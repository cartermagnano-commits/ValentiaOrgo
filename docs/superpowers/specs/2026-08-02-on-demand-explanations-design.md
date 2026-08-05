# On-demand reaction explanations

**Date:** 2026-08-02

## Problem

Every surface that shows a reaction currently generates an LLM explanation for it
whether or not anyone asked. The product is the answer; the prose is optional
commentary that costs a model call and buries the structure the user came for.

Two places do this today:

- **Reaction tab** (`ChatPanel`, `surface: 'reaction'`). Typing "react t-BuBr with
  NaOH" runs the `run_reaction` chat tool, emits a `reaction_result` frame that
  renders as a card and banner, and then the model always streams prose after it.
  The photo flow (`handleReactionPhoto`) does the same: OSR + engine, then an
  immediate `streamReply` to explain.
- **Synthesis → InfoPanel**. Selecting a branch or a node fires `/explain` from a
  `useEffect` on mount (`NodeInfoView` at InfoPanel.jsx:17-32, `BranchInfoView` at
  InfoPanel.jsx:148-164).

## Goal

Show the product only. Put the explanation behind an **Explanation** button that
generates it on demand.

Non-goal: changing what an explanation *says*. The text produced after pressing the
button must be the same text produced automatically today.

## Design

### 1. Reaction tab — defer the existing chat turn

Add `explain: bool = True` to `ChatRequest` in `app.py`. `ChatPanel` sends
`explain: false` when `surface === 'reaction'`, and only there.

In `_stream_anthropic_tools`, when `explain` is false:

- Buffer the round's text deltas instead of yielding them as `delta` frames.
- After the round completes, branch on whether the model called a tool:
  - **Tool calls present** — discard the buffered text, execute the tools, emit
    their `tool_event` frames, and stop. No further model round.
  - **No tool calls** — flush the buffered text as delta frames and stop. This is
    the conceptual-follow-up case ("why does this go SN1?"): the user asked a
    question in the Reaction tab and must still get an answer.

`_image_reaction_then_explain` gets the same treatment: emit the `reaction_result`
frame, skip the explanation stream.

The **Explanation** button re-runs the identical `/chat` request with
`explain: true`. Same messages, same grounding context, same model — the
explanation is byte-for-byte what the tab produces today, just deferred. This is
why the button reuses the chat turn rather than calling `/explain`: `/explain`
requires a `product_smiles` and so has nothing to say in the case where the
engine matched no template and the labeled AI guess *is* the answer.

**Scope.** `explain: false` is sent only from the Reaction tab. The general Chat
tab (`surface: 'chat'`) and the Synthesis assistant drawer (`surface: 'synthesis'`)
are conversations — a question there deserves a reply — and keep today's behavior.

**Trade-off accepted.** Buffering means a conceptual follow-up in the Reaction tab
appears all at once instead of token-by-token. The existing "Thinking…" spinner
covers the wait. Streaming deltas live instead would leak any preamble the model
writes before its tool call, which is the thing this change exists to remove.

### 2. Reaction tab — rendering and persistence

The assistant bubble for a deferred reaction holds its `toolResults` with an empty
`content`. Render the **Explanation** button when a message has a
`reaction_result` in `toolResults` and empty `content`.

Pressing it re-runs `streamReply` with the history *up to but excluding* that
bubble, seeded with the bubble's own `toolResults` — the same call shape the photo
flow already uses. Excluding it matters: an assistant message with empty content is
rejected by the Anthropic API, so it must never be replayed. `toApiMessages` also
gains a defensive filter dropping empty-content assistant messages, for sessions
saved before this change or left unexplained and reopened.

Pressing it streams prose into that message's `content`, which persists through the
existing `onChange`/`onSave` path to localStorage. A reopened session therefore
shows an explanation that was already generated, and the button is gone — the same
condition that shows the button hides it once content exists.

`ReactionBanner` is unchanged. It is a persistent "latest reaction" header, not a
per-message artifact; the button belongs in the bubble beside its card.

### 3. Photo flow

`handleReactionPhoto` stops calling `streamReply` after a successful
`reactFromImage`. It appends the assistant message carrying the
`reaction_result` tool result with empty content. The button in section 2 then
covers it with no extra code. Error handling is unchanged.

### 4. Synthesis → InfoPanel

Both `NodeInfoView` and `BranchInfoView` drop the `useEffect` that auto-fires the
explanation stream and gain an **Explanation** button, mirroring the
"Analyze stereochemistry" button already directly below it (InfoPanel.jsx:261-269):

- A `requested` flag on the explanation state, false initially.
- Not requested → render the button. Requested → render the existing
  `explanation-box` with its spinner / error / text states, including the
  "engine returned no response" message when a stream completes empty.
- The stale-stream guard must survive the move. Today it is a `stale` closure flag
  owned by the `useEffect` that is being deleted; with the stream started from a
  click handler instead, both views switch to the ref-counter pattern the stereo
  button already uses (`stereoSeq`): bump a seq ref whenever the selection
  changes, capture it at click time, and drop any delta or completion handler
  whose captured seq no longer matches.
- A small `useEffect` on the same dependency array remains, but only to reset
  state on selection change: `requested` back to false, text cleared, seq bumped.
  The result is that switching branch or node always lands on a clean button.

The "(AI)" tag on the section header stays.

## Files touched

- `app.py` — `ChatRequest.explain`, `_stream_anthropic_tools`,
  `_image_reaction_then_explain`
- `frontend/src/api.js` — `streamChat` gains an `explain` argument
- `frontend/src/platform/ChatPanel.tsx` — send `explain: false` on the reaction
  surface, render the button, drop the photo-flow `streamReply`
- `frontend/src/components/InfoPanel.jsx` — button in both views
- `frontend/src/App.css` — button styling for the in-bubble Explanation button,
  consistent with the existing `btn-secondary` used by "Analyze stereochemistry"

## Verification

There is no frontend test suite, and the Python suites (`test_prediction.py`,
`test_templates.py`, `test_askcos.py`) do not cover `/chat`, so the new
`explain: false` branch in the tool loop is not reachable from them. Verification
is runtime, via the `verify` skill:

1. Reaction tab, typed reaction — card and banner appear, no prose. Press
   **Explanation** → prose streams into the bubble. Reload → prose still there,
   button gone.
2. Reaction tab, conceptual follow-up ("why does this go SN1?") — answers
   normally, no button.
3. Reaction tab, reaction with no verified template — card shows the no-match
   message; **Explanation** still yields the labeled AI guess.
4. Photographed reaction — same as (1).
5. Synthesis — select a branch, then a node: each shows Reaction/Product/Steps
   with a button, no auto-generated text. Press it, then switch selection
   mid-stream and confirm the new panel is back to a clean button.
6. Chat tab and Synthesis assistant drawer — unchanged, still answer immediately.
