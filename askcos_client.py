"""
askcos_client.py — thin HTTP client for an ASKCOS forward predictor.

ASKCOS answers "given these reactants, what comes out?" with a ranked list of
product SMILES and probabilities. It replaces the SMARTS template library as
the *predictor* for /react; the templates stay on as the *naming* layer (see
_name_products in app.py) and as the offline fallback.

Deliberately chemistry-light: the only chemistry here is RDKit canonicalization
and dropping outcomes that are just an unreacted input. Everything about which
reaction fired, and what it's called, stays with the deterministic engine.

Verified against https://askcos.mit.edu (2026-08-02, no auth required):

    POST /api/forward/controller/call-sync
      {"backend": "wldn5", "model_name": "pistachio",
       "smiles": ["CC(=O)c1ccccc1"], "reagents": "[BH4-].[Na+]", "solvent": ""}
    → {"status_code": 200, "message": "",
       "result": [[{"rank": 1, "outcome": "CC(O)c1ccccc1",
                    "score": -24.1, "prob": 0.9995, "mol_wt": 122.07}, ...]]}

Note `result` is doubly nested — one inner list per entry in `smiles`.

The response is normalized in exactly one place, `_parse_outcomes`. If a
different ASKCOS deployment shapes its payload differently, that method is the
only thing that needs to change.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

logger = logging.getLogger(__name__)

FORWARD_PATH = "/api/forward/controller/call-sync"

# Ranked outcomes trail off into nonsense — the live acetophenone/NaBH4 call
# returned "O", "C", "CO" and "[B-]=C" below rank 5, several at prob 0.0
# exactly. A floor is not a nicety; without it those reach the UI looking
# exactly as authoritative as the real product.
DEFAULT_MIN_PROBABILITY = 0.05
DEFAULT_MAX_PRODUCTS    = 5
DEFAULT_BACKEND         = "wldn5"
DEFAULT_MODEL_NAME      = "pistachio"
DEFAULT_TIMEOUT         = 30.0


class AskcosUnavailable(Exception):
    """ASKCOS could not be reached, or answered with something unusable.

    Always recoverable: callers fall back to the local template engine. Never
    raised for a well-formed response that simply contains no plausible
    product — that returns an empty list instead.
    """


@dataclass(frozen=True)
class Outcome:
    """One predicted product. `probability` is ASKCOS's own confidence."""
    smiles: str
    probability: float
    rank: int
    score: float | None = None
    mol_wt: float | None = None


def _canonical(smiles: str) -> str | None:
    """Canonical SMILES, or None if RDKit won't parse it."""
    from rdkit import Chem
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    return Chem.MolToSmiles(mol)


class AskcosClient:
    """Forward-prediction client. One instance is reused across requests."""

    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        backend: str = DEFAULT_BACKEND,
        model_name: str = DEFAULT_MODEL_NAME,
        timeout: float = DEFAULT_TIMEOUT,
        max_products: int = DEFAULT_MAX_PRODUCTS,
        min_probability: float = DEFAULT_MIN_PROBABILITY,
    ):
        self.base_url        = base_url.rstrip("/")
        self.token           = token
        self.backend         = backend
        self.model_name      = model_name
        self.timeout         = timeout
        self.max_products    = max_products
        self.min_probability = min_probability

    # ── Construction ─────────────────────────────────────────────────────────

    @classmethod
    def from_env(cls) -> "AskcosClient | None":
        """Build from environment, or None when ASKCOS_BASE_URL is unset.

        Unset means "ASKCOS off" — /react then behaves exactly as it did before
        this integration. That default keeps the repo working for anyone
        without an ASKCOS deployment, and doubles as the A/B switch for
        comparing ASKCOS against the template library.
        """
        base_url = os.environ.get("ASKCOS_BASE_URL", "").strip()
        if not base_url:
            return None
        return cls(
            base_url=base_url,
            token=os.environ.get("ASKCOS_TOKEN") or None,
            backend=os.environ.get("ASKCOS_BACKEND", DEFAULT_BACKEND),
            model_name=os.environ.get("ASKCOS_MODEL", DEFAULT_MODEL_NAME),
            timeout=float(os.environ.get("ASKCOS_TIMEOUT", DEFAULT_TIMEOUT)),
            max_products=int(os.environ.get("ASKCOS_MAX_PRODUCTS", DEFAULT_MAX_PRODUCTS)),
            min_probability=float(
                os.environ.get("ASKCOS_MIN_PROBABILITY", DEFAULT_MIN_PROBABILITY)
            ),
        )

    # ── Request / response plumbing ──────────────────────────────────────────

    @property
    def url(self) -> str:
        return f"{self.base_url}{FORWARD_PATH}"

    def _headers(self) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def _payload(self, reactants: list[str], reagents: str, solvent: str) -> dict:
        return {
            "backend":    self.backend,
            "model_name": self.model_name,
            "smiles":     reactants,
            "reagents":   reagents,
            "solvent":    solvent,
        }

    def _parse_outcomes(self, data: dict, reactants: list[str]) -> list[Outcome]:
        """Normalize an ASKCOS response into filtered, validated Outcomes.

        The single seam between ASKCOS's payload shape and the rest of Orgo.
        Raises AskcosUnavailable only for a response we can't interpret at all;
        individual malformed outcomes are dropped, not fatal.
        """
        if not isinstance(data, dict):
            raise AskcosUnavailable(f"Expected a JSON object, got {type(data).__name__}")

        status = data.get("status_code")
        if status is not None and int(status) != 200:
            raise AskcosUnavailable(
                f"ASKCOS status {status}: {data.get('message') or 'no message'}"
            )

        result = data.get("result")
        if result is None:
            raise AskcosUnavailable("ASKCOS response has no 'result'")
        if not isinstance(result, list):
            raise AskcosUnavailable(f"'result' is {type(result).__name__}, expected list")
        if not result:
            return []

        # Doubly nested: one inner list per input entry. We send a single
        # combined entry, so the first inner list is ours. Tolerate a flat
        # list too, in case a deployment unwraps it.
        raw = result[0] if isinstance(result[0], list) else result
        if not isinstance(raw, list):
            raise AskcosUnavailable("Could not locate the outcome list in 'result'")

        # Unreacted starting material comes back as an "outcome" regularly
        # (benzaldehyde showed up at rank 5 in the live call). It is not a
        # product, so drop anything canonically identical to an input.
        inputs = set()
        for r in reactants:
            canon = _canonical(r)
            if canon:
                inputs.update(canon.split("."))

        outcomes: list[Outcome] = []
        seen: set[str] = set()
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            smiles = entry.get("outcome")
            if not smiles or not isinstance(smiles, str):
                continue

            try:
                prob = float(entry.get("prob", 0.0))
            except (TypeError, ValueError):
                continue
            if prob < self.min_probability:
                continue

            canon = _canonical(smiles)
            if canon is None:
                logger.debug("ASKCOS returned unparseable SMILES %r — dropped", smiles)
                continue
            if canon in inputs or canon in seen:
                continue
            seen.add(canon)

            def _optional_float(key):
                try:
                    return float(entry[key])
                except (KeyError, TypeError, ValueError):
                    return None

            outcomes.append(Outcome(
                smiles=canon,
                probability=prob,
                rank=int(entry.get("rank", len(outcomes) + 1)),
                score=_optional_float("score"),
                mol_wt=_optional_float("mol_wt"),
            ))

        outcomes.sort(key=lambda o: o.probability, reverse=True)
        return outcomes[: self.max_products]

    # ── Prediction ───────────────────────────────────────────────────────────

    def predict(
        self, reactants: list[str], reagents: str = "", solvent: str = ""
    ) -> list[Outcome]:
        """Synchronous prediction, for callers already on a worker thread."""
        import httpx
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.post(self.url, json=self._payload(reactants, reagents, solvent),
                                   headers=self._headers())
                resp.raise_for_status()
                data = resp.json()
        except AskcosUnavailable:
            raise
        except Exception as exc:
            raise AskcosUnavailable(f"{type(exc).__name__}: {exc}") from exc
        return self._parse_outcomes(data, reactants)

    async def apredict(
        self, reactants: list[str], reagents: str = "", solvent: str = ""
    ) -> list[Outcome]:
        """Async prediction, for the FastAPI request path."""
        import httpx
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(self.url, json=self._payload(reactants, reagents, solvent),
                                         headers=self._headers())
                resp.raise_for_status()
                data = resp.json()
        except AskcosUnavailable:
            raise
        except Exception as exc:
            raise AskcosUnavailable(f"{type(exc).__name__}: {exc}") from exc
        return self._parse_outcomes(data, reactants)
