"""Current canvas entrypoints and resources; retired UIs must not be served."""
from pathlib import Path
import sys
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


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
            with self.subTest(path=path), urlopen(self.base + path, timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), expected)

    def test_current_runtime_dependencies_are_available(self):
        for path in ("/ketcher/index.html", "/vendor/ngl.js", "/threed.html",
                     "/workbench/main.js", "/workbench/agent-bridge.js",
                     "/agent/app.js", "/agent/panel.js", "/agent/dist/agent-runtime.js"):
            with self.subTest(path=path), urlopen(self.base + path, timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertGreater(len(response.read()), 0)

    def test_retired_ui_and_renderers_are_not_available(self):
        for path in ("/doc.html", "/cwc_test.html", "/main.js", "/arrow_probe.js",
                     "/vendor/chemdoodleweb.js", "/vendor/chemdoodleweb-uis.js",
                     "/vendor/konva.min.js"):
            with self.subTest(path=path), self.assertRaises(HTTPError) as raised:
                urlopen(self.base + path, timeout=5)
            self.assertEqual(raised.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
