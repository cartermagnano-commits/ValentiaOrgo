# Reaction mechanism button

**Date:** 2026-08-03

## Problem

A reaction card shows what happened. It never shows *why*. A student who sees
`t-BuBr + NaOH → t-BuOH` has the answer without the reasoning — no carbocation, no
rate-determining step, no electron flow.

The obvious way to add this is to ask the LLM for a mechanism. That breaks the
invariant the whole architecture exists to protect: the LLM never does chemistry. A
mechanism asserts species that appear nowhere in engine output — a tertiary
carbocation, a tetrahedral intermediate — and those assertions would be
unverifiable.

## Goal

A **Mechanism** button on reaction bubbles in the Reaction tab that renders the
stepwise mechanism as drawn intermediates, computed deterministically from a
curated archetype library, with no LLM involvement on the curated path.

**Endgame.** The eventual target is curly-arrow diagrams — real electron-flow
arrows drawn over the structures. This design is the first step toward that, not a
detour around it: a curly arrow is a bond-order or formal-charge change between
mapped atoms, so mechanism steps written as fully atom-mapped SMARTS are
arrow-derivable later. An LLM-proposed intermediate never would be. That
constraint is the reason for the whole approach, and it is enforced (see
"Forward-compatibility rule").

**Non-goals.** No arrows in this version. No mechanisms in Synthesis/`InfoPanel` or
on `ReactionBanner`. No mechanisms for side products.

## Background

Three facts about the current codebase shaped this design:

- **90 of 94 templates already carry atom maps** in their SMARTS
  (`[CX4;!H0:1][CX4:2][Br:3]>>[CX3:1]=[CX3:2].[Br-:3]`). The library is already
  written in the idiom the endgame needs.
- **`template_id` is already on every product** (`prediction.py:60`, and `None` for
  ASKCOS-unnamed products at `prediction.py:93`). That is the join key from a
  rendered reaction back to the template that produced it — so nothing here needs
  to modify `reactivity_engine.py`, which is marked do-not-modify.
- **The opt-in button pattern exists twice**: "Analyze stereochemistry"
  (`InfoPanel.jsx:261-269`) and the deferred **Explanation** button
  (`ChatPanel.tsx:337-343`). Mechanism is a third instance of the same shape.

## Design

### 1. `mechanisms.json` — the archetype library

New file beside `reaction_templates.json`, structured the same way (`version`,
`note`, `archetypes`). It is the only place mechanism *steps* live, exactly as
`reaction_templates.json` is the only place reaction *names* live.

An archetype is an ordered list of atom-mapped SMARTS transformations with
authored captions. Illustrative:

```json
{
  "id": "electrophilic_addition_hx",
  "name": "Electrophilic addition (Markovnikov)",
  "class": "Addition",
  "provenance": "Clayden, Organic Chemistry 2nd ed., ch. 19.",
  "steps": [
    {
      "label": "Protonation of the alkene",
      "smarts": "[C:1]=[C:2].[Br:3][H:4]>>[C:1][C+:2].[Br-:3]",
      "caption": "The π bond attacks H–Br. The proton adds to the less substituted carbon, so the positive charge lands on the more substituted one.",
      "rate_determining": true
    },
    {
      "label": "Halide capture",
      "smarts": "...",
      "caption": "Bromide attacks the planar carbocation from either face."
    }
  ]
}
```

Templates in `reaction_templates.json` gain **one field**, `mechanism`, holding an
archetype id — or `null` with a reason:

```json
{ "id": "alkene_hydrogenation",
  "mechanism": null,
  "mechanism_note": "Heterogeneous Pd surface chemistry; not meaningfully described by arrow pushing." }
```

#### Four request-time states

| Template state | Result |
|---|---|
| `mechanism: "<id>"` | Deterministic mechanism from the archetype |
| `mechanism: null` | "Not described by arrow pushing" + the reason. **No LLM.** |
| Field absent (not yet curated) | LLM fallback, flagged unverified |
| `template_id` is `null` (ASKCOS-unnamed product) | LLM fallback, flagged unverified |

`null` and absent are deliberately different. `null` is a permanent judgment that
arrow pushing does not describe this reaction; absent is a curation backlog entry.

#### Forward-compatibility rule

**Every archetype step SMARTS must be fully atom-mapped on both sides.** A validator
asserts this, in the spirit of `validate_templates.py`. Complete mapping means the
bond-order and formal-charge deltas between reactant and product are computable,
which is exactly the data a curly arrow renders. An unmapped step is permanently
un-arrowable and would have to be rewritten. The rule costs one assertion now and
is the entire reason the archetype approach was chosen over LLM-proposed
intermediates.

### 2. v1 coverage — five archetypes, 49 of 94 templates

Chosen to span both structural shapes: one-step concerted (the hard case for
arrows — several simultaneous arrows on one frame) and multi-step with a real
intermediate. If the data model survives both, it survives the rest.

| Archetype | Steps | Templates |
|---|---|---|
| `sn2` | 1 | 20 — `sn2_br_oh`, `sn2_cl_oh`, `sn2_br_water`, `sn2_cl_water`, `finkelstein_br_i`, `finkelstein_cl_i`, `williamson_br`, `williamson_cl`, `halide_exchange_br_cl`, `sn2_br_nh3`, `sn2_cl_nh3`, `alpha_alkylation_br`, `alpha_alkylation_cl`, `acetylide_alkylation_br`, `acetylide_alkylation_cl`, `williamson_coupling_br`, `williamson_coupling_cl`, `sn2_amine`, `sn2_cyanide`, `sn2_azide` |
| `electrophilic_addition_hx` | 2 | 12 — `hbr`/`hcl`/`hi` × `markovnikov_terminal`, `markovnikov_disubstituted`, `markovnikov_geminal`, `addition_internal` |
| `nucleophilic_addition_carbonyl` | 2 | 8 — `grignard_aldehyde`, `grignard_ketone`, `grignard_formaldehyde`, `nabh4_aldehyde`, `nabh4_ketone`, `lialh4_aldehyde`, `lialh4_ketone`, `cyanohydrin_formation` |
| `proton_transfer` | 1 | 6 — `kinetic_enolate`, `enolate_protonation`, `ammonium_deprotonation`, `acetylide_deprotonation`, `alcohol_deprotonation`, `carboxylate_deprotonation` |
| `e2` | 1 | 3 — `e2_elim_hbr`, `e2_elim_hcl`, `e2_elim_hi` |

Deferred to later curation (not `null` — genuinely uncovered): nucleophilic acyl
substitution (8), electrophilic aromatic substitution (4), E1/carbocation (3),
halonium addition (2), and the multi-stage hydride reductions
(`lialh4_carboxylic_acid`, `ester_reduction_lah`, `amide_reduction_lah`,
`nitrile_reduction_lah`, `nitrile_grignard_ketone`), which are addition–elimination
followed by a second addition rather than the clean two-step archetype.

Marked `mechanism: null` in v1: `alkene_hydrogenation`,
`alkyne_hydrogenation_full`, `alkyne_lindlar`, `alkene_dihydroxylation`,
`nitro_reduction`. The `null` set is curated deliberately, not exhaustively — more
entries get added as they are identified.

*Incidental finding, out of scope:* `lialh4_carboxylic_acid` (index 33) and
`carboxylic_acid_reduction_lah` (index 58) are two template ids with the same name,
"LiAlH4 reduction: carboxylic acid → primary alcohol". Worth a separate look.

### 3. `mechanism_engine.py` — resolution and the guard

New module. It reads `mechanisms.json` and calls RDKit itself, sitting beside the
engine the way `prediction.py` does rather than inside it.

**`resolve_mechanism(substrate, reagent, product, template_id) -> Resolution`**

`Resolution` distinguishes the outcomes the endpoint needs to tell apart: a
resolved mechanism, a `not_applicable` verdict carrying the template's
`mechanism_note`, and "no deterministic answer" (uncurated template, unknown
`template_id`, or guard mismatch) — the last being the only one that hands off to
the LLM fallback. The module itself never calls the LLM.

1. Look up the template by id → its `mechanism` field → the archetype. Absent or
   `null` short-circuits to the states in section 1.
2. Fire the archetype's steps in order with `RunReactants`, starting from
   substrate + reagent. Each step's output feeds the next.
3. A step matching at several sites forks. Enumerate every surviving sequence
   rather than picking one arbitrarily.
4. **Terminal-product guard.** Canonicalize each sequence's final species; keep
   only those equal to the engine's `product_smiles`.
   - Exactly one survives → that is the mechanism.
   - Several survive → equivalent sites on a symmetric substrate. Take the first
     by canonical ordering, log `MECHANISM_AMBIGUOUS`.
   - None survive → return `None`, log
     `MECHANISM_MISMATCH template=… archetype=… expected=… got=…`, fall through to
     the LLM path.

The guard is the load-bearing part. Nothing otherwise guarantees the archetype's
last step lands on the product the card is already showing — regiochemistry is the
obvious way it drifts, and a mechanism whose final structure contradicts the
product two inches above it is worse than no mechanism. The instinct is the same as
`prediction.resolve_products`: when two deterministic things disagree, surface it
rather than paper over it.

`MECHANISM_MISMATCH` names the exact template and archetype that disagreed, turning
every failure into a curation task — the job `TEMPLATE_GAP endpoint=react_unnamed`
already does for missing names.

**Captions are authored, not generated.** The curated path makes no LLM call at
all: no quota, no latency, no streaming, no hallucination surface. The LLM appears
in exactly one place, the fallback for uncurated templates, where it is flagged
unverified. The cost is that captions are generic — "the π bond attacks H–Br"
rather than naming the actual substrate. Textbook captions are generic too, and
the **Explanation** button sitting next to this one already produces
substrate-specific prose. Per-molecule caption rewriting is deferred.

### 4. `POST /mechanism`

Non-streaming JSON, unlike `/explain` and `/stereo`. The payload is structured
data, and on the curated path there is no LLM to stream from.

Request carries what the bubble already holds: `substrate_smiles`,
`reagent_smiles`, `product_smiles`, `template_id`, `reaction_name`, plus `engine`
(used only if it falls to the LLM path).

```json
{ "status": "resolved",
  "archetype": "sn2", "class": "SN2",
  "steps": [ { "label": "...", "caption": "...", "smiles": "...",
               "rate_determining": false } ],
  "note": null }
```

| `status` | Meaning |
|---|---|
| `resolved` | Archetype fired and passed the guard. No LLM touched it. |
| `not_applicable` | `mechanism: null`; `note` carries the reason verbatim from the template. |
| `unverified` | LLM fallback. |
| `unavailable` | Guard mismatch *and* the fallback failed. Honest empty state. |

The `unverified` path asks the LLM for the same step shape the archetypes produce —
an ordered list of `{label, caption, smiles}` — so `MechanismView` renders both
paths with one code path and only the source line differs.

On the `unverified` path every proposed intermediate is RDKit-parsed before it
leaves the backend — the discipline `askcos_client._parse_outcomes` and
`_maybe_blind_guess` already follow. One unparseable step discards the whole
mechanism rather than rendering a gap.

`_enforce_hosted_quota` fires **only** on the `unverified` path; a curated
mechanism costs nothing and should not spend a user's daily budget. Auth via
`require_auth` like the other compute endpoints; lands in the existing 60/min
compute tier.

**`/mechanism` must be added to `apiPaths` in `frontend/next.config.mjs`** or the
frontend cannot reach it.

### 5. Frontend

**`frontend/src/components/MechanismView.tsx`** (new). Numbered steps down the
bubble: each a `StructureView` of the intermediate with its label and caption, a
downward arrow between steps. Header carries the `class` badge (`SN2`,
`Addition`), a marker on the rate-determining step, and a source line reading
either "Template library" or **"AI-generated · unverified"** — the labeling
`ai_guess` already uses.

**`ChatPanel.tsx`**: a **Mechanism** button beside **Explanation**, shown when a
message carries a `reaction_result`. It does *not* share Explanation's
empty-content condition — a student may want the mechanism after reading the
explanation — so it stays available and toggles show/hide once fetched.

The result is stored on the message (`mechanism` field) and persists to
localStorage through the existing `onChange`/`onSave` path, like streamed content.
A reopened session shows what it already computed, which on the `unverified` path
means not paying for it twice. `not_applicable` is stored too, so the note does not
refetch.

The mechanism covers the **primary product only** (`products[0]`, what
`ReactionBanner` calls `primary`). Side reactions get none in v1.

`src/api.js` gains `fetchMechanism`; `App.css` gains the step styling.

`ReactionBanner` is untouched, for the reason the on-demand-explanations spec
already gave: it is a persistent "latest reaction" header, not a per-message
artifact, and the button belongs in the bubble beside its card.

## Files touched

- `mechanisms.json` — new, five archetypes
- `reaction_templates.json` — `mechanism` field on 49 templates, `mechanism: null`
  + `mechanism_note` on 5
- `mechanism_engine.py` — new: archetype loading, step firing, terminal guard
- `app.py` — `MechanismRequest`, `POST /mechanism`, LLM fallback path
- `test_mechanisms.py` — new
- `frontend/next.config.mjs` — `/mechanism` in `apiPaths`
- `frontend/src/api.js` — `fetchMechanism`
- `frontend/src/components/MechanismView.tsx` — new
- `frontend/src/platform/ChatPanel.tsx` — Mechanism button, message `mechanism`
  field
- `frontend/src/App.css` — step styling

## Verification

`test_mechanisms.py` follows `test_prediction.py`'s discipline of importing nothing
heavy — it needs RDKit but not `app.py`, so it runs in about a second:

1. Each of the five archetypes fires and passes the terminal guard on a known
   substrate/reagent pair.
2. Every archetype step SMARTS is fully atom-mapped on both sides.
3. Every `mechanism` id referenced by a template exists in `mechanisms.json`.
4. Every template with `mechanism: null` also has a non-empty `mechanism_note`.
5. A deliberately mismatched archetype/template pair returns `None`.

`test_templates.py` must still pass — `reaction_templates.json` is being edited.

The frontend has no test suite, so the UI is verified at runtime via the `verify`
skill:

1. `1-bromobutane + NaOH` — one concerted SN2 step, "Template library".
2. `2-methylpropene + HBr` — two steps with a carbocation intermediate,
   rate-determining marker on step 1.
3. Catalytic hydrogenation — the not-applicable note, and no LLM call in the logs.
4. An ASKCOS-only product (`template_id` null) — steps labeled
   "AI-generated · unverified".
5. Reload the session — every one of the above still rendered, no refetch.
6. **Explanation** still behaves exactly as before on all of them.
