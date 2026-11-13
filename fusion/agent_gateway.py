"""Local model transport and configuration for the MolStudio canvas agent.

The browser runs the agent loop. Provider credentials stay here; the transport
forwards one configured chat-completions endpoint without buffering its SSE.
"""
from __future__ import annotations

import hmac
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

MAX_BODY = 4 * 1024 * 1024
MAX_MODEL_BODY = 32 * 1024 * 1024
REQUEST_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
KEYCHAIN_SERVICE = "local.molstudio.agent-api-key"
DEFAULT_GENERATION = {"profile": "provider-default", "effort": "default", "maxOutputTokens": None}
GENERATION_FIELDS = {"thinking", "reasoning", "reasoning_effort", "thinking_budget", "thinkingBudget",
                     "max_tokens", "max_completion_tokens", "max_output_tokens"}
OPENAI_MODEL_EFFORTS = {
    "gpt-5.2": ["none", "low", "medium", "high", "xhigh"],
    "gpt-5.1": ["none", "low", "medium", "high"], "gpt-5-pro": ["high"],
    **{name: ["low", "medium", "high"] for name in ("gpt-5", "gpt-5-mini", "gpt-5-nano", "o1", "o3", "o3-mini", "o4-mini")},
}


def _openai_efforts(model):
    """Conservative Chat Completions capability table, never infer a future model.

    https://developers.openai.com/api/docs/guides/reasoning?api-mode=chat
    Model snapshots inherit only a recognised model's documented values.
    """
    model = re.sub(r"-\d{4}-\d{2}-\d{2}$", "", model)
    return list(OPENAI_MODEL_EFFORTS.get(model, []))


def _generation(value, model):
    if not isinstance(value, dict) or set(value) - set(DEFAULT_GENERATION):
        raise GatewayError("生成设置必须只包含参数格式、思考强度与总输出上限", code="invalid_generation")
    result = {**DEFAULT_GENERATION, **value}
    profile, effort, cap = result["profile"], result["effort"], result["maxOutputTokens"]
    if not isinstance(profile, str) or profile not in ("provider-default", "deepseek", "openai"):
        raise GatewayError("未知的模型参数格式", code="invalid_generation")
    allowed = ["default"] + (["none", "low", "high", "max"] if profile == "deepseek" else
                              _openai_efforts(model) if profile == "openai" else [])
    if not isinstance(effort, str) or effort not in allowed:
        raise GatewayError("当前模型参数格式不支持此思考强度；请选择服务默认或已核实的档位", code="invalid_generation")
    ceiling = 393216 if profile == "deepseek" else 2_000_000
    if cap is not None and (type(cap) is not int or not 1 <= cap <= ceiling):
        raise GatewayError(f"总输出上限须为 1 到 {ceiling} 的整数，或留空使用服务默认", code="invalid_generation")
    return result


def _generation_capabilities(config):
    model = config.get("model", "")
    host = urlsplit(config.get("baseUrl", "")).hostname
    detected = "provider-default"
    if host == "api.deepseek.com" and model in ("deepseek-flash", "deepseek-v4-pro"):
        detected = "deepseek"
    elif host == "api.openai.com" and _openai_efforts(model):
        detected = "openai"
    return {"detectedProfile": detected, "openaiModels": OPENAI_MODEL_EFFORTS, "profiles": {
        "provider-default": {"efforts": ["default"], "maxOutputTokens": 2_000_000, "capField": "max_tokens"},
        "deepseek": {"efforts": ["default", "none", "low", "high", "max"], "maxOutputTokens": 393216, "capField": "max_tokens"},
        "openai": {"efforts": ["default", *_openai_efforts(model)], "maxOutputTokens": 2_000_000, "capField": "max_completion_tokens"},
    }}


def _generation_payload(config):
    selected = _generation(config.get("generation", DEFAULT_GENERATION), config.get("model", ""))
    profile, effort, cap = selected["profile"], selected["effort"], selected["maxOutputTokens"]
    fields = {}
    if effort != "default":
        fields["reasoning_effort"] = effort
        if profile == "deepseek":
            # Official DeepSeek Chat Completions schema. Set both explicitly:
            # compatible local proxies may otherwise inject their own mode.
            fields["thinking"] = {"type": "disabled" if effort == "none" else "enabled"}
    if cap is not None:
        fields["max_completion_tokens" if profile == "openai" else "max_tokens"] = cap
    return selected, fields


class GatewayError(Exception):
    def __init__(self, message, status=400, code="agent_error"):
        super().__init__(message)
        self.status, self.code = status, code


def _base_url(value):
    value = str(value).strip().rstrip("/")
    if len(value) > 1000 or "\\" in value:
        raise GatewayError("模型地址无效")
    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError:
        raise GatewayError("模型地址无效") from None
    if (not parsed.hostname or parsed.username or parsed.password or
            parsed.query or parsed.fragment or parsed.scheme not in ("https", "http")):
        raise GatewayError("请使用不含凭据或查询参数的模型 API 地址")
    if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise GatewayError("远程模型地址需要 HTTPS；本机反代可以使用 HTTP")
    if any(segment in (".", "..") for segment in parsed.path.split("/")):
        raise GatewayError("模型地址路径无效")
    return value


def _keychain(action, key=None):
    if sys.platform != "darwin":
        return None
    args = ["/usr/bin/security", action, "-s", KEYCHAIN_SERVICE, "-a", "MolStudio"]
    if action == "find-generic-password":
        args.append("-w")
    else:
        args.extend(["-U", "-w", key])
    try:
        result = subprocess.run(args, capture_output=True, timeout=5, check=False)
        if result.returncode == 0:
            return result.stdout.decode().strip() if action.startswith("find") else True
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


class AgentGateway:
    def __init__(self, config_dir=None, environ=None):
        env = os.environ if environ is None else environ
        self.lock = threading.RLock()
        self.token = secrets.token_urlsafe(32)
        default_dir = Path.home() / "Library" / "Application Support" / "MolStudio"
        self.config_file = Path(config_dir or env.get("MOLSTUDIO_AGENT_CONFIG_DIR") or default_dir) / "agent.json"
        self.config = {"provider": "openai-compatible", "model": "", "baseUrl": "", "generation": dict(DEFAULT_GENERATION)}
        try:
            saved = json.loads(self.config_file.read_text())
            restored = {**self.config, **self._validated_config(saved)}
            restored["generation"] = _generation(restored["generation"], restored["model"])
            self.config = restored
        except (OSError, ValueError, GatewayError, TypeError):
            pass
        overrides = env
        if env.get("MOLSTUDIO_AGENT_BASE_URL"):
            try:
                self.config["baseUrl"] = _base_url(env["MOLSTUDIO_AGENT_BASE_URL"])
            except GatewayError:
                # Keep the saved endpoint, model, and credentials together.
                overrides = {}
        if overrides.get("MOLSTUDIO_AGENT_MODEL"):
            self.config["model"] = overrides["MOLSTUDIO_AGENT_MODEL"][:200]
        if overrides.get("MOLSTUDIO_AGENT_GENERATION_JSON"):
            try:
                self.config["generation"] = _generation(json.loads(overrides["MOLSTUDIO_AGENT_GENERATION_JSON"]), self.config["model"])
            except (ValueError, TypeError):
                raise GatewayError("MOLSTUDIO_AGENT_GENERATION_JSON 不是有效的生成设置", code="invalid_generation") from None
        else:
            # An endpoint/model override must not inherit incompatible saved
            # settings. It never changes the saved file or external services.
            try:
                self.config["generation"] = _generation(self.config["generation"], self.config["model"])
            except GatewayError:
                self.config["generation"] = dict(DEFAULT_GENERATION)
        self.api_key = overrides.get("MOLSTUDIO_AGENT_API_KEY", "")
        if not self.api_key and overrides.get("MOLSTUDIO_AGENT_KEY_FILE"):
            try:
                self.api_key = Path(overrides["MOLSTUDIO_AGENT_KEY_FILE"]).read_text().strip()
            except (OSError, UnicodeError):
                pass
        self.api_key = self.api_key or (_keychain("find-generic-password") if environ is None else None) or ""
        self.active = {}
        self.cancelled = {}

    @staticmethod
    def _validated_config(value):
        if not isinstance(value, dict):
            raise GatewayError("设置必须是对象")
        result = {}
        if "provider" in value:
            if value["provider"] != "openai-compatible":
                raise GatewayError("当前支持兼容 Chat Completions 的模型服务")
            result["provider"] = "openai-compatible"
        if "baseUrl" in value:
            result["baseUrl"] = _base_url(value["baseUrl"]) if value["baseUrl"] else ""
        if "model" in value:
            model = str(value["model"]).strip()
            if len(model) > 200 or any(ord(c) < 32 for c in model):
                raise GatewayError("模型名称无效")
            result["model"] = model
        if "generation" in value:
            # Validate against the full merged config before making any writes.
            result["generation"] = value["generation"]
        return result

    def public_config(self):
        with self.lock:
            requested, effective = _generation_payload(self.config)
            return {**self.config, "configured": bool(self.config["baseUrl"] and self.config["model"] and self.api_key),
                    "sessionToken": self.token, "generationCapabilities": _generation_capabilities(self.config),
                    "generationEffective": {"requested": requested, "fields": effective,
                                            "forwardedToConfiguredEndpoint": False, "downstreamConfirmed": False}}

    def save_config(self, value):
        changes = self._validated_config(value)
        key = value.get("apiKey", "")
        if not isinstance(key, str) or len(key) > 8192 or "\n" in key or "\r" in key:
            raise GatewayError("API Key 无效")
        with self.lock:
            if self.active:
                raise GatewayError("请先停止当前任务，再修改模型设置", 409, "run_active")
            config = {**self.config, **changes}
            config["generation"] = _generation(config["generation"], config["model"])
            self.config_file.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(prefix=".agent-", dir=self.config_file.parent)
            try:
                with os.fdopen(descriptor, "w") as output:
                    json.dump(config, output, ensure_ascii=False, indent=2)
                os.replace(temporary, self.config_file)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            self.config = config
            if key.strip():
                self.api_key = key.strip()
                persisted = _keychain("add-generic-password", self.api_key)
            else:
                persisted = None
            result = self.public_config()
            if key.strip() and not persisted:
                result["notice"] = "设置已保存；密钥仅用于当前应用会话"
            return result

    def authorize(self, handler):
        self.check_origin(handler)
        token = handler.headers.get("X-MolStudio-Agent-Token", "")
        if not hmac.compare_digest(token.encode("utf-8"), self.token.encode("utf-8")):
            raise GatewayError("本机会话已变化，请重新打开助手", 403, "session_expired")

    @staticmethod
    def check_origin(handler):
        try:
            host = urlsplit("http://" + handler.headers.get("Host", ""))
            if host.hostname not in ("127.0.0.1", "localhost", "::1") or host.port != handler.server.server_port:
                raise GatewayError("本机地址不匹配", 403, "invalid_host")
        except ValueError:
            raise GatewayError("本机地址无效", 403, "invalid_host") from None
        origin = handler.headers.get("Origin")
        if origin:
            try:
                parsed = urlsplit(origin)
                if parsed.hostname not in ("127.0.0.1", "localhost", "::1") or parsed.port != handler.server.server_port or parsed.scheme != "http":
                    raise GatewayError("来源不匹配", 403, "invalid_origin")
            except ValueError:
                raise GatewayError("来源无效", 403, "invalid_origin") from None

    @staticmethod
    def read_json(handler, max_body=MAX_BODY):
        try:
            size = int(handler.headers.get("Content-Length", "0"))
        except ValueError:
            raise GatewayError("请求长度无效") from None
        if not 0 < size <= max_body:
            raise GatewayError(f"请求为空或超过 {max_body // (1024 * 1024)} MB", 413, "request_too_large")
        try:
            value = json.loads(handler.rfile.read(size))
        except (ValueError, RecursionError):
            raise GatewayError("请求不是有效 JSON") from None
        if not isinstance(value, dict):
            raise GatewayError("请求必须是对象")
        return value

    def cancel(self, request_id):
        if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
            raise GatewayError("请求标识无效")
        with self.lock:
            now = time.monotonic()
            self.cancelled = {key: at for key, at in self.cancelled.items() if now - at < 120}
            self.cancelled[request_id] = now
            request = self.active.get(request_id)
            if request is not None:
                connection = request["connection"]
                try:
                    transport = connection.sock or request.get("socket")
                    if transport:
                        # Wake a blocked read/write. The proxy owns closing the
                        # descriptor so a concurrent sendall cannot lose it mid-poll.
                        transport.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        return {"ok": True}

    def proxy(self, handler, payload):
        self.authorize(handler)
        request_id = handler.headers.get("X-MolStudio-Agent-Request", "")
        if not REQUEST_ID.fullmatch(request_id):
            raise GatewayError("缺少有效的模型请求标识")
        if not isinstance(payload.get("messages"), list) or not payload["messages"]:
            raise GatewayError("模型消息为空")
        with self.lock:
            config, key = dict(self.config), self.api_key
            generation, generation_fields = _generation_payload(config)
            if not key or not config["baseUrl"] or not config["model"]:
                raise GatewayError("请先设置模型地址、名称与 API Key", 409, "setup_required")
            if request_id in self.cancelled:
                raise GatewayError("请求已停止", 409, "cancelled")
            if request_id in self.active or len(self.active) >= 4:
                raise GatewayError("当前请求仍在执行", 409, "request_active")
            parsed = urlsplit(_base_url(config["baseUrl"]))
            endpoint = parsed.path.rstrip("/")
            if not endpoint.endswith("/chat/completions"):
                endpoint += "/chat/completions"
            cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
            service = self
            request = {"connection": None, "socket": None}

            class GuardedConnection(cls):
                def connect(self):
                    super().connect()
                    with service.lock:
                        request["socket"] = self.sock
                        if request_id in service.cancelled:
                            self.close()
                            raise GatewayError("请求已停止", 409, "cancelled")

                def send(self, data):
                    # Connect may have blocked for DNS/TLS. Recheck before any
                    # HTTP headers/body are written, not only after request().
                    if self.sock is None:
                        self.connect()
                    with service.lock:
                        if request_id in service.cancelled:
                            self.close()
                            raise GatewayError("请求已停止", 409, "cancelled")
                    # Cancellation must be able to shut down the socket while
                    # an upstream peer applies backpressure to sendall().
                    return super().send(data)

            connection = GuardedConnection(parsed.hostname, parsed.port, timeout=90)
            request["connection"] = connection
            self.active[request_id] = request
        streaming = payload.get("stream", False) is True
        # Browser/SDK defaults cannot override the saved generation policy.
        # Task correlation metadata belongs to MolStudio, never the provider.
        payload = {name: value for name, value in payload.items() if name not in GENERATION_FIELDS and name != "molstudio"}
        payload.update(generation_fields)
        payload["model"] = config["model"]
        started = False
        try:
            connection.request("POST", endpoint, body=json.dumps(payload, ensure_ascii=False).encode(),
                               headers={"Authorization": "Bearer " + key, "Content-Type": "application/json", "Accept": "text/event-stream" if streaming else "application/json", "Accept-Encoding": "identity"})
            # HTTP/1.0 / Connection:close responses transfer ownership to the
            # response object. Keep this socket so Cancel can interrupt read1.
            with self.lock:
                request["socket"] = connection.sock
                if request_id in self.cancelled:
                    raise GatewayError("请求已停止", 409, "cancelled")
            response = connection.getresponse()
            if response.status != 200:
                message = f"模型服务返回 HTTP {response.status}"
                try:
                    detail = json.loads(response.read(4096))
                except (ValueError, RecursionError):
                    detail = None
                if isinstance(detail, dict):
                    detail = detail.get("error", detail)
                if isinstance(detail, dict):
                    detail = detail.get("message")
                if isinstance(detail, (str, int, float, bool)):
                    message = str(detail).strip() or message
                raise GatewayError(message.replace(key, "[redacted]")[:1000], 502, "provider_error")
            ctype = response.getheader("Content-Type", "")
            if streaming and "text/event-stream" not in ctype.lower():
                raise GatewayError("模型服务未返回流式响应", 502, "invalid_provider_stream")
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream; charset=utf-8" if streaming else "application/json; charset=utf-8")
            handler.send_header("Cache-Control", "no-store")
            handler.send_header("X-Accel-Buffering", "no")
            handler.send_header("X-MolStudio-Generation", json.dumps({"requested": generation, "fields": generation_fields,
                                                                       "forwardedToConfiguredEndpoint": True, "downstreamConfirmed": False}, separators=(",", ":")))
            handler.send_header("Connection", "close")
            handler.end_headers()
            handler.close_connection = True
            started = True
            while True:
                with self.lock:
                    if request_id in self.cancelled:
                        break
                chunk = response.read1(4096)
                if not chunk:
                    break
                handler.wfile.write(chunk)
                handler.wfile.flush()
        except GatewayError as error:
            if not started:
                raise
            try:
                handler.wfile.write(("data: " + json.dumps({"error": {"message": str(error), "type": error.code}}) + "\n\n").encode())
                handler.wfile.flush()
            except OSError:
                pass
        except (OSError, http.client.HTTPException, ValueError):
            if not started:
                with self.lock:
                    cancelled = request_id in self.cancelled
                if cancelled:
                    raise GatewayError("请求已停止", 409, "cancelled") from None
                raise GatewayError("无法连接模型服务，请检查地址或稍后重试", 502, "provider_unavailable") from None
            with self.lock:
                cancelled = request_id in self.cancelled
            if not cancelled:
                try:
                    handler.wfile.write(b'data: {"error":{"message":"Model connection interrupted","type":"stream_interrupted"}}\n\n')
                    handler.wfile.flush()
                except OSError:
                    pass
        finally:
            connection.close()
            with self.lock:
                self.active.pop(request_id, None)


_gateway = None
_gateway_lock = threading.Lock()


def gateway():
    global _gateway
    with _gateway_lock:
        if _gateway is None:
            _gateway = AgentGateway()
        return _gateway


def _send(handler, code, value):
    body = json.dumps(value, ensure_ascii=False).encode()
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    if code >= 400:
        # Authentication errors may leave an unread request body. Never reuse
        # that connection and parse those bytes as the next HTTP request.
        handler.send_header("Connection", "close")
        handler.close_connection = True
    handler.end_headers()
    handler.wfile.write(body)


def handle_get(handler):
    if handler.path.split("?")[0] != "/api/agent/config":
        return False
    try:
        service = gateway()
        service.check_origin(handler)
        _send(handler, 200, service.public_config())
    except GatewayError as error:
        _send(handler, error.status, {"ok": False, "error": str(error), "code": error.code})
    return True


def handle_post(handler):
    route = handler.path.split("?")[0]
    if route not in ("/api/agent/config", "/api/agent/model", "/api/agent/cancel"):
        return False
    try:
        service = gateway()
        service.authorize(handler)
        payload = service.read_json(handler, MAX_MODEL_BODY if route == "/api/agent/model" else MAX_BODY)
        if route == "/api/agent/config":
            _send(handler, 200, service.save_config(payload))
        elif route == "/api/agent/cancel":
            _send(handler, 200, service.cancel(payload.get("requestId")))
        else:
            service.proxy(handler, payload)
    except GatewayError as error:
        _send(handler, error.status, {"ok": False, "error": str(error), "code": error.code})
    except (OSError, ValueError):
        _send(handler, 500, {"ok": False, "error": "无法保存模型设置", "code": "config_failed"})
    return True
