"""
FREELMAPI-FIRST LLM ROUTER — free, auto-failover, effectively unlimited
The local FreeLLMAPI desktop gateway is the PRIMARY engine. It owns the
upstream provider keys, quotas and smart routing, so the ml-service needs
no provider keys of its own. Direct free-tier providers remain as a last
resort if the router is not running (or has no eligible model).

Providers:
  1. FreeLLMAPI — local OpenAI-compatible gateway, auto:smart routing
  2. Gemini     — 1,500 req/day free        (fallback, needs GEMINI_API_KEY)
  3. Groq       — fast, large daily budget  (fallback, needs GROQ_API_KEY)
  4. OpenRouter — rotating free models      (fallback, needs OPENROUTER_API_KEY)
  5. Cerebras   — free dev tier, very fast  (fallback, needs CEREBRAS_API_KEY)
  6. HuggingFace— free rate-limited         (fallback, needs HF_API_KEY)

If every engine fails, returns None (caller uses Quant Brain text).
"""

import os
import re
import time
import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger("llm_router")

# ============================================================
# PROVIDER CONFIG
# ============================================================
DEFAULT_FREELLMAPI_URL = "http://127.0.0.1:31415"
FREELLMAPI_MODELS = {
    "smart": "auto:smart",
    "balanced": "auto:balanced",
    "fast": "auto:fast",
}

PROVIDERS = [
    {
        "name": "freellmapi",
        "url": "{base}/v1/chat/completions",
        "model": "auto:smart",
        "env_key": "FREELLMAPI_API_KEY",  # optional — auto-discovered from the desktop DB
        "format": "openai",
        "local": True,
    },
    {
        "name": "gemini",
        "url": "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}",
        "model": "gemini-3.5-flash",
        "env_key": "GEMINI_API_KEY",
        "format": "gemini",
    },
    {
        "name": "groq",
        "url": "https://api.groq.com/openai/v1/chat/completions",
        "model": "openai/gpt-oss-120b",
        "env_key": "GROQ_API_KEY",
        "format": "openai",
    },
    {
        "name": "openrouter",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "z-ai/glm-5.2:free",
        "env_key": "OPENROUTER_API_KEY",
        "format": "openai",
    },
    {
        "name": "cerebras",
        "url": "https://api.cerebras.ai/v1/chat/completions",
        "model": "gpt-oss-120b",
        "env_key": "CEREBRAS_API_KEY",
        "format": "openai",
    },
    {
        "name": "huggingface",
        "url": "https://router.huggingface.co/v1/chat/completions",
        "model": "Qwen/Qwen3-235B-A22B-Instruct-2507",
        "env_key": "HF_API_KEY",
        "format": "openai",
    },
]

# Health tracking per provider
_provider_health = {}
for p in PROVIDERS:
    _provider_health[p["name"]] = {"failures": 0, "last_failure": 0, "cooldown_ms": 30000}

_freellmapi_key_cache = {"value": None, "at": 0.0}
_FREELLMAPI_KEY_TTL_SEC = 300.0


# ============================================================
# FREELMAPI DISCOVERY
# ============================================================
def _clean_base(url: str) -> str:
    return str(url or "").strip().rstrip("/").removesuffix("/v1")


def _config_dirs() -> list:
    dirs = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        dirs.append(Path(appdata) / "FreeLLMAPI")
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        dirs.append(Path(xdg) / "FreeLLMAPI")
    home = Path.home()
    dirs.extend([
        home / ".config" / "FreeLLMAPI",
        home / "Library" / "Application Support" / "FreeLLMAPI",
        home / "AppData" / "Roaming" / "FreeLLMAPI",
    ])
    # de-dupe while preserving order
    seen, out = set(), []
    for d in dirs:
        key = str(d)
        if key not in seen:
            seen.add(key)
            out.append(d)
    return out


def _freellmapi_base() -> str:
    """FREELLMAPI_URL wins, then the desktop config.json port, then 31415."""
    env_url = os.environ.get("FREELLMAPI_URL") or os.environ.get("FREELLMAPI_BASE_URL")
    if env_url:
        return _clean_base(env_url)
    for d in _config_dirs():
        try:
            cfg = json.loads((d / "config.json").read_text(encoding="utf-8"))
            port = int(cfg.get("port") or 0)
            if port > 0:
                return f"http://127.0.0.1:{port}"
        except Exception:
            continue
    return DEFAULT_FREELLMAPI_URL


def _read_db_key(db_path: Path) -> str:
    try:
        import sqlite3
        uri = f"file:{db_path.as_posix()}?mode=ro"
        con = sqlite3.connect(uri, uri=True, timeout=2.0)
        try:
            row = con.execute(
                "SELECT value FROM settings WHERE key = 'unified_api_key'"
            ).fetchone()
            return str(row[0]).strip() if row and row[0] else ""
        finally:
            con.close()
    except Exception:
        return ""


def _freellmapi_key() -> str:
    """Env key wins; otherwise read settings.unified_api_key from freeapi.db."""
    now = time.time()
    if _freellmapi_key_cache["value"] is not None and now - _freellmapi_key_cache["at"] < _FREELLMAPI_KEY_TTL_SEC:
        return _freellmapi_key_cache["value"]
    key = (os.environ.get("FREELLMAPI_API_KEY") or "").strip()
    if not key:
        explicit = os.environ.get("FREELLMAPI_DB_PATH") or os.environ.get("FREEAPI_DB_PATH")
        candidates = [Path(explicit)] if explicit else []
        candidates.extend(d / "freeapi.db" for d in _config_dirs())
        candidates.extend([Path.cwd() / "data" / "freeapi.db", Path.cwd() / "server" / "data" / "freeapi.db"])
        for db in candidates:
            try:
                if db.is_file():
                    key = _read_db_key(db)
                    if key:
                        break
            except Exception:
                continue
    _freellmapi_key_cache["value"] = key
    _freellmapi_key_cache["at"] = now
    return key


def _freellmapi_model() -> str:
    """smart (default) → auto:smart, balanced → auto:balanced, fast → auto:fast."""
    raw = (os.environ.get("FREELLMAPI_PROFILE") or os.environ.get("AI_MODE") or "smart").strip().lower()
    return FREELLMAPI_MODELS.get(raw, FREELLMAPI_MODELS["smart"])


def _provider_url(provider: dict) -> str:
    url = provider["url"]
    if "{base}" in url:
        url = url.format(base=_freellmapi_base())
    if "{model}" in url:
        url = url.format(model=provider["model"])
    return url


def _is_provider_available(name: str) -> bool:
    """Check if a provider can be tried (FreeLLMAPI is local; others need a key)."""
    for p in PROVIDERS:
        if p["name"] != name:
            continue
        if p.get("local"):
            return True  # FreeLLMAPI — always try the local gateway
        return bool(os.environ.get(p["env_key"]))
    return False


def _record_failure(name: str):
    _provider_health[name]["failures"] += 1
    _provider_health[name]["last_failure"] = time.time() * 1000


def _record_success(name: str):
    _provider_health[name]["failures"] = 0


def _is_in_cooldown(name: str) -> bool:
    h = _provider_health[name]
    if h["failures"] < 3:
        return False
    elapsed = time.time() * 1000 - h["last_failure"]
    return elapsed < h["cooldown_ms"]


# ============================================================
# CALL FUNCTIONS
# ============================================================
import urllib.request
import urllib.error


def _call_gemini(provider: dict, system_prompt: str, user_prompt: str, key: str) -> Optional[str]:
    url = provider["url"].format(model=provider["model"], key=key)
    payload = json.dumps({
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 4096},
    }).encode("utf-8")

    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
        text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
        return text.strip() if text and len(text.strip()) >= 5 else None


def _call_openai_compat(provider: dict, system_prompt: str, user_prompt: str, key: str = None) -> Optional[str]:
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    if provider["name"] == "openrouter":
        headers["HTTP-Referer"] = "https://smartai1.onrender.com"

    model = _freellmapi_model() if provider["name"] == "freellmapi" else provider["model"]
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.7,
        "max_tokens": 4096,
    }).encode("utf-8")

    timeout = 120 if provider["name"] == "freellmapi" else 30
    req = urllib.request.Request(_provider_url(provider), data=payload, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
        text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        return text.strip() if text and len(text.strip()) >= 5 else None


def _call_hf(provider: dict, system_prompt: str, user_prompt: str, key: str) -> Optional[str]:
    url = provider["url"].format(model=provider["model"])
    full_prompt = f"System: {system_prompt}\n\nUser: {user_prompt}"
    payload = json.dumps({
        "inputs": full_prompt,
        "parameters": {"max_new_tokens": 4096, "temperature": 0.7},
    }).encode("utf-8")

    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"

    req = urllib.request.Request(url, data=payload, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read())
        if isinstance(data, list) and data:
            text = data[0].get("generated_text", "")
        elif isinstance(data, dict):
            text = data.get("generated_text", "")
        else:
            text = ""
        return text.strip() if text and len(text.strip()) >= 5 else None


# ============================================================
# MAIN ROUTER
# ============================================================
def ask_llm(system_prompt: str, user_prompt: str) -> Optional[str]:
    """
    Try each provider in order (FreeLLMAPI first). Return first successful
    response. If all fail, return None — caller should use
    quant_brain.brain_to_text().
    """
    for provider in PROVIDERS:
        name = provider["name"]

        if not _is_provider_available(name):
            continue
        if _is_in_cooldown(name):
            continue

        if name == "freellmapi":
            key = _freellmapi_key()
            model_label = _freellmapi_model()
        else:
            key = os.environ.get(provider["env_key"]) if provider["env_key"] else None
            model_label = provider["model"]

        try:
            logger.info(f"  🤖 Trying {name} ({model_label})...")
            if provider["format"] == "gemini":
                text = _call_gemini(provider, system_prompt, user_prompt, key)
            elif provider["format"] == "hf":
                text = _call_hf(provider, system_prompt, user_prompt, key)
            else:
                text = _call_openai_compat(provider, system_prompt, user_prompt, key)

            if text:
                _record_success(name)
                logger.info(f"  ✅ {name} responded ({len(text)} chars)")
                return text
            else:
                _record_failure(name)
                logger.warning(f"  ⚠️ {name} empty response")
        except Exception as e:
            _record_failure(name)
            logger.warning(f"  ❌ {name} error: {e}")

    return None


def get_provider_status() -> list:
    """Return status of all providers for the /health endpoint."""
    statuses = []
    for provider in PROVIDERS:
        name = provider["name"]
        available = _is_provider_available(name)
        health = _provider_health[name]
        statuses.append({
            "name": name,
            "available": available,
            "key_set": bool(os.environ.get(provider["env_key"])) if provider["env_key"] else True,
            "model": _freellmapi_model() if name == "freellmapi" else provider["model"],
            "failures": health["failures"],
            "in_cooldown": _is_in_cooldown(name),
            **({"base_url": _freellmapi_base()} if name == "freellmapi" else {}),
        })
    return statuses


# ============================================================
# ANTI-HALLUCINATION GUARD
# ============================================================
def anti_hallucination_check(llm_text: str, quant_data: dict) -> str:
    """
    Regex-scan LLM text for numbers NOT present in the quant_data dict.
    FIX M13: previously this only logged a warning and always returned the
    LLM text — fabricated numbers flowed through to the user. Now return
    None when too many suspicious numbers are detected so the caller can
    fall back to `brain_to_text(quant_data)` (deterministic).
    """
    if not llm_text:
        return llm_text

    # Extract all numbers from LLM response
    numbers_in_text = set(re.findall(r'\b\d+\.?\d*\b', llm_text))

    # Extract expected numbers from quant_data
    expected_numbers = set()
    for key in ["rsi", "adx", "entry", "sl", "tp1", "tp2", "rr", "vix", "support", "resistance", "atr"]:
        val = quant_data.get(key)
        if val is not None:
            if isinstance(val, dict):
                for v in val.values():
                    if isinstance(v, (int, float)):
                        expected_numbers.add(str(v))
            else:
                expected_numbers.add(str(val))

    # Allow common small numbers (1-100) and percentages
    suspicious = []
    for num_str in numbers_in_text:
        try:
            num = float(num_str)
            if num > 100 and num_str not in expected_numbers:
                suspicious.append(num_str)
        except ValueError:
            pass

    # If too many suspicious numbers, signal hallucination → return None so
    # the caller (main.py /analyze) can fall back to brain_to_text().
    if len(suspicious) > 3:
        logger.warning(f"  ⚠️ Anti-hallucination triggered: {len(suspicious)} suspicious numbers — returning None for fallback")
        return None

    return llm_text
