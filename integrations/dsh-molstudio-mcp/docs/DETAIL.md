# MolStudio canvas MCP connection

This bundle is configuration only. It inserts one `@deepseek-ai/dsh-mcp-client` row that runs the MolStudio MCP server over `stdio`, so this Harness can draw on the live MolStudio canvas with the same validated pipeline the built-in assistant uses.

## What it connects

- Command: `/Users/tiger/MolStudio/.venv-rdkit/bin/python -B /Users/tiger/MolStudio/fusion/mcp_server.py`, working directory `/Users/tiger/MolStudio`.
- Tools appear as `mcp__molstudio__<tool>`: `molstudio_status`, `molstudio_read_canvas`, `molstudio_inspect_structures`, `molstudio_draw_operations`, `molstudio_plan_task`, `molstudio_complete_phase`, `molstudio_complete_layout`, and `molstudio_write_plan`.
- Every committed batch becomes real editable Ketcher and mechanism-layer objects with undo, and the MolStudio AI panel shows a `外部协同 · <clientName>` badge with a per-operation change list.

## Use

Use MCP directly for ordinary drawing. Repository source reads, shell/RDKit diagnostic scripts, and separate Harness viewers are not setup steps. The MolStudio canvas and its own AI panel already display committed work.

1. When a connection is needed, call `mcp__molstudio__molstudio_status` with `openCanvas: true` once to discover or launch the canvas.
2. Read before editing existing objects when current atom/bond IDs and `stepId`/`version` are unavailable. Reuse successful receipt references across batches; reread after manual edits, document changes, or stale-reference diagnostics.
3. Batch uncertain SMILES in `mcp__molstudio__molstudio_inspect_structures` (up to 12 structures per call).
4. Draw complete elementary steps with `mcp__molstudio__molstudio_draw_operations` (up to 40 operations, including optional `step.seal` boundaries). Pass `clientName`; set `finish: true` for the final batch and check `finishAccepted`.

Simple mechanisms need no mandatory plan. For phased tasks, an accepted drawing with `finish: true` already completes the current phase; do not repeat `complete_phase` for it. See the [drawing Skill](../../../skills/molstudio-draw/SKILL.md) for chemistry and recovery rules.

`molstudio_read_canvas`, `molstudio_inspect_structures`, and `molstudio_draw_operations` accept `detail: "compact" | "full"` and default to compact responses. Use `full` when the original complete result is needed, such as detailed geometry inspection. This affects only MCP response size, not execution or validation.

For known-step inspection or repair, `molstudio_read_canvas` also accepts `stepIds` with 1–16 distinct stable step IDs from receipts. It returns those steps, their complete participating molecules, and relevant electron flow; `detail` still selects rendering detail. Use this scope instead of reading unrelated parts of the canvas.

Server discovery order: `MOLSTUDIO_URL` / `MOLSTUDIO_PORT`, then `~/Library/Application Support/MolStudio/active-bridge.json`, then ports `8462` and `48975`. The server also returns chemistry rules in its MCP instructions, which this Harness adds to the system prompt while the connection is active.

## Limits

- The canvas must be reachable: either a running MolStudio window, or auto-launch enabled (set `MOLSTUDIO_NO_AUTO_LAUNCH=1` in the row's `env` to disable it).
- Calls are rejected with an explicit message while the built-in MolStudio assistant is running a task, because both share one edit pipeline.
- A failed transaction rolls back and returns a diagnostic; earlier committed/sealed steps remain. Completion can be rejected after a successful commit, so use the receipt and repair only affected work. Preserve the requested chemistry; do not substitute a different substrate or intermediate to pass validation. Report unsupported representation or validation limits explicitly.
- `inspect_structures` uses the project interpreter above for local RDKit preflight; a generic system `python3` may not have RDKit.
