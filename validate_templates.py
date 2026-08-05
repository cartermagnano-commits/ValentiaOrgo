"""
validate_templates.py — Generic safety gates for the reaction template library.

Run this before committing ANY change to reaction_templates.json or reagents.py:

    python validate_templates.py

Unlike test_templates.py (which asserts specific chemistry, one case at a time),
every gate here runs across ALL templates automatically with no per-template
authoring. That is the point: as the library grows past a few dozen entries,
hand-review stops being able to hold the line on mechanical errors, and these
gates keep catching them at zero marginal cost per template.

Gates
  1. Schema        — required fields present, ids unique
  2. SMARTS        — parses as a reaction, has reactant + product sides,
                     atom maps are balanced (no map number invented on the
                     product side, which silently fabricates atoms)
  3. Wiring        — every template condition tag is carried by >= 1 reagent,
                     otherwise the template is dead on arrival
  4. Conservation  — across a firing sweep, no product may contain an element
                     in greater count than substrate + reagent supplied.
                     Atoms may LEAVE (leaving groups); they may never APPEAR.

Exit code is non-zero if any gate fails, so this can gate a commit hook or CI.
"""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem

from reagents import REAGENT_LIST

RDLogger.DisableLog("rdApp.*")

TEMPLATE_FILE = Path(__file__).parent / "reaction_templates.json"
REQUIRED_FIELDS = {"id", "name", "smarts", "conditions"}

# Substrates used for the conservation sweep. Extend when adding a template for
# a functional group not represented here, or gate 4 simply won't exercise it.
SWEEP_SUBSTRATES = [
    "CC(C)=O", "CCC=O", "CC(=O)OC", "CC(=O)Cl", "CC(=O)N", "CC(=O)O",
    "CCBr", "CCI", "CCCl", "CCO", "CC(C)(C)O",
    "C=CC", "C#CC", "c1ccccc1", "Cc1ccccc1", "N#Cc1ccccc1", "CC#N",
    "CCN", "CC(=O)CC", "O=Cc1ccccc1", "CCOC(C)=O", "C1CCCCC1=O",
]

failures: list[str] = []


def fail(gate: str, tid: str, detail: str) -> None:
    failures.append(f"[{gate}] {tid}: {detail}")


def gate_schema(templates: list[dict]) -> None:
    seen: set[str] = set()
    for i, t in enumerate(templates):
        tid = t.get("id", f"<index {i}>")
        missing = REQUIRED_FIELDS - set(t)
        if missing:
            fail("schema", tid, f"missing field(s) {sorted(missing)}")
        if tid in seen:
            fail("schema", tid, "duplicate id")
        seen.add(tid)
        if not isinstance(t.get("conditions", []), list):
            fail("schema", tid, "conditions must be a list")
        # Coupling templates pair two substrates via run_coupling() and are not
        # gated on reagent condition tags, so an empty list is correct for them.
        elif not t.get("conditions") and not t.get("coupling"):
            fail("schema", tid,
                 "conditions is empty on a non-coupling template — it can never be "
                 "selected. Add a condition tag, or mark it \"coupling\": true.")


def _map_numbers(mol) -> Counter:
    return Counter(a.GetAtomMapNum() for a in mol.GetAtoms() if a.GetAtomMapNum())


def gate_smarts(templates: list[dict]) -> None:
    for t in templates:
        tid, smarts = t.get("id", "?"), t.get("smarts", "")
        try:
            rxn = AllChem.ReactionFromSmarts(smarts)
        except Exception as exc:
            fail("smarts", tid, f"unparseable ({type(exc).__name__}: {exc})")
            continue
        if rxn is None:
            fail("smarts", tid, "ReactionFromSmarts returned None")
            continue
        if rxn.GetNumReactantTemplates() == 0:
            fail("smarts", tid, "no reactant side")
        if rxn.GetNumProductTemplates() == 0:
            fail("smarts", tid, "no product side")

        react_maps: Counter = Counter()
        for i in range(rxn.GetNumReactantTemplates()):
            react_maps += _map_numbers(rxn.GetReactantTemplate(i))
        prod_maps: Counter = Counter()
        for i in range(rxn.GetNumProductTemplates()):
            prod_maps += _map_numbers(rxn.GetProductTemplate(i))

        # A map number on the product side with no counterpart on the reactant
        # side means the transform invents a mapped atom out of nothing.
        invented = sorted(set(prod_maps) - set(react_maps))
        if invented:
            fail("smarts", tid, f"product map numbers absent from reactants: {invented}")
        if not react_maps:
            fail("smarts", tid, "no atom maps at all — transform is unconstrained")


def gate_wiring(templates: list[dict]) -> None:
    reagent_tags = {c for r in REAGENT_LIST for c in r.get("conditions", [])}
    for t in templates:
        # Coupling templates bypass condition matching entirely (run_coupling).
        if not t.get("enabled", True) or t.get("coupling"):
            continue
        tags = set(t.get("conditions", []))
        if not tags & reagent_tags:
            fail("wiring", t.get("id", "?"),
                 f"condition tag(s) {sorted(tags)} carried by no reagent — template is dead. "
                 f"Add a reagent in reagents.py with a matching tag.")


def _elements(smiles: str) -> Counter:
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return Counter()
    return Counter(a.GetSymbol() for a in mol.GetAtoms())


def gate_conservation(templates: list[dict], verbose: bool = False) -> int:
    """Fire every template across the sweep; assert no element is created."""
    from reactivity_engine import TemplateEngine

    engine = TemplateEngine()
    fired: set[str] = set()
    checked = 0

    for sub in SWEEP_SUBSTRATES:
        if Chem.MolFromSmiles(sub) is None:
            fail("conservation", sub, "sweep substrate is not valid SMILES")
            continue
        for reagent in REAGENT_LIST:
            try:
                branches = engine.run_for_reagent(
                    sub, reagent["smiles"], reagent["conditions"])
            except Exception as exc:
                fail("conservation", f"{sub} + {reagent['name']}",
                     f"engine raised {type(exc).__name__}: {exc}")
                continue
            available = _elements(sub) + _elements(reagent["smiles"])
            for b in branches:
                for step in b.get("steps", []):
                    if step.get("template_id"):
                        fired.add(step["template_id"])
                product = b.get("final_product", "")
                got = _elements(product)
                created = {el: n - available.get(el, 0)
                           for el, n in got.items() if n > available.get(el, 0)}
                checked += 1
                if created:
                    fail("conservation", f"{sub} + {reagent['name']} -> {product}",
                         f"element(s) created from nothing: {created}")
    # Coupling templates pair two substrates directly and are never reached by
    # run_for_reagent, so they need their own sweep or they'd look permanently
    # unfired and escape the conservation check entirely.
    for a in SWEEP_SUBSTRATES:
        for b in SWEEP_SUBSTRATES:
            try:
                results = engine.run_coupling(a, b)
            except Exception as exc:
                fail("conservation", f"couple {a} + {b}",
                     f"engine raised {type(exc).__name__}: {exc}")
                continue
            available = _elements(a) + _elements(b)
            for r in results:
                if r.get("template_id"):
                    fired.add(r["template_id"])
                product = r.get("product_smiles", "")
                got = _elements(product)
                created = {el: n - available.get(el, 0)
                           for el, n in got.items() if n > available.get(el, 0)}
                checked += 1
                if created:
                    fail("conservation", f"couple {a} + {b} -> {product}",
                         f"element(s) created from nothing: {created}")

    if verbose:
        print(f"  swept {checked} products across "
              f"{len(SWEEP_SUBSTRATES)}x{len(REAGENT_LIST)} reagent pairs "
              f"+ {len(SWEEP_SUBSTRATES)}^2 coupling pairs")
    return len(fired), fired


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=str(TEMPLATE_FILE))
    ap.add_argument("--show-unfired", action="store_true",
                    help="list enabled templates the sweep never exercised")
    args = ap.parse_args()

    templates = json.load(open(args.file, encoding="utf-8"))["templates"]
    enabled = [t for t in templates if t.get("enabled", True)]
    print(f"Loaded {len(templates)} templates ({len(enabled)} enabled), "
          f"{len(REAGENT_LIST)} reagents\n")

    gate_schema(templates)
    print(f"  gate 1 schema        {'ok' if not failures else 'see failures'}")
    n = len(failures)
    gate_smarts(templates)
    print(f"  gate 2 smarts        {'ok' if len(failures) == n else 'see failures'}")
    n = len(failures)
    gate_wiring(templates)
    print(f"  gate 3 wiring        {'ok' if len(failures) == n else 'see failures'}")
    n = len(failures)
    n_fired, fired = gate_conservation(templates, verbose=True)
    print(f"  gate 4 conservation  {'ok' if len(failures) == n else 'see failures'}")

    print(f"\nCoverage: {n_fired}/{len(enabled)} enabled templates fired in the sweep.")
    if args.show_unfired:
        unfired = sorted(t["id"] for t in enabled if t["id"] not in fired)
        for tid in unfired:
            print(f"    unfired: {tid}")
        print("  (unfired != broken — the sweep may lack that substrate class; "
              "add one to SWEEP_SUBSTRATES.)")

    if failures:
        print(f"\n{len(failures)} FAILURE(S):")
        for f in failures:
            print(f"  {f}")
        return 1
    print("\nAll gates passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
