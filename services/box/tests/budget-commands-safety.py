"""Step order, interruption and refusal checks for `lares budget setup` and `lares agent start`.

Docker is a stub on PATH and the keeper is a small socket server, so these prove what the commands
ask for and in what order. They do not prove that a real server accepts it.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import socket
import stat
import sys
import tempfile
import threading
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "ops" / "budget-commands.py"
spec = importlib.util.spec_from_file_location("budget_commands", SCRIPT)
budget = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules["budget_commands"] = budget
spec.loader.exec_module(budget)

IMAGE = "example.invalid/keeper@sha256:" + "a" * 64
OWNER = "stable-owner"
INCARNATION = "11111111-1111-4111-8111-111111111111"

FAKE_DOCKER = r"""#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
prefix = pathlib.Path(os.environ["FAKE_PREFIX"])
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")
fail = os.environ.get("FAKE_FAIL", "")
text = " ".join(args)
if fail and fail in text:
    print("refused by the stub", file=sys.stderr)
    sys.exit(1)
if "render-native-policy.ts" in text:
    request = json.load(sys.stdin)
    print(json.dumps({"policy": {"endpointHash": "e" * 64, "policies": []}, "maximumLiability": "1.0346",
                      "model": request["providerModel"], "installationLimit": request["installationLimit"],
                      "personLimit": request["personLimit"], "prices": request["prices"]}))
elif "prepare-fresh" in args:
    (prefix / "var/lib/lares/budget-financial").mkdir(parents=True)
    print("Fresh financial custody prepared.")
    print(json.dumps({"budgetFinancial": {"directory": "/var/lib/lares/budget-financial", "db": {"user": "lares_financial"}}}))
elif "prepare-native" in args:
    (prefix / "var/lib/lares/budget-native").mkdir(parents=True)
    print("Fresh native custody prepared.")
elif "render-gateway-authority-stage.ts" in text:
    json.load(sys.stdin)
    stage = pathlib.Path(args[-1])
    stage.mkdir(mode=0o700)
    (stage / "compose.yaml").write_text("services: {staged: true}\n")
    (stage / "keeper.json").write_text('{"staged": "must never be applied"}\n')
    (stage / "keeper.env").write_text("".join(f"{name}=/staged/{name}\n" for name in [
        "LARES_GATEWAY_BUDGET_SERVICE_KEY_FILE", "LARES_NATIVE_POLICY_FILE",
        "LARES_GATEWAY_BUDGET_SERVICE_KEY_TARGET", "LARES_NATIVE_POLICY_TARGET"]) + "LARES_KEEPER_IMAGE=staged-must-not-apply\n")
    (stage / ".complete.json").write_text("{}\n")
elif args[:1] == ["compose"] and "ps" in args:
    print("gateway-container")
elif args[:1] == ["inspect"]:
    print(os.environ.get("FAKE_GATEWAY", "true 0"))
"""


class FakeKeeper:
    """Answers the host-only socket from a dictionary and records every request."""

    def __init__(self, path: Path) -> None:
        self.requests: list[dict] = []
        self.answers: dict[str, object] = {}
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.server.bind(str(path))
        self.server.listen(16)
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self) -> None:
        while True:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            with client:
                data = b""
                while not data.endswith(b"\n"):
                    chunk = client.recv(65536)
                    if not chunk:
                        break
                    data += chunk
                request = json.loads(data)
                self.requests.append(request)
                answer = self.answers.get(request["action"], {"ok": True, "result": {}})
                if callable(answer):
                    answer = answer(request)
                client.sendall((json.dumps(answer) + "\n").encode())

    def actions(self) -> list[str]:
        return [request["action"] for request in self.requests]

    def close(self) -> None:
        self.server.close()


def ok(result: object) -> dict:
    return {"ok": True, "result": result}


def status(**overrides: object) -> dict:
    value = {
        "agent": {"status": "valid", "model": "lares-brain", "incarnation": INCARNATION, "state": "ready",
                  "pending": False, "pendingReason": None, "owned": True},
        "member": {"id": OWNER, "active": True, "verified": True, "limit": "15", "canUse": True},
        "installation": {"state": "closed"}, "account": None, "binding": None,
    }
    value.update(overrides)
    return value


class BudgetCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        # Short on purpose: a Unix socket path has a small length limit.
        self.temporary = tempfile.TemporaryDirectory(prefix="lb-", dir="/tmp")
        self.prefix = Path(self.temporary.name)
        budget.ROOT_UID = os.geteuid()
        budget.ROOT_GID = os.getegid()
        budget.GATEWAY_WATCH_SECONDS = 0
        budget.KEEPER_START_SECONDS = 1
        etc = self.prefix / "etc/lares"
        (etc / "secrets").mkdir(parents=True)
        (etc / "operator").mkdir()
        (self.prefix / "opt/lares").mkdir(parents=True)
        (self.prefix / "srv/lares/agents").mkdir(parents=True)
        (self.prefix / "var/lib/lares-maintenance").mkdir(parents=True)
        (self.prefix / "var/lib/lares").mkdir(parents=True)
        (etc / "installation.env").write_text("LARES_MODEL=anthropic/claude-opus-5\nLARES_MODEL_ALIAS=lares-brain\nGATEWAY_URL=http://lares-gateway:4000\n")
        (etc / "console-oauth.env").write_text('CONSOLE_BOOTSTRAP_IDENTITY={"ownerId":"stable-owner"}\n')
        operator = etc / "operator/database-password"
        operator.write_text("operator-secret\n")
        operator.chmod(0o600)
        self.keeper_json = etc / "keeper.json"
        self.original = {"project": "lares", "db": {"database": "lares_state"}, "lifecycle": {"network": "lares-network", "subnet": "172.30.0.0/24"},
                         "outsideCustody": {"keep": True}, "credentials": {"administrator": "owner@example.test"}}
        self.keeper_json.write_text(json.dumps(self.original))
        self.keeper_json.chmod(0o600)
        self.env_file = etc / "keeper.env"
        self.env_text = "".join([
            "LARES_KEEPER_IMAGE=installed-image\n", "LARES_NETWORK=lares-network\n", "LARES_PROXY_ADDRESS=172.30.0.254\n",
            "LARES_MAINTENANCE_ADMISSION_DIR=/var/lib/lares-maintenance/admission\n", "LARES_MAINTENANCE_INSTALLATION_ID=id\n", "LARES_MAINTENANCE_EPOCH=1\n",
            "LARES_GATEWAY_BUDGET_SERVICE_KEY_FILE=/dev/null\n", "LARES_NATIVE_POLICY_FILE=/dev/null\n",
            "LARES_GATEWAY_BUDGET_SERVICE_KEY_TARGET=/run/secrets/gateway-budget-unused-key\n", "LARES_NATIVE_POLICY_TARGET=/etc/lares/native-policy-unused.json\n",
            'LARES_VAULT_WORKING_ROOT="/srv/vault"\n', 'COMPOSE_FILE="/opt/lares/compose.lares-keeper.yaml"\n',
        ])
        self.env_file.write_text(self.env_text)
        (self.prefix / "opt/lares/compose.yaml").write_text("services: {installed: true}\n")
        self.release = self.prefix / "release.json"
        self.release.write_text("{}")
        bin_dir = self.prefix / "bin"
        bin_dir.mkdir()
        docker = bin_dir / "docker"
        docker.write_text(FAKE_DOCKER)
        docker.chmod(0o755)
        self.log = self.prefix / "docker.log"
        self.saved_environment = dict(os.environ)
        os.environ.update(PATH=f"{bin_dir}:{os.environ['PATH']}", FAKE_PREFIX=str(self.prefix), FAKE_LOG=str(self.log))
        self.keeper = FakeKeeper(self.prefix / "run/lares-host/keeper.sock")

    def tearDown(self) -> None:
        self.keeper.close()
        os.environ.clear()
        os.environ.update(self.saved_environment)
        self.temporary.cleanup()

    def run_command(self, *arguments: str) -> tuple[int, str]:
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = budget.main(["--prefix", str(self.prefix), "--image", IMAGE, "--release", str(self.release), *arguments])
        return code, output.getvalue()

    def setup_answers(self) -> tuple[str, ...]:
        return ("setup", "--installation-limit", "100", "--person-limit", "15", "--yes")

    def docker_calls(self) -> list[list[str]]:
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def called(self, text: str) -> bool:
        return any(text in " ".join(call) for call in self.docker_calls())

    def mark_setup_done(self) -> None:
        (self.prefix / "etc/lares/budget-setup.json").write_text(json.dumps({
            "version": 1, "complete": True, "alias": "lares-brain", "installationLimit": "100", "personLimit": "15",
            "policy": {}, "stageDirectory": None, "bindings": {},
        }))

    # budget setup

    def test_setup_runs_the_sheet_in_order_and_applies_only_the_agreed_files(self) -> None:
        code, output = self.run_command(*self.setup_answers())
        self.assertEqual(code, 0, output)
        order = [text for call in self.docker_calls() for text in ("render-native-policy.ts", "prepare-fresh", "prepare-native",
                 "render-gateway-authority-stage.ts", "--force-recreate", "lares-gateway") if text in " ".join(call)]
        self.assertEqual(order[:5], ["render-native-policy.ts", "prepare-fresh", "prepare-native", "render-gateway-authority-stage.ts", "--force-recreate"])
        self.assertIn("lares-gateway", order[5:])
        stop = next(index for index, call in enumerate(self.docker_calls()) if "stop" in call)
        prepare = next(index for index, call in enumerate(self.docker_calls()) if "prepare-fresh" in call)
        self.assertLess(stop, prepare)

        config = json.loads(self.keeper_json.read_text())
        for name, value in self.original.items():
            self.assertEqual(config[name], value, f"{name} must survive")
        self.assertEqual(config["budgetNative"], {"directory": "/var/lib/lares/budget-native", "reviewedPolicyFile": "/etc/lares/native-policy.json"})
        self.assertEqual(config["gatewayBudget"], {"serviceKeyFile": "/etc/lares/secrets/gateway-budget-service-key"})
        self.assertNotIn("staged", config)

        self.assertEqual((self.prefix / "opt/lares/compose.yaml").read_text(), "services: {staged: true}\n")
        env = self.env_file.read_text()
        for line in ('LARES_VAULT_WORKING_ROOT="/srv/vault"', 'COMPOSE_FILE="/opt/lares/compose.lares-keeper.yaml"', "LARES_KEEPER_IMAGE=installed-image"):
            self.assertIn(line, env)
        for name in budget.BUDGET_ENV_LINES:
            self.assertIn(f"{name}=/staged/{name}", env)
        self.assertNotIn("staged-must-not-apply", env)

        key = self.prefix / "etc/lares/secrets/gateway-budget-service-key"
        self.assertEqual(key.stat().st_size, 32)
        self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.prefix / "etc/lares/native-policy.json").stat().st_mode), 0o600)
        state = json.loads((self.prefix / "etc/lares/budget-setup.json").read_text())
        self.assertTrue(state["complete"])
        self.assertEqual(state["installationLimit"], "100")
        self.assertEqual(list((self.prefix / "var/lib/lares-budget-setup").iterdir()), [])

    def test_setup_passes_the_exact_stage_request_on_stdin_and_never_a_secret_in_argv(self) -> None:
        code, output = self.run_command(*self.setup_answers())
        self.assertEqual(code, 0, output)
        self.assertNotIn("operator-secret", self.log.read_text())
        guarded = next(call for call in self.docker_calls() if "prepare-fresh" in call)
        self.assertNotIn("--entrypoint", guarded)
        self.assertIn("no-new-privileges", guarded)
        self.assertEqual(guarded[guarded.index(IMAGE):guarded.index(IMAGE) + 5], [IMAGE, "/run/lares-maintenance/admission", "id", "1", "--"])
        self.assertEqual(guarded[-2:], ["--operator-password-file", "/etc/lares/operator/database-password"])

    def test_a_finished_setup_changes_nothing_when_run_again(self) -> None:
        self.assertEqual(self.run_command(*self.setup_answers())[0], 0)
        before = self.log.read_text()
        code, output = self.run_command(*self.setup_answers())
        self.assertEqual(code, 0)
        self.assertIn("already done", output)
        self.assertEqual(self.log.read_text(), before)

    def test_a_ledger_left_behind_by_an_interruption_stops_with_the_reinstall_answer(self) -> None:
        (self.prefix / "etc/lares/budget-setup.json").write_text(json.dumps({"complete": False, "policy": {}, "stageDirectory": None, "bindings": {}}))
        (self.prefix / "var/lib/lares/budget-financial").mkdir()
        code, output = self.run_command("setup")
        self.assertEqual(code, budget.EX_REFUSED)
        self.assertIn("wipe it and install", output)
        self.assertFalse(self.called("prepare-fresh"))
        self.assertTrue((self.prefix / "var/lib/lares/budget-financial").is_dir(), "evidence is kept, never removed")

    def test_a_ledger_step_refused_before_writing_can_simply_be_run_again(self) -> None:
        os.environ["FAKE_FAIL"] = "prepare-fresh"
        code, output = self.run_command(*self.setup_answers())
        self.assertEqual(code, budget.EX_REFUSED)
        self.assertIn("before it wrote anything", output)
        del os.environ["FAKE_FAIL"]
        code, output = self.run_command("setup")
        self.assertEqual(code, 0, output)
        self.assertIn("with the answers you gave then", output)
        self.assertEqual(json.loads((self.prefix / "etc/lares/budget-setup.json").read_text())["personLimit"], "15")

    def test_a_stop_after_the_ledgers_continues_without_repeating_them(self) -> None:
        os.environ["FAKE_FAIL"] = "render-gateway-authority-stage.ts"
        code, output = self.run_command(*self.setup_answers())
        self.assertEqual(code, budget.EX_REFUSED)
        self.assertIn("Preparing the gateway settings was refused", output)
        self.assertEqual(self.env_file.read_text(), self.env_text, "nothing is applied from a refused stage")
        del os.environ["FAKE_FAIL"]
        self.log.write_text("")
        code, output = self.run_command("setup")
        self.assertEqual(code, 0, output)
        self.assertFalse(self.called("prepare-fresh"))
        self.assertFalse(self.called("prepare-native"))
        self.assertTrue(self.called("render-gateway-authority-stage.ts"))

    def test_a_half_applied_stage_is_reused_rather_than_rendered_against_a_mixed_state(self) -> None:
        os.environ["FAKE_GATEWAY"] = "true 3"
        code, output = self.run_command(*self.setup_answers())
        self.assertEqual(code, budget.EX_REFUSED)
        self.assertIn("did not stay up", output)
        del os.environ["FAKE_GATEWAY"]
        self.log.write_text("")
        code, output = self.run_command("setup")
        self.assertEqual(code, 0, output)
        self.assertFalse(self.called("render-gateway-authority-stage.ts"))
        self.assertTrue(json.loads((self.prefix / "etc/lares/budget-setup.json").read_text())["complete"])

    def test_refused_limits_change_nothing(self) -> None:
        os.environ["FAKE_FAIL"] = "render-native-policy.ts"
        code, output = self.run_command(*self.setup_answers())
        self.assertEqual(code, budget.EX_REFUSED)
        self.assertIn("Nothing was changed", output)
        self.assertFalse((self.prefix / "etc/lares/budget-setup.json").exists())
        self.assertFalse(any("stop" in call for call in self.docker_calls()))

    def test_setup_refuses_settings_it_did_not_make_and_an_existing_agent(self) -> None:
        self.keeper_json.write_text(json.dumps({**self.original, "budgetFinancial": {"directory": "x"}}))
        code, output = self.run_command(*self.setup_answers())
        self.assertEqual(code, budget.EX_REFUSED)
        self.assertIn("will not adopt", output)
        self.keeper_json.write_text(json.dumps(self.original))
        (self.prefix / "srv/lares/agents/my-agent").mkdir()
        code, output = self.run_command(*self.setup_answers())
        self.assertEqual(code, budget.EX_REFUSED)
        self.assertIn("before the first agent", output)
        self.assertFalse(self.called("prepare-fresh"))

    def test_setup_needs_the_owner_confirmed_first(self) -> None:
        (self.prefix / "etc/lares/console-oauth.env").write_text("GOOGLE_CLIENT_ID_CONSOLE=x\n")
        code, output = self.run_command(*self.setup_answers())
        self.assertEqual(code, budget.EX_REFUSED)
        self.assertIn("owner-bootstrap", output)

    def test_only_the_four_budget_lines_change_in_keeper_env(self) -> None:
        staged = "".join(f"{name}=/new\n" for name in budget.BUDGET_ENV_LINES)
        merged = budget.env_with_budget_lines(self.env_text, staged + "OTHER=no\n")
        changed = [(a, b) for a, b in zip(self.env_text.splitlines(), merged.splitlines()) if a != b]
        self.assertEqual(len(changed), 4)
        self.assertEqual(len(merged.splitlines()), len(self.env_text.splitlines()))
        with self.assertRaises(budget.Stop):
            budget.env_with_budget_lines("LARES_KEEPER_IMAGE=x\n", staged)
        with self.assertRaises(budget.Stop):
            budget.env_with_budget_lines(self.env_text, "LARES_NATIVE_POLICY_FILE=/new\n")

    # agent start

    def start_flow(self, first: dict, after_key: dict, running: object = False) -> None:
        answers = [first, after_key, after_key]
        self.keeper.answers["budget.agent-start-status"] = lambda request: ok(answers.pop(0) if len(answers) > 1 else answers[0])
        self.keeper.answers["budget.provision-accounts"] = ok({"state": "closed", "reason": "unreconciled", "members": 1, "accountsCreated": 1, "windowsCreated": 1})
        self.keeper.answers["budget.provision-native"] = ok({"state": "bound-closed"})
        self.keeper.answers["budget.activate-native"] = ok({"state": "active"})
        self.keeper.answers["definition.list"] = ok([{"name": "my-agent", "hash": "d" * 64, "status": "valid"}])
        self.keeper.answers["definition.get"] = ok({"name": "my-agent", "runtime": {"running": running}})
        self.keeper.answers["definition.reconcile"] = ok({"running": True, "healthy": True, "pending": False, "reason": None})

    def test_agent_start_runs_each_step_once_in_order_for_the_owner(self) -> None:
        self.mark_setup_done()
        bound = status(account={"state": "closed"}, binding={"id": "b1", "credentialGeneration": "0"})
        self.start_flow(status(), bound)
        code, output = self.run_command("agent-start", "my-agent")
        self.assertEqual(code, 0, output)
        self.assertEqual(self.keeper.actions(), ["budget.agent-start-status", "budget.provision-accounts", "budget.provision-native",
                         "budget.agent-start-status", "budget.activate-native", "definition.list", "definition.get", "definition.reconcile"])
        requests = {request["action"]: request["input"] for request in self.keeper.requests}
        self.assertEqual(requests["budget.provision-accounts"], {"installationCap": "100", "memberIds": [OWNER]})
        native = requests["budget.provision-native"]
        self.assertEqual({key: native[key] for key in ("credentialGeneration", "memberId", "agent", "incarnation", "purposeAlias")},
                         {"credentialGeneration": "0", "memberId": OWNER, "agent": "my-agent", "incarnation": INCARNATION, "purposeAlias": "lares-brain"})
        self.assertEqual(requests["budget.activate-native"], {"bindingId": "b1", "credentialGeneration": "0"})
        self.assertEqual(requests["definition.reconcile"], {"name": "my-agent", "hash": "d" * 64})

    def test_a_second_person_gets_the_default_limit_and_the_running_agent_is_not_restarted(self) -> None:
        self.mark_setup_done()
        second = {"id": "second-person", "active": True, "verified": True, "limit": None, "canUse": True}
        bound = status(member={**second, "limit": "15"}, account={"state": "closed"}, binding={"id": "b2", "credentialGeneration": "0"})
        self.start_flow(status(member=second), bound, running=True)
        code, output = self.run_command("agent-start", "my-agent", "--member", "second@example.test")
        self.assertEqual(code, 0, output)
        self.assertIn("default of $15", output)
        self.assertEqual(self.keeper.requests[0]["input"], {"agent": "my-agent", "member": "second@example.test"})
        self.assertEqual(self.keeper.requests[1], {"action": "budget.apply-default-member-limit", "input": {"memberId": "second-person", "monthlyLimit": "15"}})
        self.assertNotIn("definition.reconcile", self.keeper.actions())

    def test_a_limit_the_owner_chose_is_left_alone(self) -> None:
        self.mark_setup_done()
        bound = status(account={"state": "closed"}, binding={"id": "b1", "credentialGeneration": "0"})
        self.start_flow(status(), bound)
        self.assertEqual(self.run_command("agent-start", "my-agent")[0], 0)
        self.assertNotIn("budget.apply-default-member-limit", self.keeper.actions())

    def test_the_binding_id_is_saved_before_the_first_attempt_and_reused_after_an_interruption(self) -> None:
        self.mark_setup_done()
        saved_during_call = []
        def provision(request: dict) -> dict:
            state = json.loads((self.prefix / "etc/lares/budget-setup.json").read_text())
            saved_during_call.append(list(state["bindings"].values())[0]["bindingId"])
            return {"ok": False, "outcome": "unknown", "error": "keeper could not confirm the action outcome"}
        self.start_flow(status(), status())
        self.keeper.answers["budget.provision-native"] = provision
        code, output = self.run_command("agent-start", "my-agent")
        self.assertEqual(code, budget.EX_REFUSED)
        self.assertIn("outcome is not known", output)
        self.assertEqual(saved_during_call[0], self.keeper.requests[-1]["input"]["bindingId"])
        code, _ = self.run_command("agent-start", "my-agent")
        self.assertEqual(saved_during_call[0], saved_during_call[1], "a retry must carry the same id")

    def test_running_again_continues_from_what_the_keeper_has_on_record(self) -> None:
        self.mark_setup_done()
        bound = status(account={"state": "closed"}, binding={"id": "b1", "credentialGeneration": "0"})
        self.start_flow(bound, bound)
        self.assertEqual(self.run_command("agent-start", "my-agent")[0], 0)
        self.assertNotIn("budget.provision-native", self.keeper.actions())
        self.assertIn("budget.activate-native", self.keeper.actions())
        self.keeper.requests.clear()
        opened = status(account={"state": "open"}, binding={"id": "b1", "credentialGeneration": "0"})
        self.start_flow(opened, opened)
        self.assertEqual(self.run_command("agent-start", "my-agent")[0], 0)
        self.assertNotIn("budget.activate-native", self.keeper.actions())
        self.assertIn("definition.reconcile", self.keeper.actions())

    def test_a_refused_key_says_it_will_not_retry(self) -> None:
        self.mark_setup_done()
        self.start_flow(status(), status())
        self.keeper.answers["budget.provision-native"] = {"ok": False, "outcome": "refused", "error": "Native budget provisioning refused"}
        code, output = self.run_command("agent-start", "my-agent")
        self.assertEqual(code, budget.EX_REFUSED)
        self.assertIn("cannot spend", output)
        self.assertNotIn("definition.reconcile", self.keeper.actions())

    def test_blockers_are_named_before_anything_changes(self) -> None:
        self.mark_setup_done()
        cases = [
            (status(agent=None), "No agent is called"),
            (status(member=None), "owner's account"),
            (status(member={"id": OWNER, "active": True, "verified": False, "limit": None, "canUse": True}), "sign in"),
            (status(member={"id": OWNER, "active": True, "verified": True, "limit": None, "canUse": False}), "adopted"),
            (status(agent={"status": "valid", "model": "other-brain", "incarnation": INCARNATION, "state": "ready", "pending": False, "pendingReason": None, "owned": True}), "covers only"),
            (status(account={"state": "open"}), "one agent only"),
        ]
        for answer, expected in cases:
            self.keeper.requests.clear()
            self.keeper.answers["budget.agent-start-status"] = ok(answer)
            code, output = self.run_command("agent-start", "my-agent")
            self.assertEqual(code, budget.EX_REFUSED, expected)
            self.assertIn(expected, output)
            self.assertEqual(self.keeper.actions(), ["budget.agent-start-status"], expected)

    def test_agent_start_needs_a_finished_setup_and_a_real_name(self) -> None:
        code, output = self.run_command("agent-start", "my-agent")
        self.assertEqual(code, budget.EX_REFUSED)
        self.assertIn("budget setup", output)
        self.mark_setup_done()
        code, output = self.run_command("agent-start", "../bad")
        self.assertEqual(code, budget.EX_REFUSED)
        self.assertEqual(self.keeper.actions(), [])

    def test_two_copies_cannot_run_together(self) -> None:
        installation = budget.Installation(str(self.prefix), IMAGE, str(self.release))
        held = installation.lock()
        try:
            code, output = self.run_command(*self.setup_answers())
        finally:
            os.close(held)
        self.assertEqual(code, budget.EX_REFUSED)
        self.assertIn("already running", output)


if __name__ == "__main__":
    unittest.main()
