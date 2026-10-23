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


if __name__ == "__main__":
    unittest.main(verbosity=0)
