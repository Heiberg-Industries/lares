"""Focused local safety tests for maintenance custody and admission primitives."""
from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

OPS = Path(__file__).parents[1] / "ops"
SPEC = importlib.util.spec_from_file_location("maintenance_custody", OPS / "maintenance-custody.py")
custody = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(custody)
ADMISSION = OPS / "maintenance-admission.sh"


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


if __name__ == "__main__":
    unittest.main()
