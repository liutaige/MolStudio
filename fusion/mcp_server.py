#!/usr/bin/env python3
"""Pure Python stdlib MCP (Model Context Protocol) server over stdio for MolStudio.

Supports both newline-delimited JSON-RPC 2.0 and Content-Length framing.
Discovers a running MolStudio instance (or launches MolStudio.app / dev server)
and forwards drawing/inspection tools to /api/agent/external/*.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

# Packaged clients use python -I, which omits the script directory from sys.path.
# Import only our explicit sibling resources, independent of the launcher's cwd.
_RESOURCE_DIR = str(Path(__file__).resolve().parent)
if _RESOURCE_DIR not in sys.path:
    sys.path.insert(0, _RESOURCE_DIR)
from mcp_response import compact_response, select_canvas_steps

SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
DEFAULT_PORTS = (8462, 48975)
DEFAULT_LAUNCH_WAIT_SECONDS = 8.0
DEFAULT_CALL_TIMEOUT_MS = 60000

INSTRUCTIONS = (
    "You are controlling a live MolStudio chemistry canvas via MCP tools.\n"
    "For a drawing request, use these tools directly. The result is editable in the existing MolStudio window; "
    "do not build another viewer or inspect repository source/configuration unless the user asks for development or connection diagnosis.\n"
    "Start with molstudio_status(openCanvas:true) when a canvas connection is needed. "
    "Read existing work before editing, batch uncertain structures into one inspect call (up to 12), "
    "then draw complete steps in batches of up to 40 operations. Reuse references from successful receipts instead of repeatedly reading the whole canvas.\n"
    "Use inspect_structures for structural preflight; do not add scratch or probe molecules to the live canvas just to investigate them.\n"
    "Simple bounded mechanisms need no phase plan. In a phased task, draw_operations(finish:true) already completes the current phase when accepted; "
    "do not also complete_phase for that same phase. Always check finishAccepted and any nextAction.\n"
    "Set finish:true on the final drawing batch. If the work is already committed, replay an unchanged successful batch with the same operation IDs and finish:true. "
    "step.seal is a boundary after complete step operations in the same batch, not a standalone completion tool.\n"
    "Read/inspect/draw results default to compact data with stable references, chemistry and checks. "
    "When inspecting or repairing known steps, read_canvas(stepIds:[...]) reads their complete participating molecules and electron flow. "
    "Request detail:'full' only when the omitted rendering geometry or complete observations are needed.\n"
    "Repair failed, uncommitted operations from the returned diagnostic while preserving the requested substrate and chemistry. "
    "A layout or representation limitation is not a reason to substitute another substrate or intermediate just to pass validation.\n"
    "Key MolStudio rules:\n"
    "1. Call molstudio_read_canvas before editing existing molecules or reaction steps so you use current stable atom/bond IDs, stepId, and version.\n"
    "2. Call molstudio_inspect_structures to verify uncertain SMILES and get exact atom/bond references and nativeType (e.g. Kekule aromatic vs carbonyl) before drawing.\n"
    "3. In molecule.add SMILES, map every atom with distinct positive numbers (e.g. [CH3:1][Br:2]) and reference atoms as operationId:mapNumber.\n"
    "4. For new reaction schemes, declare reactionStep.create (with layout: {}) before the molecule.add operations it references. "
    "Reuse the same unchanged intermediate as the immediately following step's reactant, including across wrapped rows; copying it creates a separate route. "
    "Omit molecule x/y and explicit breaks for automatic connected-route placement unless the user specifies positions.\n"
    "5. Omit lonePair.add.angle for automatic aim toward the attacked atom; specify explicit type, source.type, target.type, and electronCount (1 or 2) on every arrow.add.\n"
    "6. For proton transfer, draw the transferred hydrogen as a separate bonded [H:n]: base lone pair to H, and the donor X-H sigma bond electrons back to that same donor X. "
    "Every electron-flow endpoint belongs to that step's reactants, not product copies. Include all participating reagents in those reactants.\n"
    "7. Keep formal charges consistent with each elementary step. When neutral alcohol attacks a protonated carbonyl, the carbonyl oxygen becomes OH and the incoming alcohol oxygen remains positively charged until a separate deprotonation.\n"
    "8. Completion checks reject new product radicals when the reactants have no radicals and every arrow transfers two electrons. "
    "Inspect uncertain structures; report an unsupported representation rather than inventing another intermediate to pass this check.\n"
    "9. Do not add unsolicited text.add labels unless the user asked for canvas annotations. "
    "Use finish: true on molstudio_draw_operations when a batch completes the requested drawing; for multi-phase tasks use molstudio_plan_task and molstudio_complete_phase."
)


def _object_schema(properties, required):
    fixed = {}
    for name, field in properties.items():
        if name == "type" and isinstance(field, dict) and isinstance(field.get("enum"), list) and len(field["enum"]) == 1:
            fixed[name] = {**field, "const": field["enum"][0]}
        else:
            fixed[name] = field
    return {
        "type": "object",
        "properties": fixed,
        "required": required,
        "additionalProperties": False,
    }


REFERENCE_SCHEMA = {"type": "string", "minLength": 1, "maxLength": 160}
ATOM_ENDPOINT = _object_schema({"type": {"type": "string", "enum": ["atom"]}, "atomId": REFERENCE_SCHEMA}, ["type", "atomId"])
LONE_PAIR_ENDPOINT = _object_schema({"type": {"type": "string", "enum": ["lonePair"]}, "id": REFERENCE_SCHEMA}, ["type", "id"])
BOND_ENDPOINT = {
    "oneOf": [
        _object_schema(
            {
                "type": {"type": "string", "enum": ["bond"]},
                "bondId": REFERENCE_SCHEMA,
                "component": {"type": "string", "enum": ["sigma", "pi"]},
            },
            ["type", "bondId", "component"],
        ),
        _object_schema(
            {
                "type": {"type": "string", "enum": ["bond"]},
                "atom1": REFERENCE_SCHEMA,
                "atom2": REFERENCE_SCHEMA,
                "component": {"type": "string", "enum": ["sigma", "pi"]},
            },
            ["type", "atom1", "atom2", "component"],
        ),
    ]
}
FORMING_ENDPOINT = _object_schema(
    {"type": {"type": "string", "enum": ["formingBond"]}, "atom1": REFERENCE_SCHEMA, "atom2": REFERENCE_SCHEMA},
    ["type", "atom1", "atom2"],
)
REACTION_SIDE = {
    "type": "array",
    "items": REFERENCE_SCHEMA,
    "minItems": 1,
    "maxItems": 16,
    "uniqueItems": True,
    "description": "One atom reference per molecule, using an existing stable atom ID or moleculeOperationId:mapNumber.",
}
REACTION_LAYOUT = _object_schema(
    {
        "reactantPlacement": {
            "type": "string",
            "enum": ["auto", "horizontal", "vertical"],
            "description": "Relative placement of reactants in the given order.",
        },
        "reagentPlacement": {
            "type": "string",
            "enum": ["auto", "left", "right", "above", "below"],
            "description": "Place small reagents relative to the main skeleton; auto uses the reaction site.",
        },
        "breakBefore": {
            "type": "boolean",
            "description": "Start a new row with a matching continuation marker and a rightward arrow. Omit for automatic wrapping.",
        },
        "conditions": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64,
            "description": "One short line of requested reaction conditions beside the arrow.",
        },
    },
    [],
)
MODIFIED_REACTION_LAYOUT = {
    **REACTION_LAYOUT,
    "properties": {
        **REACTION_LAYOUT["properties"],
        "conditions": {
            **REACTION_LAYOUT["properties"]["conditions"],
            "minLength": 0,
            "description": "New conditions; an empty string clears them.",
        },
    },
}
STEP_VERSION_SCHEMA = {
    "type": "integer",
    "minimum": 1,
    "description": "The current version from reactionSteps or the last successful step receipt.",
}
ELECTRON_ARROW_ID = {
    **REFERENCE_SCHEMA,
    "description": "An electron-flow arrow ID from arrows[].id or the entityIds of arrow.add. Excludes native reactionArrows IDs.",
}
TARGET_SCOPE = {
    "oneOf": [
        _object_schema(
            {"molecule": {**REFERENCE_SCHEMA, "description": "Molecule handle from read_canvas, e.g. mol:2."}},
            ["molecule"],
        ),
        _object_schema(
            {
                "atoms": {
                    "type": "array",
                    "items": REFERENCE_SCHEMA,
                    "minItems": 1,
                    "maxItems": 200,
                    "description": "Exactly these stable atom IDs. The target remains this subset; bonded neighbors are excluded.",
                }
            },
            ["atoms"],
        ),
    ]
}
TASK_SCOPE_SCHEMA = _object_schema(
    {
        "type": {
            "type": "string",
            "enum": ["completeMechanism", "partialStep", "singleMolecule", "edit", "annotation"],
            "description": "Report completeMechanism for a mechanism with real reactants, all required electron flow and products. Report partialStep for a selected step or explicit arrow-only request.",
        },
        "stages": {
            "type": "array",
            "maxItems": 12,
            "items": _object_schema(
                {
                    "label": {"type": "string", "maxLength": 120},
                    "operationIds": {"type": "array", "items": REFERENCE_SCHEMA, "maxItems": 40},
                },
                ["label"],
            ),
        },
        "notes": {"type": "string", "maxLength": 500},
    },
    ["type"],
)

OPERATION_SCHEMA = {
    "oneOf": [
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {"type": "string", "enum": ["molecule.add"]},
                "smiles": {"type": "string", "minLength": 1, "maxLength": 4096, "description": "Prefer local atom maps 1..N, for example [CH3:1][Br:2]."},
                "x": {"type": "number"},
                "y": {"type": "number"},
            },
            ["id", "type", "smiles"],
        ),
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {"type": "string", "enum": ["lonePair.add"]},
                "atom": {**REFERENCE_SCHEMA, "description": "Stable atom ID or moleculeOperationId:actualMapNumber."},
                "angle": {"type": "number"},
            },
            ["id", "type", "atom"],
        ),
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {"type": "string", "enum": ["arrow.add"]},
                "source": {"oneOf": [LONE_PAIR_ENDPOINT, BOND_ENDPOINT, ATOM_ENDPOINT]},
                "target": {"oneOf": [ATOM_ENDPOINT, FORMING_ENDPOINT]},
                "electronCount": {"type": "integer", "enum": [1, 2], "description": "Required: 2 for a full electron-pair arrow, 1 for a fishhook."},
            },
            ["id", "type", "source", "target", "electronCount"],
        ),
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {
                    "type": "string",
                    "enum": ["reactionStep.create"],
                    "description": "Create a versioned reaction step and its straight arrow. Declare before its structures; returns stable stepId and version.",
                },
                "reactants": REACTION_SIDE,
                "products": REACTION_SIDE,
                "layout": REACTION_LAYOUT,
            },
            ["id", "type", "reactants", "products"],
        ),
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {
                    "type": "string",
                    "enum": ["reactionStep.modify"],
                    "description": "Update a step using its current version; returns before/after state and validation checks.",
                },
                "stepId": REFERENCE_SCHEMA,
                "expectedVersion": STEP_VERSION_SCHEMA,
                "reactants": REACTION_SIDE,
                "products": REACTION_SIDE,
                "layout": MODIFIED_REACTION_LAYOUT,
            },
            ["id", "type", "stepId", "expectedVersion"],
        ),
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {
                    "type": "string",
                    "enum": ["reactionStep.delete"],
                    "description": "Delete a reaction step and its owned arrow/conditions using its current version.",
                },
                "stepId": REFERENCE_SCHEMA,
                "expectedVersion": STEP_VERSION_SCHEMA,
            },
            ["id", "type", "stepId", "expectedVersion"],
        ),
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {
                    "type": "string",
                    "enum": ["reactionArrow.add"],
                    "description": "Compatibility operation for a straight reaction arrow. New drawings use reactionStep.create.",
                },
                "reactants": REACTION_SIDE,
                "products": REACTION_SIDE,
                "layout": REACTION_LAYOUT,
            },
            ["id", "type", "reactants", "products"],
        ),
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {"type": "string", "enum": ["text.add"]},
                "text": {"type": "string", "maxLength": 2000, "description": "Only when the user explicitly requested canvas text or labels."},
                "x": {"type": "number"},
                "y": {"type": "number"},
            },
            ["id", "type", "text", "x", "y"],
        ),
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {
                    "type": "string",
                    "enum": ["molecule.move"],
                    "description": "target.molecule moves the complete molecule; target.atoms moves exactly the listed atoms.",
                },
                "target": TARGET_SCOPE,
                "x": {"type": "number"},
                "y": {"type": "number"},
                "dx": {"type": "number"},
                "dy": {"type": "number"},
                "orientTowardAtomId": {
                    **REFERENCE_SCHEMA,
                    "description": "Rotate the single target H toward this atom, preserving its current bond length to its sole O/N parent.",
                },
            },
            ["id", "type", "target"],
        ),
        _object_schema(
            {"id": REFERENCE_SCHEMA, "type": {"type": "string", "enum": ["molecule.delete"]}, "target": TARGET_SCOPE},
            ["id", "type", "target"],
        ),
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {"type": "string", "enum": ["hydrogen.makeExplicit"]},
                "parentAtomId": {
                    **REFERENCE_SCHEMA,
                    "description": "C/N/O atom with an existing implicit H, non-query, non-aromatic and without related defined stereo. New H: operationId:1; new bond: operationId:bond:1.",
                },
            },
            ["id", "type", "parentAtomId"],
        ),
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {"type": "string", "enum": ["atom.modify"]},
                "atomId": REFERENCE_SCHEMA,
                "label": {"type": "string", "pattern": "^[A-Z][a-z]?$", "description": "Element symbol."},
                "charge": {"type": "integer", "minimum": -6, "maximum": 6},
                "isotope": {"type": "integer", "minimum": 0, "maximum": 254},
                "radical": {"type": "integer", "minimum": 0, "maximum": 3, "description": "0=none, 1=singlet, 2=doublet(monoradical), 3=triplet(diradical)."},
            },
            ["id", "type", "atomId"],
        ),
        _object_schema({"id": REFERENCE_SCHEMA, "type": {"type": "string", "enum": ["atom.delete"]}, "atomId": REFERENCE_SCHEMA}, ["id", "type", "atomId"]),
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {"type": "string", "enum": ["bond.add"]},
                "begin": REFERENCE_SCHEMA,
                "end": REFERENCE_SCHEMA,
                "order": {"type": "integer", "enum": [1, 2, 3]},
            },
            ["id", "type", "begin", "end"],
        ),
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {"type": "string", "enum": ["bond.modify"]},
                "bondId": REFERENCE_SCHEMA,
                "order": {"type": "integer", "enum": [1, 2, 3]},
            },
            ["id", "type", "bondId", "order"],
        ),
        _object_schema({"id": REFERENCE_SCHEMA, "type": {"type": "string", "enum": ["bond.delete"]}, "bondId": REFERENCE_SCHEMA}, ["id", "type", "bondId"]),
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {"type": "string", "enum": ["arrow.modify"], "description": "Modify an existing electron-flow arrow in place."},
                "arrowId": ELECTRON_ARROW_ID,
                "source": {"oneOf": [LONE_PAIR_ENDPOINT, BOND_ENDPOINT, ATOM_ENDPOINT]},
                "target": {"oneOf": [ATOM_ENDPOINT, FORMING_ENDPOINT]},
                "electronCount": {"type": "integer", "enum": [1, 2]},
                "bend": {"type": "number", "minimum": -3, "maximum": 3},
                "mode": {"type": "string", "enum": ["auto", "manual"]},
            },
            ["id", "type", "arrowId"],
        ),
        _object_schema({"id": REFERENCE_SCHEMA, "type": {"type": "string", "enum": ["arrow.delete"]}, "arrowId": ELECTRON_ARROW_ID}, ["id", "type", "arrowId"]),
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {"type": "string", "enum": ["lonePair.modify"]},
                "lonePairId": REFERENCE_SCHEMA,
                "angle": {"type": "number"},
                "aim": {"type": "string", "enum": ["auto", "manual"]},
            },
            ["id", "type", "lonePairId"],
        ),
        _object_schema({"id": REFERENCE_SCHEMA, "type": {"type": "string", "enum": ["lonePair.delete"]}, "lonePairId": REFERENCE_SCHEMA}, ["id", "type", "lonePairId"]),
        _object_schema({"id": REFERENCE_SCHEMA, "type": {"type": "string", "enum": ["text.delete"]}, "textId": REFERENCE_SCHEMA}, ["id", "type", "textId"]),
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {
                    "type": "string",
                    "enum": ["layout.tidy"],
                    "description": "Tidy the current structure: RDKit layout per molecule plus reaction-level compaction.",
                },
            },
            ["id", "type"],
        ),
        _object_schema(
            {
                "id": REFERENCE_SCHEMA,
                "type": {
                    "type": "string",
                    "enum": ["step.seal"],
                    "description": "Optional boundary after a complete drawable step. Each sealed step is one undo item.",
                },
            },
            ["id", "type"],
        ),
    ]
}

CLIENT_NAME_PROP = {"type": "string", "maxLength": 100, "description": "Optional external agent/client label shown in the MolStudio panel."}
DETAIL_PROP = {
    "type": "string",
    "enum": ["compact", "full"],
    "description": "Default compact preserves editing references, chemistry and checks. Use full for the original complete data including rendering geometry.",
}
COMPACT_TOOLS = {"molstudio_read_canvas", "molstudio_inspect_structures", "molstudio_draw_operations"}

TOOLS = [
    {
        "name": "molstudio_status",
        "description": "Check MolStudio service and active canvas connection status. Set openCanvas:true to launch MolStudio or open canvas.html if no canvas is currently connected.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "openCanvas": {"type": "boolean", "description": "Launch MolStudio or open canvas.html and wait for connection when no canvas is active."},
                "autoLaunch": {"type": "boolean", "description": "Set false to skip launching MolStudio if not already running."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "molstudio_read_canvas",
        "description": "Read actual current molecules, stable atom/bond IDs, lone pairs, arrows, reactionSteps (stepId/version), and selection from the live MolStudio canvas.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "clientName": CLIENT_NAME_PROP,
                "detail": DETAIL_PROP,
                "stepIds": {
                    "type": "array", "items": REFERENCE_SCHEMA, "minItems": 1, "maxItems": 16, "uniqueItems": True,
                    "description": "Optional stable step IDs from receipts. Return just these steps and their complete participating molecules/electron flow, instead of the entire canvas.",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "molstudio_inspect_structures",
        "description": "Check uncertain SMILES via RDKit and return exact atom/bond references and nativeType without adding objects to the canvas.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structures": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 12,
                    "items": _object_schema(
                        {"id": REFERENCE_SCHEMA, "smiles": {"type": "string", "minLength": 1, "maxLength": 4096}},
                        ["id", "smiles"],
                    ),
                },
                "clientName": CLIENT_NAME_PROP,
                "detail": DETAIL_PROP,
            },
            "required": ["structures"],
            "additionalProperties": False,
        },
    },
    {
        "name": "molstudio_draw_operations",
        "description": "Draw and edit real objects on the live MolStudio canvas. For a new scheme, declare reactionStep.create with layout before its structures. Use finish:true when this batch completes the task.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "operations": {"type": "array", "items": OPERATION_SCHEMA, "minItems": 1, "maxItems": 40},
                "taskScope": TASK_SCOPE_SCHEMA,
                "finish": {"type": "boolean", "description": "True when this batch completes the requested work."},
                "summary": {"type": "string", "maxLength": 300, "description": "Optional short summary displayed for this batch."},
                "task": {"type": "string", "maxLength": 2000, "description": "Optional task description for mechanism completion checks."},
                "allowText": {"type": "boolean", "description": "Set true only when the user explicitly requested canvas text annotations."},
                "clientName": CLIENT_NAME_PROP,
                "detail": DETAIL_PROP,
            },
            "required": ["operations"],
            "additionalProperties": False,
        },
    },
    {
        "name": "molstudio_plan_task",
        "description": "Create a bounded multi-phase plan for a complex canvas task before drawing.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "phases": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 32,
                    "items": _object_schema(
                        {
                            "id": REFERENCE_SCHEMA,
                            "objective": {"type": "string", "minLength": 1, "maxLength": 1000},
                            "kind": {"type": "string", "enum": ["draw", "review"]},
                        },
                        ["id", "objective"],
                    ),
                },
                "task": {"type": "string", "maxLength": 2000},
                "clientName": CLIENT_NAME_PROP,
            },
            "required": ["phases"],
            "additionalProperties": False,
        },
    },
    {
        "name": "molstudio_complete_phase",
        "description": "Finish the current planned phase after committed changes and host canvas checks.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "phaseId": REFERENCE_SCHEMA,
                "operationIds": {"type": "array", "items": REFERENCE_SCHEMA, "maxItems": 160, "uniqueItems": True},
                "summary": {"type": "string", "minLength": 1, "maxLength": 2000},
                "clientName": CLIENT_NAME_PROP,
            },
            "required": ["phaseId", "operationIds", "summary"],
            "additionalProperties": False,
        },
    },
    {
        "name": "molstudio_complete_layout",
        "description": "Verify and complete a layout-only task after semantic layout edits.",
        "inputSchema": {
            "type": "object",
            "properties": {"clientName": CLIENT_NAME_PROP},
            "additionalProperties": False,
        },
    },
    {
        "name": "molstudio_write_plan",
        "description": "Display a short checklist plan in the MolStudio panel without drawing.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 30,
                    "items": _object_schema(
                        {
                            "id": {"type": "string"},
                            "text": {"type": "string"},
                            "status": {"type": "string", "enum": ["pending", "running", "done"]},
                        },
                        ["id", "text", "status"],
                    ),
                },
                "clientName": CLIENT_NAME_PROP,
            },
            "required": ["steps"],
            "additionalProperties": False,
        },
    },
]

TOOL_NAMES = {tool["name"] for tool in TOOLS}


def _config_dir(environ=None):
    env = os.environ if environ is None else environ
    default_dir = Path.home() / "Library" / "Application Support" / "MolStudio"
    return Path(env.get("MOLSTUDIO_AGENT_CONFIG_DIR") or default_dir)


def _discovery_file(environ=None):
    return _config_dir(environ) / "active-bridge.json"


def _candidate_urls(environ=None):
    env = os.environ if environ is None else environ
    urls = []
    explicit_url = (env.get("MOLSTUDIO_URL") or "").strip().rstrip("/")
    if explicit_url:
        urls.append(explicit_url)
    explicit_port = (env.get("MOLSTUDIO_PORT") or "").strip()
    if explicit_port.isdigit():
        urls.append(f"http://127.0.0.1:{explicit_port}")
    try:
        data = json.loads(_discovery_file(env).read_text(encoding="utf-8"))
        if isinstance(data, dict):
            u = data.get("url")
            p = data.get("port")
            if isinstance(u, str) and u.strip():
                urls.append(u.strip().rstrip("/"))
            elif isinstance(p, int) and p > 0:
                urls.append(f"http://127.0.0.1:{p}")
    except (OSError, ValueError):
        pass
    for port in DEFAULT_PORTS:
        urls.append(f"http://127.0.0.1:{port}")
    deduped = []
    for u in urls:
        if u not in deduped:
            deduped.append(u)
    return deduped


def _http_json(method, url, payload=None, timeout=2.0):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as err:
        try:
            raw = err.read().decode("utf-8", errors="replace")
            code = err.code
        finally:
            err.close()
        try:
            body = json.loads(raw)
        except ValueError:
            body = {"ok": False, "error": raw or str(err), "code": f"http_{code}"}
        return code, body


def _bridge_candidate_score(base_url, data):
    clients = [c for c in (data.get("clients") or []) if isinstance(c, dict)]
    return (
        1 if data.get("connected") else 0,
        1 if any(c.get("focused") for c in clients) else 0,
        1 if (data.get("port") == 8462 or base_url.endswith(":8462")) else 0,
        1 if not any(c.get("busy") for c in clients) else 0,
        max((int(c.get("lastSeenAt") or 0) for c in clients), default=0),
    )


def probe_bridge(environ=None):
    """Return (best_url, best_status) from candidate URLs, preferring focused/app canvases."""
    env = os.environ if environ is None else environ
    explicit_url = (env.get("MOLSTUDIO_URL") or "").strip().rstrip("/")
    explicit_port = (env.get("MOLSTUDIO_PORT") or "").strip()
    if explicit_url or explicit_port.isdigit():
        explicit_candidates = []
        if explicit_url:
            explicit_candidates.append(explicit_url)
        if explicit_port.isdigit():
            p_url = f"http://127.0.0.1:{explicit_port}"
            if p_url not in explicit_candidates:
                explicit_candidates.append(p_url)
        for base_url in explicit_candidates:
            try:
                code, data = _http_json("GET", f"{base_url}/api/agent/external/status", timeout=1.5)
            except (urllib.error.URLError, OSError, ValueError):
                continue
            if code == 200 and isinstance(data, dict) and data.get("ok"):
                return base_url, data

    best_url = None
    best_status = None
    best_score = None
    for base_url in _candidate_urls(env):
        try:
            code, data = _http_json("GET", f"{base_url}/api/agent/external/status", timeout=1.5)
        except (urllib.error.URLError, OSError, ValueError):
            continue
        if code == 200 and isinstance(data, dict) and data.get("ok"):
            score = _bridge_candidate_score(base_url, data)
            if best_score is None or score > best_score:
                best_score = score
                best_url = base_url
                best_status = data
    return best_url, best_status


def _app_ships_bridge(app_dir):
    """True when a packaged app carries the external bridge this server talks to."""
    return (Path(app_dir) / "Contents" / "Resources" / "agent_external_bridge.py").is_file()


def _find_molstudio_app():
    here = Path(__file__).resolve()
    # If running inside MolStudio.app/Contents/Resources/mcp_server.py
    for parent in here.parents:
        if parent.name.endswith(".app") and (parent / "Contents" / "Info.plist").is_file():
            return str(parent)
    candidates = (
        Path("/Applications/MolStudio.app"),
        Path.home() / "Applications" / "MolStudio.app",
        here.parent.parent / "fusion-native" / "dist" / "MolStudio.app",
    )
    found_existing_app = False
    for candidate in candidates:
        if candidate.exists():
            found_existing_app = True
            # An app built before the bridge existed cannot serve /api/agent/external/*;
            # prefer the development server instead of launching a dead end.
            if _app_ships_bridge(candidate):
                return str(candidate)
    if found_existing_app:
        return None
    if sys.platform == "darwin":
        try:
            res = subprocess.run(["open", "-Ra", "MolStudio"], capture_output=True, timeout=2, check=False)
            if res.returncode == 0:
                return "MolStudio"
        except (OSError, subprocess.TimeoutExpired):
            pass
    return None


def _resolve_dev_python(repo_root: Path):
    venv_py = repo_root / ".venv-rdkit" / "bin" / "python"
    if venv_py.is_file() and os.access(venv_py, os.X_OK):
        return str(venv_py)
    return sys.executable


def _open_canvas_url(url: str):
    canvas_url = f"{url}/canvas.html"
    if sys.platform == "darwin" and shutil.which("open"):
        subprocess.Popen(
            ["open", canvas_url],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    else:
        webbrowser.open(canvas_url)


def _wait_for_canvas(env, wait_limit, only_url=None):
    """Poll the bridge until a canvas is connected or the budget runs out."""
    deadline = time.monotonic() + wait_limit
    probe_env = {**env, "MOLSTUDIO_URL": only_url} if only_url else env
    last_url, last_status = probe_bridge(probe_env)
    while time.monotonic() < deadline:
        if last_status and last_status.get("connected"):
            return last_url, last_status
        time.sleep(0.25)
        last_url, last_status = probe_bridge(probe_env)
    return last_url, last_status


def _launch_dev_server(env, wait_limit):
    """Start fusion/server.py and open canvas.html; returns the base URL or None."""
    server_py = Path(__file__).resolve().parent / "server.py"
    if not server_py.is_file():
        return None
    repo_root = server_py.parent.parent
    py = _resolve_dev_python(repo_root)
    port = (env.get("MOLSTUDIO_PORT") or "").strip()
    if not port.isdigit():
        port = "48975"
    log_dir = _config_dir(env)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "mcp-dev-server.log"
    with open(log_path, "ab") as log_file:
        subprocess.Popen(
            [py, "-B", str(server_py), port],
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=log_file,
            start_new_session=True,
            env=dict(env),
        )
    target_url = f"http://127.0.0.1:{port}"
    deadline_srv = time.monotonic() + min(wait_limit, 5.0)
    while time.monotonic() < deadline_srv:
        u, st = probe_bridge({**env, "MOLSTUDIO_URL": target_url})
        if u:
            break
        time.sleep(0.2)
    _open_canvas_url(target_url)
    return target_url


def launch_molstudio(existing_url=None, environ=None, wait_seconds=None):
    """Launch MolStudio.app or dev server + canvas.html and wait for SSE client registration."""
    env = os.environ if environ is None else environ
    wait_limit = float(env.get("MOLSTUDIO_LAUNCH_WAIT_SECONDS") or wait_seconds or DEFAULT_LAUNCH_WAIT_SECONDS)
    if existing_url:
        _open_canvas_url(existing_url)
        return _wait_for_canvas(env, wait_limit, only_url=existing_url)

    app_target = _find_molstudio_app()
    if app_target and sys.platform == "darwin" and shutil.which("open"):
        subprocess.Popen(
            ["open", "-a", app_target],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        url, status = _wait_for_canvas(env, wait_limit)
        if status and status.get("connected"):
            return url, status
        # The packaged app started but never exposed the bridge: use the dev server.
    target_url = _launch_dev_server(env, wait_limit)
    if target_url is None:
        return None, None
    return _wait_for_canvas(env, wait_limit, only_url=target_url)


class MolStudioMCPServer:
    def __init__(self, environ=None):
        self.environ = os.environ if environ is None else environ
        self.framing = "newline"

    def _auto_launch_allowed(self, arguments: dict):
        if self.environ.get("MOLSTUDIO_NO_AUTO_LAUNCH") == "1":
            return False
        if isinstance(arguments, dict) and arguments.get("autoLaunch") is False:
            return False
        return True

    def _ensure_bridge(self, require_canvas: bool, allow_launch: bool):
        url, status = probe_bridge(self.environ)
        if url and (not require_canvas or (status and status.get("connected"))):
            return url, status
        if allow_launch:
            url, status = launch_molstudio(existing_url=url, environ=self.environ)
        return url, status

    def call_tool(self, name: str, arguments: dict | None):
        args = dict(arguments) if isinstance(arguments, dict) else {}
        if name == "molstudio_status":
            open_canvas = bool(args.get("openCanvas"))
            allow_launch = open_canvas and self._auto_launch_allowed(args)
            url, status = self._ensure_bridge(require_canvas=open_canvas, allow_launch=allow_launch)
            if not url or not status:
                return {
                    "content": [{
                        "type": "text",
                        "text": json.dumps({
                            "ok": False,
                            "connected": False,
                            "code": "server_unavailable",
                            "error": "未发现运行中的 MolStudio 服务",
                        }, ensure_ascii=False),
                    }],
                    "isError": open_canvas,
                }
            return {
                "content": [{"type": "text", "text": json.dumps(status, ensure_ascii=False)}],
                "isError": bool(open_canvas and not status.get("connected")),
            }

        if name not in TOOL_NAMES:
            raise KeyError(name)

        stripped = name[len("molstudio_"):]
        detail = args.pop("detail", "compact") if name in COMPACT_TOOLS else "full"
        if detail not in ("compact", "full"):
            return self._tool_error("invalid_detail", "detail 必须是 compact 或 full")
        step_ids = args.pop("stepIds", None) if stripped == "read_canvas" else None
        if step_ids is not None and (
            not isinstance(step_ids, list) or not 1 <= len(step_ids) <= 16
            or any(not isinstance(item, str) or not item.strip() or len(item) > 160 for item in step_ids)
            or len(set(step_ids)) != len(step_ids)
        ):
            return self._tool_error("invalid_step_ids", "stepIds 需要 1–16 个不重复的稳定步骤 ID")
        client_name = args.pop("clientName", None) or self.environ.get("MOLSTUDIO_MCP_CLIENT_NAME") or "MCP"
        allow_launch = self._auto_launch_allowed(args)
        require_canvas = stripped != "inspect_structures"
        discovery_start = time.monotonic()
        url, status = self._ensure_bridge(require_canvas=require_canvas, allow_launch=allow_launch)
        discovery_ms = round((time.monotonic() - discovery_start) * 1000, 2)
        if not url:
            return {
                "content": [{
                    "type": "text",
                    "text": json.dumps({
                        "ok": False,
                        "code": "no_active_canvas",
                        "error": "当前没有运行中的 MolStudio 服务或画布窗口",
                    }, ensure_ascii=False),
                }],
                "isError": True,
            }
        if require_canvas and not (status and status.get("connected")):
            return {
                "content": [{
                    "type": "text",
                    "text": json.dumps({
                        "ok": False,
                        "code": "no_active_canvas",
                        "error": "当前没有已打开的 MolStudio 画布窗口",
                    }, ensure_ascii=False),
                }],
                "isError": True,
            }

        timeout_ms = int(self.environ.get("MOLSTUDIO_MCP_TIMEOUT_MS") or DEFAULT_CALL_TIMEOUT_MS)
        payload = {
            "tool": stripped,
            "args": args,
            "clientName": client_name,
            "timeoutMs": timeout_ms,
            "waitForClientMs": 2000,
        }
        bridge_start = time.monotonic()
        try:
            code, resp = _http_json(
                "POST",
                f"{url}/api/agent/external/call",
                payload=payload,
                timeout=max(5.0, (timeout_ms / 1000.0) + 10.0),
            )
        except (urllib.error.URLError, OSError, ValueError) as err:
            return {
                "content": [{"type": "text", "text": json.dumps({"ok": False, "code": "bridge_unreachable", "error": str(err)}, ensure_ascii=False)}],
                "isError": True,
            }

        if code >= 400 or not isinstance(resp, dict):
            text = json.dumps(resp, ensure_ascii=False) if isinstance(resp, dict) else str(resp)
            return {"content": [{"type": "text", "text": text}], "isError": True}

        text = resp.get("text")
        if not isinstance(text, str) or not text:
            text = json.dumps(resp, ensure_ascii=False)
        is_error = bool(resp.get("isError")) or (resp.get("ok") is False)
        bridge_ms = round((time.monotonic() - bridge_start) * 1000, 2)
        source_bytes = len(text.encode("utf-8"))
        if name in COMPACT_TOOLS and not is_error:
            try:
                value = json.loads(text)
            except ValueError:
                if step_ids is not None:
                    return self._tool_error("invalid_canvas_response", "画布未返回有效 JSON，无法按 stepIds 读取；请重新连接后读取当前画布")
                pass  # Preserve non-JSON replies from older canvas builds.
            else:
                if step_ids is not None:
                    try:
                        value = select_canvas_steps(value, step_ids)
                    except ValueError as error:
                        return self._tool_error("unknown_step", str(error))
                if detail == "compact":
                    value = compact_response(stripped, value)
                if detail == "compact" or step_ids is not None:
                    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        return {
            "content": [{"type": "text", "text": text}], "isError": is_error,
            "_meta": {"molstudio": {
                "detail": detail,
                "timingMs": {"discovery": discovery_ms, "bridge": bridge_ms},
                "sourceTextBytes": source_bytes, "textBytes": len(text.encode("utf-8")),
            }},
        }

    @staticmethod
    def _tool_error(code, message):
        return {"content": [{"type": "text", "text": json.dumps({"ok": False, "code": code, "error": message}, ensure_ascii=False)}], "isError": True}

    def handle_request(self, message: dict):
        if not isinstance(message, dict):
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}
        has_id = "id" in message
        req_id = message.get("id")
        method = message.get("method")
        params = message.get("params") or {}

        if not has_id:
            # Notifications (e.g. notifications/initialized, notifications/cancelled) get no response.
            return None

        if not isinstance(method, str):
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32600, "message": "Invalid Request"}}

        if method == "initialize":
            client_ver = params.get("protocolVersion") if isinstance(params, dict) else None
            proto = client_ver if client_ver in SUPPORTED_PROTOCOL_VERSIONS else SUPPORTED_PROTOCOL_VERSIONS[-1]
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": proto,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "molstudio", "version": "1.0.0"},
                    "instructions": INSTRUCTIONS,
                },
            }

        if method == "ping":
            return {"jsonrpc": "2.0", "id": req_id, "result": {}}

        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}

        if method == "tools/call":
            if not isinstance(params, dict) or not isinstance(params.get("name"), str):
                return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": "Invalid params"}}
            tool_name = params["name"]
            tool_args = params.get("arguments")
            if tool_args is not None and not isinstance(tool_args, dict):
                return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": "arguments must be an object"}}
            if tool_name not in TOOL_NAMES:
                return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": f"Unknown tool: {tool_name}"}}
            result = self.call_tool(tool_name, tool_args)
            return {"jsonrpc": "2.0", "id": req_id, "result": result}

        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}


def read_stdio_message(stream):
    """Read one JSON-RPC message (either Content-Length framed or newline-delimited)."""
    while True:
        raw_line = stream.readline()
        if not raw_line:
            return None, None
        stripped = raw_line.strip()
        if not stripped:
            continue
        lower = stripped.lower()
        if lower.startswith(b"content-length:"):
            try:
                length = int(stripped.split(b":", 1)[1].strip())
            except ValueError as exc:
                raise ValueError("Invalid Content-Length header") from exc
            while True:
                header_line = stream.readline()
                if not header_line or header_line in (b"\r\n", b"\n"):
                    break
            body = stream.read(length)
            if len(body) < length:
                return None, "content-length"
            return json.loads(body.decode("utf-8")), "content-length"
        return json.loads(stripped.decode("utf-8")), "newline"


def write_stdio_message(stream, message: dict, framing: str = "newline"):
    encoded = json.dumps(message, ensure_ascii=False).encode("utf-8")
    if framing == "content-length":
        header = f"Content-Length: {len(encoded)}\r\n\r\n".encode("ascii")
        stream.write(header + encoded)
    else:
        stream.write(encoded + b"\n")
    stream.flush()


def serve_stdio(stdin=None, stdout=None, environ=None):
    in_stream = stdin if stdin is not None else sys.stdin.buffer
    out_stream = stdout if stdout is not None else sys.stdout.buffer
    server = MolStudioMCPServer(environ=environ)
    while True:
        try:
            message, framing = read_stdio_message(in_stream)
        except (ValueError, UnicodeDecodeError) as err:
            write_stdio_message(
                out_stream,
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"Parse error: {err}"}},
                server.framing,
            )
            continue
        if message is None:
            break
        if framing:
            server.framing = framing
        response = server.handle_request(message)
        if response is not None:
            write_stdio_message(out_stream, response, server.framing)


def main():
    serve_stdio()


if __name__ == "__main__":
    main()
