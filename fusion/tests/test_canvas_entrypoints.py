"""Current canvas entrypoints and resources; retired UIs must not be served."""
import json
from pathlib import Path
import sys
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

_DIRECT_OPENER = build_opener(ProxyHandler({}))


def _open_direct(url_or_req, timeout=5):
    return _DIRECT_OPENER.open(url_or_req, timeout=timeout)


class CanvasEntrypoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = "http://127.0.0.1:" + str(cls.service.server_port)
        cls.thread = threading.Thread(target=cls.service.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.service.shutdown()
        cls.service.server_close()
        cls.thread.join(timeout=5)

    def test_all_public_entrypoints_open_current_canvas(self):
        expected = Path(server.FUSION_DIR, "canvas.html").read_bytes()
        for path in ("/", "/index.html", "/canvas.html"):
            with self.subTest(path=path), _open_direct(self.base + path, timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), expected)

    def test_current_runtime_dependencies_are_available(self):
        for path in ("/ketcher/index.html", "/vendor/ngl.js", "/threed.html",
                     "/workbench/main.js", "/workbench/agent-bridge.js",
                     "/agent/app.js", "/agent/panel.js", "/agent/dist/agent-runtime.js"):
            with self.subTest(path=path), _open_direct(self.base + path, timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertGreater(len(response.read()), 0)

    def test_retired_ui_and_renderers_are_not_available(self):
        for path in ("/doc.html", "/cwc_test.html", "/main.js", "/arrow_probe.js",
                     "/vendor/chemdoodleweb.js", "/vendor/chemdoodleweb-uis.js",
                     "/vendor/konva.min.js"):
            with self.subTest(path=path), self.assertRaises(HTTPError) as raised:
                _open_direct(self.base + path, timeout=5)
            self.assertEqual(raised.exception.code, 404)

    def test_html_responses_declare_same_origin_framing_only(self):
        with _open_direct(self.base + "/canvas.html", timeout=5) as response:
            self.assertEqual(response.headers.get("X-Frame-Options"), "SAMEORIGIN")
            self.assertIn("frame-ancestors 'self'", response.headers.get("Content-Security-Policy", ""))


class ServerPostGuards(unittest.TestCase):
    """非 agent 化学路由与 agent 网关共用同一套来源与体积守卫（P3）。"""

    @classmethod
    def setUpClass(cls):
        cls.service = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = "http://127.0.0.1:" + str(cls.service.server_port)
        cls.thread = threading.Thread(target=cls.service.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.service.shutdown()
        cls.service.server_close()
        cls.thread.join(timeout=5)

    def post(self, path, body, origin=None):
        headers = {"Content-Type": "application/json"}
        if origin is not None:
            headers["Origin"] = origin
        request = Request(self.base + path, data=body, headers=headers, method="POST")
        try:
            with _open_direct(request, timeout=15) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except HTTPError as err:
            return err.code, json.loads(err.read().decode("utf-8"))

    def test_missing_origin_is_allowed_for_native_clients(self):
        status, payload = self.post("/api/props", json.dumps({"data": "CCO"}).encode("utf-8"))
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])

    def test_same_origin_browser_requests_are_allowed(self):
        status, payload = self.post("/api/props", json.dumps({"data": "CCO"}).encode("utf-8"),
                                    origin=self.base)
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])

    def test_cross_origin_browser_requests_are_rejected(self):
        status, payload = self.post("/api/props", json.dumps({"data": "CCO"}).encode("utf-8"),
                                    origin="http://evil.example")
        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "invalid_origin")

    def test_oversized_bodies_are_rejected_before_read(self):
        import socket
        import time
        host, port = "127.0.0.1", self.service.server_port
        body = b"C" * (4 * 1024 * 1024 + 16)
        request = (f"POST /api/props HTTP/1.1\r\nHost: {host}:{port}\r\n"
                   f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n"
                   f"Origin: {self.base}\r\nConnection: close\r\n\r\n").encode("ascii")
        with socket.create_connection((host, port), timeout=10) as sock:
            # 只发送请求头和一小块请求体：服务端必须在读完 4MB 之前就回 413。
            sock.sendall(request + body[:1024])
            deadline = time.monotonic() + 10
            data = b""
            while b"request_too_large" not in data and time.monotonic() < deadline:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                data += chunk
        self.assertTrue(data.startswith(b"HTTP/1.1 413"),
                        data.split(b"\r\n", 1)[0][:60])
        self.assertIn(b"request_too_large", data)

    def test_invalid_content_length_is_a_readable_400(self):
        request = Request(self.base + "/api/props", data=b"{}",
                          headers={"Content-Type": "application/json",
                                   "Content-Length": "abc"}, method="POST")
        with self.assertRaises(HTTPError) as raised:
            _open_direct(request, timeout=15)
        self.assertEqual(raised.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
