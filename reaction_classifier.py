"""
reaction_classifier.py — Deterministic reaction name lookup.

Add new reactions by appending to REACTION_RULES. Each entry is a tuple:
  (name, confidence, match_fn(sub_mol, prod_mol, reagent_smiles, environment))

The first matching rule wins. The LLM never calls this — this IS the ground truth.
"""

from rdkit import Chem
from rdkit.Chem import AllChem

# ── SMARTS patterns ───────────────────────────────────────────────────────────

_CARBONYL     = Chem.MolFromSmarts("[CX3]=[OX1]")
_ENOLATE      = Chem.MolFromSmarts("[CX3]=[CX3]-[OX2-]")  # enolate C=C-O(-)
_ALKYL_HALIDE = Chem.MolFromSmarts("[CX4][Cl,Br,I]")
_ARYL_HALIDE  = Chem.MolFromSmarts("c[Cl,Br,I]")
_ALCOHOL      = Chem.MolFromSmarts("[CX4][OX2H]")
_ETHER        = Chem.MolFromSmarts("[CX4][OX2][CX4]")
_ALKENE       = Chem.MolFromSmarts("[CX3]=[CX3]")
_EPOXIDE      = Chem.MolFromSmarts("[C]1[O][C]1")

# Canonical SMILES for reagents the engine explicitly handles as kinetic bases
_raw_kinetic = ["CC(C)[N-]C(C)C.[Li+]", "[O-]C(C)(C)C.[K+]"]
_KINETIC_BASES: set[str] = set()
for _s in _raw_kinetic:
    _m = Chem.MolFromSmiles(_s)
    if _m:
        _KINETIC_BASES.add(Chem.MolToSmiles(_m))


def _canon(smiles: str) -> str | None:
    m = Chem.MolFromSmiles(smiles)
    return Chem.MolToSmiles(m) if m else None


def _has(mol, pattern) -> bool:
    return mol is not None and mol.HasSubstructMatch(pattern)


def _is_kinetic_base(reagent_smiles: str) -> bool:
    c = _canon(reagent_smiles)
    return bool(c and c in _KINETIC_BASES)


def _halide_count(mol) -> int:
    """Count halide (Cl/Br/I) atoms on sp3 carbons."""
    pat = Chem.MolFromSmarts("[CX4][Cl,Br,I]")
    return len(mol.GetSubstructMatches(pat))


# ── Rules (first match wins) ──────────────────────────────────────────────────
# Tuple: (display_name, confidence, match_fn)

REACTION_RULES: list[tuple[str, str, object]] = [

    # 1. Kinetic enolate formation (LDA / t-BuOK + carbonyl substrate → enolate)
    (
        "Kinetic enolate formation",
        "high",
        lambda sub, prod, rea, env: (
            env == "Kinetic"
            and _is_kinetic_base(rea)
            and _has(sub, _CARBONYL)
            and _has(prod, _ENOLATE)
        ),
    ),

    # 2. Kinetic base deprotonation — base used, carbonyl present, but non-enolate product
    (
        "Base-mediated deprotonation (kinetic control)",
        "medium",
        lambda sub, prod, rea, env: (
            env == "Kinetic"
            and _is_kinetic_base(rea)
            and _has(sub, _CARBONYL)
        ),
    ),

    # 3. SN2 substitution — alkyl halide loses halide, nucleophile added
    (
        "SN2 nucleophilic substitution",
        "high",
        lambda sub, prod, rea, env: (
            _has(sub, _ALKYL_HALIDE)
            and _halide_count(prod) < _halide_count(sub)
            and not _is_kinetic_base(rea)
        ),
    ),

    # 4. Nucleophilic addition to carbonyl → alcohol
    (
        "Nucleophilic addition to carbonyl",
        "medium",
        lambda sub, prod, rea, env: (
            _has(sub, _CARBONYL)
            and not _has(sub, _ALKYL_HALIDE)
            and not _is_kinetic_base(rea)
            and _has(prod, _ALCOHOL)
        ),
    ),

    # 5. Ether synthesis (Williamson-type: alkyl halide + alkoxide → ether)
    (
        "Williamson ether synthesis",
        "medium",
        lambda sub, prod, rea, env: (
            _has(sub, _ALKYL_HALIDE)
            and _has(prod, _ETHER)
            and not _is_kinetic_base(rea)
        ),
    ),

    # 6. Thermodynamic carbonyl chemistry (weak base/nucleophile + C=O, no leaving group)
    (
        "Thermodynamic carbonyl activation",
        "low",
        lambda sub, prod, rea, env: (
            env == "Thermodynamic"
            and _has(sub, _CARBONYL)
            and not _has(sub, _ALKYL_HALIDE)
        ),
    ),
]


def classify_reaction(
    substrate_smiles: str,
    product_smiles: str,
    reagent_smiles: str,
    environment_used: str,
    execution_history: list[str],
) -> dict:
    """
    Returns {"name": str, "confidence": "high"|"medium"|"low"|"unknown"}.
    This function — not the LLM — authoritatively names every reaction.
    """
    sub  = Chem.MolFromSmiles(substrate_smiles)
    prod = Chem.MolFromSmiles(product_smiles)

    if sub is None or prod is None:
        return {"name": "Unknown / not yet classified", "confidence": "unknown"}

    for name, confidence, match_fn in REACTION_RULES:
        try:
            if match_fn(sub, prod, reagent_smiles, environment_used):
                return {"name": name, "confidence": confidence}
        except Exception:
            continue

    return {"name": "Unknown / not yet classified", "confidence": "unknown"}
