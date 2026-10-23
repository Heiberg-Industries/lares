"""Focused local safety tests for maintenance custody and admission primitives."""
from __future__ import annotations

import importlib.util
import ast
import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

OPS = Path(__file__).parents[1] / "ops"
SPEC = importlib.util.spec_from_file_location("maintenance_custody", OPS / "maintenance-custody.py")
custody = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(custody)
ADMISSION = OPS / "maintenance-admission.sh"
IMAGE_PROBE = Path(__file__).parents[2] / "keeper" / "tests" / "maintenance-fence-image.probe.py"


class MaintenanceAdmissionTests(unittest.TestCase):
    def setUp(self) -> None:
        private_tmp = Path("/private/tmp")
        temp_parent = private_tmp if private_tmp.is_dir() else Path(tempfile.gettempdir())
        self.temp = tempfile.TemporaryDirectory(prefix="lares-maintenance-test-", dir=temp_parent)
        self.root = Path(self.temp.name)
        self.custody_dir = self.root / "custody"
        self.admission_dir = self.root / "admission"
        self.custody_dir.mkdir(mode=0o700)
        self.admission_dir.mkdir(mode=0o755)
        self.custody_dir.chmod(0o700)
        self.admission_dir.chmod(0o755)
        self.owner = os.geteuid()
        self.installation_id = "11111111-1111-4111-8111-111111111111"
        custody.prepare(self.custody_dir, self.admission_dir, self.installation_id,
                        1, expected_uid=self.owner)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_state_is_durable_one_way_and_keeps_service_lock_inode(self) -> None:
        lock = self.admission_dir / "service-gate.lock"
        before = lock.stat().st_ino
        self.assertEqual(custody.read_intent(self.admission_dir, expected_uid=self.owner)["state"], "normal")
        custody.transition(self.custody_dir, self.admission_dir, self.installation_id, 1,
                           "entering", expected_uid=self.owner)
        self.assertEqual(custody.read_intent(self.admission_dir, expected_uid=self.owner)["state"], "entering")
        custody.transition(self.custody_dir, self.admission_dir, self.installation_id, 1,
                           "blocked", expected_uid=self.owner)
        self.assertEqual(custody.read_intent(self.admission_dir, expected_uid=self.owner)["state"], "blocked")
        self.assertEqual(lock.stat().st_ino, before)
        with self.assertRaisesRegex(ValueError, "not allowed"):
            custody.transition(self.custody_dir, self.admission_dir, self.installation_id, 1,
                               "normal", expected_uid=self.owner)

    def test_preparation_never_replaces_an_existing_service_gate(self) -> None:
        lock = self.admission_dir / "service-gate.lock"
        before = lock.stat().st_ino
        with self.assertRaises(FileExistsError):
            custody.prepare(self.custody_dir, self.admission_dir, self.installation_id,
                            2, expected_uid=self.owner)
        self.assertEqual(lock.stat().st_ino, before)
        self.assertEqual(custody.read_intent(self.admission_dir, expected_uid=self.owner)["epoch"], 1)

    def test_fresh_preparation_publishes_normal_auth_once_and_refuses_reruns(self) -> None:
        fresh = self.root / "fresh-prefix"
        fresh.mkdir()
        custody.prepare_fresh(fresh, "172.30.0.0/24", expected_uid=self.owner)
        receipt = custody.validate(fresh, "172.30.0.0/24")
        self.assertEqual(receipt["epoch"], 1)
        auth = fresh / "var/lib/lares-maintenance/postgres-auth/pg_hba.conf"
        policy = auth.read_text(encoding="ascii")
        self.assertIn("host all lares_app 172.30.0.0/24 scram-sha-256", policy)
        self.assertIn("host all lares_workflow_provisioner 127.0.0.1/32 scram-sha-256", policy)
        self.assertIn("host all lares_workflow 127.0.0.1/32 scram-sha-256", policy)
        self.assertIn("host all all ::/0 reject", policy)
        self.assertNotIn("trust", policy)
        gate = fresh / "var/lib/lares-maintenance/admission/service-gate.lock"
        inode = gate.stat().st_ino
        with self.assertRaisesRegex(ValueError, "evidence"):
            custody.prepare_fresh(fresh, "172.30.0.0/24", expected_uid=self.owner)
        self.assertEqual(gate.stat().st_ino, inode)
        auth.write_text(policy + "# changed\n", encoding="ascii")
        with self.assertRaisesRegex(ValueError, "policy"):
            custody.validate(fresh, "172.30.0.0/24")

    def test_unconfirmed_or_non_normal_custody_is_never_prepared_or_repaired(self) -> None:
        fresh = self.root / "guarded-prefix"
        fresh.mkdir()
        self.assertEqual(custody.main(["maintenance-custody.py", "prepare-fresh", str(fresh), "172.30.0.0/24"]), 1)
        custody.prepare_fresh(fresh, "172.30.0.0/24", expected_uid=self.owner)
        gate = fresh / "var/lib/lares-maintenance/admission/service-gate.lock"
        inode = gate.stat().st_ino
        receipt = custody.validate(fresh, "172.30.0.0/24")
        admission = fresh / "var/lib/lares-maintenance/admission"
        custody.transition(fresh / "var/lib/lares-maintenance/custody", admission,
                           str(receipt["installationId"]), 1, "entering", expected_uid=self.owner)
        with self.assertRaisesRegex(ValueError, "not normal"):
            custody.validate(fresh, "172.30.0.0/24")
        self.assertEqual(gate.stat().st_ino, inode)
        self.assertEqual(custody.read_intent(admission, expected_uid=self.owner)["state"], "entering")

    def test_partial_fresh_custody_is_retained_and_never_adopted(self) -> None:
        fresh = self.root / "partial-prefix"
        fresh.mkdir()
        (fresh / "var/lib/lares-maintenance/custody").mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, "evidence"):
            custody.prepare_fresh(fresh, "172.30.0.0/24", expected_uid=self.owner)
        self.assertTrue((fresh / "var/lib/lares-maintenance/custody").is_dir())

    def test_concurrent_existing_root_is_refused_without_changing_its_sentinels(self) -> None:
        fresh = self.root / "concurrent-prefix"
        fresh.mkdir()
        root = fresh / "var/lib/lares-maintenance"
        original = custody._existing_path
        injected = False
        lock_inode: int | None = None

        def inject_after_evidence(prefix_fd: int, parts: tuple[str, ...]) -> bool:
            nonlocal injected, lock_inode
            found = original(prefix_fd, parts)
            if parts == ("var", "lib", "lares-maintenance") and not injected:
                root.mkdir(parents=True)
                admission = root / "admission"
                admission.mkdir()
                lock = admission / "service-gate.lock"
                lock.write_bytes(b"concurrent sentinel")
                lock_inode = lock.stat().st_ino
                injected = True
            return found

        with patch.object(custody, "_existing_path", side_effect=inject_after_evidence):
            with self.assertRaises(FileExistsError):
                custody.prepare_fresh(fresh, "172.30.0.0/24", expected_uid=self.owner)
        lock = root / "admission/service-gate.lock"
        self.assertEqual(lock.read_bytes(), b"concurrent sentinel")
        self.assertEqual(lock.stat().st_ino, lock_inode)
        self.assertFalse((root / "custody/preparation.pending").exists())

    def test_symlinked_prefix_var_refuses_before_redirected_writes(self) -> None:
        fresh = self.root / "symlink-prefix"
        target = self.root / "redirect-target"
        fresh.mkdir()
        target.mkdir()
        (fresh / "var").symlink_to(target, target_is_directory=True)
        with self.assertRaises(ValueError):
            custody.prepare_fresh(fresh, "172.30.0.0/24", expected_uid=self.owner)
        self.assertFalse((target / "lib/lares-maintenance").exists())

    def test_established_installation_evidence_blocks_fresh_custody_and_is_retained(self) -> None:
        evidence = (
            ("etc/lares/installation.env", b"settings\n"),
            ("etc/lares/database-bootstrap-complete", b"done\n"),
            ("etc/lares/secrets", None),
            ("var/lib/lares/budget-financial", None),
            ("var/lib/lares/budget-native", None),
            ("var/lib/lares-vault-git", None),
            ("srv/lares/agents", None),
        )
        for index, (relative, payload) in enumerate(evidence):
            with self.subTest(relative=relative):
                fresh = self.root / f"evidence-{index}"
                fresh.mkdir()
                marker = fresh / relative
                if payload is None:
                    marker.mkdir(parents=True)
                else:
                    marker.parent.mkdir(parents=True)
                    marker.write_bytes(payload)
                with self.assertRaisesRegex(ValueError, "evidence"):
                    custody.prepare_fresh(fresh, "172.30.0.0/24", expected_uid=self.owner)
                self.assertTrue(marker.exists())
                self.assertFalse((fresh / "var/lib/lares-maintenance/custody/preparation.json").exists())

    def test_receipt_publication_fsync_error_leaves_closed_marker(self) -> None:
        fresh = self.root / "fsync-prefix"
        fresh.mkdir()
        custody_path = fresh / "var/lib/lares-maintenance/custody"
        original_fsync = os.fsync
        custody_syncs = 0

        def fail_receipt_directory_sync(fd: int) -> None:
            nonlocal custody_syncs
            try:
                if os.fstat(fd).st_ino == custody_path.stat().st_ino:
                    custody_syncs += 1
                    if custody_syncs == 3:
                        raise OSError("injected receipt directory fsync failure")
            except FileNotFoundError:
                pass
            original_fsync(fd)

        with patch.object(custody.os, "fsync", side_effect=fail_receipt_directory_sync):
            with self.assertRaisesRegex(OSError, "receipt directory fsync"):
                custody.prepare_fresh(fresh, "172.30.0.0/24", expected_uid=self.owner)
        self.assertTrue((custody_path / "preparation.pending").is_file())
        with self.assertRaisesRegex(ValueError, "incomplete or uncertain"):
            custody.validate(fresh, "172.30.0.0/24")

    def test_each_precommit_file_and_parent_sync_failure_stays_closed(self) -> None:
        for failed_name in ("preparation.pending", "pg_hba.conf", "service-gate.lock",
                            "command.lock", "intent.json", "preparation.json"):
            with self.subTest(stage=failed_name):
                fresh = self.root / ("precommit-" + failed_name.replace(".", "-"))
                fresh.mkdir()
                original = custody._write_exclusive_at

                def fail_named(directory_fd: int, name: str, payload: bytes, mode: int, uid: int) -> None:
                    if name == failed_name:
                        raise OSError("injected precommit file failure")
                    original(directory_fd, name, payload, mode, uid)

                with patch.object(custody, "_write_exclusive_at", side_effect=fail_named):
                    with self.assertRaisesRegex(OSError, "precommit file failure"):
                        custody.prepare_fresh(fresh, "172.30.0.0/24", expected_uid=self.owner)
                with self.assertRaises((FileNotFoundError, ValueError)):
                    custody.validate(fresh, "172.30.0.0/24")

        for relative in ("var/lib/lares-maintenance", "var/lib", "."):
            with self.subTest(stage="directory sync " + relative):
                fresh = self.root / ("precommit-sync-" + relative.replace("/", "-").replace(".", "root"))
                fresh.mkdir()
                target = fresh / relative
                original_fsync = os.fsync

                def fail_target(fd: int) -> None:
                    try:
                        matches = os.fstat(fd).st_ino == target.stat().st_ino
                    except FileNotFoundError:
                        matches = False
                    if matches:
                        raise OSError("injected precommit directory sync failure")
                    original_fsync(fd)

                with patch.object(custody.os, "fsync", side_effect=fail_target):
                    with self.assertRaisesRegex(OSError, "precommit directory sync failure"):
                        custody.prepare_fresh(fresh, "172.30.0.0/24", expected_uid=self.owner)
                with self.assertRaises((FileNotFoundError, ValueError)):
                    custody.validate(fresh, "172.30.0.0/24")

    def test_postcommit_cleanup_sync_and_marker_recreation_failure_reports_committed(self) -> None:
        fresh = self.root / "postcommit-prefix"
        fresh.mkdir()
        custody_path = fresh / "var/lib/lares-maintenance/custody"
        original_fsync = os.fsync
        original_unlink = os.unlink
        original_write = custody._write_exclusive_at
        marker_removed = False

        def unlink_pending(name: str, *, dir_fd: int | None = None) -> None:
            nonlocal marker_removed
            original_unlink(name, dir_fd=dir_fd)
            if name == "preparation.pending":
                marker_removed = True

        def fail_cleanup_sync(fd: int) -> None:
            try:
                is_custody = os.fstat(fd).st_ino == custody_path.stat().st_ino
            except FileNotFoundError:
                is_custody = False
            if is_custody and marker_removed:
                raise OSError("injected final cleanup fsync failure")
            original_fsync(fd)

        def fail_pending_recreation(directory_fd: int, name: str, payload: bytes, mode: int, uid: int) -> None:
            if name == "preparation.pending" and payload == b"uncertain\n":
                raise OSError("injected marker recreation failure")
            original_write(directory_fd, name, payload, mode, uid)

        with patch.object(custody.os, "unlink", side_effect=unlink_pending), \
             patch.object(custody.os, "fsync", side_effect=fail_cleanup_sync), \
             patch.object(custody, "_write_exclusive_at", side_effect=fail_pending_recreation):
            custody.prepare_fresh(fresh, "172.30.0.0/24", expected_uid=self.owner)
        self.assertFalse((custody_path / "preparation.pending").exists())
        self.assertEqual(custody.validate(fresh, "172.30.0.0/24")["epoch"], 1)

    def test_receipt_requires_exact_types_and_no_unknown_or_duplicate_fields(self) -> None:
        fresh = self.root / "strict-receipt"
        fresh.mkdir()
        custody.prepare_fresh(fresh, "172.30.0.0/24", expected_uid=self.owner)
        receipt_path = fresh / "var/lib/lares-maintenance/custody/preparation.json"
        original = json.loads(receipt_path.read_text(encoding="ascii"))
        for field in ("version", "epoch", "normalPolicyVersion"):
            value = dict(original)
            value[field] = True
            receipt_path.chmod(0o600)
            receipt_path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n", encoding="ascii")
            receipt_path.chmod(0o600)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "incomplete or unsupported"):
                custody.validate(fresh, "172.30.0.0/24")
        value = dict(original)
        value["unknown"] = 1
        receipt_path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n", encoding="ascii")
        with self.assertRaisesRegex(ValueError, "incomplete or unsupported"):
            custody.validate(fresh, "172.30.0.0/24")
        raw = (json.dumps(original, sort_keys=True, separators=(",", ":")) + "\n").replace('"version":1', '"version":1,"version":1')
        receipt_path.write_text(raw, encoding="ascii")
        with self.assertRaisesRegex(ValueError, "canonical"):
            custody.validate(fresh, "172.30.0.0/24")

    def test_root_cli_refuses_nonroot_and_empty_prefix_is_normalized_by_caller(self) -> None:
        result = subprocess.run(["python3", str(OPS / "maintenance-custody.py"), "validate", str(self.root),
                                 "172.30.0.0/24"], env={k: v for k, v in os.environ.items()
                                 if k != "LARES_MAINTENANCE_TESTING"}, capture_output=True, text=True)
        if os.geteuid() != 0:
            self.assertEqual(result.returncode, 1)
            self.assertIn("requires root", result.stderr)

    def test_record_rejects_boolean_epochs_and_unknown_states(self) -> None:
        with self.assertRaisesRegex(ValueError, "epoch"):
            custody._record(self.installation_id, True, "normal")
        with self.assertRaisesRegex(ValueError, "state"):
            custody._record(self.installation_id, 1, "open")

    def test_missing_admission_files_refuse_without_normalizing_custody(self) -> None:
        intent = self.admission_dir / "intent.json"
        before = (self.admission_dir / "service-gate.lock").stat().st_ino
        intent.unlink()
        with self.assertRaises(FileNotFoundError):
            custody.read_intent(self.admission_dir, expected_uid=self.owner)
        self.assertFalse(intent.exists())
        self.assertEqual((self.admission_dir / "service-gate.lock").stat().st_ino, before)

    def test_writable_and_symlink_ancestors_refuse(self) -> None:
        writable = self.root / "writable-parent"
        writable.mkdir(mode=0o777)
        writable.chmod(0o777)
        writable_child = writable / "admission"
        writable_child.mkdir(mode=0o755)
        with self.assertRaisesRegex(ValueError, "ancestry"):
            custody._open_directory(writable_child, 0o755, self.owner)

        target = self.root / "safe-parent"
        target.mkdir(mode=0o755)
        target.chmod(0o755)
        linked = self.root / "linked-parent"
        linked.symlink_to(target, target_is_directory=True)
        with self.assertRaises(OSError):
            custody._open_directory(linked / "admission", 0o755, self.owner)

    def test_directory_descriptor_does_not_follow_replaced_parent(self) -> None:
        parent = self.root / "stable-parent"
        parent.mkdir(mode=0o755)
        parent.chmod(0o755)
        admission = parent / "admission"
        admission.mkdir(mode=0o755)
        admission.chmod(0o755)
        replacement_custody = self.root / "replacement-custody"
        replacement_custody.mkdir(mode=0o700)
        replacement_custody.chmod(0o700)
        custody.prepare(replacement_custody, admission, self.installation_id,
                        1, expected_uid=self.owner)
        fd, directory_info = custody._open_directory(admission, 0o755, self.owner)
        moved = self.root / "moved-parent"
        os.rename(parent, moved)
        parent.mkdir(mode=0o755)
        parent.chmod(0o755)
        replacement = parent / "admission"
        replacement.mkdir(mode=0o755)
        replacement.chmod(0o755)
        try:
            with self.assertRaisesRegex(ValueError, "path changed"):
                custody._read_fd(fd, admission, directory_info, self.owner)
            self.assertFalse((replacement / "intent.json").exists())
            self.assertTrue((moved / "admission" / "intent.json").is_file())
        finally:
            os.close(fd)

    def test_oversized_intent_is_refused_before_parsing(self) -> None:
        intent = self.admission_dir / "intent.json"
        intent.chmod(0o600)
        intent.write_bytes(b"x" * (custody._MAX_INTENT_BYTES + 1))
        intent.chmod(0o444)
        with self.assertRaisesRegex(ValueError, "oversized"):
            custody.read_intent(self.admission_dir, expected_uid=self.owner)

    def test_wrong_generation_unknown_state_malformed_and_linked_files_refuse(self) -> None:
        with self.assertRaisesRegex(ValueError, "generation"):
            custody.transition(self.custody_dir, self.admission_dir,
                               "22222222-2222-4222-8222-222222222222", 1,
                               "entering", expected_uid=self.owner)
        intent = self.admission_dir / "intent.json"
        intent.chmod(0o600)
        intent.write_text('{"state":"normal"}\n', encoding="ascii")
        intent.chmod(0o444)
        with self.assertRaisesRegex(ValueError, "shape"):
            custody.read_intent(self.admission_dir, expected_uid=self.owner)
        intent.unlink()
        intent.write_bytes(b'{\n')
        intent.chmod(0o444)
        with self.assertRaisesRegex(ValueError, "malformed"):
            custody.read_intent(self.admission_dir, expected_uid=self.owner)
        intent.unlink()
        intent.write_bytes((json.dumps({"version": 1, "installationId": self.installation_id,
                                       "epoch": 1, "state": "unknown"}, sort_keys=True,
                                      separators=(",", ":")) + "\n").encode())
        intent.chmod(0o444)
        with self.assertRaisesRegex(ValueError, "state"):
            custody.read_intent(self.admission_dir, expected_uid=self.owner)
        intent.unlink()
        intent.write_bytes((json.dumps({"version": 1, "installationId": self.installation_id,
                                       "epoch": 1, "state": "normal"}, sort_keys=True,
                                      separators=(",", ":")) + "\n").encode())
        intent.chmod(0o444)
        linked = self.root / "intent-link"
        linked.hardlink_to(intent)
        with self.assertRaisesRegex(ValueError, "unsafe"):
            custody.read_intent(self.admission_dir, expected_uid=self.owner)

    def test_shell_refuses_nonroot_custody_without_running_workload(self) -> None:
        # On ordinary developer machines the fixture is user-owned, not root-owned. It must
        # fail closed, with no workload marker or leaked filesystem contents.
        marker = self.root / "ran"
        result = subprocess.run(["sh", str(ADMISSION), str(self.admission_dir), self.installation_id,
                                 "1", "--", "sh", "-c", f"touch {marker}"],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
        self.assertEqual(result.returncode, 78)
        self.assertFalse(marker.exists())
        self.assertEqual(result.stderr.strip(), "maintenance admission refused")


class MaintenanceImageProbePublicationTests(unittest.TestCase):
    def run_extracted_publication(self, *, fail_private_cleanup: bool) -> tuple[int, dict[str, object], bool, tuple[bool, bool]]:
        with tempfile.TemporaryDirectory(prefix="lares-probe-publication-") as temporary:
            base = Path(temporary)
            fixture_root = base / "fixture-root"
            private_root = base / "fixture-private"
            (private_root / "role-login-fixtures").mkdir(parents=True)
            output = base / "proof.json"
            real_rmtree = shutil.rmtree

            def rmtree(path: str | os.PathLike[str]) -> None:
                if fail_private_cleanup and Path(path) == private_root:
                    raise PermissionError("injected fixture cleanup failure")
                real_rmtree(path)

            namespace = {
                "root": fixture_root,
                "private_root": private_root,
                "known_containers": [],
                "bootstrap_file": base / "not-created-bootstrap.yml",
                "normal_file": base / "not-created-normal.yml",
                "docker": lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("Docker must not run")),
                "compose": lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("Compose must not run")),
                "shutil": SimpleNamespace(rmtree=rmtree),
                "pathlib": __import__("pathlib"),
                "json": json,
                "PROOF_PATH": str(output),
                "proof": {"status": "passed", "failedStage": None, "failureKind": None, "cleanupOkay": False},
            }
            tree = ast.parse(IMAGE_PROBE.read_text(encoding="utf-8"), filename=str(IMAGE_PROBE))
            needed = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)
                      and node.name in {"cleanup", "publish_result"}}
            self.assertEqual(set(needed), {"cleanup", "publish_result"})
            module = ast.Module(body=[needed["cleanup"], needed["publish_result"]], type_ignores=[])
            exec(compile(module, str(IMAGE_PROBE), "exec"), namespace)
            code = namespace["publish_result"](0)
            result = json.loads(output.read_text(encoding="utf-8"))
            roots_exist = fixture_root.exists(), private_root.exists()
            output_published = output.is_file()
            if fail_private_cleanup:
                real_rmtree(private_root)
            return code, result, output_published, roots_exist

    def test_successful_cleanup_publishes_passed_result_without_docker(self) -> None:
        code, result, output_published, roots_exist = self.run_extracted_publication(fail_private_cleanup=False)
        self.assertEqual(code, 0)
        self.assertEqual(result["status"], "passed")
        self.assertTrue(result["cleanupOkay"])
        self.assertFalse(result["failedStage"])
        self.assertTrue(output_published)
        self.assertEqual(roots_exist, (False, False))

    def test_failed_cleanup_still_publishes_failed_result_without_docker(self) -> None:
        code, result, output_published, roots_exist = self.run_extracted_publication(fail_private_cleanup=True)
        self.assertEqual(code, 1)
        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["cleanupOkay"])
        self.assertEqual(result["failedStage"], "cleanup")
        self.assertEqual(result["failureKind"], "cleanup")
        self.assertTrue(output_published)
        self.assertEqual(roots_exist, (False, True))


if __name__ == "__main__":
    unittest.main()
