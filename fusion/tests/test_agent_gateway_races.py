"""Gateway cancellation/auth regressions using local HTTP and dummy keys only.

Run: python3 -m unittest discover -s fusion/tests -p test_agent_gateway_races.py -v
"""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import agent_gateway as gateway_module


class LocalHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_GET(self):
        gateway_module.handle_get(self)

    def do_POST(self):
        gateway_module.handle_post(self)


def provider_handler(state):
    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            state["headers"].set()
            if state["block_read"]:
                state["release_read"].wait(5)
            try:
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                # Escaping '/' is legal JSON and used by some JSON encoders.
                body = json.dumps({"error": {"message": "Rejected " + state["key"]}}).replace("/", r"\/").encode()
                self.send_response(401)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except OSError:
                pass

    return Provider


def start_server(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=lambda: server.serve_forever(poll_interval=.02), daemon=True).start()
    return server


class AgentGatewayRaceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.state = {"key": "sk/escaped-fixture-secret", "headers": threading.Event(), "release_read": threading.Event(), "block_read": False}
        self.provider = start_server(provider_handler(self.state))
        self.gateway = gateway_module.AgentGateway(self.directory.name, {
            "MOLSTUDIO_AGENT_BASE_URL": f"http://127.0.0.1:{self.provider.server_port}/v1",
            "MOLSTUDIO_AGENT_MODEL": "test-fixture", "MOLSTUDIO_AGENT_API_KEY": self.state["key"],
        })
        self.previous = gateway_module._gateway
        gateway_module._gateway = self.gateway
        self.local = start_server(LocalHandler)

    def tearDown(self):
        self.state["release_read"].set()
        for request_id in list(self.gateway.active):
            self.gateway.cancel(request_id)
        for server in (self.local, self.provider):
            server.shutdown()
            server.server_close()
        gateway_module._gateway = self.previous
        self.directory.cleanup()

    def connection(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.local.server_port, timeout=3)
        self.addCleanup(connection.close)
        return connection

    def handler(self, request_id):
        return SimpleNamespace(headers={"Host": "127.0.0.1:12345", "X-MolStudio-Agent-Token": self.gateway.token, "X-MolStudio-Agent-Request": request_id}, server=SimpleNamespace(server_port=12345))

    def proxy_worker(self, request_id, content="fixture"):
        errors = []

        def proxy():
            try:
                self.gateway.proxy(self.handler(request_id), {"stream": True, "messages": [{"role": "user", "content": content}]})
            except Exception as error:
                errors.append(getattr(error, "code", type(error).__name__))

        worker = threading.Thread(target=proxy, daemon=True)
        worker.start()
        return worker, errors

    def test_json_escaped_provider_key_is_redacted_after_decoding(self):
        connection = self.connection()
        connection.request("POST", "/api/agent/model", json.dumps({"stream": True, "messages": [{"role": "user", "content": "fixture"}]}), {
            "X-MolStudio-Agent-Token": self.gateway.token,
            "X-MolStudio-Agent-Request": "escaped-key", "Content-Type": "application/json",
        })
        response = connection.getresponse()
        body = response.read().decode()
        self.assertEqual(response.status, 502)
        self.assertNotIn(self.state["key"], body)
        self.assertIn("redacted", body)

    def test_auth_rejection_does_not_poison_next_request_on_same_client(self):
        connection = self.connection()
        connection.request("POST", "/api/agent/config", json.dumps({"model": "must-not-be-saved"}), {"Content-Type": "application/json", "X-MolStudio-Agent-Token": "wrong"})
        rejected = connection.getresponse()
        self.assertEqual(rejected.status, 403)
        self.assertEqual(rejected.getheader("Connection"), "close")
        rejected.read()
        # HTTPConnection must be able to reconnect cleanly; unread POST bytes
        # must not become the next request's method/header data.
        connection.request("GET", "/api/agent/config")
        accepted = connection.getresponse()
        self.assertEqual(accepted.status, 200)
        self.assertEqual(json.loads(accepted.read())["model"], "test-fixture")

    def test_cancel_while_connecting_prevents_any_upstream_post(self):
        connecting, release = threading.Event(), threading.Event()
        original = http.client.HTTPConnection

        class SlowConnect(original):
            def connect(self):
                connecting.set()
                release.wait(3)
                super().connect()

        with patch.object(gateway_module.http.client, "HTTPConnection", SlowConnect):
            worker, errors = self.proxy_worker("stop-before-connect")
            try:
                self.assertTrue(connecting.wait(2), "upstream connect did not start")
                self.gateway.cancel("stop-before-connect")
            finally:
                release.set()
                worker.join(4)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, ["cancelled"])
        self.assertFalse(self.state["headers"].wait(.1), "provider received HTTP headers after cancellation")

    def test_cancel_can_interrupt_sendall_under_upstream_backpressure(self):
        original = http.client.HTTPConnection
        cancelled = threading.Event()
        self.state["block_read"] = True

        class TinySendBuffer(original):
            def connect(self):
                super().connect()
                self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1024)

        def cancel():
            self.gateway.cancel("stop-during-write")
            cancelled.set()

        with patch.object(gateway_module.http.client, "HTTPConnection", TinySendBuffer):
            worker, errors = self.proxy_worker("stop-during-write", "x" * (3 * 1024 * 1024))
            canceller = None
            try:
                self.assertTrue(self.state["headers"].wait(3), "provider did not receive headers")
                time.sleep(.05)  # The 3 MiB body exceeds the deliberately small send buffer.
                canceller = threading.Thread(target=cancel, daemon=True)
                canceller.start()
                acknowledged_before_read = cancelled.wait(.5)
            finally:
                self.state["release_read"].set()
                worker.join(5)
                if canceller:
                    canceller.join(5)
        self.assertTrue(acknowledged_before_read, "cancel waited for upstream to consume the blocked request body")
        self.assertFalse(worker.is_alive())
        self.assertFalse(canceller.is_alive())
        self.assertIn(errors, [["cancelled"], ["provider_unavailable"]])


if __name__ == "__main__":
    unittest.main()
