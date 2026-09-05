"""
test_usage_events.py — Regression suite for the usage_events write path.

Run before committing changes to _post_usage_event in app.py:

    python test_usage_events.py

Matches test_askcos.py's approach: drives the real function through an
injected httpx.MockTransport (via _post_usage_event's `transport` test seam),
so no live Supabase project is needed and nothing here touches the network.
"""

import asyncio
import sys

import httpx

import app

failures: list[str] = []


def check(name: str, ok: bool, detail: str = ""):
    if ok:
        print(f"PASS  {name}")
    else:
        failures.append(name)
        print(f"FAIL  {name}  {detail}")


app.SUPABASE_URL = "https://example.supabase.co"
app.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key"

captured = []


def handler(request: httpx.Request) -> httpx.Response:
    captured.append(request)
    return httpx.Response(201, json=[{"id": 1}])


asyncio.run(app._post_usage_event("react", "user-123", transport=httpx.MockTransport(handler)))

check("posted exactly one request", len(captured) == 1, str(len(captured)))
if captured:
    req = captured[0]
    check("posts to the usage_events REST path",
          req.url.path == "/rest/v1/usage_events", str(req.url))
    check("carries the service-role key as apikey and bearer",
          req.headers.get("apikey") == "test-service-role-key"
          and req.headers.get("authorization") == "Bearer test-service-role-key",
          str(dict(req.headers)))
    import json
    body = json.loads(req.content)
    check("body carries user_id and endpoint",
          body == {"user_id": "user-123", "endpoint": "react"}, str(body))

# ── Failure modes must never raise ────────────────────────────────────────────

def raising_handler(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("connection refused", request=request)

try:
    asyncio.run(app._post_usage_event(
        "react", "user-123", transport=httpx.MockTransport(raising_handler)))
    check("a network failure is swallowed, not raised", True)
except Exception as exc:
    check("a network failure is swallowed, not raised", False, repr(exc))


def erroring_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(500, json={"message": "internal error"})

try:
    asyncio.run(app._post_usage_event(
        "react", "user-123", transport=httpx.MockTransport(erroring_handler)))
    check("a 500 response is swallowed, not raised", True)
except Exception as exc:
    check("a 500 response is swallowed, not raised", False, repr(exc))

# ── _log_usage_event: the no-op guards ────────────────────────────────────────

app.SUPABASE_URL = None
app.SUPABASE_SERVICE_ROLE_KEY = None
check("no Supabase config configured → _log_usage_event does not schedule anything",
      app._log_usage_event("react", "user-123") is None)

app.SUPABASE_URL = "https://example.supabase.co"
app.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key"
check("anonymous caller (user_id=None) → _log_usage_event does not schedule anything",
      app._log_usage_event("react", None) is None)

print(f"\n{len(failures)} failing" if failures else "\nAll checks passed")
sys.exit(1 if failures else 0)
