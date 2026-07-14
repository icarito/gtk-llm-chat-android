"""
android_keys.py — Read API keys from environment variables.
The React Native app stores keys via expo-secure-store and passes them
to the Python process as env vars at startup.
"""

import os

PROVIDER_ENV_MAP = {
    "OpenAI": "OPENAI_API_KEY",
    "Anthropic": "ANTHROPIC_API_KEY",
    "Google": "GOOGLE_API_KEY",
    "Groq": "GROQ_API_KEY",
    "DeepSeek": "DEEPSEEK_API_KEY",
    "OpenRouter": "OPENROUTER_API_KEY",
    "Perplexity": "PERPLEXITY_API_KEY",
    "xAI": "XAI_API_KEY",
}


def get_api_key(provider: str) -> str | None:
    env_var = PROVIDER_ENV_MAP.get(provider)
    if env_var:
        return os.environ.get(env_var)
    return None


def get_all_keys() -> dict[str, str | None]:
    return {provider: os.environ.get(env) for provider, env in PROVIDER_ENV_MAP.items()}
