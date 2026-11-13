#!/usr/bin/env python3
"""Exercise a signed bundle before and after relocation, without opening the GUI."""
import sys

if not sys.dont_write_bytecode:
    sys.exit("Run this script with Python -B to avoid altering the signed bundle.")

import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request


def verify_signature(app):
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app], check=True)


def exercise(app, temp):
    verify_signature(app)
    resources = os.path.join(app, "Contents", "Resources")
    python = os.path.join(resources, "python", "bin", "python")
    for retired in ("doc.html", "index.html", "arrow_probe.js",
                    "vendor/chemdoodleweb.js", "vendor/chemdoodleweb-uis.js", "vendor/konva.min.js"):
        assert not os.path.exists(os.path.join(resources, retired)), "Retired resource in current app: " + retired
    env = {"PATH": "/usr/bin:/bin", "HOME": temp, "PYTHONNOUSERSITE": "1",
           "PYTHONHOME": "/invalid/python-home", "PYTHONPATH": "/invalid/python-path"}
    mol = subprocess.check_output([
        python, "-I", "-B", "-c",
        'from rdkit import Chem; print(Chem.MolToMolBlock(Chem.MolFromSmiles("CCO")))',
    ], env=env, cwd=temp).decode()
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    proc = subprocess.Popen([python, "-I", "-B", os.path.join(resources, "server.py"), str(port)],
                            cwd=temp, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        base = "http://127.0.0.1:%d" % port
        for _ in range(100):
            try:
                with urllib.request.urlopen(base + "/canvas.html", timeout=1) as response:
                    assert response.status == 200 and response.read()
                break
            except OSError:
                if proc.poll() is not None:
                    raise RuntimeError(proc.stderr.read().decode())
                time.sleep(.1)
        else:
            raise RuntimeError("server did not start")
        with urllib.request.urlopen(base + "/", timeout=5) as response:
            root_page = response.read()
            assert response.status == 200
        with urllib.request.urlopen(base + "/canvas.html", timeout=5) as response:
            assert root_page == response.read(), "Service root must serve the current canvas"
        for path in ("/workbench/canvas-viewport.js", "/ketcher/index.html", "/vendor/ngl.js",
                     "/ketcher/inorganic-catalog.js", "/ketcher/inorganic-valence.js",
                     "/agent/app.js", "/agent/panel.js", "/agent/panel.css", "/agent/dist/agent-runtime.js"):
            with urllib.request.urlopen(base + path, timeout=5) as response:
                assert response.status == 200 and response.read(), path
        with urllib.request.urlopen(base + "/api/agent/config", timeout=5) as response:
            config = json.load(response)
            assert config.get("sessionToken") and "apiKey" not in config, config.keys()
        req = urllib.request.Request(base + "/api/agent/structure",
                                     data=json.dumps({"smiles": "[OH-:1].[CH3:2][Br:3]"}).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as response:
            structure = json.load(response)
            assert structure.get("ok") and [atom["ref"] for atom in structure["atoms"]] == ["1", "2", "3"], structure
            assert structure["atoms"][0]["charge"] == -1 and structure["ket"]["mol0"]["atoms"][1]["label"] == "C", structure
        for endpoint in ("props", "gen3d"):
            req = urllib.request.Request(base + "/api/" + endpoint,
                                         data=json.dumps({"data": mol}).encode(),
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=20) as response:
                result = json.load(response)
                assert result.get("ok"), result
        for smiles, count in (("F[Xe](F)(F)F", 5), ("F[Kr]F", 3),
                              ("FCl(F)F", 4), ("FI(F)(F)(F)(F)(F)F", 8)):
            req = urllib.request.Request(base + "/api/gen3d",
                                         data=json.dumps({"data": smiles}).encode(),
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=20) as response:
                result = json.load(response)
                assert result.get("ok") and result["natoms"] == count, result
                assert result["geometry"]["method"] == "reference_geometry", result
                assert result["geometry"]["optimized"] is False and result["notes"], result
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    verify_signature(app)
    print("PASS:", app, "service and signature before/after")


app = os.path.abspath(sys.argv[1])
with tempfile.TemporaryDirectory(prefix="molstudio-relocated-") as temp:
    exercise(app, temp)
    relocated = os.path.join(temp, "Relocated App.app")
    subprocess.run(["/usr/bin/ditto", app, relocated], check=True)
    exercise(relocated, temp)
verify_signature(app)
