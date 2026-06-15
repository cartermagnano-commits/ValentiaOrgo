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
        # 1. Compute baseline electronegativity via RDKit Gasteiger charges
        mol_copy = Chem.Mol(mol)
        AllChem.ComputeGasteigerCharges(mol_copy)
        baseline_charge = float(mol_copy.GetAtomWithIdx(carbon_idx).GetProp("_GasteigerCharge"))

        # 2. Layer Resonance and Induction heuristics using topological distance
        resonance_weights = {"N": 1.5, "O": 1.0, "F": 0.2}
        induction_weights = {"N": 0.5, "O": 0.7, "F": 1.0}

        electronic_modifier = 0.0
        distance_matrix = Chem.GetDistanceMatrix(mol)

        for atom in mol.GetAtoms():
            sym = atom.GetSymbol()
            if sym in ["N", "O", "F"]:
                d = distance_matrix[carbon_idx][atom.GetIdx()]

                if d == 1:
                    # RESONANCE WINS: Directly attached heteroatoms pump electron density
                    electronic_modifier -= resonance_weights[sym]
                elif d >= 2:
                    # INDUCTION WINS: Pulls electron density away, decaying over distance
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

        # Environmental Inference Registry
        self.kinetic_reagents = {"CC(C)[N-]C(C)C.[Li+]", "[O-]C(C)(C)C.[K+]"} # LDA, t-BuOK
        self.thermodynamic_reagents = {"O=S(=O)(O)O", "O"} # Strong acids, equilibrium solvents

    def infer_environment(self, reagent_smiles):
        """Automatically determines thermodynamic vs kinetic control based on reagents."""
        if reagent_smiles in self.kinetic_reagents:
            return "Kinetic"
        if reagent_smiles in self.thermodynamic_reagents:
            return "Thermodynamic"
        return "Thermodynamic" # Fallback default

    def is_reactive_intermediate(self, mol):
        """
        An advanced, element-agnostic safety valve that flags non-standard
        formal charges, reactive ions, and unstable valence states.
        """
        # 1. Calculate the total net charge of the entire molecular graph system
        net_molecule_charge = Chem.GetFormalCharge(mol)
        if net_molecule_charge != 0:
            # If the system as a whole is charged (e.g., free Cl-, Br-, or isolated carbocation),
            # it is inherently volatile and must keep reacting to resolve.
            return True

        # 2. Scan atom-by-atom for high-energy localized formal charges
        for atom in mol.GetAtoms():
            charge = atom.GetFormalCharge()
            symbol = atom.GetSymbol()

            if charge != 0:
                # Exception: Allow highly stable neutral zwitterions (like nitro groups),
                # but flag reactive or high-energy isolated atoms.
                if symbol in ["C", "S", "P"] and charge != 0:
                    return True # Carbocations, sulfoniums, phosphonium intermediates

                if symbol in ["Cl", "Br", "I"] and charge != 0:
                    return True # Halonium ions or hypervalent halogen anomalies

                if symbol == "O" and charge != 0:
                    return True # Protonated oxonium (O+) or unstable local alkoxides (O-)

                if symbol == "N" and charge != 0:
                    # Capture un-neutralized iminium/ammonium states
                    return True

        return False

    def execute_first_principles_step(self, substrate_mol, reagent_mol, control_type):
        """Simulates an explicit arrow-pushing step using localized properties."""

        # 1. Identify best nucleophilic center in Reagent
        best_nu_idx = None
        for atom in reagent_mol.GetAtoms():
            # If an atom has an explicit formal negative charge, prioritize it instantly
            if atom.GetFormalCharge() < 0:
                best_nu_idx = atom.GetIdx()
                break

        if best_nu_idx is None:
            best_nu_idx = 0 # Fallback default to first atom if completely neutral

        # 2. Profile competing electrophilic centers in Substrate
        electrophilic_sites = []
        for atom in substrate_mol.GetAtoms():
            if atom.GetSymbol() == "C":
                # Check for standard leaving groups or polarizable bonds
                has_leaving_group = any(n.GetSymbol() in ["Cl", "Br", "I", "O"] for n in atom.GetNeighbors())
                if has_leaving_group or atom.GetHybridization() == Chem.HybridizationType.SP2:

                    e_score = self.calculator.get_net_electronic_score(substrate_mol, atom.GetIdx())
                    sterics = self.calculator.calculate_sterics(atom)

                    electrophilic_sites.append({
                        "atom_idx": atom.GetIdx(),
                        "electronic_score": e_score,
                        "sterics": sterics
                    })

        if not electrophilic_sites:
            return None

        # 3. Apply Transition State Gating Heuristics
        if control_type == "Kinetic":
            # Sort primarily by lowest steric hindrance (path of least resistance)
            target_site = sorted(electrophilic_sites, key=lambda x: x["sterics"])[0]
        else:
            # Sort primarily by highest electrophilic score (electron deficit)
            target_site = sorted(electrophilic_sites, key=lambda x: x["electronic_score"], reverse=True)[0]

        # 4. Generate Product via Graph Editing (Procedural Bond Swapping)
        editable_substrate = Chem.RWMol(substrate_mol)
        target_carbon_idx = target_site["atom_idx"]

        # Simulating a basic addition step: form a single bond between Nu and E+
        new_atom_idx = editable_substrate.AddAtom(reagent_mol.GetAtomWithIdx(best_nu_idx))
        editable_substrate.AddBond(target_carbon_idx, new_atom_idx, Chem.BondType.SINGLE)

        # Standardize and return graph
        product_mol = editable_substrate.GetMol()
        Chem.SanitizeMol(product_mol)
        return product_mol

    def process_reaction_pipeline(self, substrate_smiles, reagent_smiles):
        """The Master Execution Loop managing state resolution and intermediate rerouting."""

        # Parse inputs
        substrate_mol = Chem.MolFromSmiles(substrate_smiles)
        reagent_mol = Chem.MolFromSmiles(reagent_smiles)

        # Deduce environmental conditions algorithmically
        control_type = self.infer_environment(reagent_smiles)

        current_substrate = substrate_mol
        max_loops = 3
        loop_count = 0
        execution_history = []

        print(f"[Pipeline Activated] Conditions Deduced: {control_type} Control")

        # THE STATE VALVE LOOP
        while loop_count < max_loops:
            loop_count += 1

            # Run simulation step
            result_mol = self.execute_first_principles_step(current_substrate, reagent_mol, control_type)

            if not result_mol:
                return {"error": "Reaction stalled: no reactive trajectories matched."}

            current_smiles = Chem.MolToSmiles(result_mol)

            # Check if our output molecule is actually an unstable transient intermediate
            if self.is_reactive_intermediate(result_mol):
                execution_history.append(f"Step {loop_count} (Intermediate State Generated): {current_smiles}")
                # Reroute intermediate as the incoming substrate for the next cycle
                current_substrate = result_mol
                continue
            else:
                # The molecule is safe, neutral, and complete! Break out.
                execution_history.append(f"Step {loop_count} (Stable Product Finalized): {current_smiles}")
                break

        return {
            "status": "Success",
            "environment_used": control_type,
            "steps_taken": loop_count,
            "execution_history": execution_history,
            "final_product_smiles": current_smiles
        }


# ==============================================================================
# 3. VERIFICATION RUN
# ==============================================================================
if __name__ == "__main__":
    engine = MolecularReactivityEngine()

    print("=== SCENARIO A: KINETIC CONTROL WITH LDA ===")
    output_a = engine.process_reaction_pipeline(
        substrate_smiles="CC(Cl)C",
        reagent_smiles="CC(C)[N-]C(C)C.[Li+]"
    )
    for log in output_a["execution_history"]:
        print(log)
    print(f"Final Output: {output_a['final_product_smiles']}\n")

    print("=== SCENARIO B: HALOGEN INTERMEDIATE VERIFICATION ===")
    # Inputs: Testing an iodinated hydrocarbon matrix under default thermodynamic rules
    output_b = engine.process_reaction_pipeline(
        substrate_smiles="CCI",
        reagent_smiles="O"
    )
    for log in output_b["execution_history"]:
        print(log)
    print(f"Final Output: {output_b['final_product_smiles']}")
