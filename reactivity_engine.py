from rdkit import Chem
from rdkit.Chem import AllChem

# ==============================================================================
# 1. THE ADVANCED PHYSICS ENGINE (Property Matrix Calculator)
# ==============================================================================
class AdvancedPhysicalCalculator:
    """Calculates electronic, steric, and resonance properties from first principles."""

    @staticmethod
    def get_net_electronic_score(mol, carbon_idx):
        """
        Calculates a localized electronic score combining Gasteiger charge,
        direct resonance contributions, and distance-decayed induction.
        """
        mol_copy = Chem.Mol(mol)
        AllChem.ComputeGasteigerCharges(mol_copy)
        baseline_charge = float(mol_copy.GetAtomWithIdx(carbon_idx).GetProp("_GasteigerCharge"))

        resonance_weights = {"N": 1.5, "O": 1.0, "F": 0.2}
        induction_weights = {"N": 0.5, "O": 0.7, "F": 1.0}

        electronic_modifier = 0.0
        distance_matrix = Chem.GetDistanceMatrix(mol)

        for atom in mol.GetAtoms():
            sym = atom.GetSymbol()
            if sym in ["N", "O", "F"]:
                d = distance_matrix[carbon_idx][atom.GetIdx()]

                if d == 1:
                    electronic_modifier -= resonance_weights[sym]
                elif d >= 2:
                    electronic_modifier += induction_weights[sym] / (d ** 2)

        return baseline_charge + electronic_modifier

    @staticmethod
    def calculate_sterics(atom):
        """Measures spatial crowding around an atom center."""
        alpha_neighbors = [n for n in atom.GetNeighbors() if n.GetSymbol() != 'H']
        raw_score = len(alpha_neighbors)
        for alpha in alpha_neighbors:
            beta_neighbors = [n for n in alpha.GetNeighbors() if n.GetSymbol() != 'H' and n.GetIdx() != atom.GetIdx()]
            raw_score += len(beta_neighbors) * 0.4
        return raw_score


# ==============================================================================
# 2. THE RE-ARCHITECTED PIPELINE ENGINE
# ==============================================================================
class MolecularReactivityEngine:
    def __init__(self):
        self.calculator = AdvancedPhysicalCalculator()

        # Raw string inputs canonicalized on initialization to guarantee lookup matches
        raw_kinetic = {"CC(C)[N-]C(C)C.[Li+]", "[O-]C(C)(C)C.[K+]"} # LDA, t-BuOK
        raw_thermo = {"O=S(=O)(O)O", "O"} # Strong acids, solvents

        self.kinetic_reagents = {Chem.MolToSmiles(Chem.MolFromSmiles(s)) for s in raw_kinetic if Chem.MolFromSmiles(s)}
        self.thermodynamic_reagents = {Chem.MolToSmiles(Chem.MolFromSmiles(s)) for s in raw_thermo if Chem.MolFromSmiles(s)}

    def infer_environment(self, reagent_smiles):
        """Automatically determines thermodynamic vs kinetic control based on reagents."""
        try:
            canonical_reagent = Chem.MolToSmiles(Chem.MolFromSmiles(reagent_smiles))
            if canonical_reagent in self.kinetic_reagents:
                return "Kinetic"
            if canonical_reagent in self.thermodynamic_reagents:
                return "Thermodynamic"
        except Exception:
            pass
        return "Thermodynamic"

    def is_reactive_intermediate(self, mol):
        """Flags non-standard formal charges and high-energy intermediate matrices."""
        net_molecule_charge = Chem.GetFormalCharge(mol)
        if net_molecule_charge != 0:
            return True

        for atom in mol.GetAtoms():
            charge = atom.GetFormalCharge()
            symbol = atom.GetSymbol()

            if charge != 0:
                if symbol in ["C", "S", "P"] and charge != 0:
                    return True
                if symbol in ["Cl", "Br", "I"] and charge != 0:
                    return True
                if symbol == "O" and charge != 0:
                    return True
                if symbol == "N" and charge != 0:
                    return True
        return False

    def execute_first_principles_step(self, substrate_mol, reagent_mol, control_type):
        """Simulates an explicit step using localized properties, gating by mechanism type."""

        # FIX 1: Ensure incoming reagent string canonicalization matches our __init__ sets perfectly
        reagent_smiles = Chem.MolToSmiles(reagent_mol)
        is_kinetic_base = reagent_smiles in self.kinetic_reagents

        if is_kinetic_base:
            # ── PATHWAY A: KINETIC DEPROTONATION (ENOLATE FORMATION) ──
            pattern = Chem.MolFromSmarts("[CX3]=[OX1]")
            match_indices = substrate_mol.GetSubstructMatches(pattern)

            if not match_indices:
                return None

            # FIX 2: Explicitly verify which index belongs to the Carbon atom to resolve the indexing blindspot
            atom_0 = substrate_mol.GetAtomWithIdx(match_indices[0][0])
            if atom_0.GetSymbol() == "C":
                carbonyl_idx = match_indices[0][0]
                oxygen_idx = match_indices[0][1]
            else:
                carbonyl_idx = match_indices[0][1]
                oxygen_idx = match_indices[0][0]

            carbonyl_carbon = substrate_mol.GetAtomWithIdx(carbonyl_idx)

            alpha_sites = []
            for n in carbonyl_carbon.GetNeighbors():
                if n.GetSymbol() == "C" and n.GetHybridization() == Chem.HybridizationType.SP3:
                    num_hs = n.GetTotalNumHs()
                    if num_hs > 0:
                        sterics = self.calculator.calculate_sterics(n)
                        alpha_sites.append({"atom_idx": n.GetIdx(), "sterics": sterics})

            if not alpha_sites:
                return None

            target_alpha = sorted(alpha_sites, key=lambda x: x["sterics"])[0]["atom_idx"]
            editable_substrate = Chem.RWMol(substrate_mol)

            # Change C=O to C-O(-) safely using verified explicit indices
            editable_substrate.GetBondBetweenAtoms(carbonyl_idx, oxygen_idx).SetBondType(Chem.BondType.SINGLE)
            editable_substrate.GetAtomWithIdx(oxygen_idx).SetFormalCharge(-1)

            # Form C=C double bond at the kinetic alpha position
            editable_substrate.GetBondBetweenAtoms(carbonyl_idx, target_alpha).SetBondType(Chem.BondType.DOUBLE)

            # Adjust implicit/explicit hydrogens cleanly to pass sanitization
            alpha_atom = editable_substrate.GetAtomWithIdx(target_alpha)
            current_hs = alpha_atom.GetNumImplicitHs()
            if current_hs > 0:
                alpha_atom.SetNumExplicitHs(current_hs - 1)
                alpha_atom.SetNoImplicit(True)

            product_mol = editable_substrate.GetMol()
            Chem.SanitizeMol(product_mol)
            return product_mol

        else:
            # ── PATHWAY B: NUCLEOPHILIC ATTACK / SUBSTITUTION ──
            best_nu_idx = None
            for atom in reagent_mol.GetAtoms():
                if atom.GetFormalCharge() < 0:
                    best_nu_idx = atom.GetIdx()
                    break

            if best_nu_idx is None:
                best_nu_idx = 0

            electrophilic_sites = []
            for atom in substrate_mol.GetAtoms():
                if atom.GetSymbol() == "C":
                    has_leaving_group = any(n.GetSymbol() in ["Cl", "Br", "I", "O"] for n in atom.GetNeighbors())
                    current_valence = sum(bond.GetBondTypeAsDouble() for bond in atom.GetBonds())

                    if has_leaving_group or atom.GetHybridization() == Chem.HybridizationType.SP2:
                        e_score = self.calculator.get_net_electronic_score(substrate_mol, atom.GetIdx())
                        sterics = self.calculator.calculate_sterics(atom)

                        electrophilic_sites.append({
                            "atom_idx": atom.GetIdx(),
                            "electronic_score": e_score,
                            "sterics": sterics,
                            "has_lg": has_leaving_group,
                            "valence": current_valence
                        })

            if not electrophilic_sites:
                return None

            valid_sites = [s for s in electrophilic_sites if s["has_lg"] or s["valence"] < 4]
            if not valid_sites:
                return None

            if control_type == "Kinetic":
                target_site = sorted(valid_sites, key=lambda x: x["sterics"])[0]
            else:
                target_site = sorted(valid_sites, key=lambda x: x["electronic_score"], reverse=True)[0]

            editable_substrate = Chem.RWMol(substrate_mol)
            target_carbon_idx = target_site["atom_idx"]

            leaving_group_idx = None
            for n in editable_substrate.GetAtomWithIdx(target_carbon_idx).GetNeighbors():
                if n.GetSymbol() in ["Cl", "Br", "I"]:
                    leaving_group_idx = n.GetIdx()
                    break

            if leaving_group_idx is not None:
                editable_substrate.RemoveBond(target_carbon_idx, leaving_group_idx)

            nu_symbol = reagent_mol.GetAtomWithIdx(best_nu_idx).GetSymbol()
            new_atom_idx = editable_substrate.AddAtom(Chem.Atom(nu_symbol))
            editable_substrate.AddBond(target_carbon_idx, new_atom_idx, Chem.BondType.SINGLE)

            product_mol = editable_substrate.GetMol()

            final_editable = Chem.RWMol(product_mol)
            isolated_indices = [a.GetIdx() for a in final_editable.GetAtoms() if a.GetDegree() == 0]
            for idx in sorted(isolated_indices, reverse=True):
                final_editable.RemoveAtom(idx)

            product_mol = final_editable.GetMol()
            Chem.SanitizeMol(product_mol)
            return product_mol

    def process_reaction_pipeline(self, substrate_smiles, reagent_smiles):
        """The Master Execution Loop managing state resolution and intermediate rerouting."""
        substrate_mol = Chem.MolFromSmiles(substrate_smiles)
        reagent_mol = Chem.MolFromSmiles(reagent_smiles)

        control_type = self.infer_environment(reagent_smiles)
        current_substrate = substrate_mol
        max_loops = 3
        loop_count = 0
        execution_history = []

        print(f"[Pipeline Activated] Conditions Deduced: {control_type} Control")

        while loop_count < max_loops:
            loop_count += 1
            result_mol = self.execute_first_principles_step(current_substrate, reagent_mol, control_type)

            if not result_mol:
                return {"error": "Reaction stalled: no reactive trajectories matched."}

            current_smiles = Chem.MolToSmiles(result_mol)

            if self.is_reactive_intermediate(result_mol):
                execution_history.append(f"Step {loop_count} (Intermediate State Generated): {current_smiles}")
                current_substrate = result_mol
                continue
            else:
                execution_history.append(f"Step {loop_count} (Stable Product Finalized): {current_smiles}")
                break

        return {
            "status": "Success",
            "environment_used": control_type,
            "steps_taken": loop_count,
            "execution_history": execution_history,
            "final_product_smiles": current_smiles
        }


if __name__ == "__main__":
    engine = MolecularReactivityEngine()

    print("=== SCENARIO A: KINETIC CONTROL WITH LDA ===")
    output_a = engine.process_reaction_pipeline(
        substrate_smiles="CC(=O)CCBr",
        reagent_smiles="CC(C)[N-]C(C)C.[Li+]"
    )
    if "error" in output_a:
        print(f"Reaction Status: {output_a['error']}")
    else:
        for log in output_a["execution_history"]:
            print(log)
        print(f"Final Output: {output_a['final_product_smiles']}")
    print()

    print("=== SCENARIO B: THERMODYNAMIC SUBSTITUTION ===")
    output_b = engine.process_reaction_pipeline(
        substrate_smiles="CCI",
        reagent_smiles="O"
    )
    if "error" in output_b:
        print(f"Reaction Status: {output_b['error']}")
    else:
        for log in output_b["execution_history"]:
            print(log)
        print(f"Final Output: {output_b['final_product_smiles']}")
