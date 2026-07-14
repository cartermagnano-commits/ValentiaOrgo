"""
diagnose_templates.py — Standalone template diagnostic for Orgo AI.

Usage:
    python diagnose_templates.py
    python diagnose_templates.py --file path/to/reaction_templates.json
    python diagnose_templates.py --substrates "CC(=O)CCBr,CCBr,CCI,CCCl"

Reports:
  1. Load summary: total / enabled / disabled / parse failures
  2. Condition wiring: template condition tags vs the REAGENT_LIST catalog
  3. Per-template firing matrix across sample substrates (via the REAL engine —
     TemplateEngine.run_for_reagent over every reagent in reagents.py, so
     eligibility gating and chaining behave exactly as in the app)
  4. Dead templates (never fire on any sample substrate under any reagent)

A template listed as dead is NOT necessarily broken — it may just need a
substrate class missing from the sample set. Add one via --substrates before
concluding anything.
"""

import argparse
import json
import sys
from pathlib import Path

# Windows consoles default to cp1252, which can't print Greek letters in
# template names (e.g. "α-alkylation"); force UTF-8 output.
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from reagents import REAGENT_LIST

DEFAULT_TEMPLATE_FILE = Path(__file__).parent / "reaction_templates.json"

# Sample substrates covering the functional groups the template set targets.
# Extend this list when adding templates for a new substrate class.
DEFAULT_SUBSTRATES = [
    "CC(=O)CCBr",       # 4-bromobutan-2-one (ketone + alkyl bromide)
    "CCBr",             # ethyl bromide
    "CCC(C)Br",         # 2-bromobutane (secondary halide — E2/SN2)
    "CCI",              # ethyl iodide
    "CCCCl",            # propyl chloride
    "CC(=O)C",          # acetone
    "CC(=O)CC",         # butanone (unsymmetric ketone)
    "CCC=O",            # propanal (aldehyde)
    "C=O",              # formaldehyde
    "CCO",              # ethanol
    "CC(C)(C)O",        # tert-butanol
    "CC#C",             # propyne (terminal alkyne)
    "CC=CC",            # 2-butene (internal alkene)
    "C=C(C)C",          # isobutylene (1,1-disubstituted alkene)
    "C=CCC",            # 1-butene (monosubstituted alkene)
    "CC(=O)OCC",        # ethyl acetate (ester)
    "O=C1CCCO1",        # gamma-butyrolactone (lactone)
    "CC(=O)O",          # acetic acid
    "CC[NH3+]",         # ethylammonium (alkylation intermediate)
    "CC(C)=CC",         # 2-methyl-2-butene (trisubstituted alkene)
    # Intermediates & organometallics — these feed the coupling templates,
    # which pair molecules from the synthesis pool rather than reagents:
    "CC[Mg]Br",         # ethylmagnesium bromide (Grignard)
    "[C-]#CC",          # propynide (acetylide anion)
    "CC[O-]",           # ethoxide
    "C=C(C)[O-]",       # acetone enolate
]

DIVIDER = "-" * 70


def load_and_parse(template_file: Path):
    """Return (all_entries, parse_failures) — a parse check independent of the
    engine, so a bad SMARTS is reported by id instead of silently skipped."""
    from rdkit import RDLogger
    from rdkit.Chem import AllChem

    RDLogger.logger().setLevel(RDLogger.CRITICAL)
    try:
        data = json.loads(template_file.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"FATAL: could not read/parse {template_file}: {exc}")
        sys.exit(1)

    all_entries = data.get("templates", [])
    failures = []
    for entry in all_entries:
        if not entry.get("enabled", True):
            continue
        tid = entry.get("id", "<unnamed>")
        try:
            rxn = AllChem.ReactionFromSmarts(entry["smarts"])
            if rxn is None:
                raise ValueError("ReactionFromSmarts returned None")
            rxn.Initialize()
        except Exception as exc:
            failures.append({"id": tid, "reason": str(exc)})
    RDLogger.logger().setLevel(RDLogger.WARNING)
    return all_entries, failures


def main():
    parser = argparse.ArgumentParser(description="Orgo AI template diagnostic")
    parser.add_argument("--file", default=str(DEFAULT_TEMPLATE_FILE), help="Path to reaction_templates.json")
    parser.add_argument("--substrates", default=",".join(DEFAULT_SUBSTRATES), help="Comma-separated SMILES")
    args = parser.parse_args()

    template_file = Path(args.file)
    substrates = [s.strip() for s in args.substrates.split(",") if s.strip()]

    from reactivity_engine import TemplateEngine

    print(f"\nOrgo AI Template Diagnostic")
    print(f"Template file  : {template_file}")
    print(f"Test substrates: {len(substrates)}")
    print(f"Reagents       : {len(REAGENT_LIST)} (from reagents.py)")
    print(DIVIDER)

    # ── 1. Load ───────────────────────────────────────────────────────────────
    all_entries, failures = load_and_parse(template_file)
    engine = TemplateEngine(template_file)

    total    = len(all_entries)
    enabled  = sum(1 for e in all_entries if e.get("enabled", True))
    loaded   = len(engine.templates) + len(engine.coupling_templates)

    print(f"\nLOAD SUMMARY")
    print(f"  Total entries   : {total}")
    print(f"  Enabled         : {enabled}")
    print(f"  Disabled        : {total - enabled}")
    print(f"  Loaded by engine: {loaded} ({len(engine.templates)} reagent-based, {len(engine.coupling_templates)} coupling)")
    print(f"  Parse failures  : {len(failures)}")
    for f in failures:
        print(f"    [{f['id']}] {f['reason']}")

    # ── 2. Condition wiring ───────────────────────────────────────────────────
    # A non-coupling template whose condition tags appear on NO reagent can
    # never become eligible — it is statically dead no matter the substrate.
    reagent_tags = {c for r in REAGENT_LIST for c in r.get("conditions", [])}
    print(f"\nCONDITION WIRING")
    print(f"  Reagent catalog tags: {sorted(reagent_tags)}")
    unfireable = [
        t for t in engine.templates
        if t["conditions"] and not set(t["conditions"]) & reagent_tags
    ]
    if unfireable:
        print(f"  STATICALLY DEAD (conditions match no reagent):")
        for t in unfireable:
            print(f"    [{t['id']}] conditions={t['conditions']}")
    else:
        print(f"  All template condition tags are wired to at least one reagent. OK.")

    no_conditions = [t for t in engine.templates if not t["conditions"]]
    if no_conditions:
        print(f"  Non-coupling templates with EMPTY conditions (eligible under ALL reagents):")
        for t in no_conditions:
            print(f"    [{t['id']}] {t['name']}")

    # ── 3. Firing matrix (real engine, real reagents) ─────────────────────────
    fired_by: dict[str, set] = {t["id"]: set() for t in engine.templates}
    for sub in substrates:
        for reagent in REAGENT_LIST:
            try:
                branches = engine.run_for_reagent(sub, reagent["smiles"], reagent["conditions"])
            except Exception as exc:
                print(f"  ENGINE ERROR: {sub} + {reagent['name']}: {exc}")
                continue
            for b in branches:
                for step in b["steps"]:
                    if step.get("template_id") in fired_by:
                        fired_by[step["template_id"]].add(sub)

    # Coupling templates: try all ordered substrate pairs.
    coupling_fired: dict[str, set] = {t["id"]: set() for t in engine.coupling_templates}
    for a in substrates:
        for b_smi in substrates:
            if a == b_smi:
                continue
            try:
                for res in engine.run_coupling(a, b_smi):
                    if res["template_id"] in coupling_fired:
                        coupling_fired[res["template_id"]].add(f"{a}+{b_smi}")
            except Exception:
                continue

    print(f"\nFIRING SUMMARY (via TemplateEngine over all reagents)")
    for t in engine.templates:
        hits = fired_by[t["id"]]
        mark = f"fires on {len(hits)}" if hits else "DEAD on samples"
        print(f"  {t['id']:<38} {mark}")
    for t in engine.coupling_templates:
        hits = coupling_fired[t["id"]]
        mark = f"fires on {len(hits)} pair(s)" if hits else "DEAD on samples"
        print(f"  {t['id']:<38} {mark}  [coupling]")

    dead = [tid for tid, hits in {**fired_by, **coupling_fired}.items() if not hits]
    print(f"\n{len(dead)} template(s) never fired on the sample set."
          + (" Add a matching substrate via --substrates before concluding they are broken." if dead else ""))
    print(DIVIDER)
    print("Done.")


if __name__ == "__main__":
    main()
