"""
headless_llm_client.py — LLM backend adapted for headless use (no GTK/GObject).
Replaces GLib.idle_add / GObject signals with plain callbacks.

Source: adapted from gtk-llm-chat gtk_llm_chat/llm_client.py
"""

import json
import os
import sys
import threading
import logging
from typing import Optional, List, Callable

import llm

from .vendored.db_operations import ChatHistory
from .vendored.debug_utils import debug_print

DEFAULT_CONVERSATION_NAME = "New Conversation"


class HeadlessLLMClient:
    def __init__(
        self,
        config: Optional[dict] = None,
        chat_history: Optional[ChatHistory] = None,
        db_path: Optional[str] = None,
        on_response: Optional[Callable[[str], None]] = None,
        on_error: Optional[Callable[[str], None]] = None,
        on_finished: Optional[Callable[[bool], None]] = None,
        on_ready: Optional[Callable[[str], None]] = None,
    ):
        self.config = config or {}
        self.model = None
        self.conversation = None
        self._is_generating_flag = False
        self._stream_thread = None
        self._init_error = None
        self.chat_history = chat_history or ChatHistory(db_path=db_path)

        self._on_response = on_response
        self._on_error = on_error
        self._on_finished = on_finished
        self._on_ready = on_ready

    def _ensure_model_loaded(self):
        if self.model is None and self._init_error is None:
            debug_print("HeadlessLLMClient: Ensuring model is loaded (was deferred).")
            self._load_model_internal()

    def send_message(self, prompt: str):
        self._ensure_model_loaded()
        if self._is_generating_flag:
            if self._on_error:
                self._on_error("Ya se está generando una respuesta.")
            return

        if self._init_error or not self.model:
            if self._on_error:
                self._on_error(
                    f"Error al inicializar el modelo: {self._init_error or 'Modelo no disponible'}"
                )
            return

        self._is_generating_flag = True
        self._stream_thread = threading.Thread(
            target=self._process_stream, args=(prompt,), daemon=True
        )
        self._stream_thread.start()

    def set_model(self, model_id):
        debug_print(f"HeadlessLLMClient: Request to set model to: {model_id}, current cid: {self.config.get('cid')}")
        self.config['model'] = model_id

        old_cid = self.config.get('cid')

        if old_cid:
            self.chat_history.update_conversation_model(old_cid, model_id)

        self.model = None
        self.conversation = None

        all_models = llm.get_models()
        self.model = next(
            (model for model in all_models if getattr(model, 'model_id', None) == model_id),
            None,
        )
        if not self.model:
            debug_print(f"HeadlessLLMClient: No se pudo encontrar el modelo con ID: {model_id}")
            return False

        self.provider = getattr(self.model, 'needs_key', None) or "Local/Other"

        debug_print(f"HeadlessLLMClient: Creando nueva instancia de conversación para el modelo {self.model.model_id}")
        self.conversation = self.model.conversation()

        if old_cid:
            debug_print(f"HeadlessLLMClient: Recargando historial para cid={old_cid} tras cambio de modelo.")
            history_entries = self.chat_history.get_conversation_history(old_cid)
            self.load_history(history_entries)
            self.config['cid'] = old_cid
        else:
            new_cid = self.conversation.id
            self.config['cid'] = new_cid
            self.chat_history.create_conversation_if_not_exists(new_cid, DEFAULT_CONVERSATION_NAME, model_id)

        if self._on_ready:
            self._on_ready(model_id)
        debug_print(f"HeadlessLLMClient: Modelo {model_id} cargado y conversación reinicializada.")
        return True

    def _load_model_internal(self, model_id=None):
        current_cid = self.config.get('cid')
        try:
            try:
                from llm.plugins import load_plugins
                if not hasattr(llm.plugins, '_loaded') or not llm.plugins._loaded:
                    load_plugins()
                    debug_print("HeadlessLLMClient: Plugins cargados correctamente en _load_model_internal")
            except Exception as e:
                debug_print(f"HeadlessLLMClient: Error verificando/cargando plugins en _load_model_internal: {e}")

            if model_id is None:
                model_id = self.config.get('model') or llm.get_default_model()

            debug_print(f"HeadlessLLMClient: Attempting to load model: {model_id}")

            new_model = llm.get_model(model_id)
            self.model = new_model
            debug_print(f"HeadlessLLMClient: Using model {self.model.model_id}")

            self.conversation = new_model.conversation()
            conversation_recreated_or_model_changed = True

            self._init_error = None

            if current_cid and conversation_recreated_or_model_changed:
                debug_print(f"HeadlessLLMClient: Attempting to reload history for cid '{current_cid}' during model initialization.")
                history_entries = self.chat_history.get_conversation_history(current_cid)
                if history_entries:
                    self.load_history(history_entries)
                    debug_print(f"HeadlessLLMClient: Successfully reloaded {len(history_entries)} entries for cid '{current_cid}' (initial load).")
                else:
                    debug_print(f"HeadlessLLMClient: No history entries found for cid '{current_cid}' to reload (initial load).")

            if self._on_ready:
                self._on_ready(self.model.model_id)
        except llm.UnknownModelError as e:
            debug_print(f"HeadlessLLMClient: Error - Unknown model: {e}")
            self._init_error = str(e)
            if self._on_error:
                self._on_error(f"Modelo desconocido: {e}")
        except Exception as e:
            debug_print(f"HeadlessLLMClient: Unexpected error loading model: {e}")
            self._init_error = str(e)
            if self._on_error:
                self._on_error(f"Error inesperado al cargar modelo: {e}")
            import traceback
            traceback.print_exc()

    def _process_stream(self, prompt: str):
        success = False
        full_response = ""
        chat_history = self.chat_history
        try:
            debug_print(f"HeadlessLLMClient: Sending prompt: '{prompt[:50]}' (len={len(prompt)})")

            filtered_responses = []
            is_user_turn = True

            for response in self.conversation.responses:
                if is_user_turn:
                    if response.prompt and response.prompt.prompt and response.prompt.prompt.strip():
                        filtered_responses.append(response)
                        is_user_turn = False
                else:
                    if hasattr(response, '_chunks') and response._chunks and any(chunk.strip() for chunk in response._chunks):
                        filtered_responses.append(response)
                        is_user_turn = True
                    else:
                        if filtered_responses:
                            filtered_responses.pop()
                        is_user_turn = True

            if filtered_responses and not is_user_turn:
                filtered_responses.pop()

            if prompt is None or str(prompt).strip() == "":
                debug_print("HeadlessLLMClient: ERROR: prompt vacío o None detectado en _process_stream. Abortando.")
                if self._on_error:
                    self._on_error("No se puede enviar un prompt vacío al modelo.")
                if self._on_finished:
                    self._on_finished(False)
                return

            prompt_args = {}
            if self.config.get('system'):
                prompt_args['system'] = self.config['system']
            if self.config.get('temperature'):
                try:
                    temp_val = float(self.config['temperature'])
                    prompt_args['temperature'] = temp_val
                except ValueError:
                    debug_print("HeadlessLLMClient: Ignoring invalid temperature:", self.config['temperature'])

            fragments = []
            system_fragments = []

            if self.config.get('fragments'):
                try:
                    fragments = [chat_history.resolve_fragment(f) for f in self.config['fragments']]
                except ValueError as e:
                    if self._on_error:
                        self._on_error(str(e))
                    return

            if self.config.get('system_fragments'):
                try:
                    system_fragments = [chat_history.resolve_fragment(sf) for sf in self.config['system_fragments']]
                except ValueError as e:
                    if self._on_error:
                        self._on_error(str(e))
                    return

            try:
                if len(fragments):
                    prompt_args['fragments'] = fragments
                if len(system_fragments):
                    prompt_args['system_fragments'] = system_fragments
                response = self.conversation.prompt(prompt, **prompt_args)
            except Exception as e:
                debug_print(f"HeadlessLLMClient: Error en conversation.prompt: {e}")
                if self._on_error:
                    self._on_error(f"Error al procesar el prompt: {e}")
                return

            debug_print("HeadlessLLMClient: Starting stream processing...")
            for chunk in response:
                if not self._is_generating_flag:
                    debug_print("HeadlessLLMClient: Stream processing cancelled externally.")
                    break
                if chunk:
                    full_response += chunk
                    if self._on_response:
                        self._on_response(chunk)
            success = True
            debug_print("HeadlessLLMClient: Stream finished normally.")

        except Exception as e:
            debug_print(f"HeadlessLLMClient: Error during streaming: {e}")
            import traceback
            debug_print(traceback.format_exc())
            if self._on_error:
                self._on_error(f"Error durante el streaming: {str(e)}")
        finally:
            try:
                self._is_generating_flag = False
                self._stream_thread = None
                if success and full_response and full_response.strip():
                    cid = self.config.get('cid')
                    model_id = self.get_model_id()

                    if self.conversation and self.conversation.id:
                        cid = self.conversation.id
                        if not self.config.get('cid'):
                            self.config['cid'] = cid
                            debug_print(f"HeadlessLLMClient: New conversation detected, cid set to: {cid}")
                        self.chat_history.create_conversation_if_not_exists(
                            cid, DEFAULT_CONVERSATION_NAME, model_id
                        )

                    if cid and model_id:
                        try:
                            self.chat_history.add_history_entry(
                                cid,
                                prompt,
                                full_response,
                                model_id,
                                fragments=self.config.get('fragments'),
                                system_fragments=self.config.get('system_fragments'),
                            )
                            debug_print(f"HeadlessLLMClient: History entry added for cid={cid} with assistant response.")
                        except Exception as e:
                            debug_print(f"Error al guardar en historial: {e}")
                    else:
                        debug_print("HeadlessLLMClient: Not saving history because cid or model_id is missing.")
            finally:
                pass
            if self._on_finished:
                self._on_finished(success)

    def cancel(self):
        self._is_generating_flag = False

    def get_model_id(self):
        self._ensure_model_loaded()
        return self.model.model_id if self.model else llm.get_default_model()

    def get_conversation_id(self):
        self._ensure_model_loaded()
        return self.conversation.id if self.conversation else None

    def load_history(self, history_entries):
        if not history_entries:
            debug_print("HeadlessLLMClient: No hay historial para cargar.")
            return

        model_id = self.config.get('model')
        if not model_id:
            conversation_id = self.config.get('cid')
            if conversation_id:
                conv_details = self.chat_history.get_conversation(conversation_id)
                if conv_details and conv_details.get('model'):
                    model_id = conv_details['model']
            if not model_id:
                for entry in history_entries:
                    if entry.get('model'):
                        model_id = entry['model']
                        break

        if not self.model or self.model.model_id != model_id:
            try:
                self.model = llm.get_model(model_id)
                debug_print(f"HeadlessLLMClient: load_history - Modelo cargado: {model_id}")
            except Exception as e:
                debug_print(f"HeadlessLLMClient: Error cargando modelo '{model_id}' para historial: {e}")
                return

        if not self.conversation or getattr(self.conversation, 'model', None) != self.model:
            self.conversation = self.model.conversation()
            debug_print(f"HeadlessLLMClient: load_history - Conversación creada para modelo: {self.model.model_id}")

        self.conversation.responses = []

        for entry in history_entries:
            user_prompt = entry.get('prompt')
            assistant_response = entry.get('response')
            if not (user_prompt and str(user_prompt).strip() and assistant_response and str(assistant_response).strip()):
                continue

            prompt_obj = llm.Prompt(user_prompt, self.model)
            resp_user = llm.Response(prompt_obj, self.model, stream=False, conversation=self.conversation)
            resp_user._prompt_json = {'prompt': user_prompt}
            resp_user._done = True
            resp_user._chunks = []
            self.conversation.responses.append(resp_user)

            resp_assistant = llm.Response(prompt_obj, self.model, stream=False, conversation=self.conversation)
            resp_assistant._done = True
            resp_assistant._chunks = [str(assistant_response).strip()]
            self.conversation.responses.append(resp_assistant)

        debug_print(f"HeadlessLLMClient: Historial cargado. Total de respuestas: {len(self.conversation.responses)}")

    def set_conversation(self, conversation_id: str):
        if not conversation_id:
            debug_print("HeadlessLLMClient: Error - No conversation ID provided")
            return False

        conv_details = self.chat_history.get_conversation(conversation_id)
        if not conv_details:
            debug_print(f"HeadlessLLMClient: Error - Conversation {conversation_id} not found")
            return False

        model_id = conv_details.get('model')
        self.config['cid'] = conversation_id

        if model_id and (not self.model or self.model.model_id != model_id):
            debug_print(f"HeadlessLLMClient: Changing model to {model_id} as per conversation {conversation_id}")
            self.set_model(model_id)

        history_entries = self.chat_history.get_conversation_history(conversation_id)
        if history_entries:
            self.load_history(history_entries)
            debug_print(f"HeadlessLLMClient: Loaded {len(history_entries)} entries for conversation {conversation_id}")
        return True

    def get_provider_for_model(self, model_id):
        if not model_id:
            return "Unknown Provider"
        try:
            all_models = llm.get_models()
            for model in all_models:
                if getattr(model, 'model_id', None) == model_id:
                    provider = getattr(model, 'needs_key', None) or "Local/Other"
                    return provider
        except Exception as e:
            debug_print(f"Error al obtener modelos: {e}")
        return "Unknown Provider"

    def get_all_models(self):
        try:
            from llm.plugins import load_plugins
            if not hasattr(llm.plugins, '_loaded') or not llm.plugins._loaded:
                load_plugins()
            return llm.get_models()
        except Exception as e:
            debug_print(f"HeadlessLLMClient: Error obteniendo modelos: {e}")
            return []
