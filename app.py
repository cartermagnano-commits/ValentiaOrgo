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

_rxn_arb_logger = logging.getLogger("reaction_arbitration")
_rxn_arb_logger.setLevel(logging.INFO)
if not _rxn_arb_logger.handlers:
    _rxn_arb_logger.addHandler(logging.StreamHandler())
    _rxn_arb_logger.propagate = False

import cv2
import numpy as np
from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
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

from osr_arbitration import (
    arbitrate_local, plausible_or_none, resolve_with_vision,
)
from reaction_arbitration import (
    AI_ONLY, DISPUTED, UNVERIFIED, VERIFIED, candidate_pool,
    plausible_products, verdict,
)
from preprocessing import denoise, deskew, normalize_binarize, perspective_correct
from reactivity_engine import TemplateEngine

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

    result = plausible_or_none(_canonical_smiles(text), "Vision")
    if result:
        logger.info("Ollama → valid SMILES (full response): %r", result)
        return result

    for candidate in re.findall(r"[A-Za-z0-9@+\-\[\]()/\\=#%\.]{6,}", text):
        result = plausible_or_none(_canonical_smiles(candidate), "Vision")
        if result:
            logger.info("Ollama → valid SMILES (extracted token): %r", result)
            return result

    logger.warning("Ollama: no valid SMILES found in response: %r", text[:200])
    return None


def _ollama_vision_smiles(img_bytes: bytes) -> str | None:
    """
    Extract all molecule SMILES from an image, ignoring reaction notation.
    Used by the /analyze pipeline as a DECIMER fallback.
    """
    return _ollama_call(
        img_bytes,
        "You are an expert chemist. The image shows chemical structures, possibly alongside "
        "reaction notation.\n\n"
        "Extract SMILES for every actual chemical molecule present. Ignore:\n"
        "  - Reaction arrows (→, ->, ⟶, curved electron-flow arrows)\n"
        "  - Question marks (?) indicating unknown products\n"
        "  - Plus signs (+) as separators — use a period (.) instead\n"
        "  - Text annotations: 'heat', 'Δ', 'hν', solvent names, temperatures\n\n"
        "Output ONLY the SMILES string. Separate multiple molecules with '.'. "
        "No explanation, no prose, no markdown.",
    )


def _ollama_reaction_smiles(img_bytes: bytes) -> str | None:
    """
    Extract only the INPUT molecules (starting materials + reagents) from a reaction image.
    Understands that arrows show reaction direction and question marks indicate the unknown
    product — neither should appear in the returned SMILES.
    Used by the /react-from-image pipeline.
    """
    return _ollama_call(
        img_bytes,
        "You are an expert organic chemist reading a reaction problem image.\n\n"
        "The image shows a chemical reaction: starting material(s) on the LEFT of a reaction "
        "arrow, possibly reagents written above or below the arrow, and a product or question "
        "mark (?) on the RIGHT.\n\n"
        "Output ONLY the SMILES of the INPUT molecules — starting materials and reagents that "
        "go INTO the reaction. Do NOT output the product or question mark.\n\n"
        "Ignore completely:\n"
        "  - Reaction arrows (→, ->, ⟶) and curved electron-flow arrows\n"
        "  - Question marks (?) — these are the unknown product, not an input\n"
        "  - Text annotations: 'heat', 'Δ', 'hν', solvent names, temperatures\n"
        "  - Plus signs (+) as separators — use a period (.) instead\n\n"
        "Output ONLY a SMILES string — no prose, no labels, no markdown. "
        "Separate multiple input molecules with a period (.).",
    )


# ── "Choose Your Engine" — generative LLM provider router ────────────────────
# The engine picker (local / byok / hosted) ONLY powers generative explanations
# and chat. Structure recognition and the reaction engine always run keyless.
# A BYOK api_key is request-scoped: never persisted, never logged.

DEFAULT_ANTHROPIC_MODEL = os.environ.get("HOSTED_ANTHROPIC_MODEL", "claude-sonnet-4-6")
DEFAULT_OPENAI_MODEL    = os.environ.get("HOSTED_OPENAI_MODEL", "gpt-4o-mini")

# Lightweight in-memory usage telemetry (per engine mode/provider). Resets on
# restart — just enough to see where generative calls are going before real
# billing/enforcement lands.
_ENGINE_USAGE: dict[str, int] = {}


def _record_usage(mode: str, provider: str | None) -> None:
    key = f"{mode}:{provider or '-'}"
    _ENGINE_USAGE[key] = _ENGINE_USAGE.get(key, 0) + 1


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
    client = anthropic.AsyncAnthropic(api_key=api_key or os.environ["ANTHROPIC_API_KEY"])
    async with client.messages.stream(
        model=model or DEFAULT_ANTHROPIC_MODEL,
        max_tokens=max_tokens,
        system=system,
        messages=messages,
    ) as stream:
        async for text in stream.text_stream:
            yield f"data: {json.dumps({'delta': text})}\n\n"
    yield "data: [DONE]\n\n"


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


def _select_stream(system: str, messages: list[dict], max_tokens: int,
                   engine: Optional[EngineConfig] = None):
    if engine is None:
        _record_usage("env", None)
        if os.environ.get("ANTHROPIC_API_KEY"):
            return _stream_anthropic(system, messages, max_tokens)
        if os.environ.get("OPENAI_API_KEY"):
            return _stream_openai(system, messages, max_tokens)
        return _stream_ollama(system, messages, max_tokens)

    mode = (engine.mode or "hosted").lower()
    if mode == "byok" and not engine.api_key:
        # Validate BEFORE recording usage — a rejected request never reached a
        # provider and shouldn't inflate the telemetry.
        raise HTTPException(400, "BYOK mode requires an API key.")
    _record_usage(mode, engine.provider)

    if mode == "local":
        return _stream_ollama(system, messages, max_tokens, model=engine.model)

    if mode == "byok":
        provider = (engine.provider or "anthropic").lower()
        if provider == "openai":
            return _stream_openai(system, messages, max_tokens,
                                  model=engine.model, api_key=engine.api_key)
        return _stream_anthropic(system, messages, max_tokens,
                                 model=engine.model, api_key=engine.api_key)

    # hosted — server-side key; billing/enforcement deferred (no users yet).
    # Honor the requested provider when its key is configured; otherwise fall
    # back to the OTHER configured hosted provider (symmetrically — this is
    # what _enforce_hosted_quota assumes when it meters on "either key set"),
    # and only then degrade to local so the app still works. engine.model is a
    # model id for the REQUESTED provider — it must not follow the request
    # across a fallback (Anthropic ids 404 on OpenAI, and both 404 on Ollama).
    provider = (engine.provider or "anthropic").lower()
    have_openai = bool(os.environ.get("OPENAI_API_KEY"))
    have_anthropic = bool(os.environ.get("ANTHROPIC_API_KEY"))
    if provider == "openai":
        if have_openai:
            return _stream_openai(system, messages, max_tokens, model=engine.model)
        if have_anthropic:
            return _stream_anthropic(system, messages, max_tokens)
    else:
        if have_anthropic:
            return _stream_anthropic(system, messages, max_tokens, model=engine.model)
        if have_openai:
            return _stream_openai(system, messages, max_tokens)
    return _stream_ollama(system, messages, max_tokens)


async def _llm_complete(system: str, messages: list[dict], max_tokens: int,
                        engine: Optional[EngineConfig] = None) -> str:
    """Run a generative call to completion and return its full text.

    Drains the same generator `/explain` streams, so provider routing, BYOK
    key handling, and hosted fallbacks are reused rather than duplicated.
    Returns "" on any failure — callers treat an empty reply as "the AI had
    nothing to say", which degrades to an unverified verdict.
    """
    chunks: list[str] = []
    try:
        async for frame in _select_stream(system, messages, max_tokens, engine):
            if not frame.startswith("data: "):
                continue
            payload = frame[6:].strip()
            if payload == "[DONE]":
                break
            try:
                data = json.loads(payload)
            except Exception:
                continue
            if data.get("error"):
                logger.warning("LLM completion error frame: %s", data["error"])
                return ""
            if data.get("delta"):
                chunks.append(data["delta"])
    except HTTPException:
        raise           # missing BYOK key etc. — surface as a real HTTP error
    except Exception as exc:
        logger.warning("LLM completion failed (%s): %s", type(exc).__name__, exc)
        return ""
    return "".join(chunks)


# A SMILES-ish token: the character set RDKit accepts, long enough not to
# match ordinary prose words.
_SMILES_TOKEN = re.compile(r"[A-Za-z0-9@+\-\[\]()/\\=#%\.]{2,}")


def _parse_smiles_list(text: str, limit: int = 4) -> list[str]:
    """Extract canonical, plausible product SMILES from a model reply.

    The prompt asks for SMILES-only output, but models still wrap replies in
    prose or code fences — so parse defensively: try each line whole first
    (a line IS the answer in the common case), then fall back to tokens.
    """
    if not text:
        return []
    found: list[str] = []
    for line in text.replace("```", "\n").splitlines():
        line = line.strip().strip(",;")
        if not line:
            continue
        # A clean single-SMILES line never contains embedded whitespace — a
        # line with a space is prose, not "the answer". This guard matters
        # because current RDKit parses space-delimited input leniently
        # (MolFromSmiles stops at the first space and accepts the valid
        # prefix) rather than rejecting the whole string, so without it
        # "I am not sure." would wrongly canonicalize to "I" here.
        canon = _canonical_smiles(line) if " " not in line else None
        if canon:
            found.append(canon)
            continue
        for token in _SMILES_TOKEN.findall(line):
            canon = _canonical_smiles(token)
            if canon:
                found.append(canon)
    return plausible_products(found)[:limit]


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

_LOOPBACK_IPS = {"127.0.0.1", "::1", "localhost"}


def _client_ip(request) -> str:
    """Best-effort real client IP.

    All browser traffic arrives through the Next.js rewrite proxy, so
    request.client.host is the proxy's address for every user — keying the
    limiter on it collapses all clients into ONE shared bucket. Next.js sets
    X-Forwarded-For with the real client; trust it only when the direct peer
    is loopback (our own proxy), so a remote caller can't spoof the header
    to dodge the limit.
    """
    peer = request.client.host if request.client else "unknown"
    if peer in _LOOPBACK_IPS:
        fwd = request.headers.get("x-forwarded-for", "")
        if fwd:
            return fwd.split(",")[0].strip() or peer
    return peer


@app.middleware("http")
async def _rate_limit(request, call_next):
    path = request.url.path
    # /analyze/verify/{token} holds a server connection for minutes while it
    # waits on the vision model — it must count against the heavy budget too.
    if path in RATE_LIMIT_HEAVY or path.startswith("/analyze/verify/"):
        limit, tier = RATE_LIMIT_HEAVY_MAX, "heavy"
    elif path in RATE_LIMIT_LIGHT:
        limit, tier = RATE_LIMIT_LIGHT_MAX, "light"
    else:
        return await call_next(request)

    key = f"{tier}:{_client_ip(request)}"
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


def _guard_messages(messages) -> None:
    if len(messages) > MAX_CHAT_MESSAGES:
        raise HTTPException(status_code=413, detail="Too many messages in one request.")
    if sum(len(m.content) for m in messages) > MAX_CONTENT_CHARS:
        raise HTTPException(status_code=413, detail="Message payload too large.")


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


def _decode_upload(raw_bytes: bytes) -> np.ndarray:
    """Decode an uploaded image into a working-size BGR array (EXIF-rotated).
    Raises ValueError when the bytes aren't a readable image."""
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
    return _resize(img)


def _normalize_polarity(img: np.ndarray) -> tuple[np.ndarray, bool, bool]:
    """Flip dark-mode digital renders to the dark-ink-on-white polarity the OSR
    models and binarization expect. Returns (img, digital, inverted)."""
    polarity = _digital_polarity(img)
    if polarity == "dark":
        return cv2.bitwise_not(img), True, True
    return img, polarity is not None, False


def _repair_and_binarize(img: np.ndarray, digital: bool, record=None) -> np.ndarray:
    """Photo-repair stages + binarization, shared by /analyze and
    /react-from-image. Clean digital depictions skip the repair stages — slow,
    and able to warp or blur an already-perfect render. A failed stage is
    non-fatal: keep the last good image and continue. record(name, arr), when
    given, captures each stage for the UI stage strip."""
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
            logger.warning("Preprocessing stage %r failed (%s): %s", name, type(exc).__name__, exc)
        if record:
            record(name, current)
    return current


def _confidence_label(verified: bool | None) -> str:
    """UI badge for a verification verdict: True→high, False→low, None→unverified."""
    if verified is True:
        return "high"
    if verified is False:
        return "low"
    return "unverified"


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


def _mol_from_smiles_loose(text: str):
    """Parse SMILES, falling back to treating '+' as a fragment separator (some
    reader outputs use it). The fallback only runs when the literal text doesn't
    parse — blind replacement would corrupt charged atoms like [NH3+] or [Li+].
    Returns an RDKit Mol or None."""
    from rdkit import Chem
    mol = Chem.MolFromSmiles(text)
    if mol is None:
        mol = Chem.MolFromSmiles(text.replace("+", "."))
    return mol


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


def _process(raw_bytes: bytes) -> dict:
    img = _decode_upload(raw_bytes)
    stages: dict[str, str | None] = {"original": _stage_b64(img)}

    # Clean digital depictions (screenshots, PDF renders) skip the photo-repair
    # stages; dark-mode renders are flipped first. (The vision model still sees
    # the raw upload — VLMs read dark mode natively.)
    img, digital, inverted = _normalize_polarity(img)
    if inverted:
        stages["invert"] = _stage_b64(img)

    # Kick off the slow independent readers FIRST, each on its own pool, so
    # they overlap the preprocessing stages and DECIMER reads below instead
    # of running after them:
    #   * vision (Ollama HTTP) — sees a downscaled copy of the upload
    #   * MolScribe (torch)    — reads the original now; the binarized
    #     rendition is submitted as soon as preprocessing produces it
    vision_future = _vision_pool.submit(_ollama_vision_smiles, _vision_png(img))
    ms_orig_future = _molscribe_pool.submit(_molscribe_read, img)

    current = _repair_and_binarize(
        img, digital, record=lambda name, arr: stages.__setitem__(name, _stage_b64(arr)))
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
    else:
        confidence = _confidence_label(verified)

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

        results.append({
            "reagent": {k: v for k, v in reagent.items() if k != "conditions"},
            "environment": environment,
            "steps_taken": b["steps_taken"],
            "execution_history": b["execution_history"],
            "product_smiles": product_smiles,
            "steps": b["steps"],
            # Kept for the frontend's reaction_classification shape; the name
            # comes straight from the template that fired.
            "reaction_classification": {"name": b["reaction_name"], "confidence": "template"},
            "template_id": b["template_id"],
            "reaction_name": b["reaction_name"],
            "matches_target": False,  # filled in after
        })

    return results


# ── Routes ────────────────────────────────────────────────────────────────────

@app.post("/analyze", dependencies=[Depends(require_auth)])
async def analyze(file: UploadFile = File(...)):
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 8 MB).")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(_executor, _process, contents)
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
        result["confidence"] = _confidence_label(verified)
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
    confidence = _confidence_label(verified)
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


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    context: Optional[dict] = None
    engine: Optional[EngineConfig] = None  # generative engine selection (Choose Your Engine)


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

    messages = [{"role": m.role, "content": m.content} for m in req.messages]

    return StreamingResponse(
        _sse_stream(system_prompt, messages, 250, req.engine),
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
        mol = _mol_from_smiles_loose(text)
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


def _smiles_ground(text: str) -> str:
    """RDKit ground truth for a single SMILES (molecule_note / retrosynthesis
    grounding): canonical form + molecular formula the LLM must not contradict,
    or an explicit invalid-SMILES flag it must relay instead of inventing a
    structure. Returns '' when there is nothing to check."""
    text = (text or "").strip()
    if not text:
        return ""
    try:
        from rdkit import Chem
        from rdkit.Chem.rdMolDescriptors import CalcMolFormula
        mol = Chem.MolFromSmiles(text)
        if mol is None:
            return (
                "ENGINE GROUND TRUTH (deterministic — never contradict):\n"
                f"  RDKit could NOT parse {text!r} as a valid SMILES. Tell the "
                "student the SMILES is invalid; do not invent a structure for it."
            )
        return (
            "ENGINE GROUND TRUTH (deterministic — never contradict):\n"
            f"  SMILES as given: {text}\n"
            f"  Canonical SMILES (RDKit): {Chem.MolToSmiles(mol)}\n"
            f"  Molecular formula: {CalcMolFormula(mol)}"
        )
    except Exception as exc:
        logger.warning("assist SMILES grounding failed (%s): %s", type(exc).__name__, exc)
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
    loop = asyncio.get_event_loop()
    # Every file type that carries a structure gets deterministic (RDKit /
    # template-engine) ground truth injected, so the LLM annotates verified
    # facts instead of free-running.
    if req.file_type == "mechanism":
        text = str(content.get("reactionInput", "")).strip()
        if text:
            ground = await loop.run_in_executor(_chem_pool, _engine_ground_from_text, text)
    elif req.file_type == "molecule_note":
        ground = await loop.run_in_executor(
            _chem_pool, _smiles_ground, str(content.get("smiles", "")))
    elif req.file_type == "retrosynthesis":
        ground = await loop.run_in_executor(
            _chem_pool, _smiles_ground, str(content.get("targetMolecule", "")))

    system, user = _assist_prompts(req.file_type, content, ground)
    return StreamingResponse(
        _sse_stream(system, [{"role": "user", "content": user}], 500, req.engine),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── /react-from-image ─────────────────────────────────────────────────────────

def _branch_products(branches: list[dict]) -> list[dict]:
    """Shape engine branches into the products list served by /react and
    /react-from-image."""
    return [
        {
            "smiles":            b["final_product"],
            "reaction_name":     b["reaction_name"],
            "template_id":       b["template_id"],
            "steps_taken":       b["steps_taken"],
            "execution_history": b["execution_history"],
        }
        for b in branches
    ]


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


def _react_from_image(raw_bytes: bytes) -> dict:
    """
    Full pipeline: raw image bytes → preprocessing → DECIMER → split
    into substrate + reagent → template engine → product SMILES.

    Returns a dict with keys:
        recognized_smiles   — raw DECIMER output
        components          — list of canonical component SMILES strings
        substrate_smiles    — first component (canonical)
        reagent_smiles      — remaining components joined with '.'
        products            — list of {smiles, reaction_name, template_id,
                               steps_taken, execution_history}
        error               — str | None
    """
    from rdkit import Chem

    # 1. Preprocess image — same decode/polarity/repair pipeline as /analyze.
    try:
        img = _decode_upload(raw_bytes)
    except ValueError as exc:
        return {"error": str(exc), "products": []}

    img, digital, _inverted = _normalize_polarity(img)
    current = _repair_and_binarize(img, digital)

    # 2. OSR via DECIMER — digital images read the original first (closest to
    # DECIMER's training distribution), binarized only as fallback; photos the
    # reverse, matching the /analyze pipeline.
    recognized_smiles: str | None = None
    try:
        first, second = (img, current) if digital else (current, img)
        recognized_smiles = _decimer_read(first) or _decimer_read(second)
        logger.info("DECIMER output: %r", recognized_smiles)
    except Exception as exc:
        # DECIMER missing/broken is recoverable — the Ollama vision fallback
        # below gets a chance, same as the /analyze pipeline.
        logger.warning("DECIMER failed (%s): %s — trying vision fallback", type(exc).__name__, exc)
        recognized_smiles = None

    # Encode the preprocessed image once (downscaled for VLM prefill speed);
    # reused by all Ollama fallback calls below
    _img_bytes = _vision_png(current)

    if not recognized_smiles:
        logger.info("DECIMER returned nothing — calling Ollama reaction parse")
        recognized_smiles = _ollama_reaction_smiles(_img_bytes)
        logger.info("Ollama (empty DECIMER fallback) returned: %r", recognized_smiles)
    if not recognized_smiles:
        return {"error": "No structure recognized in the image.", "products": []}

    # 3. Parse all components — split on '.' but re-validate each fragment
    raw_mol = _mol_from_smiles_loose(recognized_smiles)
    if raw_mol is None:
        logger.info("DECIMER SMILES invalid — calling Ollama reaction parse")
        fallback = _ollama_reaction_smiles(_img_bytes)
        logger.info("Ollama (invalid SMILES fallback) returned: %r", fallback)
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

    # Detect suspicious DECIMER output: non-organic elements (e.g. [U] = uranium, a
    # common DECIMER artefact when it misreads image noise) or excessive fragment count.
    _NON_ORGANIC = {"U", "Tc", "Re", "Os", "Ir", "Rh", "Ru", "Pd", "Pt", "Au", "Hg"}
    _atom_syms = {a.GetSymbol() for a in raw_mol.GetAtoms()}
    _bad_atoms = _atom_syms & _NON_ORGANIC
    if len(frags) > 5 or _bad_atoms:
        logger.info(
            "Suspicious DECIMER output (%d frags, non-organic atoms=%s, smiles=%r) — calling Ollama",
            len(frags), _bad_atoms or "none", recognized_smiles,
        )
        fix = _ollama_reaction_smiles(_img_bytes)
        logger.info("Ollama (suspicious DECIMER) returned: %r", fix)
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
        }

    # 4. Assign substrate/reagent and run the engine — every fragment gets a
    # turn as the substrate; the first assignment that matches a template wins.
    substrate_smiles, reagent_smiles, conditions, branches = _pick_substrate_and_react(components)
    logger.info(
        "Template engine: substrate=%r  reagent=%r  conditions=%s → %d branch(es)",
        substrate_smiles, reagent_smiles, conditions, len(branches),
    )

    # 5. Last-resort: if engine matched nothing, ask Ollama for a cleaner re-read and retry
    if not branches:
        logger.info("No templates matched — calling Ollama for last-resort re-identification")
        retry_smiles = _ollama_reaction_smiles(_img_bytes)
        logger.info("Ollama (no-match retry) returned: %r", retry_smiles)
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
                        "Retry with Ollama SMILES: substrate=%r  reagent=%r  conditions=%s → %d branch(es)",
                        substrate_smiles, reagent_smiles, conditions, len(branches),
                    )

    products = _branch_products(branches)

    return {
        "recognized_smiles": recognized_smiles,
        "components":        components,
        "substrate_smiles":  substrate_smiles,
        "reagent_smiles":    reagent_smiles,
        "products":          products,
        "error":             None if products else "No matching reaction templates for this substrate/reagent pair.",
    }


class ReactRequest(BaseModel):
    substrate_smiles: str
    reagent_smiles: str


@app.post("/react", dependencies=[Depends(require_auth)])
async def react(req: ReactRequest):
    """Return all predicted products for a given substrate + reagent SMILES pair."""
    from rdkit import Chem

    sub_mol = Chem.MolFromSmiles(req.substrate_smiles.strip())
    if sub_mol is None:
        raise HTTPException(status_code=422, detail="Invalid substrate SMILES")
    rea_mol = Chem.MolFromSmiles(req.reagent_smiles.strip())
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

    def _run():
        return _get_engine().run_for_reagent(substrate, reagent, conditions)

    loop = asyncio.get_event_loop()
    branches = await loop.run_in_executor(_chem_pool, _run)

    environment = "Kinetic" if "kinetic_base" in conditions else "Thermodynamic"

    return {
        "substrate_smiles": substrate,
        "reagent_smiles":   reagent,
        "environment":      environment,
        "products":         _branch_products(branches),
    }


@app.post("/react-from-image", dependencies=[Depends(require_auth)])
async def react_from_image(file: UploadFile = File(...)):
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 8 MB).")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(_executor, _react_from_image, contents)
    except Exception as exc:
        logger.exception("react-from-image pipeline failed")
        raise HTTPException(status_code=500, detail="Reaction image processing failed.") from exc
    return result


# The web UI is served separately by the Next.js frontend (port 3000), which
# proxies these API routes via next.config.mjs rewrites. FastAPI is API-only.
