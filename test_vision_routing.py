"""test_vision_routing.py — vision provider selection, no network calls.

Plain python (no pytest):
    python test_vision_routing.py
"""

import os
import sys

import app

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


# ── engine field parsing ─────────────────────────────────────────────────────
check("engine field: None stays None", app._parse_engine_field(None), None)
check("engine field: empty stays None", app._parse_engine_field(""), None)
check("engine field: junk stays None", app._parse_engine_field("{not json"), None)
parsed = app._parse_engine_field('{"mode":"hosted","provider":"anthropic"}')
check("engine field: mode parsed", parsed.mode, "hosted")
check("engine field: provider parsed", parsed.provider, "anthropic")

# Vision may return textbook reagent formulae inside an otherwise-valid SMILES
# mixture. They must be expanded before RDKit validation so the whole reaction
# reaches ASKCOS rather than collapsing to the lone organic substrate.
check(
    "vision formula aliases: nitrating mixture becomes valid SMILES",
    app._smiles_from_vision_text("c1ccccc1.HNO3.H2SO4", "TestVision"),
    "O=S(=O)(O)O.O=[N+]([O-])O.c1ccccc1",
)
check(
    "vision formula aliases: slash notation expands both acids",
    app._smiles_from_vision_text("c1ccccc1.HNO3/H2SO4", "TestVision"),
    "O=S(=O)(O)O.O=[N+]([O-])O.c1ccccc1",
)

# The Reaction tab uses _cloud_vision_smiles, not the legacy Claude helper.
# Stub the SDK response to prove the active provider route uses the same
# formula-normalizing parser without making a network request.
import anthropic  # noqa: E402


class _FakeTextBlock:
    type = "text"
    text = "c1ccccc1.HNO3.H2SO4"


class _FakeVisionResponse:
    content = [_FakeTextBlock()]


class _FakeMessages:
    @staticmethod
    def create(**kwargs):
        return _FakeVisionResponse()


class _FakeAnthropicClient:
    messages = _FakeMessages()


orig_anthropic_client = anthropic.Anthropic
try:
    anthropic.Anthropic = lambda **kwargs: _FakeAnthropicClient()
    check(
        "cloud vision route normalizes formula-style reagents",
        app._cloud_vision_smiles(b"image", "prompt", "anthropic", None, "sk-test"),
        "O=S(=O)(O)O.O=[N+]([O-])O.c1ccccc1",
    )
finally:
    anthropic.Anthropic = orig_anthropic_client

# ── provider selection: which backend does the router reach for? ─────────────
calls = []


def fake_cloud(img, prompt, provider, model, api_key):
    calls.append(("cloud", provider, model))
    return "CCO"


def fake_ollama(img, prompt):
    calls.append(("ollama", None, None))
    return "CC=O"


orig_cloud, orig_ollama = app._cloud_vision_smiles, app._ollama_call
orig_anthropic = os.environ.get("ANTHROPIC_API_KEY")
app._cloud_vision_smiles, app._ollama_call = fake_cloud, fake_ollama
try:
    # Local mode must never reach the cloud, even with a key configured.
    os.environ["ANTHROPIC_API_KEY"] = "sk-test"
    calls.clear()
    app._vision_smiles_routed(b"x", "p", app.EngineConfig(mode="local"))
    check("local mode → ollama", [c[0] for c in calls], ["ollama"])

    # Hosted with a server key → cloud.
    calls.clear()
    app._vision_smiles_routed(b"x", "p", app.EngineConfig(mode="hosted", provider="anthropic"))
    check("hosted+key → cloud anthropic", [(c[0], c[1]) for c in calls], [("cloud", "anthropic")])

    # BYOK carries the caller's key.
    calls.clear()
    app._vision_smiles_routed(
        b"x", "p",
        app.EngineConfig(mode="byok", provider="openai", api_key="sk-user", model="gpt-4o"))
    check("byok openai → cloud openai", [(c[0], c[1]) for c in calls], [("cloud", "openai")])
    check("byok passes model through", calls[0][2], "gpt-4o")

    # BYOK without a key can't reach the cloud — fall to local.
    calls.clear()
    app._vision_smiles_routed(b"x", "p", app.EngineConfig(mode="byok", provider="openai"))
    check("byok w/o key → ollama", [c[0] for c in calls], ["ollama"])

    # Hosted with NO server key at all → local fallback.
    os.environ.pop("ANTHROPIC_API_KEY", None)
    calls.clear()
    app._vision_smiles_routed(b"x", "p", app.EngineConfig(mode="hosted", provider="anthropic"))
    check("hosted w/o key → ollama", [c[0] for c in calls], ["ollama"])

    # No engine config at all → current behavior (local).
    calls.clear()
    app._vision_smiles_routed(b"x", "p", None)
    check("no engine → ollama", [c[0] for c in calls], ["ollama"])

    # Cloud failure falls through to local rather than returning nothing.
    os.environ["ANTHROPIC_API_KEY"] = "sk-test"
    app._cloud_vision_smiles = lambda *a, **k: None
    calls.clear()
    got = app._vision_smiles_routed(b"x", "p", app.EngineConfig(mode="hosted", provider="anthropic"))
    check("cloud failure → ollama fallback", [c[0] for c in calls], ["ollama"])
    check("cloud failure → local read returned", got, "CC=O")
finally:
    app._cloud_vision_smiles, app._ollama_call = orig_cloud, orig_ollama
    if orig_anthropic is None:
        os.environ.pop("ANTHROPIC_API_KEY", None)
    else:
        os.environ["ANTHROPIC_API_KEY"] = orig_anthropic

# ── multi-reader recognition used by /react-from-image ───────────────────────
import numpy as np  # noqa: E402

blank = np.full((80, 120, 3), 255, dtype=np.uint8)

orig_dec, orig_ms, orig_vis = app._decimer_read, app._molscribe_read, app._ollama_vision_smiles
try:
    # Cross-model agreement → verified without consulting vision at all.
    # (The vision future is submitted early for latency overlap and only
    # cancelled after local agreement — with a fake lambda it may already have
    # run by cancel() time, so we assert non-consultation via reads["vision"]
    # being unrecorded, not via a call-count list.)
    app._decimer_read = lambda arr: "CCO"
    app._molscribe_read = lambda arr: "CCO"
    app._ollama_vision_smiles = lambda b, e=None: "CCC"
    smiles, verified, reads = app._multi_reader_smiles(blank, blank, True, None)
    check("multi-reader: agreement → smiles", smiles, "CCO")
    check("multi-reader: agreement → verified", verified, True)
    check("multi-reader: agreement → vision not consulted", reads["vision"], None)

    # Cross-model conflict → vision arbitrates and its read is recorded.
    app._decimer_read = lambda arr: "CCO"
    app._molscribe_read = lambda arr: "CC=O"
    app._ollama_vision_smiles = lambda b, e=None: "CC=O"
    smiles, verified, reads = app._multi_reader_smiles(blank, blank, True, None)
    check("multi-reader: conflict → vision arbitrates", smiles, "CC=O")
    check("multi-reader: conflict → verified true on vision agreement", verified, True)
    check("multi-reader: vision read recorded", reads["vision"], "CC=O")

    # Every reader fails → no structure, no crash.
    app._decimer_read = lambda arr: None
    app._molscribe_read = lambda arr: None
    app._ollama_vision_smiles = lambda b, e=None: None
    smiles, verified, reads = app._multi_reader_smiles(blank, blank, True, None)
    check("multi-reader: total failure → None", smiles, None)
    check("multi-reader: total failure → unverified", verified, None)
finally:
    app._decimer_read, app._molscribe_read, app._ollama_vision_smiles = orig_dec, orig_ms, orig_vis

# ── image chat preserves the selected vision engine ─────────────────────────
import asyncio  # noqa: E402
import base64  # noqa: E402

captured_engines = []
orig_react_from_image, orig_sse_stream = app._react_from_image, app._sse_stream


def fake_react_from_image(raw, engine=None):
    captured_engines.append(engine)
    return {"error": "synthetic unreadable image", "products": []}


async def fake_sse_stream(*args, **kwargs):
    yield "data: [DONE]\n\n"


async def drain_image_chat(engine):
    image = base64.b64encode(b"synthetic-image").decode()
    messages = [{"role": "user", "content": "read this",
                 "images": [{"media_type": "image/png", "data": image}]}]
    return [frame async for frame in app._image_reaction_then_explain(
        "system", messages, engine, explain=False)]


try:
    app._react_from_image = fake_react_from_image
    app._sse_stream = fake_sse_stream
    selected_engine = app.EngineConfig(mode="hosted", provider="anthropic")
    asyncio.run(drain_image_chat(selected_engine))
    check("image chat forwards hosted engine into OSR",
          captured_engines[0] if captured_engines else None, selected_engine)
finally:
    app._react_from_image, app._sse_stream = orig_react_from_image, orig_sse_stream

print(f"\n{_passed} passed, {_failed} failed")
sys.exit(1 if _failed else 0)
