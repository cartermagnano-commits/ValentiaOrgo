"""
byok.py — where a user-supplied Anthropic-family key's traffic should go.

Split out of app.py so the rule is testable without importing FastAPI, cv2
and the OSR model warm-ups (the same reason prediction.py is its own module).

The rule: a BYOK key routes by its own prefix and NEVER inherits the server's
ANTHROPIC_BASE_URL. A gateway like MIT Parley rejects a real Anthropic key,
and api.anthropic.com rejects a Parley key — so a server configured for one
must not drag a user's key of the other kind along with it.
"""

from __future__ import annotations

ANTHROPIC_BASE_URL = "https://api.anthropic.com"
PARLEY_BASE_URL = "https://parley.api.mit.edu"
PARLEY_KEY_PREFIX = "sk-parley-"


def anthropic_base_url(api_key: str | None, server_base_url: str | None = None) -> str:
    """Base URL for an Anthropic-family call.

    With a BYOK `api_key`, route by key prefix and ignore `server_base_url`
    entirely. Without one, fall back to the server's configured gateway, or
    to api.anthropic.com when none is set.
    """
    if api_key:
        return PARLEY_BASE_URL if api_key.startswith(PARLEY_KEY_PREFIX) else ANTHROPIC_BASE_URL
    return (server_base_url or ANTHROPIC_BASE_URL).rstrip("/")
