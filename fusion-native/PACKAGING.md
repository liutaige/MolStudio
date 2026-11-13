# Native macOS packaging

`build-app.sh` builds a native app with its own relocatable CPython and RDKit.
The service directly imports RDKit and the local `stereo.py` and `inorganic.py`; the RDKit wheel
also requires NumPy and Pillow. The bundle includes those three wheel packages
and the Python standard library. It never copies the development `.venv-rdkit`.
The inorganic drawing catalog and helper are copied with `ketcher-local/`.
The app contains the current canvas, workbench, AI panel, help and NGL 3D viewer.
The retired ChemDoodle page, Electron shell, one-off debug probes and their unused
libraries are not shipped. The separate paper-document application is left in
its own project and is not part of this build.

## Build

On macOS 14 or newer, install Xcode command-line tools, Node.js with npm and
[uv](https://docs.astral.sh/uv/getting-started/installation/). A build needs
network access to download uv's managed CPython 3.12.13 distribution and the
pinned RDKit 2026.9.1, NumPy 2.5.4 and Pillow 13.0.0 binary wheels. A compatible
wheel must be available for the build machine's architecture. Build separately
on Apple Silicon and Intel; this script does not produce a universal app.

```sh
bash fusion-native/build-app.sh /tmp/MolStudio.app
```

The destination must end in `.app`. An existing destination is preserved unless
`OVERWRITE_APP=1` is set explicitly. The script installs Python in a temporary
folder, copies it into the app, checks RDKit, CoordGen and 3D embedding, then
ad-hoc signs and verifies the bundle. The resulting app is not Developer ID
signed or notarized, and the script does not enable the macOS App Sandbox.
`BUILD_WITH_SWIFTC=1` builds with `swiftc` instead of SwiftPM if needed.

The app honors the existing `MolStudioPythonPath` user default and
`MOLSTUDIO_PYTHON` environment variable before falling back to its bundled
Python. To exercise the bundled runtime, remove those overrides in the test
account; an executable override with broken dependencies will otherwise take
precedence and display a diagnostic. The bundled Python runs in isolated mode,
ignoring user site packages and Python environment variables, and disables
bytecode writes so launching does not alter the signed application bundle. The
app also disables bytecode writes when it uses a configured external interpreter.

## Distribute as DMG

`make-dmg.sh` is the release path: it runs a fresh `build-app.sh`, exercises
`verify-portable.py` on the result, assembles a staging folder (app,
Applications link, and a Chinese first-open note), compresses it to a UDZO
image, then mounts the image to spot-check the version and signature, and
finally syncs the accepted app back to `dist/MolStudio.app`.

```sh
bash fusion-native/make-dmg.sh
# -> fusion-native/dist/MolStudio-<version>[-<beta tag>]-<arch>.dmg
```

Versions live in one place, `fusion-native/version.sh`: `APP_VERSION`
(three-part number, also mirrored into `fusion/package.json`; `make-dmg.sh`
fails if they drift), `BUILD_NUMBER` (incremented per public build), and
`BETA_TAG` (set empty for a final release). One machine produces only its own
architecture; build the other architecture on an Intel or Apple Silicon Mac
respectively.

The DMG is ad-hoc signed only — no Developer ID signature or notarization — so
on another Mac the quarantined app triggers Gatekeeper on first launch
("cannot verify the developer" or, after some transfer paths, "damaged"). The
bundled first-open note explains the one-time approvals: right-click Open,
Privacy & Security "Open Anyway", or removing the quarantine attribute with
`xattr`. Double-click-clean distribution requires a Developer ID Application
certificate plus notarization, which is not yet available.

## Install and update

Quit any running copy of MolStudio before launching a replacement. The native
bundles share the `local.ketcher3d.native` bundle identifier. Copy the verified
build to `~/Applications/MolStudio.app` and launch it from there. Model settings
are stored in `~/Library/Application Support/MolStudio`, and the API key uses
the macOS Keychain. Both are outside the application bundle.

Builds are written to the chosen output path. Keep older installed app bundles
outside the source checkout; source history is kept in Git. The current assistant
and acceptance commands are documented in [MolStudio AI assistant](../fusion/agent/README.md).

## Relocation check

This test copies the app to a temporary path, starts its packaged Python service
with a clean environment and a temporary port, and checks the editor resources,
properties, ordinary 3D generation and four inorganic reference models. It does not start or interact with the graphical
app or any service already listening on the normal port.

```sh
/tmp/MolStudio.app/Contents/Resources/python/bin/python -I -B fusion-native/verify-portable.py /tmp/MolStudio.app
codesign --verify --deep --strict /tmp/MolStudio.app
```

This check does not establish Finder double-click behavior, Gatekeeper acceptance,
App Sandbox operation, another macOS version, or compatibility with another
architecture. Test those separately on representative clean machines.
