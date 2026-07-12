"""
reactivity_engine.py — Template-driven reaction engine.

All reaction chemistry is defined in reaction_templates.json.
This module is a generic template loader and runner with no reaction-specific code.
"""

import json
import logging
from collections import deque
from pathlib import Path

from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem

_rdlog = RDLogger.logger()

logger = logging.getLogger(__name__)

_TEMPLATE_FILE = Path(__file__).parent / "reaction_templates.json"
MAX_STEPS = 3
MAX_BRANCHES = 12   # cap on branches per (substrate, reagent) — bounds chain fan-out


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
            # Try both orderings so the user doesn't need to worry about which
            # molecule is "substrate" vs "reagent" for 2-reactant templates.
            reactant_sets = []
            for frag in reagent_fragments:
                reactant_sets.append((substrate_mol, frag))
                reactant_sets.append((frag, substrate_mol))

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

        Returns a list of branch dicts, one per unique final product (deduplicated
        across templates and chains). Each branch includes the full step chain up
        to MAX_STEPS; intermediates with several onward reactions fan out into
        one branch per continuation, capped at MAX_BRANCHES.

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
        # An intermediate may react onward through MORE than one eligible
        # template (e.g. an enolate can alkylate or re-protonate). Every
        # continuation becomes its own branch — taking whichever template
        # happens to come first in the JSON file would silently pick the
        # chemistry. Bounded by MAX_STEPS depth and MAX_BRANCHES total;
        # complete chains are deduplicated by final product (the first chain
        # in template order wins).
        branches: list[dict] = []
        seen_finals: set[str] = set()

        def _continuations(mol: Chem.Mol, visited: set[str]) -> dict[str, dict]:
            """Distinct next products for an intermediate, keyed by canonical
            SMILES → first-winning template metadata. Species already on the
            current chain are excluded to prevent A→B→A cycles."""
            found: dict[str, dict] = {}
            for template in eligible:
                for prod_smi in self._run_template(template, mol, reagent_frags):
                    nc = Chem.MolToSmiles(Chem.MolFromSmiles(prod_smi))
                    if nc not in visited and nc not in found:
                        found[nc] = {
                            "template_id": template["id"],
                            "reaction_name": template["name"],
                        }
            return found

        # BFS over partial chains: each entry is the list of (canon, tmeta)
        # steps beyond the starting material. FIFO keeps template-order
        # priority — earlier-listed continuations finalize first.
        queue: deque[list[tuple[str, dict]]] = deque(
            [[(canon, tmeta)] for canon, tmeta in seen_products.items()]
        )
        while queue and len(branches) < MAX_BRANCHES:
            chain = queue.popleft()
            last_canon = chain[-1][0]
            last_mol = Chem.MolFromSmiles(last_canon)

            if self._classify_step_type(last_mol) == "intermediate" and len(chain) < MAX_STEPS:
                visited = {substrate_canon, *(c for c, _ in chain)}
                nxt = _continuations(last_mol, visited)
                if nxt:
                    for nc, ntmeta in nxt.items():
                        queue.append(chain + [(nc, ntmeta)])
                    continue
                # Dead-end intermediate: finalize the chain as-is below.

            final_product = last_canon
            if final_product in seen_finals:
                continue
            seen_finals.add(final_product)

            steps: list[dict] = [{
                "smiles": substrate_canon,
                "label": "Starting Material",
                "type": "start",
                "step_index": 0,
                "step_text": "Starting material",
                "template_id": None,
                "reaction_name": None,
            }]
            execution_history: list[str] = []
            for idx, (canon, meta) in enumerate(chain, start=1):
                stype = self._classify_step_type(Chem.MolFromSmiles(canon))
                step_text = f"Step {idx} ({'Intermediate State Generated' if stype == 'intermediate' else 'Stable Product Finalized'}): {canon}"
                execution_history.append(step_text)
                steps.append({
                    "smiles": canon,
                    "label": meta["reaction_name"],
                    "type": stype,
                    "step_index": idx,
                    "step_text": step_text,
                    "template_id": meta["template_id"],
                    "reaction_name": meta["reaction_name"],
                })

            branches.append({
                "template_id": chain[0][1]["template_id"],
                "reaction_name": chain[0][1]["reaction_name"],
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

                elif sym == "Br" and charge == 0:
                    if any(n.GetSymbol() == "Br" for n in atom.GetNeighbors()):
                        conds.add("halogenation")   # Br2
                    else:
                        conds.add("hbr")            # HBr

                elif sym == "Cl" and charge == 0:
                    if any(n.GetSymbol() == "Cl" for n in atom.GetNeighbors()):
                        conds.add("halogenation")   # Cl2
                    else:
                        conds.add("hcl")            # HCl

                elif sym == "I" and charge == 0:
                    conds.add("hi")                 # HI

                elif sym == "B" and charge < 0:
                    conds.add("hydride")            # BH4- (NaBH4)

                elif sym == "Al" and charge < 0:
                    conds.add("hydride")            # AlH4- (LiAlH4)

                elif sym == "N" and charge == 0:
                    conds.add("amine_nucleophile")  # NH3 or amine

                elif sym == "S" and charge == 0:
                    # H2SO4 or sulfonic acid → acid catalyst
                    for n in atom.GetNeighbors():
                        if n.GetSymbol() == "O" and n.GetFormalCharge() < 0:
                            conds.add("acid")
                            break
                    else:
                        # S bonded to multiple O's with no charge (H2SO4 neutral form)
                        o_count = sum(1 for n in atom.GetNeighbors() if n.GetSymbol() == "O")
                        if o_count >= 3:
                            conds.add("acid")

                elif sym == "P" and charge == 0:
                    # H3PO4 → acid catalyst
                    o_count = sum(1 for n in atom.GetNeighbors() if n.GetSymbol() == "O")
                    if o_count >= 3:
                        conds.add("acid")

        # Water (single O, no charge, no heavy neighbors)
        canon = Chem.MolToSmiles(mol)
        if canon == "O":
            conds.add("protic")

        return list(conds)

    # ── Backward-compat wrapper for the predict_reactivity.py CLI ─────────────

    def process_reaction_pipeline(
        self, substrate_smiles: str, reagent_smiles: str, reagent_conditions: list[str] | None = None
    ) -> dict:
        """
        Single-result wrapper. If reagent_conditions is not supplied, infers them
        from the reagent's chemistry so the CLI call-site keeps working.
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
