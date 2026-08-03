# On-Demand Reaction Explanations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop auto-generating an LLM explanation for every reaction; show the product only and put the explanation behind an **Explanation** button on both the Reaction tab and the Synthesis InfoPanel.

**Architecture:** The Reaction tab is a chat — its explanation is the model's post-tool text round, so suppressing it needs a backend flag (`explain`) that stops the tool loop after emitting the engine result. The button then re-runs the identical `/chat` turn with `explain: true`, so the text you get is the text you get today, just deferred. The Synthesis InfoPanel is simpler: delete the `useEffect` that auto-fires `/explain` and gate it behind a button, mirroring the "Analyze stereochemistry" button already sitting directly below it.

**Tech Stack:** FastAPI + Anthropic SDK (streaming tool loop) on the backend; Next.js App Router + TypeScript (`ChatPanel.tsx`) and JSX (`InfoPanel.jsx`) on the frontend. Plain-script Python tests, no pytest. No frontend test framework.

**Spec:** `docs/superpowers/specs/2026-08-02-on-demand-explanations-design.md`

## Global Constraints

- **The LLM never does chemistry.** This change only moves *when* the LLM explains. It must not alter what `_react_core`, `resolve_products`, or the template engine return.
- **`reactivity_engine.py` and `preprocessing.py` are off-limits** — README marks them "do not modify." No task here touches them.
- **Run exactly one uvicorn worker.** Restart with `python3 -m uvicorn app:app --host 127.0.0.1 --port 8000` from the repo root.
- **No pytest.** Tests are plain scripts run as `python3 test_<name>.py`, printing one `PASS`/`FAIL` line per case and exiting non-zero on failure.
- **`explain: false` is sent only from the Reaction tab** (`surface === 'reaction'`). The general Chat tab and the Synthesis assistant drawer keep answering immediately.
- **Absolute paths in the shell.** The working directory drifts between the repo root and `frontend/`; every command below is written to be run from the repo root `/Users/cartermagnano/Dev/Orgo-AI-1`.
- The frontend runs as a **production build** (`npx next start -p 3000`), not `next dev` — per `.claude/skills/verify`, `next dev` launched from this shell serves pages that never hydrate. After any frontend change you must `npm run build` then restart, and **hard-reload the browser tab** (a tab holding older JS is what caused the phantom `POST /react` calls seen earlier).

---

### Task 1: Backend — `explain` flag stops the tool loop before the explanation round

**Files:**
- Modify: `app.py` — `ChatRequest` (~line 2628), `_stream_anthropic_tools` (~line 1237), `_image_reaction_then_explain` (~line 2663), `/chat` dispatch (~line 2755)
- Create: `test_chat_explain.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ChatRequest.explain: bool = True`, honored by `POST /chat`. When `false`, a turn whose model round calls a tool emits only `tool_event` frames (no `delta` frames) and then `data: [DONE]`. When `false` and the round calls **no** tool, the text streams normally.

- [ ] **Step 1: Write the failing test**

Create `test_chat_explain.py`:

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd /Users/cartermagnano/Dev/Orgo-AI-1 && python3 test_chat_explain.py
```
Expected: with the backend running, `FAIL  explain=false emits no explanation text` (the unknown `explain` field is ignored by Pydantic's default config, so the server still streams prose). The other cases pass. If it prints `SKIP`, start uvicorn first.

- [ ] **Step 3: Add the `explain` field to `ChatRequest`**

In `app.py`, in `class ChatRequest`, after the `use_engine: bool = True` line:

```python
    # False = the client wants only the engine result this turn; the model's
    # prose is deferred until the user asks for it. The Reaction tab's
    # Explanation button re-sends the same turn with explain=True.
    explain: bool = True
```

- [ ] **Step 4: Suppress the explanation round in `_stream_anthropic_tools`**

Change the signature:

```python
async def _stream_anthropic_tools(system: str, messages: list[dict], max_tokens: int,
                                  surface: str, model: str | None = None,
                                  explain: bool = True):
```

Inside the `for round_index in range(_CHAT_TOOL_ROUNDS):` loop, replace the streaming block and the `tool_uses` handling. The existing code is:

```python
        async with client.messages.stream(
            model=model or DEFAULT_ANTHROPIC_MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=convo,
            tools=tools,
        ) as stream:
            async for text in stream.text_stream:
                yield f"data: {json.dumps({'delta': text})}\n\n"
            final = await stream.get_final_message()

        tool_uses = [b for b in final.content if getattr(b, "type", None) == "tool_use"]
        # Round cap reached: stop executing tools; the text streamed so far
        # stands as the answer.
        if not tool_uses or round_index == _CHAT_TOOL_ROUNDS - 1:
            break
```

Replace it with:

```python
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
```

Leave the rest of the loop (appending `convo` entries and executing tools for the explaining path) exactly as it is.

- [ ] **Step 5: Suppress the explanation stream for image-bearing turns**

In `app.py`, change `_image_reaction_then_explain`'s signature:

```python
async def _image_reaction_then_explain(system: str, messages: list[dict],
                                       engine: Optional[EngineConfig],
                                       explain: bool = True):
```

Then inside it, immediately after the existing `yield` of the `reaction_result` frame and before `ground = _reaction_ground_text(result)`, insert:

```python
            if not explain:
                # Card only. The Explanation button re-runs this turn.
                return
```

- [ ] **Step 6: Pass the flag through the `/chat` dispatch**

In the `chat` endpoint, update both engine branches:

```python
        stream = _with_error_frames(_stream_anthropic_tools(
            system_prompt + _CHAT_TOOLS_SYSTEM, messages, 800,
            req.surface, model=req.engine.model if req.engine else None,
            explain=req.explain,
        ))
    elif surface_runs_reactions and has_images:
        # Image chats bypass the native tool path — run the engine on the image
        # ourselves so the reaction still surfaces (banner/card + grounding).
        stream = _with_error_frames(
            _image_reaction_then_explain(system_prompt, messages, req.engine,
                                         explain=req.explain))
```

- [ ] **Step 7: Restart the backend and run the test**

Run:
```bash
cd /Users/cartermagnano/Dev/Orgo-AI-1 && kill $(lsof -tiTCP:8000 -sTCP:LISTEN) 2>/dev/null; sleep 2
cd /Users/cartermagnano/Dev/Orgo-AI-1 && nohup python3 -m uvicorn app:app --host 127.0.0.1 --port 8000 > /tmp/orgo-backend.log 2>&1 &
sleep 8 && cd /Users/cartermagnano/Dev/Orgo-AI-1 && python3 test_chat_explain.py
```
Expected: `5 passed, 0 failed`.

- [ ] **Step 8: Confirm nothing else regressed**

Run:
```bash
cd /Users/cartermagnano/Dev/Orgo-AI-1 && python3 test_prediction.py 2>&1 | tail -2 && python3 test_askcos.py 2>&1 | tail -2
```
Expected: `43 passed, 0 failed` and `40 passed, 0 failed`.

- [ ] **Step 9: Commit**

```bash
cd /Users/cartermagnano/Dev/Orgo-AI-1 && git add app.py test_chat_explain.py && git commit -m "$(cat <<'EOF'
Defer chat explanations behind an explain flag

/chat gains explain: bool = True. When false, a turn whose model round
calls a tool emits only its tool_event frames and stops before the
explanation round. A turn that calls no tool still answers — the text is
buffered rather than dropped, because the model writes preamble before
its tool call and streaming live would leak it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Frontend — the Reaction tab stops asking for prose

**Files:**
- Modify: `frontend/src/api.js:160-171` (`streamChat`)
- Modify: `frontend/src/platform/ChatPanel.tsx` — `toApiMessages` (~line 90), `streamReply` (~line 330)

**Interfaces:**
- Consumes: `ChatRequest.explain` from Task 1.
- Produces: `streamChat(messages, context, onDelta, model, surface, onToolEvent, useEngine, explain)`; `streamReply(history, seedToolResults, contextOverride, explain, targetId)` in `ChatPanel`. `targetId` is unused until Task 3 but is added here so `streamReply` is only rewritten once.

- [ ] **Step 1: Add the `explain` argument to `streamChat`**

In `frontend/src/api.js`, replace the `streamChat` function:

```js
// useEngine=false asks the backend to skip the deterministic engine for this
// turn: no app tools, and no OSR/template run on an attached image.
// explain=false asks it to stop after the engine result — the Reaction tab
// shows the product first and generates prose only when asked.
export async function streamChat(messages, context, onDelta, model = null,
                                 surface = null, onToolEvent = null,
                                 useEngine = true, explain = true) {
  return streamSSE(
    '/chat',
    { messages, context, engine: getEnginePayload(model), surface,
      use_engine: useEngine, explain },
    onDelta,
    onToolEvent,
  )
}
```

- [ ] **Step 2: Drop empty assistant messages from the replayed history**

In `frontend/src/platform/ChatPanel.tsx`, replace the `toApiMessages` filter:

```tsx
function toApiMessages(history: ChatMessage[]) {
  const live = history.filter(
    // Failed-request bubbles are UI state, not conversation — don't replay
    // them to the model as if it had said "Error: ..." itself. A deferred
    // reaction bubble carries only its engine card, and an assistant message
    // with empty content is rejected outright by the API.
    message => !(message.role === 'assistant'
      && (message.content.startsWith('Error:') || !message.content.trim())),
  )
```

Leave the rest of the function unchanged.

- [ ] **Step 3: Teach `streamReply` about `explain` and `targetId`**

Replace the head of `streamReply` — its signature, `assistantId`, and `withReply` — with:

```tsx
  async function streamReply(
    history: ChatMessage[],
    seedToolResults: ChatToolResult[] = [],
    contextOverride?: Record<string, unknown> | null,
    // The Reaction tab shows the product first: its turns ask the backend to
    // stop after the engine result. Every other surface answers immediately.
    explain: boolean = surface !== 'reaction',
    // When set, the streamed text fills THIS existing message instead of
    // appending a new one — the Explanation button filling in a bubble that
    // already holds its engine card, without disturbing anything after it.
    targetId?: string,
  ) {
    const assistantId = targetId ?? `msg_${Date.now()}_reply`
    const toolResults: ChatToolResult[] = [...seedToolResults]
    const withReply = (replyText: string): ChatContent => (
      targetId
        ? {
            ...data,
            messages: messages.map(message => (
              message.id === targetId ? { ...message, content: replyText } : message
            )),
          }
        : {
            ...data,
            messages: [
              ...history,
              {
                id: assistantId,
                role: 'assistant',
                content: replyText,
                createdAt: new Date().toISOString(),
                ...(toolResults.length ? { toolResults: [...toolResults] } : {}),
              },
            ],
          }
    )
```

- [ ] **Step 4: Pass `explain` to `streamChat`**

Still in `streamReply`, the `await streamChat(...)` call currently ends with:

```tsx
        useEngine,
      )
```

Change it to:

```tsx
        useEngine,
        explain,
      )
```

- [ ] **Step 5: Build and restart the frontend**

Run:
```bash
cd /Users/cartermagnano/Dev/Orgo-AI-1/frontend && kill $(lsof -tiTCP:3000 -sTCP:LISTEN) 2>/dev/null; npm run build 2>&1 | tail -5
cd /Users/cartermagnano/Dev/Orgo-AI-1/frontend && nohup npx next start -p 3000 > /tmp/orgo-frontend.log 2>&1 &
sleep 5 && curl -s -o /dev/null -w "frontend %{http_code}\n" http://127.0.0.1:3000/
```
Expected: build succeeds with no TypeScript errors, then `frontend 200`.

- [ ] **Step 6: Verify by hand**

Open http://localhost:3000, **hard-reload** (Cmd+Shift+R), open the Reaction tool and send `react ethanol with thionyl chloride`.

Expected: the reaction banner and the product card appear; **no prose** follows. The bubble looks unfinished — that is correct at this point; the button arrives in Task 3.

Then send `In one sentence, what does 'kinetic control' mean?` in the same thread. Expected: a normal text answer (it runs no tool, so nothing is deferred).

- [ ] **Step 7: Commit**

```bash
cd /Users/cartermagnano/Dev/Orgo-AI-1 && git add frontend/src/api.js frontend/src/platform/ChatPanel.tsx && git commit -m "$(cat <<'EOF'
Reaction tab requests the product without the explanation

Sends explain: false on the reaction surface only. streamReply gains a
targetId so a later Explanation press can fill an existing bubble in
place instead of appending, and toApiMessages now drops empty-content
assistant messages, which the API rejects.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Frontend — the Explanation button

**Files:**
- Modify: `frontend/src/platform/ChatPanel.tsx` — imports (line 4), helpers near `streamReply`, the message-rendering block (~line 490)
- Modify: `frontend/src/App.css` — new rule after `.chat-tool-miss` (~line 4762)

**Interfaces:**
- Consumes: `streamReply(history, seedToolResults, contextOverride, explain, targetId)` from Task 2.
- Produces: `canExplain(message: ChatMessage): boolean` and `explainMessage(message: ChatMessage): Promise<void>` inside `ChatPanel`; CSS class `.chat-explain-btn`.

- [ ] **Step 1: Import the icon**

In `frontend/src/platform/ChatPanel.tsx`, replace the lucide import:

```tsx
import { Camera, FileText, FlaskConical, Network, Paperclip, Sparkles, X, Zap } from 'lucide-react'
```

- [ ] **Step 2: Add the two helpers**

Insert directly **above** `async function streamReply(` in `ChatPanel`:

```tsx
  // A deferred reaction: the engine card is already in the bubble but no prose
  // has been generated for it. The same condition hides the button once prose
  // exists, so a reopened session shows what it already paid for and nothing else.
  function canExplain(message: ChatMessage): boolean {
    return message.role === 'assistant'
      && !message.content.trim()
      && Boolean(message.toolResults?.some(result => result.type === 'reaction_result'))
  }

  // Re-run the turn that produced this bubble, this time asking for the prose.
  // The bubble itself is excluded from the replayed history — it is the message
  // being filled in, and an empty assistant message is rejected by the API —
  // while `targetId` keeps everything after it untouched.
  async function explainMessage(message: ChatMessage) {
    if (streaming || saving) return
    const index = messages.findIndex(entry => entry.id === message.id)
    if (index < 0) return
    await streamReply(messages.slice(0, index), message.toolResults ?? [],
                      undefined, true, message.id)
  }
```

- [ ] **Step 3: Render the button**

In the message-rendering block, the current lines are:

```tsx
            {message.toolResults?.length ? <ToolResultCards results={message.toolResults} /> : null}
            {message.content}
```

Replace them with:

```tsx
            {message.toolResults?.length ? <ToolResultCards results={message.toolResults} /> : null}
            {message.content}
            {canExplain(message) && (
              <button
                type="button"
                className="chat-explain-btn"
                onClick={() => void explainMessage(message)}
                disabled={streaming || saving}
              >
                <Sparkles size={13} />
                Explanation
              </button>
            )}
```

- [ ] **Step 4: Style the button**

In `frontend/src/App.css`, immediately after the `.chat-tool-miss { ... }` rule, add:

```css
/* Deferred explanation: the product is the answer, prose is opt-in. */
.chat-explain-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
}

.chat-explain-btn:hover:not(:disabled) { background: var(--card); }
.chat-explain-btn:disabled { opacity: 0.5; cursor: default; }
```

- [ ] **Step 5: Build and restart the frontend**

Run:
```bash
cd /Users/cartermagnano/Dev/Orgo-AI-1/frontend && kill $(lsof -tiTCP:3000 -sTCP:LISTEN) 2>/dev/null; npm run build 2>&1 | tail -5
cd /Users/cartermagnano/Dev/Orgo-AI-1/frontend && nohup npx next start -p 3000 > /tmp/orgo-frontend.log 2>&1 &
sleep 5 && curl -s -o /dev/null -w "frontend %{http_code}\n" http://127.0.0.1:3000/
```
Expected: build succeeds, `frontend 200`.

- [ ] **Step 6: Verify by hand**

Hard-reload http://localhost:3000, open the Reaction tool, send `react ethanol with thionyl chloride`.

Expected, in order:
1. Card + banner appear, no prose, an **Explanation** button below the card.
2. Press it — prose streams into the same bubble and the button disappears as content arrives. Note it re-runs the engine, so expect roughly the same wait as the original request.
3. Reload the page (the thread is in localStorage). The explanation is still there and the button does not come back.
4. Send a second reaction, leave it unexplained, then send a third message. The second bubble keeps its button and pressing it does **not** delete the third message.

Now the case the button exists for. Send `react benzaldehyde with methylmagnesium bromide` — no template names this one (it logs `TEMPLATE_GAP endpoint=react_unnamed`), so the card reads `Predicted (unnamed)`. Expected: the **Explanation** button still appears, and pressing it still produces prose. This is the case `/explain` could not have served, which is why the button re-runs the chat turn.

Finally, confirm the surfaces this change must **not** touch. Open the **Chat** tool and send `react ethanol with thionyl chloride`: it should show the card **and** stream prose immediately, with no button. Then open **Synthesis**, expand the **Assistant** drawer, and ask it to run a reaction: same — immediate prose, no button. Only `surface === 'reaction'` defers.

- [ ] **Step 7: Commit**

```bash
cd /Users/cartermagnano/Dev/Orgo-AI-1 && git add frontend/src/platform/ChatPanel.tsx frontend/src/App.css && git commit -m "$(cat <<'EOF'
Add the Explanation button to deferred reaction bubbles

Shows on an assistant bubble that holds a reaction card and no prose;
pressing it re-runs the turn with explain: true and fills that bubble in
place. Content persists to localStorage, so the button is gone on reopen.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Frontend — photographed reactions defer too

**Files:**
- Modify: `frontend/src/platform/ChatPanel.tsx` — `handleReactionPhoto` (~line 406-445)

**Interfaces:**
- Consumes: `canExplain` / the button from Task 3 (the posted bubble matches its condition, so no new UI is needed).
- Produces: nothing new.

- [ ] **Step 1: Stop auto-explaining the photo**

In `handleReactionPhoto`, the `try` block currently reads:

```tsx
      const result = await reactFromImage(file)
      if (result.error) throw new Error(result.error)
      const reactionContext = reactionContextFrom(result)
      lastReactionRef.current = reactionContext
      setLatestReaction(result)
      setPhotoReading(false)
      await streamReply(history, [{ type: 'reaction_result', data: result }], reactionContext)
```

Replace it with:

```tsx
      const result = await reactFromImage(file)
      if (result.error) throw new Error(result.error)
      // Still recorded as grounding for follow-up questions — we're deferring
      // the explanation, not forgetting the reaction.
      lastReactionRef.current = reactionContextFrom(result)
      setLatestReaction(result)
      setPhotoReading(false)
      // Post the engine result as its own bubble with no prose. It matches
      // canExplain(), so the Explanation button appears on it automatically.
      const explained: ChatContent = {
        ...data,
        messages: [...history, {
          id: `msg_${Date.now()}_reply`,
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString(),
          toolResults: [{ type: 'reaction_result', data: result }],
        }],
      }
      onChange(explained)
      await onSave(explained)
```

Leave the `catch` and `finally` blocks exactly as they are.

- [ ] **Step 2: Build and restart the frontend**

Run:
```bash
cd /Users/cartermagnano/Dev/Orgo-AI-1/frontend && kill $(lsof -tiTCP:3000 -sTCP:LISTEN) 2>/dev/null; npm run build 2>&1 | tail -5
cd /Users/cartermagnano/Dev/Orgo-AI-1/frontend && nohup npx next start -p 3000 > /tmp/orgo-frontend.log 2>&1 &
sleep 5 && curl -s -o /dev/null -w "frontend %{http_code}\n" http://127.0.0.1:3000/
```
Expected: build succeeds, `frontend 200`.

- [ ] **Step 3: Verify by hand**

Generate a reaction image and photograph-test it:

```bash
cd /Users/cartermagnano/Dev/Orgo-AI-1 && python3 -c "
from rdkit import Chem
from rdkit.Chem import Draw
Draw.MolToFile(Chem.MolFromSmiles('CCO'), '/tmp/rxn.png', size=(600,600))
print('wrote /tmp/rxn.png')
"
```

Hard-reload the Reaction tool, press the camera button, pick `/tmp/rxn.png`.

Expected: after the OSR read (~30s; the spinner says so) the reaction card appears with an **Explanation** button and no prose. Pressing the button streams the explanation into that bubble.

Note: on this machine MolScribe is not installed and Ollama is not running, so the OSR read is unarbitrated — a wrong structure read is an environment limitation, not a regression from this task. What you are checking is that no prose is generated, not that the molecule is right.

- [ ] **Step 4: Commit**

```bash
cd /Users/cartermagnano/Dev/Orgo-AI-1 && git add frontend/src/platform/ChatPanel.tsx && git commit -m "$(cat <<'EOF'
Photographed reactions post the card without prose

handleReactionPhoto no longer chains a streamReply. The posted bubble
matches canExplain(), so the Explanation button covers it with no extra
UI. The reaction is still recorded as grounding for follow-ups.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Synthesis InfoPanel — branch view button

**Files:**
- Modify: `frontend/src/components/InfoPanel.jsx` — imports (line 4), `BranchInfoView` (lines 141-176 and the render block at 234-252)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on. Task 6 repeats this shape for `NodeInfoView`.

- [ ] **Step 1: Add the icon import**

In `frontend/src/components/InfoPanel.jsx`, replace the lucide import:

```jsx
import { CheckCircle2, Microscope, Atom, Sparkles } from 'lucide-react'
```

- [ ] **Step 2: Replace the auto-firing effect with a reset effect and a click handler**

In `BranchInfoView`, replace everything from `const [explanation, setExplanation] = useState(...)` down to the closing brace of the `useEffect` (lines 142-164) with:

```jsx
  const [explanation, setExplanation] = useState({ text: '', loading: false, error: null, requested: false })
  const [stereo, setStereo] = useState({ text: '', loading: false, error: null, requested: false })
  // Bumped whenever the branch changes so an in-flight stream from the previous
  // branch can't write into the freshly-reset state. Both explanations are
  // user-triggered now, so neither can rely on an effect's cleanup closure.
  const stereoSeq = useRef(0)
  const explainSeq = useRef(0)

  useEffect(() => {
    if (!branch) return
    explainSeq.current++
    stereoSeq.current++
    setExplanation({ text: '', loading: false, error: null, requested: false })
    setStereo({ text: '', loading: false, error: null, requested: false })
  }, [branch?.id, substrateSMILES])

  function explain() {
    const seq = explainSeq.current
    setExplanation({ text: '', loading: true, error: null, requested: true })
    streamExplanation(branch, substrateSMILES, delta => {
      if (explainSeq.current === seq) setExplanation(prev => ({ ...prev, text: prev.text + delta, loading: false }))
    })
      .then(() => { if (explainSeq.current === seq) setExplanation(prev => prev.loading
        ? { text: '', loading: false, error: 'The AI engine returned no response. Check Settings → Engine.', requested: true }
        : prev) })
      .catch(e => { if (explainSeq.current === seq) setExplanation({ text: '', loading: false, error: e.message, requested: true }) })
  }
```

Leave `analyzeStereo` and everything below it unchanged.

- [ ] **Step 3: Gate the explanation box behind the button**

In `BranchInfoView`'s render, replace the whole "Mechanism explanation" block:

```jsx
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="panel-header" style={{ padding: '0 0 6px', border: 'none' }}>
          Mechanism explanation
          <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6, fontSize: 10 }}>(AI)</span>
        </div>
        {!explanation.requested ? (
          <button
            className="btn-secondary"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '7px 0' }}
            onClick={explain}
          >
            <Sparkles size={14} />
            Explanation
          </button>
        ) : (
          <div className="explanation-box">
            {explanation.loading ? (
              <div className="loading-row">
                <div className="spinner" /> Generating explanation…
              </div>
            ) : explanation.error ? (
              <span style={{ color: 'var(--danger)', fontSize: 12 }}>{explanation.error}</span>
            ) : (
              explanation.text
            )}
          </div>
        )}
      </div>
```

- [ ] **Step 4: Build and restart the frontend**

Run:
```bash
cd /Users/cartermagnano/Dev/Orgo-AI-1/frontend && kill $(lsof -tiTCP:3000 -sTCP:LISTEN) 2>/dev/null; npm run build 2>&1 | tail -5
cd /Users/cartermagnano/Dev/Orgo-AI-1/frontend && nohup npx next start -p 3000 > /tmp/orgo-frontend.log 2>&1 &
sleep 5 && curl -s -o /dev/null -w "frontend %{http_code}\n" http://127.0.0.1:3000/
```
Expected: build succeeds, `frontend 200`.

- [ ] **Step 5: Verify by hand**

Hard-reload, open the **Synthesis** tool, set a starting material (e.g. `CCO`), run pathways, and click a pathway in the sidebar.

Expected: the panel shows Reaction / Reagent / Control / Steps / Product and an **Explanation** button — no text generated on its own. Press it: the spinner appears, then the explanation streams in. "Analyze stereochemistry" below still behaves as before.

Then press **Explanation** and, while it is still streaming, click a *different* pathway. Expected: the new panel shows a clean **Explanation** button, and no text from the abandoned stream ever appears in it.

- [ ] **Step 6: Commit**

```bash
cd /Users/cartermagnano/Dev/Orgo-AI-1 && git add frontend/src/components/InfoPanel.jsx && git commit -m "$(cat <<'EOF'
Branch mechanism explanation is opt-in

Selecting a pathway no longer fires /explain on mount. The effect now
only resets state; a seq ref guards the click-started stream against a
selection change, matching the stereochemistry button beside it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Synthesis InfoPanel — node view button

**Files:**
- Modify: `frontend/src/components/InfoPanel.jsx` — `NodeInfoView` (lines 14-32 and its render block at 114-132)

**Interfaces:**
- Consumes: the `Sparkles` import added in Task 5.
- Produces: nothing.

- [ ] **Step 1: Replace the auto-firing effect with a reset effect and a click handler**

In `NodeInfoView`, replace lines 15-32 (the `useState` and the whole `useEffect`) with:

```jsx
  const [explanation, setExplanation] = useState({ text: '', loading: false, error: null, requested: false })
  // Switching nodes mid-stream must silence the old stream, or its deltas
  // interleave into the new explanation (and its completion handler can stamp a
  // bogus error over the new stream's pending state). The stream starts from a
  // click now, so the guard is a ref rather than an effect-cleanup closure.
  const explainSeq = useRef(0)

  useEffect(() => {
    explainSeq.current++
    setExplanation({ text: '', loading: false, error: null, requested: false })
  }, [nodeData?.smiles, nodeData?.nodeType, branch?.id, substrateSMILES])

  function explain() {
    if (!nodeData || !branch) return
    const seq = explainSeq.current
    setExplanation({ text: '', loading: true, error: null, requested: true })
    streamNodeExplanation(nodeData, branch, substrateSMILES, delta => {
      if (explainSeq.current === seq) setExplanation(prev => ({ ...prev, text: prev.text + delta, loading: false }))
    })
      .then(() => { if (explainSeq.current === seq) setExplanation(prev => prev.loading
        ? { text: '', loading: false, error: 'The AI engine returned no response. Check Settings → Engine.', requested: true }
        : prev) })
      .catch(e => { if (explainSeq.current === seq) setExplanation({ text: '', loading: false, error: e.message, requested: true }) })
  }
```

- [ ] **Step 2: Gate the node explanation box behind the button**

In `NodeInfoView`'s render, replace the whole "Step explanation" block (the `{/* LLM explanation */}` section, lines 114-132) with:

```jsx
      {/* LLM explanation — opt-in, so a node click costs nothing until asked. */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="panel-header" style={{ padding: '0 0 6px', border: 'none' }}>
          Step explanation
          <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6, fontSize: 10 }}>(AI)</span>
        </div>
        {!explanation.requested ? (
          <button
            className="btn-secondary"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '7px 0', width: '100%' }}
            onClick={explain}
          >
            <Sparkles size={14} />
            Explanation
          </button>
        ) : (
          <div className="explanation-box">
            {explanation.loading ? (
              <div className="loading-row">
                <div className="spinner" /> Generating explanation…
              </div>
            ) : explanation.error ? (
              <span style={{ color: 'var(--danger)', fontSize: 12 }}>{explanation.error}</span>
            ) : (
              explanation.text
            )}
          </div>
        )}
      </div>
```

Note: this drops the `explanation-placeholder` branch ("Explanation will appear here."). The button now occupies that state, so the placeholder has nothing left to say.

- [ ] **Step 3: Build and restart the frontend**

Run:
```bash
cd /Users/cartermagnano/Dev/Orgo-AI-1/frontend && kill $(lsof -tiTCP:3000 -sTCP:LISTEN) 2>/dev/null; npm run build 2>&1 | tail -5
cd /Users/cartermagnano/Dev/Orgo-AI-1/frontend && nohup npx next start -p 3000 > /tmp/orgo-frontend.log 2>&1 &
sleep 5 && curl -s -o /dev/null -w "frontend %{http_code}\n" http://127.0.0.1:3000/
```
Expected: build succeeds, `frontend 200`.

- [ ] **Step 4: Verify by hand**

Hard-reload, open Synthesis, run pathways, then click a **node in the graph** (not a sidebar pathway).

Expected: the node panel shows its role, structure and step text with an **Explanation** button and no generated text. Press it and the explanation streams. Click a different node mid-stream: clean button, no bleed-through.

- [ ] **Step 5: Run every suite once more**

Run:
```bash
cd /Users/cartermagnano/Dev/Orgo-AI-1 && python3 test_prediction.py 2>&1 | tail -2 && python3 test_templates.py 2>&1 | tail -2 && python3 test_askcos.py 2>&1 | tail -2 && python3 test_chat_explain.py 2>&1 | tail -2
```
Expected: `43 passed`, `62 passed`, `40 passed`, `5 passed` — zero failures.

- [ ] **Step 6: Commit**

```bash
cd /Users/cartermagnano/Dev/Orgo-AI-1 && git add frontend/src/components/InfoPanel.jsx && git commit -m "$(cat <<'EOF'
Node step explanation is opt-in

Clicking a node no longer fires /explain on mount, matching the branch
view. Same seq-ref guard against a selection change mid-stream.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Notes for the implementer

**Known cost of the Explanation button on the Reaction tab.** Pressing it re-runs the whole turn, which means the engine runs a second time (~3.4s of ASKCOS). This is deliberate and specified: it keeps one code path for "explain a reaction" and it is the only variant that still produces prose when no template matched, which is exactly when the labeled AI guess *is* the answer. If that second engine call later proves worth removing, the fix is to feed the stored `reaction_result` back as a tool result rather than to fork the explanation logic.

**Do not "simplify" the buffering in Task 1.** It looks like it could just stream deltas and let the frontend ignore them. It cannot: the tokens would still be generated and paid for, and the model demonstrably writes preamble text before its tool call on this stack (measured: first text at 4.4s, tool call at 9.4s).

**Environment on this machine.** MolScribe is not installed and Ollama is not running, so OSR reads are unarbitrated. That affects only Task 4's photo path, and only the *accuracy* of the structure read — not whether prose is deferred.
