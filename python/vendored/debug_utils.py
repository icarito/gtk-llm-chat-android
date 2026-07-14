"""
Vendored from gtk-llm-chat gtk_llm_chat/debug_utils.py
Source: https://github.com/icarito/gtk-llm-chat
Commit: f16798c (placeholder — update when vendoring)
"""

import os

DEBUG = os.environ.get('DEBUG') or False


def debug_print(*args, **kwargs):
    if DEBUG:
        print(*args, **kwargs)
