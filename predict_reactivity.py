"""
predict_reactivity.py — End-to-end prediction from image to reaction product.

This script takes an image of a reaction (e.g., substrate + reagent),
runs it through the preprocessing pipeline and OSR (DECIMER),
and then feeds the resulting SMILES into the MolecularReactivityEngine.
"""

import os
import sys
from pathlib import Path
from rdkit import Chem
from preprocessing import load_image, run_pipeline
from reactivity_engine import MolecularReactivityEngine

def get_smiles(image_path: str) -> str:
    """Call DECIMER on a saved image file."""
    from DECIMER import predict_SMILES
    return predict_SMILES(image_path)

def main(image_path_str: str):
    image_path = Path(image_path_str)
    if not image_path.exists():
        print(f"Error: File {image_path_str} not found.")
        return

    print(f"--- Processing Image: {image_path.name} ---")

    # 1. Preprocessing
    print("Step 1: Preprocessing...")
    img = load_image(str(image_path))
    # Run a default pipeline
    steps = {"perspective": True, "deskew": True, "denoise": True, "binarize": True}
    output_dir = "output_temp"
    processed_img, _ = run_pipeline(img, output_dir, image_path.stem, steps=steps)

    # 2. Setup Safe Environment for Execution & OSR
    # Moving file writing and evaluation inside the try block ensures cleanup always triggers
    temp_processed_path = "temp_processed.png"
    import cv2
    cv2.imwrite(temp_processed_path, processed_img)

    try:
        # 3. OSR (Optical Structure Recognition)
        print("Step 2: Optical Structure Recognition (OSR)...")
        smiles_out = get_smiles(temp_processed_path)
        print(f"Predicted SMILES: {smiles_out}")

        print("Step 3: Predicting Reactivity...")

        # Standardize separate chemical entities using RDKit/SMILES conventions.
        # Only treat '+' as a fragment separator when the raw string doesn't
        # parse — blindly replacing it corrupts charged atoms like [Li+].
        from rdkit import Chem
        canonical_notation = smiles_out
        if Chem.MolFromSmiles(smiles_out) is None:
            canonical_notation = smiles_out.replace('+', '.')
        mol_strings = [p.strip() for p in canonical_notation.split('.') if p.strip()]

        if len(mol_strings) < 2:
            print("Error: Could not identify two distinct molecular entities (substrate and reagent) from the image.")
            if len(mol_strings) == 1:
                print(f"Only found one molecule structure components: {mol_strings[0]}")
            return

        # Strategy: The first molecular entity parsed is isolated as the core organic substrate matrix.
        substrate = mol_strings[0]

        # Reconstruct all remaining trailing components back into a valid multi-component reagent string.
        # This preserves complex salt components (e.g., 'CC(C)[N-]C(C)C.[Li+]') rather than slicing them up.
        reagent = ".".join(mol_strings[1:])

        print(f"Substrate: {substrate}")
        print(f"Reagent:   {reagent}")

        # 4. Reactivity Prediction Loop
        engine = MolecularReactivityEngine()
        result = engine.process_reaction_pipeline(substrate, reagent)

        if "error" in result:
            print(f"Engine Error: {result['error']}")
        else:
            print("\n--- Reaction Result ---")
            print(f"Environment: {result['environment_used']} Control")
            print(f"Steps Taken: {result['steps_taken']}")
            for log in result['execution_history']:
                print(f"  {log}")
            print(f"Final Product SMILES: {result['final_product_smiles']}")

            # Validate structural integrity with RDKit
            product_mol = Chem.MolFromSmiles(result['final_product_smiles'])
            if product_mol:
                print("Product molecule validated successfully by RDKit.")

    except Exception as e:
        print(f"An error occurred during reactivity prediction: {e}")
    finally:
        # Always tear down temporary disk fragments to prevent workspace clutter
        if os.path.exists(temp_processed_path):
            os.remove(temp_processed_path)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python predict_reactivity.py <path_to_image>")
    else:
        main(sys.argv[1])
