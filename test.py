import json
from reactivity_engine import MolecularReactivityEngine

def print_engine_results(smiles_A, smiles_B=None):
    """Wrapper function to format and print the backend output nicely."""
    engine = MolecularReactivityEngine()

    # Run the engine
    # Note: MolecularReactivityEngine uses process_reaction_pipeline which infers conditions
    output = engine.process_reaction_pipeline(smiles_A, smiles_B)

    # Format the dictionary output into a clean, readable string (pretty printing)
    formatted_json = json.dumps(output, indent=4)

    print("=" * 60)
    print(f"INPUTS:\n  Substrate: {smiles_A}\n  Reagent:   {smiles_B or 'None'}")
    print("=" * 60)
    print("ENGINE OUTPUT:")
    print(formatted_json)
    print("=" * 60 + "\n")

# ==============================================================================
# RUNNING THE TEST CASES
# ==============================================================================
if __name__ == "__main__":
    print("\n🚀 STARTING TERMINAL TEST SUITE 🚀\n")

    # Test Case 1: Thermodynamic Control (using water as default thermodynamic reagent)
    # 4-bromobutan-2-one + Water
    print_engine_results(
        smiles_A="CC(=O)CCBr",
        smiles_B="O"
    )

    # Test Case 2: Kinetic Control (using LDA)
    # 4-bromobutan-2-one + LDA
    print_engine_results(
        smiles_A="CC(=O)CCBr",
        smiles_B="CC(C)[N-]C(C)C.[Li+]"
    )
