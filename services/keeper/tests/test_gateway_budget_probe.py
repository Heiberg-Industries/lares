"""Offline guard regressions; no Docker, database, gateway or provider calls."""
import importlib.util
import pathlib
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
