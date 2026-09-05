"""
test_auth.py — Regression suite for optional_auth (app.py).

Run before committing changes to the auth section of app.py:

    python test_auth.py

Plain Python on purpose (matching test_templates.py): one PASS/FAIL line per
case, non-zero exit on any failure. Imports app.py directly — the only
top-level heavy import there is cv2 (see
docs/superpowers/specs/2026-09-03-byok-railway-deploy-design.md), so this
stays fast and needs no live Supabase project: HS256 verification is a local
computation (no JWKS network call), which is exactly the path exercised here.
"""

import asyncio
import sys

import jwt
from fastapi import HTTPException

import app

failures: list[str] = []


def check(name: str, ok: bool, detail: str = ""):
    if ok:
        print(f"PASS  {name}")
    else:
        failures.append(name)
        print(f"FAIL  {name}  {detail}")


def run(authorization: str):
    return asyncio.run(app.optional_auth(authorization=authorization))


TEST_SECRET = "test-secret-do-not-use-in-prod"


def make_token(secret: str = TEST_SECRET, **claims) -> str:
    payload = {"sub": "user-123", "aud": "authenticated", **claims}
    return jwt.encode(payload, secret, algorithm="HS256")


# ── AUTH_ENABLED, with a valid HS256 secret configured ────────────────────────
app.AUTH_ENABLED = True
app.SUPABASE_JWT_SECRET = TEST_SECRET
app.SUPABASE_JWKS_URL = None

result = run(f"Bearer {make_token()}")
check("valid token returns the real user id", result == "user-123", repr(result))

result = run("")
check("no Authorization header returns None (anonymous), not a 401",
      result is None, repr(result))

try:
    run("Bearer not-a-real-jwt")
    check("a garbage token 401s (doesn't silently return None)", False)
except HTTPException as exc:
    check("a garbage token 401s", exc.status_code == 401, repr(exc))

try:
    run(f"Bearer {make_token(secret='wrong-secret')}")
    check("a token signed with the wrong secret 401s", False)
except HTTPException as exc:
    check("a token signed with the wrong secret 401s", exc.status_code == 401, repr(exc))

check("a non-Bearer Authorization header is treated as anonymous",
      run("Basic dXNlcjpwYXNz") is None)

# ── AUTH_ENABLED false: nothing can be verified, so always anonymous ─────────
app.AUTH_ENABLED = False

result = run(f"Bearer {make_token()}")
check("AUTH_ENABLED false returns None even with a well-formed token",
      result is None, repr(result))

print(f"\n{len(failures)} failing" if failures else "\nAll checks passed")
sys.exit(1 if failures else 0)
