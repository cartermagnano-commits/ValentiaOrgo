"""
test_templates.py — Regression suite for the reaction template engine.

Run before committing changes to reaction_templates.json, reagents.py, or
reactivity_engine.py:

    python test_templates.py

Plain Python on purpose (no pytest dependency): prints one PASS/FAIL line per
case and exits non-zero on any failure. Each behavior case runs the REAL
pipeline — TemplateEngine.run_for_reagent with the reagent's condition tags
exactly as wired in reagents.py — so it also catches condition-tag drift
between the reagent catalog and the template file.
"""

import json
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from rdkit import Chem

from reagents import REAGENT_LIST
from reactivity_engine import TemplateEngine

TEMPLATE_FILE = Path(__file__).parent / "reaction_templates.json"

REAGENTS = {r["name"]: r for r in REAGENT_LIST}

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


def canon(smi: str) -> str:
    mol = Chem.MolFromSmiles(smi)
    return Chem.MolToSmiles(mol) if mol else f"<invalid {smi}>"


def assert_invariants(name: str, branches: list[dict]) -> bool:
    """Structural invariants every engine result must satisfy."""
    finals = [b["final_product"] for b in branches]
    if len(finals) != len(set(finals)):
        check(name + " [invariant: unique finals]", False, str(finals))
        return False
    for b in branches:
        if Chem.MolFromSmiles(b["final_product"]) is None:
            check(name + " [invariant: valid product]", False, b["final_product"])
            return False
        idxs = [s["step_index"] for s in b["steps"]]
        if idxs != list(range(len(idxs))) or b["final_product"] != b["steps"][-1]["smiles"]:
            check(name + " [invariant: step chain]", False, str(idxs))
            return False
    return True


def react(name: str, substrate: str, reagent_name: str,
          expect: list[str] | None = None, forbid: list[str] | None = None,
          min_branches: int = 1):
    """Run substrate + named reagent through the engine; assert expectations."""
    r = REAGENTS[reagent_name]
    branches = engine.run_for_reagent(canon(substrate), r["smiles"], r["conditions"])
    if not assert_invariants(name, branches):
        return
    finals = {b["final_product"] for b in branches}
    problems = []
    if len(branches) < min_branches:
        problems.append(f"got {len(branches)} branches, want >= {min_branches}")
    for e in expect or []:
        if canon(e) not in finals:
            problems.append(f"missing expected product {canon(e)}; got {sorted(finals)}")
    for f in forbid or []:
        if canon(f) in finals:
            problems.append(f"forbidden product {canon(f)} present")
    check(name, not problems, "; ".join(problems))


def couple(name: str, mol_a: str, mol_b: str, expect: str):
    results = engine.run_coupling(canon(mol_a), canon(mol_b))
    prods = {r["product_smiles"] for r in results}
    check(name, canon(expect) in prods, f"want {canon(expect)}, got {sorted(prods)}")


engine = TemplateEngine()

# ── Load / wiring checks ──────────────────────────────────────────────────────

data = json.loads(TEMPLATE_FILE.read_text(encoding="utf-8"))
enabled = sum(1 for e in data.get("templates", []) if e.get("enabled", True))
loaded = len(engine.templates) + len(engine.coupling_templates)
check("all enabled templates parse and load", loaded == enabled,
      f"{loaded} loaded vs {enabled} enabled — a SMARTS failed to parse (run diagnose_templates.py)")

reagent_tags = {c for r in REAGENT_LIST for c in r.get("conditions", [])}
unfireable = [t["id"] for t in engine.templates
              if t["conditions"] and not set(t["conditions"]) & reagent_tags]
check("every conditioned template is wired to a reagent", not unfireable,
      f"statically dead: {unfireable}")

# ── Substitution / elimination ───────────────────────────────────────────────

react("Finkelstein Br->I", "CCBr", "NaI", expect=["CCI"])
react("SN2 vs E2 on 2-bromobutane (NaOEt)", "CCC(C)Br", "NaOEt",
      expect=["CC=CC", "C=CCC", "CCOC(C)CC"], min_branches=3)
react("E2 with t-BuOK", "CCC(C)Br", "t-BuOK", expect=["CC=CC"])
react("alcohol deprotonation (NaH)", "CCO", "NaH", expect=["CC[O-]"])
react("NH3 alkylation chains to neutral amine", "CCBr", "NH3", expect=["CCN"])

# ── Addition to alkenes ──────────────────────────────────────────────────────

react("HBr Markovnikov on isobutylene (geminal)", "C=C(C)C", "HBr", expect=["CC(C)(C)Br"])
react("HCl on internal alkene", "CC=CC", "HCl", expect=["CCC(C)Cl"])
react("HI Markovnikov on 1-butene", "C=CCC", "HI", expect=["CCC(C)I"])
react("Br2 anti addition", "CC=CC", "Br2", expect=["CC(Br)C(C)Br"])

# ── Carbonyl chemistry ───────────────────────────────────────────────────────

react("NaBH4 reduces acetone", "CC(=O)C", "NaBH4", expect=["CC(C)O"])
react("LiAlH4 reduces propanal", "CCC=O", "LiAlH4", expect=["CCCO"])
react("NaBH4 does NOT touch esters", "CC(=O)OCC", "NaBH4", min_branches=0,
      forbid=["CCO"])
react("carbonyl hydration (water)", "CC(=O)C", "Water", expect=["CC(C)(O)O"])
react("kinetic enolate from butanone (LDA)", "CC(=O)CC", "LDA", min_branches=1)
react("acetylide from propyne (LDA)", "CC#C", "LDA", expect=["[C-]#CC"])

# ── Hydrolysis / dehydration ─────────────────────────────────────────────────

react("ester saponification", "CC(=O)OCC", "NaOH", min_branches=1)
react("lactone saponification conserves mass", "O=C1CCCO1", "NaOH", min_branches=1)
react("acid-catalyzed dehydration of t-BuOH", "CC(C)(C)O", "H2SO4", expect=["C=C(C)C"])

# ── Coupling templates (pool-level, two reactants) ───────────────────────────

couple("Grignard + aldehyde -> secondary alcohol", "CC[Mg]Br", "CCC=O", "CCC(O)CC")
couple("Grignard + ketone -> tertiary alcohol", "CC[Mg]Br", "CC(=O)C", "CC(C)(O)CC")
couple("Grignard + formaldehyde -> primary alcohol", "CC[Mg]Br", "C=O", "CCCO")
couple("acetylide alkylation", "[C-]#CC", "CCBr", "CCC#CC")
couple("Williamson coupling", "CC[O-]", "CCBr", "CCOCC")
# Regression: product SMARTS must set +0 on the mapped enolate O — without it
# the -1 charge is inherited and RDKit silently drops every aldol product.
couple("aldol: acetone enolate + propanal", "C=C(C)[O-]", "CCC=O", "CC(=O)CC(O)CC")

# ── Saponification mass balance (regression: two-fragment product SMARTS) ───

branches = engine.run_for_reagent(canon("O=C1CCCO1"), REAGENTS["NaOH"]["smiles"],
                                  REAGENTS["NaOH"]["conditions"])
ring_atoms = Chem.MolFromSmiles("O=C1CCCO1").GetNumHeavyAtoms()
mass_ok = all(
    Chem.MolFromSmiles(b["final_product"]).GetNumHeavyAtoms() <= ring_atoms + 2
    for b in branches
)
check("lactone product doesn't duplicate the ring remnant", mass_ok,
      str([b["final_product"] for b in branches]))

# ── Summary ──────────────────────────────────────────────────────────────────

print()
print(f"{passes} passed, {len(failures)} failed")
if failures:
    for f in failures:
        print(f"  FAILED: {f}")
    sys.exit(1)
