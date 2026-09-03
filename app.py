"""
app.py — Orgo AI FastAPI backend.

Endpoints:
  POST /analyze         image → SMILES + stage images (base64); fast path returns
                        confidence "verifying" + verify_token for deferred check
  GET  /analyze/verify/{token}  collect the deferred vision verification
  POST /react           substrate + reagent → all predicted products
  GET  /structure       SMILES → SVG (for UI rendering)
  POST /pathways        substrate → branching graph over REAGENT_LIST
  POST /explain         engine output + reaction name → LLM prose explanation
  POST /chat            conversational chemistry assistant (grounded in engine data)

Start:  uvicorn app:app --host 0.0.0.0 --port 8000 --reload
Or use: start.bat
"""

import asyncio
import base64
import io
import json
import logging
import os
import re
import tempfile
import threading
import time
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
if not logger.handlers:
    logger.addHandler(logging.StreamHandler())
    logger.propagate = False

# The arbitration module logs discarded degenerate reads — route it through
# the same handler so those lines actually reach the console.
_arb_logger = logging.getLogger("osr_arbitration")
_arb_logger.setLevel(logging.INFO)
if not _arb_logger.handlers:
    _arb_logger.addHandler(logging.StreamHandler())
    _arb_logger.propagate = False

import cv2
import numpy as np
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from PIL import Image
from pydantic import BaseModel

# Load .env file if present (never hard-code the key)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

from askcos_client import AskcosClient, AskcosUnavailable
from byok import anthropic_base_url
from osr_arbitration import (
    arbitrate_local, plausible_or_none, resolve_with_vision,
)
from prediction import (
    UNNAMED_REACTION, Prediction, needs_sanity_check, resolve_products,
)
from preprocessing import denoise, deskew, normalize_binarize, perspective_correct
from proxy_auth import (
    LOOPBACK_IPS, PROXY_SECRET_HEADER, proxy_authorized, resolve_client_ip,
    secret_matches,
)
from reactivity_engine import TemplateEngine

# ── ASKCOS forward predictor ─────────────────────────────────────────────────
# None when ASKCOS_BASE_URL is unset, which means "ASKCOS off" — /react then
# behaves exactly as it did before the integration, on templates alone. Built
# once at import (after load_dotenv above); the client holds no connection
# state, so a single instance is safe across threads and requests.
ASKCOS = AskcosClient.from_env()
if ASKCOS is not None:
    logger.info("ASKCOS forward predictor enabled: %s (backend=%s, model=%s)",
                ASKCOS.base_url, ASKCOS.backend, ASKCOS.model_name)
else:
    logger.info("ASKCOS disabled (ASKCOS_BASE_URL unset) — using template engine only")

# ── LLM config — Ollama is used when no Anthropic key is present ─────────────
OLLAMA_BASE_URL    = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL       = os.environ.get("OLLAMA_MODEL", "llama3.2:1b")
# Explicit env override for the vision model; when unset, auto-detect below.
OLLAMA_VISION_MODEL_ENV = os.environ.get("OLLAMA_VISION_MODEL")
# Hard cap on any single vision read, INCLUDING a cold model load (~6 GB).
# Past this, /analyze degrades gracefully to the best local read flagged
# low/unverified instead of holding the request open for minutes.
VISION_TIMEOUT = float(os.environ.get("OLLAMA_VISION_TIMEOUT", "120"))
# VLM prefill cost scales with pixel count; a line structure is perfectly
# legible at 768 px, and 1024→768 cuts visual tokens ~45% — directly cutting
# the wait whenever arbitration needs the vision read.
VISION_MAX_DIM = int(os.environ.get("VISION_MAX_DIM", "768"))
# Structure recognition stays pinned to Sonnet regardless of the (cheaper)
# chat model: misreading a structure poisons everything downstream, while a
# chat reply being slightly less polished costs nothing.
ANTHROPIC_VISION_MODEL = os.environ.get("ANTHROPIC_VISION_MODEL", "claude-sonnet-4-6")

# Vision-capable model families that current Ollama engines can load, best
# first. llama3.2-vision is intentionally last: its 'mllama' architecture was
# dropped by Ollama ≥ 0.30, so it only works on older installs.
_VISION_MODEL_CANDIDATES = [
    "qwen3-vl", "qwen2.5vl", "gemma3", "minicpm-v", "llava", "moondream",
    "llama3.2-vision",
]
_vision_model_cache: str | None = None


def _ollama_vision_model() -> str | None:
    """Resolve the vision model to use: env override, else the best installed
    candidate from /api/tags. Cached after first success; returns None when no
    vision-capable model is installed (callers already treat failure as soft)."""
    global _vision_model_cache
    if OLLAMA_VISION_MODEL_ENV:
        return OLLAMA_VISION_MODEL_ENV
    if _vision_model_cache:
        return _vision_model_cache
    try:
        import httpx
        r = httpx.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5.0)
        r.raise_for_status()
        installed = [m.get("name", "") for m in r.json().get("models", [])]
    except Exception:
        return None
    for family in _VISION_MODEL_CANDIDATES:
        for name in installed:
            if name.split(":")[0] == family:
                _vision_model_cache = name
                logger.info("Vision model auto-detected: %s", name)
                return name
    return None


def _smiles_from_vision_text(text: str, source: str) -> str | None:
    """Pull the first plausible canonical SMILES out of a VLM response —
    either the whole response or an extracted SMILES-shaped token."""
    import re

    # Whole-response parse only when it IS a bare SMILES (single token) —
    # RDKit stops parsing at whitespace, so prose like "I need to..." would
    # otherwise "parse" as iodine with the rest as a name field.
    if len(text.split()) == 1:
        result = plausible_or_none(_canonical_smiles(text), "Vision")
        if result:
            logger.info("%s → valid SMILES (full response): %r", source, result)
            return result

    for candidate in re.findall(r"[A-Za-z0-9@+\-\[\]()/\\=#%\.]{6,}", text):
        result = plausible_or_none(_canonical_smiles(candidate), "Vision")
        if result:
            logger.info("%s → valid SMILES (extracted token): %r", source, result)
            return result

    logger.warning("%s: no valid SMILES found in response: %r", source, text[:200])
    return None


def _anthropic_vision_call(img_bytes: bytes, prompt: str,
                           api_key: str | None = None) -> str | None:
    """
    Send an image + prompt to Claude and return the first valid canonical
    SMILES found in the response. Returns None on any failure so Ollama can
    still take over.

    Uses the OpenAI-compatible /v1/chat/completions route rather than the
    native Anthropic messages API: gateways like MIT Parley silently DROP
    base64 image blocks on their /v1/messages passthrough (Claude replies
    "I don't see any image"), while the chat-completions route delivers
    them — and api.anthropic.com serves the same route, so this works for
    direct keys too.
    Runs synchronously — always call from a thread pool, never the event loop.
    A BYOK api_key, when supplied, routes the request and never gets logged.
    """
    import httpx

    # A BYOK key routes by its own prefix and never inherits the server's
    # gateway (Parley rejects a real Anthropic key, and vice versa).
    base = anthropic_base_url(api_key, os.environ.get("ANTHROPIC_BASE_URL"))
    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    b64 = base64.b64encode(img_bytes).decode()
    logger.info("Claude vision call → model=%s url=%s", ANTHROPIC_VISION_MODEL, base)
    try:
        resp = httpx.post(
            f"{base}/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": ANTHROPIC_VISION_MODEL,
                "max_tokens": 256,
                "temperature": 0,
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "image_url",
                         "image_url": {"url": f"data:image/png;base64,{b64}"}},
                        {"type": "text", "text": prompt},
                    ],
                }],
            },
            timeout=VISION_TIMEOUT,
        )
        resp.raise_for_status()
        choice = resp.json()["choices"][0]
        # A gateway content filter returns HTTP 200 with content=null and
        # finish_reason="content_filter" — without this branch that surfaced as
        # an opaque AttributeError and the whole OSR path failed silently.
        if choice.get("finish_reason") == "content_filter" or choice["message"].get("content") is None:
            logger.warning(
                "Claude vision blocked by gateway content filter (%s): %s — "
                "the prompt wording likely tripped it; see the note in _vision_smiles.",
                choice.get("finish_reason"),
                choice["message"].get("refusal") or "no detail",
            )
            return None
        text = choice["message"]["content"].strip()
        logger.info("Claude vision raw response: %r", text[:300])
    except Exception as exc:
        logger.warning("Claude vision error (%s): %s", type(exc).__name__, exc)
        return None
    return _smiles_from_vision_text(text, "Claude")


def _ollama_call(img_bytes: bytes, prompt: str) -> str | None:
    """
    Send an image + prompt to the Ollama vision model and return the first valid
    canonical SMILES found in the response. Returns None on any failure.
    Runs synchronously — always call from a thread pool, never the event loop.
    """
    import httpx

    model = _ollama_vision_model()
    if not model:
        logger.warning("No vision-capable Ollama model installed — skipping vision call")
        return None
    b64 = base64.b64encode(img_bytes).decode()
    logger.info("Ollama call → model=%s url=%s", model, OLLAMA_BASE_URL)
    try:
        resp = httpx.post(
            f"{OLLAMA_BASE_URL}/api/chat",
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt, "images": [b64]}],
                "stream": False,
                # SMILES output is short — capping decode length stops the
                # occasional VLM ramble from wasting tens of seconds.
                "options": {"temperature": 0, "num_predict": 256},
            },
            # Covers a cold model load (~6 GB); tune via OLLAMA_VISION_TIMEOUT.
            timeout=VISION_TIMEOUT,
        )
        resp.raise_for_status()
        text = resp.json()["message"]["content"].strip()
        logger.info("Ollama raw response: %r", text[:300])
    except Exception as exc:
        logger.warning("Ollama vision error (%s): %s", type(exc).__name__, exc)
        return None

    return _smiles_from_vision_text(text, "Ollama")


def _vision_call(img_bytes: bytes, prompt: str,
                 api_key: str | None = None) -> str | None:
    """Route a vision read to the best available backend: Claude when a key is
    available — the caller's BYOK key first, else a server-side
    ANTHROPIC_API_KEY (which may point at a gateway like MIT Parley) — falling
    back to local Ollama otherwise or on any Claude failure."""
    if api_key or os.environ.get("ANTHROPIC_API_KEY"):
        result = _anthropic_vision_call(img_bytes, prompt, api_key)
        if result:
            return result
    return _ollama_call(img_bytes, prompt)


def _vision_smiles(img_bytes: bytes, api_key: str | None = None) -> str | None:
    """
    Extract all molecule SMILES from an image, ignoring reaction notation.
    Used by the /analyze pipeline as a DECIMER fallback.
    """
    return _vision_call(
        img_bytes,
        # Wording is load-bearing: the Parley gateway content-filters persona
        # assignments ("You are an expert chemist") and output-suppression
        # directives ("Output ONLY ... no prose, no markdown"), returning
        # finish_reason=content_filter. Re-test against Parley before editing.
        "The image shows chemical structures, possibly alongside reaction notation.\n\n"
        "Report the SMILES for every actual chemical molecule present, separating "
        "molecules with a period (.). Leave out:\n"
        "  - Reaction arrows (→, ->, ⟶, curved electron-flow arrows)\n"
        "  - Question marks (?) indicating unknown products\n"
        "  - Plus signs (+) used as separators\n"
        "  - Text annotations: 'heat', 'Δ', 'hν', solvent names, temperatures",
        api_key,
    )


def _vision_reaction_smiles(img_bytes: bytes, api_key: str | None = None) -> str | None:
    """
    Extract only the INPUT molecules (starting materials + reagents) from a reaction image.
    Understands that arrows show reaction direction and question marks indicate the unknown
    product — neither should appear in the returned SMILES.
    Used by the /react-from-image pipeline.
    """
    return _vision_call(
        img_bytes,
        # See the wording note in _vision_smiles. A bulleted exclusion list trips
        # the Parley filter here (it does not in _vision_smiles), so the
        # exclusions are prose. Re-test against Parley before editing.
        "The image shows a chemical reaction: starting material(s) on the left of a reaction "
        "arrow, possibly reagents written above or below the arrow, and a product or question "
        "mark (?) on the right.\n\n"
        "Report the SMILES for the input molecules — the starting materials and reagents that "
        "go into the reaction — separating molecules with a period (.). Leave out the product "
        "and the question mark, along with reaction arrows, curved electron-flow arrows, plus "
        "signs used as separators, and text annotations such as 'heat', 'Δ', 'hν', solvent "
        "names and temperatures.",
        api_key,
    )


# ── "Choose Your Engine" — generative LLM provider router ────────────────────
# The engine picker (local / byok / hosted) ONLY powers generative explanations
# and chat. Structure recognition uses the server-side ANTHROPIC_API_KEY when
# present (see _vision_call), else runs keyless via local Ollama.
# A BYOK api_key is request-scoped: never persisted, never logged.

# Chat/explanations run on Haiku by default — ~1/3 the cost of Sonnet and
# fine for pedagogical prose; vision stays on Sonnet (ANTHROPIC_VISION_MODEL).
DEFAULT_ANTHROPIC_MODEL = os.environ.get("HOSTED_ANTHROPIC_MODEL", "claude-haiku-4-5")
DEFAULT_OPENAI_MODEL    = os.environ.get("HOSTED_OPENAI_MODEL", "gpt-4o-mini")

# Lightweight in-memory usage telemetry (per engine mode/provider). Resets on
# restart — just enough to see where generative calls are going before real
# billing/enforcement lands.
_ENGINE_USAGE: dict[str, int] = {}


def _record_usage(mode: str, provider: str | None) -> None:
    key = f"{mode}:{provider or '-'}"
    _ENGINE_USAGE[key] = _ENGINE_USAGE.get(key, 0) + 1


# "No template matched" tracking, so new SMARTS templates get prioritized by
# real usage instead of guesswork. The log line is the durable signal
# (greppable TEMPLATE_GAP prefix); the counter is a dev convenience view with
# the same resets-on-restart tradeoff as _ENGINE_USAGE.
_TEMPLATE_GAPS: dict[str, int] = {}   # "substrate|reagent" (canonical) → miss count


def _record_template_gap(endpoint: str, substrate: str, reagent: str,
                         conditions: list[str]) -> None:
    logger.info("TEMPLATE_GAP endpoint=%s substrate=%s reagent=%s conditions=%s",
                endpoint, substrate, reagent, ",".join(conditions))
    key = f"{substrate}|{reagent}"
    _TEMPLATE_GAPS[key] = _TEMPLATE_GAPS.get(key, 0) + 1


class EngineConfig(BaseModel):
    """Per-request generative-AI engine selection. Never persisted server-side."""
    mode: str = "hosted"            # "local" | "byok" | "hosted"
    provider: Optional[str] = None  # "anthropic" | "openai"
    model: Optional[str] = None     # concrete model id
    api_key: Optional[str] = None   # BYOK only — request-scoped, never stored/logged


async def _stream_ollama(system: str, messages: list[dict], max_tokens: int, model: str | None = None):
    """Async generator: streams SSE delta chunks from a local Ollama model."""
    import httpx
    payload = {
        "model": model or OLLAMA_MODEL,
        "messages": [{"role": "system", "content": system}] + messages,
        "stream": True,
        "options": {"num_predict": max_tokens},
    }
    async with httpx.AsyncClient() as client:
        async with client.stream(
            "POST", f"{OLLAMA_BASE_URL}/v1/chat/completions",
            json=payload, timeout=120.0,
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    chunk = line[6:].strip()
                    if chunk == "[DONE]":
                        break
                    try:
                        data = json.loads(chunk)
                        delta = data["choices"][0]["delta"].get("content", "")
                        if delta:
                            yield f"data: {json.dumps({'delta': delta})}\n\n"
                    except Exception:
                        pass
    yield "data: [DONE]\n\n"


async def _stream_anthropic(system: str, messages: list[dict], max_tokens: int,
                            model: str | None = None, api_key: str | None = None):
    """Async generator: streams SSE delta chunks from Anthropic."""
    import anthropic
    if api_key:
        # BYOK: don't inherit the server's ANTHROPIC_BASE_URL (a gateway like
        # Parley would reject a real Anthropic key). Route by key prefix.
        base_url = ("https://parley.api.mit.edu" if api_key.startswith("sk-parley-")
                    else "https://api.anthropic.com")
        client = anthropic.AsyncAnthropic(api_key=api_key, base_url=base_url)
    else:
        client = anthropic.AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    async with client.messages.stream(
        model=model or DEFAULT_ANTHROPIC_MODEL,
        max_tokens=max_tokens,
        system=system,
        messages=messages,
    ) as stream:
        async for text in stream.text_stream:
            yield f"data: {json.dumps({'delta': text})}\n\n"
    yield "data: [DONE]\n\n"


async def _anthropic_complete(system: str, user: str, max_tokens: int,
                              model: str | None = None,
                              api_key: str | None = None) -> str:
    """One-shot, non-streaming Anthropic completion. Used only for the
    short structured JSON answers (blind product guess, sanity check) — these
    don't need SSE since the frontend consumes them as a single JSON field,
    not incremental prose. Uses the caller's BYOK key when given, else the
    server key."""
    import anthropic
    key = api_key or os.environ["ANTHROPIC_API_KEY"]
    client = anthropic.AsyncAnthropic(
        api_key=key,
        base_url=anthropic_base_url(api_key, os.environ.get("ANTHROPIC_BASE_URL")),
    )
    resp = await client.messages.create(
        model=model or DEFAULT_ANTHROPIC_MODEL,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    # A refusal is a successful HTTP 200 whose text is a canned decline string,
    # which _parse_json_object would silently reject as unparseable. Log it so
    # the cause is visible — on the Parley gateway this is usually the prompt
    # wording tripping its content filter, not the chemistry.
    if resp.stop_reason == "refusal":
        logger.warning("Anthropic/gateway refused the request (stop_details=%s) — "
                       "check the prompt wording; see the note in _blind_guess_prompts.",
                       getattr(resp, "stop_details", None))
        return ""
    return resp.content[0].text if resp.content else ""


def _parse_json_object(text: str) -> dict | None:
    """Best-effort parse of a single JSON object out of an LLM response.
    Strips code fences, then falls back to the first {...} span. Returns
    None (never raises) on anything unparseable — callers must treat that
    as 'feature unavailable', not an error."""
    if not text:
        return None
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z]*\n?|```$", "", stripped).strip()
    try:
        obj = json.loads(stripped)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    m = re.search(r"\{.*\}", stripped, re.S)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


async def _stream_openai(system: str, messages: list[dict], max_tokens: int,
                         model: str | None = None, api_key: str | None = None):
    """Async generator: streams SSE delta chunks from OpenAI."""
    import openai
    client = openai.AsyncOpenAI(api_key=api_key or os.environ["OPENAI_API_KEY"])
    stream = await client.chat.completions.create(
        model=model or DEFAULT_OPENAI_MODEL,
        max_tokens=max_tokens,
        messages=[{"role": "system", "content": system}] + messages,
        stream=True,
    )
    async for chunk in stream:
        delta = (chunk.choices[0].delta.content or "") if chunk.choices else ""
        if delta:
            yield f"data: {json.dumps({'delta': delta})}\n\n"
    yield "data: [DONE]\n\n"


async def _stream_chat_completions(base_url: str, api_key: str | None, model: str,
                                   system: str, messages: list[dict], max_tokens: int):
    """Async generator: streams SSE deltas from an OpenAI-compatible
    /v1/chat/completions endpoint, with multimodal (image) message support.

    Used whenever a chat request carries image attachments: gateways like MIT
    Parley silently DROP base64 image blocks on their native /v1/messages
    passthrough, but deliver them on the chat-completions route — which
    api.anthropic.com, api.openai.com, and Ollama all serve too (see
    _anthropic_vision_call).
    """
    import httpx

    def to_openai(m: dict):
        images = m.get("images") or []
        if not images:
            return {"role": m["role"], "content": m["content"]}
        blocks = [
            {"type": "image_url",
             "image_url": {"url": f"data:{img['media_type']};base64,{img['data']}"}}
            for img in images
        ]
        if m.get("content"):
            blocks.append({"type": "text", "text": m["content"]})
        return {"role": m["role"], "content": blocks}

    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "stream": True,
        "messages": [{"role": "system", "content": system}] + [to_openai(m) for m in messages],
    }
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    async with httpx.AsyncClient() as client:
        async with client.stream(
            "POST", f"{base_url.rstrip('/')}/v1/chat/completions",
            json=payload, headers=headers, timeout=120.0,
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    chunk = line[6:].strip()
                    if chunk == "[DONE]":
                        break
                    try:
                        data = json.loads(chunk)
                        delta = data["choices"][0]["delta"].get("content", "")
                        if delta:
                            yield f"data: {json.dumps({'delta': delta})}\n\n"
                    except Exception:
                        pass
    yield "data: [DONE]\n\n"


def _friendly_stream_error(exc: Exception) -> str:
    """Map a provider/transport exception to a message a user can act on.

    Never include request payloads or API keys — only the exception class
    and a safe summary.
    """
    name = type(exc).__name__
    text = str(exc)
    if "Connect" in name or "ConnectionError" in name:
        return (
            "The Local (Ollama) engine is not reachable. Start Ollama, or pick a "
            "different engine under Settings → Engine."
        )
    if "404" in text and "ollama" in text.lower() or "not found, try pulling" in text.lower():
        return (
            "The selected local model isn't installed in Ollama. "
            "Run `ollama pull <model>` or pick another model in Settings → Engine."
        )
    if "authentication" in name.lower() or "401" in text:
        return "The API key was rejected by the provider. Check your key in Settings → Engine."
    if "rate" in name.lower() or "429" in text:
        return "The provider is rate-limiting requests. Wait a moment and try again."
    return f"The AI engine failed mid-response ({name}). Try again or switch engines in Settings → Engine."


async def _with_error_frames(gen):
    """Wrap a provider stream so failures surface as an SSE error frame.

    Provider generators start emitting only after the HTTP 200 headers are
    already sent, so a connect/auth failure can't become a normal HTTP error —
    without this wrapper the client just sees an empty stream and spins forever.
    """
    try:
        async for chunk in gen:
            yield chunk
    except Exception as exc:
        logger.warning("LLM stream failed (%s): %s", type(exc).__name__, exc)
        yield f"data: {json.dumps({'error': _friendly_stream_error(exc)})}\n\n"
        yield "data: [DONE]\n\n"


def _sse_stream(system: str, messages: list[dict], max_tokens: int,
                engine: Optional[EngineConfig] = None):
    """Return the streaming generator for the selected engine.

    Validation (missing keys) happens here, before streaming starts, so errors
    surface as a normal HTTP response rather than mid-stream. When no engine is
    supplied, fall back to env-based selection for back-compat.
    """
    return _with_error_frames(
        _select_stream(system, messages, max_tokens, engine))


def _anthropic_base_for_key(api_key: str | None) -> str:
    """Base URL for an Anthropic-family key. BYOK keys route by prefix (a real
    Anthropic key must not inherit a Parley ANTHROPIC_BASE_URL and vice versa);
    the server key uses the configured gateway."""
    if api_key:
        return ("https://parley.api.mit.edu" if api_key.startswith("sk-parley-")
                else "https://api.anthropic.com")
    return os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com")


def _select_multimodal_stream(system: str, messages: list[dict], max_tokens: int,
                              engine: Optional[EngineConfig]):
    """Engine routing for chat requests that carry image attachments. All
    providers (Anthropic/Parley, OpenAI, Ollama) speak the OpenAI-compatible
    chat-completions route, which — unlike Parley's /v1/messages — actually
    delivers image blocks."""
    mode = (engine.mode or "hosted").lower() if engine else "hosted"
    provider = ((engine.provider if engine else None) or "anthropic").lower()
    model = engine.model if engine else None

    if mode == "local":
        return _stream_chat_completions(OLLAMA_BASE_URL, None, model or OLLAMA_MODEL,
                                        system, messages, max_tokens)
    if mode == "byok":
        if not engine or not engine.api_key:
            raise HTTPException(400, "BYOK mode requires an API key.")
        if provider == "openai":
            return _stream_chat_completions("https://api.openai.com", engine.api_key,
                                            model or DEFAULT_OPENAI_MODEL,
                                            system, messages, max_tokens)
        return _stream_chat_completions(_anthropic_base_for_key(engine.api_key),
                                        engine.api_key, model or DEFAULT_ANTHROPIC_MODEL,
                                        system, messages, max_tokens)
    # hosted
    if provider == "openai" and os.environ.get("OPENAI_API_KEY"):
        return _stream_chat_completions("https://api.openai.com",
                                        os.environ["OPENAI_API_KEY"],
                                        model or DEFAULT_OPENAI_MODEL,
                                        system, messages, max_tokens)
    if os.environ.get("ANTHROPIC_API_KEY"):
        return _stream_chat_completions(_anthropic_base_for_key(None),
                                        os.environ["ANTHROPIC_API_KEY"],
                                        model or DEFAULT_ANTHROPIC_MODEL,
                                        system, messages, max_tokens)
    return _stream_chat_completions(OLLAMA_BASE_URL, None, model or OLLAMA_MODEL,
                                    system, messages, max_tokens)


def _select_stream(system: str, messages: list[dict], max_tokens: int,
                   engine: Optional[EngineConfig] = None):
    if any(m.get("images") for m in messages):
        _record_usage((engine.mode if engine else "hosted") or "hosted",
                      engine.provider if engine else None)
        return _select_multimodal_stream(system, messages, max_tokens, engine)
    if engine is None:
        _record_usage("env", None)
        if os.environ.get("ANTHROPIC_API_KEY"):
            return _stream_anthropic(system, messages, max_tokens)
        return _stream_ollama(system, messages, max_tokens)

    mode = (engine.mode or "hosted").lower()
    _record_usage(mode, engine.provider)

    if mode == "local":
        return _stream_ollama(system, messages, max_tokens, model=engine.model)

    if mode == "byok":
        if not engine.api_key:
            raise HTTPException(400, "BYOK mode requires an API key.")
        provider = (engine.provider or "anthropic").lower()
        if provider == "openai":
            return _stream_openai(system, messages, max_tokens,
                                  model=engine.model, api_key=engine.api_key)
        return _stream_anthropic(system, messages, max_tokens,
                                 model=engine.model, api_key=engine.api_key)

    # hosted — server-side key; billing/enforcement deferred (no users yet)
    provider = (engine.provider or "anthropic").lower()
    if provider == "openai" and os.environ.get("OPENAI_API_KEY"):
        return _stream_openai(system, messages, max_tokens, model=engine.model)
    if os.environ.get("ANTHROPIC_API_KEY"):
        return _stream_anthropic(system, messages, max_tokens, model=engine.model)
    # No hosted key configured → degrade to local so the app still works.
    return _stream_ollama(system, messages, max_tokens, model=engine.model)

app = FastAPI(title="Orgo AI")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        "http://localhost:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Hardening: request caps + per-IP rate limiting ───────────────────────────
MAX_UPLOAD_BYTES  = 8 * 1024 * 1024   # 8 MB per uploaded image
MAX_CHAT_MESSAGES = 50
MAX_CONTENT_CHARS = 24_000            # total chars across chat messages
MAX_HISTORY_LINES = 500

# Two rate-limit tiers per IP. HEAVY covers compute/generative endpoints.
# LIGHT covers the cheap renderers that must stay public even in prod
# (/structure is loaded via <img src>, which can't carry an auth header):
# they're input-capped but shouldn't be free CPU for a scripted loop. The
# LIGHT budget is deliberately loose — a pathway graph legitimately renders
# well over 60 SVG tiles in a minute, so it can't share the HEAVY tier.
# /health and /engine/* polls stay unlimited.
RATE_LIMIT_HEAVY = {
    "/analyze", "/react-from-image", "/react", "/pathways",
    "/explain", "/chat", "/assist", "/stereo",
}
RATE_LIMIT_HEAVY_MAX = 60       # requests per window per IP
RATE_LIMIT_LIGHT = {"/structure", "/molfile"}
RATE_LIMIT_LIGHT_MAX = 600
RATE_LIMIT_WINDOW = 60.0        # seconds
_rate_buckets: dict[str, deque] = {}

# Shared secret proving a request came from our own Next.js proxy. Unset
# means the check is off — the keyless local-development default.
ORGO_PROXY_SECRET = os.environ.get("ORGO_PROXY_SECRET") or None


def _client_ip(request, secret_ok: bool) -> str:
    """Best-effort real client IP, for rate-limit bucketing.

    Browser traffic arrives through the Next.js proxy, so request.client.host
    is the proxy's address for every user — keying the limiter on it collapses
    all clients into ONE shared bucket. The proxy sets X-Forwarded-For with the
    real client; we may believe it when the peer is loopback (proxy on this
    machine) or the request carried a valid ORGO_PROXY_SECRET (proxy on
    Vercel). A remote caller with neither cannot spoof the header to dodge the
    limit.

    Note `secret_ok`, NOT "authorized": with no secret configured every request
    is authorized, and dev binds 0.0.0.0 (start.bat), so authorization would
    hand any LAN host a spoofable bucket.
    """
    peer = request.client.host if request.client else "unknown"
    trusted = secret_ok or peer in LOOPBACK_IPS
    return resolve_client_ip(peer, request.headers.get("x-forwarded-for"), trusted)


@app.middleware("http")
async def _rate_limit(request, call_next):
    path = request.url.path

    # Access control before anything else: without the shared secret this
    # request did not come through our proxy. /health is exempt — Railway's
    # healthcheck probes the backend directly and carries no header.
    #
    # Two flags, deliberately: `authorized` may be true because no secret is
    # configured or because the path is exempt, neither of which says anything
    # about WHO sent the request. Only `secret_ok` does, so only it may unlock
    # X-Forwarded-For below.
    provided = request.headers.get(PROXY_SECRET_HEADER)
    secret_ok = secret_matches(provided, ORGO_PROXY_SECRET)
    authorized = proxy_authorized(provided, ORGO_PROXY_SECRET, path)
    if not authorized:
        return JSONResponse(
            status_code=403,
            content={"detail": "This API is reachable only through the Orgo AI app."},
        )

    # /analyze/verify/{token} holds a server connection for minutes while it
    # waits on the vision model — it must count against the heavy budget too.
    if path in RATE_LIMIT_HEAVY or path.startswith("/analyze/verify/"):
        limit, tier = RATE_LIMIT_HEAVY_MAX, "heavy"
    elif path in RATE_LIMIT_LIGHT:
        limit, tier = RATE_LIMIT_LIGHT_MAX, "light"
    else:
        return await call_next(request)

    key = f"{tier}:{_client_ip(request, secret_ok)}"
    now = time.monotonic()
    bucket = _rate_buckets.setdefault(key, deque())
    while bucket and now - bucket[0] > RATE_LIMIT_WINDOW:
        bucket.popleft()
    if not bucket:
        # Opportunistically drop other empty buckets so the per-IP dict
        # can't grow without bound across many distinct clients.
        for stale_key in [k for k, v in _rate_buckets.items() if not v and k != key]:
            _rate_buckets.pop(stale_key, None)
    if len(bucket) >= limit:
        return JSONResponse(
            status_code=429,
            content={"detail": "Rate limit exceeded — please slow down and retry shortly."},
        )
    bucket.append(now)
    return await call_next(request)


# Optional Supabase JWT auth. Enabled when either verification method is
# configured; disabled otherwise so local dev works out of the box. When
# enabled, protected endpoints require a valid Supabase access token (the
# frontend attaches `Authorization: Bearer <token>` to all API calls).
#
#   SUPABASE_JWT_SECRET — legacy shared-secret projects (HS256).
#   SUPABASE_URL / SUPABASE_JWKS_URL — projects on JWT signing keys, the
#     Supabase default since May 2025: tokens are RS256/ES256/EdDSA and are
#     verified against the project's public JWKS endpoint. SUPABASE_URL is the
#     same value the frontend uses as NEXT_PUBLIC_SUPABASE_URL.
#
# A project mid-migration can set both; the token's alg header picks the path.
SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET")
SUPABASE_JWKS_URL = os.environ.get("SUPABASE_JWKS_URL") or (
    f"{os.environ['SUPABASE_URL'].rstrip('/')}/auth/v1/.well-known/jwks.json"
    if os.environ.get("SUPABASE_URL") else None
)
AUTH_ENABLED = bool(SUPABASE_JWT_SECRET or SUPABASE_JWKS_URL)

# Deployment mode. "dev" (default) keeps auth optional for local use. "prod"
# refuses to start without a token-verification method, so the API can never
# reach a real network with auth silently disabled — the failure is at boot,
# not after someone finds the open endpoint.
ORGO_ENV = os.environ.get("ORGO_ENV", "dev").lower()
IS_PROD = ORGO_ENV in ("prod", "production")
if IS_PROD and not AUTH_ENABLED:
    raise RuntimeError(
        "ORGO_ENV=prod requires a way to verify Supabase tokens: set SUPABASE_URL "
        "(project URL — tokens verified via its public JWKS; Supabase default "
        "since May 2025) and/or SUPABASE_JWT_SECRET (legacy HS256 shared secret). "
        "Without one, every endpoint would be unauthenticated. Set one, or run "
        "with ORGO_ENV=dev for local development."
    )

_jwks_client = None


def _get_jwks_client():
    global _jwks_client
    if _jwks_client is None:
        import jwt
        _jwks_client = jwt.PyJWKClient(SUPABASE_JWKS_URL, cache_keys=True, lifespan=3600)
    return _jwks_client


def _verify_token(token: str) -> str | None:
    """Verify a Supabase access token and return its user id (sub).

    Blocking (the JWKS path can hit the network on cache miss) — call via
    asyncio.to_thread. Raises jwt exceptions on any failure.
    """
    import jwt
    alg = jwt.get_unverified_header(token).get("alg", "")
    if alg == "HS256":
        if not SUPABASE_JWT_SECRET:
            raise jwt.InvalidTokenError("HS256 token but no SUPABASE_JWT_SECRET configured")
        payload = jwt.decode(
            token, SUPABASE_JWT_SECRET, algorithms=["HS256"], audience="authenticated",
        )
    else:
        if not SUPABASE_JWKS_URL:
            raise jwt.InvalidTokenError(f"{alg or 'unknown'}-signed token but no SUPABASE_URL/SUPABASE_JWKS_URL configured")
        signing_key = _get_jwks_client().get_signing_key_from_jwt(token)
        payload = jwt.decode(
            token, signing_key.key,
            algorithms=["RS256", "ES256", "EdDSA"], audience="authenticated",
        )
    return payload.get("sub")


async def require_auth(authorization: str = Header(default="")):
    if not AUTH_ENABLED:
        return None  # auth disabled (dev)
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    try:
        return await asyncio.to_thread(_verify_token, authorization[7:])
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from exc


MAX_CHAT_IMAGES = 6                       # image attachments per request
MAX_CHAT_IMAGE_B64 = 6 * 1024 * 1024      # base64 chars per image (~4.5 MB raw)


def _guard_messages(messages) -> None:
    if len(messages) > MAX_CHAT_MESSAGES:
        raise HTTPException(status_code=413, detail="Too many messages in one request.")
    if sum(len(m.content) for m in messages) > MAX_CONTENT_CHARS:
        raise HTTPException(status_code=413, detail="Message payload too large.")
    images = [a for m in messages for a in getattr(m, "attachments", [])
              if a.kind == "image"]
    if len(images) > MAX_CHAT_IMAGES:
        raise HTTPException(status_code=413, detail="Too many image attachments in one request.")
    if any(len(a.data) > MAX_CHAT_IMAGE_B64 for a in images):
        raise HTTPException(status_code=413, detail="An attached image is too large.")


# ── Hosted-mode quota ─────────────────────────────────────────────────────────
# Hosted mode spends the SERVER's LLM API key, so each user gets a daily request
# cap. Local and BYOK modes spend the user's own resources — unmetered. Counters
# are in-memory by design: the API runs as a single process (see the executor
# notes below), and losing a day's counters on restart is acceptable for what is
# abuse protection, not billing.
HOSTED_DAILY_REQUESTS = int(os.environ.get("HOSTED_DAILY_REQUESTS", "200"))
_hosted_usage: dict[tuple[str, str], int] = {}   # (user_id, YYYY-MM-DD) → requests


def _enforce_hosted_quota(engine: Optional[EngineConfig], user_id: str | None) -> None:
    """Raise 429 when a hosted-mode generative request exceeds the daily cap.

    A missing engine config falls back to env-based selection, which also uses
    the server key when one is configured — so it's metered the same way.
    Without auth (dev), all callers share the 'anon' bucket.
    """
    mode = (engine.mode or "hosted").lower() if engine else "hosted"
    if mode != "hosted":
        return
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY")):
        return  # no server key configured → hosted degrades to local; nothing to meter
    day = time.strftime("%Y-%m-%d")
    for stale in [k for k in _hosted_usage if k[1] != day]:
        _hosted_usage.pop(stale, None)
    key = (user_id or "anon", day)
    if _hosted_usage.get(key, 0) >= HOSTED_DAILY_REQUESTS:
        raise HTTPException(
            status_code=429,
            detail="Daily hosted AI quota reached. Switch to Local or BYOK in "
                   "Settings → Engine, or try again tomorrow.",
        )
    _hosted_usage[key] = _hosted_usage.get(key, 0) + 1


# ── Direct Reaction: AI-guess fallback + advisory sanity check ────────────────
# Both are single-shot, fail-open extras layered on the deterministic engine:
# the blind guess runs ONLY when zero templates matched (clearly labeled
# unverified in the UI), the sanity check ONLY when a template did match
# (purely advisory — it can flag, never override). Any failure — quota,
# network, unparseable output, invalid SMILES — degrades to None, never into
# the response. No retries by design: a retry-until-agreement loop would let
# a stochastic LLM veto a deterministic computation.


def _validate_and_canonicalize_smiles(smiles: str) -> str | None:
    """RDKit validity + canonicalization for LLM-produced SMILES. Returns
    None for anything that doesn't parse — a hallucinated non-SMILES answer
    must degrade to 'no guess available', never reach the frontend."""
    from rdkit import Chem
    mol = Chem.MolFromSmiles((smiles or "").strip())
    return Chem.MolToSmiles(mol) if mol is not None else None


def _blind_guess_prompts(substrate_smiles: str, reagent_smiles: str) -> tuple[str, str]:
    system = (
        "You are an organic chemistry prediction assistant for Orgo AI. "
        "Orgo AI's deterministic template engine found NO matching reaction "
        "template for the substrate/reagent pair below — this reflects a gap "
        "in curated template coverage, not proof the reaction is impossible.\n\n"
        "Give your own single best-guess prediction of the major organic "
        "product, the way a careful organic chemistry student would attempt "
        "it by hand.\n\n"
        # Phrasing note: the MIT Parley gateway runs an input content filter that
        # rejects output-suppression directives ("respond with ONLY", "no prose
        # outside the JSON") with finish_reason=content_filter. Keep format
        # requests permissive — _parse_json_object already strips code fences.
        "GUIDELINES:\n"
        "- You are shown NO verified ground truth here. This is a genuine, "
        "unverified guess and must be labeled as such.\n"
        "- Format your answer as a JSON object with the shape below.\n"
        "- JSON shape exactly: "
        '{"product_smiles": "<valid SMILES of the major product, or "" if '
        'you cannot determine one>", "reaction_name": "<short mechanism name '
        'or null>", "confidence": "low" | "medium", "reasoning": "<1-2 '
        'sentence rationale, under 240 characters>"}\n'
        '- Never use confidence "high" — this path only runs when there is '
        "no verified answer.\n"
        '- If you are not reasonably confident of any product, set '
        'product_smiles to "" and explain why in reasoning.'
    )
    user = (
        "Predict the major organic product for this reaction.\n\n"
        f"Substrate (SMILES): {substrate_smiles}\n"
        f"Reagent(s) (SMILES): {reagent_smiles}\n\n"
        "Answer as a JSON object."
    )
    return system, user


def _sanity_check_prompts(substrate_smiles: str, reagent_smiles: str,
                          products: list[dict]) -> tuple[str, str]:
    system = (
        "You are a chemistry sanity-check reviewer for Orgo AI. A "
        "deterministic, verified SMARTS-template engine has already computed "
        "the product(s) below — this connectivity is confirmed correct by "
        "the template match and MUST NOT be second-guessed, relabeled, or "
        "revised.\n\n"
        "Your job is only to skim for something that would look genuinely "
        "surprising or worth a caveat to an organic chemistry instructor "
        "(e.g. an unusual reagent/substrate pairing for the matched reaction "
        "class, a stereochemistry/regiochemistry caveat worth noting, a "
        "safety or side-reaction note). This is a purely advisory pass.\n\n"
        # See the phrasing note in _blind_guess_prompts — the Parley gateway
        # content-filters output-suppression directives.
        "GUIDELINES:\n"
        "- Do not propose an alternative product. Do not contradict the "
        "given product.\n"
        "- Format your answer as a JSON object with the shape below.\n"
        "- JSON shape exactly: "
        '{"flagged": true | false, "note": "<one short sentence, under 160 '
        'characters, only when flagged is true, else empty string>"}\n'
        "- Default to flagged: false. Only set true for a specific, genuine "
        "concern — not generic commentary or praise."
    )
    product_lines = "\n".join(
        f"  - {p['smiles']}  (reaction: {p['reaction_name']})" for p in products[:3]
    )
    user = (
        f"Substrate: {substrate_smiles}\n"
        f"Reagent(s): {reagent_smiles}\n"
        f"Engine product(s):\n{product_lines}\n\n"
        "Is anything here worth flagging to a student? Answer as a JSON object."
    )
    return system, user


async def _maybe_blind_guess(substrate: str, reagent: str, user_id: str | None,
                             api_key: str | None = None) -> dict | None:
    if not (api_key or os.environ.get("ANTHROPIC_API_KEY")):
        return None
    try:
        _enforce_hosted_quota(None, user_id)
    except HTTPException:
        logger.info("ai_guess skipped: hosted quota reached (user=%s)", user_id or "anon")
        return None
    try:
        system, user = _blind_guess_prompts(substrate, reagent)
        raw = await _anthropic_complete(system, user, max_tokens=300, api_key=api_key)
        data = _parse_json_object(raw)
        if not data or not data.get("product_smiles"):
            return None
        loop = asyncio.get_event_loop()
        canon = await loop.run_in_executor(
            _chem_pool, _validate_and_canonicalize_smiles, data["product_smiles"])
        if canon is None:
            logger.info("ai_guess discarded: RDKit rejected %r", data.get("product_smiles"))
            return None
        confidence = data.get("confidence") if data.get("confidence") in ("low", "medium") else "low"
        return {
            "smiles": canon,
            "reaction_name": data.get("reaction_name") or None,
            "confidence": confidence,
            "reasoning": (data.get("reasoning") or "")[:280],
            "unverified": True,
        }
    except Exception as exc:
        logger.warning("ai_guess failed (%s): %s", type(exc).__name__, exc)
        return None


async def _maybe_sanity_check(substrate: str, reagent: str, products: list[dict],
                              user_id: str | None,
                              api_key: str | None = None) -> dict | None:
    if not (api_key or os.environ.get("ANTHROPIC_API_KEY")):
        return None
    try:
        _enforce_hosted_quota(None, user_id)
    except HTTPException:
        return None
    try:
        system, user = _sanity_check_prompts(substrate, reagent, products)
        raw = await _anthropic_complete(system, user, max_tokens=150, api_key=api_key)
        data = _parse_json_object(raw)
        if not data:
            return None
        return {
            "flagged": bool(data.get("flagged")),
            "note": (data.get("note") or "")[:200] if data.get("flagged") else "",
        }
    except Exception as exc:
        logger.warning("sanity_check failed (%s): %s", type(exc).__name__, exc)
        return None


# ── Chat tools: the assistant can drive parts of the app ─────────────────────
# Tool calls run server-side (pure engine work — no nested LLM calls) and are
# surfaced to the browser as SSE `tool_event` frames so the UI can render
# product cards in the conversation and update the Synthesis panel. Which
# tools a chat gets depends on where it's embedded ("surface").

_CHAT_TOOL_DEFS: dict[str, dict] = {
    "run_reaction": {
        "name": "run_reaction",
        "description": (
            "Run Orgo AI's reaction engine on one substrate + one reagent "
            "(SMILES). Use this BEFORE answering any question about what two "
            "specific molecules form. Convert names to SMILES yourself, "
            "writing ionic reagents in their reactive ionic form — sodium "
            "ethoxide as CC[O-].[Na+], NaOH as [OH-].[Na+], t-BuOK as "
            "CC(C)(C)[O-].[K+], LDA as CC(C)[N-]C(C)C.[Li+] — never as "
            "neutral aggregates like CCO.[Na]. Results render as cards in "
            "the UI.\n"
            "Reading the result: `source` is 'templates' (a curated, "
            "human-written rule — treat as ground truth) or 'askcos' (an ML "
            "forward predictor — reliable when `probability` is high). "
            "`low_confidence: true` means no curated rule corroborates the "
            "prediction and the model itself is unsure — say so plainly "
            "rather than presenting it as settled. A reaction_name of "
            "'Predicted (unnamed)' means the product is predicted but the "
            "name library has no entry; do not invent a name for it."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "substrate_smiles": {"type": "string", "description": "Substrate SMILES"},
                "reagent_smiles": {"type": "string", "description": "Reagent SMILES (multi-fragment with '.' allowed)"},
            },
            "required": ["substrate_smiles", "reagent_smiles"],
        },
    },
    "set_stockroom": {
        "name": "set_stockroom",
        "description": (
            "Set or extend the user's Synthesis stockroom (starting "
            "materials). Use when the user asks to add, set, or replace "
            "materials. The panel updates live."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "smiles": {"type": "array", "items": {"type": "string"},
                           "description": "Starting-material SMILES"},
                "mode": {"type": "string", "enum": ["replace", "add"],
                         "description": "replace the stockroom or add to it (default replace)"},
            },
            "required": ["smiles"],
        },
    },
    "run_pathways": {
        "name": "run_pathways",
        "description": (
            "Run pathway exploration: fan the starting material(s) out across "
            "the reagent catalog (optionally searching toward a target "
            "product). The graph renders in the Synthesis panel."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_smiles": {"type": "array", "items": {"type": "string"},
                                 "description": "Starting-material SMILES (1-4)"},
                "target_smiles": {"type": "string", "description": "Optional target product SMILES"},
            },
            "required": ["start_smiles"],
        },
    },
}

# Which tools each chat surface exposes. Stockroom/pathways manipulation only
# makes sense where the Synthesis panel is on screen (its Assistant drawer).
_SURFACE_TOOLS: dict[str, list[str]] = {
    "synthesis": ["run_reaction", "set_stockroom", "run_pathways"],
    "reaction": ["run_reaction"],
    "chat": ["run_reaction"],
}

_CHAT_TOOL_ROUNDS = 4   # bound on tool-call iterations per /chat request

_CHAT_TOOLS_SYSTEM = (
    "\n\nTOOLS:\n"
    "- run_reaction: ALWAYS call this before answering what two specific "
    "molecules form. Its output is verified ground truth — never contradict "
    "it. If it returns zero products, say the verified engine has no rule "
    "for that pair, then you may give your own prediction clearly labeled "
    "as an unverified AI guess.\n"
    "- set_stockroom (when available): use when the user asks to set or add "
    "starting materials; confirm what you set.\n"
    "- run_pathways (when available): use when the user asks to explore "
    "routes from their materials; the graph appears in the Synthesis panel.\n"
    "- Tool results render as cards in the UI automatically — explain the "
    "chemistry concisely instead of restating raw SMILES or JSON."
)


async def _execute_chat_tool(name: str, args: dict) -> tuple[dict, dict | None]:
    """Run one chat tool. Returns (model_view, ui_event): what the model reads
    back, and the tool_event frame for the browser (None to skip). Never
    raises — errors become a message the model can relay."""
    try:
        if name == "run_reaction":
            core = await _react_core(str(args.get("substrate_smiles", "")),
                                     str(args.get("reagent_smiles", "")))
            if not core["products"]:
                _record_template_gap("chat", core["substrate_smiles"],
                                     core["reagent_smiles"], core["conditions"])
            model_view = {
                "substrate_smiles": core["substrate_smiles"],
                "reagent_smiles": core["reagent_smiles"],
                "environment": core["environment"],
                # The model is told which engine answered and how confident it
                # was, so it can hedge on a low-probability ASKCOS prediction
                # instead of presenting everything with equal certainty. In
                # chat the model IS the second opinion, so low_confidence is
                # surfaced to it rather than triggering a separate call.
                "source": core["source"],
                "low_confidence": core["low_confidence"],
                "products": [
                    {"smiles": p["smiles"], "reaction_name": p["reaction_name"],
                     "steps_taken": p["steps_taken"],
                     "probability": p.get("probability"),
                     "execution_history": p["execution_history"]}
                    for p in core["products"]
                ],
            }
            if not core["products"]:
                model_view["note"] = (
                    "No reaction template matched. Tell the user the verified "
                    "engine has no rule for this pair; you may offer a clearly "
                    "labeled unverified guess."
                )
            return model_view, {"type": "reaction_result", "data": core}

        if name == "set_stockroom":
            loop = asyncio.get_event_loop()
            valid: list[str] = []
            invalid: list[str] = []
            for smi in list(args.get("smiles") or [])[:8]:
                canon = await loop.run_in_executor(
                    _chem_pool, _validate_and_canonicalize_smiles, str(smi))
                (valid if canon else invalid).append(canon or str(smi))
            mode = args.get("mode") if args.get("mode") in ("replace", "add") else "replace"
            if not valid:
                return {"applied": False, "invalid": invalid,
                        "note": "No valid SMILES — nothing changed."}, None
            return ({"applied": True, "smiles": valid, "mode": mode, "invalid": invalid},
                    {"type": "set_stockroom", "data": {"smiles": valid, "mode": mode}})

        if name == "run_pathways":
            req = PathwaysRequest(
                start_smiles=[str(s) for s in (args.get("start_smiles") or [])][:4],
                target_smiles=(str(args.get("target_smiles")) if args.get("target_smiles") else None),
            )
            result = await pathways(req)
            branches = result.get("branches") or []
            routes = result.get("routes") or []
            model_view = {
                "search_mode": result.get("search_mode"),
                "result_status": result.get("result_status"),
                "shortest_route_depth": result.get("shortest_route_depth"),
                "no_match_message": result.get("no_match_message"),
                "route_count": len(routes),
                "branches": [
                    {"reagent": (b.get("reagent") or {}).get("name"),
                     "reaction": (b.get("reaction_classification") or {}).get("name"),
                     "product": b.get("product_smiles")}
                    for b in branches[:12]
                ],
            }
            ui_event = {"type": "pathways_result", "data": {
                "start_smiles": req.start_smiles,
                "target_smiles": req.target_smiles or "",
                "pathways": result,
            }}
            return model_view, ui_event

        return {"error": f"Unknown tool: {name}"}, None
    except HTTPException as exc:
        return {"error": str(exc.detail)}, None
    except Exception as exc:
        logger.warning("chat tool %s failed (%s): %s", name, type(exc).__name__, exc)
        return {"error": f"Tool failed: {type(exc).__name__}"}, None


async def _stream_anthropic_tools(system: str, messages: list[dict], max_tokens: int,
                                  surface: str, model: str | None = None,
                                  explain: bool = True,
                                  api_key: str | None = None):
    """Streaming Anthropic chat with a bounded server-side tool loop. Text
    deltas stream as normal SSE frames; each executed tool additionally emits
    a `tool_event` frame for the UI."""
    import anthropic
    key = api_key or os.environ["ANTHROPIC_API_KEY"]
    client = anthropic.AsyncAnthropic(
        api_key=key,
        base_url=anthropic_base_url(api_key, os.environ.get("ANTHROPIC_BASE_URL")),
    )
    tool_names = _SURFACE_TOOLS.get(surface) or ["run_reaction"]
    tools = [_CHAT_TOOL_DEFS[n] for n in tool_names if n in _CHAT_TOOL_DEFS]
    convo: list[dict] = [dict(m) for m in messages]

    for round_index in range(_CHAT_TOOL_ROUNDS):
        # tools must be sent on EVERY request once the history contains
        # toolUse/toolResult blocks — Bedrock-backed gateways (Parley) reject
        # the request otherwise. Termination comes from the round cap below,
        # not from withdrawing the tools.
        # Deferred mode cannot stream as it goes: the model often writes a
        # preamble BEFORE its tool call (measured on this stack: first text at
        # 4.4s, tool call at 9.4s), and that preamble is exactly the prose the
        # user asked us not to generate. Buffer until we know whether a tool ran.
        buffered: list[str] = []
        async with client.messages.stream(
            model=model or DEFAULT_ANTHROPIC_MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=convo,
            tools=tools,
        ) as stream:
            async for text in stream.text_stream:
                if explain:
                    yield f"data: {json.dumps({'delta': text})}\n\n"
                else:
                    buffered.append(text)
            final = await stream.get_final_message()

        tool_uses = [b for b in final.content if getattr(b, "type", None) == "tool_use"]

        if not explain:
            if not tool_uses:
                # No engine work this turn, so nothing was deferred — this is a
                # real answer to a real question (a follow-up like "why SN1?")
                # and withholding it would just lose the reply.
                for text in buffered:
                    yield f"data: {json.dumps({'delta': text})}\n\n"
                break
            # A tool ran: the card is the answer. Drop the preamble, emit the
            # engine result, and stop before the explanation round.
            for block in tool_uses:
                _model_view, ui_event = await _execute_chat_tool(
                    block.name, dict(block.input or {}))
                if ui_event:
                    yield f"data: {json.dumps({'tool_event': ui_event})}\n\n"
            break

        # Round cap reached: stop executing tools; the text streamed so far
        # stands as the answer.
        if not tool_uses or round_index == _CHAT_TOOL_ROUNDS - 1:
            break

        convo.append({"role": "assistant", "content": final.content})
        results = []
        for block in tool_uses:
            model_view, ui_event = await _execute_chat_tool(
                block.name, dict(block.input or {}))
            if ui_event:
                yield f"data: {json.dumps({'tool_event': ui_event})}\n\n"
            results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": json.dumps(model_view),
            })
        convo.append({"role": "user", "content": results})

    yield "data: [DONE]\n\n"


_decimer_fn = None
_executor  = ThreadPoolExecutor(max_workers=1)   # DECIMER OSR only (not thread-safe)
_svg_pool  = ThreadPoolExecutor(max_workers=4)   # RDKit SVG rendering (thread-safe, fast)
_chem_pool = ThreadPoolExecutor(max_workers=4)   # template engine / pathway search — kept off
                                                 # _executor so /react and /pathways never queue
                                                 # behind an in-flight OSR read
_vision_pool = ThreadPoolExecutor(max_workers=2) # Ollama vision HTTP calls — must not
                                                 # share _executor or they'd serialize
                                                 # behind DECIMER instead of running
                                                 # concurrently with it
_molscribe_pool = ThreadPoolExecutor(max_workers=1)  # MolScribe (torch) — its own
                                                 # single worker so its reads overlap
                                                 # DECIMER's instead of queueing
                                                 # behind them on _executor

# One TemplateEngine per chem-pool thread: RDKit's compiled reaction objects
# aren't documented thread-safe for concurrent RunReactants, and re-loading the
# template JSON per thread costs milliseconds once.
_thread_engines = threading.local()


def _get_engine() -> TemplateEngine:
    engine = getattr(_thread_engines, "engine", None)
    if engine is None:
        engine = TemplateEngine()
        _thread_engines.engine = engine
    return engine

# Deferred verification: /analyze returns the DECIMER read immediately and hands
# the client a token; the in-flight vision read is parked here until the client
# collects it via GET /analyze/verify/{token}. Entries the client never claims
# (tab closed, etc.) are purged by TTL on the next insert.
_PENDING_VERIFY: dict[str, dict] = {}
_PENDING_VERIFY_TTL = 600.0  # seconds


def _store_pending_verify(future, smiles: str) -> str:
    now = time.monotonic()
    for stale in [t for t, e in _PENDING_VERIFY.items()
                  if now - e["created"] > _PENDING_VERIFY_TTL]:
        _PENDING_VERIFY.pop(stale, None)
    token = uuid.uuid4().hex
    _PENDING_VERIFY[token] = {"future": future, "smiles": smiles, "created": now}
    return token
MAX_DIM = 1024

# The reagent catalog lives in reagents.py (pure data, importable by the
# diagnostic and the test suite without loading this app).
from reagents import REAGENT_LIST


# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_decimer():
    global _decimer_fn
    if _decimer_fn is None:
        from DECIMER import predict_SMILES
        _decimer_fn = predict_SMILES
    return _decimer_fn


# Warm DECIMER in the background so the first user request doesn't pay the
# cold-start penalty. Runs on _executor — the same single-worker pool that
# serves /analyze — so the API binds its port immediately and any early image
# request simply queues behind the warm-up instead of failing.
# Non-fatal: without DECIMER the /analyze OSR path degrades to the vision-model
# fallback, and every non-image feature still works.
def _warm_decimer() -> None:
    try:
        _load_decimer()
        logger.info("DECIMER warm-load complete")
    except Exception as _exc:
        logger.warning(
            "DECIMER unavailable (%s: %s) — image structure recognition will rely on "
            "the vision-model fallback. Install with: pip install decimer",
            type(_exc).__name__, _exc,
        )


_executor.submit(_warm_decimer)


# ── MolScribe — second local OSR reader ──────────────────────────────────────
# A different architecture from DECIMER (Swin transformer, trained with
# explicit-H and hand-drawn augmentation), so its errors are largely
# uncorrelated: exact canonical agreement between the two gives an instant
# "verified" without waiting on the (slow) vision model. Needs the vendored
# OpenNMT subset in _vendor/ — see _vendor/onmt/__init__.py for why.
_molscribe_model = None


def _load_molscribe():
    global _molscribe_model
    if _molscribe_model is None:
        import sys
        vendor = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_vendor")
        if vendor not in sys.path:
            sys.path.insert(0, vendor)
        import torch
        from huggingface_hub import hf_hub_download
        from molscribe import MolScribe as _MolScribe
        ckpt = hf_hub_download("yujieq/MolScribe", "swin_base_char_aux_1m.pth")
        _molscribe_model = _MolScribe(ckpt, device=torch.device("cpu"))
    return _molscribe_model


def _warm_molscribe() -> None:
    try:
        _load_molscribe()
        logger.info("MolScribe warm-load complete")
    except Exception as exc:
        logger.warning(
            "MolScribe unavailable (%s: %s) — reader-agreement verification is off; "
            "/analyze falls back to vision-model verification alone.",
            type(exc).__name__, exc,
        )


# Warms on its own pool: loads in parallel with DECIMER's warm-up, and a slow
# MolScribe download can never delay the first DECIMER read.
_molscribe_pool.submit(_warm_molscribe)


# /health is polled by every open tab (ApiStatusBanner), and the Ollama probe
# inside it is a blocking HTTP call. Cache the probe result briefly so poll
# storms cost one probe per window, and (below) run it off the event loop.
_OLLAMA_STATUS_TTL = 5.0  # seconds
_ollama_status_cache: tuple[float, dict] | None = None


def _ollama_status() -> dict:
    """Probe the local Ollama server. Returns reachability + available models.

    Used both at startup (logging) and by GET /engine/ollama-status so the
    "Choose Your Engine" picker can show a real detected/not-detected state.
    Synchronous (blocking up to ~5s when Ollama is down) — async endpoints
    must call it via _ollama_status_async, never directly.
    """
    try:
        import httpx
        r = httpx.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5.0)
        r.raise_for_status()
        models = [m["name"] for m in r.json().get("models", [])]
        vision_model = _ollama_vision_model()
        return {
            "running": True,
            "base_url": OLLAMA_BASE_URL,
            "models": models,
            "chat_model": OLLAMA_MODEL,
            "vision_model": vision_model,
            "vision_available": vision_model is not None,
            "error": None,
        }
    except Exception as exc:
        return {
            "running": False,
            "base_url": OLLAMA_BASE_URL,
            "models": [],
            "chat_model": OLLAMA_MODEL,
            "vision_model": None,
            "vision_available": False,
            # Class name only — full text can embed internal URLs/paths and
            # this dict is served verbatim by /engine/ollama-status.
            "error": type(exc).__name__,
        }


async def _ollama_status_async() -> dict:
    """TTL-cached, non-blocking wrapper around _ollama_status.

    The probe is a synchronous HTTP call with a 5s connect timeout; calling it
    directly from an async endpoint froze the WHOLE event loop for up to 5s
    per /health poll whenever Ollama was down.
    """
    global _ollama_status_cache
    now = time.monotonic()
    if _ollama_status_cache and now - _ollama_status_cache[0] < _OLLAMA_STATUS_TTL:
        return _ollama_status_cache[1]
    status = await asyncio.to_thread(_ollama_status)
    _ollama_status_cache = (time.monotonic(), status)
    return status


def _check_ollama() -> None:
    """Log Ollama reachability and confirm the vision model is available."""
    status = _ollama_status()
    if status["running"]:
        logger.info("Ollama reachable at %s — models: %s", OLLAMA_BASE_URL, status["models"])
        if not status["vision_available"]:
            logger.warning(
                "No vision-capable model found in Ollama (available: %s). "
                "Ollama image fallback will fail until one is pulled "
                "(e.g. `ollama pull qwen2.5vl:7b`).",
                status["models"],
            )
    else:
        logger.warning("Ollama unreachable at %s (%s). Image fallback disabled.",
                       OLLAMA_BASE_URL, status["error"])

_check_ollama()


@app.get("/engine/ollama-status")
async def engine_ollama_status():
    """Live probe for the engine picker: is a local Ollama server available?"""
    return await _ollama_status_async()


@app.get("/health")
async def health():
    """Readiness probe used by the frontend (offline banner) and any monitor."""
    ollama = await _ollama_status_async()
    return {
        "status": "ok",
        "decimer_ready": _decimer_fn is not None,
        "molscribe_ready": _molscribe_model is not None,
        "ollama_running": ollama["running"],
        "hosted_key_configured": bool(
            os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY")
        ),
    }


@app.get("/engine/usage")
async def engine_usage():
    """In-memory generative-call counts per engine mode/provider (since restart)."""
    return {"usage": dict(_ENGINE_USAGE), "total": sum(_ENGINE_USAGE.values())}


@app.get("/engine/template-gaps")
async def template_gaps():
    """In-memory 'no template matched' counts per (substrate, reagent) pair
    since restart — use to prioritize which SMARTS templates to add next."""
    top = sorted(_TEMPLATE_GAPS.items(), key=lambda kv: kv[1], reverse=True)[:100]
    return {"gaps": [{"pair": k, "count": v} for k, v in top],
            "total_misses": sum(_TEMPLATE_GAPS.values())}


def _is_valid_smiles(smiles: str) -> bool:
    if not smiles:
        return False
    try:
        from rdkit import Chem
        return Chem.MolFromSmiles(smiles) is not None
    except Exception:
        return False


def _to_b64(img: np.ndarray) -> str | None:
    if img is None:
        return None
    ok, buf = cv2.imencode(".png", img)
    return base64.b64encode(buf).decode() if ok else None


STAGE_THUMB_DIM = 320  # stage previews are diagnostic thumbnails, not working images


def _stage_b64(img: np.ndarray) -> str | None:
    """Downscaled base64 PNG for the /analyze stage strip. Full-resolution
    stages made every /analyze response multi-MB; the strip renders these at
    ~100 px anyway, so a 320 px thumbnail loses nothing visible."""
    if img is None:
        return None
    h, w = img.shape[:2]
    if max(h, w) > STAGE_THUMB_DIM:
        scale = STAGE_THUMB_DIM / max(h, w)
        img = cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))),
                         interpolation=cv2.INTER_AREA)
    return _to_b64(img)


def _resize(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    if max(h, w) > MAX_DIM:
        scale = MAX_DIM / max(h, w)
        img = cv2.resize(img, (int(w * scale), int(h * scale)),
                         interpolation=cv2.INTER_AREA)
    return img


def _vision_png(img: np.ndarray) -> bytes:
    """Encode the image the vision model sees: capped at VISION_MAX_DIM.
    VLM prefill time scales with pixel count, and structures stay legible
    well below the OSR working resolution."""
    h, w = img.shape[:2]
    if max(h, w) > VISION_MAX_DIM:
        scale = VISION_MAX_DIM / max(h, w)
        img = cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))),
                         interpolation=cv2.INTER_AREA)
    _, buf = cv2.imencode(".png", img)
    return buf.tobytes()


def _extract_history_smiles(execution_history: list[str]) -> list[str]:
    """Pull SMILES strings out of execution_history step lines."""
    smiles_list = []
    for entry in execution_history:
        if "): " in entry:
            smiles_list.append(entry.split("): ", 1)[1].strip())
    return smiles_list


def _mol_svg(smiles: str, width: int, height: int) -> str:
    from rdkit import Chem
    from rdkit.Chem import AllChem
    from rdkit.Chem.Draw import rdMolDraw2D

    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return ""
    try:
        AllChem.Compute2DCoords(mol)
    except Exception:
        pass
    drawer = rdMolDraw2D.MolDraw2DSVG(width, height)
    opts = drawer.drawOptions()
    opts.addAtomIndices = False
    opts.addStereoAnnotation = True
    opts.padding = 0.15
    drawer.DrawMolecule(mol)
    drawer.FinishDrawing()
    return drawer.GetDrawingText()


# ── Image processing (runs in thread pool) ────────────────────────────────────

def _digital_polarity(img: np.ndarray) -> str | None:
    """Detect an already-clean digital depiction (screenshot, PDF render,
    ChemDraw export). These are bimodal — mostly uniform background with
    crisp ink and almost no midtones — whereas phone photos are full of
    midtones from shadows, paper texture, and uneven lighting.

    Returns "light" for the classic dark-ink-on-white render, "dark" for a
    dark-mode render (same bimodal signature, inverted), and None for photos.
    Dark-mode screenshots previously fell through to the photo pipeline,
    whose repair stages could only degrade them.

    For clean digital images the photo-repair stages (perspective warp,
    deskew, NLM denoise) are pure downside: slow (NLM takes seconds) and able
    to warp or blur a depiction that was already perfect.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    white = float(np.mean(gray > 235))
    dark = float(np.mean(gray < 90))
    midtone = 1.0 - white - dark
    if midtone >= 0.10:
        return None
    if white > 0.60 and dark < 0.25:
        return "light"
    if dark > 0.60 and white < 0.25:
        return "dark"
    return None


def _canonical_smiles(raw: str | None) -> str | None:
    """
    Validate + canonicalize reader output; None if unparseable.

    Explicitly drawn hydrogens are collapsed (RemoveHs): the same molecule
    drawn with and without spelled-out H's must canonicalize to the SAME
    string, because reader agreement/verification compares these strings —
    and the displayed SMILES shouldn't be cluttered with [H] atoms either.
    """
    if not raw:
        return None
    from rdkit import Chem
    mol = Chem.MolFromSmiles(raw)
    if mol is None:
        return None
    try:
        mol = Chem.RemoveHs(mol)
    except Exception:
        pass  # exotic H's (isotopes, bridging) can refuse removal — keep as-is
    return Chem.MolToSmiles(mol)


def _decimer_read(arr: np.ndarray) -> str | None:
    """Run DECIMER on an image array; return plausible canonical SMILES or None."""
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp_path = tmp.name
        cv2.imwrite(tmp_path, arr)
        return plausible_or_none(_canonical_smiles(_load_decimer()(tmp_path)), "DECIMER")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

def _molscribe_read(arr: np.ndarray) -> str | None:
    """Run MolScribe on a BGR image array; return plausible canonical SMILES or None."""
    try:
        model = _load_molscribe()
    except Exception as exc:
        logger.warning("MolScribe load failed (%s): %s", type(exc).__name__, exc)
        return None
    try:
        rgb = cv2.cvtColor(arr, cv2.COLOR_BGR2RGB)
        out = model.predict_image(rgb)
        return plausible_or_none(_canonical_smiles(out.get("smiles")), "MolScribe")
    except Exception as exc:
        logger.warning("MolScribe read failed (%s): %s", type(exc).__name__, exc)
        return None


def _process(raw_bytes: bytes, api_key: str | None = None) -> dict:
    try:
        pil = Image.open(io.BytesIO(raw_bytes))
        try:
            from PIL import ImageOps
            pil = ImageOps.exif_transpose(pil)
        except Exception:
            pass
        pil = pil.convert("RGB")
        img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
    except Exception as exc:
        raise ValueError(f"Could not decode image: {exc}") from exc

    img = _resize(img)
    stages: dict[str, str | None] = {"original": _stage_b64(img)}

    # Clean digital depictions (screenshots, PDF renders) skip the photo-repair
    # stages — they're slow and can only degrade an already-flat, noise-free
    # image. Photos get the full pipeline. Dark-mode renders are flipped to
    # dark-ink-on-white first: that's the polarity the OSR models and
    # binarization expect. (The vision model still sees the raw upload — VLMs
    # read dark mode natively.)
    polarity = _digital_polarity(img)
    if polarity == "dark":
        img = cv2.bitwise_not(img)
        stages["invert"] = _stage_b64(img)
    digital = polarity is not None

    # Kick off the slow independent readers FIRST, each on its own pool, so
    # they overlap the preprocessing stages and DECIMER reads below instead
    # of running after them:
    #   * vision (Claude or Ollama HTTP) — sees a downscaled copy of the upload
    #   * MolScribe (torch)    — reads the original now; the binarized
    #     rendition is submitted as soon as preprocessing produces it
    vision_future = _vision_pool.submit(_vision_smiles, _vision_png(img), api_key)
    ms_orig_future = _molscribe_pool.submit(_molscribe_read, img)

    current = img.copy()
    photo_stages = [] if digital else [
        ("perspective", perspective_correct), ("deskew", deskew), ("denoise", denoise),
    ]
    for name, fn in photo_stages + [("binarize", normalize_binarize)]:
        try:
            result = fn(current)
            if result is not None and isinstance(result, np.ndarray):
                current = result
        except Exception as exc:
            # A failed stage is non-fatal — keep the last good image and continue,
            # but surface the cause instead of hiding it.
            logger.warning("Preprocessing stage %r failed (%s): %s", name, type(exc).__name__, exc)
        stages[name] = _stage_b64(current)

    stages["final"] = _stage_b64(current)

    # ── Multi-candidate OSR ───────────────────────────────────────────────
    # Up to four local reads of the same image: DECIMER and MolScribe each
    # read the original AND the binarized rendition. Binarization rescues
    # badly-lit photos but can destroy thin bonds in clean depictions, so
    # neither rendition wins universally — and MolScribe, trained on clean
    # depictions, often only succeeds on the binarized one. The vision model
    # reads the original independently as tiebreaker + verifier. All
    # comparisons are on canonical SMILES. Small local VLMs proved unreliable
    # as *judges* ("do these two drawings match?") — they blessed wrong reads
    # and rejected correct ones — but exact canonical agreement between
    # independent readers almost never blesses a wrong structure.
    error: str | None = None
    bin_read: str | None = None
    orig_read: str | None = None

    # Photos get a MolScribe read of the binarized rendition too — it runs on
    # the MolScribe pool during DECIMER's reads below, so it costs ~no wall
    # time and doubles the chances of the instant cross-model-agreement path.
    # For clean digital images binarized ≈ original; skip the duplicate read.
    ms_bin_future = None if digital else _molscribe_pool.submit(_molscribe_read, current)

    try:
        # For clean digital images DECIMER reads the ORIGINAL first — that's
        # closest to its training distribution — and the binarized rendition
        # only as a fallback. Photos get both reads for the agreement signal.
        if digital:
            orig_read = _decimer_read(img)
            if not orig_read:
                bin_read = _decimer_read(current)
        else:
            bin_read = _decimer_read(current)
            orig_read = _decimer_read(img)
    except Exception as exc:
        error = str(exc)

    def _collect(future, label: str) -> str | None:
        """MolScribe runs concurrently on its own pool; by now it has usually
        finished. The timeout only guards against a wedged torch call — it
        must never hold the OSR worker hostage."""
        if future is None:
            return None
        try:
            return future.result(timeout=60.0)
        except Exception as exc:
            logger.warning("%s read not collected (%s): %s", label, type(exc).__name__, exc)
            return None

    ms_orig = _collect(ms_orig_future, "MolScribe/original")
    ms_bin = _collect(ms_bin_future, "MolScribe/binarized")

    # Settle the verdict from local reads when possible. Whenever the verdict
    # needs the VISION read, we do NOT wait for it here — _process runs on
    # the single OSR worker, and parking that worker on a minutes-long HTTP
    # call would freeze every other /analyze and /react-from-image request.
    # The async endpoint awaits the future and settles the verdict via
    # resolve_with_vision instead.
    smiles, verified, pending, defer = arbitrate_local(orig_read, bin_read, ms_orig, ms_bin)
    verify_token: str | None = None
    if verified:
        logger.info("Cross-model agreement: %r → verified (vision unused)", smiles)
    elif defer and smiles:
        # One unambiguous local candidate — return its structure immediately;
        # the in-flight vision read becomes a deferred verification the client
        # collects via GET /analyze/verify/{token}. It can only change the
        # badge, never the structure.
        verify_token = _store_pending_verify(vision_future, smiles)

    valid = smiles is not None
    if valid:
        error = None

    if pending:
        confidence = "unverified"   # placeholder; endpoint overwrites after vision
    elif verify_token:
        confidence = "verifying"
    elif verified is True:
        confidence = "high"
    elif verified is False:
        confidence = "low"
    else:
        confidence = "unverified"

    result = {
        "smiles": smiles,
        "valid": valid,
        "verified": verified,
        "confidence": confidence,
        "verify_token": verify_token,
        "error": error,
        "stages": stages,
        "reads": {
            "decimer_original": orig_read,
            "decimer_binarized": bin_read,
            "molscribe": ms_orig,
            "molscribe_binarized": ms_bin,
            "vision": None,
            "clean_digital": digital,
        },
    }
    if pending:
        result["_pending"] = {
            "future": vision_future, "orig": orig_read, "bin": bin_read,
            "ms_orig": ms_orig, "ms_bin": ms_bin, "digital": digital,
        }
    return result


def _run_all_pathways_for_reagent(substrate: str, reagent: dict) -> list[dict]:
    """
    Run all eligible templates for one reagent. Returns a list of branch dicts
    (one per unique product), each RDKit-validated. Returns [] on any failure.
    """
    from rdkit import Chem

    conditions = reagent.get("conditions", [])

    try:
        branches = _get_engine().run_for_reagent(substrate, reagent["smiles"], conditions)
    except Exception:
        logger.exception("Template engine error for reagent %s", reagent["name"])
        return []

    results = []
    environment = "Kinetic" if "kinetic_base" in conditions else "Thermodynamic"

    for b in branches:
        product_smiles = b["final_product"]
        prod_mol = Chem.MolFromSmiles(product_smiles)
        if prod_mol is None:
            continue

        # Build the step list the frontend expects
        steps = b["steps"]

        # Kept for the frontend's reaction_classification shape; the name comes
        # straight from the template that fired.
        classification = {
            "name": b["reaction_name"],
            "confidence": "template",
        }

        results.append({
            "reagent": {k: v for k, v in reagent.items() if k != "conditions"},
            "environment": environment,
            "steps_taken": b["steps_taken"],
            "execution_history": b["execution_history"],
            "product_smiles": product_smiles,
            "steps": steps,
            "reaction_classification": classification,
            "template_id": b["template_id"],
            "reaction_name": b["reaction_name"],
            "matches_target": False,  # filled in after
        })

    return results


# ── Routes ────────────────────────────────────────────────────────────────────

@app.post("/analyze", dependencies=[Depends(require_auth)])
async def analyze(file: UploadFile = File(...),
                  api_key: str | None = Form(default=None)):
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 8 MB).")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(_executor, _process, contents, api_key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        # Full detail goes to the log; the response stays generic so internal
        # paths/library errors don't leak to callers.
        logger.exception("Image analysis failed")
        raise HTTPException(status_code=500, detail="Image processing failed.") from exc

    pending = result.pop("_pending", None)
    if pending:
        # The verdict depends on the in-flight vision read. Await it here on
        # the event loop — the OSR worker was already released, so a slow
        # vision model delays only THIS request, not every other upload.
        try:
            vision_read = await asyncio.wait_for(
                asyncio.wrap_future(pending["future"]), timeout=VISION_TIMEOUT + 10.0)
        except asyncio.CancelledError:
            raise  # client disconnected — nothing to salvage
        except Exception as exc:
            logger.warning("Vision read failed (%s): %s", type(exc).__name__, exc)
            vision_read = None
        smiles, verified = resolve_with_vision(
            pending["orig"], pending["bin"], pending["ms_orig"], pending["ms_bin"],
            pending["digital"], vision_read)
        logger.info(
            "Vision-arbitrated read: decimer=(%r, %r) molscribe=(%r, %r) vision=%r → %r (verified=%s)",
            pending["orig"], pending["bin"], pending["ms_orig"], pending["ms_bin"],
            vision_read, smiles, verified)
        result["smiles"] = smiles
        result["valid"] = smiles is not None
        result["verified"] = verified
        if verified is True:
            result["confidence"] = "high"
        elif verified is False:
            result["confidence"] = "low"
        else:
            result["confidence"] = "unverified"
        if result["valid"]:
            result["error"] = None
        result["reads"]["vision"] = vision_read
    return result


@app.get("/analyze/verify/{token}", dependencies=[Depends(require_auth)])
async def analyze_verify(token: str):
    """
    Collect the deferred vision verification for a prior /analyze response.
    Blocks until the in-flight vision read completes (or fails). One-shot:
    the token is consumed on first retrieval.
    """
    entry = _PENDING_VERIFY.pop(token, None)
    if entry is None:
        raise HTTPException(status_code=404, detail="Unknown or expired verification token")
    try:
        vision_read = await asyncio.wait_for(
            asyncio.wrap_future(entry["future"]), timeout=VISION_TIMEOUT + 30.0
        )
    except asyncio.CancelledError:
        # Client disconnected mid-wait (tab closed, page refreshed). Put the
        # entry back — the token was consumed but the verdict never delivered,
        # and a retry after reload should still be able to collect it.
        _PENDING_VERIFY[token] = entry
        raise
    except Exception as exc:
        logger.warning("Deferred verification failed (%s): %s", type(exc).__name__, exc)
        vision_read = None

    smiles = entry["smiles"]
    verified: bool | None = (vision_read == smiles) if vision_read else None
    if verified is True:
        confidence = "high"
    elif verified is False:
        confidence = "low"
    else:
        confidence = "unverified"
    logger.info("Deferred verification: chosen=%r vision=%r → %s", smiles, vision_read, confidence)
    return {"smiles": smiles, "verified": verified, "confidence": confidence, "vision": vision_read}


MAX_SMILES_CHARS = 512  # generous for coursework molecules; blocks CPU-burn payloads


@app.get("/structure")
async def structure(
    smiles: str = Query(..., max_length=MAX_SMILES_CHARS),
    width: int = Query(200, ge=40, le=800),
    height: int = Query(150, ge=40, le=600),
):
    """Return an SVG rendering of a SMILES structure for display in the UI."""
    svg = await asyncio.get_event_loop().run_in_executor(
        _svg_pool, _mol_svg, smiles, width, height
    )
    if not svg:
        raise HTTPException(status_code=422, detail="Invalid SMILES")
    return Response(content=svg, media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/molfile")
async def molfile(
    smiles: str = Query(..., max_length=MAX_SMILES_CHARS),
    name: str = Query("molecule", max_length=128),
):
    """Return an MDL Molfile (.mol) for a SMILES, as a downloadable attachment."""
    from rdkit import Chem
    from rdkit.Chem import AllChem

    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise HTTPException(status_code=422, detail="Invalid SMILES")
    try:
        mol = Chem.AddHs(mol)
        AllChem.Compute2DCoords(mol)
    except Exception:
        pass
    block = Chem.MolToMolBlock(mol)
    safe = "".join(c for c in name if c.isalnum() or c in ("-", "_")) or "molecule"
    return Response(
        content=block,
        media_type="chemical/x-mdl-molfile",
        headers={"Content-Disposition": f'attachment; filename="{safe}.mol"'},
    )


MAX_SEARCH_DEPTH = 10   # hard cap enforced server-side
MAX_POOL_SIZE    = 600  # unique molecules in pool before aborting convergent search


class PathwaysRequest(BaseModel):
    # Accept either a single substrate (legacy) or a list of starting materials.
    # If start_smiles is provided it takes priority; substrate_smiles kept for
    # backward compatibility with the old frontend.
    start_smiles: list[str] = []
    substrate_smiles: str = ""
    target_smiles: Optional[str] = None
    desired_depth: int = 5   # user's requested depth; server always searches to MAX_SEARCH_DEPTH


# ── MoleculeInfo tracks every molecule in the synthesis pool ──────────────────

class _MolInfo:
    """Provenance record for one molecule in the BFS pool."""
    __slots__ = ("smiles", "depth", "prov_type", "parent_a", "parent_b",
                 "reaction_name", "template_id", "reagent_name", "reagent_smiles",
                 "environment", "source_index", "step_text")

    def __init__(
        self, smiles, depth, prov_type,
        parent_a=None, parent_b=None,
        reaction_name=None, template_id=None,
        reagent_name=None, reagent_smiles=None,
        environment=None, source_index=None,
        step_text=None,
    ):
        self.smiles        = smiles
        self.depth         = depth
        self.prov_type     = prov_type   # "start" | "reagent" | "coupling"
        self.parent_a      = parent_a    # canonical SMILES of first parent
        self.parent_b      = parent_b    # canonical SMILES of second parent (coupling only)
        self.reaction_name = reaction_name
        self.template_id   = template_id
        self.reagent_name  = reagent_name
        self.reagent_smiles = reagent_smiles
        self.environment   = environment
        self.source_index  = source_index   # only for "start" nodes
        self.step_text     = step_text


def _trace_dag(pool: dict, target_smiles: str) -> tuple[list[dict], list[dict]]:
    """
    Trace backwards from target through provenance to collect the minimal DAG.
    Returns (dag_nodes, dag_edges) in React Flow-friendly format.
    """
    # BFS backwards
    visited = set()
    queue = [target_smiles]
    node_order = []

    while queue:
        smi = queue.pop(0)
        if smi in visited:
            continue
        visited.add(smi)
        node_order.append(smi)
        info = pool.get(smi)
        if info is None:
            continue
        if info.parent_a and info.parent_a not in visited:
            queue.append(info.parent_a)
        if info.parent_b and info.parent_b not in visited:
            queue.append(info.parent_b)

    # Assign stable node IDs
    node_ids = {smi: f"n{i}" for i, smi in enumerate(node_order)}

    dag_nodes = []
    dag_edges = []
    edge_idx  = 0

    for smi in node_order:
        info = pool[smi]
        nid  = node_ids[smi]
        is_target = (smi == target_smiles)

        if info.prov_type == "start":
            label = f"Starting Material {info.source_index + 1}" if info.source_index is not None else "Starting Material"
            node_type = "start"
        elif is_target:
            label = "Target"
            node_type = "product"
        else:
            label = info.reaction_name or "Intermediate"
            node_type = "intermediate"

        dag_nodes.append({
            "id": nid,
            "smiles": smi,
            "type": node_type,
            "label": label,
            "is_coupling": info.prov_type == "coupling",
            "step_text": info.step_text or "",
            "reaction_name": info.reaction_name,
            "reagent_name": info.reagent_name,
            "reagent_smiles": info.reagent_smiles,
            "environment": info.environment,
            "source_index": info.source_index,
        })

        if info.parent_a:
            dag_edges.append({
                "id": f"e{edge_idx}",
                "source": node_ids[info.parent_a],
                "target": nid,
                "reaction_name": info.reaction_name or "",
                "reagent_name": info.reagent_name or "",
                "is_coupling": info.prov_type == "coupling",
            })
            edge_idx += 1

        if info.parent_b:
            dag_edges.append({
                "id": f"e{edge_idx}",
                "source": node_ids[info.parent_b],
                "target": nid,
                "reaction_name": info.reaction_name or "",
                "reagent_name": info.reagent_name or "",
                "is_coupling": info.prov_type == "coupling",
            })
            edge_idx += 1

    return dag_nodes, dag_edges


def _bfs_convergent(
    start_smiles_list: list[str],
    target_canon: str,
    desired_depth: int,
) -> dict:
    """
    Convergent BFS from one or more starting materials toward target_canon.

    Supports:
    - Unimolecular reagent-based templates (run_for_reagent)
    - Bimolecular coupling templates (run_coupling) between any two pool molecules

    Always searches to MAX_SEARCH_DEPTH regardless of desired_depth; routes are
    partitioned into within/beyond desired_depth so the caller can report correctly.

    Returns:
      routes          — list of route dicts (dag_nodes, dag_edges, depth, …)
      nodes_explored  — int
      terminated_early — bool (pool ceiling hit)
      result_status   — "found" | "found_beyond_depth" | "not_found" | "ceiling_hit"
    """
    from collections import deque
    from rdkit import Chem

    # Pool: canonical SMILES → _MolInfo
    pool: dict[str, _MolInfo] = {}
    for i, smi in enumerate(start_smiles_list):
        pool[smi] = _MolInfo(
            smiles=smi, depth=0, prov_type="start", source_index=i,
            step_text="Starting material",
        )

    # BFS queue: (smiles, depth)
    queue: deque = deque((smi, 0) for smi in start_smiles_list)

    found_routes: list[dict] = []
    terminated_early = False

    while queue and not terminated_early:
        current_smiles, depth = queue.popleft()

        if depth >= MAX_SEARCH_DEPTH:
            continue

        current_mol = Chem.MolFromSmiles(current_smiles)
        if current_mol is None:
            continue

        # ── 1. Unimolecular / reagent-based templates ─────────────────────────
        for reagent in REAGENT_LIST:
            if terminated_early:
                break
            conditions  = reagent.get("conditions", [])
            environment = "Kinetic" if "kinetic_base" in conditions else "Thermodynamic"

            try:
                branches = _get_engine().run_for_reagent(current_smiles, reagent["smiles"], conditions)
            except Exception:
                logger.exception("BFS: engine error for reagent %s on %s", reagent["name"], current_smiles)
                continue

            for branch in branches:
                product = branch["final_product"]
                new_depth = depth + branch["steps_taken"]

                step_text = (
                    branch["execution_history"][-1]
                    if branch["execution_history"]
                    else f"Reagent {reagent['name']} applied"
                )

                if product == target_canon:
                    # Build and record this route
                    if product not in pool:
                        pool[product] = _MolInfo(
                            smiles=product, depth=new_depth, prov_type="reagent",
                            parent_a=current_smiles,
                            reaction_name=branch["reaction_name"],
                            template_id=branch["template_id"],
                            reagent_name=reagent["name"],
                            reagent_smiles=reagent["smiles"],
                            environment=environment,
                            step_text=step_text,
                        )
                    dag_nodes, dag_edges = _trace_dag(pool, target_canon)
                    found_routes.append({
                        "depth": new_depth,
                        "dag_nodes": dag_nodes,
                        "dag_edges": dag_edges,
                    })
                    continue

                if product not in pool:
                    pool[product] = _MolInfo(
                        smiles=product, depth=new_depth, prov_type="reagent",
                        parent_a=current_smiles,
                        reaction_name=branch["reaction_name"],
                        template_id=branch["template_id"],
                        reagent_name=reagent["name"],
                        reagent_smiles=reagent["smiles"],
                        environment=environment,
                        step_text=step_text,
                    )
                    if len(pool) >= MAX_POOL_SIZE:
                        terminated_early = True
                        break
                    queue.append((product, new_depth))

        # ── 2. Coupling templates (both reactants from pool) ──────────────────
        if not terminated_early and _get_engine().coupling_templates:
            pool_snapshot = list(pool.keys())  # snapshot to avoid mutation during iteration
            for other_smiles in pool_snapshot:
                if other_smiles == current_smiles:
                    continue
                try:
                    coupling_results = _get_engine().run_coupling(current_smiles, other_smiles)
                except Exception:
                    logger.exception("BFS: coupling error %s + %s", current_smiles, other_smiles)
                    continue

                other_depth = pool[other_smiles].depth
                new_depth = max(depth, other_depth) + 1

                for cr in coupling_results:
                    product = cr["product_smiles"]

                    if product == target_canon:
                        if product not in pool:
                            pool[product] = _MolInfo(
                                smiles=product, depth=new_depth, prov_type="coupling",
                                parent_a=current_smiles, parent_b=other_smiles,
                                reaction_name=cr["reaction_name"],
                                template_id=cr["template_id"],
                                step_text=f"Coupling: {cr['reaction_name']}",
                            )
                        dag_nodes, dag_edges = _trace_dag(pool, target_canon)
                        found_routes.append({
                            "depth": new_depth,
                            "dag_nodes": dag_nodes,
                            "dag_edges": dag_edges,
                        })
                        continue

                    if product not in pool:
                        pool[product] = _MolInfo(
                            smiles=product, depth=new_depth, prov_type="coupling",
                            parent_a=current_smiles, parent_b=other_smiles,
                            reaction_name=cr["reaction_name"],
                            template_id=cr["template_id"],
                            step_text=f"Coupling: {cr['reaction_name']}",
                        )
                        if len(pool) >= MAX_POOL_SIZE:
                            terminated_early = True
                            break
                        queue.append((product, new_depth))

    # ── Classify result ───────────────────────────────────────────────────────
    if found_routes:
        # Sort by depth ascending (shortest first)
        found_routes.sort(key=lambda r: r["depth"])
        # De-duplicate routes by DAG node set
        seen_dag: set[frozenset] = set()
        unique_routes = []
        for r in found_routes:
            key = frozenset(n["smiles"] for n in r["dag_nodes"])
            if key not in seen_dag:
                seen_dag.add(key)
                unique_routes.append(r)
        found_routes = unique_routes

        within = [r for r in found_routes if r["depth"] <= desired_depth]
        beyond = [r for r in found_routes if r["depth"] >  desired_depth]

        if within:
            result_status = "found"
            best_routes = within
        else:
            result_status = "found_beyond_depth"
            best_routes = [beyond[0]]   # shortest route beyond desired depth
    else:
        best_routes = []
        result_status = "ceiling_hit" if terminated_early else "not_found"

    # Annotate routes with is_shortest flag
    for i, r in enumerate(best_routes):
        r["is_shortest"] = (i == 0)
        r["exceeds_desired_depth"] = r["depth"] > desired_depth

    return {
        "routes": best_routes,
        "nodes_explored": len(pool),
        "terminated_early": terminated_early,
        "result_status": result_status,
        "shortest_route_depth": best_routes[0]["depth"] if best_routes else None,
    }


@app.post("/pathways", dependencies=[Depends(require_auth)])
async def pathways(req: PathwaysRequest):
    from rdkit import Chem

    # ── Resolve starting materials (support legacy single-substrate field) ─────
    raw_starts = req.start_smiles if req.start_smiles else (
        [req.substrate_smiles] if req.substrate_smiles.strip() else []
    )
    if not raw_starts:
        raise HTTPException(status_code=422, detail="At least one starting material is required")

    canon_starts: list[str] = []
    for smi in raw_starts:
        mol = Chem.MolFromSmiles(smi.strip())
        if mol is None:
            raise HTTPException(status_code=422, detail=f"Invalid starting material SMILES: {smi!r}")
        canon_starts.append(Chem.MolToSmiles(mol))

    # Remove duplicates, preserve order
    seen_starts: set[str] = set()
    unique_starts: list[str] = []
    for s in canon_starts:
        if s not in seen_starts:
            seen_starts.add(s)
            unique_starts.append(s)
    canon_starts = unique_starts

    # Server-side clamp on desired_depth
    desired_depth = max(1, min(MAX_SEARCH_DEPTH, req.desired_depth))

    # Canonicalize optional target
    target_canon: str | None = None
    if req.target_smiles and req.target_smiles.strip():
        t_mol = Chem.MolFromSmiles(req.target_smiles.strip())
        if t_mol:
            target_canon = Chem.MolToSmiles(t_mol)

    loop = asyncio.get_event_loop()

    # ── Target given: convergent BFS ──────────────────────────────────────────
    if target_canon:
        search_result = await loop.run_in_executor(
            _chem_pool, _bfs_convergent, canon_starts, target_canon, desired_depth
        )

        status = search_result["result_status"]
        routes = search_result["routes"]

        # Build the human-readable no-match message
        if status in ("not_found", "ceiling_hit"):
            if status == "ceiling_hit":
                no_match_message = (
                    f"The search space exceeded {MAX_POOL_SIZE} unique molecules before completing. "
                    f"No route to the target was found within those bounds. "
                    "Try reducing the number of starting materials or lowering the depth."
                )
            else:
                no_match_message = (
                    f"Searched all reaction pathways up to {MAX_SEARCH_DEPTH} steps "
                    f"({search_result['nodes_explored']} unique molecules explored); "
                    "no combination of the available templates converts the starting material(s) into the target. "
                    "The required reaction may not be in the current template library, "
                    "or the transformation may not be achievable under the available conditions."
                )
        elif status == "found_beyond_depth":
            d = search_result["shortest_route_depth"]
            no_match_message = (
                f"No route within your requested depth of {desired_depth}. "
                f"Shortest route found needs {d} step{'s' if d != 1 else ''} (shown below)."
            )
        else:
            no_match_message = None

        # Tag routes with id for frontend selection
        for i, route in enumerate(routes):
            route["id"] = f"route_{i}"
            route["matches_target"] = True

        return {
            "start_smiles": canon_starts,
            "target_smiles": target_canon,
            "search_mode": "target_search",
            "result_status": status,
            "desired_depth": desired_depth,
            "shortest_route_depth": search_result["shortest_route_depth"],
            "search_info": {
                "nodes_explored": search_result["nodes_explored"],
                "terminated_early": search_result["terminated_early"],
                "max_depth_searched": MAX_SEARCH_DEPTH,
            },
            "no_match_message": no_match_message,
            "routes": routes,
            "branches": [],   # empty in target-search mode
        }

    # ── No target: fan-out from ALL starting materials ────────────────────────
    branches: list[dict] = []
    branch_idx = 0
    for substrate in canon_starts:
        for reagent in REAGENT_LIST:
            reagent_branches = await loop.run_in_executor(
                _chem_pool, _run_all_pathways_for_reagent, substrate, reagent
            )
            for branch in reagent_branches:
                branch["id"] = f"branch_{branch_idx}_{branch['template_id']}"
                branch["start_smiles_used"] = substrate
                branch_idx += 1
                branches.append(branch)

    return {
        "start_smiles": canon_starts,
        "target_smiles": None,
        "search_mode": "fanout",
        "result_status": None,
        "desired_depth": desired_depth,
        "shortest_route_depth": None,
        "search_info": None,
        "no_match_message": None,
        "routes": [],
        "branches": branches,
    }


class ExplainRequest(BaseModel):
    substrate_smiles: str
    product_smiles: str
    reagent_name: str
    reagent_smiles: str
    reaction_name: str
    execution_history: list[str]
    environment_used: str
    # Optional per-node fields — when provided, explanation is scoped to a single step
    node_smiles: Optional[str] = None
    node_role: Optional[str] = None       # 'start' | 'intermediate' | 'product'
    node_step_text: Optional[str] = None  # raw execution_history entry for this step
    engine: Optional[EngineConfig] = None  # generative engine selection (Choose Your Engine)


@app.post("/explain")
async def explain(req: ExplainRequest, user_id: str | None = Depends(require_auth)):
    _enforce_hosted_quota(req.engine, user_id)
    if len(req.execution_history) > MAX_HISTORY_LINES:
        raise HTTPException(status_code=413, detail="Execution history too large.")
    system_prompt = (
        "You are an organic chemistry teaching assistant for Orgo AI. "
        "You will be given exact chemical data computed by a verified deterministic engine. "
        "Your sole job is to explain this data clearly to a student.\n\n"
        "HARD RULES:\n"
        "- The provided SMILES, reaction name, execution history, and environment are ground truth. "
        "Never contradict or independently re-derive them.\n"
        "- Explain ONLY what the engine computed. Do not invent steps not in the history.\n"
        "- If a student asks you to go beyond the provided data, say so explicitly.\n"
        "- Flag uncertainty rather than fabricating mechanism details."
    )

    history_text = "\n".join(req.execution_history) if req.execution_history else "No history available"

    if req.node_smiles and req.node_role and req.node_role != "start":
        # Per-node explanation scoped to one step
        user_prompt = (
            f"Explain what is happening at this specific step in the reaction pathway:\n\n"
            f"**Step role:** {req.node_role}\n"
            f"**This step's molecular state (SMILES):** {req.node_smiles}\n"
            f"**Engine description of this step:** {req.node_step_text or 'N/A'}\n\n"
            f"**Full reaction context:**\n"
            f"  Starting material: {req.substrate_smiles}\n"
            f"  Reagent: {req.reagent_name} ({req.reagent_smiles})\n"
            f"  Reaction type (engine-classified): {req.reaction_name}\n"
            f"  Control environment: {req.environment_used}\n"
            f"  Final product: {req.product_smiles}\n\n"
            f"**Complete engine execution history:**\n{history_text}\n\n"
            "Explain: what chemical transformation reached this state, what bonds formed or broke, "
            "and why this intermediate/product is expected given the reagent. "
            "Be concise and accessible to an undergraduate student."
        )
    else:
        user_prompt = (
            f"Please explain this reaction pathway to a student:\n\n"
            f"**Starting material:** {req.substrate_smiles}\n"
            f"**Reagent:** {req.reagent_name} ({req.reagent_smiles})\n"
            f"**Reaction type (engine-classified):** {req.reaction_name}\n"
            f"**Control environment:** {req.environment_used}\n\n"
            f"**Engine execution history:**\n{history_text}\n\n"
            f"**Final product:** {req.product_smiles}\n\n"
            "Explain: (1) what happened chemically, (2) why this mechanism applies given the reagent, "
            "(3) which bonds formed and broke, and (4) the significance of kinetic vs thermodynamic control "
            "if relevant. Keep it accessible to an undergraduate student."
        )

    return StreamingResponse(
        _sse_stream(system_prompt, [{"role": "user", "content": user_prompt}], 350, req.engine),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class StereoRequest(BaseModel):
    substrate_smiles: str
    product_smiles: str
    reagent_name: str
    reagent_smiles: str
    reaction_name: str
    execution_history: list[str] = []
    environment_used: str = ""
    engine: Optional[EngineConfig] = None


@app.post("/stereo")
async def stereo(req: StereoRequest, user_id: str | None = Depends(require_auth)):
    """Opt-in stereo/regiochemistry annotation pass.

    The deterministic SMARTS engine owns connectivity but cannot express
    stereochemistry or regiochemistry. This asks the LLM to ANNOTATE the
    stereo/regio outcome of the engine's product — it must not propose a
    different product structure.
    """
    _enforce_hosted_quota(req.engine, user_id)
    system_prompt = (
        "You are an organic chemistry stereochemistry specialist for Orgo AI.\n"
        "You are given a reaction whose CONNECTIVITY was computed by a verified "
        "deterministic engine. The product SMILES is ground truth for atom "
        "connectivity.\n\n"
        "HARD RULES:\n"
        "- Do NOT propose a different product or change the connectivity.\n"
        "- Annotate ONLY stereochemistry and regiochemistry: E/Z, cis/trans, "
        "R/S, syn/anti addition, Markovnikov vs anti-Markovnikov, and whether the "
        "product is racemic or a single stereoisomer.\n"
        "- If the reaction creates no new stereocenter or the outcome is not "
        "stereospecific, say so plainly.\n"
        "- Be concise: 2-4 sentences. Flag uncertainty rather than inventing detail."
    )
    history_text = "\n".join(req.execution_history) if req.execution_history else "N/A"
    user_prompt = (
        "Annotate the stereochemistry and regiochemistry of this reaction:\n\n"
        f"Starting material: {req.substrate_smiles}\n"
        f"Reagent: {req.reagent_name} ({req.reagent_smiles})\n"
        f"Reaction type: {req.reaction_name}\n"
        f"Control environment: {req.environment_used}\n"
        f"Engine product (connectivity is ground truth): {req.product_smiles}\n"
        f"Engine steps:\n{history_text}\n\n"
        "State the expected stereochemical/regiochemical outcome for THIS product."
    )
    return StreamingResponse(
        _sse_stream(system_prompt, [{"role": "user", "content": user_prompt}], 300, req.engine),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class ChatAttachment(BaseModel):
    kind: str = "image"          # only images reach the backend; text files are
                                 # inlined into message content client-side
    media_type: str = "image/png"
    data: str = ""               # raw base64, no data: URI prefix
    name: str = ""


class ChatMessage(BaseModel):
    role: str
    content: str
    attachments: list[ChatAttachment] = []


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    context: Optional[dict] = None
    engine: Optional[EngineConfig] = None  # generative engine selection (Choose Your Engine)
    surface: Optional[str] = None          # "synthesis" | "reaction" | "chat" — enables app tools
    # False = answer straight from the model: no app tools, and no OSR/template
    # run on an attached image. The escape hatch for when OSR misreads the
    # picture and the deterministic path is getting in the way of the question.
    use_engine: bool = True
    # False = the client wants only the engine result this turn; the model's
    # prose is deferred until the user asks for it. The Reaction tab's
    # Explanation button re-sends the same turn with explain=True.
    explain: bool = True


def _reaction_ground_text(result: dict) -> str:
    """Grounding block appended to the chat system prompt when the engine ran on
    an attached reaction image — the LLM must explain this verified result, not
    re-derive it."""
    products = result.get("products") or []
    lines = [
        "\n--- ENGINE-VERIFIED REACTION (read from the attached image; never contradict) ---",
        f"Substrate: {result.get('substrate_smiles', '')}",
        f"Reagent: {result.get('reagent_smiles', '')}",
    ]
    if products:
        lines.append("Verified products:")
        for p in products[:4]:
            lines.append(f"  - {p.get('reaction_name', '')}: {p.get('smiles', '')}")
    else:
        lines.append(
            "The verified engine found no matching template for this pair. Say so "
            "plainly; any product you propose is an unverified general-chemistry guess."
        )
    return "\n".join(lines)


async def _image_reaction_then_explain(system: str, messages: list[dict],
                                       engine: Optional[EngineConfig],
                                       explain: bool = True):
    """Image-bearing chats can't use the native tool path (the gateway drops
    image blocks on the tools endpoint). So run OSR + the deterministic engine
    on the newest attached image ourselves, emit a `reaction_result` frame — the
    same one the run_reaction tool emits, so the UI renders its banner/card —
    then stream a grounded explanation that still carries the image."""
    vision_key = engine.api_key if engine else None
    newest_image: str | None = None
    for message in reversed(messages):
        images = message.get("images") or []
        if images:
            newest_image = images[-1].get("data")
            break

    ground = ""
    if newest_image:
        result = None
        try:
            raw = base64.b64decode(newest_image)
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(_executor, _react_from_image, raw, vision_key)
        except Exception as exc:
            logger.warning("chat image-reaction OSR failed (%s): %s",
                           type(exc).__name__, exc)
        if (result and not result.get("error")
                and result.get("substrate_smiles") and result.get("reagent_smiles")):
            if not result.get("products"):
                _record_template_gap("chat_image", result["substrate_smiles"],
                                     result["reagent_smiles"], [])
            yield f"data: {json.dumps({'tool_event': {'type': 'reaction_result', 'data': result}})}\n\n"
            if not explain:
                # Card only. The Explanation button re-runs this turn.
                yield "data: [DONE]\n\n"
                return
            ground = _reaction_ground_text(result)

    async for frame in _sse_stream(system + ground, messages, 800, engine):
        yield frame


@app.post("/chat")
async def chat(req: ChatRequest, user_id: str | None = Depends(require_auth)):
    _enforce_hosted_quota(req.engine, user_id)
    _guard_messages(req.messages)
    context_block = ""
    if req.context:
        lines = ["\n--- Currently displayed reaction ---"]
        if req.context.get("substrate_smiles"):
            lines.append(f"Starting material: {req.context['substrate_smiles']}")
        if req.context.get("reagent_name"):
            lines.append(f"Reagent: {req.context['reagent_name']} ({req.context.get('reagent_smiles','')})")
        if req.context.get("reaction_name"):
            lines.append(f"Reaction: {req.context['reaction_name']}")
        if req.context.get("product_smiles"):
            lines.append(f"Product: {req.context['product_smiles']}")
        if req.context.get("execution_history"):
            lines.append("History: " + " | ".join(req.context["execution_history"]))
        context_block = "\n".join(lines)

    system_prompt = (
        "You are an organic chemistry tutor for Orgo AI. "
        "Help students understand organic chemistry concepts and reactions.\n\n"
        f"{context_block}\n\n"
        "RULES:\n"
        "- When a reaction is shown above, ground every answer in that engine-computed data. "
        "Do NOT override or re-derive the engine's product, mechanism, or reaction type.\n"
        "- Distinguish clearly between 'the engine computed X' and 'in general chemistry, Y is also possible'.\n"
        "- For questions outside the displayed reaction, draw on chemistry knowledge but flag uncertainty.\n"
        "- Keep responses concise and student-friendly."
    )

    messages = []
    for m in req.messages:
        entry: dict = {"role": m.role, "content": m.content}
        images = [{"media_type": a.media_type, "data": a.data}
                  for a in m.attachments if a.kind == "image" and a.data]
        if images:
            entry["images"] = images
        messages.append(entry)

    # App tools (run_reaction / set_stockroom / run_pathways) run on the
    # native Anthropic tool-use path. Image-bearing chats stay on the
    # chat-completions route (Parley drops image blocks on /v1/messages),
    # which doesn't carry our tools — so a chat turn gets tools OR images,
    # never both.
    has_images = any(m.get("images") for m in messages)
    mode = (req.engine.mode if req.engine else "hosted") or "hosted"
    # use_engine=False drops both engine paths below (tools and image-OSR) to the
    # plain streaming branch — a direct model answer with no deterministic run.
    surface_runs_reactions = (
        req.use_engine
        and bool(req.surface)
        and "run_reaction" in (_SURFACE_TOOLS.get(req.surface) or [])
    )

    byok_key = req.engine.api_key if req.engine else None
    if (surface_runs_reactions and not has_images
            and ((mode == "hosted" and os.environ.get("ANTHROPIC_API_KEY"))
                 or (mode == "byok" and byok_key))):
        _record_usage(mode, "anthropic")
        stream = _with_error_frames(_stream_anthropic_tools(
            system_prompt + _CHAT_TOOLS_SYSTEM, messages, 800,
            req.surface, model=req.engine.model if req.engine else None,
            explain=req.explain, api_key=byok_key,
        ))
    elif surface_runs_reactions and has_images:
        # Image chats bypass the native tool path — run the engine on the image
        # ourselves so the reaction still surfaces (banner/card + grounding).
        stream = _with_error_frames(
            _image_reaction_then_explain(system_prompt, messages, req.engine,
                                         explain=req.explain))
    else:
        stream = _sse_stream(system_prompt, messages, 800, req.engine)

    return StreamingResponse(
        stream,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── /assist — grounded LLM help for the non-pathway file types ───────────────

class AssistRequest(BaseModel):
    file_type: str                         # mechanism | retrosynthesis | molecule_note | chat
    content: dict = {}
    engine: Optional[EngineConfig] = None


def _engine_ground_from_text(text: str) -> str:
    """If `text` parses into 2+ components (substrate + reagent), run the
    deterministic engine and return a ground-truth summary the LLM must not
    contradict. Returns '' when no grounding is possible."""
    try:
        from rdkit import Chem
        from rdkit import RDLogger
        RDLogger.DisableLog("rdApp.*")
        # Parse as-is first: blindly replacing '+' corrupts charged SMILES
        # like [NH3+] or [Li+]. Only fall back to treating '+' as a fragment
        # separator when the literal text doesn't parse.
        mol = Chem.MolFromSmiles(text)
        if mol is None:
            mol = Chem.MolFromSmiles(text.replace("+", "."))
        if mol is None:
            return ""
        frags = Chem.GetMolFrags(mol, asMols=True)
        if len(frags) < 2:
            return ""
        # First fragment AS WRITTEN is the substrate. Don't pick by size:
        # reagent counterions/salt partners (e.g. LDA's diisopropylamide) can
        # out-weigh a small substrate, and typed input follows the
        # "substrate + reagent" convention anyway.
        comps = [Chem.MolToSmiles(f) for f in frags]
        substrate, reagent = comps[0], ".".join(comps[1:])
        conditions = TemplateEngine._infer_conditions(reagent)
        branches = _get_engine().run_for_reagent(substrate, reagent, conditions)
        if not branches:
            return ""
        lines = [
            "ENGINE GROUND TRUTH (deterministic — never contradict):",
            f"  Substrate: {substrate}   Reagent: {reagent}",
        ]
        for b in branches[:4]:
            lines.append(
                f"  - {b['reaction_name']}: product {b['final_product']}; "
                f"steps: {' | '.join(b['execution_history'])}"
            )
        return "\n".join(lines)
    except Exception as exc:
        logger.warning("assist grounding failed (%s): %s", type(exc).__name__, exc)
        return ""


def _assist_prompts(file_type: str, content: dict, ground: str = "") -> tuple[str, str]:
    """Build (system, user) prompts per file type. The LLM explains/proposes;
    it must not override deterministic engine facts when ground truth is given."""
    base_rules = (
        "You are an organic chemistry teaching assistant for Orgo AI.\n"
        "HARD RULES:\n"
        "- When ENGINE GROUND TRUTH is provided below, treat it as verified fact. "
        "Never contradict the engine's products, connectivity, or reaction names.\n"
        "- Distinguish clearly between engine-computed facts and general chemistry reasoning.\n"
        "- Flag uncertainty rather than fabricating mechanism or stereochemical detail.\n"
        "- Be concise and accessible to an undergraduate student."
    )
    g = f"\n\n{ground}" if ground else ""

    def field(key, default="(none provided)"):
        v = content.get(key)
        if isinstance(v, list):
            return ", ".join(str(x) for x in v) or default
        return str(v) if v not in (None, "") else default

    if file_type == "mechanism":
        system = base_rules + g
        user = (
            "Explain the step-by-step mechanism for this reaction.\n\n"
            f"Reaction input: {field('reactionInput')}\n"
            f"Student's mechanism notes: {field('mechanismStepsText', '')}\n"
            f"Electron-pushing notes: {field('electronPushingNotes', '')}\n"
            f"Other notes: {field('notes', '')}\n\n"
            "Describe each elementary step: which bonds break/form, the nucleophile/"
            "electrophile roles, and the electron-pushing (curved-arrow) logic."
        )
    elif file_type == "retrosynthesis":
        system = base_rules + g
        user = (
            "Propose a retrosynthetic analysis for the target below.\n\n"
            f"Target molecule: {field('targetMolecule')}\n"
            f"Known/attempted disconnections: {field('disconnectionsText', '')}\n"
            f"Proposed precursors: {field('proposedPrecursorsText', '')}\n"
            f"Notes/constraints: {field('notes', '')}\n\n"
            "Suggest key disconnections with rationale and plausible precursors "
            "and forward reactions. Flag where multiple routes are possible."
        )
    elif file_type == "molecule_note":
        system = base_rules + g
        user = (
            "Give a concise chemical profile of this molecule.\n\n"
            f"Name: {field('moleculeName')}\n"
            f"SMILES: {field('smiles')}\n"
            f"Functional groups (student): {field('functionalGroupsText', '')}\n"
            f"Notes: {field('notes', '')}\n\n"
            "Identify the functional groups, typical reactivity, and any hazards or "
            "synthesis context worth noting."
        )
    else:  # chat / general
        system = base_rules + g
        user = (
            "Respond to the student's project note or question.\n\n"
            f"{field('notes', '')}"
        )
    return system, user


@app.post("/assist")
async def assist(req: AssistRequest, user_id: str | None = Depends(require_auth)):
    _enforce_hosted_quota(req.engine, user_id)
    content = req.content or {}
    ground = ""
    if req.file_type == "mechanism":
        text = str(content.get("reactionInput", "")).strip()
        if text:
            loop = asyncio.get_event_loop()
            ground = await loop.run_in_executor(_chem_pool, _engine_ground_from_text, text)

    system, user = _assist_prompts(req.file_type, content, ground)
    return StreamingResponse(
        _sse_stream(system, [{"role": "user", "content": user}], 500, req.engine),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── /react-from-image ─────────────────────────────────────────────────────────

def _pick_substrate_and_react(components: list[str]) -> tuple[str, str, list[str], list[dict]]:
    """Try each recognized fragment as the substrate (largest first), with the
    remaining fragments as the reagent; the first assignment that fires any
    template wins.

    Image-recognized fragments carry no positional convention (unlike typed
    input, where "substrate + reagent" order is assumed), so "largest fragment
    = substrate" is only a starting guess — a bulky reagent like LDA out-weighs
    a small substrate, and the correct assignment is the one the template
    library actually recognizes.

    Returns (substrate, reagent, conditions, branches); when no assignment
    matches, branches is [] and substrate/reagent fall back to largest-first
    so the caller can still display the split it tried.
    """
    engine = _get_engine()
    fallback: tuple[str, str, list[str]] | None = None
    for i, candidate in enumerate(components):
        reagent = ".".join(components[:i] + components[i + 1:])
        conditions = TemplateEngine._infer_conditions(reagent)
        if fallback is None:
            fallback = (candidate, reagent, conditions)
        branches = engine.run_for_reagent(candidate, reagent, conditions)
        if branches:
            return candidate, reagent, conditions, branches
    substrate, reagent, conditions = fallback
    return substrate, reagent, conditions, []


# ── Product prediction: ASKCOS predicts, templates name and overrule ─────────
# The decision logic lives in prediction.py so it can be tested without
# importing this module (and with it TensorFlow/DECIMER/MolScribe). What
# remains here is only the I/O around it.


def _askcos_outcomes_sync(substrate: str, reagent: str) -> tuple[list | None, str | None]:
    """Blocking ASKCOS call → (outcomes, failure). Never raises."""
    if ASKCOS is None:
        return None, None
    try:
        return ASKCOS.predict([substrate], reagents=reagent), None
    except AskcosUnavailable as exc:
        return None, str(exc)


async def _askcos_outcomes(substrate: str, reagent: str) -> tuple[list | None, str | None]:
    """Async ASKCOS call → (outcomes, failure). Never raises."""
    if ASKCOS is None:
        return None, None
    try:
        return await ASKCOS.apredict([substrate], reagents=reagent), None
    except AskcosUnavailable as exc:
        return None, str(exc)


async def _predict_products(substrate: str, reagent: str,
                            conditions: list[str]) -> Prediction:
    """Predicted products for a substrate/reagent pair.

    Runs the template engine and ASKCOS concurrently — the templates are needed
    either way (to name ASKCOS products, to overrule them, or to stand in for
    them), so there is no reason to pay for them serially.
    """
    def _run_templates():
        return _get_engine().run_for_reagent(substrate, reagent, conditions)

    loop = asyncio.get_event_loop()
    branches, (outcomes, failure) = await asyncio.gather(
        loop.run_in_executor(_chem_pool, _run_templates),
        _askcos_outcomes(substrate, reagent),
    )
    return resolve_products(branches, outcomes, failure)


def _react_from_image(raw_bytes: bytes, api_key: str | None = None) -> dict:
    """
    Full pipeline: raw image bytes → preprocessing → DECIMER → substrate +
    reagent split → ASKCOS forward prediction (named by the template engine,
    which also stands in when ASKCOS is unreachable) → product SMILES.

    Returns a dict with keys:
        recognized_smiles   — raw DECIMER output
        components          — list of canonical component SMILES strings
        substrate_smiles    — first component (canonical)
        reagent_smiles      — remaining components joined with '.'
        products            — list of {smiles, reaction_name, template_id,
                               steps_taken, execution_history, probability}
        source              — "askcos" | "templates", which engine produced them
        error               — str | None
    """
    from rdkit import Chem

    # 1. Preprocess image
    try:
        pil = Image.open(io.BytesIO(raw_bytes))
        try:
            from PIL import ImageOps
            pil = ImageOps.exif_transpose(pil)
        except Exception:
            pass
        pil = pil.convert("RGB")
        img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
    except Exception as exc:
        return {"error": f"Could not decode image: {exc}", "products": []}

    img = _resize(img)
    # Same gating as /analyze: clean digital depictions skip the photo-repair
    # stages (slow, and binarization can destroy thin bonds in crisp renders);
    # dark-mode renders are flipped to the polarity OSR expects.
    polarity = _digital_polarity(img)
    if polarity == "dark":
        img = cv2.bitwise_not(img)
    digital = polarity is not None
    current = img.copy()
    photo_stages = [] if digital else [
        ("perspective", perspective_correct), ("deskew", deskew), ("denoise", denoise),
    ]
    for _, fn in photo_stages + [("binarize", normalize_binarize)]:
        try:
            result = fn(current)
            if result is not None and isinstance(result, np.ndarray):
                current = result
        except Exception:
            pass

    # 2. OSR via DECIMER — digital images read the original first (closest to
    # DECIMER's training distribution), binarized only as fallback; photos the
    # reverse, matching the /analyze pipeline.
    recognized_smiles: str | None = None
    try:
        first, second = (img, current) if digital else (current, img)
        recognized_smiles = _decimer_read(first) or _decimer_read(second)
        logger.info("DECIMER output: %r", recognized_smiles)
    except Exception as exc:
        # DECIMER missing/broken is recoverable — the vision fallback
        # below gets a chance, same as the /analyze pipeline.
        logger.warning("DECIMER failed (%s): %s — trying vision fallback", type(exc).__name__, exc)
        recognized_smiles = None

    # Encode the preprocessed image once (downscaled for VLM prefill speed);
    # reused by all vision fallback calls below
    _img_bytes = _vision_png(current)

    if not recognized_smiles:
        logger.info("DECIMER returned nothing — calling vision reaction parse")
        recognized_smiles = _vision_reaction_smiles(_img_bytes, api_key)
        logger.info("Vision (empty DECIMER fallback) returned: %r", recognized_smiles)
    if not recognized_smiles:
        return {"error": "No structure recognized in the image.", "products": []}

    # 3. Parse all components — split on '.' but re-validate each fragment
    raw_mol = Chem.MolFromSmiles(recognized_smiles)
    if raw_mol is None:
        # Try replacing '+' notation (some DECIMER outputs use '+' for fragment sep)
        alt = recognized_smiles.replace("+", ".")
        raw_mol = Chem.MolFromSmiles(alt)
        if raw_mol is None:
            logger.info("DECIMER SMILES invalid — calling vision reaction parse")
            fallback = _vision_reaction_smiles(_img_bytes, api_key)
            logger.info("Vision (invalid SMILES fallback) returned: %r", fallback)
            if fallback:
                recognized_smiles = fallback
                raw_mol = Chem.MolFromSmiles(recognized_smiles)
        if raw_mol is None:
            return {
                "recognized_smiles": recognized_smiles,
                "error": "Recognized SMILES is invalid; try a clearer image.",
                "products": [],
            }

    frags = Chem.GetMolFrags(raw_mol, asMols=True)

    # Detect suspicious DECIMER output: implausible elements or excessive fragment
    # count. This is an allowlist rather than a denylist of exotic elements: DECIMER
    # invents whatever two-letter symbol fits the pixels, and the failure that
    # motivated this — "SOCl2" written over the arrow read back as [CH3][Sb](Cl)Cl,
    # antimony — is exactly the case a hand-written denylist keeps missing. Anything
    # outside the set an undergraduate depiction can actually contain is treated as a
    # misread. Reagents that only ever appear as text over the arrow (OsO4, Pd/C,
    # KMnO4, PCC) are deliberately absent: seeing them as *drawn atoms* means the
    # label was misparsed. A false positive here costs one extra vision call and
    # nothing else — the re-read only replaces the SMILES if it yields >= 2 fragments.
    _PLAUSIBLE_ATOMS = {
        "C", "H", "N", "O", "S", "P", "F", "Cl", "Br", "I",   # organic core
        "B", "Si",                                            # boranes, silyl groups
        "Li", "Na", "K", "Mg", "Ca", "Al", "Zn", "Cu", "Fe",  # counterions / Grignards
    }
    _atom_syms = {a.GetSymbol() for a in raw_mol.GetAtoms()}
    _bad_atoms = _atom_syms - _PLAUSIBLE_ATOMS
    if len(frags) > 5 or _bad_atoms:
        logger.info(
            "Suspicious DECIMER output (%d frags, implausible atoms=%s, smiles=%r) — calling vision",
            len(frags), _bad_atoms or "none", recognized_smiles,
        )
        fix = _vision_reaction_smiles(_img_bytes, api_key)
        logger.info("Vision (suspicious DECIMER) returned: %r", fix)
        if fix:
            fix_mol = Chem.MolFromSmiles(fix)
            if fix_mol is not None:
                fix_frags = Chem.GetMolFrags(fix_mol, asMols=True)
                if len(fix_frags) >= 2:
                    recognized_smiles = fix
                    raw_mol = fix_mol
                    frags = fix_frags

    # Sort by heavy-atom count descending so the substrate (largest) comes first
    frags_sorted = sorted(frags, key=lambda m: m.GetNumHeavyAtoms(), reverse=True)
    components = [Chem.MolToSmiles(f) for f in frags_sorted]

    if len(components) < 2:
        return {
            "recognized_smiles": recognized_smiles,
            "components": components,
            "substrate_smiles": components[0] if components else "",
            "reagent_smiles": "",
            "error": "Only one molecule was recognized. Upload an image containing both substrate and reagent.",
            "products": [],
            "source": "templates",
        }

    # 4. Assign substrate/reagent and run the engine — every fragment gets a
    # turn as the substrate; the first assignment that matches a template wins.
    substrate_smiles, reagent_smiles, conditions, branches = _pick_substrate_and_react(components)
    logger.info(
        "Template engine: substrate=%r  reagent=%r  conditions=%s → %d branch(es)",
        substrate_smiles, reagent_smiles, conditions, len(branches),
    )

    # 5. Last-resort: if engine matched nothing, ask vision for a cleaner re-read and retry
    if not branches:
        logger.info("No templates matched — calling vision for last-resort re-identification")
        retry_smiles = _vision_reaction_smiles(_img_bytes, api_key)
        logger.info("Vision (no-match retry) returned: %r", retry_smiles)
        if retry_smiles and retry_smiles != recognized_smiles:
            retry_mol = Chem.MolFromSmiles(retry_smiles)
            if retry_mol is not None:
                retry_frags = Chem.GetMolFrags(retry_mol, asMols=True)
                retry_sorted = sorted(retry_frags, key=lambda m: m.GetNumHeavyAtoms(), reverse=True)
                retry_components = [Chem.MolToSmiles(f) for f in retry_sorted]
                if len(retry_components) >= 2:
                    recognized_smiles = retry_smiles
                    components        = retry_components
                    substrate_smiles, reagent_smiles, conditions, branches = (
                        _pick_substrate_and_react(retry_components)
                    )
                    logger.info(
                        "Retry with vision SMILES: substrate=%r  reagent=%r  conditions=%s → %d branch(es)",
                        substrate_smiles, reagent_smiles, conditions, len(branches),
                    )

    # 6. Predict. The template run above already happened (and drove both the
    # substrate/reagent assignment and the vision retries), so ASKCOS only has
    # to answer for the assignment that survived all of that.
    outcomes, failure = _askcos_outcomes_sync(substrate_smiles, reagent_smiles)
    prediction = resolve_products(branches, outcomes, failure)
    logger.info("Prediction source=%s low_confidence=%s → %d product(s)",
                prediction.source, prediction.low_confidence, len(prediction.products))

    return {
        "recognized_smiles": recognized_smiles,
        "components":        components,
        "substrate_smiles":  substrate_smiles,
        "reagent_smiles":    reagent_smiles,
        "products":          prediction.products,
        "source":            prediction.source,
        "low_confidence":    prediction.low_confidence,
        # Empty products is NOT an error here: the endpoint layers an AI-guess
        # fallback on that case, and an error string would make the frontend
        # bail before rendering it. Genuine OSR failures return earlier with
        # their own error strings.
        "error":             None,
    }


class ReactRequest(BaseModel):
    substrate_smiles: str
    reagent_smiles: str
    engine: Optional[EngineConfig] = None   # BYOK key for the escalation paths


async def _react_core(substrate_smiles: str, reagent_smiles: str) -> dict:
    """Reaction run shared by /react and the chat run_reaction tool:
    canonicalize, infer conditions, predict via ASKCOS, name via templates.
    Raises HTTPException(422) on invalid SMILES; no LLM involvement."""
    from rdkit import Chem

    sub_mol = Chem.MolFromSmiles(substrate_smiles.strip())
    if sub_mol is None:
        raise HTTPException(status_code=422, detail="Invalid substrate SMILES")
    rea_mol = Chem.MolFromSmiles(reagent_smiles.strip())
    if rea_mol is None:
        raise HTTPException(status_code=422, detail="Invalid reagent SMILES")

    substrate = Chem.MolToSmiles(sub_mol)
    reagent   = Chem.MolToSmiles(rea_mol)

    conditions = TemplateEngine._infer_conditions(reagent)
    # Also check REAGENT_LIST for explicit condition tags
    for r in REAGENT_LIST:
        r_mol = Chem.MolFromSmiles(r["smiles"])
        if r_mol and Chem.MolToSmiles(r_mol) == reagent:
            conditions = r.get("conditions", conditions)
            break

    prediction = await _predict_products(substrate, reagent, conditions)

    return {
        "substrate_smiles": substrate,
        "reagent_smiles":   reagent,
        "environment":      "Kinetic" if "kinetic_base" in conditions else "Thermodynamic",
        "conditions":       conditions,
        "products":         prediction.products,
        "source":           prediction.source,
        "low_confidence":   prediction.low_confidence,
    }


@app.post("/react")
async def react(req: ReactRequest, user_id: str | None = Depends(require_auth)):
    """Return all predicted products for a given substrate + reagent SMILES pair."""
    core = await _react_core(req.substrate_smiles, req.reagent_smiles)
    byok_key = req.engine.api_key if req.engine else None
    substrate, reagent = core["substrate_smiles"], core["reagent_smiles"]
    products = core["products"]

    ai_guess = None
    sanity_check = None
    if not products:
        _record_template_gap("react", substrate, reagent, core["conditions"])
        ai_guess = await _maybe_blind_guess(substrate, reagent, user_id, api_key=byok_key)
    else:
        # An ASKCOS product the templates couldn't reproduce is a library gap,
        # and a sharper one than "nothing matched" — we know a reaction happens
        # and what it yields, just not what to call it.
        if any(p["reaction_name"] == UNNAMED_REACTION for p in products):
            _record_template_gap("react_unnamed", substrate, reagent, core["conditions"])

        if core["low_confidence"]:
            # No template corroborates ASKCOS and ASKCOS itself isn't sure, so
            # neither deterministic source is standing behind this answer. Ask
            # Claude as a second opinion. It arrives in the same `ai_guess`
            # channel as the no-products case — already RDKit-validated and
            # already flagged `unverified` — so the UI presents it as a guess
            # sitting alongside the prediction, never as ground truth.
            _record_template_gap("react_low_confidence", substrate, reagent, core["conditions"])
            ai_guess = await _maybe_blind_guess(substrate, reagent, user_id, api_key=byok_key)
        elif needs_sanity_check(products, core["low_confidence"]):
            # A curated template named every product, so a hand-written rule
            # already vouches for this answer — spending a model round-trip to
            # second-guess it only makes the page slower. See needs_sanity_check.
            sanity_check = await _maybe_sanity_check(substrate, reagent, products, user_id,
                                                     api_key=byok_key)

    return {
        "substrate_smiles": substrate,
        "reagent_smiles":   reagent,
        "environment":      core["environment"],
        "products":         products,
        "source":           core["source"],
        "low_confidence":   core["low_confidence"],
        "ai_guess":         ai_guess,
        "sanity_check":     sanity_check,
    }


@app.post("/react-from-image")
async def react_from_image(file: UploadFile = File(...),
                           api_key: str | None = Form(default=None),
                           user_id: str | None = Depends(require_auth)):
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 8 MB).")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(_executor, _react_from_image, contents, api_key)
    except Exception as exc:
        logger.exception("react-from-image pipeline failed")
        raise HTTPException(status_code=500, detail="Reaction image processing failed.") from exc

    result["ai_guess"] = None
    result["sanity_check"] = None
    if result.get("substrate_smiles") and result.get("reagent_smiles") and not result.get("error"):
        if not result.get("products"):
            _record_template_gap("react_from_image",
                                 result["substrate_smiles"], result["reagent_smiles"], [])
            result["ai_guess"] = await _maybe_blind_guess(
                result["substrate_smiles"], result["reagent_smiles"], user_id,
                api_key=api_key)
        elif result.get("low_confidence"):
            # Same escalation as /react: nothing deterministic vouches for this
            # product, so Claude gives a second opinion alongside it.
            _record_template_gap("react_from_image_low_confidence",
                                 result["substrate_smiles"], result["reagent_smiles"], [])
            result["ai_guess"] = await _maybe_blind_guess(
                result["substrate_smiles"], result["reagent_smiles"], user_id,
                api_key=api_key)
        elif needs_sanity_check(result["products"], bool(result.get("low_confidence"))):
            result["sanity_check"] = await _maybe_sanity_check(
                result["substrate_smiles"], result["reagent_smiles"],
                result["products"], user_id, api_key=api_key)
    return result


# The web UI is served separately by the Next.js frontend (port 3000), which
# proxies these API routes via next.config.mjs rewrites. FastAPI is API-only.
