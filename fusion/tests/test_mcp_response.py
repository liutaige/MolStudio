"""MCP payload views preserve edit references and support bounded step reads."""
from copy import deepcopy
import contextlib
import io
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mcp_server
from mcp_response import compact_response, select_canvas_steps


def canvas_fixture():
    atoms = [
        {"id": name, "label": label, "charge": charge, "implicitH": hydrogen,
         "radical": 0, "aromatic": False, "hasQuery": False, "isotope": 0,
         "x": index * 1.123456, "y": index * -0.123456,
         "stereoLabel": None, "stereoParity": None, "alias": None}
        for index, (name, label, charge, hydrogen) in enumerate([
            ("nu", "O", -1, 1), ("c", "C", 0, 3), ("br", "Br", 0, 0),
            ("pc", "C", 0, 3), ("po", "O", 0, 1), ("pbr", "Br", -1, 0),
            ("spare-c", "C", 0, 3), ("spare-o", "O", 0, 1),
        ])
    ]
    bonds = [
        {"id": bid, "begin": begin, "end": end, "order": order, "nativeType": native,
         "aromatic": False, "stereo": 0}
        for bid, begin, end, order, native in [
            ("c-br", "c", "br", 1, 1), ("pc-po", "pc", "po", 1, 1),
            ("spare-bond", "spare-c", "spare-o", 1, 1),
        ]
    ]
    for atom in atoms:
        atom["neighbors"] = [
            {"uuid": b["end"] if b["begin"] == atom["id"] else b["begin"],
             "order": b["order"], "aromatic": b["aromatic"], "angle": 123.456789123456}
            for b in bonds if atom["id"] in (b["begin"], b["end"])
        ]
    step = {
        "stepId": "rs-sn2", "version": 3, "reactionArrowId": "ra-sn2",
        "reactants": ["nu", "c"], "products": ["pc", "pbr"],
        "conditions": "aqueous", "layout": {"reagentPlacement": "left"},
        "layoutStatus": {"status": "passed", "continuation": 2, "routeId": "route-1", "laneId": "lane-2"},
        "ports": [{"token": "续 2", "kind": "continuation", "side": "left", "at": "molecule",
                   "anchorRefs": ["pc"], "position": {"x": 9.0, "y": 4.0}}],
        "checks": {"layout": {"status": "passed", "issues": [], "checkedArrowIds": ["attack", "leave"]},
                   "chemistry": {"status": "passed", "issues": []}},
    }
    arrow = {"id": "attack", "electronCount": 2,
             "source": {"type": "lonePair", "slotId": "pair-nu", "ownerAtomId": "nu"},
             "target": {"type": "formingBond", "atomA": "nu", "atomB": "c"},
             "geometry": {"mode": "auto", "bend": 0.3, "routeVersion": 4,
                          "controlFrame": {"along": 0.5, "normal": 0.4}},
             "stepId": "group-1", "pairId": None}
    return {
        "sessionId": "session-1", "revision": 10, "coordinateSystem": "x right, y down",
        "atoms": atoms, "bonds": bonds,
        "molecules": [
            {"id": "mol:1", "atoms": ["nu"], "bonds": [], "center": {"x": 0, "y": 0}},
            {"id": "mol:2", "atoms": ["c", "br"], "bonds": ["c-br"], "center": {"x": 2, "y": 0}},
            {"id": "mol:3", "atoms": ["pc", "po"], "bonds": ["pc-po"], "center": {"x": 4, "y": 0}},
            {"id": "mol:4", "atoms": ["pbr"], "bonds": [], "center": {"x": 6, "y": 0}},
            {"id": "mol:5", "atoms": ["spare-c", "spare-o"], "bonds": ["spare-bond"], "center": {"x": 20, "y": 0}},
        ],
        "lonePairs": [{"id": "pair-nu", "ownerAtomId": "nu", "origin": "manual", "electronCount": 2,
                       "refAtomId": "c", "angleRel": 0, "angle": 20, "radius": 0.42, "visible": True}],
        "arrows": [arrow, {"id": "leave", "electronCount": 2,
                           "source": {"type": "bond", "bondId": "c-br", "component": "sigma"},
                           "target": {"type": "atom", "atomId": "br"},
                           "geometry": {"mode": "manual", "bend": -0.4}, "stepId": "group-1"}],
        "reactionSteps": [step],
        "reactionArrows": [{"id": "ra-sn2", "mode": "open-angle", "start": {"x": 3, "y": 0},
                            "end": {"x": 4, "y": 0}, "stepId": "rs-sn2", "version": 3,
                            "reactants": ["nu", "c"], "products": ["pc", "pbr"], "conditions": "aqueous"}],
        "texts": [{"id": "label-1", "text": "续 2", "x": 3, "y": 0}],
        "steps": [{"id": "group-1", "label": "Step 1"}],
        "selection": {"atoms": ["nu", "spare-o"], "bonds": ["c-br", "spare-bond"],
                      "mechanism": ["attack"], "otherCount": 0},
        "viewport": {"center": {"x": 5, "y": 5}, "visibleBounds": {"x1": -10, "x2": 20, "y1": -5, "y2": 10}},
        "limits": {"operationsPerCall": 40}, "supportedOperations": ["molecule.add", "reactionStep.modify"],
        "futureObservation": {"data": "preserved"},
    }


def byte_size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


class CompactResponseTests(unittest.TestCase):
    def test_read_preserves_chemical_graph_and_layout_references(self):
        canvas = canvas_fixture()
        canvas["atoms"][1].update({"stereoLabel": "R", "stereoParity": 1, "isotope": 13})
        before = deepcopy(canvas)
        result = compact_response("read_canvas", canvas)
        self.assertEqual(canvas, before)
        self.assertEqual(set(result), set(canvas))
        for original, observed in zip(canvas["atoms"], result["atoms"]):
            for key in ("id", "label", "charge", "implicitH", "radical", "aromatic", "hasQuery", "isotope", "x", "y"):
                self.assertEqual(observed[key], original[key])
            self.assertNotIn("neighbors", observed)
        self.assertEqual(result["atoms"][1]["stereoLabel"], "R")
        for key in ("bonds", "molecules", "lonePairs", "reactionSteps", "steps", "selection", "texts", "viewport", "futureObservation"):
            self.assertEqual(result[key], canvas[key])
        for original, observed in zip(canvas["arrows"], result["arrows"]):
            for key in ("id", "source", "target", "electronCount", "stepId"):
                self.assertEqual(observed[key], original[key])
            for key in ("mode", "bend"):
                self.assertEqual(observed["geometry"][key], original["geometry"][key])
        self.assertEqual(result["reactionArrows"][0]["id"], "ra-sn2")
        self.assertEqual(result["reactionArrows"][0]["stepId"], "rs-sn2")
        self.assertLess(byte_size(result), byte_size(canvas) * 0.85)

    def test_unknown_or_unresolved_neighbor_information_is_preserved(self):
        canvas = canvas_fixture()
        canvas["atoms"][1]["neighbors"][0]["futureBondMeaning"] = "new semantic field"
        canvas["atoms"][2]["neighbors"][0]["uuid"] = "not-in-bonds"
        result = compact_response("molstudio_read_canvas", canvas)
        self.assertEqual(result["atoms"][1]["neighbors"], canvas["atoms"][1]["neighbors"])
        self.assertEqual(result["atoms"][2]["neighbors"], canvas["atoms"][2]["neighbors"])
        result["futureObservation"]["data"] = "mutated detached result"
        self.assertEqual(canvas["futureObservation"]["data"], "preserved")

    def test_draw_deduplicates_step_snapshots_without_losing_repair_data(self):
        step = canvas_fixture()["reactionSteps"][0]
        receipt = {
            "sessionId": "s", "revision": 1,
            "created": [{"id": "new-step", "type": "reactionStep.create", "stepId": step["stepId"],
                         "version": step["version"], "after": deepcopy(step)},
                        {"id": "mol-op", "type": "molecule.add", "atoms": [{"id": "a", "ref": "21", "label": "C"}],
                         "bonds": [{"id": "b", "ref": "9", "begin": "21", "end": "7", "order": 2, "nativeType": 2}]}],
            "updated": [], "deleted": [], "cascaded": [],
            "steps": [{"operationId": "new-step", "stepId": step["stepId"], "version": step["version"],
                       "action": "create", "before": None, "after": deepcopy(step),
                       "layout": deepcopy(step["layoutStatus"]), "checks": deepcopy(step["checks"])}],
            "stepMapping": {"new-step": step["stepId"]}, "finishAccepted": False,
            "finishRejected": "Repair only this step", "warnings": ["Keep this warning"],
            "completionDiagnostic": {"code": "completion_check_failed", "invalidReactionSteps": [
                {"stepId": step["stepId"], "version": step["version"], "reactants": step["reactants"]}]},
            "nextAction": "Use the same stable stepId and current version", "futureReceipt": {"keep": True},
        }
        before = deepcopy(receipt)
        result = compact_response("draw_operations", receipt)
        self.assertEqual(receipt, before)
        self.assertNotIn("after", result["created"][0])
        self.assertEqual(result["created"][1], receipt["created"][1])
        for key in ("stepMapping", "finishAccepted", "finishRejected", "completionDiagnostic", "warnings", "nextAction", "futureReceipt"):
            self.assertEqual(result[key], receipt[key])
        observed = result["steps"][0]
        self.assertEqual(observed["after"]["reactants"], step["reactants"])
        self.assertEqual(observed["after"]["products"], step["products"])
        self.assertEqual(observed["after"]["version"], step["version"])
        self.assertEqual(observed["checks"], step["checks"])
        self.assertEqual(observed["layout"], step["layoutStatus"])
        self.assertLess(byte_size(result), byte_size(receipt) * 0.75)

    def test_conflicting_step_snapshots_and_inspection_errors_are_not_hidden(self):
        value = {"created": [{"id": "x", "after": {"version": 1}}],
                 "steps": [{"operationId": "x", "after": {"version": 2}}]}
        self.assertEqual(compact_response("draw_operations", value), value)
        inspections = [
            {"id": "good", "ok": True, "atoms": [{"ref": "21", "index": 0, "label": "C", "charge": 0, "radicalElectrons": 0}],
             "bonds": [{"ref": "1", "index": 0, "begin": "21", "end": "5", "order": 1.5, "nativeType": 2}]},
            {"id": "bad", "ok": False, "error": "Invalid valence", "code": "smiles_valence", "atomIndex": 3,
             "atomMap": 21, "duplicateAtomMaps": {"21": [1, 3]}},
        ]
        original = deepcopy(inspections)
        result = compact_response("inspect_structures", inspections)
        self.assertEqual(result[1], inspections[1])
        self.assertEqual(result[0]["atoms"][0], {"ref": "21", "label": "C", "charge": 0, "radicalElectrons": 0})
        self.assertEqual(result[0]["bonds"][0]["nativeType"], 2)
        self.assertEqual(inspections, original)
        self.assertEqual(compact_response("future_tool", value), value)


class StepScopeTests(unittest.TestCase):
    def test_scoped_read_keeps_whole_molecules_and_resolvable_endpoints(self):
        canvas = canvas_fixture()
        before = deepcopy(canvas)
        result = select_canvas_steps(canvas, ["rs-sn2"])
        self.assertEqual(canvas, before)
        atom_ids = {atom["id"] for atom in result["atoms"]}
        self.assertEqual(atom_ids, {"nu", "c", "br", "pc", "po", "pbr"})
        self.assertEqual({bond["id"] for bond in result["bonds"]}, {"c-br", "pc-po"})
        self.assertEqual([molecule["id"] for molecule in result["molecules"]], ["mol:1", "mol:2", "mol:3", "mol:4"])
        self.assertEqual(result["arrows"], canvas["arrows"])
        self.assertEqual(result["lonePairs"], canvas["lonePairs"])
        self.assertEqual(result["reactionSteps"], canvas["reactionSteps"])
        self.assertEqual(result["reactionArrows"], canvas["reactionArrows"])
        self.assertEqual(result["selection"]["atoms"], ["nu"])
        self.assertEqual(result["selection"]["bonds"], ["c-br"])
        self.assertEqual(result["scope"]["stepIds"], ["rs-sn2"])
        self.assertEqual(result["scope"]["total"]["atoms"], 8)
        self.assertEqual(result["scope"]["returned"]["atoms"], 6)
        self.assertEqual(result["texts"], canvas["texts"])
        self.assertEqual(result["steps"], canvas["steps"])

    def test_cross_component_flow_closes_the_other_endpoint_without_chasing_route(self):
        canvas = canvas_fixture()
        canvas["arrows"].extend([
            {"id": "cross", "electronCount": 2, "source": {"type": "atom", "atomId": "nu"},
             "target": {"type": "atom", "atomId": "spare-o"}},
            {"id": "only-spare", "electronCount": 1, "source": {"type": "atom", "atomId": "spare-c"},
             "target": {"type": "atom", "atomId": "spare-o"}},
        ])
        result = select_canvas_steps(canvas, ["rs-sn2"])
        self.assertEqual({atom["id"] for atom in result["atoms"]}, {atom["id"] for atom in canvas["atoms"]})
        self.assertIn("cross", [arrow["id"] for arrow in result["arrows"]])
        self.assertNotIn("only-spare", [arrow["id"] for arrow in result["arrows"]])

    def test_shared_intermediate_does_not_pull_next_step_or_its_arrows(self):
        canvas = canvas_fixture()
        step = deepcopy(canvas["reactionSteps"][0])
        step.update({"stepId": "rs-next", "reactionArrowId": "ra-next", "reactants": ["pc"], "products": ["spare-c"]})
        canvas["reactionSteps"].append(step)
        canvas["reactionArrows"].append({"id": "ra-next", "stepId": "rs-next"})
        canvas["arrows"].append({"id": "next-flow", "electronCount": 2,
                                 "source": {"type": "bond", "bondId": "pc-po", "component": "sigma"},
                                 "target": {"type": "atom", "atomId": "po"}})
        result = select_canvas_steps(canvas, ["rs-sn2"])
        self.assertEqual([step["stepId"] for step in result["reactionSteps"]], ["rs-sn2"])
        self.assertEqual([arrow["id"] for arrow in result["reactionArrows"]], ["ra-sn2"])
        self.assertNotIn("next-flow", [arrow["id"] for arrow in result["arrows"]])
        combined = select_canvas_steps(canvas, ["rs-sn2", "rs-next"])
        self.assertIn("next-flow", [arrow["id"] for arrow in combined["arrows"]])

    def test_native_radical_source_keeps_its_flow_and_complete_target_component(self):
        canvas = canvas_fixture()
        canvas["arrows"].append({"id": "fishhook", "electronCount": 1,
                                  "source": {"type": "radical", "ownerAtomId": "nu"},
                                  "target": {"type": "atom", "atomId": "spare-o"}})
        result = select_canvas_steps(canvas, ["rs-sn2"])
        self.assertIn("fishhook", [arrow["id"] for arrow in result["arrows"]])
        self.assertIn("spare-c", [atom["id"] for atom in result["atoms"]])
        self.assertIn("spare-bond", [bond["id"] for bond in result["bonds"]])

    def test_automatic_pair_aim_and_shared_port_references_remain_resolvable(self):
        for reference_source in ("pair", "port"):
            with self.subTest(reference_source=reference_source):
                canvas = canvas_fixture()
                if reference_source == "pair":
                    canvas["lonePairs"][0]["refAtomId"] = "spare-o"
                else:
                    canvas["reactionSteps"][0]["ports"][0]["anchorRefs"] = ["spare-o"]
                result = select_canvas_steps(canvas, ["rs-sn2"])
                atom_ids = {atom["id"] for atom in result["atoms"]}
                self.assertTrue({"spare-o", "spare-c"} <= atom_ids)
                self.assertIn("spare-bond", [bond["id"] for bond in result["bonds"]])

    def test_unknown_steps_and_broken_participants_fail_instead_of_empty_success(self):
        canvas = canvas_fixture()
        for requested in ([], ["missing"], ["rs-sn2", "missing"], ["rs-sn2", "rs-sn2"]):
            with self.assertRaises(ValueError):
                select_canvas_steps(canvas, requested)
        canvas["reactionSteps"][0]["reactants"].append("missing-atom")
        with self.assertRaisesRegex(ValueError, "missing-atom"):
            select_canvas_steps(canvas, ["rs-sn2"])


class ServeStdioLoopTests(unittest.TestCase):
    """一次坏调用不能杀死整个 stdio 服务进程（P2）。"""

    def _serve(self, lines, handle_request=None, environ=None):
        stdin = io.BytesIO(("\n".join(lines) + "\n").encode("utf-8"))
        stdout = io.BytesIO()
        original = mcp_server.MolStudioMCPServer.handle_request
        if handle_request is not None:
            mcp_server.MolStudioMCPServer.handle_request = handle_request
        try:
            mcp_server.serve_stdio(stdin=stdin, stdout=stdout, environ=environ or {})
        finally:
            mcp_server.MolStudioMCPServer.handle_request = original
        return [json.loads(line) for line in stdout.getvalue().decode("utf-8").splitlines() if line.strip()]

    def test_broken_tool_call_returns_internal_error_and_loop_continues(self):
        real = mcp_server.MolStudioMCPServer.handle_request

        def flaky(self, message):
            if message.get("method") == "tools/call":
                raise ValueError("MOLSTUDIO_MCP_TIMEOUT_MS=abc")
            return real(self, message)

        responses = self._serve(
            [json.dumps({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                         "params": {"name": "molstudio_read_canvas"}}),
             json.dumps({"jsonrpc": "2.0", "id": 8, "method": "ping"})],
            handle_request=flaky)
        self.assertEqual(len(responses), 2)
        self.assertEqual(responses[0]["id"], 7)
        self.assertEqual(responses[0]["error"]["code"], -32603)
        self.assertIn("abc", responses[0]["error"]["message"])
        self.assertEqual(responses[1], {"jsonrpc": "2.0", "id": 8, "result": {}})

    def test_unserializable_response_falls_back_to_internal_error(self):
        def bad_response(self, message):
            return {"jsonrpc": "2.0", "id": message.get("id"), "result": {"object": object()}}

        responses = self._serve(
            [json.dumps({"jsonrpc": "2.0", "id": "abc", "method": "ping"})],
            handle_request=bad_response)
        self.assertEqual(len(responses), 1)
        self.assertEqual(responses[0]["id"], "abc")
        self.assertEqual(responses[0]["error"]["code"], -32603)

    def test_nonstandard_request_ids_are_answered_with_null(self):
        real = mcp_server.MolStudioMCPServer.handle_request

        def flaky(self, message):
            if message.get("method") == "tools/call":
                raise RuntimeError("boom")
            return real(self, message)

        responses = self._serve(
            [json.dumps({"jsonrpc": "2.0", "id": [1], "method": "tools/call", "params": {}}),
             json.dumps({"jsonrpc": "2.0", "id": True, "method": "tools/call", "params": {}}),
             '{"jsonrpc": "2.0", "id": "x", "method": "tools/call", "params":',  # 坏 JSON 也活下来
             json.dumps({"jsonrpc": "2.0", "id": 9, "method": "ping"})],
            handle_request=flaky)
        self.assertEqual([r.get("id") for r in responses], [None, None, None, 9])
        self.assertEqual([r["error"]["code"] for r in responses[:2]], [-32603, -32603])
        self.assertEqual(responses[2]["error"]["code"], -32700)  # 坏 JSON 走既有的解析错误分支

    def test_failing_notification_stays_silent(self):
        def always_raise(self, message):
            raise RuntimeError("boom")

        responses = self._serve(
            [json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"})],
            handle_request=always_raise)
        self.assertEqual(responses, [])


class EnvNumberParsingTests(unittest.TestCase):
    """非法数字环境变量回退默认并写一行警告，不让进程启动即死（P2）。"""

    def test_invalid_values_fall_back_with_warning(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(mcp_server._env_number({}, "MOLSTUDIO_MCP_TIMEOUT_MS", 60000), 60000)
            self.assertEqual(mcp_server._env_number({"MOLSTUDIO_MCP_TIMEOUT_MS": "abc"},
                                                    "MOLSTUDIO_MCP_TIMEOUT_MS", 60000), 60000)
            self.assertEqual(mcp_server._env_number({"MOLSTUDIO_MCP_TIMEOUT_MS": "12000"},
                                                    "MOLSTUDIO_MCP_TIMEOUT_MS", 60000), 12000)
            self.assertEqual(mcp_server._env_number({"MOLSTUDIO_MCP_TIMEOUT_MS": "0"},
                                                    "MOLSTUDIO_MCP_TIMEOUT_MS", 60000, minimum=1), 60000)
            self.assertEqual(mcp_server._env_number({"MOLSTUDIO_LAUNCH_WAIT_SECONDS": "abc"},
                                                    "MOLSTUDIO_LAUNCH_WAIT_SECONDS", 8.0, cast=float), 8.0)
            self.assertEqual(mcp_server._env_number({"MOLSTUDIO_LAUNCH_WAIT_SECONDS": "3"},
                                                    "MOLSTUDIO_LAUNCH_WAIT_SECONDS", 8.0, cast=float), 3.0)
        warnings = stderr.getvalue()
        self.assertIn("MOLSTUDIO_MCP_TIMEOUT_MS", warnings)
        self.assertIn("MOLSTUDIO_LAUNCH_WAIT_SECONDS", warnings)


if __name__ == "__main__":
    unittest.main()
