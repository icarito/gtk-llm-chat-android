"""
Vendored from gtk-llm-chat gtk_llm_chat/db_operations.py
Source: https://github.com/icarito/gtk-llm-chat
Commit: f16798c (placeholder — update when vendoring)
"""

import sqlite3
from typing import List, Dict, Optional
import json
from datetime import datetime, timezone
from ulid import ULID
import os
import urllib.request
import urllib.error
import threading
import hashlib
import logging
import llm
import sqlite_utils
from llm.migrations import migrate


def debug_print(*args, **kwargs):
    print(*args, **kwargs)


class ChatHistory:
    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            user_dir = llm.user_dir()
            db_path = os.path.join(user_dir, "logs.db")
        self.db_path = db_path
        self._thread_local = threading.local()

    def _ensure_db_exists(self):
        if not os.path.exists(self.db_path):
            self._run_llm_migrations()

    def _run_llm_migrations(self):
        db_utils = None
        try:
            db_utils = sqlite_utils.Database(self.db_path)
            migrate(db_utils)
            logging.info(f"LLM migrations applied successfully to {self.db_path}")
        except Exception as e:
            logging.error(f"Error running LLM migrations on {self.db_path}: {e}", exc_info=True)
        finally:
            if db_utils and hasattr(db_utils, 'conn') and db_utils.conn:
                try:
                    db_utils.conn.close()
                except Exception as close_err:
                    logging.error(f"Error closing sqlite_utils connection after migration: {close_err}", exc_info=True)
        self.close_connection()

    def get_connection(self):
        if not hasattr(self._thread_local, "conn") or self._thread_local.conn is None:
            try:
                if not os.path.exists(self.db_path):
                    self._run_llm_migrations()
                self._thread_local.conn = sqlite3.connect(self.db_path)
                self._thread_local.conn.row_factory = sqlite3.Row
            except sqlite3.Error as e:
                if "no such table" in str(e):
                    logging.warning(f"Table not found error on connect, attempting migrations again: {e}")
                    try:
                        self._run_llm_migrations()
                        self._thread_local.conn = sqlite3.connect(self.db_path)
                        self._thread_local.conn.row_factory = sqlite3.Row
                    except Exception as migrate_err:
                        logging.error(f"Failed to run migrations on 'no such table' error: {migrate_err}", exc_info=True)
                        raise ConnectionError(f"Error al conectar a la base de datos después de fallo de migración: {e}") from migrate_err
                else:
                    raise ConnectionError(f"Error al conectar a la base de datos: {e}") from e
        return self._thread_local.conn

    def close_connection(self):
        if hasattr(self._thread_local, "conn") and self._thread_local.conn is not None:
            self._thread_local.conn.close()
            self._thread_local.conn = None

    def get_conversation_history(self, conversation_id: str) -> List[Dict]:
        if not os.path.exists(self.db_path):
            return []
        conn = self.get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT r.*, c.name as conversation_name
            FROM responses r
            JOIN conversations c ON r.conversation_id = c.id
            WHERE r.conversation_id = ?
            ORDER BY datetime_utc ASC
        """, (conversation_id,))

        history = []
        for row in cursor.fetchall():
            entry = dict(row)
            if entry['prompt_json']:
                entry['prompt_json'] = json.loads(entry['prompt_json'])
            if entry['response_json']:
                entry['response_json'] = json.loads(entry['response_json'])
            if entry['options_json']:
                entry['options_json'] = json.loads(entry['options_json'])
            history.append(entry)
        return history

    def get_last_conversation(self):
        if not os.path.exists(self.db_path):
            return None
        conn = self.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM conversations ORDER BY id DESC LIMIT 1")
        row = cursor.fetchone()
        return dict(row) if row else None

    def get_conversation(self, conversation_id: str):
        if not os.path.exists(self.db_path):
            return None
        conn = self.get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM conversations WHERE id = ?", (conversation_id,))
        row = cursor.fetchone()
        return dict(row) if row else None

    def _sanitize_title(self, title: str) -> str:
        return title.strip()

    def set_conversation_title(self, conversation_id: str, title: str):
        sanitized_title = self._sanitize_title(title)
        query = "UPDATE conversations SET name = ? WHERE id = ?"
        conn = self.get_connection()
        cursor = conn.cursor()
        try:
            cursor.execute(query, (sanitized_title, conversation_id))
            conn.commit()
        finally:
            cursor.close()
            self.close_connection()

    def delete_conversation(self, conversation_id: str):
        conn = self.get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM conversations WHERE id = ?", (conversation_id,))
        cursor.execute(
            "DELETE FROM responses WHERE conversation_id = ?",
            (conversation_id,))
        conn.commit()

    def get_conversations(self, limit: int, offset: int) -> List[Dict]:
        if not os.path.exists(self.db_path):
            return []
        conn = self.get_connection()
        cursor = conn.cursor()
        try:
            cursor.execute("""
                SELECT * FROM conversations
                ORDER BY id DESC
                LIMIT ? OFFSET ?
            """, (limit, offset))
        except sqlite3.OperationalError:
            return []

        conversations = []
        for row in cursor.fetchall():
            conversations.append(dict(row))

        return conversations

    def add_history_entry(
        self, conversation_id: str, prompt: str, response_text: str,
        model_id: str, fragments: List[str] = None, system_fragments: List[str] = None
    ):
        self._ensure_db_exists()
        conn = self.get_connection()
        cursor = conn.cursor()
        try:
            response_id = str(ULID()).lower()
            timestamp_utc = datetime.now(timezone.utc).isoformat()

            cursor.execute("""
                INSERT INTO responses
                (id, model, prompt, response, conversation_id, datetime_utc)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (
                response_id,
                model_id,
                prompt,
                response_text,
                conversation_id,
                timestamp_utc
            ))
            conn.commit()
            if fragments:
                self._add_fragments(response_id, fragments, 'prompt_fragments')
            if system_fragments:
                self._add_fragments(response_id, system_fragments, 'system_fragments')

        except sqlite3.Error as e:
            debug_print(f"Error adding entry to history: {e}")
            conn.rollback()
        finally:
            self.close_connection()

    def create_conversation_if_not_exists(self, conversation_id, name: str, model: Optional[str] = None):
        self._ensure_db_exists()
        conn = self.get_connection()
        cursor = conn.cursor()
        try:
            cursor.execute("""
                INSERT OR IGNORE INTO conversations (id, name, model)
                VALUES (?, ?, ?)
            """, (conversation_id, name, model))
            conn.commit()
        except sqlite3.Error as e:
            debug_print(f"Error creating conversation record: {e}")
            conn.rollback()
        finally:
            self.close_connection()

    def _add_fragments(self, response_id: str, fragments: List[str], table_name: str):
        conn = self.get_connection()
        cursor = conn.cursor()
        for order, fragment_specifier in enumerate(fragments):
            try:
                fragment_content = self.resolve_fragment(fragment_specifier)
                fragment_id: int = self._get_or_create_fragment(fragment_content, source=fragment_specifier)
                cursor.execute(f"""
                    INSERT INTO {table_name} (response_id, fragment_id, "order")
                    VALUES (?, ?, ?)
                """, (response_id, fragment_id, order))
            except ValueError as e:
                debug_print(f"Error adding fragment '{fragment_specifier}': {e}")
            except sqlite3.IntegrityError as e:
                debug_print(f"Integrity error adding fragment '{fragment_specifier}' for response {response_id}: {e}")
            except sqlite3.Error as e:
                debug_print(f"Database error adding fragment '{fragment_specifier}': {e}")
        conn.commit()
        self.close_connection()

    def _get_or_create_fragment(self, fragment_content: str, source: str = None) -> int:
        conn = self.get_connection()
        cursor = conn.cursor()
        content_hash = hashlib.sha256(fragment_content.encode('utf-8')).hexdigest()
        cursor.execute("SELECT id FROM fragments WHERE hash = ?", (content_hash,))
        row = cursor.fetchone()
        if row:
            fragment_id = row['id']
        else:
            timestamp_utc = datetime.now(timezone.utc).isoformat()
            cursor.execute(
                "INSERT INTO fragments (content, hash, source, datetime_utc) VALUES (?, ?, ?, ?)",
                (fragment_content, content_hash, source, timestamp_utc)
            )
            conn.commit()
            fragment_id = cursor.lastrowid
            if fragment_id is None:
                cursor.execute("SELECT id FROM fragments WHERE hash = ?", (content_hash,))
                row = cursor.fetchone()
                if row:
                    fragment_id = row['id']
                else:
                    raise sqlite3.Error("Could not retrieve fragment ID after insertion.")
        self.close_connection()
        return fragment_id

    def get_fragments_for_response(self, response_id: str, table_name: str) -> List[str]:
        conn = self.get_connection()
        cursor = conn.cursor()
        query = f"""
            SELECT fragments.content
            FROM {table_name}
            JOIN fragments ON {table_name}.fragment_id = fragments.id
            WHERE {table_name}.response_id = ?
            ORDER BY {table_name}."order"
        """
        cursor.execute(query, (response_id,))
        return [row['content'] for row in cursor.fetchall()]

    def resolve_fragment(self, specifier: str) -> str:
        specifier = specifier.strip()

        if not specifier:
            raise ValueError("Empty fragment specifier")

        conn = self.get_connection()
        cursor = conn.cursor()

        if len(specifier) == 64 and all(c in '0123456789abcdef' for c in specifier):
            cursor.execute("SELECT content FROM fragments WHERE hash = ?", (specifier,))
            hash_row = cursor.fetchone()
            if hash_row:
                return hash_row['content']

        cursor.execute("""
            SELECT fragments.content
            FROM fragment_aliases
            JOIN fragments ON fragment_aliases.fragment_id = fragments.id
            WHERE fragment_aliases.alias = ?
        """, (specifier,))
        alias_row = cursor.fetchone()
        if alias_row:
            return alias_row['content']

        try:
            if specifier.startswith(('http://', 'https://')):
                try:
                    with urllib.request.urlopen(specifier, timeout=10) as response:
                        if response.status == 200:
                            charset = response.headers.get_content_charset() or 'utf-8'
                            content = response.read().decode(charset)
                            return content
                        else:
                            raise ValueError(f"Failed to fetch URL '{specifier}': HTTP status {response.status}")
                except urllib.error.URLError as e:
                    raise ValueError(f"Failed to fetch URL '{specifier}': {e}") from e

            elif os.path.exists(specifier):
                try:
                    with open(specifier, 'r', encoding='utf-8') as f:
                        content = f.read()
                        self._get_or_create_fragment(content, source=specifier)
                        return content
                except UnicodeDecodeError as e:
                    raise ValueError(f"Failed to decode file '{specifier}' as UTF-8: {e}") from e
                except PermissionError as e:
                    raise ValueError(f"Permission error accessing file '{specifier}': {e}") from e
                except Exception as e:
                    raise ValueError(f"Error reading file '{specifier}': {e}") from e

            elif specifier.isdigit():
                try:
                    fragment_id_int = int(specifier)
                    cursor.execute("SELECT content FROM fragments WHERE id = ?", (fragment_id_int,))
                    id_row = cursor.fetchone()
                    if id_row:
                        return id_row['content']
                except ValueError:
                    pass

            return specifier

        except ValueError as e:
            logging.warning(f"ChatHistory: Could not resolve fragment '{specifier}': {e}")
            raise
        except Exception as e:
            logging.error(f"ChatHistory: Unexpected error resolving fragment '{specifier}': {e}", exc_info=True)
            raise ValueError(f"Unexpected error resolving fragment '{specifier}': {e}") from e

    def update_conversation_model(self, cid, model_id):
        if not cid:
            logging.warning("No conversation ID provided to update model.")
            return
        conn = self.get_connection()
        try:
            conn.execute(
                "UPDATE conversations SET model = ? WHERE id = ?",
                (model_id, cid)
            )
            conn.commit()
        finally:
            self.close_connection()
