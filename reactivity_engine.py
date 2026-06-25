"""
reactivity_engine.py — Template-driven reaction engine.

All reaction chemistry is defined in reaction_templates.json.
This module is a generic template loader and runner with no reaction-specific code.
"""

import json
import logging
from pathlib import Path

from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem

_rdlog = RDLogger.logger()

logger = logging.getLogger(__name__)

_TEMPLATE_FILE = Path(__file__).parent / "reaction_templates.json"
MAX_STEPS = 3


class TemplateEngine:
    """Generic SMARTS reaction template runner. Contains no reaction-specific chemistry."""

    def __init__(self, template_path: str | Path | None = None):
        self.templates: list[dict] = []
        self.coupling_templates: list[dict] = []
        path = Path(template_path) if template_path else _TEMPLATE_FILE
        self._load_templates(path)

    # ── Loading ───────────────────────────────────────────────────────────────

    def _load_templates(self, path: Path) -> None:
        if not path.exists():
            logger.warning("Template file not found: %s — no templates loaded.", path)
            return

        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.error("Failed to parse template file %s: %s — no templates loaded.", path, exc)
            return

        _rdlog.setLevel(RDLogger.CRITICAL)  # suppress unmapped-atom warnings during load
        loaded = 0
        for entry in data.get("templates", []):
            if not entry.get("enabled", True):
                continue
            tid = entry.get("id", "<unnamed>")
            try:
                rxn = AllChem.ReactionFromSmarts(entry["smarts"])
                if rxn is None:
                    raise ValueError("ReactionFromSmarts returned None")
                rxn.Initialize()
                t = {
                    "id": tid,
                    "name": entry["name"],
                    "rxn": rxn,
                    "n_reactants": rxn.GetNumReactantTemplates(),
                    "conditions": entry.get("conditions", []),
                    "provenance": entry.get("provenance", ""),
                    "coupling": entry.get("coupling", False),
                }
                if t["coupling"]:
                    self.coupling_templates.append(t)
                else:
                    self.templates.append(t)
                loaded += 1
            except Exception as exc:
                logger.warning("Skipping template '%s': %s", tid, exc)

        _rdlog.setLevel(RDLogger.WARNING)   # restore normal RDKit logging
        if loaded == 0:
            logger.warning("No valid templates loaded from %s.", path)
        else:
            logger.info(
                "Loaded %d templates from %s (%d reagent-based, %d coupling).",
                loaded, path, len(self.templates), len(self.coupling_templates),
            )

    # ── Template selection ────────────────────────────────────────────────────

    def eligible_templates(self, reagent_conditions: list[str]) -> list[dict]:
        """Return templates whose condition set intersects with the reagent's conditions."""
        result = []
        for t in self.templates:
            tc = t["conditions"]
            if not tc or any(c in reagent_conditions for c in tc):
                result.append(t)
        return result

    # ── Reagent handling ──────────────────────────────────────────────────────

    def _reagent_fragments(self, reagent_smiles: str) -> list:
        """Split a multi-component reagent SMILES into individual fragment molecules."""
        mol = Chem.MolFromSmiles(reagent_smiles)
        if mol is None:
            return []
        return [f for f in Chem.GetMolFrags(mol, asMols=True) if f is not None]

    # ── Template application ──────────────────────────────────────────────────

    def _run_template(
        self,
        template: dict,
        substrate_mol,
        reagent_fragments: list,
    ) -> list[str]:
        """
        Apply one template to the substrate. For 2-reactant templates, tries each reagent
        fragment as the second reactant. Returns a list of unique canonical main-product SMILES,
        each RDKit-validated. Invalid outputs are silently dropped.
        """
        rxn = template["rxn"]
        n = template["n_reactants"]

        if n == 1:
            reactant_sets = [(substrate_mol,)]
        else:
            if not reagent_fragments:
                return []
            reactant_sets = [(substrate_mol, frag) for frag in reagent_fragments]

        seen: set[str] = set()
        results: list[str] = []

        for reactants in reactant_sets:
            try:
                products_list = rxn.RunReactants(reactants)
            except Exception as exc:
                logger.debug("Template '%s' RunReactants error: %s", template["id"], exc)
                continue

            for prod_tuple in products_list:
                try:
                    combined = prod_tuple[0]
                    for p in prod_tuple[1:]:
                        combined = Chem.CombineMols(combined, p)

                    Chem.SanitizeMol(combined)

                    frags = Chem.GetMolFrags(combined, asMols=True)
                    main = max(frags, key=lambda m: m.GetNumHeavyAtoms())
                    smi = Chem.MolToSmiles(main)

                    if smi and smi not in seen:
                        seen.add(smi)
                        results.append(smi)
                except Exception as exc:
                    logger.debug(
                        "Template '%s' product validation error: %s", template["id"], exc
                    )

        return results

    # ── Step classification ───────────────────────────────────────────────────

    @staticmethod
    def _classify_step_type(mol) -> str:
        """Return 'intermediate' if the molecule carries a formal charge, else 'product'."""
        if mol is None:
            return "product"
        if Chem.GetFormalCharge(mol) != 0:
            return "intermediate"
        for atom in mol.GetAtoms():
            if atom.GetFormalCharge() != 0:
                return "intermediate"
        return "product"

    # ── Main public API ───────────────────────────────────────────────────────

    def run_for_reagent(
        self,
        substrate_smiles: str,
        reagent_smiles: str,
        reagent_conditions: list[str],
    ) -> list[dict]:
        """
        Apply all eligible templates to the substrate under the given reagent.

        Returns a list of branch dicts, one per unique canonical product (deduplicated
        across templates). Each branch includes the full step chain up to MAX_STEPS.

        Branch dict keys:
            template_id, reaction_name, steps, final_product, steps_taken,
            execution_history
        """
        if not self.templates:
            return []

        substrate_mol = Chem.MolFromSmiles(substrate_smiles)
        if substrate_mol is None:
            return []
        substrate_canon = Chem.MolToSmiles(substrate_mol)

        eligible = self.eligible_templates(reagent_conditions)
        if not eligible:
            return []

        reagent_frags = self._reagent_fragments(reagent_smiles)

        # ── Step 1: fire all eligible templates on the initial substrate ──────
        # Keyed by canonical product SMILES → first-winning template metadata
        seen_products: dict[str, dict] = {}

        for template in eligible:
            for prod_smi in self._run_template(template, substrate_mol, reagent_frags):
                canon = Chem.MolToSmiles(Chem.MolFromSmiles(prod_smi))
                if canon == substrate_canon:
                    continue  # skip no-op
                if canon not in seen_products:
                    seen_products[canon] = {
                        "template_id": template["id"],
                        "reaction_name": template["name"],
                    }

        if not seen_products:
            return []

        # ── Build branches, chaining steps for reactive intermediates ─────────
        branches: list[dict] = []

        for step1_canon, tmeta in seen_products.items():
            step1_mol = Chem.MolFromSmiles(step1_canon)
            step_type = self._classify_step_type(step1_mol)
            step_text = f"Step 1 ({'Intermediate State Generated' if step_type == 'intermediate' else 'Stable Product Finalized'}): {step1_canon}"

            steps: list[dict] = [
                {
                    "smiles": substrate_canon,
                    "label": "Starting Material",
                    "type": "start",
                    "step_index": 0,
                    "step_text": "Starting material",
                    "template_id": None,
                    "reaction_name": None,
                },
                {
                    "smiles": step1_canon,
                    "label": tmeta["reaction_name"],
                    "type": step_type,
                    "step_index": 1,
                    "step_text": step_text,
                    "template_id": tmeta["template_id"],
                    "reaction_name": tmeta["reaction_name"],
                },
            ]

            execution_history: list[str] = [step_text]
            current_mol = step1_mol
            current_canon = step1_canon
            step_count = 1

            # ── Multi-step: continue if intermediate, up to MAX_STEPS ─────────
            while step_type == "intermediate" and step_count < MAX_STEPS:
                step_count += 1
                next_seen: dict[str, dict] = {}

                for template in eligible:
                    for prod_smi in self._run_template(template, current_mol, reagent_frags):
                        nc = Chem.MolToSmiles(Chem.MolFromSmiles(prod_smi))
                        if nc != current_canon and nc not in next_seen:
                            next_seen[nc] = {
                                "template_id": template["id"],
                                "reaction_name": template["name"],
                            }

                if not next_seen:
                    break

                next_canon, next_tmeta = next(iter(next_seen.items()))
                next_mol = Chem.MolFromSmiles(next_canon)
                step_type = self._classify_step_type(next_mol)
                step_text = f"Step {step_count} ({'Intermediate State Generated' if step_type == 'intermediate' else 'Stable Product Finalized'}): {next_canon}"
                execution_history.append(step_text)

                steps.append({
                    "smiles": next_canon,
                    "label": next_tmeta["reaction_name"],
                    "type": step_type,
                    "step_index": step_count,
                    "step_text": step_text,
                    "template_id": next_tmeta["template_id"],
                    "reaction_name": next_tmeta["reaction_name"],
                })

                current_mol = next_mol
                current_canon = next_canon

            final_product = steps[-1]["smiles"]
            branches.append({
                "template_id": tmeta["template_id"],
                "reaction_name": tmeta["reaction_name"],
                "steps": steps,
                "steps_taken": len(steps) - 1,
                "final_product": final_product,
                "execution_history": execution_history,
            })

        return branches

    # ── Coupling (both reactants from synthesis pool) ─────────────────────────

    def run_coupling(self, mol_a_smiles: str, mol_b_smiles: str) -> list[dict]:
        """
        Try all coupling templates on the ordered pair (A, B) AND (B, A).

        Returns a list of dicts with keys: template_id, reaction_name, product_smiles.
        Each product is RDKit-validated; invalid outputs are silently dropped.
        Deduplicates results by canonical product SMILES.
        """
        if not self.coupling_templates:
            return []

        mol_a = Chem.MolFromSmiles(mol_a_smiles)
        mol_b = Chem.MolFromSmiles(mol_b_smiles)
        if mol_a is None or mol_b is None:
            return []

        seen: set[str] = set()
        results: list[dict] = []

        for template in self.coupling_templates:
            for reactants in [(mol_a, mol_b), (mol_b, mol_a)]:
                try:
                    products_list = template["rxn"].RunReactants(reactants)
                except Exception as exc:
                    logger.debug("Coupling template '%s' RunReactants error: %s", template["id"], exc)
                    continue

                for prod_tuple in products_list:
                    try:
                        combined = prod_tuple[0]
                        for p in prod_tuple[1:]:
                            combined = Chem.CombineMols(combined, p)
                        Chem.SanitizeMol(combined)
                        frags = Chem.GetMolFrags(combined, asMols=True)
                        main = max(frags, key=lambda m: m.GetNumHeavyAtoms())
                        smi = Chem.MolToSmiles(main)
                        if smi and smi not in seen:
                            seen.add(smi)
                            results.append({
                                "template_id": template["id"],
                                "reaction_name": template["name"],
                                "product_smiles": smi,
                            })
                    except Exception as exc:
                        logger.debug("Coupling template '%s' product error: %s", template["id"], exc)

        return results

    # ── Condition inference (used by backward-compat wrapper) ─────────────────

    @staticmethod
    def _infer_conditions(reagent_smiles: str) -> list[str]:
        """
        Heuristically derive condition tags from reagent chemistry so callers that
        don't supply explicit conditions still get sensible template gating.
        """
        mol = Chem.MolFromSmiles(reagent_smiles)
        if mol is None:
            return []

        conds: set[str] = set()
        frags = Chem.GetMolFrags(mol, asMols=True)

        for frag in frags:
            for atom in frag.GetAtoms():
                sym = atom.GetSymbol()
                charge = atom.GetFormalCharge()

                if sym == "N" and charge < 0:
                    conds.update(["kinetic_base", "strong_base"])

                elif sym == "O" and charge < 0:
                    nbrs = list(atom.GetNeighbors())
                    if any(n.GetSymbol() == "C" for n in nbrs):
                        conds.update(["strong_base", "alkoxide"])
                        # Bulky quaternary C adjacent to O- → kinetic base behaviour
                        for n in nbrs:
                            if n.GetSymbol() == "C" and n.GetDegree() >= 4:
                                conds.add("kinetic_base")
                    else:
                        conds.update(["strong_base", "hydroxide"])

                elif sym == "O" and charge == 0 and frag.GetNumAtoms() == 1:
                    conds.add("protic")

                elif sym in ("I", "Cl", "Br") and charge < 0:
                    conds.add("halide_nucleophile")

        # Water (single O, no charge, no heavy neighbors)
        canon = Chem.MolToSmiles(mol)
        if canon == "O":
            conds.add("protic")

        return list(conds)

    # ── Backward-compat wrapper for /predict endpoint and test.py ─────────────

    def process_reaction_pipeline(
        self, substrate_smiles: str, reagent_smiles: str, reagent_conditions: list[str] | None = None
    ) -> dict:
        """
        Single-result wrapper. If reagent_conditions is not supplied, infers them
        from the reagent's chemistry so the old test.py call-site keeps working.
        Returns the first successful branch dict, or an error dict.
        """
        if not reagent_conditions:
            reagent_conditions = self._infer_conditions(reagent_smiles)

        branches = self.run_for_reagent(substrate_smiles, reagent_smiles, reagent_conditions)

        if not branches:
            return {"error": "Reaction stalled: no templates matched the substrate/reagent combination."}

        b = branches[0]
        return {
            "status": "Success",
            "environment_used": "Kinetic" if "kinetic_base" in reagent_conditions else "Thermodynamic",
            "steps_taken": b["steps_taken"],
            "execution_history": b["execution_history"],
            "final_product_smiles": b["final_product"],
            "template_id": b["template_id"],
            "reaction_name": b["reaction_name"],
        }


# ── Module-level alias kept for any import that used the old class name ───────
MolecularReactivityEngine = TemplateEngine


# ── Smoke test ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    engine = TemplateEngine()
    print(f"Templates loaded: {len(engine.templates)}")
    for t in engine.templates:
        print(f"  [{t['id']}] {t['name']}  n_reactants={t['n_reactants']}  conditions={t['conditions']}")
    print()

    print("=== CC(=O)CCBr + LDA (kinetic_base) ===")
    branches = engine.run_for_reagent(
        "CC(=O)CCBr", "CC(C)[N-]C(C)C.[Li+]", ["kinetic_base", "strong_base"]
    )
    for b in branches:
        print(f"  [{b['template_id']}] {b['reaction_name']} -> {b['final_product']}")
    print()

    print("=== CC(=O)CCBr + Water (protic) ===")
    branches = engine.run_for_reagent("CC(=O)CCBr", "O", ["protic"])
    for b in branches:
        print(f"  [{b['template_id']}] {b['reaction_name']} -> {b['final_product']}")
    print()

    print("=== CC(=O)CCBr + NaI (halide_nucleophile) ===")
    branches = engine.run_for_reagent("CC(=O)CCBr", "[Na+].[I-]", ["halide_nucleophile"])
    for b in branches:
        print(f"  [{b['template_id']}] {b['reaction_name']} -> {b['final_product']}")
