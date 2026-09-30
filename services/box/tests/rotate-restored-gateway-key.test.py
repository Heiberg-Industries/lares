"""Safety checks for the manual fresh-target restore repair."""

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "ops" / "rotate-restored-gateway-key.py"
spec = importlib.util.spec_from_file_location("restore_gateway_key", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RestoreGatewayKeyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.compose = root / "compose.yaml"
        self.compose.write_text("services: {}\n")
        self.secrets = root / "secrets"
        self.secrets.mkdir()
        self.master_key = root / "installed" / "gateway-master-key"
        self.master_key.parent.mkdir()
        self.master_key.write_text("sk-synthetic-master-key")

    def run_main(self, execute=False):
        args = ["repair", "--agent", "example", "--compose", str(self.compose),
                "--secrets-dir", str(self.secrets),
                "--master-key-file", str(self.master_key)]
        if execute:
            args.append("--execute")
        with patch.object(sys, "argv", args), patch.object(module.os, "geteuid", return_value=0):
            module.main()

    def test_existing_plaintext_refuses_before_database_or_gateway(self):
        (self.secrets / "example-gateway-key").write_text("sk-still-present")
        with patch.object(module, "command") as command, patch.object(module, "gateway") as gateway:
            with self.assertRaisesRegex(SystemExit, "plaintext gateway key exists"):
                self.run_main(execute=True)
            command.assert_not_called()
            gateway.assert_not_called()

    def test_dry_run_checks_exact_orphan_without_deleting(self):
        resource = [{"name": "example", "state": "ready", "ownership": "owned", "controlled": True}]
        key = [{"token": "a" * 64, "key_alias": "lares-agent-example", "key_type": "llm_api",
                "max_budget": 5, "budget_duration": "1d",
                "models": [f"lares-{p}" for p in ("brain", "writer", "utility", "gate", "embed")],
                "metadata": {"managed_by": "lares", "agent": "example"}}]
        with patch.object(module, "command", return_value=""), \
             patch.object(module, "rows", side_effect=[resource, key]), \
             patch.object(module, "gateway", return_value=[{"key_alias": "lares-agent-example"}]) as gateway:
            self.run_main()
            gateway.assert_called_once_with("sk-synthetic-master-key", "v2/key/info", "a" * 64)

    def test_execute_deletes_only_after_exact_checks_and_verifies_absence(self):
        resource = [{"name": "example", "state": "ready", "ownership": "owned", "controlled": True}]
        key = [{"token": "b" * 64, "key_alias": "lares-agent-example", "key_type": "llm_api",
                "max_budget": 5, "budget_duration": "1d",
                "models": [f"lares-{p}" for p in ("brain", "writer", "utility", "gate", "embed")],
                "metadata": {"managed_by": "lares", "agent": "example"}}]
        with patch.object(module, "command", return_value=""), \
             patch.object(module, "rows", side_effect=[resource, key]), \
             patch.object(module, "gateway", side_effect=[[{"key_alias": "lares-agent-example"}], [], []]) as gateway:
            self.run_main(execute=True)
            self.assertEqual([call.args[1] for call in gateway.call_args_list],
                             ["v2/key/info", "key/delete", "v2/key/info"])


if __name__ == "__main__":
    unittest.main()
