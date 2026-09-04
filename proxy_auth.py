"""
proxy_auth.py — is this request from our own proxy, and can we believe its
forwarded client IP?

Split out of app.py so both rules are testable without importing FastAPI,
cv2 and the OSR warm-ups (see prediction.py for the same reasoning).

Background: the rate limiter used to trust X-Forwarded-For only from a
loopback peer, which held while the Next.js proxy ran on the same machine.
With the frontend on Vercel and the backend on Railway the peer is an egress
IP that is never loopback, so the header was ignored and every user collapsed
into ONE shared bucket. Widening the trust unconditionally is not an option:
the Railway URL is public, so any caller could spoof the header.

ORGO_PROXY_SECRET settles both questions at once. The proxy attaches it to
every forwarded request; its presence both authorizes the request and marks
the forwarded IP as trustworthy.
"""

from __future__ import annotations

import hmac

# Header the Next.js middleware attaches. Lowercase: ASGI header lookups are
# case-insensitive but Starlette normalizes to lowercase.
PROXY_SECRET_HEADER = "x-orgo-proxy-secret"

# Railway's healthcheck probes the backend directly and carries no proxy
# header, so gating /health would fail every deploy. It exposes only booleans
# about which models loaded.
EXEMPT_PATHS = frozenset({"/health"})

LOOPBACK_IPS = {"127.0.0.1", "::1", "localhost"}


def secret_matches(header_value: str | None, expected_secret: str | None) -> bool:
    """True only when a secret is configured AND this request carried it.

    The narrow question, kept separate from proxy_authorized on purpose: an
    unset secret authorizes every request but proves nothing about who sent
    it, so it must never be read as grounds to trust a forwarded IP.
    """
    if not expected_secret or not header_value:
        return False
    # hmac.compare_digest raises TypeError on a non-ASCII str (Starlette
    # latin-1-decodes header bytes, so a caller can send bytes 0x80-0xFF and
    # hit exactly that). Bytes have no such restriction, so compare as UTF-8
    # bytes instead — this never raises, and fails closed on any mismatch.
    return hmac.compare_digest(header_value.encode("utf-8"), expected_secret.encode("utf-8"))


def proxy_authorized(header_value: str | None, expected_secret: str | None,
                     path: str) -> bool:
    """True when this request may proceed.

    An unset `expected_secret` disables the check entirely — that is the
    keyless local-development path, and the backend must never lock itself
    out by default. /health is exempt because Railway's healthcheck probes
    the backend directly and carries no proxy header.
    """
    if not expected_secret:
        return True
    if path in EXEMPT_PATHS:
        return True
    return secret_matches(header_value, expected_secret)


def resolve_client_ip(peer: str, forwarded: str | None, trusted: bool) -> str:
    """Rate-limit bucket key: the real client IP when we can believe it.

    `trusted` says the request demonstrably came from our proxy — either a
    loopback peer (local dev) or a valid proxy secret. Only then is the
    forwarded chain believed; otherwise an untrusted caller could spoof a
    fresh bucket per request and walk past the limiter.
    """
    if trusted and forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    return peer
