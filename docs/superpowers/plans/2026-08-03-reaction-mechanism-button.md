# Reaction Mechanism Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Mechanism** button to reaction bubbles in the Reaction tab that renders the stepwise mechanism as drawn intermediates, computed deterministically from a curated archetype library with no LLM on the curated path.

**Architecture:** A new `mechanisms.json` holds ~5 mechanism archetypes, each an ordered list of fully atom-mapped SMARTS steps with authored captions. Templates in `reaction_templates.json` gain a `mechanism` field naming their archetype. A new `mechanism_engine.py` fires the archetype's steps through RDKit against the real substrate and reagent, and keeps only the sequence whose final fragment pool contains the product the engine already computed. `POST /mechanism` serves the result; uncurated templates fall to a clearly-labeled LLM path; templates marked `mechanism: null` get nothing at all.

**Tech Stack:** Python 3 + RDKit + FastAPI (backend), Next.js App Router + TypeScript + React (frontend). No pytest, no lint config, no frontend test suite.

**Spec:** `docs/superpowers/specs/2026-08-03-reaction-mechanism-button-design.md`

## Global Constraints

- **The LLM never does chemistry.** The curated path makes no model call at all. The LLM appears only in the uncurated fallback, where its output is RDKit-validated and labeled `unverified`.
- **Do not modify `reactivity_engine.py` or `preprocessing.py`.** The README marks them do-not-modify. Everything here reads their output; nothing changes them.
- **Tests are plain Python scripts, not pytest.** Follow `test_prediction.py`: a `check(name, ok, detail)` helper, one `PASS`/`FAIL` line per case, a summary, `sys.exit(1)` on any failure. Run with `python test_mechanisms.py`.
- **`test_mechanisms.py` must not import `app.py`.** Importing it pulls in TensorFlow/DECIMER/MolScribe (~2 min). It may import `mechanism_engine` and RDKit only.
- **Every archetype step SMARTS must be fully atom-mapped on every heavy atom, both sides.** Implicit hydrogens are exempt. This is the forward-compatibility rule for curly arrows and is enforced by a test.
- **Run exactly one uvicorn worker.** Rate-limit buckets and quota counters live in process memory.
- **Any new backend route the frontend calls must be added to `apiPaths` in `frontend/next.config.mjs`.**
- Model IDs in this codebase: `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-8`.
- Commit after every task.

---

### Task 1: `mechanism_engine.py` — loading and validation

Creates the module, the data types, and `mechanisms.json` with a single archetype (`sn2`). No firing yet — this task proves the library loads, links to templates, and passes the atom-mapping rule.

**Files:**
- Create: `mechanisms.json`
- Create: `mechanism_engine.py`
- Create: `test_mechanisms.py`
- Modify: `reaction_templates.json` (add `"mechanism": "sn2"` to 20 templates)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `mechanism_engine.Step` — dataclass `(label: str, caption: str, smiles: str = "", rate_determining: bool = False)`
  - `mechanism_engine.Resolution` — dataclass `(status: str, steps: list[Step], archetype: str | None, reaction_class: str | None, note: str | None)`; `status` is one of `"resolved"`, `"not_applicable"`, `"no_mechanism"`
  - `mechanism_engine.MechanismEngine(mechanism_path=None, template_path=None)` with attributes `archetypes: dict[str, dict]`, `template_mechanism: dict[str, str | None]`, `template_note: dict[str, str]`, and method `unmapped_steps() -> list[tuple[str, int, str]]`
  - `mechanism_engine.ENGINE` — module-level singleton

- [ ] **Step 1: Write `mechanisms.json` with the `sn2` archetype**

```json
{
  "version": "1.0",
  "note": "Mechanism archetypes. Each archetype is an ordered list of steps; each step lists one or more fully atom-mapped SMARTS variants that are unioned when the step fires. Captions are authored, never generated — the curated mechanism path makes no LLM call. Every heavy atom on both sides of every variant MUST carry an atom map (test_mechanisms.py enforces this), because a curly arrow is a bond-order or formal-charge change between mapped atoms and an unmapped step is permanently un-arrowable.",
  "archetypes": [
    {
      "id": "sn2",
      "name": "SN2 — bimolecular nucleophilic substitution",
      "class": "SN2",
      "provenance": "Clayden, Organic Chemistry 2nd ed., ch. 15. Concerted backside displacement; one transition state, no intermediate.",
      "steps": [
        {
          "label": "Concerted backside attack",
          "rate_determining": true,
          "caption": "The nucleophile attacks the carbon from the face directly opposite the leaving group. Bond making and bond breaking happen in the same step, through a single transition state, so the configuration at that carbon inverts.",
          "variants": [
            "[CX4:1][Br,Cl,I:2].[O,S,N;-1:3]>>[CX4:1][*;+0:3].[*;-1:2]",
            "[CX4:1][Br,Cl,I:2].[C;-1:3]>>[CX4:1][C;+0:3].[*;-1:2]",
            "[CX4:1][Br,Cl,I:2].[N;H1,H2,H3;+0:3]>>[CX4:1][N;+1:3].[*;-1:2]",
            "[CX4:1][Br,Cl,I:2].[Cl,Br,I;-1:3]>>[CX4:1][*;+0:3].[*;-1:2]"
          ]
        }
      ]
    }
  ]
}
```

- [ ] **Step 2: Tag the 20 SN2 templates**

Run this once; it edits `reaction_templates.json` in place, preserving key order and formatting style.

```python
import json

SN2 = [
    "sn2_br_oh", "sn2_cl_oh", "sn2_br_water", "sn2_cl_water",
    "finkelstein_br_i", "finkelstein_cl_i", "williamson_br", "williamson_cl",
    "halide_exchange_br_cl", "sn2_br_nh3", "sn2_cl_nh3",
    "alpha_alkylation_br", "alpha_alkylation_cl",
    "acetylide_alkylation_br", "acetylide_alkylation_cl",
    "williamson_coupling_br", "williamson_coupling_cl",
    "sn2_amine", "sn2_cyanide", "sn2_azide",
]

path = "reaction_templates.json"
data = json.load(open(path, encoding="utf-8"))
seen = set()
for t in data["templates"]:
    if t["id"] in SN2:
        t["mechanism"] = "sn2"
        seen.add(t["id"])
missing = set(SN2) - seen
assert not missing, f"template ids not found: {missing}"
json.dump(data, open(path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
open(path, "a", encoding="utf-8").write("\n")
print(f"tagged {len(seen)} templates")
```

Expected: `tagged 20 templates`

- [ ] **Step 3: Write the failing test**

Create `test_mechanisms.py`:

```python
"""
test_mechanisms.py — Regression suite for the mechanism archetype engine.

Run before committing changes to mechanisms.json, mechanism_engine.py, or the
`mechanism` fields in reaction_templates.json:

    python test_mechanisms.py

Plain Python on purpose (matching test_prediction.py and test_templates.py):
one PASS/FAIL line per case, non-zero exit on any failure. Imports RDKit and
mechanism_engine only — never app.py, which would drag in TensorFlow/DECIMER
and turn a one-second suite into a two-minute one.
"""

import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from mechanism_engine import ENGINE

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


# ── Library integrity ────────────────────────────────────────────────────────

check("the sn2 archetype loaded", "sn2" in ENGINE.archetypes)

check("every archetype step SMARTS is fully atom-mapped",
      ENGINE.unmapped_steps() == [],
      f"unmapped: {ENGINE.unmapped_steps()}")

unknown = sorted(
    tid for tid, mid in ENGINE.template_mechanism.items()
    if mid is not None and mid not in ENGINE.archetypes
)
check("every mechanism id referenced by a template exists", unknown == [],
      f"dangling ids: {unknown}")

nulls_without_note = sorted(
    tid for tid, mid in ENGINE.template_mechanism.items()
    if mid is None and not ENGINE.template_note.get(tid)
)
check("every template with mechanism:null carries a mechanism_note",
      nulls_without_note == [], f"missing notes: {nulls_without_note}")

check("the 20 SN2 templates are tagged",
      sum(1 for m in ENGINE.template_mechanism.values() if m == "sn2") == 20,
      f"got {sum(1 for m in ENGINE.template_mechanism.values() if m == 'sn2')}")


# ── Summary ──────────────────────────────────────────────────────────────────

print()
print(f"{passes} passed, {len(failures)} failed")
if failures:
    for f in failures:
        print(f"  FAILED: {f}")
    sys.exit(1)
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `python test_mechanisms.py`
Expected: `ModuleNotFoundError: No module named 'mechanism_engine'`

- [ ] **Step 5: Write `mechanism_engine.py`**

```python
"""
mechanism_engine.py — Deterministic stepwise reaction mechanisms.

All mechanism chemistry is defined in mechanisms.json. This module is a generic
archetype loader and runner with no reaction-specific code, the way
reactivity_engine.py is for reaction_templates.json.

The LLM is not involved on this path. Captions are authored in the library;
intermediates are computed by RDKit from the real substrate and reagent; and a
sequence is only ever returned if its final fragment pool contains the product
the reaction engine already computed. See
docs/superpowers/specs/2026-08-03-reaction-mechanism-button-design.md.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem

logger = logging.getLogger(__name__)
_rdlog = RDLogger.logger()

_MECHANISM_FILE = Path(__file__).parent / "mechanisms.json"
_TEMPLATE_FILE = Path(__file__).parent / "reaction_templates.json"

# Every heavy atom in a SMARTS must carry ":<n>". Hydrogens are exempt — the
# proton picked up on workup is not an atom in the template.
_ATOM_TOKEN = re.compile(r"\[([^\]]+)\]")


@dataclass
class Step:
    """One rendered mechanism step. `smiles` is the intermediate (or, on the
    last step, the product) as a canonical multi-fragment SMILES."""
    label: str
    caption: str
    smiles: str = ""
    rate_determining: bool = False


@dataclass
class Resolution:
    """Outcome of a mechanism lookup.

    status:
      "resolved"        — archetype fired and passed the terminal-product guard
      "not_applicable"  — template is marked mechanism:null; `note` says why
      "no_mechanism"    — no deterministic answer. The ONLY status that hands
                          off to the LLM fallback in app.py.
    """
    status: str
    steps: list[Step] = field(default_factory=list)
    archetype: str | None = None
    reaction_class: str | None = None
    note: str | None = None


def _heavy_atoms_mapped(smarts: str) -> bool:
    """True when every bracketed heavy-atom token carries an atom map."""
    for token in _ATOM_TOKEN.findall(smarts):
        core = token.split(";")[0]
        if core in ("H", "#1"):
            continue
        if ":" not in token:
            return False
    return True


class MechanismEngine:
    """Generic mechanism archetype loader and runner."""

    def __init__(self, mechanism_path: str | Path | None = None,
                 template_path: str | Path | None = None):
        self.archetypes: dict[str, dict] = {}
        self.template_mechanism: dict[str, str | None] = {}
        self.template_note: dict[str, str] = {}
        self._load_archetypes(Path(mechanism_path) if mechanism_path else _MECHANISM_FILE)
        self._load_template_links(Path(template_path) if template_path else _TEMPLATE_FILE)

    # ── Loading ───────────────────────────────────────────────────────────────

    def _load_archetypes(self, path: Path) -> None:
        if not path.exists():
            logger.warning("Mechanism file not found: %s — no archetypes loaded.", path)
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.error("Failed to parse %s: %s — no archetypes loaded.", path, exc)
            return

        _rdlog.setLevel(RDLogger.CRITICAL)
        for entry in data.get("archetypes", []):
            aid = entry.get("id", "<unnamed>")
            try:
                steps = []
                for step in entry["steps"]:
                    compiled = []
                    for smarts in step["variants"]:
                        rxn = AllChem.ReactionFromSmarts(smarts)
                        if rxn is None:
                            raise ValueError(f"ReactionFromSmarts returned None for {smarts!r}")
                        rxn.Initialize()
                        compiled.append((smarts, rxn))
                    steps.append({
                        "label": step["label"],
                        "caption": step["caption"],
                        "rate_determining": step.get("rate_determining", False),
                        "variants": compiled,
                    })
                self.archetypes[aid] = {
                    "id": aid,
                    "name": entry["name"],
                    "class": entry.get("class", ""),
                    "provenance": entry.get("provenance", ""),
                    "steps": steps,
                }
            except Exception as exc:
                logger.warning("Skipping archetype '%s': %s", aid, exc)
        _rdlog.setLevel(RDLogger.WARNING)
        logger.info("Loaded %d mechanism archetypes from %s.", len(self.archetypes), path)

    def _load_template_links(self, path: Path) -> None:
        """Read only the `mechanism` / `mechanism_note` fields. This does not
        compile templates — reactivity_engine.py owns that and is do-not-modify."""
        if not path.exists():
            logger.warning("Template file not found: %s — no mechanism links.", path)
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.error("Failed to parse %s: %s — no mechanism links.", path, exc)
            return
        for entry in data.get("templates", []):
            if "mechanism" not in entry:
                continue           # not yet curated — distinct from an explicit null
            self.template_mechanism[entry["id"]] = entry["mechanism"]
            if entry.get("mechanism_note"):
                self.template_note[entry["id"]] = entry["mechanism_note"]

    # ── Validation (used by test_mechanisms.py) ───────────────────────────────

    def unmapped_steps(self) -> list[tuple[str, int, str]]:
        """Every (archetype_id, step_index, smarts) whose heavy atoms are not
        fully mapped. Must be empty: an unmapped step can never be turned into
        a curly arrow, which is the whole reason the library is written this way."""
        bad = []
        for aid, arch in self.archetypes.items():
            for index, step in enumerate(arch["steps"]):
                for smarts, _rxn in step["variants"]:
                    if not _heavy_atoms_mapped(smarts):
                        bad.append((aid, index, smarts))
        return bad


ENGINE = MechanismEngine()
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `python test_mechanisms.py`
Expected: `5 passed, 0 failed`

- [ ] **Step 7: Confirm the template edit did not break the reaction engine**

Run: `python test_templates.py`
Expected: the suite's existing pass count, 0 failed. `mechanism` is an unread extra key as far as `reactivity_engine.py` is concerned.

- [ ] **Step 8: Commit**

```bash
git add mechanisms.json mechanism_engine.py test_mechanisms.py reaction_templates.json
git commit -m "Mechanism archetype library loads and links to templates"
```

---

### Task 2: Firing and the terminal-product guard

Adds `resolve_mechanism`. This is the load-bearing task: nothing else guarantees the archetype's last step lands on the product the card already shows.

**Files:**
- Modify: `mechanism_engine.py`
- Modify: `test_mechanisms.py`

**Interfaces:**
- Consumes: `Step`, `Resolution`, `MechanismEngine`, `ENGINE` from Task 1.
- Produces: `MechanismEngine.resolve(substrate: str, reagent: str, product: str, template_id: str | None, steps_taken: int = 1) -> Resolution`, and the module-level convenience `mechanism_engine.resolve_mechanism(...)` with the identical signature, delegating to `ENGINE`.

- [ ] **Step 1: Write the failing tests**

Append to `test_mechanisms.py`, immediately before the `# ── Summary ──` block:

```python
# ── Firing and the terminal-product guard ────────────────────────────────────

from mechanism_engine import resolve_mechanism

r = resolve_mechanism("CCCCBr", "[OH-].[Na+]", "CCCCO", "sn2_br_oh")
check("SN2 hydroxide resolves", r.status == "resolved", f"got {r.status}")
check("SN2 is one step", len(r.steps) == 1, f"got {len(r.steps)} steps")
check("SN2's single step lands on the product",
      r.steps and "CCCCO" in r.steps[-1].smiles.split("."),
      f"got {r.steps[-1].smiles if r.steps else None}")
check("SN2's step is marked rate-determining",
      bool(r.steps and r.steps[0].rate_determining))
check("the resolved archetype is reported", r.archetype == "sn2")
check("the reaction class is reported", r.reaction_class == "SN2")

check("the spectator counter-ion does not defeat the guard",
      resolve_mechanism("CCBr", "CC[O-].[Na+]", "CCOCC", "williamson_br").status
      == "resolved")

check("a cyanide nucleophile resolves through the anionic-carbon variant",
      resolve_mechanism("CCCCBr", "[C-]#N.[Na+]", "CCCCC#N", "sn2_cyanide").status
      == "resolved")

check("a product the archetype cannot reach is refused",
      resolve_mechanism("CCCCBr", "[OH-].[Na+]", "CCC=C", "sn2_br_oh").status
      == "no_mechanism")

check("an untagged template yields no deterministic mechanism",
      resolve_mechanism("CCCCBr", "[OH-].[Na+]", "CCCCO", "aromatic_nitration").status
      == "no_mechanism")

check("an ASKCOS-only product (no template_id) yields no deterministic mechanism",
      resolve_mechanism("CCCCBr", "[OH-].[Na+]", "CCCCO", None).status
      == "no_mechanism")

check("a multi-step branch is refused before firing",
      resolve_mechanism("CCCCBr", "[OH-].[Na+]", "CCCCO", "sn2_br_oh",
                        steps_taken=2).status == "no_mechanism")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python test_mechanisms.py`
Expected: `ImportError: cannot import name 'resolve_mechanism' from 'mechanism_engine'`

- [ ] **Step 3: Implement firing and the guard**

Add to `mechanism_engine.py`, after `unmapped_steps` and before the `ENGINE = MechanismEngine()` line. Also add `from itertools import permutations` to the imports.

```python
    # ── Firing ────────────────────────────────────────────────────────────────

    MAX_POOLS = 32      # cap on surviving branches per step, bounds fan-out

    @staticmethod
    def _fragments(smiles: str) -> list[str]:
        """Canonical SMILES of each disconnected fragment, or [] if unparseable."""
        mol = Chem.MolFromSmiles(smiles or "")
        if mol is None:
            return []
        return [Chem.MolToSmiles(f) for f in Chem.GetMolFrags(mol, asMols=True)]

    def _apply_step(self, step: dict, pool: tuple[str, ...]) -> set[tuple[str, ...]]:
        """Fire one step's variants against a fragment pool. Returns every
        resulting pool: consumed fragments replaced by the step's products,
        untouched fragments carried through."""
        out: set[tuple[str, ...]] = set()
        mols = [Chem.MolFromSmiles(s) for s in pool]
        if any(m is None for m in mols):
            return out
        for _smarts, rxn in step["variants"]:
            n = rxn.GetNumReactantTemplates()
            if n > len(pool):
                continue
            for combo in permutations(range(len(pool)), n):
                try:
                    runs = rxn.RunReactants(tuple(mols[i] for i in combo))
                except Exception:
                    continue
                for products in runs:
                    try:
                        made: list[str] = []
                        for p in products:
                            Chem.SanitizeMol(p)
                            made += [Chem.MolToSmiles(f)
                                     for f in Chem.GetMolFrags(p, asMols=True)]
                    except Exception:
                        continue      # an invalid intermediate is simply not a branch
                    rest = [pool[i] for i in range(len(pool)) if i not in combo]
                    out.add(tuple(sorted(made + rest)))
        return out

    def resolve(self, substrate: str, reagent: str, product: str,
                template_id: str | None, steps_taken: int = 1) -> Resolution:
        """Compute the mechanism for one engine-verified reaction.

        Never calls the LLM. Returns status "no_mechanism" when it has no
        deterministic answer — app.py owns what happens next."""
        # A multi-step branch reports only its FIRST template as template_id
        # (reactivity_engine.py:306), so that template's archetype describes the
        # opening move and could never reach the final product. Bail here rather
        # than letting the guard reject it after the work.
        if steps_taken and steps_taken > 1:
            return Resolution(status="no_mechanism")

        if not template_id or template_id not in self.template_mechanism:
            return Resolution(status="no_mechanism")

        archetype_id = self.template_mechanism[template_id]
        if archetype_id is None:
            return Resolution(
                status="not_applicable",
                note=self.template_note.get(template_id)
                     or "This reaction is not usefully described by arrow pushing.",
            )

        archetype = self.archetypes.get(archetype_id)
        if archetype is None:
            logger.warning("Template '%s' names unknown archetype '%s'.",
                           template_id, archetype_id)
            return Resolution(status="no_mechanism")

        target = Chem.MolFromSmiles(product or "")
        if target is None:
            return Resolution(status="no_mechanism")
        target_smiles = Chem.MolToSmiles(target)

        start = tuple(sorted(self._fragments(substrate) + self._fragments(reagent)))
        if not start:
            return Resolution(status="no_mechanism")

        # Each sequence is the list of pools after each step, so a surviving
        # sequence carries its own intermediates with it.
        sequences: list[list[tuple[str, ...]]] = [[start]]
        _rdlog.setLevel(RDLogger.CRITICAL)
        try:
            for step in archetype["steps"]:
                grown: list[list[tuple[str, ...]]] = []
                for seq in sequences:
                    for pool in sorted(self._apply_step(step, seq[-1])):
                        grown.append(seq + [pool])
                if not grown:
                    logger.info(
                        "MECHANISM_MISMATCH template=%s archetype=%s reason=step_no_match "
                        "step=%s", template_id, archetype_id, step["label"])
                    return Resolution(status="no_mechanism")
                grown.sort(key=lambda seq: seq[-1])
                sequences = grown[: self.MAX_POOLS]
        finally:
            _rdlog.setLevel(RDLogger.WARNING)

        # Terminal-product guard. Membership, not equality: the final pool also
        # holds the leaving group and any spectator counter-ion from the reagent.
        winners = [seq for seq in sequences if target_smiles in seq[-1]]
        if not winners:
            logger.info(
                "MECHANISM_MISMATCH template=%s archetype=%s expected=%s got=%s",
                template_id, archetype_id, target_smiles,
                [".".join(seq[-1]) for seq in sequences[:3]])
            return Resolution(status="no_mechanism")
        if len(winners) > 1:
            logger.info("MECHANISM_AMBIGUOUS template=%s archetype=%s survivors=%d",
                        template_id, archetype_id, len(winners))
        winner = winners[0]     # sequences are canonically sorted, so this is stable

        steps = [
            Step(label=spec["label"], caption=spec["caption"],
                 smiles=".".join(pool), rate_determining=spec["rate_determining"])
            for spec, pool in zip(archetype["steps"], winner[1:])
        ]
        return Resolution(status="resolved", steps=steps, archetype=archetype_id,
                          reaction_class=archetype["class"])
```

Then add below `ENGINE = MechanismEngine()`:

```python


def resolve_mechanism(substrate: str, reagent: str, product: str,
                      template_id: str | None, steps_taken: int = 1) -> Resolution:
    """Module-level convenience over the singleton engine."""
    return ENGINE.resolve(substrate, reagent, product, template_id, steps_taken)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python test_mechanisms.py`
Expected: `17 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add mechanism_engine.py test_mechanisms.py
git commit -m "Fire mechanism archetypes and guard on the engine's product"
```

---

### Task 3: The remaining four archetypes

Every SMARTS below has been verified to fire and pass the guard against the cases in Step 3.

**Files:**
- Modify: `mechanisms.json`
- Modify: `reaction_templates.json`
- Modify: `test_mechanisms.py`

**Interfaces:**
- Consumes: everything from Tasks 1–2. No new names.
- Produces: archetype ids `e2`, `proton_transfer`, `electrophilic_addition_hx`, `nucleophilic_addition_carbonyl`.

- [ ] **Step 1: Write the failing tests**

Replace the `check("the 20 SN2 templates are tagged", ...)` block in `test_mechanisms.py` with:

```python
counts = {}
for mid in ENGINE.template_mechanism.values():
    counts[mid] = counts.get(mid, 0) + 1
check("all five archetypes are tagged with the expected counts",
      counts == {"sn2": 20, "electrophilic_addition_hx": 12,
                 "nucleophilic_addition_carbonyl": 8, "proton_transfer": 6,
                 "e2": 3, None: 5},
      f"got {counts}")
```

And append these cases before the `# ── Summary ──` block:

```python
# One representative per archetype, each a real substrate/reagent/product triple.
ARCHETYPE_CASES = [
    ("e2 with t-BuOK",            "CCC(C)Br", "CC(C)(C)[O-].[K+]", "CC=CC",       "e2_elim_hbr",             1),
    ("proton transfer, alcohol",  "CCO",      "CC(C)(C)[O-].[K+]", "CC[O-]",      "alcohol_deprotonation",   1),
    ("proton transfer, alkyne",   "C#CC",     "CC(C)[N-]C(C)C.[Li+]", "[C-]#CC",  "acetylide_deprotonation", 1),
    ("HBr addition, Markovnikov", "CC(C)=C",  "Br",                "CC(C)(C)Br",  "hbr_markovnikov_geminal", 2),
    ("Grignard onto a ketone",    "CC(C)=O",  "C[Mg]Br",           "CC(C)(C)O",   "grignard_ketone",         2),
    ("NaBH4 onto an aldehyde",    "CCC=O",    "[BH4-].[Na+]",      "CCCO",        "nabh4_aldehyde",          2),
    ("LiAlH4 onto a ketone",      "CC(C)=O",  "[AlH4-].[Li+]",     "CC(C)O",      "lialh4_ketone",           2),
]
for label, substrate, reagent, product, tid, n_steps in ARCHETYPE_CASES:
    res = resolve_mechanism(substrate, reagent, product, tid)
    check(f"{label} resolves", res.status == "resolved", f"got {res.status}")
    check(f"{label} has {n_steps} step(s)", len(res.steps) == n_steps,
          f"got {len(res.steps)}")
    check(f"{label} ends on the engine's product",
          bool(res.steps) and product in res.steps[-1].smiles.split("."),
          f"got {res.steps[-1].smiles if res.steps else None}")

# The Markovnikov branch is chosen by the guard, not by the SMARTS: step 1 fires
# both protonation directions and only the one reaching the engine's product
# survives. The intermediate must therefore be the tertiary cation.
markov = resolve_mechanism("CC(C)=C", "Br", "CC(C)(C)Br", "hbr_markovnikov_geminal")
check("the guard picks the tertiary carbocation, not the primary one",
      "C[C+](C)C" in markov.steps[0].smiles.split("."),
      f"got {markov.steps[0].smiles if markov.steps else None}")

not_app = resolve_mechanism("C=CCC", "[HH]", "CCCC", "alkene_hydrogenation")
check("a mechanism:null template reports not_applicable",
      not_app.status == "not_applicable", f"got {not_app.status}")
check("not_applicable carries the curated reason",
      bool(not_app.note) and "surface" in not_app.note.lower(),
      f"got {not_app.note!r}")
check("not_applicable produces no steps", not_app.steps == [])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python test_mechanisms.py`
Expected: FAIL on the archetype-count case and on every case whose archetype is not yet in `mechanisms.json`.

- [ ] **Step 3: Add the four archetypes to `mechanisms.json`**

Append these to the `archetypes` array, after `sn2`:

```json
    {
      "id": "e2",
      "name": "E2 — bimolecular elimination",
      "class": "E2",
      "provenance": "Hartenfeller M. et al., J. Chem. Inf. Model. 2011, 51, 3093-3098; Clayden ch. 17. Concerted anti-periplanar elimination.",
      "steps": [
        {
          "label": "Concerted anti-periplanar elimination",
          "rate_determining": true,
          "caption": "The base removes a hydrogen from the carbon next to the leaving group at the same moment the leaving group departs and the π bond forms. The hydrogen and the leaving group must be anti-periplanar for the orbitals to overlap, which is why this is one step and not two.",
          "variants": [
            "[C;!H0:1][C:2][Br,Cl,I:3].[O,N;-1:4]>>[C:1]=[C:2].[*;-1:3].[*;+0;H1:4]"
          ]
        }
      ]
    },
    {
      "id": "proton_transfer",
      "name": "Proton transfer (acid–base)",
      "class": "Acid–base",
      "provenance": "Clayden ch. 8. Simple Brønsted proton transfer to a base; no carbon skeleton changes.",
      "steps": [
        {
          "label": "Deprotonation",
          "rate_determining": false,
          "caption": "The base takes the most acidic proton. No bonds to carbon are made or broken — only a proton moves, and the negative charge ends up wherever it is best stabilised.",
          "variants": [
            "[O,S;!H0:1].[O,N,C;-1:2]>>[*;-1:1].[*;+0;H1:2]",
            "[C:9](=[O:8])[C;!H0:1].[O,N,C;-1:2]>>[C:9]([O-:8])=[C:1].[*;+0;H1:2]",
            "[CX2;!H0:1]#[CX2:3].[O,N,C;-1:2]>>[C;-1:1]#[C:3].[*;+0;H1:2]"
          ]
        }
      ]
    },
    {
      "id": "electrophilic_addition_hx",
      "name": "Electrophilic addition of H–X (Markovnikov)",
      "class": "Addition",
      "provenance": "Clayden ch. 19. Two steps through a discrete carbocation; Markovnikov selectivity follows from which cation is more stable.",
      "steps": [
        {
          "label": "Protonation of the alkene",
          "rate_determining": true,
          "caption": "The π bond acts as the nucleophile and attacks H–X. The proton adds to the carbon that gives the more stable carbocation, which is why the halide ends up on the more substituted carbon.",
          "variants": [
            "[CX3:1]=[CX3:2].[Br,Cl,I;H1:3]>>[C+:1][C:2].[*;-1;H0:3]"
          ]
        },
        {
          "label": "Halide capture",
          "rate_determining": false,
          "caption": "The halide attacks the planar carbocation. It can approach from either face, so a new stereocentre formed here is racemic.",
          "variants": [
            "[C+:1].[Br,Cl,I;-1:2]>>[C;+0:1][*;+0:2]"
          ]
        }
      ]
    },
    {
      "id": "nucleophilic_addition_carbonyl",
      "name": "Nucleophilic addition to a carbonyl",
      "class": "Addition",
      "provenance": "Clayden ch. 6 and ch. 9. Nucleophile adds to the carbonyl carbon; the alkoxide is protonated on workup.",
      "steps": [
        {
          "label": "Nucleophilic attack on the carbonyl carbon",
          "rate_determining": true,
          "caption": "The nucleophile attacks the electrophilic carbonyl carbon. The π electrons move onto oxygen, the carbon rehybridises from sp² to sp³, and the result is a tetrahedral alkoxide.",
          "variants": [
            "[C:1][Mg:5][Br,Cl,I:6].[C:2]=[O:3]>>[C:1][C:2][O-:3].[Mg:5][*:6]",
            "[C;H0:2]=[O:3].[B,Al;H4;-1:5]>>[C;H1:2][O-:3].[B,Al;H3;+0:5]",
            "[C;H1:2]=[O:3].[B,Al;H4;-1:5]>>[C;H2:2][O-:3].[B,Al;H3;+0:5]",
            "[C:2]=[O:3].[C;-1:1]#[N:4]>>[C:2]([O-:3])[C;+0:1]#[N;+0:4]"
          ]
        },
        {
          "label": "Protonation on workup",
          "rate_determining": false,
          "caption": "Dilute acid added at the end of the reaction protonates the alkoxide to give the alcohol. This is a separate operation, not part of the reaction itself — the alkoxide is what exists in the flask beforehand.",
          "variants": [
            "[C:1][O-:2]>>[C:1][O;H1;+0:2]"
          ]
        }
      ]
    }
```

- [ ] **Step 4: Tag the remaining templates and mark the nulls**

Run this once:

```python
import json

TAGS = {
    "e2": ["e2_elim_hbr", "e2_elim_hcl", "e2_elim_hi"],
    "proton_transfer": [
        "kinetic_enolate", "enolate_protonation", "ammonium_deprotonation",
        "acetylide_deprotonation", "alcohol_deprotonation", "carboxylate_deprotonation",
    ],
    "electrophilic_addition_hx": [
        "hbr_markovnikov_terminal", "hbr_markovnikov_disubstituted",
        "hbr_markovnikov_geminal", "hbr_addition_internal",
        "hcl_markovnikov_terminal", "hcl_markovnikov_disubstituted",
        "hcl_markovnikov_geminal", "hcl_addition_internal",
        "hi_markovnikov_terminal", "hi_markovnikov_disubstituted",
        "hi_markovnikov_geminal", "hi_addition_internal",
    ],
    "nucleophilic_addition_carbonyl": [
        "grignard_aldehyde", "grignard_ketone", "grignard_formaldehyde",
        "nabh4_aldehyde", "nabh4_ketone", "lialh4_aldehyde", "lialh4_ketone",
        "cyanohydrin_formation",
    ],
}

NULLS = {
    "alkene_hydrogenation":
        "Heterogeneous Pd surface chemistry; not meaningfully described by arrow pushing.",
    "alkyne_hydrogenation_full":
        "Heterogeneous Pd surface chemistry; not meaningfully described by arrow pushing.",
    "alkyne_lindlar":
        "Heterogeneous poisoned-catalyst surface chemistry; not meaningfully described by arrow pushing.",
    "alkene_dihydroxylation":
        "Concerted [3+2] cycloaddition onto OsO4; the arrow pushing adds nothing an undergraduate can use.",
    "nitro_reduction":
        "Multi-stage dissolving-metal reduction through nitroso and hydroxylamine; no single arrow-pushing sequence describes it.",
}

path = "reaction_templates.json"
data = json.load(open(path, encoding="utf-8"))
by_id = {t["id"]: t for t in data["templates"]}

for archetype, ids in TAGS.items():
    for tid in ids:
        assert tid in by_id, f"unknown template id: {tid}"
        by_id[tid]["mechanism"] = archetype
for tid, note in NULLS.items():
    assert tid in by_id, f"unknown template id: {tid}"
    by_id[tid]["mechanism"] = None
    by_id[tid]["mechanism_note"] = note

json.dump(data, open(path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
open(path, "a", encoding="utf-8").write("\n")
tagged = sum(1 for t in data["templates"] if t.get("mechanism"))
print(f"{tagged} tagged, {len(NULLS)} marked not-applicable")
```

Expected: `49 tagged, 5 marked not-applicable`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python test_mechanisms.py`
Expected: `42 passed, 0 failed`

- [ ] **Step 6: Confirm the reaction engine still passes**

Run: `python test_templates.py`
Expected: existing pass count, 0 failed.

- [ ] **Step 7: Commit**

```bash
git add mechanisms.json reaction_templates.json test_mechanisms.py
git commit -m "Add E2, proton transfer, electrophilic addition and carbonyl addition archetypes"
```

---

### Task 4: `POST /mechanism`

**Files:**
- Modify: `mechanism_engine.py` (add `to_payload`)
- Modify: `test_mechanisms.py`
- Modify: `app.py` (request model, endpoint, LLM fallback, rate-limit tier)
- Modify: `frontend/next.config.mjs`

**Interfaces:**
- Consumes: `Resolution`, `resolve_mechanism` from Tasks 1–3.
- Produces:
  - `mechanism_engine.to_payload(resolution: Resolution) -> dict` — the wire shape `{status, archetype, reaction_class, steps: [{label, caption, smiles, rate_determining}], note}`
  - `POST /mechanism` accepting `{substrate_smiles, reagent_smiles, product_smiles, template_id, reaction_name, steps_taken, engine}` and returning that payload with `status` in `resolved | not_applicable | unverified | unavailable`.

- [ ] **Step 1: Write the failing test for `to_payload`**

Append to `test_mechanisms.py` before the summary block:

```python
from mechanism_engine import to_payload

payload = to_payload(resolve_mechanism("CCCCBr", "[OH-].[Na+]", "CCCCO", "sn2_br_oh"))
check("payload reports the resolved status", payload["status"] == "resolved")
check("payload carries the archetype and class",
      payload["archetype"] == "sn2" and payload["reaction_class"] == "SN2")
check("payload steps are plain dicts with the wire keys",
      payload["steps"] and set(payload["steps"][0]) ==
      {"label", "caption", "smiles", "rate_determining"},
      f"got {payload['steps'][0].keys() if payload['steps'] else None}")
check("payload note is null when resolved", payload["note"] is None)

na = to_payload(resolve_mechanism("C=CCC", "[HH]", "CCCC", "alkene_hydrogenation"))
check("not_applicable payload carries the note and no steps",
      na["status"] == "not_applicable" and na["note"] and na["steps"] == [])
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python test_mechanisms.py`
Expected: `ImportError: cannot import name 'to_payload'`

- [ ] **Step 3: Implement `to_payload`**

Add to `mechanism_engine.py`, next to `resolve_mechanism`:

```python
def to_payload(resolution: Resolution) -> dict:
    """Resolution → the /mechanism wire shape. app.py maps the "no_mechanism"
    status onto the LLM fallback before calling this."""
    return {
        "status": resolution.status,
        "archetype": resolution.archetype,
        "reaction_class": resolution.reaction_class,
        "steps": [
            {"label": s.label, "caption": s.caption, "smiles": s.smiles,
             "rate_determining": s.rate_determining}
            for s in resolution.steps
        ],
        "note": resolution.note,
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python test_mechanisms.py`
Expected: `47 passed, 0 failed`

- [ ] **Step 5: Add the endpoint to `app.py`**

Add `"/mechanism"` to the `RATE_LIMIT_HEAVY` set (around `app.py:708`) so it reads:

```python
RATE_LIMIT_HEAVY = {
    "/analyze", "/react-from-image", "/react", "/pathways",
    "/explain", "/chat", "/assist", "/stereo", "/mechanism",
}
```

Add the import near the other engine imports:

```python
from mechanism_engine import resolve_mechanism, to_payload
```

Then add this immediately after the `/stereo` endpoint (which ends around `app.py:2640`):

```python
class MechanismRequest(BaseModel):
    substrate_smiles: str
    reagent_smiles: str
    product_smiles: str
    template_id: Optional[str] = None
    reaction_name: str = ""
    steps_taken: int = 1
    engine: Optional[EngineConfig] = None


def _mechanism_prompts(substrate: str, reagent: str, product: str,
                       reaction_name: str) -> tuple[str, str]:
    system = (
        "You are an organic chemistry mechanism assistant for Orgo AI. "
        "Orgo AI's curated mechanism library has NO archetype for this "
        "reaction — that reflects a gap in curated coverage, not proof that "
        "no mechanism exists.\n\n"
        "The starting material, reagent and product below were computed by a "
        "verified engine and are ground truth. Your job is to propose the "
        "stepwise mechanism connecting them.\n\n"
        # See the phrasing note in _blind_guess_prompts — the Parley gateway
        # content-filters output-suppression directives.
        "GUIDELINES:\n"
        "- Never contradict or re-derive the given product. Your last step "
        "MUST end at it.\n"
        "- Each step's `smiles` is the species present after that step, as "
        "valid SMILES. Use '.' to separate co-existing fragments.\n"
        "- Two to four steps. This is an unverified proposal and will be "
        "labeled as such to the student.\n"
        "- Format your answer as a JSON object with the shape below.\n"
        "- JSON shape exactly: "
        '{"steps": [{"label": "<3-6 word step name>", "caption": "<1-2 '
        'sentences, under 240 characters>", "smiles": "<valid SMILES>", '
        '"rate_determining": true | false}]}\n'
        '- If you cannot propose a mechanism you believe in, return '
        '{"steps": []}.'
    )
    user = (
        "Propose the stepwise mechanism for this reaction.\n\n"
        f"Starting material (SMILES): {substrate}\n"
        f"Reagent(s) (SMILES): {reagent}\n"
        f"Product (SMILES, ground truth): {product}\n"
        f"Reaction type: {reaction_name or 'unknown'}\n\n"
        "Answer as a JSON object."
    )
    return system, user


async def _maybe_llm_mechanism(req: MechanismRequest,
                               user_id: str | None) -> list[dict] | None:
    """Unverified fallback for a reaction with no curated archetype.

    Mirrors _maybe_blind_guess: every intermediate is RDKit-validated before it
    leaves the backend, and one unparseable step discards the whole mechanism
    rather than rendering a gap. Never raises."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        _enforce_hosted_quota(req.engine, user_id)
    except HTTPException:
        logger.info("mechanism fallback skipped: hosted quota reached (user=%s)",
                    user_id or "anon")
        return None
    try:
        system, user = _mechanism_prompts(
            req.substrate_smiles, req.reagent_smiles, req.product_smiles,
            req.reaction_name)
        raw = await _anthropic_complete(system, user, max_tokens=700)
        data = _parse_json_object(raw)
        raw_steps = (data or {}).get("steps") or []
        if not raw_steps or len(raw_steps) > 6:
            return None
        loop = asyncio.get_event_loop()
        steps: list[dict] = []
        for entry in raw_steps:
            canon = await loop.run_in_executor(
                _chem_pool, _validate_and_canonicalize_smiles, str(entry.get("smiles", "")))
            if canon is None:
                logger.info("mechanism fallback discarded: RDKit rejected %r",
                            entry.get("smiles"))
                return None
            steps.append({
                "label": str(entry.get("label") or "Step")[:60],
                "caption": str(entry.get("caption") or "")[:280],
                "smiles": canon,
                "rate_determining": bool(entry.get("rate_determining")),
            })
        return steps
    except Exception as exc:
        logger.warning("mechanism fallback failed (%s): %s", type(exc).__name__, exc)
        return None


@app.post("/mechanism")
async def mechanism(req: MechanismRequest, user_id: str | None = Depends(require_auth)):
    """Stepwise mechanism for one engine-verified reaction.

    The curated path is fully deterministic and makes NO model call — captions
    are authored in mechanisms.json and intermediates are computed by RDKit —
    so it also spends no hosted quota. The LLM appears only when no archetype
    covers the reaction, and its output is labeled `unverified`."""
    resolution = resolve_mechanism(
        req.substrate_smiles, req.reagent_smiles, req.product_smiles,
        req.template_id, req.steps_taken)

    if resolution.status in ("resolved", "not_applicable"):
        return to_payload(resolution)

    steps = await _maybe_llm_mechanism(req, user_id)
    if not steps:
        return {"status": "unavailable", "archetype": None, "reaction_class": None,
                "steps": [], "note": "No mechanism is available for this reaction yet."}
    return {"status": "unverified", "archetype": None, "reaction_class": None,
            "steps": steps, "note": None}
```

- [ ] **Step 6: Add the route to the Next.js proxy**

In `frontend/next.config.mjs`, add `'mechanism',` to `apiPaths` after `'stereo',`.

- [ ] **Step 7: Verify the endpoint by hand**

Start the backend: `uvicorn app:app --host 0.0.0.0 --port 8000`

```bash
curl -s localhost:8000/mechanism -H 'Content-Type: application/json' -d '{
  "substrate_smiles": "CCCCBr", "reagent_smiles": "[OH-].[Na+]",
  "product_smiles": "CCCCO", "template_id": "sn2_br_oh",
  "reaction_name": "SN2: alkyl bromide + hydroxide", "steps_taken": 1 }'
```

Expected: `"status":"resolved"`, `"reaction_class":"SN2"`, one step whose `smiles` contains `CCCCO`.

```bash
curl -s localhost:8000/mechanism -H 'Content-Type: application/json' -d '{
  "substrate_smiles": "C=CCC", "reagent_smiles": "[HH]",
  "product_smiles": "CCCC", "template_id": "alkene_hydrogenation", "steps_taken": 1 }'
```

Expected: `"status":"not_applicable"` with the surface-chemistry note and `"steps":[]`.

- [ ] **Step 8: Commit**

```bash
git add mechanism_engine.py test_mechanisms.py app.py frontend/next.config.mjs
git commit -m "Serve mechanisms over POST /mechanism"
```

---

### Task 5: Frontend API client and types

**Files:**
- Modify: `frontend/src/api.js`
- Modify: `frontend/src/types.ts`

**Interfaces:**
- Consumes: `POST /mechanism` from Task 4.
- Produces:
  - `api.fetchMechanism(reactionData: object) -> Promise<Mechanism>`
  - `types.MechanismStep` = `{ label: string; caption: string; smiles: string; rate_determining: boolean }`
  - `types.Mechanism` = `{ status: 'resolved' | 'not_applicable' | 'unverified' | 'unavailable'; archetype: string | null; reaction_class: string | null; steps: MechanismStep[]; note: string | null }`
  - `ChatMessage.mechanism?: Mechanism`

- [ ] **Step 1: Add the types**

In `frontend/src/types.ts`, add above `ChatMessage`:

```ts
export type MechanismStep = {
  label: string
  caption: string
  smiles: string
  rate_determining: boolean
}

// A mechanism is fetched once and stored on its message, so a reopened session
// shows what it already computed — and on the `unverified` path does not pay
// for it a second time.
export type Mechanism = {
  status: 'resolved' | 'not_applicable' | 'unverified' | 'unavailable'
  archetype: string | null
  reaction_class: string | null
  steps: MechanismStep[]
  note: string | null
}
```

And add one field to `ChatMessage`:

```ts
  mechanism?: Mechanism
```

- [ ] **Step 2: Add the API call**

In `frontend/src/api.js`, after `reactFromImage`:

```js
// Stepwise mechanism for one engine-verified reaction. `reaction` is the
// `reaction_result` tool-result payload; the mechanism covers its PRIMARY
// product only (products[0]), which is what the banner draws.
export async function fetchMechanism(reaction) {
  const product = (reaction?.products ?? [])[0]
  if (!product) throw new Error('No product to explain a mechanism for.')
  return post('/mechanism', {
    substrate_smiles: reaction.substrate_smiles,
    reagent_smiles: reaction.reagent_smiles,
    product_smiles: product.smiles,
    template_id: product.template_id ?? null,
    reaction_name: product.reaction_name ?? '',
    steps_taken: product.steps_taken ?? 1,
    ...getEnginePayload(),
  })
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors. (`api.js` is untyped JS; this checks `types.ts` and its consumers.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api.js frontend/src/types.ts
git commit -m "Add the mechanism API client and types"
```

---

### Task 6: `MechanismView` component

**Files:**
- Create: `frontend/src/components/MechanismView.tsx`
- Modify: `frontend/src/App.css`

**Interfaces:**
- Consumes: `Mechanism`, `MechanismStep` from Task 5; `StructureView` (`{ smiles, width, height, className }`).
- Produces: default export `MechanismView({ mechanism }: { mechanism: Mechanism | null })`.

- [ ] **Step 1: Write the component**

```tsx
'use client'

import { ArrowDown, FlaskConical, Info, Zap } from 'lucide-react'
import type { Mechanism } from '../types'
import StructureView from './StructureView'

const MOL_W = 150
const MOL_H = 104

// Stepwise mechanism for one reaction. Renders the same way whether the steps
// came from the curated archetype library or the LLM fallback — only the source
// line differs, and it says so plainly.
export default function MechanismView({ mechanism }: { mechanism: Mechanism | null }) {
  if (!mechanism) return null

  if (mechanism.status === 'not_applicable' || mechanism.status === 'unavailable') {
    return (
      <div className="mechanism-box">
        <div className="mechanism-note">
          <Info size={13} />
          {mechanism.note ?? 'No mechanism is available for this reaction yet.'}
        </div>
      </div>
    )
  }

  const unverified = mechanism.status === 'unverified'

  return (
    <div className="mechanism-box">
      <div className="mechanism-head">
        <span className="mechanism-class">
          <FlaskConical size={13} />
          {mechanism.reaction_class ?? 'Mechanism'}
        </span>
        <span className={`mechanism-source${unverified ? ' unverified' : ''}`}>
          {unverified ? 'AI-generated · unverified' : 'Template library'}
        </span>
      </div>

      {mechanism.steps.map((step, index) => (
        <div key={index} className="mechanism-step">
          {index > 0 && <ArrowDown size={16} className="mechanism-arrow" />}
          <div className="mechanism-step-body">
            <div className="mechanism-step-head">
              <span className="mechanism-step-n">{index + 1}</span>
              <span className="mechanism-step-label">{step.label}</span>
              {step.rate_determining && (
                <span className="mechanism-rds">
                  <Zap size={11} />
                  rate-determining
                </span>
              )}
            </div>
            <div className="mechanism-step-mols">
              {step.smiles.split('.').map((fragment, fragIndex) => (
                <StructureView key={fragIndex} smiles={fragment}
                               width={MOL_W} height={MOL_H} />
              ))}
            </div>
            <p className="mechanism-caption">{step.caption}</p>
          </div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Add the styles**

Append to `frontend/src/App.css`, after the `.chat-explain-btn` rules (around line 4782):

```css
/* ── Reaction tab: stepwise mechanism ─────────────────────────────────────── */
.mechanism-box {
  width: 100%;
  margin-top: 8px;
  padding: 12px 14px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 12px;
}

.mechanism-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 10px;
  margin-bottom: 10px;
  border-bottom: 1px solid var(--border);
}

.mechanism-class {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.mechanism-source { font-size: 10px; color: var(--muted); }
.mechanism-source.unverified { color: var(--danger); font-weight: 500; }

.mechanism-step { display: flex; flex-direction: column; align-items: center; }
.mechanism-arrow { color: var(--muted); margin: 2px 0 6px; flex-shrink: 0; }
.mechanism-step-body { width: 100%; }

.mechanism-step-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 6px;
}

.mechanism-step-n {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 50%;
  flex-shrink: 0;
}

.mechanism-step-label { font-size: 12px; font-weight: 600; color: var(--text); }

.mechanism-rds {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  color: var(--muted);
}

.mechanism-step-mols {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.mechanism-caption {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
}

.mechanism-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/MechanismView.tsx frontend/src/App.css
git commit -m "Render stepwise mechanisms with drawn intermediates"
```

---

### Task 7: Wire the button into `ChatPanel`

**Files:**
- Modify: `frontend/src/platform/ChatPanel.tsx`

**Interfaces:**
- Consumes: `fetchMechanism` (Task 5), `MechanismView` (Task 6), `Mechanism` type (Task 5).
- Produces: the finished feature. Nothing downstream.

- [ ] **Step 1: Add the imports**

In `frontend/src/platform/ChatPanel.tsx`, extend the existing imports:

```tsx
import { Camera, FileText, FlaskConical, Network, Paperclip, Sparkles, Workflow, X, Zap } from 'lucide-react'
import type { ChatAttachment, ChatContent, ChatMessage, ChatToolResult, Mechanism } from '../types'
import { fetchMechanism, reactFromImage, streamChat } from '../api'
import MechanismView from '../components/MechanismView'
```

- [ ] **Step 2: Add the state and handler**

Add next to the existing `explainMessage` (around `ChatPanel.tsx:337`):

```tsx
  // Messages whose mechanism is currently being fetched, by message id.
  const [mechanismLoading, setMechanismLoading] = useState<string | null>(null)

  // A mechanism can be asked for on any bubble carrying an engine result —
  // unlike Explanation, it is NOT gated on empty content, because wanting the
  // mechanism after reading the explanation is the normal case.
  function canShowMechanism(message: ChatMessage): boolean {
    return message.role === 'assistant'
      && Boolean(message.toolResults?.some(result => result.type === 'reaction_result'))
  }

  // Fetch once and store on the message, so it persists to localStorage through
  // the same onChange/onSave path as streamed content.
  async function mechanismFor(message: ChatMessage) {
    if (mechanismLoading || streaming || saving) return
    const hit = message.toolResults?.slice().reverse()
      .find(result => result.type === 'reaction_result')
    if (!hit) return
    setMechanismLoading(message.id)
    try {
      const mechanism = (await fetchMechanism(hit.data)) as Mechanism
      const next: ChatContent = {
        ...data,
        messages: messages.map(entry => (
          entry.id === message.id ? { ...entry, mechanism } : entry
        )),
      }
      onChange(next)
      await onSave(next)
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not build a mechanism.', 'error')
    } finally {
      setMechanismLoading(null)
    }
  }
```

`notify` is the existing toast helper already destructured from `useToast()` at `ChatPanel.tsx:262`; this matches the error handling at `ChatPanel.tsx:290`.

- [ ] **Step 3: Render the button and the view**

Replace the `canExplain(message) && (...)` block in the bubble (around `ChatPanel.tsx:551-561`) with:

```tsx
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
            {canShowMechanism(message) && !message.mechanism && (
              <button
                type="button"
                className="chat-explain-btn"
                onClick={() => void mechanismFor(message)}
                disabled={streaming || saving || mechanismLoading === message.id}
              >
                <Workflow size={13} />
                {mechanismLoading === message.id ? 'Building mechanism…' : 'Mechanism'}
              </button>
            )}
            {message.mechanism && <MechanismView mechanism={message.mechanism} />}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Verify at runtime**

Use the `verify` skill to launch the app, then in the **Reaction** tab:

1. Type `react 1-bromobutane with NaOH`. The card and banner appear. Press **Mechanism** → one concerted SN2 step, badge `SN2`, source line "Template library", rate-determining marker present.
2. Type `react 2-methylpropene with HBr`. Press **Mechanism** → two steps; step 1's intermediate is the **tertiary** carbocation, not the primary one; step 1 is marked rate-determining.
3. Type `react 1-butene with H2 over Pd`. Press **Mechanism** → the not-applicable note about surface chemistry, no steps. Confirm the backend log shows no Anthropic call for this request.
4. Find a reaction whose product ASKCOS names `Predicted (unnamed)`. Press **Mechanism** → steps render with the source line **"AI-generated · unverified"**.
5. Reload the page. Every mechanism above is still rendered and its button is gone.
6. Press **Explanation** on any of them and confirm it streams prose exactly as before.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/platform/ChatPanel.tsx
git commit -m "Add the Mechanism button to reaction bubbles"
```

---

## Notes for the implementer

**Why the guard matters more than coverage.** It is tempting, when an archetype fails the terminal-product guard, to "fix" it by forcing the last step to be the engine's product and generating only the intermediates in between. Do not. That hides drift instead of surfacing it: if the archetype was wrong at step 2, you get a wrong intermediate leading to a right product, which is the most confusing possible output for a student. A missing mechanism is an honest gap; a wrong one is a defect.

**Reading the logs.** After this ships, `MECHANISM_MISMATCH` lines name the exact template and archetype that disagreed. Each one is either a bug in an archetype's SMARTS or a template that was tagged with the wrong archetype. That log is the curation backlog, the same way `TEMPLATE_GAP endpoint=react_unnamed` is the backlog for missing reaction names.

**What comes next (not in this plan).** Curly arrows. The step SMARTS are fully atom-mapped specifically so the bond-order and formal-charge deltas between each step's reactant and product templates are computable — that delta is what an arrow draws. The next project reads those deltas and overlays SVG arcs on the structures `MechanismView` already renders.
