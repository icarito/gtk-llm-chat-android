"""
server.py — FastAPI application serving the gtk-llm-chat backend over HTTP + WebSocket.
Runs embedded in the Android APK via Chaquopy. Communicates with the React Native
frontend on localhost.
"""

import os
import asyncio
import json
import threading
import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.responses import JSONResponse
import uvicorn

from .headless_llm_client import HeadlessLLMClient
from .vendored.db_operations import ChatHistory
from .vendored.debug_utils import debug_print

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

llm_client: Optional[HeadlessLLMClient] = None
chat_history: Optional[ChatHistory] = None


def get_db_path() -> str:
    import llm
    user_dir = os.environ.get("LLM_USER_PATH") or llm.user_dir()
    return os.path.join(user_dir, "logs.db")


def create_client() -> HeadlessLLMClient:
    db_path = get_db_path()
    history = ChatHistory(db_path=db_path)
    client = HeadlessLLMClient(chat_history=history, db_path=db_path)
    return client


def get_chat_history() -> ChatHistory:
    global chat_history
    if chat_history is None:
        chat_history = ChatHistory(db_path=get_db_path())
    return chat_history


def get_llm_client() -> HeadlessLLMClient:
    global llm_client
    if llm_client is None:
        llm_client = create_client()
    return llm_client


@asynccontextmanager
async def lifespan(app: FastAPI):
    _ = get_llm_client()
    logger.info(f"Backend started, db_path={get_db_path()}")
    yield
    logger.info("Backend shutting down")


app = FastAPI(lifespan=lifespan, title="gtk-llm-chat-android", version="0.1.0")


@app.get("/health")
async def health():
    return {"ok": True, "version": "0.1.0", "db_path": get_db_path()}


# ── Models ──

@app.get("/models")
async def list_models():
    client = get_llm_client()
    models = client.get_all_models()
    result = []
    for model in models:
        model_id = getattr(model, 'model_id', 'unknown')
        provider = client.get_provider_for_model(model_id)
        result.append({
            "model_id": model_id,
            "name": getattr(model, 'name', model_id),
            "provider": provider,
        })
    return result


# ── Conversations CRUD ──

@app.get("/conversations")
async def list_conversations(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    history = get_chat_history()
    convs = history.get_conversations(limit, offset)
    result = []
    for c in convs:
        conv_dict = dict(c)
        conv_dict['id'] = str(conv_dict['id'])
        result.append(conv_dict)
    return result


@app.get("/conversations/{cid}/history")
async def get_conversation_history(cid: str):
    history = get_chat_history()
    entries = history.get_conversation_history(cid)
    if not entries and not history.get_conversation(cid):
        raise HTTPException(status_code=404, detail="Conversation not found")
    result = []
    for entry in entries:
        entry_dict = {}
        for k, v in entry.items():
            if isinstance(v, bytes):
                entry_dict[k] = v.decode('utf-8', errors='replace')
            else:
                entry_dict[k] = v
        result.append(entry_dict)
    return result


@app.post("/conversations")
async def create_conversation(body: dict):
    history = get_chat_history()
    client = get_llm_client()
    model_id = body.get("model", client.get_model_id())
    name = body.get("name", "New Conversation")
    temp_id = body.get("id")

    if temp_id:
        history.create_conversation_if_not_exists(temp_id, name, model_id)
        return {"id": temp_id, "name": name, "model": model_id}

    client.set_model(model_id)
    cid = client.get_conversation_id()
    history.set_conversation_title(cid, name)
    return {"id": cid, "name": name, "model": model_id}


@app.delete("/conversations/{cid}")
async def delete_conversation(cid: str):
    history = get_chat_history()
    history.delete_conversation(cid)
    return {"ok": True}


@app.put("/conversations/{cid}/title")
async def rename_conversation(cid: str, body: dict):
    title = body.get("title", "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title cannot be empty")
    history = get_chat_history()
    history.set_conversation_title(cid, title)
    return {"ok": True, "title": title}


# ── WebSocket streaming ──

@app.websocket("/conversations/{cid}/stream")
async def stream_chat(websocket: WebSocket, cid: str):
    await websocket.accept()
    logger.info(f"WebSocket connected for conversation {cid}")

    client = get_llm_client()
    client.config['cid'] = cid

    loop = asyncio.get_event_loop()
    send_queue = asyncio.Queue()
    finished = threading.Event()
    stream_error = {"occurred": False, "message": ""}

    def on_response(chunk: str):
        asyncio.run_coroutine_threadsafe(send_queue.put(("response", chunk)), loop)

    def on_error(msg: str):
        stream_error["occurred"] = True
        stream_error["message"] = msg
        asyncio.run_coroutine_threadsafe(send_queue.put(("error", msg)), loop)
        finished.set()

    def on_finished(success: bool):
        asyncio.run_coroutine_threadsafe(send_queue.put(("finished", success)), loop)
        finished.set()

    def on_ready(model_id: str):
        asyncio.run_coroutine_threadsafe(send_queue.put(("ready", model_id)), loop)

    client._on_response = on_response
    client._on_error = on_error
    client._on_finished = on_finished
    client._on_ready = on_ready

    async def drain_queue():
        while True:
            msg = await send_queue.get()
            msg_type = msg[0]
            if msg_type == "response":
                await websocket.send_json({"type": "response", "chunk": msg[1]})
            elif msg_type == "error":
                await websocket.send_json({"type": "error", "message": msg[1]})
            elif msg_type == "finished":
                await websocket.send_json({"type": "finished", "success": msg[1]})
                return
            elif msg_type == "ready":
                await websocket.send_json({"type": "ready", "model_id": msg[1]})

    drain_task = asyncio.create_task(drain_queue())

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "send":
                prompt = data.get("prompt", "")
                if data.get("system"):
                    client.config['system'] = data['system']
                if data.get("temperature") is not None:
                    client.config['temperature'] = data['temperature']
                client.send_message(prompt)

            elif msg_type == "set_model":
                model_id = data.get("model_id")
                if model_id:
                    client.set_model(model_id)

            elif msg_type == "cancel":
                client.cancel()

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for conversation {cid}")
        client.cancel()
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        client.cancel()
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        drain_task.cancel()
        try:
            await drain_task
        except asyncio.CancelledError:
            pass


def run_server(host: str = "127.0.0.1", port: int = 8765):
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    run_server()
