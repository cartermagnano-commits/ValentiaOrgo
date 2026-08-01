"""test_reaction_arbitration.py — verdict-table suite for reaction_arbitration.

Plain python (no pytest):
    python test_reaction_arbitration.py

Uses check(name, got, want) rather than test_osr.py's check(name, ok, detail) —
better failure output for value comparisons.
"""

import sys

from reaction_arbitration import (
    agreement, candidate_pool, looks_degenerate_product, plausible_products,
    verdict,
)

_passed = 0
_failed = 0


def check(name, got, want):
    global _passed, _failed
    if got == want:
        print(f"PASS  {name}")
        _passed += 1
    else:
        print(f"FAIL  {name}\n        got:  {got!r}\n        want: {want!r}")
        _failed += 1


# ── degeneracy gate ──────────────────────────────────────────────────────────
check("degenerate: dummy atom rejected", looks_degenerate_product("*CCO"), True)
check("degenerate: long alkane rejected", looks_degenerate_product("C" * 30), True)
check("degenerate: repeated fragment rejected",
      looks_degenerate_product("CC=O.CC=O.CC=O.CC=O"), True)
check("degenerate: many fragments rejected",
      looks_degenerate_product(".".join(["C"] * 13)), True)
check("degenerate: normal product accepted", looks_degenerate_product("CC(=O)CCO"), False)
check("degenerate: empty string rejected", looks_degenerate_product(""), True)
check("plausible filters the bad ones",
      plausible_products(["CC(=O)CCO", "*CCO", ""]), ["CC(=O)CCO"])

# ── agreement ────────────────────────────────────────────────────────────────
check("agreement: exact match found", agreement(["CCO", "CC=O"], ["CC=O"]), "CC=O")
check("agreement: no overlap", agreement(["CCO"], ["CC=O"]), None)
check("agreement: empty ai side", agreement(["CCO"], []), None)
check("agreement: empty engine side", agreement([], ["CCO"]), None)
check("agreement: first engine product wins ordering",
      agreement(["CCO", "CC=O"], ["CC=O", "CCO"]), "CCO")

# ── verdict table ────────────────────────────────────────────────────────────
check("verdict: round-1 agreement is verified",
      verdict(["CCO"], ["CCO"], 1, False), ("verified", "CCO"))
check("verdict: converged at round 3 still verified",
      verdict(["CCO"], ["CCO"], 3, False), ("verified", "CCO"))
check("verdict: persistent disagreement is disputed",
      verdict(["CCO"], ["CC=O"], 3, False), ("disputed", None))
check("verdict: engine empty + valid ai is ai_only",
      verdict([], ["CCO"], 1, False), ("ai_only", "CCO"))
check("verdict: engine empty + no ai is unverified",
      verdict([], [], 1, False), ("unverified", None))
check("verdict: ai failure keeps engine result unverified",
      verdict(["CCO"], [], 1, True), ("unverified", None))
check("verdict: ai produced nothing usable is unverified",
      verdict(["CCO"], [], 3, False), ("unverified", None))
check("verdict: engine empty + ai failed is unverified",
      verdict([], [], 1, True), ("unverified", None))

# ── candidate pool ───────────────────────────────────────────────────────────
pool = candidate_pool(["CCO", "CC=O"], ["CC=O", "CCC"], seed=7)
check("pool: deduplicated union", sorted(pool), ["CC=O", "CCC", "CCO"])
check("pool: deterministic for a given seed",
      candidate_pool(["CCO", "CC=O"], ["CC=O", "CCC"], seed=7), pool)
check("pool: drops degenerate candidates",
      sorted(candidate_pool(["CCO"], ["*CC"], seed=1)), ["CCO"])

# ── response parsing (imports app; heavier, kept last) ───────────────────────
import app  # noqa: E402

check("parse: bare smiles", app._parse_smiles_list("CCO"), ["CCO"])
check("parse: prose around smiles",
      app._parse_smiles_list("The major product is CC(=O)CCO here."), ["CC(=O)CCO"])
check("parse: newline separated, order kept",
      app._parse_smiles_list("CCO\nCC=O"), ["CCO", "CC=O"])
check("parse: markdown fence stripped",
      app._parse_smiles_list("```\nCCO\n```"), ["CCO"])
check("parse: garbage yields nothing", app._parse_smiles_list("I am not sure."), [])
check("parse: empty yields nothing", app._parse_smiles_list(""), [])
check("parse: degenerate output filtered", app._parse_smiles_list("*CCO"), [])
check("parse: duplicates collapsed", app._parse_smiles_list("CCO\nOCC"), ["CCO"])
check("parse: honors limit", len(app._parse_smiles_list("CCO\nCC=O\nCCC\nCCCC\nCCCCC", limit=2)), 2)

# ── prose words that happen to be valid diatomic SMILES (round-1 fix) ───────
check("parse: NO as prose word is not a product",
      app._parse_smiles_list("I cannot determine this. NO reaction occurs."), [])
check("parse: CO as prose word is not a product",
      app._parse_smiles_list("There is CO present in the mixture"), [])
check("parse: bare CO line is still trusted as methanol",
      app._parse_smiles_list("CO"), ["CO"])

print(f"\n{_passed} passed, {_failed} failed")
sys.exit(1 if _failed else 0)
