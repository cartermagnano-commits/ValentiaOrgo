"""
test_chat_explain.py — the deferred-explanation contract for POST /chat.

Run with the backend up:

    python3 -m uvicorn app:app --host 127.0.0.1 --port 8000   # in another shell
    python3 test_chat_explain.py

Skips cleanly when nothing is listening on :8000. This one makes real model
calls, so it is opt-in rather than part of an offline suite — the behaviour it
checks (does the server stop before the explanation round?) only exists
end-to-end, inside a live Anthropic tool loop.
"""

import json
import socket
import sys
import urllib.error
import urllib.request

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:8000"

failures: list[str] = []
passes = 0


def check(name: str, ok: bool, detail: str = ""):
    global passes
    if ok:
        passes += 1
        print(f"PASS  {name}")
    else:
        failures.append(name)
        print(f"FAIL  {name}  {detail}")


def backend_up() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", 8000), timeout=2):
            return True
    except OSError:
        return False


def chat(text: str, explain: bool) -> tuple[list[str], list[dict]]:
    """POST /chat on the reaction surface. Returns (text deltas, tool events)."""
    body = json.dumps({
        "messages": [{"role": "user", "content": text}],
        "context": None,
        "engine": {"mode": "hosted", "provider": "anthropic",
                   "model": "claude-haiku-4-5"},
        "surface": "reaction",
        "use_engine": True,
        "explain": explain,
    }).encode()
    req = urllib.request.Request(BASE + "/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    deltas: list[str] = []
    events: list[dict] = []
    with urllib.request.urlopen(req, timeout=180) as response:
        for raw in response:
            line = raw.decode(errors="replace").strip()
            if not line.startswith("data: "):
                continue
            payload = line[6:]
            if payload == "[DONE]":
                break
            try:
                event = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if "delta" in event:
                deltas.append(event["delta"])
            if "tool_event" in event:
                events.append(event["tool_event"])
    return deltas, events


if not backend_up():
    print("SKIP  backend not listening on :8000 — start uvicorn and re-run")
    sys.exit(0)

REACTION = "react ethanol with thionyl chloride"

# 1. Deferred: the engine result arrives, the prose does not.
deltas, events = chat(REACTION, explain=False)
check("explain=false still emits the reaction card",
      any(e.get("type") == "reaction_result" for e in events),
      f"events={[e.get('type') for e in events]}")
check("explain=false emits no explanation text",
      deltas == [], f"got {len(deltas)} deltas: {''.join(deltas)[:200]!r}")

# 2. The button's request: same turn, prose restored. Guards the deferral from
#    becoming a permanent mute.
deltas, events = chat(REACTION, explain=True)
check("explain=true still emits the reaction card",
      any(e.get("type") == "reaction_result" for e in events),
      f"events={[e.get('type') for e in events]}")
check("explain=true emits explanation text",
      len("".join(deltas).strip()) > 0, f"got {len(deltas)} deltas")

# 3. A conceptual question calls no tool, so nothing was deferred — the user
#    asked and must be answered even with explain=false.
deltas, events = chat(
    "In one sentence, what does the term 'kinetic control' mean?", explain=False)
check("explain=false still answers a question that ran no tool",
      len("".join(deltas).strip()) > 0,
      f"got {len(deltas)} deltas, events={[e.get('type') for e in events]}")

print()
print(f"{passes} passed, {len(failures)} failed")
if failures:
    for f in failures:
        print(f"  FAILED: {f}")
    sys.exit(1)
