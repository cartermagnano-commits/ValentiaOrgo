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

# ── Batch 1: curriculum expansion ────────────────────────────────────────────
# Positive cases assert the transform fires with the right product; the `forbid`
# and negative cases guard against over-broad SMARTS, which is the failure mode
# hand-review misses most often as the library grows.

# Nitriles — the gap that motivated this batch.
react("nitrile + water -> primary amide", "N#Cc1ccccc1", "Water",
      expect=["NC(=O)c1ccccc1"])
react("hydroxide alone does not hydrate the nitrile", "N#Cc1ccccc1", "NaOH",
      forbid=["NC(=O)c1ccccc1", "OC(=O)c1ccccc1"], min_branches=0)
react("LiAlH4 reduces nitrile to primary amine", "N#Cc1ccccc1", "LiAlH4",
      expect=["NCc1ccccc1"])
# Regression: one-step nitrile -> acid fabricated an oxygen (needs 2 H2O).
# The acid must be reached by chaining through the amide, never in one step.
react("nitrile + water does NOT jump straight to the acid", "N#Cc1ccccc1", "Water",
      forbid=["OC(=O)c1ccccc1"])

# Carbonyl / acid-derivative interconversion.
react("LiAlH4 reduces carboxylic acid to primary alcohol", "OC(=O)c1ccccc1", "LiAlH4",
      expect=["OCc1ccccc1"])
react("amide hydrolysis gives the carboxylic acid", "NC(=O)c1ccccc1", "Water",
      expect=["OC(=O)c1ccccc1"])
react("acyl chloride + amine -> amide", "CC(=O)Cl", "EtNH2", expect=["CCNC(C)=O"])
react("acyl chloride + alcohol -> ester", "CC(=O)Cl", "EtOH", expect=["CCOC(C)=O"])

# Oxidation ladder — strength must be respected.
react("PCC stops at the aldehyde", "CCO", "PCC", expect=["CC=O"])
react("PCC does NOT over-oxidise to the acid", "CCO", "PCC", forbid=["CC(=O)O"])
react("KMnO4 takes the secondary alcohol to the ketone", "CC(C)O", "KMnO4",
      expect=["CC(C)=O"])

# Alkenes / alkynes.
react("H2/Pd reduces the alkene", "C=CC", "H2/Pd-C", expect=["CCC"])
react("Lindlar stops the alkyne at the alkene", "C#CC", "H2/Lindlar", expect=["C=CC"])
react("Lindlar does NOT go through to the alkane", "C#CC", "H2/Lindlar", forbid=["CCC"])
react("mCPBA epoxidises the alkene", "C=CC", "mCPBA", expect=["CC1CO1"])

# Aromatic substitution — regression: the halogen must come from the halogen
# reagent. Both of these produced bromobenzene before the fix, because Br was
# hardcoded on the product side instead of mapped from Br2.
react("Br2 brominates benzene", "c1ccccc1", "Br2", expect=["Brc1ccccc1"])
react("Cl2 chlorinates benzene", "c1ccccc1", "Cl2", expect=["Clc1ccccc1"])
react("Cl2 does NOT produce an aryl bromide", "c1ccccc1", "Cl2", forbid=["Brc1ccccc1"])
react("AlCl3 alone does NOT halogenate", "c1ccccc1", "AlCl3",
      forbid=["Brc1ccccc1", "Clc1ccccc1"], min_branches=0)
# Regression: nitration chained to tri-nitrobenzene before the ring guard.
react("nitration stops at mononitration", "c1ccccc1", "HNO3/H2SO4",
      forbid=["[O-][N+](=O)c1ccccc1[N+](=O)[O-]"])

# Substitution.
react("SN2 with cyanide gives the nitrile", "CCBr", "NaCN", expect=["CCC#N"])
react("SN2 with azide gives the alkyl azide", "CCBr", "NaN3", expect=["CCN=[N+]=[N-]"])

# Regression: a one-equivalent acetal SMARTS wrote both alkoxy groups and
# duplicated the alcohol's carbons. Acetal must be reached via the hemiacetal.
react("aldehyde + alcohol gives the hemiacetal", "CCC=O", "EtOH",
      expect=["CCC(O)OCC"])
react("one alcohol equivalent does NOT give the acetal", "CCC=O", "EtOH",
      forbid=["CCOC(CC)OCC"])

# ── Batch 2: alcohol activation (SOCl2 / PBr3 / TsCl) ────────────────────────
# Motivated by a real miss: "benzyl alcohol + SOCl2" returned no verified
# product, so the endpoint fell through to an unverified LLM guess. Each
# activator gets its own SMARTS keyed on the actual reagent skeleton, because
# _infer_conditions collapses SOCl2 and TsCl to the same "hcl" tag as HCl —
# the condition tag alone cannot tell them apart.

react("SOCl2 converts benzyl alcohol to benzyl chloride", "OCc1ccccc1", "SOCl2",
      expect=["ClCc1ccccc1"])
react("SOCl2 converts a primary alcohol to the alkyl chloride", "CCCCO", "SOCl2",
      expect=["CCCCCl"])
react("SOCl2 converts a carboxylic acid to the acyl chloride", "CC(=O)O", "SOCl2",
      expect=["CC(=O)Cl"])
react("PBr3 converts 1-butanol to 1-bromobutane", "CCCCO", "PBr3",
      expect=["CCCCBr"])
react("TsCl tosylates the alcohol", "CCO", "TsCl",
      expect=["CCOS(=O)(=O)c1ccc(C)cc1"])

# Negative guards — the activator SMARTS must key on the reagent skeleton, not
# on the shared "hcl"/"hbr" condition tag.
react("HCl alone does NOT chlorinate benzyl alcohol", "OCc1ccccc1", "HCl",
      forbid=["ClCc1ccccc1"], min_branches=0)
react("SOCl2 does NOT add across an alkene", "C=CCC", "SOCl2",
      forbid=["CCC(C)Cl"], min_branches=0)
react("PBr3 does NOT add across an alkene", "C=CCC", "PBr3",
      forbid=["CCC(C)Br"], min_branches=0)
react("TsCl does NOT chlorinate the alcohol", "CCO", "TsCl", forbid=["CCCl"])
react("SOCl2 leaves the ether alone", "CCOCC", "SOCl2", min_branches=0)
react("SOCl2 does NOT convert the ketone", "CC(=O)C", "SOCl2", min_branches=0)

# ── Summary ──────────────────────────────────────────────────────────────────

print()
print(f"{passes} passed, {len(failures)} failed")
if failures:
    for f in failures:
        print(f"  FAILED: {f}")
    sys.exit(1)
