# MolStudio

**MolStudio** is a 2D chemical structure, reaction mechanism, and AI-assisted chemistry canvas combining an enhanced Ketcher editor, semantic electron-flow tools, RDKit stereochemistry / 3D conformer generation, paper-page layout with vector PDF export, a local MCP server, and a native macOS desktop shell.

> **Beta Status / 当前状态**: `v0.4.1` — Web/Python canvas and MCP server run locally; the native desktop shell (`fusion-native/`) requires macOS 14+ (Xcode/Swift). Current UI strings are primarily Simplified Chinese; paper mode currently supports Phase-1 mixed editing (adding pages and removing blank trailing pages; automatic height pagination and rich-text formulas/Markdown are not yet implemented).

---

## Key Features / 核心能力

- **Unified Chemistry & Mechanism Canvas (`fusion/canvas.html`, `fusion/workbench/`)**: Draw molecules alongside semantic lone pairs, 1-electron fishhook and 2-electron curved arrows, and versioned `reactionSteps` with automatic multi-row DAG route layout (`续` continuation markers, reagent docking, preparation branches).
- **RDKit Chemistry & Conservative Cleanup (`fusion/server.py`, `stereo.py`, `conservative_layout.py`, `inorganic.py`)**: Stereochemistry-preserving 2D cleanup (preserving atom identity, scale, and substituent side), inorganic coordination/hypervalent 3D templates, and ETKDG + MMFF/UFF 3D conformer preview (`fusion/threed.html`, `ngl.js`).
- **Paper Mode & Native PDF Export**: Switch between infinite canvas and A4/Letter paper pages with mixed text boxes, images, shapes, embedded 3D previews, `.molwork` v2 persistence, and per-page vector PDF export on macOS.
- **Built-in AI Assistant & External MCP Server (`fusion/agent/`, `fusion/mcp_server.py`)**: OpenAI-compatible Chat Completions gateway (API keys kept in local process / macOS Keychain) and `stdio` MCP bridge (`molstudio_status`, `molstudio_read_canvas`, `molstudio_inspect_structures`, `molstudio_draw_operations`, etc.) for external coding harnesses/clients.
- **Native macOS Shell (`fusion-native/`)**: Swift/AppKit + SwiftUI welcome screen, native toolbars/inspectors/color picker, and standalone relocatable `.app` / `.dmg` packaging with bundled CPython + RDKit.

---

## Quick Start / 快速开始

### Prerequisites

- **Python 3.12+** (pinned runtime in `fusion/requirements.txt`: `rdkit==2026.9.1`, `numpy==2.5.4`, `pillow==13.0.0`)
- **Node.js & npm** (for agent runtime bundling and tests)
- **[uv](https://docs.astral.sh/uv/getting-started/installation/)** (recommended for Python env & macOS app packaging)
- **macOS 14+ & Xcode Command Line Tools** (only required when building `fusion-native/` desktop `.app`)

### Setup & Run (Local Web Canvas)

```sh
# 1. Python environment with RDKit
uv venv --python 3.12.13 .venv-rdkit
uv pip install --python .venv-rdkit/bin/python --only-binary :all: -r fusion/requirements.txt

# 2. Node dependencies & agent browser bundle
npm --prefix fusion ci --ignore-scripts
npm --prefix fusion/agent ci --ignore-scripts
npm --prefix fusion run build:agent

# 3. Start local server (default port 48975)
npm --prefix fusion start
```

Open `http://127.0.0.1:48975/` (`/`, `/index.html`, and `/canvas.html` all open the current canvas).

### Native macOS App Build / macOS 原生应用构建

```sh
npm --prefix fusion run build -- /tmp/MolStudio.app
```

See [fusion-native/PACKAGING.md](fusion-native/PACKAGING.md) for DMG packaging, Gatekeeper notes (current builds are ad-hoc signed), and isolated candidate builds.

---

## Documentation / 文档导航

- [Development, Build & Tests / 开发、构建与测试](fusion/README.md)
- [AI Assistant, Protocol & MCP Guide / AI 助手与 MCP 协同](fusion/agent/README.md)
- [Canvas Drawing Skill for MCP Clients / MCP 绘图技能说明](skills/molstudio-draw/SKILL.md)
- [macOS Native Packaging / macOS 原生应用打包](fusion-native/PACKAGING.md)
- [Native Regressions / 原生回归说明](fusion-native/regression/README.md)
- [Inorganic 3D Support Scope / 无机小分子 3D 支持范围](fusion/INORGANIC_3D.md)
- [Paper Mode Design / 纸页模式与欢迎页设计](fusion/DOCUMENT_MODE.md) · [Verification Records / 实现与分构建验收](fusion/DOCUMENT_MODE_RESULTS.md)

---

## Repository Structure / 目录结构

| Path | Role |
| --- | --- |
| `fusion/canvas.html` | Primary canvas entrypoint |
| `fusion/workbench/` | Mechanism model, rendering, editing, `.molwork` storage, and AI bridge |
| `fusion/agent/` | AI sidebar UI, tool loop, streaming parser, and validation |
| `fusion/server.py`, `stereo.py`, `conservative_layout.py`, `inorganic.py`, `agent_gateway.py` | Local HTTP server, RDKit chemistry calculations, conservative cleanup, and model gateway |
| `fusion/mcp_server.py`, `agent_external_bridge.py`, `mcp_response.py` | Stdio MCP server and localhost SSE bridge |
| `fusion/threed.html`, `fusion/vendor/ngl.js` | 3D conformer preview |
| `fusion/tests/`, `fusion-native/regression/` | Unit, chemistry, layout, and native regressions |
| `fusion-native/` | macOS Swift/AppKit/SwiftUI shell and `.app`/`.dmg` packaging scripts |
| `ketcher-local/` | Pinned Ketcher 3.18 standalone assets and local patch scripts (`fusion/patch-ketcher-*.cjs`) |
| `integrations/`, `skills/` | MCP integration config example and `molstudio-draw` skill |

Complete mechanism files use `.molwork`; interchange formats include `.ket`, `.mol`, `.sdf`, and `.smi`.

---

## Testing / 测试

```sh
# JavaScript unit, agent, and document tests
npm --prefix fusion test

# Python chemistry, layout, gateway, and MCP tests
.venv-rdkit/bin/python -B fusion/tests/test_conservative_layout.py
.venv-rdkit/bin/python -B fusion/tests/test_stereo.py
.venv-rdkit/bin/python -B -m unittest discover -s fusion/tests -p 'test_*.py'
```

See [fusion/README.md](fusion/README.md) and [fusion/agent/README.md](fusion/agent/README.md) for Electron real-canvas probes and live-model acceptance commands.

---

## License & Notices / 开源协议

- Licensed under the **Apache License 2.0** — see [LICENSE](LICENSE).
- Third-party bundled components (Ketcher, NGL Viewer, Pi Agent Core, KaTeX, markdown-it, etc.) retain their respective licenses — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## Branch Scope & Maintenance / Git 与发布范围

GitHub 的 `main` 只保留当前画布、共享化学核心、原生壳、AI/MCP、必要测试与开发说明。本地完整开发分支 `codex/local-workspace` 上保留了未公开的半成品实验应用（如 `research/document-editor-prototype/`），该分支不推送 GitHub。从本地开发分支同步 `main` 时使用：

```sh
python3 scripts/update-canvas-branch.py
git push origin main:main
```

新克隆如需启用推送范围检查：

```sh
git config core.hooksPath .githooks
git config remote.origin.push refs/heads/main:refs/heads/main
```
