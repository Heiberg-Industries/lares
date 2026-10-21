"""Offline guard regressions; no Docker, database, gateway or provider calls."""
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch


PROBE = pathlib.Path(__file__).with_name("gateway-budget-image.probe.py")
SPEC = importlib.util.spec_from_file_location("gateway_budget_image_probe", PROBE)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class BudgetProofGuards(unittest.TestCase):
    def topology(self, folder):
        topology = probe.Topology.__new__(probe.Topology)
        topology.proof = {"cases": []}
        topology.artifact = pathlib.Path(folder) / "evidence.json"
        return topology

    def test_half_call_cap_four_admissions_cannot_pass(self):
        with tempfile.TemporaryDirectory() as folder:
            topology = self.topology(folder)
            measurement = probe.cap_observation("member", .5, 4)

            def unsafe_native_behavior():
                topology.proof["cases"][-1]["observations"] = measurement
                probe.require_configured_caps([measurement])

            topology.case("fixture", "concurrent", unsafe_native_behavior)
            row = topology.proof["cases"][-1]
            self.assertEqual(row["status"], "FAIL")
            self.assertEqual(row["observations"]["measuredOvershootUsd"], 3.5)
            self.assertFalse(all(item["status"] == "PASS" for item in topology.proof["cases"]))

    def test_sequential_overshoot_cannot_pass_but_exact_cap_can(self):
        with self.assertRaises(probe.ProbeError):
            probe.require_configured_caps([probe.cap_observation("member", 1.5, 2)])
        probe.require_configured_caps([probe.cap_observation("member", 2, 2)])
        with self.assertRaises(probe.ProbeError):
            probe.require_configured_caps([])

    def test_missing_cost_cannot_serve_as_cap_measurement(self):
        for invalid in (None, float("nan"), float("inf")):
            with self.subTest(invalid=invalid), self.assertRaises(probe.ProbeError):
                probe.cap_observation("member", 1, invalid)

    def test_unrelated_errors_cannot_prove_budget_refusal(self):
        for status in (404, 429, 500):
            with self.subTest(status=status), self.assertRaises(probe.ProbeError):
                probe.require_budget_refusal({"status": status}, 0, recognized=False)
        # Even a recognizer bug cannot turn a server error into a cap refusal.
        with self.assertRaises(probe.InfrastructureError):
            probe.require_budget_refusal({"status": 500}, 0, recognized=True)
        probe.require_budget_refusal({"status": 429}, 0, recognized=True)
        with self.assertRaises(probe.ProbeError):
            probe.require_budget_refusal({"status": 429}, 1, recognized=True)

    def test_budget_method_uses_actual_recognizer_result(self):
        topology = probe.Topology.__new__(probe.Topology)
        topology.count = Mock(return_value=0)
        topology.call = Mock(return_value={"status": 404, "body": {"error": {"type": "not_found"}}})
        topology.node = Mock(return_value={"recognized": False})
        with self.assertRaises(probe.ProbeError):
            topology.budget_refused("fixture", "fixture-key")
        self.assertEqual(topology.node.call_args.args[0]["kind"], "classify")

    def test_auth_and_budget_refusal_are_distinct(self):
        for status in (404, 429, 500):
            with self.subTest(status=status), self.assertRaises(probe.ProbeError):
                probe.require_auth_refusal({"status": status}, 0)
        probe.require_auth_refusal({"status": 401}, 0)
        probe.require_auth_refusal({"status": 403}, 0)
        with self.assertRaises(probe.ProbeError):
            probe.require_auth_refusal({"status": 401}, 1)

    def test_missing_identity_accepts_only_verified_zero_upstream_refusal(self):
        probe.require_identity_refusal({"status":429},0,budget_recognized=True)
        probe.require_identity_refusal({"status":401},0)
        for status,delta,recognized in ((429,0,False),(429,1,True),(200,1,False),(404,0,False),(500,0,False)):
            with self.subTest(status=status,delta=delta),self.assertRaises(probe.ProbeError):
                probe.require_identity_refusal({"status":status},delta,recognized)

    def test_initial_sdk_failure_is_preserved_without_raw_error(self):
        with tempfile.TemporaryDirectory() as folder:
            topology=self.topology(folder)
            topology.node=Mock(return_value={"ok":False,"requests":1,"attempts":1,"status":400,"errorCode":"invalid_request_error","sdkFailure":"api-call","message":"sk-private-value","body":{"key":"sk-private-value"}})
            topology.control=Mock(side_effect=[{"routes":{"chat-completions":0,"messages":0,"other":0}},{"routes":{"chat-completions":0,"messages":1,"other":0}}])

            def initial_sdk():
                topology.stage("serial-sdk-anthropic")
                result=topology.sdk("fixture","fixture-key","anthropic")
                probe.require(result["ok"],"actual SDK call failed before cap")

            topology.case("fixture","serial",initial_sdk)
            row=topology.proof["cases"][-1]
            self.assertEqual(row["status"],"FAIL")
            self.assertEqual(row["stage"],"serial-sdk-anthropic")
            self.assertEqual(row["sdkRequests"][0]["status"],400)
            self.assertEqual(row["sdkRequests"][0]["errorCode"],"invalid_request_error")
            self.assertEqual(row["sdkRequests"][0]["upstreamRouteDelta"],{"chat-completions":0,"messages":1,"other":0})
            self.assertNotIn("sk-private-value",topology.artifact.read_text())

    def test_seed_http_failure_is_preserved_without_response_body(self):
        with tempfile.TemporaryDirectory() as folder:
            topology=self.topology(folder)
            topology.count=Mock(return_value=0)
            topology.call=Mock(return_value={"status":429,"body":{"error":{"type":"budget_exceeded","message":"sk-private-value"}}})

            def seed():
                result=topology.diagnostic_call("fixture","fixture-key","sdk-refusal-seed")
                probe.require(result["status"]==200,"initial priced call failed")

            topology.case("fixture","seed",seed)
            row=topology.proof["cases"][-1]
            self.assertEqual(row["stage"],"sdk-refusal-seed")
            self.assertEqual(row["httpRequests"][0],{"stage":"sdk-refusal-seed","status":429,"errorCode":"budget_exceeded","upstreamDelta":0})
            self.assertNotIn("sk-private-value",topology.artifact.read_text())

    def test_unknown_diagnostic_codes_and_names_are_not_copied(self):
        summary=probe.http_diagnostic({"status":400,"body":{"error":{"type":"sk-private-value","code":"arbitrary provider text"}}})
        self.assertEqual(summary,{"status":400,"errorCode":"unclassified"})
        sdk=probe.sdk_diagnostic({"ok":False,"status":400,"errorCode":"sk-private-value","sdkFailure":"arbitrary name","message":"sk-private-value"})
        self.assertEqual(sdk["errorCode"],"unclassified")
        self.assertEqual(sdk["sdkFailure"],"unclassified")
        self.assertNotIn("sk-private-value",str(sdk))

    def test_restore_command_failure_records_exact_fixed_stage(self):
        with tempfile.TemporaryDirectory() as folder:
            topology=self.topology(folder)
            topology.name="fixture"
            topology.fixture=Mock(return_value=("team",["member"],{("member","alpha"):"fixture-key"}))
            topology.count=Mock(return_value=0)
            topology.call=Mock(return_value={"status":200,"body":{}})
            topology.settled=Mock(return_value={})
            topology.exhaust_member_policy=Mock()

            def command(*args,**kwargs):
                if "dropdb" in args:
                    raise probe.InfrastructureError("disposable command failed (raw diagnostics withheld)")
                return "fixture dump"

            with patch.object(probe,"shell",side_effect=command):
                topology.case("fixture","restore",lambda:topology.restore("fixture"))
            row=topology.proof["cases"][-1]
            self.assertEqual(row["status"],"FAIL")
            self.assertEqual(row["stage"],"restore-drop-database")
            self.assertEqual(row["failureKind"],"harness-or-api-compatibility")

    def test_command_diagnostics_keep_only_exit_and_fixed_reason(self):
        with tempfile.TemporaryDirectory() as folder:
            topology=self.topology(folder)
            completed=subprocess.CompletedProcess([],1,"sk-private-output",'dropdb: error: database "private-db" is being accessed by other users sk-private-value')
            with patch.object(probe.subprocess,"run",return_value=completed):
                topology.case("fixture","restore",lambda:topology.staged_shell("restore-drop-database","docker","exec","private-container","dropdb"))
            row=topology.proof["cases"][-1]
            self.assertEqual(row["commandDiagnostic"],{"exitClass":"exit","exitCode":1,"reason":"database-in-use"})
            self.assertEqual(row["failureKind"],"harness-or-api-compatibility")
            for private in ("sk-private-output","private-db","sk-private-value","private-container"):
                self.assertNotIn(private,topology.artifact.read_text())
        unknown=probe.CommandError(-9,"sk-private-value")
        self.assertEqual(unknown.diagnostic,{"exitClass":"signal","exitCode":-9,"reason":"unclassified"})
        self.assertNotIn("sk-private-value",str(unknown))

    def test_sdk_routes_are_bounded_and_unknown_paths_are_not_copied(self):
        result=probe.sdk_diagnostic({"ok":False,"httpRequests":[{"route":"messages","status":404,"url":"sk-private-value"},{"route":"sk-private-value","status":700}]*100})
        self.assertEqual(len(result["httpRequests"]),100)
        self.assertEqual(result["httpRequests"][:2],[{"route":"messages","status":404},{"route":"other","status":0}])
        self.assertNotIn("sk-private-value",str(result))
        for bad in ({},{"routes":{"chat-completions":0,"messages":0,"other":"sk-private-value"}},{"routes":{"chat-completions":0,"messages":0,"other":-1}}):
            with self.assertRaises(probe.InfrastructureError):
                probe.route_counts(bad)
        self.assertEqual(probe.route_counts({"routes":{"chat-completions":0,"messages":1,"other":2,"sk-private-value":3}}),{"chat-completions":0,"messages":1,"other":2})

    def test_refusal_policy_changes_verified_cap_without_manufacturing_spend(self):
        with tempfile.TemporaryDirectory() as folder:
            topology=self.topology(folder)
            topology.cost=1
            topology.sql=Mock(side_effect=['{"spend":1,"maxBudget":100}',"UPDATE 1",'{"spend":1,"maxBudget":0.5}'])
            topology.case("fixture","policy",lambda:topology.exhaust_member_policy("fixture","team","member","sdk-refusal"))
            row=topology.proof["cases"][-1]
            self.assertEqual(row["status"],"PASS")
            self.assertEqual(row["fixturePolicy"]["persistedMemberSpendUsd"],1)
            self.assertEqual(row["fixturePolicy"]["exhaustedCapUsd"],.5)
            update=topology.sql.call_args_list[1].args[1]
            self.assertIn('UPDATE "LiteLLM_BudgetTable"',update)
            self.assertNotIn("SET spend",update)
            self.assertEqual(topology.sql.call_args_list[0],topology.sql.call_args_list[2])

    def test_missing_or_changed_policy_cannot_prove_exhaustion(self):
        for initial,after in (({"spend":1,"maxBudget":.5},{"spend":1,"maxBudget":.5}),({"spend":1,"maxBudget":100},{"spend":2,"maxBudget":.5}),({"spend":1,"maxBudget":100},{"spend":1,"maxBudget":100})):
            with self.subTest(initial=initial,after=after),tempfile.TemporaryDirectory() as folder:
                topology=self.topology(folder)
                topology.cost=1
                topology.sql=Mock(side_effect=[probe.json.dumps(initial),"UPDATE 1",probe.json.dumps(after)])
                topology.case("fixture","policy",lambda:topology.exhaust_member_policy("fixture","team","member","sdk-refusal"))
                self.assertEqual(topology.proof["cases"][-1]["status"],"FAIL")
                self.assertEqual(topology.proof["cases"][-1]["failureKind"],"harness-or-api-compatibility")

    def test_sdk_refusal_seeds_usable_policy_and_restarts_before_testing(self):
        with tempfile.TemporaryDirectory() as folder:
            topology=self.topology(folder)
            topology.name="fixture"
            topology.fixture=Mock(return_value=("team",["member"],{("member","alpha"):"fixture-key"}))
            topology.diagnostic_call=Mock(return_value={"status":200})
            topology.settled=Mock()
            topology.exhaust_member_policy=Mock()
            topology.ready=Mock(return_value=True)
            topology.count=Mock(return_value=0)
            response={"ok":False,"recognized":True,"classification":"terminal","requests":1,"attempts":1,"visibleRefusals":1,"silentSession":True,"upstreamRouteDelta":dict.fromkeys(probe.ROUTES,0)}
            def sdk(*args,**kwargs):
                self.assertTrue(topology.ready.called)
                topology.exhaust_member_policy.assert_called_once_with("fixture","team","member","sdk-refusal")
                return response
            topology.sdk=Mock(side_effect=sdk)
            with patch.object(probe,"shell",return_value="") as command:
                topology.case("fixture","sdk",lambda:topology.sdk_refusal("fixture"))
            topology.fixture.assert_called_once_with("fixture",100,100)
            command.assert_called_once_with("docker","restart","fixture-fixture")
            self.assertEqual(topology.proof["cases"][-1]["status"],"PASS")
            response["upstreamRouteDelta"]["messages"]=1
            with patch.object(probe,"shell",return_value=""):
                topology.exhaust_member_policy.reset_mock()
                topology.case("fixture","sdk",lambda:topology.sdk_refusal("fixture"))
            self.assertEqual(topology.proof["cases"][-1]["status"],"FAIL")
            self.assertEqual(topology.proof["cases"][-1]["reason"],"capped SDK retry reached upstream")

    def test_unknown_member_server_error_is_not_a_safe_rejection(self):
        for status in (0, 500, 503):
            with self.subTest(status=status), self.assertRaises(probe.InfrastructureError):
                probe.provisioning_rejected(status)
        self.assertFalse(probe.provisioning_rejected(200))
        self.assertTrue(probe.provisioning_rejected(403))

    def test_poll_does_not_hide_schema_or_parse_failure(self):
        for failure in (probe.InfrastructureError("schema unavailable"), ValueError("invalid JSON")):
            with self.subTest(failure=type(failure).__name__):
                action = Mock(side_effect=failure)
                with self.assertRaises(type(failure)) as raised:
                    probe.eventually(action, "must not replace failure", timeout=1)
                self.assertIs(raised.exception, failure)
                self.assertEqual(action.call_count, 1)

    def test_explicit_transient_startup_retry_preserves_error_class(self):
        action = Mock(side_effect=probe.InfrastructureError("not ready"))
        with patch.object(probe.time, "monotonic", side_effect=[0, 0, 2]), patch.object(probe.time, "sleep"):
            with self.assertRaises(probe.InfrastructureError):
                probe.eventually(action, "startup unavailable", timeout=1,
                                 retry_on=(probe.InfrastructureError,), timeout_error=probe.InfrastructureError)

    def test_schema_failure_is_recorded_as_infrastructure(self):
        with tempfile.TemporaryDirectory() as folder:
            topology = self.topology(folder)
            action = Mock(side_effect=probe.InfrastructureError("schema unavailable"))
            topology.case("fixture", "poll", lambda: probe.eventually(action, "missing spend"))
            row = topology.proof["cases"][-1]
            self.assertEqual(row["status"], "FAIL")
            self.assertEqual(row["failureKind"], "harness-or-api-compatibility")


if __name__ == "__main__":
    unittest.main()
