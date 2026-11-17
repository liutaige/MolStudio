# Third-Party Notices

MolStudio includes or builds upon third-party open-source software. Each component retains its own copyright and license terms.

## Bundled Frontend Assets

| Component | Path | Upstream / Role | License |
| --- | --- | --- | --- |
| Ketcher (pinned 3.18 standalone build) | `ketcher-local/` | [EPAM Ketcher](https://github.com/epam/ketcher) — 2D chemical structure editor, patched locally via `fusion/patch-ketcher-*.cjs` for clipboard transport, action primitives, label spacing, and inorganic valence hooks. Bundled dependency notices are included in `ketcher-local/static/js/*.LICENSE.txt`. | Apache-2.0 |
| NGL Viewer | `fusion/vendor/ngl.js` | [NGL](https://github.com/nglviewer/ngl) — WebGL 3D molecular viewer used in `fusion/threed.html` and 3D document objects. | MIT |
| AI Agent Browser Runtime | `fusion/agent/dist/` | Built from `fusion/agent/package.json` (`@earendil-works/pi-*`, `markdown-it`, `katex`, `openai`, etc.). See [agent third-party notices](fusion/agent/THIRD_PARTY_NOTICES.md) and [combined runtime notices](fusion/agent/dist/THIRD_PARTY_NOTICES.txt). | MIT / BSD-2-Clause / Apache-2.0 |

## Python & Native Packaging Dependencies (Installed at Setup / Build Time)

| Component | Version Pinned | Role | License |
| --- | --- | --- | --- |
| RDKit | `2026.9.1` | 2D depiction/CoordGen, stereo verification, SMILES/MOL conversion, 3D ETKDG & force-field optimization | BSD-3-Clause |
| NumPy | `2.5.4` | Damped least-squares conservative layout & geometry math | BSD-3-Clause |
| Pillow | `13.0.0` | Required by RDKit wheel and image handling | HPND (MIT-CMU) |
