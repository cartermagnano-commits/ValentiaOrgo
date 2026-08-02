# Direct mode — a composer toggle that bypasses the deterministic engine

**Date:** 2026-08-02
**Status:** approved, ready for implementation planning

## Problem

Every chat surface in Orgo AI routes through the deterministic RDKit engine: the
assistant calls `run_reaction` / `set_stockroom` / `run_pathways` mid-conversation,
and attached reaction photos are read by OSR and run through the template engine
before Claude ever sees them. That is the product's core claim, and it stays the
default.

But when no template matches, or when the user just wants Claude's own answer to an
organic chemistry question, there is no way to ask for one. Direct mode adds a
composer-level toggle that skips the engine entirely and sends the question to
Claude as an ordinary API call.

This is an **escape hatch, not a migration**. The engine remains the default and the
primary path. The toggle is expected to be short-lived and must be cheap to remove.

## Decisions

| Question | Decision |
|---|---|
| Role vs. engine | Escape hatch alongside the engine; engine stays default |
| Placement | Composer pill next to the model picker, on **all three** surfaces — Chat, Reaction, and the Synthesis assistant drawer |
| Backend behavior | No engine tools, **unchanged** tutor system prompt, context block still sent |
| Images | Direct mode bypasses OSR too — photos go straight to Claude vision |
| Per-message labeling | None. The composer pill is the only indicator |
| Wire mechanism | Send `surface: null` — no backend change |

## Architecture

### The mechanism

`surface` is already the switch that controls everything Direct mode needs to turn
off. In `/chat` (`app.py:2707-2724`):

```python
surface_runs_reactions = bool(req.surface) and "run_reaction" in (_SURFACE_TOOLS.get(req.surface) or [])

if surface_runs_reactions and not has_images and mode == "hosted" and ANTHROPIC_API_KEY:
    stream = ..._stream_anthropic_tools(...)      # engine tools
elif surface_runs_reactions and has_images:
    stream = ..._image_reaction_then_explain(...) # OSR + engine on the photo
else:
    stream = _sse_stream(system_prompt, messages, 800, req.engine)
```

With `surface = null`, `surface_runs_reactions` is `False`, both engine branches are
skipped, and the request lands in the `else`. That branch:

- sends `system_prompt` — the unchanged tutor prompt, including the
  `--- Currently displayed reaction ---` context block when `context` is present;
- calls `_select_stream`, which at `app.py:629` detects image attachments and routes
  them to `_select_multimodal_stream`, i.e. Claude vision over the
  chat-completions route.

That is the full specification above, already implemented. **The backend does not
change.** No new Pydantic field, no new branch, no new prompt.

### Components

**`ChatPanel`** owns the toggle. It is the only component that changes behavior.

- New state: `const [direct, setDirect] = useState(false)`.
- New control: a pill button in the `.chat-input-row`, immediately left of the
  existing `.chat-model-select` (`ChatPanel.tsx:542`). Rendered on every surface —
  the button is unconditional, not gated on `surface`. It reads `Direct`, carries
  `aria-pressed={direct}`, and its `title` explains the mode: *"Answer directly with
  Claude — skips the verified reaction engine."* The `.is-on` state is what
  communicates that the mode is active; the label text does not change.
- The `streamChat` call at `ChatPanel.tsx:335` passes `direct ? null : surface`.
  Nothing else in the call changes.
- `handleReactionPhoto` (`ChatPanel.tsx:382`) gains an early branch: when `direct`
  is on, read the file with the existing `readImageAttachment` and push it onto
  `pending` — exactly what the paperclip does — instead of calling `reactFromImage`.
  The user then presses Send and the photo rides to Claude vision through `/chat`.

**`api.js`, `lib/engine.ts`, `Workspace.tsx`, `app.py`** — unchanged. `streamChat`
already takes `surface` as a parameter (`api.js:160`).

**`App.css`** — one new rule pair, `.chat-direct-toggle` and its `.is-on` state,
modeled on the adjacent `.chat-model-select` (`App.css:1738`) so the pill matches the
composer's existing height and radius, plus the `.claude-chat` override at
`App.css:3522`.

### Toggle state is per-mount, not persisted

The model picker persists to `localStorage` via `lib/engine.ts`; Direct mode
deliberately does not. Two reasons: a mode that silently disables the app's
verification layer should not survive a page reload unannounced, and a
non-persisted toggle is one less thing to delete when the feature is removed.

`ChatPanel` is keyed on session id in `Workspace.tsx`, so opening or creating a
session remounts it and the toggle returns to off. That is the intended behavior.

### Data flow

Direct off — unchanged from today:

```
composer → streamChat(..., surface='reaction') → POST /chat {surface:'reaction'}
         → _stream_anthropic_tools → run_reaction → engine → tool_event frames
         → ToolResultCards + ReactionBanner + onUiEvent
```

Direct on:

```
composer → streamChat(..., surface=null) → POST /chat {surface:null}
         → _sse_stream → _select_stream → Anthropic (or _select_multimodal_stream
           when images are attached)
         → text deltas only, no tool_event frames
```

### Consequences that follow from "no tools"

These are inherent to the chosen behavior, not defects:

- No `reaction_result` events, so no `ToolResultCards` on Direct replies and the
  Reaction tab's `ReactionBanner` keeps showing whatever the last engine run
  produced (or stays empty). The banner and camera button remain visible, because
  `showReactionBanner` and `enableReactionPhoto` read the `surface` **prop**, which
  Direct mode does not change — only the value handed to `streamChat` changes.
- In the Synthesis drawer, Direct mode cannot set the stockroom or run pathways;
  `onUiEvent` never fires. Asking it to "set my stockroom to benzene" produces prose.
- The `context` object is still sent in Direct mode, on every surface. The system
  prompt is unchanged, so the grounding block still applies; context describes what
  is on screen and is not itself an engine call.

### Error handling

Unchanged. The `else` branch is wrapped by `_with_error_frames` inside `_sse_stream`,
so provider failures arrive as SSE error frames and surface through the existing
`catch` in `streamReply` as an `Error: …` bubble. The
`if (!acc && !toolResults.length) throw` guard at `ChatPanel.tsx:349` still catches
empty responses — in Direct mode `toolResults` is always empty, so the guard reduces
to "no text came back", which is correct.

One case worth naming: on the Reaction tab with Direct on, `handleReactionPhoto` no
longer performs a network call, so its `reactFromImage` failure path and the
`photoReading` spinner ("Reading the reaction… this can take ~30 seconds") are not
reached. Attachment failures fall through to the existing `notify(...)` toast.

## Testing

There is no frontend test suite, and this change touches no Python, so
`test_templates.py`, `diagnose_templates.py`, and `test_osr.py` are unaffected —
they are not part of the verification for this work.

Verification is manual, against both servers running — `uvicorn app:app --port 8000
--reload` and `cd frontend && npm run dev` on this machine (`start.bat` is the
Windows launcher). The project's `verify` skill covers launching and driving the app:

1. **Engine still default.** Chat tab, Direct off, ask "react t-BuBr with NaOH" →
   an engine reaction tool card renders.
2. **Direct suppresses tools.** Same tab, Direct on, same prompt → prose answer, no
   tool card. DevTools Network shows `POST /chat` with `"surface": null`.
3. **Direct on Reaction + camera.** Reaction tab, Direct on, press the camera button
   and pick a reaction photo → it appears as an attachment chip rather than
   triggering the "Reading the reaction…" spinner. Send → Claude describes the image
   from vision; no banner update.
4. **Direct on Synthesis drawer.** Open the drawer, Direct on, "set my stockroom to
   benzene" → prose reply, stockroom unchanged, no remount.
5. **Toggle resets.** Turn Direct on, start a new chat → toggle is off. Reload the
   page → toggle is off.
6. **Off is fully reversible.** Turn Direct off mid-conversation and ask a reaction
   question → tool cards return in the same thread.

## Out of scope

Explicitly excluded, each a deliberate decision rather than an oversight:

- Per-message "unverified" badges in the transcript (declined — the composer pill is
  the only indicator).
- A Direct-specific system prompt, or a solver-style prompt.
- Server-side telemetry distinguishing Direct requests from ordinary Chat requests.
- A global Direct switch on the Settings page.
- Any change to `reactivity_engine.py`, `preprocessing.py`, `reaction_templates.json`,
  or `reagents.py`.

## Upgrade and removal paths

**If Direct mode survives and needs a server-side identity** — add
`direct: bool = False` to `ChatRequest` (`app.py:2597`), short-circuit to
`_sse_stream` ahead of the existing chain, and forward the flag from `streamChat`.
Roughly eight backend lines. Nothing written for this design is discarded.

**If Direct mode is removed** — delete the pill button, the `direct` state, the
`direct ? null : surface` ternary, the `handleReactionPhoto` early branch, and the
CSS rule. No backend, no schema, no stored data to migrate.
