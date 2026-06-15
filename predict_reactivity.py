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
    processed_img = run_pipeline(img, steps, save_stages_dir=None)
    
    # Save temporary processed image for OSR
    temp_processed_path = "temp_processed.png"
    import cv2
    cv2.imwrite(temp_processed_path, processed_img)

    # 2. OSR (Optical Structure Recognition)
    print("Step 2: Optical Structure Recognition (OSR)...")
    smiles_out = get_smiles(temp_processed_path)
    print(f"Predicted SMILES: {smiles_out}")

    # 3. Reactivity Engine
    print("Step 3: Predicting Reactivity...")
    
    # Simple heuristic to split SMILES if multiple molecules are detected (often separated by '.')
    # DECIMER often returns multiple molecules separated by '.' or '+'
    # We'll try to split and find two molecules.
    parts = smiles_out.replace('+', '.').split('.')
    parts = [p.strip() for p in parts if p.strip()]
    
    if len(parts) < 2:
        print("Error: Could not identify two distinct molecules (substrate and reagent) from the image.")
        if len(parts) == 1:
            print(f"Only found one molecule: {parts[0]}")
        return

    substrate = parts[0]
    reagent = parts[1]
    
    print(f"Substrate: {substrate}")
    print(f"Reagent:   {reagent}")

    engine = MolecularReactivityEngine()
    try:
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
            
            # Show the product if possible (text-based for now)
            product_mol = Chem.MolFromSmiles(result['final_product_smiles'])
            if product_mol:
                print("Product molecule validated by RDKit.")
                
    except Exception as e:
        print(f"An error occurred during reactivity prediction: {e}")
    finally:
        if os.path.exists(temp_processed_path):
            os.remove(temp_processed_path)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python predict_reactivity.py <path_to_image>")
    else:
        main(sys.argv[1])
