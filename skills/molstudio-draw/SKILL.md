---
name: molstudio-draw
description: Draw, inspect, and edit live 2D chemical structures, reaction steps, lone pairs, and curved electron-flow arrows on the MolStudio canvas via MCP tools. Use when the user asks to draw a molecule, reaction scheme, or curved-arrow mechanism in MolStudio, or inspect/modify the active MolStudio canvas.
---

# MolStudio Canvas Drawing Skill

Use the `molstudio_*` MCP tools to collaborate directly on the live MolStudio canvas (`fusion/canvas.html` or `MolStudio.app`). Every committed edit creates a real editable Ketcher + mechanism-layer object with undo support and live progress visibility in the MolStudio AI panel.

## Workflow

For ordinary drawing, use the MCP tools directly. The tool schemas and receipts are the working contract; reading repository source, running shell/RDKit diagnostic scripts, or building a separate HTML/sidebar viewer is not a prerequisite. Reserve implementation investigation for integration troubleshooting or development.

1. **Connect when needed**: One `molstudio_status` call with `openCanvas: true` can discover or launch MolStudio and wait for its canvas. Reuse a healthy connection.
2. **Read current references**: Before editing existing objects or continuing a mechanism, use `molstudio_read_canvas` if current references are unavailable. Keep atom/bond IDs, `stepId`/`version`, and aliases from successful receipts for subsequent batches. Read again after a document switch, manual edit, stale-reference diagnostic, or when more context is needed; do not reread the whole unchanged canvas after every batch.
3. **Batch uncertain structures**: Preflight complex or unfamiliar SMILES together in `molstudio_inspect_structures` (up to 12 structures). It returns atom/bond refs, `order`, and `nativeType` without drawing.
4. **Submit complete steps**: Use `molstudio_draw_operations` with at most 40 operations per call, `taskScope`, and `clientName` (e.g. `"Codex"`). A batch can contain one complete elementary step or several; optional `step.seal` boundaries commit each step separately and count toward the limit. When using seals, seal the last step too. Set `finish: true` on the final batch and check `finishAccepted`. If drawing is already committed, replay an unchanged successful batch with the same operation IDs and `finish: true`; do not submit `step.seal` alone or add an unrelated edit merely to finish.
5. **Plan only when useful**: A bounded mechanism does not require `write_plan` or `plan_task`. For a complex task, `plan_task` and `complete_phase` support phases. In a phased task, an accepted `draw_operations` with `finish: true` already completes the current phase; do not call `complete_phase` again for that phase. For layout-only cleanup, finish with `molstudio_complete_layout`.

`molstudio_read_canvas`, `molstudio_inspect_structures`, and `molstudio_draw_operations` accept `detail: "compact" | "full"`. The default compact response reduces model context while retaining the references and diagnostics needed for the workflow. Request `full` only when the original complete result is needed, such as detailed geometry inspection; this setting does not change canvas execution or validation.

For inspection or repair of known steps, pass `stepIds: ["<stable stepId>"]` to `molstudio_read_canvas` (1–16 distinct step IDs from receipts). This returns the selected steps with their complete participating molecules and relevant electron flow; `detail` still controls the returned rendering detail. Prefer this local context when the rest of the canvas is unrelated.

## Essential Chemistry & Schema Rules

- **Mapped SMILES**: In `molecule.add`, map every atom with distinct positive integers (`[CH3:1][Br:2]`, including explicit `[H:n]`) and reference them as `<opId>:<mapNum>`.
- **Reaction steps first**: Declare `reactionStep.create` (with `layout: {}`) before the `molecule.add` operations it references. Use one atom reference per molecule in `reactants` and `products`. Reuse the same unchanged intermediate as the immediately following step's reactant, including across wrapped rows; copying it splits the route. Omit molecule coordinates and explicit breaks for automatic route placement unless the user specifies them.
- **Lone pairs & curved arrows**:
  - Omit `lonePair.add.angle` for automatic target-following aim; use `lonePair.modify` with `aim: "auto"` when adapting an existing lone pair.
  - Every `arrow.add` must specify top-level `type: "arrow.add"`, `source` (with `type: "lonePair" | "bond" | "atom"`), `target` (with `type: "atom" | "formingBond"`), and `electronCount` (`2` for full arrow, `1` for fishhook).
  - For π arrows, check `inspect_structures` `nativeType` first (`nativeType: 2` required for a double-bond π source).
- **Proton transfers**: Draw the transferred proton as a separate bonded `[H:n]` (or use `hydrogen.makeExplicit`), then draw base lone pair → H and donor X–H σ bond → that same donor X. All electron-flow endpoints belong to that step's reactants, not product copies; include its participating reagents in `reactants`.
- **Charge and representation checks**: Keep each elementary step's formal charges consistent. Neutral alcohol addition to a protonated carbonyl leaves the original carbonyl oxygen as OH and the incoming alcohol oxygen positively charged until deprotonation. The host rejects a new product radical when no reactant has a radical and all arrows transfer two electrons; report unsupported representations instead of changing intermediates to pass this check.
- **Keep canvas clean**: Use `inspect_structures` for structural preflight; do not add scratch or probe molecules to the live canvas just to investigate them. Do NOT add `text.add` annotations or captions unless explicitly requested by the user.
- **Error recovery**: Read `diagnostic` (`operationId`, `code`, `layoutFailures`, `stepId`/`actualVersion`) and repair only the affected work. A failed transaction rolls back; earlier committed or sealed steps remain. A rejected completion check can follow a successful commit, so use the receipt to avoid redrawing it. Preserve the requested substrate, intermediates, and electron flow when correcting geometry. Do not change the chemistry merely to pass a validator. If the requested chemistry exceeds the current representation or validation support, report the specific diagnostic and limitation rather than inventing a substitute mechanism.

## MCP Server Registration

Development repository:
```json
{
  "mcpServers": {
    "molstudio": {
      "command": "/Users/tiger/MolStudio/.venv-rdkit/bin/python",
      "args": ["-B", "/Users/tiger/MolStudio/fusion/mcp_server.py"]
    }
  }
}
```

Bundled `MolStudio.app`:
```json
{
  "mcpServers": {
    "molstudio": {
      "command": "/Applications/MolStudio.app/Contents/Resources/python/bin/python",
      "args": ["-I", "-B", "/Applications/MolStudio.app/Contents/Resources/mcp_server.py"]
    }
  }
}
```

Optional environment variables:
- `MOLSTUDIO_URL` / `MOLSTUDIO_PORT`: Target a specific running MolStudio server (otherwise discovers via `~/Library/Application Support/MolStudio/active-bridge.json`, then ports `8462` and `48975`).
- `MOLSTUDIO_NO_AUTO_LAUNCH=1`: Disable auto-launching `MolStudio.app` or opening `canvas.html` when no canvas is active.
- `MOLSTUDIO_MCP_CLIENT_NAME`: Default client badge displayed in the MolStudio AI panel.
