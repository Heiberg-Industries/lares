"""Offline command-construction regression for the combined first-use probe."""

import ast
import json
import pathlib
import re
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
        self.assertEqual([node.value.args[0].value.id for node in launches], ["gateway_args", "keeper_cmd"])
        runtime_launches = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name) and node.func.id == "run"
            and len(node.args) >= 2
            and isinstance(node.args[0], ast.Constant) and node.args[0].value == "docker"
            and isinstance(node.args[1], ast.Starred)
            and any(keyword.arg == "timeout" and isinstance(keyword.value, ast.Constant)
                    and keyword.value.value == 120 for keyword in node.keywords)
        ]
        self.assertEqual([node.args[1].value.id for node in runtime_launches], ["args"])

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


class NeutralFirstUseDefinitionTests(unittest.TestCase):
    def test_probe_fixture_passes_actual_production_definition_validator(self) -> None:
        tree = ast.parse(PROBE.read_text(encoding="utf-8"), filename=str(PROBE))
        builder = next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "neutral_first_use_definition"
        )
        namespace = {"json": json, "pathlib": pathlib}
        module = ast.fix_missing_locations(ast.Module(body=[builder], type_ignores=[]))
        exec(compile(module, str(PROBE), "exec"), namespace)

        template_path = REPO / "packages" / "agent-kit" / "templates" / "chief-of-staff" / "definition.json"
        template = json.loads(template_path.read_text(encoding="utf-8"))
        self.assertTrue(template["autonomy"], "the regression fixture must include inherited template autonomy")
        fixture = namespace["neutral_first_use_definition"](template_path, "proof-agent", "lares-brain")
        self.assertEqual(fixture["grants"], [])
        self.assertEqual(fixture["skills"], [])
        self.assertEqual(fixture["channels"], [])
        self.assertEqual(fixture["autonomy"], {})
        self.assertEqual(fixture["schedules"], template["schedules"])

        with tempfile.TemporaryDirectory(prefix="lares-neutral-first-use-definition-") as directory:
            fixture_path = pathlib.Path(directory) / "agent.json"
            fixture_path.write_text(json.dumps(fixture), encoding="utf-8")
            definition_module = json.dumps(str(REPO / "packages" / "agent-kit" / "src" / "definition.ts"))
            validator_module = json.dumps(str(REPO / "packages" / "agent-kit" / "src" / "definition-validate.ts"))
            persona_module = json.dumps(str(REPO / "packages" / "agent-kit" / "src" / "persona" / "deployed-tools.ts"))
            role_path = json.dumps(str(REPO / "packages" / "agent-kit" / "templates" / "chief-of-staff" / "role.md"))
            service_path = json.dumps(str(REPO / "services" / "chief-of-staff"))
            fixture_file = json.dumps(str(fixture_path))
            script = f'''import assert from "node:assert/strict";
import {{ readFileSync }} from "node:fs";
import {{ parseDefinition }} from {definition_module};
import {{ assertDefinitionValid }} from {validator_module};
import {{ deployedToolsFor }} from {persona_module};
const validate = raw => assertDefinitionValid({{definition:parseDefinition(raw),
  roleMd:readFileSync({role_path},"utf8"),deployedTools:deployedToolsFor({service_path})}});
const inherited=JSON.parse(readFileSync({json.dumps(str(template_path))},"utf8"));
Object.assign(inherited,{{name:"proof-agent",model:"lares-brain",grants:[],skills:[],channels:[]}});
assert.throws(()=>validate(inherited),/autonomy is set for "vault", which has no matching grant/);
validate(JSON.parse(readFileSync({fixture_file},"utf8")));
console.log("neutral first-use fixture passes the production definition validator");
'''
            result = subprocess.run(
                ["node", "--import", "tsx", "--input-type=module", "-e", script],
                cwd=KEEPER, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                timeout=20, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertIn("neutral first-use fixture passes the production definition validator", result.stdout)


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


class CompiledFirstUsePhaseDiagnosticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tree = ast.parse(PROBE.read_text(encoding="utf-8"), filename=str(PROBE))

    def test_generated_client_marks_fixed_phases_around_the_real_signed_request(self) -> None:
        client_source = next(node.args[0].value for node in ast.walk(self.tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == "write_text" and node.args and isinstance(node.args[0], ast.Constant)
            and "FIRST_USE_PHASE_FILE" in node.args[0].value)
        phases = ("imports", "session-create", "session-bind", "capsule-sign", "send",
                  "turn-result", "refusalchecks", "complete")
        positions = [client_source.index("mark(" + repr(phase) + ")") for phase in phases]
        self.assertEqual(positions, sorted(positions))
        for contract in (
            "await import('/app/services/chief-of-staff/node_modules/eve/dist/src/client/index.js')",
            "await client.sessions.create({headers})", "await bindConsoleSession(",
            "await signPrivateModelPurposeRequest(request)", "await session.send(message,{headers:sendHeaders})",
            "await pending.result()", "process.env.CHECK_REFUSALS==='1'", "response:result.message",
            "fs.writeFileSync(temp,JSON.stringify({phase}),{mode:0o600})", "fs.renameSync(temp,phaseFile)",
            "catch{process.exitCode=1}",
        ):
            self.assertIn(contract, client_source)
        self.assertNotIn("console.error", client_source)
        self.assertNotIn("console.log(session", client_source)

    def test_phase_reader_is_strict_bounded_and_redacts_invalid_content(self) -> None:
        phase_constant = next(node for node in self.tree.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "COMPILED_CLIENT_PHASES" for target in node.targets))
        summary = next(node for node in self.tree.body if isinstance(node, ast.FunctionDef)
            and node.name == "safe_compiled_client_phase_summary")
        namespace = {"json": json}
        module = ast.fix_missing_locations(ast.Module(body=[phase_constant, summary], type_ignores=[]))
        exec(compile(module, str(PROBE), "exec"), namespace)
        parse = namespace["safe_compiled_client_phase_summary"]
        self.assertEqual(parse('{"phase":"capsule-sign","valid":true}', 0),
                         {"phase": "capsule-sign", "markerValid": True})
        secret = "PRIVATE-SESSION-OR-ERROR-CANARY"
        for raw, code in (
            ('{"phase":"unknown-phase","valid":true}', 0),
            ('{"phase":"send","valid":true,"token":"' + secret + '"}', 0),
            ('{"phase":"send","valid":false}', 0),
            ('{"phase":"send","valid":true}' + (" " * 129), 0),
            ('{"phase":"send","valid":true}', 1),
            (secret, 0),
        ):
            result = parse(raw, code)
            self.assertEqual(result, {"phase": "unknown", "markerValid": False})
            self.assertNotIn(secret, json.dumps(result))

    def test_container_marker_reader_checks_fixed_file_and_fixed_shape_before_returning_phase(self) -> None:
        phase_constant = next(node for node in self.tree.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "COMPILED_CLIENT_PHASES" for target in node.targets))
        files_constant = next(node for node in self.tree.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "COMPILED_CLIENT_PHASE_FILES" for target in node.targets))
        safe_summary = next(node for node in self.tree.body if isinstance(node, ast.FunctionDef)
            and node.name == "safe_compiled_client_phase_summary")
        reader = next(node for node in self.tree.body if isinstance(node, ast.FunctionDef)
            and node.name == "compiled_client_phase_summary")
        namespace = {"json": json, "RuntimeError": RuntimeError}
        module = ast.fix_missing_locations(ast.Module(body=[phase_constant, files_constant, safe_summary, reader], type_ignores=[]))
        exec(compile(module, str(PROBE), "exec"), namespace)
        observed = {}
        namespace["run"] = lambda *args, **kwargs: observed.update(args=args, kwargs=kwargs) or type(
            "Result", (), {"returncode": 0, "stdout": '{"phase":"send","valid":true}'}
        )()
        self.assertEqual(namespace["compiled_client_phase_summary"]("fixture-chief", "owner-first"),
                         {"phase": "send", "markerValid": True})
        reader_script = observed["args"][observed["args"].index("-e") + 1]
        for contract in ("/tmp/first-use-phase-first", "s.size>128", "Object.keys(x).length===1", "allowed.includes(x.phase)",
                         "JSON.stringify(out)", "phase:'unknown'"):
            self.assertIn(contract, reader_script)
        secret = "PRIVATE-SESSION-OR-ERROR-CANARY"
        namespace["run"] = lambda *args, **kwargs: type(
            "Result", (), {"returncode": 1, "stdout": secret}
        )()
        failed = namespace["compiled_client_phase_summary"]("fixture-chief", "owner-first")
        self.assertEqual(failed, {"phase": "unknown", "markerValid": False})
        self.assertNotIn(secret, json.dumps(failed))
        self.assertEqual(namespace["compiled_client_phase_summary"]("fixture-chief", "unrecognized"),
                         {"phase": "unknown", "markerValid": False})

    def test_phase_initialization_defaults_to_imports_without_exposing_values(self) -> None:
        files_constant = next(node for node in self.tree.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "COMPILED_CLIENT_PHASE_FILES" for target in node.targets))
        initialize = next(node for node in self.tree.body if isinstance(node, ast.FunctionDef)
            and node.name == "initialize_compiled_client_phase")
        namespace = {"json": json}
        module = ast.fix_missing_locations(ast.Module(body=[files_constant, initialize], type_ignores=[]))
        exec(compile(module, str(PROBE), "exec"), namespace)
        seen = {}
        namespace["run"] = lambda *args, **kwargs: seen.update(args=args, kwargs=kwargs) or type(
            "Result", (), {"returncode": 0}
        )()
        self.assertTrue(namespace["initialize_compiled_client_phase"]("fixture-chief", "owner-first"))
        self.assertEqual(seen["args"][:4], ("docker", "exec", "fixture-chief", "node"))
        script = seen["args"][seen["args"].index("-e") + 1]
        self.assertIn("/tmp/first-use-phase-first", script)
        self.assertIn('{"phase":"imports"}', script)
        self.assertNotIn("token", script.lower())
        self.assertFalse(namespace["initialize_compiled_client_phase"]("fixture-chief", "unknown"))

    def test_request_runner_records_only_fixed_phase_and_bounded_exit_state(self) -> None:
        invoke = next(node for node in ast.walk(self.tree) if isinstance(node, ast.FunctionDef)
                      and node.name == "invoke_compiled_client")
        namespace = {
            "COMPILED_CLIENT_PHASE_FILES": {"owner-first": "/tmp/first-use-phase-first"},
            "chief_name": "fixture-chief", "proof": {},
            "compiled_client_phase_summary": lambda _name, _marker: {"phase": "capsule-sign", "markerValid": True},
            "fixed_client_failure_observations": lambda: {
                "upstreamDispatchCount": 2,
                "financialDurableCounts": {"attempts": 3, "grants": 3, "settled": 3},
            },
            "RuntimeError": RuntimeError,
        }
        module = ast.fix_missing_locations(ast.Module(body=[invoke], type_ignores=[]))
        exec(compile(module, str(PROBE), "exec"), namespace)
        secret = "PRIVATE-SESSION-OR-ERROR-CANARY"
        namespace["run"] = lambda *args, **kwargs: type("Result", (), {"returncode": 17, "stdout": secret})()
        with self.assertRaisesRegex(RuntimeError, "Compiled signed request failed"):
            namespace["invoke_compiled_client"]("fixture-member", "owner-first", check_refusals=True)
        self.assertEqual(namespace["proof"]["firstUseClientDiagnostics"], {
            "request": "owner-first", "phase": "capsule-sign", "markerValid": True,
            "timedOut": False, "exitCode": 17, "upstreamDispatchCount": 2,
            "financialDurableCounts": {"attempts": 3, "grants": 3, "settled": 3},
        })
        self.assertNotIn(secret, json.dumps(namespace["proof"]))
        namespace["proof"].clear()
        namespace["run"] = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("bounded timeout"))
        with self.assertRaisesRegex(RuntimeError, "Compiled signed request exceeded its time bound"):
            namespace["invoke_compiled_client"]("fixture-member", "owner-first")
        self.assertEqual(namespace["proof"]["firstUseClientDiagnostics"], {
            "request": "owner-first", "phase": "capsule-sign", "markerValid": True,
            "timedOut": True, "exitCode": None, "upstreamDispatchCount": 2,
            "financialDurableCounts": {"attempts": 3, "grants": 3, "settled": 3},
        })

    def test_failure_observation_exports_only_bounded_counts(self) -> None:
        observe = next(node for node in ast.walk(self.tree) if isinstance(node, ast.FunctionDef)
                       and node.name == "fixed_client_failure_observations")
        namespace = {
            "upstream_calls": lambda: 3,
            "native_snapshot": lambda: {"attempts": 7, "grants": 6, "settled": 4,
                                         "liability": "9000.01", "recovery_epoch": "PRIVATE", "endpoint_generation": 77},
        }
        module = ast.fix_missing_locations(ast.Module(body=[observe], type_ignores=[]))
        exec(compile(module, str(PROBE), "exec"), namespace)
        result = namespace["fixed_client_failure_observations"]()
        self.assertEqual(result, {
            "upstreamDispatchCount": 3,
            "financialDurableCounts": {"attempts": 7, "grants": 6, "settled": 4},
        })
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertNotIn("9000.01", json.dumps(result))


class CompiledChiefStartupDiagnosticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        tree = ast.parse(PROBE.read_text(encoding="utf-8"), filename=str(PROBE))
        cls.functions = {
            node.name: node for node in tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name in {"safe_startup_container_state", "safe_startup_log_categories",
                              "bounded_compiled_runtime_logs", "register_compiled_chief_container"}
        }
        cls.namespace = {"re": __import__("re")}
        module = ast.fix_missing_locations(ast.Module(body=list(cls.functions.values()), type_ignores=[]))
        exec(compile(module, str(PROBE), "exec"), cls.namespace)
        cls.tree = tree

    def test_state_summary_keeps_only_fixed_typed_container_fields(self) -> None:
        summary = self.namespace["safe_startup_container_state"](
            found=True, status="exited", running=False, exit_code="137", oom_killed=True,
        )
        self.assertEqual(summary, {
            "found": True, "status": "exited", "running": False, "exitCode": 137, "oomKilled": True,
        })
        invalid = self.namespace["safe_startup_container_state"](
            found=False, status="secret-bearing-status", running="true", exit_code="99999", oom_killed=1,
        )
        self.assertEqual(invalid, {
            "found": False, "status": "unknown", "running": False, "exitCode": None, "oomKilled": False,
        })

    def test_log_summary_is_bounded_allowlisted_and_never_returns_log_text(self) -> None:
        secret_canary = "NEVER-EMIT-THIS-SESSION-TOKEN"
        classify = self.namespace["safe_startup_log_categories"]
        clipped = classify("read-only file system " + ("x" * 40000) + "EACCES: permission denied " + secret_canary)
        self.assertFalse(clipped["readOnlyFilesystem"])
        self.assertTrue(clipped["permissionDenied"])
        self.assertEqual(set(clipped), {
            "missingSettings", "unset_DATABASE_URL", "unset_WORKFLOW_POSTGRES_URL",
            "unset_DATABASE_PASSWORD_FILE", "unreadable_DATABASE_PASSWORD_FILE", "empty_DATABASE_PASSWORD_FILE",
            "unset_WORKFLOW_POSTGRES_PASSWORD_FILE", "unreadable_WORKFLOW_POSTGRES_PASSWORD_FILE",
            "empty_WORKFLOW_POSTGRES_PASSWORD_FILE", "unset_GATEWAY_URL", "unset_LARES_AGENT_NAME",
            "unset_LARES_DEFINITION_DIR", "unset_GATEWAY_KEY_FILE", "unreadable_GATEWAY_KEY_FILE",
            "empty_GATEWAY_KEY_FILE",
            "managedIncarnationInvalid", "managedSocketNotConfigured",
            "runtimeControlFileUnavailable", "modelPurposeSocketUnavailable",
            "gatewayRuntimeSocketUnavailable", "workflowCredentialsUnavailable",
            "invalidConfiguration", "moduleResolution", "permissionDenied",
            "readOnlyFilesystem", "databaseUnavailable", "addressInUse", "memoryExhaustion",
        })
        self.assertNotIn(secret_canary, json.dumps(clipped))
        self.assertTrue(classify("Error [ERR_MODULE_NOT_FOUND]: Cannot find package")["moduleResolution"])

    def test_generated_required_settings_failures_have_fixed_safe_categories(self) -> None:
        classify = self.namespace["safe_startup_log_categories"]
        cases = {
            "lares: DATABASE_URL is not set. configured prose": "unset_DATABASE_URL",
            "lares: WORKFLOW_POSTGRES_URL is not set. configured prose": "unset_WORKFLOW_POSTGRES_URL",
            "lares: DATABASE_PASSWORD_FILE is not set. configured prose": "unset_DATABASE_PASSWORD_FILE",
            "lares: DATABASE_PASSWORD_FILE points to a file that does not exist or cannot be read (/secret/value)": "unreadable_DATABASE_PASSWORD_FILE",
            "lares: DATABASE_PASSWORD_FILE points to a file that exists but is empty (/secret/value)": "empty_DATABASE_PASSWORD_FILE",
            "lares: WORKFLOW_POSTGRES_PASSWORD_FILE is not set. configured prose": "unset_WORKFLOW_POSTGRES_PASSWORD_FILE",
            "lares: WORKFLOW_POSTGRES_PASSWORD_FILE points to a file that does not exist or cannot be read (/secret/value)": "unreadable_WORKFLOW_POSTGRES_PASSWORD_FILE",
            "lares: WORKFLOW_POSTGRES_PASSWORD_FILE points to a file that exists but is empty (/secret/value)": "empty_WORKFLOW_POSTGRES_PASSWORD_FILE",
            "lares: GATEWAY_URL is not set. configured prose": "unset_GATEWAY_URL",
            "lares: LARES_AGENT_NAME is not set. configured prose": "unset_LARES_AGENT_NAME",
            "lares: LARES_DEFINITION_DIR is not set. configured prose": "unset_LARES_DEFINITION_DIR",
            "lares: GATEWAY_KEY_FILE is not set. configured prose": "unset_GATEWAY_KEY_FILE",
            "lares: GATEWAY_KEY_FILE points to a file that does not exist or cannot be read (/secret/value)": "unreadable_GATEWAY_KEY_FILE",
            "lares: GATEWAY_KEY_FILE points to a file that exists but is empty (/secret/value)": "empty_GATEWAY_KEY_FILE",
            "lares: managed incarnation is invalid": "managedIncarnationInvalid",
            "lares: managed model-purpose socket is not configured": "managedSocketNotConfigured",
            "lares: runtime-control file is missing, unreadable, or empty": "runtimeControlFileUnavailable",
            "lares: model-purpose runtime socket is unavailable": "modelPurposeSocketUnavailable",
            "lares: model-purpose gateway socket is unavailable": "gatewayRuntimeSocketUnavailable",
            "lares: workflow database credentials are unavailable.": "workflowCredentialsUnavailable",
        }
        for source_message, expected in cases.items():
            with self.subTest(category=expected):
                summary = classify(source_message + "\nNEVER-EMIT-THIS-SESSION-TOKEN")
                self.assertTrue(summary[expected])
                self.assertNotIn("NEVER-EMIT-THIS-SESSION-TOKEN", json.dumps(summary))

        # The optional gateway key's absence is the managed-keyless case, not a failure.
        summary = classify("startup continues")
        self.assertFalse(summary["unset_GATEWAY_KEY_FILE"])
        guard = (REPO / "images/agent-runtime/required-settings-chief-of-staff.sh").read_text(encoding="utf-8")
        actual_calls = {(kind, name) for kind, name in re.findall(
            r"^[ \t]*lares_require(_file)? ([A-Z0-9_]+)", guard, re.MULTILINE)}
        self.assertEqual(actual_calls, {
            ("", "DATABASE_URL"), ("", "WORKFLOW_POSTGRES_URL"),
            ("_file", "DATABASE_PASSWORD_FILE"), ("_file", "WORKFLOW_POSTGRES_PASSWORD_FILE"),
            ("", "GATEWAY_URL"), ("", "LARES_AGENT_NAME"), ("", "LARES_DEFINITION_DIR"),
            ("_file", "GATEWAY_KEY_FILE"),
        })

    def test_setting_categories_require_exact_lares_line_and_field_delimiter(self) -> None:
        classify = self.namespace["safe_startup_log_categories"]
        negatives = [
            "lares: OTHER_DATABASE_URL is not set. prose",
            "lares: DATABASE_URL_EXTRA is not set. prose",
            'startup logged: "lares: DATABASE_URL is not set. prose"',
            'lares: note says "DATABASE_URL is not set" but not a guard line',
            "error: lares: managed incarnation is invalid",
            "lares: workflow database credentials are unavailable: unrelated detail",
            'startup logged: "lares: managed model-purpose socket is not configured"',
            'startup logged: "lares: runtime-control file is missing, unreadable, or empty"',
            'startup logged: "lares: model-purpose runtime socket is unavailable"',
            'startup logged: "lares: model-purpose gateway socket is unavailable"',
        ]
        for text in negatives:
            with self.subTest(text=text):
                summary = classify(text)
                self.assertFalse(summary["unset_DATABASE_URL"])
                self.assertFalse(summary["missingSettings"])
                self.assertFalse(summary["managedIncarnationInvalid"])
                self.assertFalse(summary["managedSocketNotConfigured"])
                self.assertFalse(summary["runtimeControlFileUnavailable"])
                self.assertFalse(summary["modelPurposeSocketUnavailable"])
                self.assertFalse(summary["gatewayRuntimeSocketUnavailable"])
                self.assertFalse(summary["workflowCredentialsUnavailable"])
        exact = classify("context line\nlares: DATABASE_URL is not set. fixed explanation")
        self.assertTrue(exact["unset_DATABASE_URL"])
        self.assertTrue(exact["missingSettings"])

    def test_continuously_readable_log_pipe_stops_at_deadline_and_reaps_process(self) -> None:
        class FakePipe:
            def fileno(self):
                return 42

        class FakeProcess:
            def __init__(self):
                self.stdout = FakePipe()
                self.killed = False
                self.waited = False

            def poll(self):
                return None if not self.killed else -9

            def kill(self):
                self.killed = True

            def wait(self, timeout=None):
                self.waited = True
                return -9

        process = FakeProcess()
        clock_values = iter([0.0, 0.0, 4.0, 5.0])
        reads = []
        selects = []
        self.namespace.update({
            "subprocess": SimpleNamespace(PIPE=object(), STDOUT=object(), Popen=lambda *_args, **_kwargs: process),
            "time": SimpleNamespace(monotonic=lambda: next(clock_values)),
            "select": SimpleNamespace(select=lambda *args: selects.append(args) or ([process.stdout], [], [])),
            "os": SimpleNamespace(read=lambda *_args: reads.append(True) or b"EACCES: permission denied\n"),
        })
        captured = self.namespace["bounded_compiled_runtime_logs"]("fixture-network-chief")
        self.assertEqual(len(reads), 2)
        self.assertEqual(len(selects), 2)
        self.assertTrue(process.killed)
        self.assertTrue(process.waited)
        self.assertIn("permission denied", captured)

    def test_nonzero_launch_discovery_registers_only_owned_container_for_cleanup(self) -> None:
        inspections = []

        def inspect_created(*args, **_kwargs):
            inspections.append(args)
            return SimpleNamespace(returncode=0, stdout="created\n")

        self.namespace.update({"network": "fixture-network", "run": inspect_created})
        container_names = []
        register = self.namespace["register_compiled_chief_container"]
        self.assertTrue(register("fixture-network-chief", container_names))
        self.assertEqual(container_names, ["fixture-network-chief"])
        inspection_count = len(inspections)
        self.assertFalse(register("unowned-project-chief", container_names))
        self.assertEqual(len(inspections), inspection_count)

        launch_failure = next(
            node for node in ast.walk(self.tree)
            if isinstance(node, ast.If)
            and ast.unparse(node.test) == "launch_result.returncode != 0"
        )
        ordered_calls = [
            node.func.id for node in sorted(
                (item for item in ast.walk(launch_failure) if isinstance(item, ast.Call)),
                key=lambda call: call.lineno,
            ) if isinstance(node.func, ast.Name)
            and node.func.id in {"register_compiled_chief_container", "compiled_startup_diagnostics"}
        ]
        self.assertEqual(ordered_calls, ["register_compiled_chief_container", "compiled_startup_diagnostics"])
        timeout_handler = next(
            node for node in ast.walk(self.tree)
            if isinstance(node, ast.ExceptHandler)
            and isinstance(node.type, ast.Name) and node.type.id == "RuntimeError"
            and any(isinstance(item, ast.Call) and isinstance(item.func, ast.Name)
                    and item.func.id == "register_compiled_chief_container" for item in ast.walk(node))
        )
        timeout_calls = [
            node.func.id for node in sorted(
                (item for item in ast.walk(timeout_handler) if isinstance(item, ast.Call)),
                key=lambda call: call.lineno,
            ) if isinstance(node.func, ast.Name)
            and node.func.id in {"register_compiled_chief_container", "compiled_startup_diagnostics"}
        ]
        self.assertEqual(timeout_calls, ["register_compiled_chief_container", "compiled_startup_diagnostics"])

    def test_compiled_runtime_failure_stages_are_separated_and_ordered(self) -> None:
        stage_assignments = sorted((
            node for node in ast.walk(self.tree)
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "stage" for target in node.targets)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
            and node.value.value.startswith("runtime-")
        ), key=lambda node: node.lineno)
        stages = [node.value.value for node in stage_assignments]
        expected = ["runtime-create", "runtime-health", "runtime-config",
                    "runtime-secret-mounts", "runtime-protected-paths"]
        cursor = 0
        for stage in stages:
            if cursor < len(expected) and stage == expected[cursor]:
                cursor += 1
        self.assertEqual(cursor, len(expected), stages)


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
        self.assertEqual(set(queries), {"native", "bindings", "members", "authority"})
        self.assertGreaterEqual(queries["authority"].count("LIMIT 1025"), 4)
        self.assertIn("LIMIT 129", queries["authority"])
        self.assertIn("LIMIT 129", queries["bindings"])
        self.assertIn("LIMIT 129", queries["members"])
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
            result = namespace["financial_observer"]("authority", {
                "host": "proof-db", "port": 5432, "database": "proof", "user": "lares_financial",
                "passwordFile": "/etc/lares/secrets/financial-database-password",
            })
            self.assertEqual(result, "{}")
            self.assertEqual(len(calls), 2)
            exact_script = (root / "financial-observer.mts").read_text(encoding="utf-8")
            self.assertIn("YYYY-MM-DD\\\"T\\\"HH24:MI:SS.US\\\"Z\\\"", exact_script)
            self.assertIn("openingCap", exact_script)
            self.assertIn("actualAmount", exact_script)
            self.assertIn("invocationHash", exact_script)
            self.assertIn("grantHash", exact_script)
            self.assertIn("BEGIN READ ONLY", exact_script)
            self.assertNotIn("fixture-password-value", exact_script)


class FirstActivationMemberSummaryTests(unittest.TestCase):
    def test_actual_consumer_accepts_only_exact_member_state_roster(self) -> None:
        tree = ast.parse(PROBE.read_text(encoding="utf-8"), filename=str(PROBE))
        consumer = next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "selected_member_states_match"
        )
        namespace = {}
        module = ast.fix_missing_locations(ast.Module(body=[consumer], type_ignores=[]))
        exec(compile(module, str(PROBE), "exec"), namespace)
        matches = namespace["selected_member_states_match"]
        owner, later = "first-use-owner", "first-use-member-later"
        self.assertTrue(matches([{"memberId": owner, "state": "open"}], {owner: "open"}))
        expected = [{"memberId": owner, "state": "open"}, {"memberId": later, "state": "closed"}]
        self.assertTrue(matches(expected, {owner: "open", later: "closed"}))
        self.assertTrue(matches([dict(row, state="open") for row in expected], {owner: "open", later: "open"}))
        self.assertFalse(matches([dict(expected[0], memberId="unexpected")], {owner: "open"}))
        self.assertFalse(matches([dict(expected[0], state="closed")], {owner: "open"}))
        self.assertFalse(matches(expected[:1], {owner: "open", later: "closed"}))
        self.assertFalse(matches(expected + [dict(expected[0])], {owner: "open", later: "closed"}))
        self.assertFalse(matches([dict(expected[0]), dict(expected[0])], {owner: "open"}))
        self.assertFalse(matches([dict(expected[0], extra="unexpected")], {owner: "open"}))

    def test_financial_authority_consumer_requires_exact_existing_rows_to_remain(self) -> None:
        tree = ast.parse(PROBE.read_text(encoding="utf-8"), filename=str(PROBE))
        consumer = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                        and node.name == "financial_authority_preserved")
        namespace = {}
        module = ast.fix_missing_locations(ast.Module(body=[consumer], type_ignores=[]))
        exec(compile(module, str(PROBE), "exec"), namespace)
        compare = namespace["financial_authority_preserved"]
        before = {key: [{"id": key + "-old", "value": "canonical"}] for key in ("accounts", "windows", "bindings", "attempts")}
        before["grants"] = [{"attemptId": "grant-old", "value": "canonical"}]
        after = {key: [dict(row) for row in rows] for key, rows in before.items()}
        for key, identity in (("accounts", "id"), ("windows", "id"), ("bindings", "id"), ("attempts", "id")):
            after[key].append({"id": key + "-new", "value": "new"})
        after["grants"].append({"attemptId": "grant-new", "value": "new"})
        self.assertTrue(compare(before, after))
        changed = {key: [dict(row) for row in rows] for key, rows in after.items()}
        changed["attempts"][0]["value"] = "mutated"
        self.assertFalse(compare(before, changed))
        changed_grant = {key: [dict(row) for row in rows] for key, rows in after.items()}
        changed_grant["grants"][0]["value"] = "mutated"
        self.assertFalse(compare(before, changed_grant))

    def test_first_owner_snapshot_must_link_the_exact_settled_path(self) -> None:
        tree = ast.parse(PROBE.read_text(encoding="utf-8"), filename=str(PROBE))
        consumer = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                        and node.name == "owner_financial_authority_snapshot_complete")
        namespace = {"re": re}
        preservation = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                            and node.name == "financial_authority_preserved")
        module = ast.fix_missing_locations(ast.Module(body=[preservation, consumer], type_ignores=[]))
        exec(compile(module, str(PROBE), "exec"), namespace)
        complete = namespace["owner_financial_authority_snapshot_complete"]
        owner, installation_id, member_account_id = "first-use-owner", "installation-id", "owner-account-id"
        installation_window, member_window, binding_id, attempt_id = "install-window", "member-window", "owner-binding", "owner-attempt"
        snapshot = {
            "accounts": [
                {"id": installation_id, "kind": "installation", "state": "open", "reason": "approved",
                 "activeWindowId": installation_window},
                {"id": member_account_id, "kind": "member", "memberId": owner,
                 "installationAccountId": installation_id, "state": "open", "reason": "approved",
                 "activeWindowId": member_window},
            ],
            "windows": [{"id": installation_window, "accountId": installation_id},
                        {"id": member_window, "accountId": member_account_id}],
            "bindings": [{"id": binding_id, "memberId": owner, "state": "active",
                          "installationAccountId": installation_id, "memberAccountId": member_account_id}],
            "attempts": [{"id": attempt_id, "memberId": owner, "state": "settled",
                          "installationAccountId": installation_id, "memberAccountId": member_account_id,
                          "bindingId": binding_id, "installationWindowId": installation_window,
                          "memberWindowId": member_window, "actualAmount": "0.25"}],
            "grants": [{"attemptId": attempt_id, "grantHash": "a" * 64}],
        }
        self.assertTrue(complete(snapshot, owner))
        for key, index, field, wrong in (
            ("accounts", 1, "memberId", "different-member"),
            ("accounts", 1, "activeWindowId", "different-window"),
            ("bindings", 0, "memberAccountId", "different-account"),
            ("attempts", 0, "state", "prepared"),
            ("attempts", 0, "actualAmount", "0"),
            ("grants", 0, "attemptId", "different-attempt"),
        ):
            changed = json.loads(json.dumps(snapshot))
            changed[key][index][field] = wrong
            self.assertFalse(complete(changed, owner), (key, field))
        self.assertFalse(complete({**snapshot, "attempts": snapshot["attempts"] + [snapshot["attempts"][0]]}, owner))

    def test_each_later_settlement_is_exactly_linked_to_its_member_and_native_authority(self) -> None:
        tree = ast.parse(PROBE.read_text(encoding="utf-8"), filename=str(PROBE))
        consumer = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                        and node.name == "financial_settlement_delta_matches")
        namespace = {"re": re}
        preservation = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                            and node.name == "financial_authority_preserved")
        module = ast.fix_missing_locations(ast.Module(body=[preservation, consumer], type_ignores=[]))
        exec(compile(module, str(PROBE), "exec"), namespace)
        matches = namespace["financial_settlement_delta_matches"]
        owner, later = "first-use-owner", "first-use-member-later"
        install, owner_account, later_account = "install-account", "owner-account", "later-account"
        install_window, owner_window, later_window = "install-window", "owner-window", "later-window"
        owner_binding, later_binding = "owner-binding", "later-binding"
        baseline = {
            "accounts": [
                {"id": install, "kind": "installation", "state": "open", "reason": "approved", "activeWindowId": install_window,
                 "endpointGeneration": "7", "recoveryEpoch": "epoch-a", "policyGeneration": "11"},
                {"id": owner_account, "kind": "member", "memberId": owner, "installationAccountId": install,
                 "state": "open", "reason": "approved", "activeWindowId": owner_window, "policyGeneration": "12"},
                {"id": later_account, "kind": "member", "memberId": later, "installationAccountId": install,
                 "state": "open", "reason": "approved", "activeWindowId": later_window, "policyGeneration": "13"},
            ],
            "windows": [{"id": install_window, "accountId": install},
                        {"id": owner_window, "accountId": owner_account},
                        {"id": later_window, "accountId": later_account}],
            "bindings": [
                {"id": owner_binding, "memberId": owner, "installationAccountId": install,
                 "memberAccountId": owner_account, "endpointHash": "endpoint-owner", "credentialGeneration": "3",
                 "profileHash": "profile-owner", "state": "active"},
                {"id": later_binding, "memberId": later, "installationAccountId": install,
                 "memberAccountId": later_account, "endpointHash": "endpoint-later", "credentialGeneration": "4",
                 "profileHash": "profile-later", "state": "active"},
            ],
            "attempts": [{"id": "prior-attempt", "memberId": owner, "state": "settled", "actualAmount": "0.25"}],
            "grants": [{"attemptId": "prior-attempt", "grantHash": "a" * 64}],
        }

        def after_for(member_id: str, binding_id: str) -> dict:
            account_id = owner_account if member_id == owner else later_account
            member_window_id = owner_window if member_id == owner else later_window
            binding = next(row for row in baseline["bindings"] if row["id"] == binding_id)
            attempt = {"id": "new-attempt", "memberId": member_id, "state": "settled",
                       "installationAccountId": install, "memberAccountId": account_id,
                       "bindingId": binding_id, "installationWindowId": install_window,
                       "memberWindowId": member_window_id, "endpointHash": binding["endpointHash"],
                       "credentialGeneration": binding["credentialGeneration"], "endpointGeneration": "7",
                       "recoveryEpoch": "epoch-a", "profileHash": binding["profileHash"],
                       "installationPolicyGeneration": "11",
                       "memberPolicyGeneration": "12" if member_id == owner else "13", "actualAmount": "0.5"}
            return {key: [dict(row) for row in rows] for key, rows in baseline.items()} | {
                "attempts": [dict(row) for row in baseline["attempts"]] + [attempt],
                "grants": [dict(row) for row in baseline["grants"] +
                           [{"attemptId": "new-attempt", "grantHash": "b" * 64}]],
            }

        for member_id, binding_id in ((later, later_binding), (owner, owner_binding)):
            valid = after_for(member_id, binding_id)
            self.assertTrue(matches(baseline, valid, member_id, binding_id))
            for key, field, wrong in (
                ("attempts", "memberId", owner if member_id == later else later),
                ("attempts", "state", "prepared"),
                ("attempts", "memberAccountId", owner_account if member_id == later else later_account),
                ("attempts", "bindingId", owner_binding if binding_id == later_binding else later_binding),
                ("attempts", "memberWindowId", owner_window if member_id == later else later_window),
                ("attempts", "credentialGeneration", "wrong-generation"),
                ("attempts", "endpointHash", "wrong-endpoint"),
                ("attempts", "profileHash", "wrong-profile"),
                ("attempts", "recoveryEpoch", "wrong-epoch"),
                ("attempts", "actualAmount", "0"),
                ("grants", "attemptId", "unlinked-attempt"),
            ):
                changed = json.loads(json.dumps(valid))
                changed[key][-1][field] = wrong
                self.assertFalse(matches(baseline, changed, member_id, binding_id), (member_id, key, field))
            for key in ("attempts", "grants"):
                missing = json.loads(json.dumps(valid))
                missing[key].pop()
                self.assertFalse(matches(baseline, missing, member_id, binding_id), (member_id, "missing", key))
                extra = json.loads(json.dumps(valid))
                extra[key].append(dict(extra[key][-1]))
                self.assertFalse(matches(baseline, extra, member_id, binding_id), (member_id, "extra", key))
            changed_old = json.loads(json.dumps(valid))
            changed_old["attempts"][0]["actualAmount"] = "9"
            self.assertFalse(matches(baseline, changed_old, member_id, binding_id))
            changed_roster = json.loads(json.dumps(valid))
            changed_roster["accounts"][0]["endpointGeneration"] = "8"
            self.assertFalse(matches(baseline, changed_roster, member_id, binding_id))


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
        self.assertIn("VALUES($1,'Owner',$2,'owner','active')", source_code)
        self.assertNotIn("first-use-member-later", source_code)
        self.assertNotIn("Member A", source_code)
        self.assertNotIn("Member B", source_code)

        stages = {
            node.value.value: node.lineno
            for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
            and node.value.value in {
                "source-rows-and-readiness", "production-keeper-startup",
                "initial-budget-actions-through-console-client",
                "source-adoption-after-initial-budgets", "owner-only-host-provisioning",
                "owner-first-console-signature-and-model-request",
                "later-member-source-identity-link",
                "later-member-initial-budget-actions-through-console-client",
                "later-member-ordinary-grant-check",
                "later-member-host-account-provisioning", "later-member-native-provisioning",
                "later-member-activation", "later-member-console-signed-model-request",
                "owner-repeat-console-signed-model-request",
            }
        }
        self.assertEqual(set(stages), {
            "source-rows-and-readiness", "production-keeper-startup",
            "initial-budget-actions-through-console-client",
            "source-adoption-after-initial-budgets", "owner-only-host-provisioning",
            "owner-first-console-signature-and-model-request",
            "later-member-source-identity-link",
            "later-member-initial-budget-actions-through-console-client",
            "later-member-ordinary-grant-check",
            "later-member-host-account-provisioning", "later-member-native-provisioning",
            "later-member-activation", "later-member-console-signed-model-request",
            "owner-repeat-console-signed-model-request",
        })
        self.assertLess(stages["source-rows-and-readiness"], stages["production-keeper-startup"])
        self.assertLess(stages["production-keeper-startup"], stages["initial-budget-actions-through-console-client"])
        self.assertLess(stages["initial-budget-actions-through-console-client"], stages["source-adoption-after-initial-budgets"])
        self.assertLess(stages["source-adoption-after-initial-budgets"], stages["owner-only-host-provisioning"])
        self.assertLess(stages["owner-only-host-provisioning"], stages["owner-first-console-signature-and-model-request"])
        self.assertLess(stages["owner-first-console-signature-and-model-request"], stages["later-member-source-identity-link"])
        self.assertLess(stages["later-member-source-identity-link"], stages["later-member-initial-budget-actions-through-console-client"])
        self.assertLess(stages["later-member-initial-budget-actions-through-console-client"], stages["later-member-ordinary-grant-check"])
        self.assertLess(stages["later-member-ordinary-grant-check"], stages["later-member-host-account-provisioning"])
        self.assertLess(stages["later-member-host-account-provisioning"], stages["later-member-native-provisioning"])
        self.assertLess(stages["later-member-native-provisioning"], stages["later-member-activation"])
        self.assertLess(stages["later-member-activation"], stages["later-member-console-signed-model-request"])
        self.assertLess(stages["later-member-console-signed-model-request"], stages["owner-repeat-console-signed-model-request"])

        owner_request = next(node for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "client_result" for target in node.targets))
        owner_request_source = ast.unparse(owner_request.value)
        self.assertIn("invoke_compiled_client(owner, 'owner-first', check_refusals=True)", owner_request_source)
        request_runner = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)
                              and node.name == "invoke_compiled_client")
        request_runner_source = ast.unparse(request_runner)
        self.assertIn("'FIRST_USE_MEMBER_ID=' + member_id", request_runner_source)
        self.assertIn("'CHECK_REFUSALS=1'", request_runner_source)
        first_use_client = next(node for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == "write_text" and node.args and isinstance(node.args[0], ast.Constant)
            and "wrongMemberStatus" in node.args[0].value)
        self.assertIn("process.env.FIRST_USE_MEMBER_ID", first_use_client.args[0].value)
        self.assertIn("first-use-no-such-member", first_use_client.args[0].value)
        self.assertNotIn("first-use-member-later", first_use_client.args[0].value)

        client_builder = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                              and node.name == "initial_budget_client_source")
        namespace = {"json": json}
        module = ast.fix_missing_locations(ast.Module(body=[client_builder], type_ignores=[]))
        exec(compile(module, str(PROBE), "exec"), namespace)
        client_script = namespace["initial_budget_client_source"](
            [{"memberId":"first-use-owner","eligible":True,"setupComplete":False}], ["first-use-owner"])
        for contract in (
            "services/console/lib/keeper-client.ts", "member.initial-budget-status",
            "member.set-initial-budget", "first-use-owner", "first-use-owner@example.invalid",
            "statusCount:status.length", "capsSaved:targets.length", "const targets=[\"first-use-owner\"]",
        ):
            self.assertIn(contract, client_script)
        self.assertNotIn("console.log(sessionToken", client_script)
        later_client_script = namespace["initial_budget_client_source"](
            [{"memberId":"first-use-owner","eligible":False,"setupComplete":True},
             {"memberId":"first-use-member-later","eligible":True,"setupComplete":False}],
            ["first-use-member-later"])
        self.assertIn('"memberId":"first-use-member-later"', later_client_script)
        self.assertIn('const targets=["first-use-member-later"]', later_client_script)

        adoption_assignment = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "source_adoption_code" for target in node.targets)
        )
        self.assertIn("PgGrantStore", adoption_assignment.value.value)
        self.assertIn("adoptAgent", adoption_assignment.value.value)
        self.assertIn("updateAgentAccess", adoption_assignment.value.value)
        self.assertIn("current.accessRevision<=adopted.accessRevision", adoption_assignment.value.value)

        later_source_assignment = next(node for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "later_source_code" for target in node.targets))
        later_source = later_source_assignment.value.value
        self.assertIn("INSERT INTO users", later_source)
        self.assertIn("INSERT INTO member_provider_identities", later_source)
        self.assertIn("linked:true", later_source)
        self.assertNotIn("org_member_policy", later_source)
        later_grant_assignment = next(node for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "later_grant_code" for target in node.targets))
        later_grant = later_grant_assignment.value.value
        self.assertIn("captureUseWithExpiry(member,agent,{db})", later_grant)
        self.assertIn("await db.query('BEGIN')", later_grant)
        self.assertIn("await db.query('ROLLBACK')", later_grant)
        self.assertIn("db.release()", later_grant)
        self.assertIn("user:'lares_app'", later_grant)
        self.assertNotIn("BEGIN READ ONLY", later_grant)

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
