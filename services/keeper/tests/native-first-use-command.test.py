"""Offline command-construction regression for the combined first-use probe."""

import ast
import json
import pathlib
import subprocess
import tempfile
import unittest
from types import SimpleNamespace

PROBE = pathlib.Path(__file__).with_name("native-first-use-image.probe.py")
REPO = PROBE.parents[3]
KEEPER = REPO / "services" / "keeper"


class GatewayDockerCommandTests(unittest.TestCase):
    def test_constructed_probe_commands_use_docker_wrapper_exactly_once(self) -> None:
        tree = ast.parse(PROBE.read_text(encoding="utf-8"), filename=str(PROBE))
        functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
        launches = sorted((
            node for node in ast.walk(tree)
            if isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name)
            and node.value.func.id == "docker"
            and len(node.value.args) == 1
            and isinstance(node.value.args[0], ast.Starred)
            and isinstance(node.value.args[0].value, ast.Name)
        ), key=lambda node: node.lineno)
        self.assertEqual([node.value.args[0].value.id for node in launches], ["gateway_args", "keeper_cmd", "args"])

        calls = []

        def record_run(command, **_kwargs):
            calls.append(tuple(command))
            return SimpleNamespace(returncode=0, stdout="started\n")

        synthetic_paths = {
            name: pathlib.Path("/synthetic") / name
            for name in ("repo", "native_dir", "secrets_dir", "tls_runtime", "config_dir_path", "install_root",
                         "host_socket_dir", "run_dir", "agent_dir", "capsule_source", "client_script")
        }
        namespace = {
            "pathlib": pathlib,
            "subprocess": SimpleNamespace(
                run=record_run, PIPE=subprocess.PIPE, STDOUT=subprocess.STDOUT,
                TimeoutExpired=subprocess.TimeoutExpired,
            ),
            "RuntimeError": RuntimeError,
            **synthetic_paths,
            "endpoint_hash": "a" * 64,
            "network": "lares-command-fixture",
            "gateway": "registry.invalid/fixture/gateway@sha256:" + "b" * 64,
            "volume": "lares-command-fixture-state",
            "keeper_name": "lares-command-fixture-keeper",
            "keeper_image": "registry.invalid/fixture/keeper:synthetic",
            "chief_name": "lares-command-fixture-chief",
            "chief_image": "registry.invalid/fixture/chief@sha256:" + "c" * 64,
            "agent": "proof-agent",
            "incarnation": "11111111-1111-4111-8111-111111111111",
            "owner": "fixture-owner",
            "definition_hash": "d" * 64,
            "workflow_database": "workflow-proof",
        }
        for launch in launches:
            argument_name = launch.value.args[0].value.id
            candidates = [
                node for node in ast.walk(tree)
                if isinstance(node, ast.Assign) and node.lineno < launch.lineno
                and any(isinstance(target, ast.Name) and target.id == argument_name for target in node.targets)
            ]
            assignment = max(candidates, key=lambda node: node.lineno)
            selected = [functions[name] for name in ("run", "output", "docker")]
            if argument_name == "args":
                selected.append(functions["compiled_chief_start_args"])
            selected.extend([assignment, launch])
            module = ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[]))
            exec(compile(module, str(PROBE), "exec"), namespace)

            self.assertEqual(len(calls), 1, argument_name)
            argv = calls.pop()
            self.assertEqual(argv[0:2], ("docker", "run"), argument_name)
            self.assertEqual(argv.count("docker"), 1, argument_name)

            # The previous duplicate-prefix shape is rejected without executing Docker.
            duplicated = ("docker",) + argv
            self.assertNotEqual(duplicated.count("docker"), 1, argument_name)


class NativeFirstUseConfigTests(unittest.TestCase):
    def test_actual_probe_config_loads_and_missing_egress_is_rejected(self) -> None:
        tree = ast.parse(PROBE.read_text(encoding="utf-8"), filename=str(PROBE))
        assignments = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "base_config" for target in node.targets)
        ]
        self.assertEqual(len(assignments), 1, "probe must have one base_config assignment")
        assignment = assignments[0]
        proof_names = {
            node.id for node in ast.walk(assignment.value)
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
        }
        self.assertLessEqual(proof_names, {"network", "proof"}, "fixture config may use only the network and image proof placeholders")

        namespace = {
            "network": "lares-config-fixture",
            "proof": {"images": {"chief": "sha256:" + "a" * 64, "keeper": "sha256:" + "b" * 64}},
        }
        module = ast.fix_missing_locations(ast.Module(body=[assignment], type_ignores=[]))
        exec(compile(module, str(PROBE), "exec"), namespace)
        fixture_config = namespace["base_config"]
        self.assertIsInstance(fixture_config, dict)
        self.assertEqual(fixture_config.get("designatedOwnerId"), "first-use-owner")
        self.assertIn("egress", fixture_config.get("lifecycle", {}))

        loader = (KEEPER / "lib" / "config.ts").as_uri()
        with tempfile.TemporaryDirectory(prefix="lares-native-first-use-config-") as directory:
            valid_path = pathlib.Path(directory) / "keeper.json"
            valid_path.write_text(json.dumps(fixture_config), encoding="utf-8")
            missing_egress_path = pathlib.Path(directory) / "keeper-missing-egress.json"
            missing_egress = json.loads(valid_path.read_text(encoding="utf-8"))
            del missing_egress["lifecycle"]["egress"]
            missing_egress_path.write_text(json.dumps(missing_egress), encoding="utf-8")
            script = (
                f'import {{ loadKeeperConfig }} from {json.dumps(loader)};'
                'import assert from "node:assert/strict";'
                f'const valid = loadKeeperConfig({json.dumps(str(valid_path))});'
                'assert.ok(valid.lifecycle?.egress);'
                'assert.throws(() => loadKeeperConfig('
                f'{json.dumps(str(missing_egress_path))}), /lifecycle\\.egress:/);'
            )
            result = subprocess.run(
                ["node", "--import", "tsx", "--input-type=module", "-e", script],
                cwd=KEEPER,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=20,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout)


class CompiledChiefKeylessCommandTests(unittest.TestCase):
    def test_constructed_chief_args_use_managed_socket_and_only_named_secret_files(self) -> None:
        tree = ast.parse(PROBE.read_text(encoding="utf-8"), filename=str(PROBE))
        builder = next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "compiled_chief_start_args"
        )
        namespace = {"secrets_dir": pathlib.Path("/synthetic/secrets")}
        module = ast.fix_missing_locations(ast.Module(body=[builder], type_ignores=[]))
        exec(compile(module, str(PROBE), "exec"), namespace)
        argv = namespace["compiled_chief_start_args"](
            chief_name="first-use-chief", network="first-use-network",
            agent_dir=pathlib.Path("/synthetic/agent"), run_dir=pathlib.Path("/synthetic/run"),
            capsule_source=pathlib.Path("/synthetic/capsule.ts"),
            client_script=pathlib.Path("/synthetic/client.mts"),
            chief_image="registry.invalid/chief@sha256:" + "a" * 64,
            secrets_dir=pathlib.Path("/synthetic/secrets"),
            agent="proof-agent", incarnation="11111111-1111-4111-8111-111111111111",
            owner="fixture-owner", definition_hash="b" * 64, workflow_database="workflow-proof",
        )
        env_values = {}
        for index, entry in enumerate(argv[:-1]):
            if entry == "-e":
                key, value = argv[index + 1].split("=", 1)
                env_values[key] = value
        mounts = [entry for entry in argv if entry.startswith("type=bind,")]
        secret_mounts = [mount for mount in mounts if "dst=/run/secrets/" in mount]
        destinations = {mount.split("dst=", 1)[1].split(",", 1)[0] for mount in secret_mounts}
        expected = {
            "/run/secrets/app-password", "/run/secrets/workflow-password",
            "/run/secrets/route-password", "/run/secrets/runtime-control",
            "/run/secrets/console-model-purpose-signing-key",
        }
        self.assertEqual(destinations, expected)
        self.assertEqual(
            {mount.split("dst=", 1)[1].split(",", 1)[0]: mount.split("src=", 1)[1].split(",", 1)[0]
             for mount in secret_mounts},
            {
                "/run/secrets/app-password": "/synthetic/secrets/app-password",
                "/run/secrets/workflow-password": "/synthetic/secrets/workflow-password",
                "/run/secrets/route-password": "/synthetic/secrets/route-password",
                "/run/secrets/runtime-control": "/synthetic/secrets/proof-agent-runtime-control",
                "/run/secrets/console-model-purpose-signing-key": "/synthetic/secrets/console-model-purpose-signing-key",
            },
        )
        self.assertTrue(all(mount.endswith(",readonly") for mount in secret_mounts))
        self.assertFalse(any(mount.startswith("type=bind,src=/synthetic/secrets,") for mount in mounts))
        self.assertFalse(any(any(secret in mount for secret in ("gateway-key", "gateway-master", "native-policy",
                                                                    "model-provider-key", "native-litellm-password"))
                             for mount in mounts))
        self.assertNotIn("GATEWAY_KEY_FILE", env_values)
        self.assertEqual(env_values["LARES_MODEL_PURPOSE_RUNTIME_SOCKET"],
                         "/run/lares/model-purpose/model-purpose.sock")
        self.assertEqual(env_values["LARES_AGENT_INCARNATION"],
                         "11111111-1111-4111-8111-111111111111")
        self.assertEqual(env_values["LARES_RUNTIME_CONTROL_SECRET_FILE"], "/run/secrets/runtime-control")
        self.assertIn("GATEWAY_URL", env_values)
        self.assertFalse(any(name.endswith(("_API_KEY", "_KEY_FILE")) for name in env_values))
        self.assertFalse({"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY",
                          "LITELLM_MASTER_KEY", "GATEWAY_MASTER_KEY_FILE"} & env_values.keys())


class FinancialObserverTests(unittest.TestCase):
    def test_observer_is_fixed_summary_only_and_uses_read_only_financial_role(self) -> None:
        tree = ast.parse(PROBE.read_text(encoding="utf-8"), filename=str(PROBE))
        assignment = next(
            node for node in tree.body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "FINANCIAL_OBSERVER_SQL" for target in node.targets)
        )
        namespace = {}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[assignment], type_ignores=[])), str(PROBE), "exec"), namespace)
        queries = namespace["FINANCIAL_OBSERVER_SQL"]
        self.assertEqual(set(queries), {"native", "bindings", "members"})
        self.assertTrue(all(query.lstrip().upper().startswith("SELECT") for query in queries.values()))
        self.assertTrue(all(not any(word in query.upper() for word in ("INSERT", "UPDATE", "DELETE", "TRUNCATE", "DROP"))
                            for query in queries.values()))
        observer = next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "financial_observer"
        )
        source = ast.unparse(observer)
        self.assertIn("lares_financial", source)
        self.assertIn("BEGIN READ ONLY", source)
        self.assertIn("financial-database-password", source)

        with tempfile.TemporaryDirectory(prefix="lares-financial-observer-") as directory:
            root = pathlib.Path(directory)
            secrets_dir = root / "secrets"
            secrets_dir.mkdir()
            calls = []
            namespace = {
                "FINANCIAL_OBSERVER_SQL": queries, "RuntimeError": RuntimeError, "json": json,
                "root": root, "secrets_dir": secrets_dir, "network": "observer-network",
                "keeper_image": "registry.invalid/keeper:fixture",
                "output": lambda *args, **_kwargs: calls.append(args) or "{}",
            }
            module = ast.fix_missing_locations(ast.Module(body=[observer], type_ignores=[]))
            exec(compile(module, str(PROBE), "exec"), namespace)
            result = namespace["financial_observer"]("native", {
                "host": "proof-db", "port": 5432, "database": "proof", "user": "lares_financial",
                "passwordFile": "/etc/lares/secrets/financial-database-password",
            })
            self.assertEqual(result, "{}")
            self.assertEqual(len(calls), 1)
            args = calls[0]
            self.assertIn("type=bind,src=" + str(secrets_dir / "financial-database-password") +
                          ",dst=/etc/lares/secrets/financial-database-password,readonly", args)
            self.assertNotIn("type=bind,src=" + str(secrets_dir) + ",dst=/etc/lares/secrets,readonly", args)
            script = (root / "financial-observer.mts").read_text(encoding="utf-8")
            self.assertIn("lares_financial", script)
            self.assertIn("BEGIN READ ONLY", script)
            self.assertIn("default_transaction_read_only=on", script)
            self.assertNotIn("fixture-password-value", script)


class FirstActivationMemberSummaryTests(unittest.TestCase):
    def test_actual_consumer_accepts_only_selected_open_member_and_other_closed(self) -> None:
        tree = ast.parse(PROBE.read_text(encoding="utf-8"), filename=str(PROBE))
        consumer = next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "selected_members_match_first_activation"
        )
        namespace = {}
        module = ast.fix_missing_locations(ast.Module(body=[consumer], type_ignores=[]))
        exec(compile(module, str(PROBE), "exec"), namespace)
        matches = namespace["selected_members_match_first_activation"]
        member_ids = ["first-use-member-a", "first-use-member-b"]
        expected = [
            {"memberId": member_ids[0], "state": "open"},
            {"memberId": member_ids[1], "state": "closed"},
        ]
        self.assertTrue(matches(expected, member_ids))

        wrong_member = [dict(row) for row in expected]
        wrong_member[0]["memberId"] = member_ids[1]
        self.assertFalse(matches(wrong_member, member_ids))
        wrong_state = [dict(row) for row in expected]
        wrong_state[1]["state"] = "open"
        self.assertFalse(matches(wrong_state, member_ids))
        self.assertFalse(matches(expected[:1], member_ids))
        self.assertFalse(matches(expected + [dict(expected[0])], member_ids))


class InitialBudgetFixtureOrderTests(unittest.TestCase):
    def test_source_fixture_defers_policy_rows_and_grants_until_real_keeper_actions(self) -> None:
        tree = ast.parse(PROBE.read_text(encoding="utf-8"), filename=str(PROBE))
        source_assignment = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "source_code" for target in node.targets)
        )
        source_code = source_assignment.value.value
        self.assertNotIn("org_member_policy", source_code)
        self.assertIn("INSERT INTO member_sessions", source_code)
        self.assertIn("FIXTURE_OWNER_SESSION_TOKEN_HASH", source_code)
        self.assertIn("financialAccessDenied:true", source_code)
        self.assertNotIn("PgGrantStore", source_code)

        stages = {
            node.value.value: node.lineno
            for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
            and node.value.value in {
                "source-rows-and-readiness", "production-keeper-startup",
                "initial-budget-actions-through-console-client",
                "source-adoption-after-initial-budgets", "host-only-provisioning",
            }
        }
        self.assertEqual(set(stages), {
            "source-rows-and-readiness", "production-keeper-startup",
            "initial-budget-actions-through-console-client",
            "source-adoption-after-initial-budgets", "host-only-provisioning",
        })
        self.assertLess(stages["source-rows-and-readiness"], stages["production-keeper-startup"])
        self.assertLess(stages["production-keeper-startup"], stages["initial-budget-actions-through-console-client"])
        self.assertLess(stages["initial-budget-actions-through-console-client"], stages["source-adoption-after-initial-budgets"])
        self.assertLess(stages["source-adoption-after-initial-budgets"], stages["host-only-provisioning"])

        client_script = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute) and node.func.attr == "write_text"
            and node.args and isinstance(node.args[0], ast.Constant)
            and "member.initial-budget-status" in node.args[0].value
        ).args[0].value
        for contract in (
            "services/console/lib/keeper-client.ts", "member.initial-budget-status",
            "member.set-initial-budget", "first-use-owner", "first-use-owner@example.invalid",
            "statusCount:status.length", "capsSaved:expected.length",
        ):
            self.assertIn(contract, client_script)
        self.assertNotIn("console.log(sessionToken", client_script)

        adoption_assignment = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "source_adoption_code" for target in node.targets)
        )
        self.assertIn("PgGrantStore", adoption_assignment.value.value)
        self.assertIn("adoptAgent", adoption_assignment.value.value)
        self.assertIn("updateAgentAccess", adoption_assignment.value.value)
        self.assertIn("current.accessRevision<=adopted.accessRevision", adoption_assignment.value.value)

    def test_constructed_console_action_command_mounts_only_the_token_file(self) -> None:
        tree = ast.parse(PROBE.read_text(encoding="utf-8"), filename=str(PROBE))
        builder = next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "initial_budget_client_args"
        )
        namespace = {}
        module = ast.fix_missing_locations(ast.Module(body=[builder], type_ignores=[]))
        exec(compile(module, str(PROBE), "exec"), namespace)
        token_file = pathlib.Path("/protected/owner-session/token")
        argv = namespace["initial_budget_client_args"](
            network="first-use-network", run_dir=pathlib.Path("/socket"), token_file=token_file,
            client_source=pathlib.Path("/console/keeper-client.ts"),
            client_script=pathlib.Path("/fixture/client.mts"), keeper_image="keeper:fixture",
        )
        mounts = [item for item in argv if item.startswith("type=bind,")]
        self.assertIn("--read-only", argv)
        self.assertIn("--tmpfs", argv)
        tmpfs_index = argv.index("--tmpfs")
        self.assertEqual(argv[tmpfs_index + 1], "/tmp:rw,noexec,nosuid,nodev,mode=1777,size=16m")
        token_mounts = [item for item in mounts if "dst=/fixture/owner-session-token" in item]
        self.assertEqual(token_mounts, [f"type=bind,src={token_file},dst=/fixture/owner-session-token,readonly"])
        self.assertTrue(all(item.endswith(",readonly") for item in mounts))
        self.assertFalse(any("/etc/lares/secrets" in item or "gateway-master" in item for item in mounts))
        self.assertNotIn("FIXTURE_OWNER_SESSION_TOKEN_HASH", argv)
        self.assertTrue(any("dst=/app/services/console/lib/keeper-client.ts" in item for item in argv))
        self.assertIn("/app/services/keeper/initial-budget-client.mts", argv)


class ConsoleKeeperActorContractTests(unittest.TestCase):
    def test_actual_socket_and_console_client_accept_neutral_email_actor(self) -> None:
        socket_source = json.dumps(str(KEEPER / "lib" / "socket-server.ts"))
        actions_source = json.dumps(str(KEEPER / "lib" / "actions.ts"))
        client_source = json.dumps(str(REPO / "services" / "console" / "lib" / "keeper-client.ts"))
        script = f'''import {{ mkdtempSync, rmSync }} from "node:fs";
import {{ join }} from "node:path";
import {{ z }} from "zod";
import {{ serve }} from {socket_source};
import {{ registerAction, resetActions }} from {actions_source};
import {{ keeper, KeeperRefusedError }} from {client_source};
const directory=mkdtempSync("/tmp/lares-keeper-actor-");
const socket=join(directory,"keeper.sock");
const uid=process.getuid?.()??0,gid=process.getgid?.()??0;
let stop;
try{{
  registerAction({{name:"fixture.actor-probe",input:z.object({{}}),run:async()=>({{accepted:true}})}});
  stop=await serve({{socket,host:false,context:{{actor:"fixture",audit:async()=>{{}}}},ownership:{{uid,gid}}}});
  process.env.LARES_KEEPER_SOCKET=socket;
  const accepted=await keeper("fixture.actor-probe",{{}},"first-use-owner@example.invalid");
  if(!accepted?.accepted)throw new Error("neutral email actor was not accepted by actual socket");
  const refused=await keeper("fixture.actor-probe",{{}},"first-use-owner-console").then(()=>false,error=>error instanceof KeeperRefusedError);
  if(!refused)throw new Error("old non-email actor was not refused by actual socket");
  console.log("actual Keeper socket and Console client actor contract passed");
}}finally{{if(stop)await stop();resetActions();rmSync(directory,{{recursive:true,force:true}});}}
'''
        result = subprocess.run(
            ["node", "--import", "tsx", "--input-type=module", "-e", script],
            cwd=KEEPER, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=20, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("actual Keeper socket and Console client actor contract passed", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=0)
