"""
reagents.py — The reagent catalog for /pathways fan-out and condition inference.

This is the single place to add or remove reagents. "conditions" tags are
matched against each template's "conditions" field in reaction_templates.json:
a template fires only when its conditions intersect with the reagent's.

Kept free of heavy imports on purpose — diagnose_templates.py and
test_templates.py import this module without dragging in the FastAPI app
(and its TensorFlow/DECIMER warm-load).
"""

REAGENT_LIST = [
    {
        "name": "LDA",
        "smiles": "CC(C)[N-]C(C)C.[Li+]",
        "description": "Lithium diisopropylamide — strong, hindered kinetic base",
        "conditions": ["kinetic_base", "strong_base"],
    },
    {
        "name": "t-BuOK",
        "smiles": "[O-]C(C)(C)C.[K+]",
        "description": "Potassium tert-butoxide — strong, hindered base / alkoxide",
        "conditions": ["kinetic_base", "strong_base", "alkoxide"],
    },
    {
        "name": "NaOEt",
        "smiles": "CC[O-].[Na+]",
        "description": "Sodium ethoxide — strong base / alkoxide nucleophile",
        "conditions": ["strong_base", "alkoxide"],
    },
    {
        "name": "NaOH",
        "smiles": "[OH-].[Na+]",
        "description": "Sodium hydroxide — strong base / hydroxide nucleophile",
        "conditions": ["strong_base", "hydroxide"],
    },
    {
        "name": "Water",
        "smiles": "O",
        "description": "Water — weak nucleophile / protic solvent",
        "conditions": ["protic"],
    },
    {
        "name": "NaI",
        "smiles": "[Na+].[I-]",
        "description": "Sodium iodide — iodide nucleophile (Finkelstein)",
        "conditions": ["halide_nucleophile"],
    },
    {
        "name": "NaCl",
        "smiles": "[Na+].[Cl-]",
        "description": "Sodium chloride — chloride nucleophile",
        "conditions": ["halide_nucleophile"],
    },
    {
        "name": "NaH",
        "smiles": "[Na+].[H-]",
        "description": "Sodium hydride — strong base for alcohol deprotonation (Williamson ether synthesis)",
        "conditions": ["strong_base"],
    },
    {
        "name": "NaBH4",
        "smiles": "[BH4-].[Na+]",
        "description": "Sodium borohydride — mild hydride reducing agent (aldehydes and ketones → alcohols)",
        "conditions": ["hydride"],
    },
    {
        "name": "LiAlH4",
        "smiles": "[AlH4-].[Li+]",
        "description": "Lithium aluminium hydride — strong reducing agent (aldehydes, ketones, esters, carboxylic acids → alcohols)",
        "conditions": ["hydride"],
    },
    {
        "name": "HBr",
        "smiles": "Br",
        "description": "Hydrogen bromide — Markovnikov addition to alkenes; SN2 on alcohols",
        "conditions": ["hbr"],
    },
    {
        "name": "HCl",
        "smiles": "Cl",
        "description": "Hydrogen chloride — Markovnikov addition to alkenes",
        "conditions": ["hcl"],
    },
    {
        "name": "HI",
        "smiles": "I",
        "description": "Hydrogen iodide — Markovnikov addition to alkenes; most reactive HX",
        "conditions": ["hi"],
    },
    {
        "name": "Br2",
        "smiles": "BrBr",
        "description": "Bromine — anti addition to alkenes → vicinal dibromide",
        "conditions": ["halogenation"],
    },
    {
        "name": "Cl2",
        "smiles": "ClCl",
        "description": "Chlorine — anti addition to alkenes → vicinal dichloride",
        "conditions": ["halogenation"],
    },
    {
        "name": "NH3",
        "smiles": "N",
        "description": "Ammonia — nucleophilic N-alkylation with alkyl halides",
        "conditions": ["amine_nucleophile"],
    },
    {
        "name": "H2SO4",
        "smiles": "OS(=O)(=O)O",
        "description": "Sulfuric acid — acid catalyst for alcohol dehydration and alkene hydration",
        "conditions": ["acid"],
    },
]
