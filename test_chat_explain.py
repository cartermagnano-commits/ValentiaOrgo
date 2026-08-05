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

import base64
import io
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


def chat(text: str, explain: bool, attachments: list[dict] | None = None,
         timeout: int = 180) -> tuple[list[str], list[dict]]:
    """POST /chat on the reaction surface. Returns (text deltas, tool events).

    `attachments` matches the `ChatAttachment` wire shape the backend parses
    in app.py (`ChatMessage.attachments` -> `entry["images"]` in the /chat
    handler): {"kind": "image", "media_type": "...", "data": "<base64>",
    "name": "..."}.
    """
    message: dict = {"role": "user", "content": text}
    if attachments:
        message["attachments"] = attachments
    body = json.dumps({
        "messages": [message],
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
    with urllib.request.urlopen(req, timeout=timeout) as response:
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

# 4. The image-bearing deferred path (_image_reaction_then_explain), which the
#    tool-loop cases above never touch (they carry no attachments, so
#    has_images is always False in the /chat dispatch). This one is slow —
#    OSR runs synchronously inside the request and can take 30-60s in this
#    environment (MolScribe is not installed; Ollama vision fallback is
#    unreachable), so DECIMER alone must read the image. Generated at test
#    time with RDKit rather than committing a binary fixture.
try:
    from rdkit import Chem
    from rdkit.Chem import Draw
except ImportError:
    print("SKIP  image-bearing deferred turn — rdkit not importable")
else:
    mol1 = Chem.MolFromSmiles("CCO")
    mol2 = Chem.MolFromSmiles("O=S(Cl)Cl")
    grid = Draw.MolsToGridImage([mol1, mol2], molsPerRow=2,
                                subImgSize=(300, 300), useSVG=False)
    buf = io.BytesIO()
    grid.save(buf, format="PNG")
    image_b64 = base64.b64encode(buf.getvalue()).decode()

    attachments = [{"kind": "image", "media_type": "image/png",
                    "data": image_b64, "name": "rxn.png"}]
    deltas, events = chat("What reaction is shown in this image?", explain=False,
                          attachments=attachments, timeout=240)
    if any(e.get("type") == "reaction_result" for e in events):
        # OSR read both components: this is the deferred contract, same as
        # the tool-loop path — card only, no prose.
        check("explain=false image turn emits no explanation text when OSR succeeds",
              deltas == [], f"got {len(deltas)} deltas: {''.join(deltas)[:200]!r}")
    else:
        # OSR is degraded on this machine and didn't recognize a reaction in
        # the synthetic image — _image_reaction_then_explain correctly falls
        # through to a normal streamed answer in that case, so deltas ARE
        # expected. Nothing to assert; this case just didn't exercise the
        # deferral.
        print("SKIP  image-bearing deferred turn — OSR produced no reaction_result "
              f"on this machine (events={[e.get('type') for e in events]}, "
              f"{len(deltas)} deltas)")

print()
print(f"{passes} passed, {len(failures)} failed")
if failures:
    for f in failures:
        print(f"  FAILED: {f}")
    sys.exit(1)
