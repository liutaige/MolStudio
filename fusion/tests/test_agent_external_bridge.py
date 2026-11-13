"""Tests for the MolStudio external agent bridge, server routes, and stdio MCP server."""
from __future__ import annotations

import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import agent_external_bridge as bridge_module
import mcp_server
import server as chemistry_server


def _read_sse_event(response):
    """Read one SSE event block from an HTTPResponse."""
    event_type = None
    data_lines = []
    comments = []
    while True:
        raw = response.readline()
        if not raw:
            return None
        line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
        if line == "":
            if event_type is not None or data_lines or comments:
                return {
                    "event": event_type,
                    "data": "\n".join(data_lines) if data_lines else None,
                    "comments": comments,
                }
            continue
        if line.startswith(":"):
            comments.append(line[1:].strip())
            if not data_lines and event_type is None:
                return {"event": "keepalive", "data": None, "comments": comments}
        elif line.startswith("event:"):
            event_type = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].strip())


class ExternalBridgeUnitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.bridge = bridge_module.ExternalBridge(
            config_dir=self.temp.name,
            keepalive_seconds=0.15,
        )
        bridge_ref = self.bridge

        class TestHandler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if not bridge_module.handle_get(self, service=bridge_ref):
                    self.send_response(404)
                    self.end_headers()

            def do_POST(self):
                if not bridge_module.handle_post(self, service=bridge_ref):
                    self.send_response(404)
                    self.end_headers()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), TestHandler)
        self.server.daemon_threads = True
        self.bridge.register_port(self.server.server_port)
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.bridge.close()
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def _request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            hdrs = dict(headers or {})
            raw = None
            if body is not None:
                raw = json.dumps(body).encode("utf-8")
                hdrs.setdefault("Content-Type", "application/json")
            conn.request(method, path, body=raw, headers=hdrs)
            resp = conn.getresponse()
            data = resp.read().decode("utf-8")
            return resp.status, json.loads(data) if data else None
        finally:
            conn.close()

    def test_discovery_file_and_initial_status(self):
        discovery_path = Path(self.temp.name) / "active-bridge.json"
        self.assertTrue(discovery_path.is_file())
        discovery = json.loads(discovery_path.read_text(encoding="utf-8"))
        self.assertEqual(discovery["port"], self.port)
        self.assertEqual(discovery["pid"], os.getpid())
        self.assertEqual(discovery["url"], f"http://127.0.0.1:{self.port}")
        self.assertIsNone(discovery["activeClientId"])
        self.assertEqual(discovery["connectedClients"], 0)
        self.assertIsInstance(discovery["updatedAt"], int)

        code, body = self._request("GET", "/api/agent/external/status")
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        self.assertFalse(body["connected"])
        self.assertEqual(body["port"], self.port)
        self.assertEqual(body["clients"], [])

    def test_origin_and_host_enforcement(self):
        code, body = self._request("GET", "/api/agent/external/status", headers={"Host": f"evil.example:{self.port}"})
        self.assertEqual(code, 403)
        self.assertEqual(body["code"], "invalid_host")

        code, body = self._request(
            "POST",
            "/api/agent/external/status",
            {"clientId": "c1", "focused": True},
            headers={"Origin": "https://evil.example"},
        )
        self.assertEqual(code, 403)
        self.assertEqual(body["code"], "invalid_origin")

        code, body = self._request(
            "POST",
            "/api/agent/external/call",
            {"tool": "read_canvas"},
            headers={"Origin": f"http://127.0.0.1:{self.port + 1}"},
        )
        self.assertEqual(code, 403)
        self.assertEqual(body["code"], "invalid_origin")

    def test_no_active_canvas_returns_409(self):
        code, body = self._request(
            "POST",
            "/api/agent/external/call",
            {"tool": "read_canvas", "args": {}, "waitForClientMs": 50},
        )
        self.assertEqual(code, 409)
        self.assertFalse(body["ok"])
        self.assertEqual(body["code"], "no_active_canvas")

    def test_sse_keepalive_and_status_lifecycle(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/api/agent/external/events?clientId=win-1&sessionId=sess-a")
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        self.assertIn("text/event-stream", resp.getheader("Content-Type"))
        self.assertEqual(resp.getheader("Cache-Control"), "no-store")
        self.assertEqual(resp.getheader("X-Accel-Buffering"), "no")

        connected_ev = _read_sse_event(resp)
        self.assertEqual(connected_ev["event"], "connected")
        self.assertEqual(json.loads(connected_ev["data"]), {"clientId": "win-1", "sessionId": "sess-a"})

        keepalive_ev = _read_sse_event(resp)
        self.assertEqual(keepalive_ev["event"], "keepalive")

        code, st_resp = self._request(
            "POST",
            "/api/agent/external/status",
            {"clientId": "win-1", "sessionId": "sess-b", "focused": True, "busy": False},
        )
        self.assertEqual(code, 200)
        self.assertTrue(st_resp["ok"])

        code, status = self._request("GET", "/api/agent/external/status")
        self.assertEqual(code, 200)
        self.assertTrue(status["connected"])
        self.assertEqual(status["activeClientId"], "win-1")
        self.assertEqual(status["sessionId"], "sess-b")
        self.assertEqual(len(status["clients"]), 1)
        self.assertTrue(status["clients"][0]["focused"])

        discovery = json.loads((Path(self.temp.name) / "active-bridge.json").read_text(encoding="utf-8"))
        self.assertEqual(discovery["activeClientId"], "win-1")
        self.assertEqual(discovery["sessionId"], "sess-b")
        self.assertEqual(discovery["connectedClients"], 1)

        resp.close()
        conn.close()
        # Wait briefly for server handler thread to detect disconnect and unregister
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            _, st = self._request("GET", "/api/agent/external/status")
            if not st["connected"]:
                break
            time.sleep(0.05)
        _, st = self._request("GET", "/api/agent/external/status")
        self.assertFalse(st["connected"])
        self.assertEqual(st["clients"], [])

    def test_tool_call_prefers_focused_client_and_round_trips(self):
        c1 = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c1.request("GET", "/api/agent/external/events?clientId=bg-client&sessionId=s1")
        r1 = c1.getresponse()
        _read_sse_event(r1)  # connected

        c2 = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c2.request("GET", "/api/agent/external/events?clientId=focused-client&sessionId=s2")
        r2 = c2.getresponse()
        _read_sse_event(r2)  # connected

        self._request("POST", "/api/agent/external/status", {"clientId": "bg-client", "focused": False, "busy": False})
        self._request("POST", "/api/agent/external/status", {"clientId": "focused-client", "focused": True, "busy": False})

        call_result = {}

        def do_call():
            call_result["code"], call_result["body"] = self._request(
                "POST",
                "/api/agent/external/call",
                {
                    "tool": "draw_operations",
                    "args": {"operations": [{"id": "m1", "type": "molecule.add", "smiles": "[CH4:1]"}]},
                    "clientName": "Claude Code",
                    "timeoutMs": 3000,
                },
            )

        t = threading.Thread(target=do_call, daemon=True)
        t.start()

        ev = None
        while True:
            ev = _read_sse_event(r2)
            if ev and ev["event"] != "keepalive":
                break
        payload = json.loads(ev["data"])
        self.assertEqual(payload["type"], "tool_call")
        self.assertEqual(payload["tool"], "draw_operations")
        self.assertEqual(payload["clientName"], "Claude Code")
        req_id = payload["requestId"]

        code, ack = self._request(
            "POST",
            "/api/agent/external/result",
            {
                "requestId": req_id,
                "ok": True,
                "isError": False,
                "text": '{"created":["m1"]}',
                "data": {"created": ["m1"]},
                "changes": ["+ 分子 m1 ([CH4:1])"],
            },
        )
        self.assertEqual(code, 200)
        self.assertTrue(ack["ok"])

        t.join(timeout=3)
        self.assertEqual(call_result["code"], 200)
        self.assertEqual(call_result["body"]["text"], '{"created":["m1"]}')
        self.assertEqual(call_result["body"]["changes"], ["+ 分子 m1 ([CH4:1])"])

        r1.close()
        r2.close()
        c1.close()
        c2.close()

    def test_call_timeout_emits_cancel_and_returns_504(self):
        c1 = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c1.request("GET", "/api/agent/external/events?clientId=slow-client&sessionId=s1")
        r1 = c1.getresponse()
        _read_sse_event(r1)  # connected

        code, body = self._request(
            "POST",
            "/api/agent/external/call",
            {"tool": "read_canvas", "args": {}, "timeoutMs": 120},
        )
        self.assertEqual(code, 504)
        self.assertFalse(body["ok"])
        self.assertEqual(body["code"], "timeout")

        events = []
        for _ in range(4):
            ev = _read_sse_event(r1)
            if ev and ev["data"]:
                events.append(json.loads(ev["data"]))
            if len(events) >= 2:
                break
        self.assertEqual(events[0]["type"], "tool_call")
        self.assertEqual(events[1]["type"], "cancel")
        self.assertEqual(events[1]["requestId"], events[0]["requestId"])

        # Late result after timeout returns 404
        code, late = self._request("POST", "/api/agent/external/result", {"requestId": events[0]["requestId"], "ok": True})
        self.assertEqual(code, 404)
        self.assertEqual(late["code"], "unknown_request")
        r1.close()
        c1.close()


class ServerRouteIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.prev_bridge = bridge_module._bridge
        bridge_module._bridge = bridge_module.ExternalBridge(config_dir=self.temp.name)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), chemistry_server.Handler)
        self.server.daemon_threads = True
        bridge_module.bridge().register_port(self.server.server_port)
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        bridge_module.bridge().close()
        bridge_module._bridge = self.prev_bridge
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def test_inspect_structures_local_fallback_without_browser(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            payload = {
                "tool": "inspect_structures",
                "args": {
                    "structures": [
                        {"id": "eth", "smiles": "[CH3:1][CH2:2][OH:3]"},
                        {"id": "bad", "smiles": "C(C"},
                    ]
                },
            }
            conn.request(
                "POST",
                "/api/agent/external/call",
                body=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            body = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(body["ok"])
            self.assertFalse(body["isError"])
            results = body["data"]
            self.assertEqual(len(results), 2)
            self.assertTrue(results[0]["ok"])
            self.assertEqual(len(results[0]["atoms"]), 3)
            self.assertEqual(len(results[0]["bonds"]), 2)
            self.assertFalse(results[1]["ok"])
            self.assertEqual(results[1]["code"], "smiles_syntax")
        finally:
            conn.close()

    def test_inspect_structures_forwards_via_sse_when_connected(self):
        sse_conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        sse_conn.request("GET", "/api/agent/external/events?clientId=canvas-1&sessionId=doc-1")
        sse_resp = sse_conn.getresponse()
        _read_sse_event(sse_resp)

        forwarded = {}

        def sse_worker():
            try:
                ev = _read_sse_event(sse_resp)
                if ev and ev.get("data"):
                    msg = json.loads(ev["data"])
                    if msg.get("type") == "tool_call":
                        forwarded["msg"] = msg
                        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
                        c.request(
                            "POST",
                            "/api/agent/external/result",
                            body=json.dumps({
                                "requestId": msg["requestId"],
                                "ok": True,
                                "isError": False,
                                "text": '[{"id":"eth","ok":true,"via":"sse"}]',
                            }).encode("utf-8"),
                            headers={"Content-Type": "application/json"},
                        )
                        c.getresponse().read()
                        c.close()
            except OSError:
                pass

        worker = threading.Thread(target=sse_worker, daemon=True)
        worker.start()

        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request(
                "POST",
                "/api/agent/external/call",
                body=json.dumps({
                    "tool": "inspect_structures",
                    "args": {"structures": [{"id": "eth", "smiles": "CCO"}]},
                }).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            body = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(body["text"], '[{"id":"eth","ok":true,"via":"sse"}]')
            self.assertEqual(forwarded["msg"]["tool"], "inspect_structures")
        finally:
            conn.close()
            sse_resp.close()
            sse_conn.close()
            worker.join(timeout=2)


class MCPServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.prev_bridge = bridge_module._bridge
        bridge_module._bridge = bridge_module.ExternalBridge(config_dir=self.temp.name)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), chemistry_server.Handler)
        self.server.daemon_threads = True
        bridge_module.bridge().register_port(self.server.server_port)
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        # Keep discovery inside the fixture: a real MolStudio canvas listening on the
        # default ports must not be preferred over this test server.
        self.prev_default_ports = mcp_server.DEFAULT_PORTS
        mcp_server.DEFAULT_PORTS = ()
        self.env = {
            "MOLSTUDIO_AGENT_CONFIG_DIR": self.temp.name,
            "MOLSTUDIO_NO_AUTO_LAUNCH": "1",
        }

    def tearDown(self):
        mcp_server.DEFAULT_PORTS = self.prev_default_ports
        bridge_module.bridge().close()
        bridge_module._bridge = self.prev_bridge
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def test_stdio_newline_framing_initialize_list_and_inspect(self):
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "ping"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "molstudio_status", "arguments": {}}},
            {
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "molstudio_inspect_structures",
                    "arguments": {"structures": [{"id": "meoh", "smiles": "[CH3:1][OH:2]"}]},
                },
            },
            {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "molstudio_read_canvas", "arguments": {}}},
        ]
        stdin_bytes = b"".join((json.dumps(req) + "\n").encode("utf-8") for req in requests)
        out = io.BytesIO()
        mcp_server.serve_stdio(io.BytesIO(stdin_bytes), out, environ=self.env)

        lines = [json.loads(line) for line in out.getvalue().decode("utf-8").splitlines() if line.strip()]
        # notifications/initialized produces no response -> 6 responses
        self.assertEqual([r["id"] for r in lines], [1, 2, 3, 4, 5, 6])

        init_res = lines[0]["result"]
        self.assertEqual(init_res["protocolVersion"], "2024-11-05")
        self.assertEqual(init_res["serverInfo"]["name"], "molstudio")
        self.assertIn("reactionStep.create", init_res["instructions"])

        self.assertEqual(lines[1]["result"], {})

        tool_names = [t["name"] for t in lines[2]["result"]["tools"]]
        self.assertEqual(
            tool_names,
            [
                "molstudio_status",
                "molstudio_read_canvas",
                "molstudio_inspect_structures",
                "molstudio_draw_operations",
                "molstudio_plan_task",
                "molstudio_complete_phase",
                "molstudio_complete_layout",
                "molstudio_write_plan",
            ],
        )

        # status discovers server from active-bridge.json without MOLSTUDIO_URL/PORT
        status_json = json.loads(lines[3]["result"]["content"][0]["text"])
        self.assertEqual(status_json["port"], self.port)
        self.assertFalse(status_json["connected"])
        self.assertFalse(lines[3]["result"]["isError"])

        # inspect_structures succeeds locally even with no canvas connected
        inspect_res = lines[4]["result"]
        self.assertFalse(inspect_res["isError"])
        inspected = json.loads(inspect_res["content"][0]["text"])
        self.assertEqual(inspected[0]["id"], "meoh")
        self.assertTrue(inspected[0]["ok"])
        self.assertEqual(len(inspected[0]["atoms"]), 2)

        # read_canvas without active canvas returns isError=True + no_active_canvas
        read_res = lines[5]["result"]
        self.assertTrue(read_res["isError"])
        self.assertEqual(json.loads(read_res["content"][0]["text"])["code"], "no_active_canvas")

    def test_stdio_content_length_framing_and_draw_roundtrip(self):
        # Connect a mock canvas SSE client
        sse_conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        sse_conn.request("GET", "/api/agent/external/events?clientId=canvas-1&sessionId=doc-1")
        sse_resp = sse_conn.getresponse()
        _read_sse_event(sse_resp)

        received_calls = queue.Queue()

        def sse_worker():
            try:
                while True:
                    ev = _read_sse_event(sse_resp)
                    if ev is None:
                        break
                    if ev.get("data"):
                        msg = json.loads(ev["data"])
                        if msg.get("type") == "tool_call":
                            received_calls.put(msg)
                            c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
                            c.request(
                                "POST",
                                "/api/agent/external/result",
                                body=json.dumps({
                                    "requestId": msg["requestId"],
                                    "ok": True,
                                    "isError": False,
                                    "text": json.dumps({"ok": True, "created": ["m1"], "finishAccepted": True}),
                                }).encode("utf-8"),
                                headers={"Content-Type": "application/json"},
                            )
                            c.getresponse().read()
                            c.close()
                            break
            except OSError:
                pass

        worker_thread = threading.Thread(target=sse_worker, daemon=True)
        worker_thread.start()

        req = {
            "jsonrpc": "2.0",
            "id": 10,
            "method": "tools/call",
            "params": {
                "name": "molstudio_draw_operations",
                "arguments": {
                    "operations": [{"id": "m1", "type": "molecule.add", "smiles": "[CH4:1]"}],
                    "finish": True,
                    "clientName": "Codex",
                },
            },
        }
        payload = json.dumps(req).encode("utf-8")
        framed = f"Content-Length: {len(payload)}\r\n\r\n".encode("ascii") + payload
        out = io.BytesIO()
        mcp_server.serve_stdio(io.BytesIO(framed), out, environ=self.env)

        call = received_calls.get(timeout=2)
        self.assertEqual(call["tool"], "draw_operations")
        self.assertEqual(call["clientName"], "Codex")
        self.assertNotIn("clientName", call["args"])

        parsed_out, framing = mcp_server.read_stdio_message(io.BytesIO(out.getvalue()))
        self.assertEqual(framing, "content-length")
        self.assertEqual(parsed_out["id"], 10)
        self.assertFalse(parsed_out["result"]["isError"])
        self.assertIn("finishAccepted", parsed_out["result"]["content"][0]["text"])

        sse_resp.close()
        sse_conn.close()
        worker_thread.join(timeout=2)


class MCPLaunchDiscoveryTests(unittest.TestCase):
    def test_app_ships_bridge_requires_bridge_file(self):
        with tempfile.TemporaryDirectory() as temp:
            app = Path(temp) / "MolStudio.app"
            resources = app / "Contents" / "Resources"
            resources.mkdir(parents=True)
            self.assertFalse(mcp_server._app_ships_bridge(app))
            (resources / "agent_external_bridge.py").write_text("", encoding="utf-8")
            self.assertTrue(mcp_server._app_ships_bridge(app))

    def test_launch_falls_back_to_dev_server_when_app_has_no_canvas(self):
        env = {"MOLSTUDIO_LAUNCH_WAIT_SECONDS": "0.1"}
        with tempfile.TemporaryDirectory() as temp, \
                mock.patch.object(mcp_server, "sys", types.SimpleNamespace(platform="darwin")), \
                mock.patch.object(mcp_server, "_config_dir", return_value=Path(temp)), \
                mock.patch.object(mcp_server, "_find_molstudio_app", return_value="/Applications/MolStudio.app"), \
                mock.patch.object(mcp_server.shutil, "which", return_value="/usr/bin/open"), \
                mock.patch.object(mcp_server.subprocess, "Popen") as popen, \
                mock.patch.object(
                    mcp_server,
                    "_wait_for_canvas",
                    side_effect=[(None, None), ("http://127.0.0.1:48975", {"connected": True})],
                ) as wait, \
                mock.patch.object(
                    mcp_server, "_launch_dev_server", return_value="http://127.0.0.1:48975"
                ) as dev_server:
            url, status = mcp_server.launch_molstudio(environ=env)

        self.assertEqual(popen.call_args.args[0], ["open", "-a", "/Applications/MolStudio.app"])
        dev_server.assert_called_once()
        self.assertEqual(wait.call_count, 2)
        self.assertEqual(wait.call_args.kwargs.get("only_url"), "http://127.0.0.1:48975")
        self.assertEqual(url, "http://127.0.0.1:48975")
        self.assertTrue(status["connected"])

    def test_launch_keeps_packaged_app_canvas_without_dev_server(self):
        env = {"MOLSTUDIO_LAUNCH_WAIT_SECONDS": "0.1"}
        with tempfile.TemporaryDirectory() as temp, \
                mock.patch.object(mcp_server, "sys", types.SimpleNamespace(platform="darwin")), \
                mock.patch.object(mcp_server, "_config_dir", return_value=Path(temp)), \
                mock.patch.object(mcp_server, "_find_molstudio_app", return_value="/Applications/MolStudio.app"), \
                mock.patch.object(mcp_server.shutil, "which", return_value="/usr/bin/open"), \
                mock.patch.object(mcp_server.subprocess, "Popen"), \
                mock.patch.object(
                    mcp_server,
                    "_wait_for_canvas",
                    return_value=("http://127.0.0.1:8462", {"connected": True}),
                ) as wait, \
                mock.patch.object(mcp_server, "_launch_dev_server") as dev_server:
            url, status = mcp_server.launch_molstudio(environ=env)

        dev_server.assert_not_called()
        self.assertEqual(wait.call_count, 1)
        self.assertEqual(url, "http://127.0.0.1:8462")
        self.assertTrue(status["connected"])

    def test_find_molstudio_app_skips_open_ra_when_existing_apps_lack_bridge(self):
        with tempfile.TemporaryDirectory() as temp:
            fake_home = Path(temp) / "home"
            legacy_app = fake_home / "Applications" / "MolStudio.app"
            (legacy_app / "Contents" / "Resources").mkdir(parents=True)
            fake_repo = Path(temp) / "repo"
            fake_mcp = fake_repo / "fusion" / "mcp_server.py"
            fake_mcp.parent.mkdir(parents=True)
            fake_mcp.write_text("", encoding="utf-8")

            with mock.patch.object(mcp_server, "__file__", str(fake_mcp)), \
                    mock.patch.object(mcp_server.Path, "home", return_value=fake_home), \
                    mock.patch.object(mcp_server.subprocess, "run") as sub_run:
                # Guard against host /Applications/MolStudio.app by checking its bridge status
                host_app = Path("/Applications/MolStudio.app")
                if host_app.exists() and mcp_server._app_ships_bridge(host_app):
                    self.skipTest("/Applications/MolStudio.app already ships bridge on this machine")
                found = mcp_server._find_molstudio_app()

        self.assertIsNone(found)
        sub_run.assert_not_called()

    def test_probe_bridge_prefers_8462_over_48975_when_neither_focused(self):
        status_48975 = {
            "ok": True,
            "port": 48975,
            "connected": True,
            "clients": [{"clientId": "browser", "focused": False, "busy": False, "lastSeenAt": 2000}],
        }
        status_8462 = {
            "ok": True,
            "port": 8462,
            "connected": True,
            "clients": [{"clientId": "native-app", "focused": False, "busy": False, "lastSeenAt": 1000}],
        }

        def fake_http_json(method, url, payload=None, timeout=2.0):
            if ":48975/" in url:
                return 200, status_48975
            if ":8462/" in url:
                return 200, status_8462
            raise OSError("unexpected url")

        with mock.patch.object(
            mcp_server,
            "_candidate_urls",
            return_value=["http://127.0.0.1:48975", "http://127.0.0.1:8462"],
        ), mock.patch.object(mcp_server, "_http_json", side_effect=fake_http_json):
            best_url, best_status = mcp_server.probe_bridge(environ={})

        self.assertEqual(best_url, "http://127.0.0.1:8462")
        self.assertEqual(best_status["port"], 8462)


class MCPResponseContractTests(unittest.TestCase):
    """Exercise the public stdio facade without changing the live canvas."""

    def setUp(self):
        self.mcp = mcp_server.MolStudioMCPServer(environ={"MOLSTUDIO_NO_AUTO_LAUNCH": "1"})

    def test_isolated_packaged_python_can_load_sibling_module_from_another_cwd(self):
        request = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}) + "\n"
        with tempfile.TemporaryDirectory() as cwd:
            completed = subprocess.run([sys.executable, "-I", "-B", str(Path(mcp_server.__file__).resolve())],
                                       input=request, capture_output=True, text=True, cwd=cwd, timeout=5, check=True)
        response = json.loads(completed.stdout)
        self.assertEqual(len(response["result"]["tools"]), 8)

    def call_with_reply(self, tool, args, reply):
        with mock.patch.object(self.mcp, "_ensure_bridge", return_value=("http://127.0.0.1:12345", {"connected": True})), \
                mock.patch.object(mcp_server, "_http_json", return_value=(200, reply)) as http:
            result = self.mcp.call_tool(tool, args)
        return result, http

    def test_detail_is_advertised_only_on_data_tools(self):
        exposed = {tool["name"] for tool in mcp_server.TOOLS if "detail" in tool["inputSchema"]["properties"]}
        self.assertEqual(exposed, mcp_server.COMPACT_TOOLS)
        for tool in mcp_server.TOOLS:
            if tool["name"] in exposed:
                self.assertNotIn("detail", tool["inputSchema"].get("required", []))
        read = next(tool for tool in mcp_server.TOOLS if tool["name"] == "molstudio_read_canvas")
        self.assertIn("stepIds", read["inputSchema"]["properties"])

    def test_full_keeps_original_text_and_does_not_forward_transport_options(self):
        original = '{\n  "sessionId": "doc-1", "arrows": [{"id": "a", "geometry": {"bend": 1.2}}]\n}'
        result, http = self.call_with_reply("molstudio_read_canvas", {"detail": "full", "clientName": "Existing Harness"},
                                            {"ok": True, "text": original})
        self.assertEqual(result["content"][0]["text"], original)
        self.assertFalse(result["isError"])
        payload = http.call_args.kwargs["payload"]
        self.assertEqual(payload["args"], {})
        self.assertEqual(payload["clientName"], "Existing Harness")
        meta = result["_meta"]["molstudio"]
        self.assertEqual(meta["sourceTextBytes"], len(original.encode("utf-8")))
        self.assertEqual(meta["textBytes"], meta["sourceTextBytes"])
        self.assertGreaterEqual(meta["timingMs"]["discovery"], 0)
        self.assertGreaterEqual(meta["timingMs"]["bridge"], 0)

    def test_compact_defaults_to_json_without_whitespace_and_keeps_finish_rejection(self):
        data = {"sessionId": "doc-1", "finishAccepted": False, "finishRejected": "缺少电子流",
                "completionDiagnostic": {"code": "completion_check_failed", "stepId": "step-1"},
                "nextAction": "Repair only step-1", "created": [{"id": "mol", "atoms": [{"id": "atom-1", "ref": "3", "label": "O"}]}]}
        original = json.dumps(data, ensure_ascii=False, indent=2)
        result, http = self.call_with_reply("molstudio_draw_operations", {"operations": [{"id": "seal", "type": "step.seal"}]},
                                            {"ok": True, "text": original})
        value = json.loads(result["content"][0]["text"])
        self.assertFalse(value["finishAccepted"])
        self.assertEqual(value["finishRejected"], data["finishRejected"])
        self.assertEqual(value["completionDiagnostic"], data["completionDiagnostic"])
        self.assertEqual(value["created"][0]["atoms"][0]["id"], "atom-1")
        self.assertEqual(value["created"][0]["atoms"][0]["ref"], "3")
        self.assertEqual(http.call_args.kwargs["payload"]["args"], {"operations": [{"id": "seal", "type": "step.seal"}]})
        self.assertLess(result["_meta"]["molstudio"]["textBytes"], len(original.encode("utf-8")))

    def test_error_and_non_json_replies_stay_readable_and_unchanged(self):
        for reply in ({"ok": False, "isError": True, "text": '{"code":"reaction_step_electron_crowding","layoutFailures":[{"arrowId":"a","obstacle":"b"}]}'},
                      {"ok": True, "text": "Reply from an older canvas"}):
            with self.subTest(reply=reply):
                result, _ = self.call_with_reply("molstudio_read_canvas", {}, reply)
                self.assertEqual(result["content"][0]["text"], reply["text"])
                self.assertEqual(result["isError"], reply.get("ok") is False)

    def test_invalid_detail_and_scope_fail_without_calling_the_bridge(self):
        for args in ({"detail": "tiny"}, {"detail": None}, {"stepIds": []}, {"stepIds": ["s", "s"]},
                     {"stepIds": "s"}, {"stepIds": [["s"]]}, {"stepIds": [""]}):
            with self.subTest(args=args), mock.patch.object(self.mcp, "_ensure_bridge") as ensure:
                result = self.mcp.call_tool("molstudio_read_canvas", args)
                self.assertTrue(result["isError"])
                self.assertIn(json.loads(result["content"][0]["text"])["code"], ("invalid_detail", "invalid_step_ids"))
                ensure.assert_not_called()

    def test_unknown_step_does_not_silently_return_an_empty_or_global_canvas(self):
        result, http = self.call_with_reply("molstudio_read_canvas", {"detail": "full", "stepIds": ["missing"]},
                                            {"ok": True, "text": json.dumps({"reactionSteps": [], "atoms": []})})
        self.assertTrue(result["isError"])
        self.assertEqual(json.loads(result["content"][0]["text"])["code"], "unknown_step")
        self.assertNotIn("stepIds", http.call_args.kwargs["payload"]["args"])

    def test_scoped_read_rejects_non_json_instead_of_claiming_a_scoped_result(self):
        result, _ = self.call_with_reply("molstudio_read_canvas", {"stepIds": ["step-1"]},
                                         {"ok": True, "text": "Reply from an older canvas"})
        self.assertTrue(result["isError"])
        self.assertEqual(json.loads(result["content"][0]["text"])["code"], "invalid_canvas_response")


if __name__ == "__main__":
    unittest.main()
