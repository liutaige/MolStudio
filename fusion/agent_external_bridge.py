"""Local external-agent bridge for MolStudio (HTTP + SSE + active-bridge discovery).

Allows external MCP servers / coding harnesses on localhost to discover a running
MolStudio instance, inspect its canvas status, forward tool calls to the active
browser canvas via SSE, and receive execution results.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import queue
import secrets
import select
import socket
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlsplit

import agent_gateway

MAX_BODY = agent_gateway.MAX_BODY
DEFAULT_KEEPALIVE_SECONDS = 15.0
DEFAULT_WAIT_FOR_CLIENT_MS = 2000
DEFAULT_CALL_TIMEOUT_MS = 60000
MAX_CALL_TIMEOUT_MS = 600000


class BridgeError(Exception):
    def __init__(self, message, status=400, code="bridge_error"):
        super().__init__(message)
        self.status = status
        self.code = code


def _now_ms():
    return int(time.time() * 1000)


def _discovery_path(config_dir=None, environ=None):
    env = os.environ if environ is None else environ
    default_dir = Path.home() / "Library" / "Application Support" / "MolStudio"
    base_dir = Path(config_dir or env.get("MOLSTUDIO_AGENT_CONFIG_DIR") or default_dir)
    return base_dir / "active-bridge.json"


def _write_json_atomic(path: Path, payload: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".active-bridge-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(payload, output, ensure_ascii=False, indent=2)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class ExternalBridge:
    def __init__(self, config_dir=None, environ=None, keepalive_seconds=DEFAULT_KEEPALIVE_SECONDS):
        self.config_dir = config_dir
        self.environ = environ
        self.keepalive_seconds = float(keepalive_seconds)
        self.lock = threading.RLock()
        self.client_cond = threading.Condition(self.lock)
        self.port = None
        self.url = None
        self.pid = os.getpid()
        # client_id -> {"clientId", "sessionId", "focused", "busy", "lastSeenAt", "connectedAt", "queue"}
        self.sse_clients = {}
        # client_id -> {"sessionId", "focused", "busy", "lastSeenAt"}
        self.client_meta = {}
        # request_id -> {"event": threading.Event, "result": dict | None, "clientId": str}
        self.pending = {}
        self._closed = False

    def discovery_file(self):
        return _discovery_path(self.config_dir, self.environ)

    def register_port(self, port: int):
        with self.lock:
            self.port = int(port)
            self.url = f"http://127.0.0.1:{self.port}"
            self.pid = os.getpid()
            self._write_discovery_locked()

    def _ensure_port_from_handler(self, handler):
        server = getattr(handler, "server", None)
        server_port = getattr(server, "server_port", None)
        if self.port is None and server_port:
            self.port = int(server_port)
            self.url = f"http://127.0.0.1:{self.port}"

    def _pick_client_locked(self):
        if not self.sse_clients:
            return None
        return max(
            self.sse_clients.values(),
            key=lambda c: (
                1 if c.get("focused") else 0,
                0 if c.get("busy") else 1,
                c.get("lastSeenAt", 0),
                c.get("connectedAt", 0),
            ),
        )

    def _snapshot_clients_locked(self):
        clients = [
            {
                "clientId": c["clientId"],
                "sessionId": c.get("sessionId"),
                "focused": bool(c.get("focused")),
                "busy": bool(c.get("busy")),
                "lastSeenAt": c.get("lastSeenAt"),
            }
            for c in sorted(
                self.sse_clients.values(),
                key=lambda item: (
                    1 if item.get("focused") else 0,
                    item.get("lastSeenAt", 0),
                    item.get("connectedAt", 0),
                ),
                reverse=True,
            )
        ]
        active = self._pick_client_locked()
        return clients, active

    def _write_discovery_locked(self):
        _, active = self._snapshot_clients_locked()
        payload = {
            "port": self.port,
            "pid": self.pid,
            "url": self.url,
            "activeClientId": active["clientId"] if active else None,
            "sessionId": active.get("sessionId") if active else None,
            "connectedClients": len(self.sse_clients),
            "updatedAt": _now_ms(),
        }
        try:
            _write_json_atomic(self.discovery_file(), payload)
        except OSError:
            pass

    def status(self):
        with self.lock:
            clients, active = self._snapshot_clients_locked()
            return {
                "ok": True,
                "port": self.port,
                "pid": self.pid,
                "url": self.url,
                "connected": len(clients) > 0,
                "activeClientId": active["clientId"] if active else None,
                "sessionId": active.get("sessionId") if active else None,
                "clients": clients,
            }

    def update_client_status(self, payload: dict):
        client_id = payload.get("clientId")
        if not isinstance(client_id, str) or not client_id.strip() or len(client_id) > 160:
            raise BridgeError("clientId 无效", 400, "bad_request")
        client_id = client_id.strip()
        session_id = payload.get("sessionId")
        if session_id is not None and not isinstance(session_id, str):
            raise BridgeError("sessionId 必须是字符串", 400, "bad_request")
        focused = payload.get("focused")
        busy = payload.get("busy")
        now = _now_ms()
        with self.lock:
            meta = self.client_meta.setdefault(client_id, {
                "sessionId": None,
                "focused": False,
                "busy": False,
                "lastSeenAt": now,
            })
            if "sessionId" in payload:
                meta["sessionId"] = session_id
            if isinstance(focused, bool):
                meta["focused"] = focused
            if isinstance(busy, bool):
                meta["busy"] = busy
            meta["lastSeenAt"] = now

            client = self.sse_clients.get(client_id)
            if client is not None:
                if "sessionId" in payload:
                    client["sessionId"] = session_id
                if isinstance(focused, bool):
                    client["focused"] = focused
                if isinstance(busy, bool):
                    client["busy"] = busy
                client["lastSeenAt"] = now
            self._write_discovery_locked()
        return {"ok": True}

    def register_sse_client(self, client_id: str | None, session_id: str | None):
        cid = (client_id or "").strip() or f"client-{secrets.token_hex(6)}"
        if len(cid) > 160:
            cid = cid[:160]
        sid = session_id.strip() if isinstance(session_id, str) and session_id.strip() else None
        now = _now_ms()
        event_queue = queue.Queue()
        with self.lock:
            old = self.sse_clients.get(cid)
            if old is not None:
                try:
                    old["queue"].put_nowait(None)
                except Exception:
                    pass
            meta = self.client_meta.get(cid, {})
            entry = {
                "clientId": cid,
                "sessionId": sid if sid is not None else meta.get("sessionId"),
                "focused": bool(meta.get("focused", False)),
                "busy": bool(meta.get("busy", False)),
                "lastSeenAt": now,
                "connectedAt": now,
                "queue": event_queue,
            }
            self.sse_clients[cid] = entry
            self._write_discovery_locked()
            self.client_cond.notify_all()
        return entry

    def unregister_sse_client(self, entry: dict):
        cid = entry["clientId"]
        with self.lock:
            current = self.sse_clients.get(cid)
            if current is entry:
                self.sse_clients.pop(cid, None)
                self._write_discovery_locked()

    def call_tool(self, payload: dict, local_inspect=None):
        tool = payload.get("tool")
        if not isinstance(tool, str) or not tool.strip() or len(tool) > 120:
            raise BridgeError("tool 名称无效", 400, "bad_request")
        tool = tool.strip()
        args = payload.get("args")
        if args is None:
            args = {}
        if not isinstance(args, dict):
            raise BridgeError("args 必须是对象", 400, "bad_request")
        client_name = payload.get("clientName")
        if not isinstance(client_name, str) or not client_name.strip():
            client_name = "MCP"
        else:
            client_name = client_name.strip()[:100]

        timeout_ms = payload.get("timeoutMs", DEFAULT_CALL_TIMEOUT_MS)
        if not isinstance(timeout_ms, (int, float)) or isinstance(timeout_ms, bool) or timeout_ms <= 0:
            raise BridgeError("timeoutMs 无效", 400, "bad_request")
        timeout_ms = min(float(timeout_ms), float(MAX_CALL_TIMEOUT_MS))

        wait_ms = payload.get("waitForClientMs", DEFAULT_WAIT_FOR_CLIENT_MS)
        if not isinstance(wait_ms, (int, float)) or isinstance(wait_ms, bool) or wait_ms < 0:
            raise BridgeError("waitForClientMs 无效", 400, "bad_request")
        wait_sec = min(float(wait_ms), 30000.0) / 1000.0

        # If no browser canvas is connected and caller asks for inspect_structures,
        # evaluate locally via RDKit so preflight works before opening a canvas.
        with self.lock:
            has_client = bool(self.sse_clients)
        if tool == "inspect_structures" and not has_client and local_inspect is not None:
            return local_inspect(args)

        with self.lock:
            if not self.sse_clients and wait_sec > 0:
                deadline = time.monotonic() + wait_sec
                while not self.sse_clients and not self._closed:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    self.client_cond.wait(timeout=remaining)
            client = self._pick_client_locked()
            if client is None:
                if tool == "inspect_structures" and local_inspect is not None:
                    return local_inspect(args)
                raise BridgeError("当前没有已打开的 MolStudio 画布窗口", 409, "no_active_canvas")
            request_id = f"ext-{secrets.token_hex(12)}"
            done_event = threading.Event()
            pending_entry = {
                "event": done_event,
                "result": None,
                "clientId": client["clientId"],
            }
            self.pending[request_id] = pending_entry
            client["queue"].put({
                "type": "tool_call",
                "requestId": request_id,
                "tool": tool,
                "args": args,
                "clientName": client_name,
            })

        signaled = done_event.wait(timeout=timeout_ms / 1000.0)
        if not signaled:
            with self.lock:
                self.pending.pop(request_id, None)
                active_client = self.sse_clients.get(client["clientId"])
                if active_client is not None:
                    active_client["queue"].put({"type": "cancel", "requestId": request_id})
            raise BridgeError(f"工具 {tool} 执行超时（{int(timeout_ms)}ms）", 504, "timeout")

        with self.lock:
            result = pending_entry["result"]
        if not isinstance(result, dict):
            return {"ok": False, "isError": True, "error": "外部调用未收到有效结果"}
        return result

    def submit_result(self, payload: dict):
        request_id = payload.get("requestId")
        if not isinstance(request_id, str) or not request_id.strip():
            raise BridgeError("缺少 requestId", 400, "bad_request")
        request_id = request_id.strip()
        with self.lock:
            entry = self.pending.pop(request_id, None)
            if entry is None:
                raise BridgeError("未找到对应的外部请求或已超时", 404, "unknown_request")
            result = {
                "ok": bool(payload.get("ok", True)),
                "isError": bool(payload.get("isError", False)),
            }
            for key in ("text", "data", "changes", "error", "diagnostic"):
                if key in payload and payload[key] is not None:
                    result[key] = payload[key]
            entry["result"] = result
            entry["event"].set()
        return {"ok": True}

    def close(self):
        with self.lock:
            self._closed = True
            for entry in list(self.sse_clients.values()):
                try:
                    entry["queue"].put_nowait(None)
                except Exception:
                    pass
            self.sse_clients.clear()
            self.client_cond.notify_all()


_bridge = None
_bridge_lock = threading.Lock()


def bridge():
    global _bridge
    with _bridge_lock:
        if _bridge is None:
            _bridge = ExternalBridge()
        return _bridge


def _send_json(handler, code: int, value: dict):
    body = json.dumps(value, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    if code >= 400:
        handler.send_header("Connection", "close")
        handler.close_connection = True
    handler.end_headers()
    handler.wfile.write(body)


def _peer_disconnected(handler) -> bool:
    sock = getattr(handler, "connection", None)
    if sock is None:
        return False
    try:
        readable, _, _ = select.select([sock], [], [], 0)
        if readable:
            flags = socket.MSG_PEEK | getattr(socket, "MSG_DONTWAIT", 0)
            data = sock.recv(1, flags)
            if data == b"":
                return True
    except (OSError, ValueError, TypeError):
        return False
    return False


def handle_get(handler, service: ExternalBridge | None = None):
    parsed = urlsplit(handler.path)
    route = parsed.path
    if route not in ("/api/agent/external/status", "/api/agent/external/events"):
        return False
    svc = service or bridge()
    try:
        agent_gateway.AgentGateway.check_origin(handler)
        svc._ensure_port_from_handler(handler)
        if route == "/api/agent/external/status":
            _send_json(handler, 200, svc.status())
            return True

        # SSE stream: /api/agent/external/events?clientId=...&sessionId=...
        params = parse_qs(parsed.query)
        client_id = (params.get("clientId") or [None])[0]
        session_id = (params.get("sessionId") or [None])[0]
        entry = svc.register_sse_client(client_id, session_id)
        try:
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
            handler.send_header("Cache-Control", "no-store")
            handler.send_header("X-Accel-Buffering", "no")
            handler.send_header("Connection", "close")
            handler.end_headers()
            handler.close_connection = True

            connected_payload = json.dumps(
                {"clientId": entry["clientId"], "sessionId": entry.get("sessionId")},
                ensure_ascii=False,
            )
            handler.wfile.write(f"event: connected\ndata: {connected_payload}\n\n".encode("utf-8"))
            handler.wfile.flush()

            next_keepalive = time.monotonic() + svc.keepalive_seconds
            while True:
                now = time.monotonic()
                wait_for = min(1.0, max(0.01, next_keepalive - now))
                try:
                    item = entry["queue"].get(timeout=wait_for)
                except queue.Empty:
                    if _peer_disconnected(handler):
                        break
                    if time.monotonic() >= next_keepalive:
                        handler.wfile.write(b": keepalive\n\n")
                        handler.wfile.flush()
                        next_keepalive = time.monotonic() + svc.keepalive_seconds
                    continue
                if item is None:
                    break
                data_line = json.dumps(item, ensure_ascii=False)
                handler.wfile.write(f"data: {data_line}\n\n".encode("utf-8"))
                handler.wfile.flush()
                next_keepalive = time.monotonic() + svc.keepalive_seconds
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            svc.unregister_sse_client(entry)
    except agent_gateway.GatewayError as error:
        _send_json(handler, error.status, {"ok": False, "error": str(error), "code": error.code})
    return True


def handle_post(handler, service: ExternalBridge | None = None, local_inspect=None):
    route = urlsplit(handler.path).path
    if route not in ("/api/agent/external/status", "/api/agent/external/call", "/api/agent/external/result"):
        return False
    svc = service or bridge()
    try:
        agent_gateway.AgentGateway.check_origin(handler)
        svc._ensure_port_from_handler(handler)
        payload = agent_gateway.AgentGateway.read_json(handler, MAX_BODY)
        if route == "/api/agent/external/status":
            _send_json(handler, 200, svc.update_client_status(payload))
        elif route == "/api/agent/external/call":
            _send_json(handler, 200, svc.call_tool(payload, local_inspect=local_inspect))
        else:
            _send_json(handler, 200, svc.submit_result(payload))
    except agent_gateway.GatewayError as error:
        _send_json(handler, error.status, {"ok": False, "error": str(error), "code": error.code})
    except BridgeError as error:
        _send_json(handler, error.status, {"ok": False, "error": str(error), "code": error.code})
    except (OSError, ValueError):
        _send_json(handler, 500, {"ok": False, "error": "外部桥接处理失败", "code": "bridge_failed"})
    return True
