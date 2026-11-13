"""Network and structure contracts for the local agent; no paid model requests."""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from rdkit import Chem
from rdkit.Chem import rdDepictor

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import agent_gateway as gateway_module
import server as chemistry


class Provider(BaseHTTPRequestHandler):
    state = None

    def log_message(self, *args):
        pass

    def do_POST(self):
        state = self.state
        state["calls"] += 1
        state["authorization"] = self.headers.get("Authorization")
        state["payload"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if "error" in state:
            body = json.dumps(state["error"]).encode()
            self.send_response(401)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        if state.get("truncate_chunked"):
            self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        if state.get("truncate_chunked"):
            fragment = b'data: {"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}\n\n'
            self.wfile.write(f'{len(fragment):x}\r\n'.encode() + fragment + b'\r\n')
            self.wfile.flush()
            return  # A missing zero-length final chunk is a real HTTP framing error.
        self.wfile.write(b'data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
        self.wfile.flush()
        state["first"].set()
        state["release"].wait(5)
        try:
            if state.get("upstream_error"):
                self.wfile.write(b'data: {"error":{"type":"upstream_error","code":"upstream_stream_error"}}\n\n')
                self.wfile.flush()
                return
            if state.get("long_output"):
                chunk = b'data: {"choices":[{"delta":{"content":"' + b'x' * (64 * 1024) + b'"}}]}\n\n'
                for _ in range(513):
                    self.wfile.write(chunk)
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


class Local(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        gateway_module.handle_get(self)

    def do_POST(self):
        gateway_module.handle_post(self)


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = {"calls": 0, "first": threading.Event(), "release": threading.Event(), "key": "test-only-private-key"}
        Provider.state = self.state
        self.provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        self.provider.daemon_threads = True
        threading.Thread(target=self.provider.serve_forever, daemon=True).start()
        self.gateway = gateway_module.AgentGateway(self.temp.name, {
            "MOLSTUDIO_AGENT_BASE_URL": f"http://127.0.0.1:{self.provider.server_port}/v1",
            "MOLSTUDIO_AGENT_MODEL": "test-flash", "MOLSTUDIO_AGENT_API_KEY": self.state["key"],
        })
        self.previous = gateway_module._gateway
        gateway_module._gateway = self.gateway
        self.local = ThreadingHTTPServer(("127.0.0.1", 0), Local)
        self.local.daemon_threads = True
        threading.Thread(target=self.local.serve_forever, daemon=True).start()

    def tearDown(self):
        self.state["release"].set()
        for request_id in list(self.gateway.active):
            self.gateway.cancel(request_id)
        self.local.shutdown()
        self.provider.shutdown()
        self.local.server_close()
        self.provider.server_close()
        gateway_module._gateway = self.previous
        self.temp.cleanup()

    def request(self, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.local.server_port, timeout=3)
        values = {"Content-Type": "application/json", "X-MolStudio-Agent-Token": self.gateway.token}
        values.update(headers or {})
        connection.request("POST" if body is not None else "GET", path,
                           body=json.dumps(body).encode() if body is not None else None, headers=values)
        response = connection.getresponse()
        return connection, response

    def test_public_config_never_exposes_key_and_rejects_rebinding(self):
        connection, response = self.request("/api/agent/config")
        body = response.read().decode()
        self.assertEqual(response.status, 200)
        self.assertNotIn(self.state["key"], body)
        self.assertTrue(json.loads(body)["configured"])
        connection.close()
        connection, response = self.request("/api/agent/config", headers={"Host": "attacker.example"})
        self.assertEqual(response.status, 403)
        response.read()
        connection.close()

    def test_config_requires_token_and_matching_origin(self):
        for headers in ({"X-MolStudio-Agent-Token": "wrong"}, {"Origin": "https://attacker.example"}, {"Origin": "http://localhost:invalid"}):
            connection, response = self.request("/api/agent/config", {"model": "other"}, headers)
            self.assertEqual(response.status, 403)
            response.read()
            connection.close()
        self.assertEqual(self.gateway.config["model"], "test-flash")

    def test_settings_persist_without_plaintext_secret(self):
        with patch.object(gateway_module, "_keychain", return_value=None):
            connection, response = self.request("/api/agent/config", {"model": "other", "apiKey": "changed-test-secret", "maxTurns": 32})
            self.assertEqual(response.status, 200)
            result = json.load(response)
            self.assertNotIn("apiKey", result)
            connection.close()
        saved = self.gateway.config_file.read_text()
        self.assertNotIn("changed-test-secret", saved)
        self.assertNotIn("maxTurns", result)
        self.assertNotIn("maxTurns", json.loads(saved))
        self.assertEqual(self.gateway.api_key, "changed-test-secret")

    def forwarded(self, request_id, extra=None):
        self.state["release"].set()
        connection, response = self.request("/api/agent/model", {
            "stream": True, "messages": [{"role": "user", "content": "fixture"}], **(extra or {})
        }, {"X-MolStudio-Agent-Request": request_id})
        try:
            self.assertEqual(response.status, 200, response.reason)
            self.assertIn(b"[DONE]", response.read())
            return dict(self.state["payload"]), json.loads(response.getheader("X-MolStudio-Generation"))
        finally:
            connection.close()

    def test_provider_default_removes_sdk_thinking_fields_and_private_task_metadata(self):
        body, metadata = self.forwarded("generation-default", {
            "thinking": {"type": "enabled"}, "reasoning_effort": "high", "reasoning": {"effort": "max"},
            "max_tokens": 3, "max_completion_tokens": 4, "thinking_budget": 999,
            "molstudio": {"taskId": "private-task", "phaseId": "first", "requestIndex": 1},
        })
        for field in gateway_module.GENERATION_FIELDS | {"molstudio"}:
            self.assertNotIn(field, body)
        self.assertEqual(metadata["fields"], {})
        self.assertEqual(metadata["requested"], gateway_module.DEFAULT_GENERATION)
        self.assertTrue(metadata["forwardedToConfiguredEndpoint"])
        self.assertFalse(metadata["downstreamConfirmed"])
        self.assertNotIn("private-task", json.dumps(metadata))
        self.gateway.save_config({"generation": {"profile": "provider-default", "maxOutputTokens": 512}})
        capped, _ = self.forwarded("generation-default-cap")
        self.assertEqual(capped["max_tokens"], 512)
        self.assertNotIn("reasoning_effort", capped)
        self.assertNotIn("thinking", capped)

    def test_deepseek_supported_choices_reach_actual_http_provider(self):
        for effort in ("none", "low", "high", "max", "default"):
            with self.subTest(effort=effort):
                self.gateway.save_config({"generation": {"profile": "deepseek", "effort": effort, "maxOutputTokens": 16384}})
                body, metadata = self.forwarded("deepseek-" + effort, {"reasoning_effort": "medium", "thinking": {"type": "disabled"}, "max_completion_tokens": 1})
                self.assertEqual(body["max_tokens"], 16384)
                self.assertNotIn("max_completion_tokens", body)
                if effort == "default":
                    self.assertNotIn("thinking", body)
                    self.assertNotIn("reasoning_effort", body)
                else:
                    self.assertEqual(body["reasoning_effort"], effort)
                    self.assertEqual(body["thinking"], {"type": "disabled" if effort == "none" else "enabled"})
                self.assertEqual(metadata["fields"], {name: body[name] for name in gateway_module.GENERATION_FIELDS if name in body})
        self.assertEqual(self.state["calls"], 5)

    def test_openai_model_capabilities_validate_actual_payload_and_do_not_guess_unknown_models(self):
        self.gateway.save_config({"model": "gpt-5.2-2025-12-11", "generation": {"profile": "openai", "effort": "xhigh", "maxOutputTokens": 2048}})
        body, metadata = self.forwarded("openai-generation", {"thinking": {"type": "enabled"}, "max_tokens": 99})
        self.assertEqual(body["reasoning_effort"], "xhigh")
        self.assertEqual(body["max_completion_tokens"], 2048)
        self.assertNotIn("thinking", body)
        self.assertNotIn("max_tokens", body)
        self.assertEqual(metadata["fields"], {"reasoning_effort": "xhigh", "max_completion_tokens": 2048})
        with self.assertRaises(gateway_module.GatewayError):
            self.gateway.save_config({"model": "gpt-5.1", "generation": {"profile": "openai", "effort": "xhigh"}})
        with self.assertRaises(gateway_module.GatewayError):
            self.gateway.save_config({"model": "new-unknown-model", "generation": {"profile": "openai", "effort": "high"}})
        self.gateway.save_config({"model": "new-unknown-model", "generation": {"profile": "openai", "effort": "default"}})
        self.assertEqual(self.gateway.public_config()["generationCapabilities"]["profiles"]["openai"]["efforts"], ["default"])
        self.assertEqual(self.gateway.public_config()["generationCapabilities"]["detectedProfile"], "provider-default")

    def test_invalid_generation_update_is_atomic_and_preserves_credential_and_file(self):
        self.gateway.save_config({"generation": {"profile": "deepseek", "effort": "low"}})
        original_file = self.gateway.config_file.read_bytes()
        original_config = dict(self.gateway.config)
        cases = [None, [], "high", {"profile": "unknown"}, {"profile": "deepseek", "effort": "xhigh"},
                 {"profile": "provider-default", "effort": "high"}, {"maxOutputTokens": True},
                 {"maxOutputTokens": "100"}, {"maxOutputTokens": 1.5}, {"maxOutputTokens": 0},
                 {"profile": "deepseek", "maxOutputTokens": 393217}, {"thinkingBudget": 1000}]
        with patch.object(gateway_module, "_keychain") as keychain:
            for generation in cases:
                with self.subTest(generation=generation):
                    connection, response = self.request("/api/agent/config", {"model": "changed", "apiKey": "must-not-replace-key", "generation": generation})
                    try:
                        self.assertEqual(response.status, 400)
                        self.assertEqual(json.load(response)["code"], "invalid_generation")
                    finally:
                        connection.close()
                    self.assertEqual(self.gateway.config, original_config)
                    self.assertEqual(self.gateway.config_file.read_bytes(), original_file)
                    self.assertEqual(self.gateway.api_key, self.state["key"])
            keychain.assert_not_called()

    def test_isolated_generation_environment_override_is_validated_and_never_saved(self):
        env = {"MOLSTUDIO_AGENT_MODEL": "deepseek-v4.1-flash", "MOLSTUDIO_AGENT_GENERATION_JSON": json.dumps({"profile": "deepseek", "effort": "low", "maxOutputTokens": 16384})}
        restored = gateway_module.AgentGateway(self.temp.name, env)
        self.assertEqual(restored.public_config()["generationEffective"]["fields"], {"reasoning_effort": "low", "thinking": {"type": "enabled"}, "max_tokens": 16384})
        self.assertFalse(restored.public_config()["generationEffective"]["forwardedToConfiguredEndpoint"])
        self.assertFalse(restored.config_file.exists())
        for value in ('not-json', '{"profile":"deepseek","effort":"medium"}'):
            with self.assertRaises(gateway_module.GatewayError):
                gateway_module.AgentGateway(self.temp.name, {**env, "MOLSTUDIO_AGENT_GENERATION_JSON": value})

    def test_settings_cannot_change_generation_or_credentials_while_request_is_running(self):
        self.gateway.save_config({"generation": {"profile": "deepseek", "effort": "low"}})
        original_file = self.gateway.config_file.read_bytes()
        connection, response = self.request("/api/agent/model", {"stream": True, "messages": [{"role": "user", "content": "fixture"}]}, {"X-MolStudio-Agent-Request": "settings-locked"})
        try:
            self.assertIn(b"first", response.readline())
            update, denied = self.request("/api/agent/config", {"generation": {"profile": "deepseek", "effort": "high"}, "apiKey": "new-unwanted-key"})
            try:
                self.assertEqual(denied.status, 409)
                self.assertEqual(json.load(denied)["code"], "run_active")
            finally:
                update.close()
            self.assertEqual(self.gateway.config_file.read_bytes(), original_file)
            self.assertEqual(self.gateway.config["generation"]["effort"], "low")
            self.assertEqual(self.gateway.api_key, self.state["key"])
        finally:
            self.state["release"].set()
            response.read()
            connection.close()

    def test_invalid_endpoint_override_preserves_saved_model_and_credential(self):
        saved_url = self.gateway.config["baseUrl"]
        self.gateway.config_file.write_text(json.dumps({"baseUrl": saved_url, "model": "saved-model", "maxTurns": 24}))
        with patch.dict(os.environ, {"MOLSTUDIO_AGENT_BASE_URL": "not-a-url", "MOLSTUDIO_AGENT_MODEL": "env-model",
                                     "MOLSTUDIO_AGENT_API_KEY": "env-key"}), patch.object(gateway_module, "_keychain", return_value="saved-key"):
            restored = gateway_module.AgentGateway(self.temp.name)
        self.assertEqual(restored.config["baseUrl"], saved_url)
        self.assertEqual(restored.config["model"], "saved-model")
        self.assertTrue(restored.public_config()["configured"])
        self.assertEqual(restored.api_key, "saved-key")
        self.assertNotIn("maxTurns", restored.config)

    def test_bad_key_file_does_not_prevent_gateway_start(self):
        key_file = Path(self.temp.name) / "bad-key-file"
        key_file.write_bytes(b"\xff\xfe")
        restored = gateway_module.AgentGateway(self.temp.name, {"MOLSTUDIO_AGENT_KEY_FILE": str(key_file)})
        self.assertFalse(restored.public_config()["configured"])

    def test_long_transcript_crosses_old_message_and_request_size_limits(self):
        self.state["release"].set()
        messages = [{"role": "user", "content": "fixture"} for _ in range(501)]
        messages[-1]["content"] = "x" * gateway_module.MAX_BODY
        connection, response = self.request("/api/agent/model", {"stream": True, "messages": messages},
                                            {"X-MolStudio-Agent-Request": "long-input"})
        self.addCleanup(connection.close)
        self.assertEqual(response.status, 200)
        self.assertIn(b"[DONE]", response.read())
        self.assertEqual(len(self.state["payload"]["messages"]), len(messages))
        self.assertEqual(len(self.state["payload"]["messages"][-1]["content"]), gateway_module.MAX_BODY)

    def test_long_stream_reaches_done_beyond_old_response_byte_limit(self):
        self.state["long_output"] = True
        self.state["release"].set()
        connection, response = self.request("/api/agent/model", {"stream": True, "messages": [{"role": "user", "content": "fixture"}]},
                                            {"X-MolStudio-Agent-Request": "long-output"})
        self.addCleanup(connection.close)
        self.assertEqual(response.status, 200)
        received = 0
        tail = b""
        while chunk := response.read(64 * 1024):
            received += len(chunk)
            tail = (tail + chunk)[-32:]
        self.assertGreater(received, 32 * 1024 * 1024)
        self.assertTrue(tail.endswith(b"data: [DONE]\n\n"))

    def test_streams_first_chunk_before_provider_finishes_and_forces_model(self):
        connection, response = self.request("/api/agent/model", {"model": "untrusted", "stream": True, "messages": [{"role": "user", "content": "test"}]}, {"X-MolStudio-Agent-Request": "stream-1"})
        self.assertEqual(response.status, 200)
        self.assertIn(b"first", response.readline())
        self.assertFalse(self.state["release"].is_set())
        self.assertEqual(self.state["payload"]["model"], "test-flash")
        self.assertEqual(self.state["authorization"], "Bearer " + self.state["key"])
        self.state["release"].set()
        self.assertIn(b"[DONE]", response.read())
        connection.close()
        self.assertEqual(self.state["calls"], 1)

    def test_upstream_sse_error_is_forwarded_once_and_fresh_request_requires_explicit_action(self):
        self.state["upstream_error"] = True
        self.state["release"].set()
        body = {"stream": True, "messages": [{"role": "user", "content": "fixture"}]}
        connection, response = self.request("/api/agent/model", body, {"X-MolStudio-Agent-Request": "interrupted"})
        received = response.read()
        connection.close()
        self.assertEqual(response.status, 200)
        self.assertIn(b'"code":"upstream_stream_error"', received)
        self.assertNotIn(b'[DONE]', received)
        self.assertEqual(self.state["calls"], 1)
        # A distinct later request models an explicit continue; no transport
        # retry can replay a partial tool stream without that request.
        self.state.pop("upstream_error")
        connection, response = self.request("/api/agent/model", body, {"X-MolStudio-Agent-Request": "explicit-continue"})
        self.assertIn(b'[DONE]', response.read())
        connection.close()
        self.assertEqual(self.state["calls"], 2)

    def test_truncated_chunked_transport_reports_error_without_replay(self):
        self.state["truncate_chunked"] = True
        body = {"stream": True, "messages": [{"role": "user", "content": "fixture"}]}
        connection, response = self.request("/api/agent/model", body, {"X-MolStudio-Agent-Request": "truncated-chunk"})
        received = response.read()
        connection.close()
        self.assertEqual(response.status, 200)
        self.assertIn(b'"tool_calls"', received)
        self.assertIn(b'"type":"stream_interrupted"', received)
        self.assertNotIn(b'[DONE]', received)
        self.assertEqual(self.state["calls"], 1)

    def test_cancel_releases_inflight_upstream_and_rejects_late_start(self):
        connection, response = self.request("/api/agent/model", {"stream": True, "messages": [{"role": "user", "content": "test"}]}, {"X-MolStudio-Agent-Request": "stop-1"})
        self.assertIn(b"first", response.readline())
        cancel_connection, cancel_response = self.request("/api/agent/cancel", {"requestId": "stop-1"})
        self.assertEqual(cancel_response.status, 200)
        cancel_response.read()
        cancel_connection.close()
        response.read()
        connection.close()
        connection, response = self.request("/api/agent/model", {"stream": True, "messages": [{"role": "user", "content": "test"}]}, {"X-MolStudio-Agent-Request": "stop-1"})
        self.assertEqual(response.status, 409)
        response.read()
        connection.close()
        self.assertEqual(self.state["calls"], 1)

    def test_provider_error_is_redacted(self):
        self.state["error"] = {"error": {"message": "Rejected " + self.state["key"]}}
        connection, response = self.request("/api/agent/model", {"stream": True, "messages": [{"role": "user", "content": "test"}]}, {"X-MolStudio-Agent-Request": "error-1"})
        body = response.read().decode()
        self.assertEqual(response.status, 502)
        self.assertNotIn(self.state["key"], body)
        self.assertIn("redacted", body)
        connection.close()

    def test_unusual_provider_json_errors_return_valid_proxy_errors(self):
        cases = [("denied", "denied"), ([{"secret": self.state["key"]}], "HTTP 401"),
                 ({"error": {"message": 17}}, "17"), ({"error": {"message": ["denied"]}}, "HTTP 401")]
        for index, (error, expected) in enumerate(cases):
            with self.subTest(index=index):
                self.state["error"] = error
                connection, response = self.request("/api/agent/model", {"stream": True, "messages": [{"role": "user", "content": "test"}]},
                                                    {"X-MolStudio-Agent-Request": f"odd-error-{index}"})
                try:
                    body = json.load(response)
                    self.assertEqual(response.status, 502)
                    self.assertEqual(body["code"], "provider_error")
                    self.assertIn(expected, body["error"])
                    self.assertNotIn(self.state["key"], body["error"])
                finally:
                    connection.close()


class StructureTests(unittest.TestCase):
    def structure(self, smiles):
        return chemistry.Handler._api_agent_structure(None, smiles)

    @unittest.skipUnless(rdDepictor.IsCoordGenSupportAvailable(), "requires CoordGen")
    def test_agent_depiction_before_and_after_clean(self):
        preference = rdDepictor.GetPreferCoordGen()
        try:
            for smiles in ("[CH3:11][C:12]([CH3:13])([CH3:14])[OH2+:15]", "F[C@](Cl)(Br)I"):
                with self.subTest(smiles=smiles):
                    rdDepictor.SetPreferCoordGen(False)
                    fresh = self.structure(smiles)
                    self.assertFalse(rdDepictor.GetPreferCoordGen())
                    section = fresh["ket"]["mol0"]
                    chemistry.stereo.layout_section(section)
                    self.assertEqual(fresh, self.structure(smiles))
                    centers = chemistry.stereo.center_gaps(
                        [atom["location"][:2] for atom in section["atoms"]],
                        [bond["atoms"] for bond in section["bonds"]],
                    )
                    self.assertEqual(len(centers), 1)
                    gaps = centers[0]["gaps"]
                    self.assertFalse(all(80 <= gap <= 100 for gap in gaps), gaps)
                    actual = Chem.MolToSmiles(chemistry.stereo.mol_from_section(section))
                    self.assertEqual(actual, fresh["smiles"])
        finally:
            rdDepictor.SetPreferCoordGen(preference)

    def test_mapped_sn2_structure_references_match_ket_atom_order(self):
        result = self.structure("[CH3:2][Br:3]")
        self.assertEqual([atom["ref"] for atom in result["atoms"]], ["2", "3"])
        self.assertEqual(result["bonds"][0], {"ref": "1", "index": 0, "begin": "2", "end": "3", "order": 1, "nativeType": 1})
        self.assertEqual(result["ket"]["mol0"]["atoms"][1]["label"], "Br")
        self.assertEqual(result["ket"]["mol0"]["bonds"][0]["atoms"], [0, 1])

    def test_bonded_explicit_hydrogen_keeps_its_map_and_native_bond(self):
        result = self.structure("[CH3:3][O+:7]([H:12])[CH3:4]")
        self.assertEqual([atom["ref"] for atom in result["atoms"]], ["3", "7", "12", "4"])
        self.assertEqual(result["bonds"][1], {"ref": "2", "index": 1, "begin": "7", "end": "12", "order": 1, "nativeType": 1})
        section = result["ket"]["mol0"]
        self.assertEqual(section["atoms"][2]["label"], "H")
        self.assertEqual(section["bonds"][1]["atoms"], [1, 2])

    def test_inspection_reports_chemical_order_and_actual_native_bond_type(self):
        formic = self.structure("[CH:13](=[O+:14][H:17])[OH:15]")
        self.assertEqual([(bond["begin"], bond["end"], bond["order"], bond["nativeType"])
                          for bond in formic["bonds"]],
                         [("13", "14", 2, 2), ("14", "17", 1, 1), ("13", "15", 1, 1)])
        triple = self.structure("N#N")
        self.assertEqual((triple["bonds"][0]["order"], triple["bonds"][0]["nativeType"]), (3, 3))
        aromatic = self.structure("c1ccccc1")
        self.assertEqual({bond["order"] for bond in aromatic["bonds"]}, {1.5})
        self.assertEqual({bond["nativeType"] for bond in aromatic["bonds"]}, {1, 2})
        for bond in aromatic["bonds"]:
            self.assertEqual(bond["nativeType"], aromatic["ket"]["mol0"]["bonds"][bond["index"]]["type"])

    def test_hydrogen_only_structures_have_finite_coordinates(self):
        for smiles in ("[H:1]", "[H+:1]", "[H:1][H:2]"):
            with self.subTest(smiles=smiles):
                result = self.structure(smiles)
                json.dumps(result, allow_nan=False)
                self.assertEqual(result["atoms"][0]["ref"], "1")

    def test_charge_isotope_and_radical_are_retained(self):
        oh = self.structure("[OH-:1]")
        self.assertEqual(oh["ket"]["mol0"]["atoms"][0]["charge"], -1)
        isotope = self.structure("[13CH3][CH2]")
        self.assertEqual(isotope["ket"]["mol0"]["atoms"][0]["isotope"], 13)
        self.assertEqual(isotope["ket"]["mol0"]["atoms"][1]["radical"], 2)

    def test_invalid_or_ambiguous_mappings_are_rejected(self):
        for smiles in ("[CH3:1][Br:1]", "[CH3:1]Br", "not a smiles"):
            with self.assertRaises(chemistry.ApiError):
                self.structure(smiles)

    def test_smiles_failures_are_classified_and_attributed(self):
        with self.assertRaises(chemistry.ApiError) as syntax:
            self.structure("C1CC")
        self.assertEqual(syntax.exception.code, "smiles_syntax")
        self.assertEqual(syntax.exception.extra["field"], "smiles")

        with self.assertRaises(chemistry.ApiError) as valence:
            self.structure("[CH5:42]")
        self.assertEqual(valence.exception.code, "smiles_valence")
        self.assertEqual(valence.exception.extra["field"], "smiles")
        self.assertEqual(valence.exception.extra["atomIndex"], 0)
        self.assertEqual(valence.exception.extra["atomMap"], 42)

    def test_partial_and_duplicate_maps_point_to_atoms(self):
        with self.assertRaises(chemistry.ApiError) as partial:
            self.structure("[CH3:7]Br")
        self.assertEqual(partial.exception.code, "partial_atom_mapping")
        self.assertEqual(partial.exception.extra["mappedAtomIndices"], [0])
        self.assertEqual(partial.exception.extra["unmappedAtomIndices"], [1])

        with self.assertRaises(chemistry.ApiError) as duplicate:
            self.structure("[CH3:7][Br:7]")
        self.assertEqual(duplicate.exception.code, "duplicate_atom_mapping")
        self.assertEqual(duplicate.exception.extra["duplicateAtomMaps"], {"7": [0, 1]})


if __name__ == "__main__":
    unittest.main()
