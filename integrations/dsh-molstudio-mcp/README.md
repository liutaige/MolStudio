# MolStudio MCP for DeepSeek Harness

Configuration-only DSH bundle (`@local/molstudio-mcp`) that connects this Harness to the MolStudio canvas MCP server over `stdio`, so the agent can draw, inspect, and edit the live canvas with `mcp__molstudio__*` tools.

- Install: DSH **Plugins** > **Add plugin** > this directory, or `plugin_manager` `install_bundle` with this path.
- Remove: disable or remove the `@local/molstudio-mcp` bundle; no other profile state is touched.
- Runtime: `/path/to/MolStudio/.venv-rdkit/bin/python -B /path/to/MolStudio/fusion/mcp_server.py` (cwd `/path/to/MolStudio`; replace `/path/to/MolStudio` with your local checkout path).
- Connection details, tool list, and limits: [docs/DETAIL.md](docs/DETAIL.md).
- Server contract and chemistry rules: [fusion/mcp_server.py](../../fusion/mcp_server.py) and [skills/molstudio-draw/SKILL.md](../../skills/molstudio-draw/SKILL.md).
