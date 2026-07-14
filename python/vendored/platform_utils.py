"""
Vendored from gtk-llm-chat gtk_llm_chat/platform_utils.py
Source: https://github.com/icarito/gtk-llm-chat
Commit: f16798c (placeholder — update when vendoring)
"""

import sys
import os
import llm


PLATFORM = sys.platform
DEBUG = os.environ.get('DEBUG') or False


def debug_print(*args, **kwargs):
    if DEBUG:
        print(*args, **kwargs)


def is_linux():
    return PLATFORM.startswith('linux')


def is_windows():
    return PLATFORM.startswith('win')


def is_mac():
    return PLATFORM == 'darwin'


def ensure_user_dir_exists():
    try:
        user_dir = llm.user_dir()
        debug_print(f"[platform_utils] llm.user_dir() resolvió a: {user_dir}")
        os.makedirs(user_dir, exist_ok=True)
        return user_dir
    except Exception as e:
        debug_print(f"[platform_utils] Error crítico obteniendo/creando directorio de usuario con llm.user_dir(): {e}")
        return None
