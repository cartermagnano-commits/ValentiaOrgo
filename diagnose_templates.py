"""
diagnose_templates.py — Standalone template diagnostic for Orgo AI.

Usage:
    python diagnose_templates.py
    python diagnose_templates.py --file path/to/reaction_templates.json
    python diagnose_templates.py --substrates "CC(=O)CCBr,CCBr,CCI,CCCl"

Reports:
  1. Load summary: total / enabled / disabled / parse failures
  2. Per-template firing matrix across sample substrates
  3. Dead templates (never fire on any sample)
  4. Templates with empty or missing condition metadata
  5. Suggested new templates for common Orgo 1 reactions (disabled, for your review)
"""

import argparse
import json
import sys
from pathlib import Path

DEFAULT_TEMPLATE_FILE = Path(__file__).parent / "reaction_templates.json"

# Sample substrates covering common functional groups
DEFAULT_SUBSTRATES = [
    "CC(=O)CCBr",   # 4-bromobutan-2-one (ketone + alkyl bromide)
    "CCBr",          # ethyl bromide
    "CCI",           # ethyl iodide
    "CCCl",          # propyl chloride
    "BrCCBr",        # 1,2-dibromoethane
    "CC(=O)C",      # acetone (no halide)
    "CCCCC(=O)C",   # 2-heptanone (ketone, longer chain)
    "CC(=O)CBr",    # 1-bromoacetone (alpha-halo ketone)
]

# Minimal representative fragment per condition tag (for firing tests)
CONDITION_REAGENT_FRAGMENTS = {
    "kinetic_base":      "CC(C)[N-]C(C)C",
    "strong_base":       "[OH-]",
    "alkoxide":          "CC[O-]",
    "hydroxide":         "[OH-]",
    "protic":            "O",
    "halide_nucleophile": "[I-]",
    "amine_nucleophile": "N",
}

DIVIDER = "-" * 70


def load_and_parse(template_file: Path):
    """Return (all_entries, loaded_templates, failures)."""
    from rdkit import Chem, RDLogger
    from rdkit.Chem import AllChem

    RDLogger.logger().setLevel(RDLogger.CRITICAL)

    try:
        data = json.loads(template_file.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"FATAL: could not read/parse {template_file}: {exc}")
        sys.exit(1)

    all_entries = data.get("templates", [])
    loaded, failures = [], []

    for entry in all_entries:
        if not entry.get("enabled", True):
            continue
        tid = entry.get("id", "<unnamed>")
        try:
            rxn = AllChem.ReactionFromSmarts(entry["smarts"])
            if rxn is None:
                raise ValueError("ReactionFromSmarts returned None")
            rxn.Initialize()
            loaded.append({
                "id": tid,
                "name": entry.get("name", tid),
                "smarts": entry["smarts"],
                "conditions": entry.get("conditions", []),
                "rxn": rxn,
                "n_reactants": rxn.GetNumReactantTemplates(),
            })
        except Exception as exc:
            failures.append({"id": tid, "reason": str(exc)})

    RDLogger.logger().setLevel(RDLogger.WARNING)
    return all_entries, loaded, failures


def test_template_fires(template: dict, substrate_smi: str) -> bool:
    """Try each condition-compatible reagent fragment; return True if any product forms."""
    from rdkit import Chem

    sub_mol = Chem.MolFromSmiles(substrate_smi)
    if sub_mol is None:
        return False

    rxn = template["rxn"]
    n = template["n_reactants"]
    conds = template["conditions"]

    reagent_smiles_to_try = []
    if conds:
        for cond in conds:
            frag_smi = CONDITION_REAGENT_FRAGMENTS.get(cond)
            if frag_smi:
                reagent_smiles_to_try.append(frag_smi)
    else:
        reagent_smiles_to_try = ["O"]  # fallback for unconditioned templates

    for rea_smi in reagent_smiles_to_try:
        rea_mol = Chem.MolFromSmiles(rea_smi)
        if rea_mol is None:
            continue

        try:
            if n == 1:
                products = rxn.RunReactants((sub_mol,))
            else:
                products = rxn.RunReactants((sub_mol, rea_mol))
        except Exception:
            continue

        if products:
            return True

    return False


def suggest_new_templates() -> list[dict]:
    """Return a list of suggested Orgo 1 templates not in the current set."""
    return [
        {
            "id": "nabh4_carbonyl_reduction",
            "name": "NaBH4 carbonyl reduction (ketone/aldehyde -> alcohol)",
            "smarts": "[CX3:1](=[OX1:2])>>[CX4:1][OH]",
            "conditions": ["hydride_reductant"],
            "provenance": "March, J. 'Advanced Organic Chemistry' 5th ed. Nucleophilic hydride delivery to carbonyl. Requires new condition tag 'hydride_reductant' and NaBH4 reagent entry.",
            "enabled": False,
            "review_notes": "1-reactant template. Add NaBH4 to REAGENT_LIST with conditions=['hydride_reductant']. Verify SMARTS handles both ketones and aldehydes.",
        },
        {
            "id": "hbr_markovnikov_alkene",
            "name": "HBr addition to alkene (Markovnikov)",
            "smarts": "[CX3:1]=[CX3:2].[Br-]>>[CX4:1][Br].[CX4:2]",
            "conditions": ["protic_acid"],
            "provenance": "Markovnikov, V. Ann. Chem. 1870. Requires new condition tag 'protic_acid' and HBr reagent entry. SMARTS is approximate — regiochemistry not enforced by template alone.",
            "enabled": False,
            "review_notes": "Regioselectivity (Markovnikov vs anti-Markovnikov) cannot be enforced by SMARTS alone without atom mapping to specify which C gets Br. Consider two separate templates for each regioisomer.",
        },
        {
            "id": "hcl_markovnikov_alkene",
            "name": "HCl addition to alkene (Markovnikov)",
            "smarts": "[CX3:1]=[CX3:2].[Cl-]>>[CX4:1][Cl].[CX4:2]",
            "conditions": ["protic_acid"],
            "provenance": "Markovnikov addition with HCl. Same limitations as HBr template above.",
            "enabled": False,
            "review_notes": "Same caveats as hbr_markovnikov_alkene.",
        },
        {
            "id": "aldol_condensation",
            "name": "Aldol condensation (enolate + aldehyde)",
            "smarts": "[CX3:1]([OX2-:2])=[CX3:3].[CX3H:4]=[OX1:5]>>[CX4:3][CX4:4]([OH:5])[CX3:1](=[OX1:2])",
            "conditions": ["kinetic_base"],
            "provenance": "Aldol condensation: enolate attacks aldehyde carbonyl. March, J. 'Advanced Organic Chemistry'. Product contains beta-hydroxy carbonyl.",
            "enabled": False,
            "review_notes": "Complex 2-reactant template. Test carefully — the enolate SMARTS [CX3]([OX2-])=[CX3] requires the enolate to already be formed (so this fires in step 2 of a kinetic_base pathway). Verify SMARTS against RDKit before enabling.",
        },
        {
            "id": "esterification",
            "name": "Fischer esterification (carboxylic acid + alcohol)",
            "smarts": "[CX3:1](=[OX1:2])[OX2H:3].[OX2H:4][CX4:5]>>[CX3:1](=[OX1:2])[OX2:3][CX4:5].[OH2]",
            "conditions": ["protic_acid"],
            "provenance": "Fischer, E. and Speier, A. Ber. Dtsch. Chem. Ges. 1895. Acid-catalyzed esterification; equilibrium-driven. Requires 'protic_acid' condition and H2SO4/HCl reagent entry.",
            "enabled": False,
            "review_notes": "Add H2SO4 (or HCl) to REAGENT_LIST with conditions=['protic_acid']. The template captures the net transformation; mechanism (4 steps) is not shown.",
        },
        {
            "id": "saponification",
            "name": "Saponification (ester hydrolysis under base)",
            "smarts": "[CX3:1](=[OX1:2])[OX2:3][CX4:4].[OH-]>>[CX3:1](=[OX1:2])[OH].[OX2-:3][CX4:4]",
            "conditions": ["hydroxide"],
            "provenance": "Base-mediated irreversible ester hydrolysis (saponification). March, J. 'Advanced Organic Chemistry'. Hydroxide conditions already defined.",
            "enabled": False,
            "review_notes": "Test SMARTS against methyl acetate (CC(=O)OC) + NaOH. Should give acetic acid + methoxide. Verify charge handling on product alkoxide.",
        },
    ]


def main():
    parser = argparse.ArgumentParser(description="Orgo AI template diagnostic")
    parser.add_argument("--file", default=str(DEFAULT_TEMPLATE_FILE), help="Path to reaction_templates.json")
    parser.add_argument("--substrates", default=",".join(DEFAULT_SUBSTRATES), help="Comma-separated SMILES")
    args = parser.parse_args()

    template_file = Path(args.file)
    substrates = [s.strip() for s in args.substrates.split(",") if s.strip()]

    print(f"\nOrgo AI Template Diagnostic")
    print(f"Template file : {template_file}")
    print(f"Test substrates: {len(substrates)}")
    print(DIVIDER)

    # ── 1. Load ───────────────────────────────────────────────────────────────
    all_entries, loaded, failures = load_and_parse(template_file)

    total     = len(all_entries)
    enabled   = sum(1 for e in all_entries if e.get("enabled", True))
    disabled  = total - enabled

    print(f"\nLOAD SUMMARY")
    print(f"  Total entries   : {total}")
    print(f"  Enabled         : {enabled}")
    print(f"  Disabled        : {disabled}")
    print(f"  Parsed OK       : {len(loaded)}")
    print(f"  Parse failures  : {len(failures)}")

    if failures:
        print(f"\nPARSE FAILURES")
        for f in failures:
            print(f"  [{f['id']}] {f['reason']}")

    # ── 2. Missing conditions ─────────────────────────────────────────────────
    no_conditions = [t for t in loaded if not t["conditions"]]
    if no_conditions:
        print(f"\nTEMPLATES WITH EMPTY CONDITIONS (silently excluded by reagent gating)")
        for t in no_conditions:
            print(f"  [{t['id']}] {t['name']}")
            print(f"    SMARTS: {t['smarts']}")
    else:
        print(f"\nAll enabled templates have at least one condition tag. OK.")

    # ── 3. Firing matrix ─────────────────────────────────────────────────────
    print(f"\nFIRING MATRIX  (Y = fires, - = no match)")
    col_w = max(len(s) for s in substrates) + 2
    header = f"  {'Template':<35}" + "".join(f"{s:>{col_w}}" for s in substrates)
    print(header)
    print("  " + "-" * (35 + col_w * len(substrates)))

    fire_counts: dict[str, int] = {}
    for t in loaded:
        row = f"  {t['id']:<35}"
        hits = 0
        for sub in substrates:
            fired = test_template_fires(t, sub)
            row += f"{'Y':>{col_w}}" if fired else f"{'-':>{col_w}}"
            if fired:
                hits += 1
        print(row)
        fire_counts[t["id"]] = hits

    # ── 4. Dead templates ─────────────────────────────────────────────────────
    dead = [t for t in loaded if fire_counts[t["id"]] == 0]
    print(f"\nDEAD TEMPLATES (zero hits across all sample substrates)")
    if dead:
        for t in dead:
            print(f"  [{t['id']}] {t['name']}")
            print(f"    Conditions : {t['conditions']}")
            print(f"    SMARTS     : {t['smarts']}")
            print(f"    Likely cause: substrates don't contain the required substructure, OR")
            print(f"    condition tag has no matching entry in CONDITION_REAGENT_FRAGMENTS above.")
    else:
        print("  None — all enabled templates fire on at least one sample substrate.")

    # ── 5. Suggestions ────────────────────────────────────────────────────────
    suggestions = suggest_new_templates()
    print(f"\nSUGGESTED NEW TEMPLATES (disabled — for your review)")
    print(f"Copy desired entries into reaction_templates.json and set \"enabled\": true after verifying.")
    print()
    for s in suggestions:
        print(json.dumps({k: v for k, v in s.items() if k != "review_notes"}, indent=2))
        print(f"  // REVIEW NOTES: {s['review_notes']}")
        print()

    print(DIVIDER)
    print("Done.")


if __name__ == "__main__":
    main()
