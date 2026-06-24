"""
app.py — Orgo AI FastAPI backend.

Endpoints:
  POST /analyze         image → SMILES + stage images (base64)
  POST /predict         substrate + reagent → product
  GET  /structure       SMILES → SVG (for UI rendering)
  POST /pathways        substrate → branching graph over REAGENT_LIST
  POST /explain         engine output + reaction name → LLM prose explanation
  POST /chat            conversational chemistry assistant (grounded in engine data)

Start:  uvicorn app:app --host 0.0.0.0 --port 8000 --reload
Or use: start.bat
"""

import asyncio
import base64
import io
import logging
import os
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

# Load .env file if present (never hard-code the key)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

from preprocessing import denoise, deskew, normalize_binarize, perspective_correct
from reactivity_engine import TemplateEngine
from reaction_classifier import classify_reaction

app = FastAPI(title="Orgo AI")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_decimer_fn = None
_executor  = ThreadPoolExecutor(max_workers=1)   # DECIMER + chemistry engine (not thread-safe)
_svg_pool  = ThreadPoolExecutor(max_workers=4)   # RDKit SVG rendering (thread-safe, fast)
MAX_DIM = 1800

# Load templates once at startup — avoids re-parsing JSON per request
_engine = TemplateEngine()

# ── Reagent list — edit here to add/remove reagents for /pathways fan-out ─────
# "conditions" tags are matched against each template's "conditions" field in
# reaction_templates.json. A template fires only when its conditions intersect
# with the reagent's conditions. This list is the single place to add reagents.
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
]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_decimer():
    global _decimer_fn
    if _decimer_fn is None:
        from DECIMER import predict_SMILES
        _decimer_fn = predict_SMILES
    return _decimer_fn


def _is_valid_smiles(smiles: str) -> bool:
    if not smiles:
        return False
    try:
        from rdkit import Chem
        return Chem.MolFromSmiles(smiles) is not None
    except Exception:
        return False


def _to_b64(img: np.ndarray) -> str | None:
    if img is None:
        return None
    ok, buf = cv2.imencode(".png", img)
    return base64.b64encode(buf).decode() if ok else None


def _resize(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    if max(h, w) > MAX_DIM:
        scale = MAX_DIM / max(h, w)
        img = cv2.resize(img, (int(w * scale), int(h * scale)),
                         interpolation=cv2.INTER_AREA)
    return img


def _extract_history_smiles(execution_history: list[str]) -> list[str]:
    """Pull SMILES strings out of execution_history step lines."""
    smiles_list = []
    for entry in execution_history:
        if "): " in entry:
            smiles_list.append(entry.split("): ", 1)[1].strip())
    return smiles_list


def _mol_svg(smiles: str, width: int, height: int) -> str:
    from rdkit import Chem
    from rdkit.Chem import AllChem
    from rdkit.Chem.Draw import rdMolDraw2D

    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return ""
    try:
        AllChem.Compute2DCoords(mol)
    except Exception:
        pass
    drawer = rdMolDraw2D.MolDraw2DSVG(width, height)
    opts = drawer.drawOptions()
    opts.addAtomIndices = False
    opts.addStereoAnnotation = True
    opts.padding = 0.15
    drawer.DrawMolecule(mol)
    drawer.FinishDrawing()
    return drawer.GetDrawingText()


# ── Image processing (runs in thread pool) ────────────────────────────────────

def _process(raw_bytes: bytes) -> dict:
    try:
        pil = Image.open(io.BytesIO(raw_bytes))
        try:
            from PIL import ImageOps
            pil = ImageOps.exif_transpose(pil)
        except Exception:
            pass
        pil = pil.convert("RGB")
        img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
    except Exception as exc:
        raise ValueError(f"Could not decode image: {exc}") from exc

    img = _resize(img)
    stages: dict[str, str | None] = {"original": _to_b64(img)}
    current = img.copy()

    for name, fn in [("perspective", perspective_correct), ("deskew", deskew),
                     ("denoise", denoise), ("binarize", normalize_binarize)]:
        try:
            result = fn(current)
            if result is not None and isinstance(result, np.ndarray):
                current = result
        except Exception:
            pass
        stages[name] = _to_b64(current)

    stages["final"] = _to_b64(current)

    smiles: str | None = None
    valid = False
    error: str | None = None
    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp_path = tmp.name
        cv2.imwrite(tmp_path, current)
        smiles = _load_decimer()(tmp_path)
        valid = _is_valid_smiles(smiles)
    except Exception as exc:
        error = str(exc)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

    return {"smiles": smiles, "valid": valid, "error": error, "stages": stages}


def _run_all_pathways_for_reagent(substrate: str, reagent: dict) -> list[dict]:
    """
    Run all eligible templates for one reagent. Returns a list of branch dicts
    (one per unique product), each RDKit-validated. Returns [] on any failure.
    """
    from rdkit import Chem

    conditions = reagent.get("conditions", [])

    try:
        branches = _engine.run_for_reagent(substrate, reagent["smiles"], conditions)
    except Exception:
        logger.exception("Template engine error for reagent %s", reagent["name"])
        return []

    results = []
    environment = "Kinetic" if "kinetic_base" in conditions else "Thermodynamic"

    for b in branches:
        product_smiles = b["final_product"]
        prod_mol = Chem.MolFromSmiles(product_smiles)
        if prod_mol is None:
            continue

        # Build the step list the frontend expects
        steps = b["steps"]

        # Template name is authoritative — the classifier is only used for confidence scoring
        classification = {
            "name": b["reaction_name"],
            "confidence": "template",
        }

        results.append({
            "reagent": {k: v for k, v in reagent.items() if k != "conditions"},
            "environment": environment,
            "steps_taken": b["steps_taken"],
            "execution_history": b["execution_history"],
            "product_smiles": product_smiles,
            "steps": steps,
            "reaction_classification": classification,
            "template_id": b["template_id"],
            "reaction_name": b["reaction_name"],
            "matches_target": False,  # filled in after
        })

    return results


# ── Routes ────────────────────────────────────────────────────────────────────

@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(_executor, _process, contents)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Processing failed: {exc}") from exc
    return result


class PredictRequest(BaseModel):
    substrate_smiles: str
    reagent_smiles: str


@app.post("/predict")
async def predict(req: PredictRequest):
    from rdkit import Chem
    sub_mol = Chem.MolFromSmiles(req.substrate_smiles.strip())
    if sub_mol is None:
        raise HTTPException(status_code=422, detail="Invalid substrate SMILES")
    rea_mol = Chem.MolFromSmiles(req.reagent_smiles.strip())
    if rea_mol is None:
        raise HTTPException(status_code=422, detail="Invalid reagent SMILES")

    substrate = Chem.MolToSmiles(sub_mol)
    reagent_canon = Chem.MolToSmiles(rea_mol)

    # Derive conditions by matching the reagent against REAGENT_LIST; unknown reagents get []
    conditions: list[str] = []
    for r in REAGENT_LIST:
        r_mol = Chem.MolFromSmiles(r["smiles"])
        if r_mol and Chem.MolToSmiles(r_mol) == reagent_canon:
            conditions = r.get("conditions", [])
            break

    def _predict():
        return _engine.run_for_reagent(substrate, reagent_canon, conditions)

    loop = asyncio.get_event_loop()
    branches = await loop.run_in_executor(_executor, _predict)

    if not branches:
        raise HTTPException(
            status_code=422,
            detail="No templates matched this substrate/reagent combination."
        )

    b = branches[0]
    product_mol = Chem.MolFromSmiles(b["final_product"])
    if product_mol is None:
        raise HTTPException(
            status_code=500,
            detail="Engine produced an invalid product — blocked by RDKit validation"
        )

    environment = "Kinetic" if "kinetic_base" in conditions else "Thermodynamic"
    return {
        "product_smiles": b["final_product"],
        "environment_used": environment,
        "steps_taken": b["steps_taken"],
        "execution_history": b["execution_history"],
        "rdkit_validated": True,
        "template_id": b["template_id"],
        "reaction_name": b["reaction_name"],
    }


@app.get("/structure")
async def structure(
    smiles: str = Query(...),
    width: int = Query(200, ge=40, le=800),
    height: int = Query(150, ge=40, le=600),
):
    """Return an SVG rendering of a SMILES structure for display in the UI."""
    svg = await asyncio.get_event_loop().run_in_executor(
        _svg_pool, _mol_svg, smiles, width, height
    )
    if not svg:
        raise HTTPException(status_code=422, detail="Invalid SMILES")
    return Response(content=svg, media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=3600"})


MAX_SEARCH_DEPTH = 10   # hard cap enforced server-side
MAX_SEARCH_NODES = 200  # unique molecules explored before aborting


def _bfs_to_target(
    substrate: str,
    target_canon: str,
    max_depth: int,
) -> dict:
    """
    Breadth-first search from substrate toward target_canon.

    Each BFS layer = one reagent application (run_for_reagent).
    run_for_reagent's internal MAX_STEPS chaining is treated as a single layer.

    Returns a dict with:
      routes          — list of branch dicts for every path that reached target
      nodes_explored  — count of unique molecules visited
      target_found    — bool
      terminated_early — bool (node ceiling was hit)
    """
    from collections import deque
    from rdkit import Chem

    # Each queue entry: (current_smiles, steps_so_far)
    # steps_so_far is the accumulated step list for this route (start node included)
    start_step = {
        "smiles": substrate,
        "label": "Starting Material",
        "type": "start",
        "step_index": 0,
        "step_text": "Starting material",
        "template_id": None,
        "reaction_name": None,
        "reagent_name": None,
        "reagent_smiles": None,
        "environment": None,
    }

    queue: deque = deque()
    queue.append((substrate, [start_step]))

    visited: set[str] = {substrate}
    routes: list[dict] = []
    nodes_explored = 1
    terminated_early = False

    while queue and not terminated_early:
        current_smiles, path = queue.popleft()
        current_depth = len(path) - 1  # start node is depth 0

        if current_depth >= max_depth:
            continue

        for reagent in REAGENT_LIST:
            if terminated_early:
                break

            conditions = reagent.get("conditions", [])
            environment = "Kinetic" if "kinetic_base" in conditions else "Thermodynamic"

            try:
                branches = _engine.run_for_reagent(current_smiles, reagent["smiles"], conditions)
            except Exception:
                logger.exception("BFS: engine error for reagent %s on %s", reagent["name"], current_smiles)
                continue

            for branch in branches:
                product_smiles = branch["final_product"]

                # Re-index steps from this branch into the growing route
                base_idx = len(path)
                new_steps = []
                for i, step in enumerate(branch["steps"][1:], start=base_idx):
                    new_steps.append({
                        **step,
                        "step_index": i,
                        "reagent_name": reagent["name"],
                        "reagent_smiles": reagent["smiles"],
                        "environment": environment,
                    })

                full_path = path + new_steps

                if product_smiles == target_canon:
                    # Build a branch dict matching the format _run_all_pathways_for_reagent returns
                    routes.append({
                        "reagent": {k: v for k, v in reagent.items() if k != "conditions"},
                        "environment": environment,
                        "steps_taken": len(full_path) - 1,
                        "execution_history": [s["step_text"] for s in full_path if s.get("step_text") and s["step_index"] > 0],
                        "product_smiles": product_smiles,
                        "steps": full_path,
                        "reaction_classification": {
                            "name": branch["reaction_name"],
                            "confidence": "template",
                        },
                        "template_id": branch["template_id"],
                        "reaction_name": branch["reaction_name"],
                        "matches_target": True,
                        "route_depth": len(full_path) - 1,
                    })
                    # Don't add the target to the frontier; it's a terminal node
                    continue

                if product_smiles not in visited:
                    visited.add(product_smiles)
                    nodes_explored += 1
                    if nodes_explored >= MAX_SEARCH_NODES:
                        terminated_early = True
                        break
                    queue.append((product_smiles, full_path))

    return {
        "routes": routes,
        "nodes_explored": nodes_explored,
        "target_found": len(routes) > 0,
        "terminated_early": terminated_early,
    }


class PathwaysRequest(BaseModel):
    substrate_smiles: str
    target_smiles: Optional[str] = None
    max_depth: int = 5


@app.post("/pathways")
async def pathways(req: PathwaysRequest):
    from rdkit import Chem

    sub_mol = Chem.MolFromSmiles(req.substrate_smiles.strip())
    if sub_mol is None:
        raise HTTPException(status_code=422, detail="Invalid substrate SMILES")
    substrate = Chem.MolToSmiles(sub_mol)

    # Server-side clamp — client value is not trusted for the hard cap
    max_depth = max(1, min(MAX_SEARCH_DEPTH, req.max_depth))

    # Canonicalize optional target
    target_canon: str | None = None
    if req.target_smiles and req.target_smiles.strip():
        t_mol = Chem.MolFromSmiles(req.target_smiles.strip())
        if t_mol:
            target_canon = Chem.MolToSmiles(t_mol)

    loop = asyncio.get_event_loop()

    # ── Target given: BFS toward target ───────────────────────────────────────
    if target_canon:
        search_result = await loop.run_in_executor(
            _executor, _bfs_to_target, substrate, target_canon, max_depth
        )

        branches: list[dict] = []
        branch_idx = 0

        if search_result["target_found"]:
            # Emit found routes as highlighted branches
            for route in search_result["routes"]:
                route["id"] = f"route_{branch_idx}_{route['template_id']}"
                branch_idx += 1
                branches.append(route)
            no_match_message = None
        else:
            # No route found — fall back to the 1-step fan-out for context
            for reagent in REAGENT_LIST:
                reagent_branches = await loop.run_in_executor(
                    _executor, _run_all_pathways_for_reagent, substrate, reagent
                )
                for branch in reagent_branches:
                    branch["id"] = f"branch_{branch_idx}_{branch['template_id']}"
                    branch_idx += 1
                    branch["matches_target"] = False
                    branches.append(branch)

            termination_reason = (
                "The search was stopped early because the molecule space grew too large at this depth."
                if search_result["terminated_early"]
                else f"within {max_depth} layer{'s' if max_depth != 1 else ''} using the current reaction set"
            )
            no_match_message = (
                f"No pathway to the target product was found {termination_reason}. "
                "Try increasing the depth, or the current templates may not cover this transformation."
            )

        return {
            "start_smiles": substrate,
            "target_smiles": target_canon,
            "search_mode": "target_search",
            "search_info": {
                "max_depth": max_depth,
                "nodes_explored": search_result["nodes_explored"],
                "target_found": search_result["target_found"],
                "terminated_early": search_result["terminated_early"],
            },
            "no_match_message": no_match_message,
            "branches": branches,
        }

    # ── No target: unchanged fan-out ──────────────────────────────────────────
    branches = []
    branch_idx = 0
    for reagent in REAGENT_LIST:
        reagent_branches = await loop.run_in_executor(
            _executor, _run_all_pathways_for_reagent, substrate, reagent
        )
        for branch in reagent_branches:
            branch["id"] = f"branch_{branch_idx}_{branch['template_id']}"
            branch_idx += 1
            branches.append(branch)

    return {
        "start_smiles": substrate,
        "target_smiles": None,
        "search_mode": "fanout",
        "search_info": None,
        "no_match_message": None,
        "branches": branches,
    }


class ExplainRequest(BaseModel):
    substrate_smiles: str
    product_smiles: str
    reagent_name: str
    reagent_smiles: str
    reaction_name: str
    execution_history: list[str]
    environment_used: str
    # Optional per-node fields — when provided, explanation is scoped to a single step
    node_smiles: Optional[str] = None
    node_role: Optional[str] = None       # 'start' | 'intermediate' | 'product'
    node_step_text: Optional[str] = None  # raw execution_history entry for this step


@app.post("/explain")
async def explain(req: ExplainRequest):
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return {
            "explanation": (
                "⚠️ No API key configured — AI explanations are unavailable.\n\n"
                "To enable them: create a .env file in the project root and add:\n"
                "  ANTHROPIC_API_KEY=sk-ant-...\n\n"
                "Get a key at https://console.anthropic.com (paid API). "
                "The rest of the app (graph, structure recognition) works without a key."
            )
        }

    import anthropic
    client = anthropic.Anthropic(api_key=api_key)

    system_prompt = (
        "You are an organic chemistry teaching assistant for Orgo AI. "
        "You will be given exact chemical data computed by a verified deterministic engine. "
        "Your sole job is to explain this data clearly to a student.\n\n"
        "HARD RULES:\n"
        "- The provided SMILES, reaction name, execution history, and environment are ground truth. "
        "Never contradict or independently re-derive them.\n"
        "- Explain ONLY what the engine computed. Do not invent steps not in the history.\n"
        "- If a student asks you to go beyond the provided data, say so explicitly.\n"
        "- Flag uncertainty rather than fabricating mechanism details."
    )

    history_text = "\n".join(req.execution_history) if req.execution_history else "No history available"

    if req.node_smiles and req.node_role and req.node_role != "start":
        # Per-node explanation scoped to one step
        user_prompt = (
            f"Explain what is happening at this specific step in the reaction pathway:\n\n"
            f"**Step role:** {req.node_role}\n"
            f"**This step's molecular state (SMILES):** {req.node_smiles}\n"
            f"**Engine description of this step:** {req.node_step_text or 'N/A'}\n\n"
            f"**Full reaction context:**\n"
            f"  Starting material: {req.substrate_smiles}\n"
            f"  Reagent: {req.reagent_name} ({req.reagent_smiles})\n"
            f"  Reaction type (engine-classified): {req.reaction_name}\n"
            f"  Control environment: {req.environment_used}\n"
            f"  Final product: {req.product_smiles}\n\n"
            f"**Complete engine execution history:**\n{history_text}\n\n"
            "Explain: what chemical transformation reached this state, what bonds formed or broke, "
            "and why this intermediate/product is expected given the reagent. "
            "Be concise and accessible to an undergraduate student."
        )
    else:
        user_prompt = (
            f"Please explain this reaction pathway to a student:\n\n"
            f"**Starting material:** {req.substrate_smiles}\n"
            f"**Reagent:** {req.reagent_name} ({req.reagent_smiles})\n"
            f"**Reaction type (engine-classified):** {req.reaction_name}\n"
            f"**Control environment:** {req.environment_used}\n\n"
            f"**Engine execution history:**\n{history_text}\n\n"
            f"**Final product:** {req.product_smiles}\n\n"
            "Explain: (1) what happened chemically, (2) why this mechanism applies given the reagent, "
            "(3) which bonds formed and broke, and (4) the significance of kinetic vs thermodynamic control "
            "if relevant. Keep it accessible to an undergraduate student."
        )

    def _call_claude():
        resp = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=800,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
        )
        return resp.content[0].text

    loop = asyncio.get_event_loop()
    text = await loop.run_in_executor(None, _call_claude)
    return {"explanation": text}


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    context: Optional[dict] = None


@app.post("/chat")
async def chat(req: ChatRequest):
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return {
            "response": (
                "⚠️ Chatbot unavailable — no API key configured.\n"
                "Add ANTHROPIC_API_KEY to your .env file to enable it. "
                "See README for instructions."
            )
        }

    import anthropic
    client = anthropic.Anthropic(api_key=api_key)

    context_block = ""
    if req.context:
        lines = ["\n--- Currently displayed reaction ---"]
        if req.context.get("substrate_smiles"):
            lines.append(f"Starting material: {req.context['substrate_smiles']}")
        if req.context.get("reagent_name"):
            lines.append(f"Reagent: {req.context['reagent_name']} ({req.context.get('reagent_smiles','')})")
        if req.context.get("reaction_name"):
            lines.append(f"Reaction: {req.context['reaction_name']}")
        if req.context.get("product_smiles"):
            lines.append(f"Product: {req.context['product_smiles']}")
        if req.context.get("execution_history"):
            lines.append("History: " + " | ".join(req.context["execution_history"]))
        context_block = "\n".join(lines)

    system_prompt = (
        "You are an organic chemistry tutor for Orgo AI. "
        "Help students understand organic chemistry concepts and reactions.\n\n"
        f"{context_block}\n\n"
        "RULES:\n"
        "- When a reaction is shown above, ground every answer in that engine-computed data. "
        "Do NOT override or re-derive the engine's product, mechanism, or reaction type.\n"
        "- Distinguish clearly between 'the engine computed X' and 'in general chemistry, Y is also possible'.\n"
        "- For questions outside the displayed reaction, draw on chemistry knowledge but flag uncertainty.\n"
        "- Keep responses concise and student-friendly."
    )

    messages = [{"role": m.role, "content": m.content} for m in req.messages]

    def _call_claude():
        resp = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=600,
            system=system_prompt,
            messages=messages,
        )
        return resp.content[0].text

    loop = asyncio.get_event_loop()
    text = await loop.run_in_executor(None, _call_claude)
    return {"response": text}


# ── Static file serving — mount AFTER all API routes ─────────────────────────
# Vite build outputs to static/. html=True serves index.html for any unmatched
# path, enabling client-side routing.
_static = Path(__file__).parent / "static"
_static.mkdir(exist_ok=True)
app.mount("/", StaticFiles(directory=str(_static), html=True), name="spa")
