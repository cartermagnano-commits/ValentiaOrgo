"""
test_askcos.py — Regression suite for the ASKCOS forward-prediction client.

Run before committing changes to askcos_client.py:

    python test_askcos.py

Plain Python on purpose (matching test_templates.py): one PASS/FAIL line per
case, non-zero exit on any failure.

No live ASKCOS instance is required — every case drives a real AskcosClient
through httpx.MockTransport, so parsing, filtering and error mapping are all
exercised against canned payloads. The fixture in SAMPLE_RESPONSE is the
verbatim shape returned by https://askcos.mit.edu on 2026-08-02 for
acetophenone + NaBH4, truncated to the first eight ranks.

There is one optional live case at the end, skipped unless ASKCOS_BASE_URL is
set, so the unit run stays offline and fast.
"""

import json
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import httpx

from askcos_client import (
    AskcosClient, AskcosUnavailable, Outcome, FORWARD_PATH,
)

failures: list[str] = []
passes = 0


def check(name: str, ok: bool, detail: str = ""):
    global passes
    if ok:
        passes += 1
        print(f"PASS  {name}")
    else:
        failures.append(name)
        print(f"FAIL  {name}  {detail}")


# ── Fixtures ─────────────────────────────────────────────────────────────────

# Real response shape: doubly-nested `result`, and a long tail of junk outcomes
# at vanishing probability. Ranks 6-8 are exactly why the probability floor
# exists — "O" and "C" are not products of anything.
SAMPLE_RESPONSE = {
    "status_code": 200,
    "message": "",
    "result": [[
        {"rank": 1, "outcome": "CC(O)c1ccccc1",  "score": -24.1, "prob": 0.9995,   "mol_wt": 122.07},
        {"rank": 2, "outcome": "c1ccccc1",       "score": -32.1, "prob": 0.00034,  "mol_wt": 78.05},
        {"rank": 3, "outcome": "CCc1ccccc1",     "score": -33.3, "prob": 0.00010,  "mol_wt": 106.08},
        {"rank": 4, "outcome": "OCc1ccccc1",     "score": -34.7, "prob": 2.61e-05, "mol_wt": 108.06},
        {"rank": 5, "outcome": "CC(=O)c1ccccc1", "score": -40.1, "prob": 1.13e-07, "mol_wt": 106.04},
        {"rank": 6, "outcome": "O",              "score": -55.9, "prob": 1.46e-14, "mol_wt": 18.01},
        {"rank": 7, "outcome": "C",              "score": -89.2, "prob": 0.0,      "mol_wt": 16.03},
        {"rank": 8, "outcome": "[B-]=C",         "score": -3447.9, "prob": 0.0,    "mol_wt": 40.01},
    ]],
}

ACETOPHENONE = "CC(=O)c1ccccc1"
BOROHYDRIDE  = "[BH4-].[Na+]"


def client_returning(payload, status: int = 200, **kwargs) -> tuple[AskcosClient, list]:
    """An AskcosClient wired to a MockTransport. Returns (client, captured_requests)."""
    captured = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(status, json=payload)

    transport = httpx.MockTransport(handler)
    c = AskcosClient(base_url="https://askcos.example", **kwargs)
    _patch_transport(c, transport)
    return c, captured


def client_raising(exc: Exception, **kwargs) -> AskcosClient:
    def handler(request: httpx.Request) -> httpx.Response:
        raise exc

    c = AskcosClient(base_url="https://askcos.example", **kwargs)
    _patch_transport(c, httpx.MockTransport(handler))
    return c


def _patch_transport(client: AskcosClient, transport: httpx.MockTransport) -> None:
    """Force this client's httpx.Client to use the mock transport.

    askcos_client imports httpx lazily inside predict(), so patching the module
    attribute isn't enough; instead bind a predict() that constructs the client
    with our transport and reuses the real _parse_outcomes.
    """
    def predict(reactants, reagents="", solvent=""):
        try:
            with httpx.Client(transport=transport, timeout=client.timeout) as http:
                resp = http.post(client.url,
                                 json=client._payload(reactants, reagents, solvent),
                                 headers=client._headers())
                resp.raise_for_status()
                data = resp.json()
        except AskcosUnavailable:
            raise
        except Exception as exc:
            raise AskcosUnavailable(f"{type(exc).__name__}: {exc}") from exc
        return client._parse_outcomes(data, reactants)

    client.predict = predict


# ── Request construction ─────────────────────────────────────────────────────

c, captured = client_returning(SAMPLE_RESPONSE)
c.predict([ACETOPHENONE], reagents=BOROHYDRIDE)
req = captured[0]
body = json.loads(req.content)

check("posts to the forward controller path", req.url.path == FORWARD_PATH, str(req.url))
check("sends reactants in 'smiles' as a list",
      body["smiles"] == [ACETOPHENONE], str(body.get("smiles")))
check("sends reagents in the separate 'reagents' field",
      body["reagents"] == BOROHYDRIDE, str(body.get("reagents")))
check("defaults backend to wldn5", body["backend"] == "wldn5", str(body.get("backend")))
check("defaults model_name to pistachio",
      body["model_name"] == "pistachio", str(body.get("model_name")))
check("omits Authorization when no token set",
      "authorization" not in {k.lower() for k in req.headers}, str(req.headers))

c, captured = client_returning(SAMPLE_RESPONSE, token="secret-token")
c.predict([ACETOPHENONE])
check("sends bearer token when configured",
      captured[0].headers.get("authorization") == "Bearer secret-token",
      str(captured[0].headers.get("authorization")))

c, captured = client_returning(SAMPLE_RESPONSE, backend="graph2smiles", model_name="uspto")
c.predict([ACETOPHENONE])
body = json.loads(captured[0].content)
check("backend and model are configurable",
      body["backend"] == "graph2smiles" and body["model_name"] == "uspto", str(body))


# ── Parsing and filtering ────────────────────────────────────────────────────

c, _ = client_returning(SAMPLE_RESPONSE)
out = c.predict([ACETOPHENONE], reagents=BOROHYDRIDE)

check("unwraps the doubly-nested result", len(out) >= 1, f"got {len(out)}")
check("top outcome is the real product (1-phenylethanol)",
      out[0].smiles == "CC(O)c1ccccc1", out[0].smiles if out else "empty")
check("carries the probability through",
      abs(out[0].probability - 0.9995) < 1e-9, str(out[0].probability if out else None))
check("carries rank/score/mol_wt through",
      out[0].rank == 1 and out[0].score == -24.1 and out[0].mol_wt == 122.07,
      str(out[0]) if out else "empty")
check("returns Outcome instances", all(isinstance(o, Outcome) for o in out))

smis = [o.smiles for o in out]
check("probability floor drops the junk tail",
      not any(s in smis for s in ("O", "C", "[B-]=C")), str(smis))
check("default floor keeps only the confident product",
      smis == ["CC(O)c1ccccc1"], str(smis))
check("unreacted starting material is not reported as a product",
      "CC(=O)c1ccccc1" not in smis, str(smis))

# A lower floor lets more through, proving the filter is the thing doing the work.
c, _ = client_returning(SAMPLE_RESPONSE, min_probability=1e-6)
smis = [o.smiles for o in c.predict([ACETOPHENONE], reagents=BOROHYDRIDE)]
check("lowering the floor admits lower-ranked outcomes",
      "c1ccccc1" in smis and "OCc1ccccc1" in smis, str(smis))
check("starting material still excluded at a low floor",
      "CC(=O)c1ccccc1" not in smis, str(smis))

c, _ = client_returning(SAMPLE_RESPONSE, min_probability=0.0, max_products=2)
check("max_products caps the list",
      len(c.predict([ACETOPHENONE])) == 2, "expected 2")

c, _ = client_returning(SAMPLE_RESPONSE, min_probability=0.0)
probs = [o.probability for o in c.predict([ACETOPHENONE])]
check("outcomes are sorted by descending probability",
      probs == sorted(probs, reverse=True), str(probs))

# Products are canonicalized before leaving the client — the backend invariant
# is that nothing unvalidated reaches the frontend.
c, _ = client_returning({
    "status_code": 200, "message": "",
    "result": [[{"rank": 1, "outcome": "OC(C)c1ccccc1", "prob": 0.9}]],
})
got = c.predict(["CCCCCCCC"])
check("canonicalizes product SMILES",
      got[0].smiles == "CC(O)c1ccccc1", got[0].smiles if got else "empty")

# One bad apple must not spoil the response.
c, _ = client_returning({
    "status_code": 200, "message": "",
    "result": [[
        {"rank": 1, "outcome": "this-is-not-smiles", "prob": 0.9},
        {"rank": 2, "outcome": "CCO", "prob": 0.8},
    ]],
})
got = [o.smiles for o in c.predict(["CCCCCCCC"])]
check("drops unparseable SMILES without failing the request",
      got == ["CCO"], str(got))

c, _ = client_returning({
    "status_code": 200, "message": "",
    "result": [[
        {"rank": 1, "outcome": "CCO", "prob": 0.9},
        {"rank": 2, "outcome": "OCC", "prob": 0.5},
    ]],
})
check("deduplicates outcomes that canonicalize identically",
      len(c.predict(["CCCCCCCC"])) == 1, "expected 1")

c, _ = client_returning({"status_code": 200, "message": "", "result": []})
check("empty result is an empty list, not an error", c.predict(["CCO"]) == [])

c, _ = client_returning({
    "status_code": 200, "message": "",
    "result": [{"rank": 1, "outcome": "CCO", "prob": 0.9}],
})
check("tolerates a flat (un-nested) result list",
      [o.smiles for o in c.predict(["CCCCCCCC"])] == ["CCO"])


# ── Error mapping — everything recoverable becomes AskcosUnavailable ─────────

def expect_unavailable(name: str, fn):
    try:
        fn()
        check(name, False, "no exception raised")
    except AskcosUnavailable:
        check(name, True)
    except Exception as exc:
        check(name, False, f"raised {type(exc).__name__} instead: {exc}")


c, _ = client_returning({"detail": "nope"}, status=500)
expect_unavailable("HTTP 500 raises AskcosUnavailable", lambda: c.predict(["CCO"]))

c, _ = client_returning({"detail": "nope"}, status=404)
expect_unavailable("HTTP 404 raises AskcosUnavailable", lambda: c.predict(["CCO"]))

c = client_raising(httpx.ConnectError("refused"))
expect_unavailable("connection failure raises AskcosUnavailable", lambda: c.predict(["CCO"]))

c = client_raising(httpx.ReadTimeout("too slow"))
expect_unavailable("timeout raises AskcosUnavailable", lambda: c.predict(["CCO"]))

c, _ = client_returning({"status_code": 500, "message": "model down", "result": None})
expect_unavailable("in-band error status raises AskcosUnavailable", lambda: c.predict(["CCO"]))

c, _ = client_returning({"status_code": 200, "message": ""})
expect_unavailable("missing 'result' raises AskcosUnavailable", lambda: c.predict(["CCO"]))

c, _ = client_returning({"status_code": 200, "result": "not-a-list"})
expect_unavailable("non-list 'result' raises AskcosUnavailable", lambda: c.predict(["CCO"]))

c, _ = client_returning(["not", "an", "object"])
expect_unavailable("non-object payload raises AskcosUnavailable", lambda: c.predict(["CCO"]))


# ── from_env ─────────────────────────────────────────────────────────────────

_saved = {k: os.environ.get(k) for k in (
    "ASKCOS_BASE_URL", "ASKCOS_TOKEN", "ASKCOS_BACKEND", "ASKCOS_MODEL",
    "ASKCOS_TIMEOUT", "ASKCOS_MAX_PRODUCTS", "ASKCOS_MIN_PROBABILITY",
)}
for k in _saved:
    os.environ.pop(k, None)

check("from_env returns None when ASKCOS_BASE_URL is unset",
      AskcosClient.from_env() is None)

os.environ["ASKCOS_BASE_URL"] = "   "
check("from_env treats a blank base URL as unset", AskcosClient.from_env() is None)

os.environ["ASKCOS_BASE_URL"] = "https://askcos.mit.edu/"
env_client = AskcosClient.from_env()
check("from_env builds a client when the base URL is set", env_client is not None)
check("from_env strips the trailing slash from the base URL",
      env_client.base_url == "https://askcos.mit.edu", env_client.base_url)
check("from_env composes the forward URL correctly",
      env_client.url == f"https://askcos.mit.edu{FORWARD_PATH}", env_client.url)
check("from_env leaves the token unset when absent", env_client.token is None)

os.environ.update({
    "ASKCOS_TOKEN": "tok", "ASKCOS_BACKEND": "augmented-transformer",
    "ASKCOS_MODEL": "uspto", "ASKCOS_TIMEOUT": "12.5",
    "ASKCOS_MAX_PRODUCTS": "3", "ASKCOS_MIN_PROBABILITY": "0.25",
})
env_client = AskcosClient.from_env()
check("from_env reads every override",
      (env_client.token == "tok" and env_client.backend == "augmented-transformer"
       and env_client.model_name == "uspto" and env_client.timeout == 12.5
       and env_client.max_products == 3 and env_client.min_probability == 0.25),
      str(env_client.__dict__))

for k, v in _saved.items():
    if v is None:
        os.environ.pop(k, None)
    else:
        os.environ[k] = v


# ── Optional live check (skipped unless ASKCOS_BASE_URL is set) ──────────────

if os.environ.get("ASKCOS_BASE_URL"):
    live = AskcosClient.from_env()
    try:
        got = live.predict([ACETOPHENONE], reagents=BOROHYDRIDE)
        check("LIVE: acetophenone + NaBH4 gives 1-phenylethanol",
              bool(got) and got[0].smiles == "CC(O)c1ccccc1",
              str([o.smiles for o in got]))
    except AskcosUnavailable as exc:
        check("LIVE: ASKCOS reachable", False, str(exc))
else:
    print("SKIP  live ASKCOS check (set ASKCOS_BASE_URL to enable)")


# ── Summary ──────────────────────────────────────────────────────────────────

print()
print(f"{passes} passed, {len(failures)} failed")
if failures:
    for f in failures:
        print(f"  FAILED: {f}")
    sys.exit(1)
