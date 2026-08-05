# Chat reactions render as banners, not SMILES cards

**Date:** 2026-08-02
**Status:** approved, ready for implementation planning

## Problem

When a user puts a reaction into the Chat surface, the result is currently presented
twice, in two different visual languages:

1. **A pinned banner** at the top of the chat panel (`ChatPanel.tsx:465`), showing
   substrate (+ reagent) → product as drawn structures. It deliberately prints no
   SMILES text — "the drawing IS the answer" (`ReactionBanner.tsx:20-22`). It always
   shows the *newest* reaction in the thread, detached from the message that produced
   it.
2. **An inline "Engine reaction" card** inside the assistant's message bubble
   (`ChatPanel.tsx:118-148`), which *does* print SMILES: substrate and reagent as
   `<code>` in the card header, and every product's SMILES string under its drawing.

The SMILES text is the unwanted part. Structures are the answer a chemist reads; raw
SMILES strings are noise in a conversation. The duplication is the second problem —
the same reaction appears in two places with two different treatments.

## Decisions

| Question | Decision |
|---|---|
| SMILES text in chat | **None.** Drawings only, everywhere in the chat surface |
| Inline presentation | Reuse `ReactionBanner` inside the message bubble |
| Pinned top banner | Removed from Chat; **kept unchanged** on the Reaction tab |
| Backend | No changes. The tool event already carries the right shape |
| Empty-product warning | Kept — it survives the card's removal |

## Architecture

### 1. The inline card becomes a banner

In `ToolResultCards`, the `reaction_result` branch stops rendering bespoke card markup
and renders the existing component instead:

```tsx
<ReactionBanner reaction={result.data} inline />
```

No data plumbing changes. The tool event emitted by `_execute_chat_tool` is
`{"type": "reaction_result", "data": core}` (`app.py:1184`), and `core` already carries
`substrate_smiles`, `reagent_smiles`, `environment`, and `products[]` — exactly the
shape `ReactionBanner` reads. `_image_reaction_then_explain` emits the same event
shape (`app.py:2700`), so photo-read reactions get the same treatment with no extra
work.

What the user gains over the old card: side products move behind the banner's existing
disclosure toggle instead of being truncated at three, and the reaction name and
conditions move into the banner footer.

What the user loses: the SMILES strings. That is the point.

### 2. An `inline` variant on the banner

`ReactionBanner` takes an optional `inline?: boolean` prop that adds a modifier class
to its root element. The pinned banner is styled for a panel header —
`margin: 12px auto 0; max-width: 820px` (`App.css:4765-4775`) — which would float it
centered and gapped inside a chat bubble. The modifier drops the auto-centering, the
top margin, and the max-width so the banner sits flush in the bubble. Every other
banner style is shared, so the two placements stay visually identical in substance.

Default (`inline` absent) preserves today's pinned appearance exactly.

### 3. The pinned banner becomes Reaction-tab only

`showReactionBanner` narrows from `surface === 'reaction' || surface === 'chat'` to
`surface === 'reaction'`. In Chat, reactions now appear in the message where they
happened, in conversation order — scrollable history rather than a single
always-latest banner.

`latestReaction` state and the `findLatestReaction` seeding stay as they are; gating
the render makes them inert for the chat surface without touching the Reaction tab's
behavior. `lastReactionRef` (the grounding context sent to `/chat` on follow-ups) is a
separate value and is untouched.

## Error handling

When the engine returns no products, the old card printed:

> No verified template matched this pair — any product below is an unverified AI guess.

`ReactionBanner`'s equivalent is the terser "No verified product" inside the flow,
which drops the warning that the assistant's following prose is *unverified*. That
caveat is load-bearing — it is the boundary between engine output and an LLM guess.

So when `products` is empty, the inline rendering keeps that warning line beneath the
banner. The banner itself is unchanged; the warning is rendered by `ToolResultCards`
alongside it. No SMILES, caveat intact.

`ReactionBanner` returns `null` when `substrate_smiles` is absent, so a malformed tool
event renders nothing rather than a broken frame.

## Testing

There is no frontend test suite in this repo, and this change touches no Python. No
backend test script (`test_templates.py`, `test_prediction.py`, `test_askcos.py`)
covers or is affected by it.

Verification is manual, via the project's `verify` skill:

1. Launch the app and open the **Chat** surface.
2. Send a reaction the template library covers (e.g. cyclohexene + Br₂).
3. Confirm: the result renders as a banner inside the assistant's message, showing
   drawn structures with no SMILES text anywhere; side products sit behind the
   disclosure toggle; no banner is pinned at the top of the panel.
4. Send a pair no template matches and confirm the unverified-guess warning still
   appears beneath the banner.
5. Open the **Reaction** tab and confirm its pinned banner is unchanged.

## Out of scope

- The Reaction tab's pinned banner layout and behavior.
- The `set_stockroom` and `pathways_result` cards, which keep their current form.
- Any backend or engine change.
