"""Focused local safety tests for maintenance custody and admission primitives."""
from __future__ import annotations

import importlib.util
import ast
import fcntl
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
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

    def _installed_bundle(self) -> tuple[Path, Path]:
        prefix = self.root / "installed-host"
        prefix.mkdir()
        custody.prepare_fresh(prefix, "172.30.0.0/24", expected_uid=self.owner)
        installed = prefix / "opt/lares"
        installed.mkdir(parents=True)
        for source in OPS.iterdir():
            if source.is_file():
                shutil.copy2(source, installed / source.name)
        (installed / "compose.yaml").write_text("services: {}\n", encoding="ascii")
        secrets = prefix / "etc/lares/secrets"
        operator = prefix / "etc/lares/operator"
        secrets.mkdir(parents=True)
        operator.mkdir(parents=True)
        app_password = secrets / "database-password"
        app_password.write_text("fixture-only\n", encoding="ascii")
        os.chown(app_password, -1, os.getegid())
        app_password.chmod(0o440)
        operator_password = operator / "database-password"
        operator_password.write_text("fixture-only\n", encoding="ascii")
        os.chown(operator_password, -1, os.getegid())
        operator_password.chmod(0o600)
        return prefix, installed

    def _test_env(self, prefix: Path, **values: str) -> dict[str, str]:
        env = os.environ.copy()
        env.update({"LARES_MAINTENANCE_TESTING": "1",
                    "LARES_PREFIX": str(prefix),
                    "DB_COMPOSE_DIR": str(prefix / "opt/lares"),
                    "UPDATE_COMPOSE_FILES": "compose.yaml",
                    "LARES_MAINTENANCE_TEST_PREFIX": str(prefix),
                    "PATH": "/usr/bin:/bin"})
        env.update(values)
        return env

    def test_update_target_requires_installer_credential_modes_and_single_links(self) -> None:
        prefix, installed = self._installed_bundle()
        app = prefix / "etc/lares/secrets/database-password"
        operator = prefix / "etc/lares/operator/database-password"
        args = (str(prefix), str(installed), "compose.yaml", str(app), str(operator),
                "127.0.0.1", "5432", "lares_state")
        custody.validate_update_target(*args, test_owner=True)

        for path, mode in ((app, 0o600), (app, 0o400), (operator, 0o440)):
            original_mode = stat.S_IMODE(path.stat().st_mode)
            path.chmod(mode)
            with self.assertRaisesRegex(ValueError, "credential"):
                custody.validate_update_target(*args, test_owner=True)
            path.chmod(original_mode)

        linked = self.root / "app-password-link"
        linked.hardlink_to(app)
        with self.assertRaisesRegex(ValueError, "credential"):
            custody.validate_update_target(*args, test_owner=True)
        linked.unlink()

        with patch.object(custody.os, "getegid", return_value=os.getegid() + 1):
            with self.assertRaisesRegex(ValueError, "credential"):
                custody.validate_update_target(*args, test_owner=True)
        with patch.object(custody.os, "geteuid", return_value=os.geteuid() + 1):
            with self.assertRaisesRegex(ValueError, "credential"):
                custody.validate_update_target(*args, test_owner=True)

        with self.assertRaisesRegex(ValueError, "credential"):
            custody.validate_update_target(*args, test_owner=False)

    def test_update_target_cli_has_exact_root_and_test_owner_arities(self) -> None:
        args = ["maintenance-custody.py", "validate-update-target", *("fixture" for _ in range(8))]
        with patch.object(custody.os, "geteuid", return_value=0), \
             patch.dict(os.environ, {"LARES_MAINTENANCE_TESTING": "1"}), \
             patch.object(custody, "validate_update_target") as validate:
            self.assertEqual(custody.main(args), 0)
            validate.assert_called_once_with(*args[2:], test_owner=False)

        for suffix in ("--test-owner", "unexpected"):
            with self.subTest(root_suffix=suffix), \
                 patch.object(custody.os, "geteuid", return_value=0), \
                 patch.dict(os.environ, {"LARES_MAINTENANCE_TESTING": "1"}), \
                 patch.object(custody, "validate_update_target") as validate:
                self.assertEqual(custody.main([*args, suffix]), 78)
                validate.assert_not_called()

        with patch.object(custody.os, "geteuid", return_value=1000), \
             patch.dict(os.environ, {}, clear=True), \
             patch.object(custody, "validate_update_target") as validate:
            self.assertEqual(custody.main([*args, "--test-owner"]), 78)
            validate.assert_not_called()

        with patch.object(custody.os, "geteuid", return_value=1000), \
             patch.dict(os.environ, {"LARES_MAINTENANCE_TESTING": "1"}), \
             patch.object(custody, "validate_update_target") as validate:
            self.assertEqual(custody.main([*args, "--test-owner"]), 0)
            validate.assert_called_once_with(*args[2:], test_owner=True)

    def _run_installed(self, prefix: Path, installed: Path, script: str,
                       *args: str, extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        env = self._test_env(prefix, **(extra_env or {}))
        if script == "setup-backups.sh":
            bindir = self.root / "bin"
            bindir.mkdir(exist_ok=True)
            id_stub = bindir / "id"
            id_stub.write_text("#!/bin/sh\necho 0\n", encoding="utf8")
            id_stub.chmod(0o755)
            env["PATH"] = f"{bindir}:/usr/bin:/bin"
        return subprocess.run(["/bin/bash", str(installed / script), *args], env=env,
                              text=True, capture_output=True, timeout=5)

    def test_installed_backup_timer_bundle_refuses_before_settings_and_effects(self) -> None:
        prefix, installed = self._installed_bundle()
        custody.transition(prefix / "var/lib/lares-maintenance/custody",
                           prefix / "var/lib/lares-maintenance/admission",
                           custody.validate(prefix)["installationId"], 1, "entering",
                           expected_uid=self.owner)
        sentinel = self.root / "settings-were-sourced"
        settings = self.root / "backup.env"
        settings.write_text(f"touch '{sentinel}'\n", encoding="utf8")
        effects = self.root / "effects.log"
        bindir = self.root / "bin"
        bindir.mkdir(exist_ok=True)
        for name in ("mktemp", "restic", "docker", "psql", "curl", "systemctl", "rm"):
            stub = bindir / name
            stub.write_text(f"#!/bin/sh\nprintf '%s\\n' '{name}' >> '{effects}'\nexit 0\n", encoding="utf8")
            stub.chmod(0o755)
        settings_env = {"AGENT_BOX_BACKUP_ENV": str(settings), "LARES_ENGINE_IMAGE": "example.invalid/engine@sha256:" + "a" * 64}
        cases = [
            ("backup.sh", ()),
            ("backup-verify.sh", ()),
            ("restore-drill.sh", ()),
            ("setup-backups.sh", ("--prefix", str(prefix), "--dry-run")),
            ("refresh-recovery.sh", ("--prefix", str(prefix))),
            ("update.sh", ("--release", str(self.root / "release.json"), "--dry-run")),
            ("rollback.sh", ("--dry-run",)),
        ]
        (self.root / "release.json").write_text("{}\n", encoding="ascii")
        for script, args in cases:
            with self.subTest(script=script):
                result = self._run_installed(prefix, installed, script, *args,
                                             extra_env={**settings_env, "PATH": f"{bindir}:/usr/bin:/bin"})
                self.assertEqual(result.returncode, 78, result.stdout + result.stderr)
                self.assertIn("maintenance admission: refused", result.stderr)
                self.assertFalse(sentinel.exists())
                self.assertFalse(effects.exists())

    def test_run_normal_holds_same_shared_descriptor_through_bash_and_fd9(self) -> None:
        prefix, installed = self._installed_bundle()
        gate = prefix / "var/lib/lares-maintenance/admission/service-gate.lock"
        if sys.platform.startswith("linux"):
            self.assertNotEqual(str(gate.stat().st_ino), format(gate.stat().st_ino, "x"),
                                "the Linux test must exercise differing decimal/hex inode spellings")
        script = installed / "backup.sh"
        script.write_text("""#!/bin/bash
set -euo pipefail
python3 \"$(dirname \"$0\")/maintenance-custody.py\" assert-normal-held \"$LARES_MAINTENANCE_TEST_PREFIX\" backup --test-owner
python3 - \"$1\" \"$2\" <<'PY'
import json,os,sys
os.write(1,(json.dumps({'args':sys.argv[1:],'lease':(os.fstat(197).st_dev,os.fstat(197).st_ino),'fd9':os.fstat(9).st_ino})+'\\n').encode())
PY
""", encoding="utf8")
        script.chmod(0o750)
        fd9_path = self.root / "fd9-marker"
        fd9_path.write_text("fd9 remains open", encoding="utf8")
        fd9 = os.open(fd9_path, os.O_RDONLY)
        saved9 = -1
        try:
            try:
                saved9 = os.dup(9)
            except OSError:
                pass
            os.dup2(fd9, 9, inheritable=True)
            os.set_inheritable(9, True)
            result = subprocess.run(["python3", str(installed / "maintenance-custody.py"),
                                     "run-normal", str(prefix), "backup", "--test-owner", "--",
                                     "alpha", "two words"], env=self._test_env(prefix),
                                    pass_fds=(9,), text=True, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            observed = json.loads(result.stdout)
            self.assertEqual(observed["args"], ["alpha", "two words"])
            self.assertEqual(tuple(observed["lease"]), (gate.stat().st_dev, gate.stat().st_ino))
            self.assertEqual(observed["fd9"], fd9_path.stat().st_ino)
        finally:
            if saved9 >= 0:
                os.dup2(saved9, 9, inheritable=True)
                os.close(saved9)
            else:
                os.close(9)
            os.close(fd9)

    def test_inherited_open_but_unlocked_and_forged_environment_refuse(self) -> None:
        prefix, installed = self._installed_bundle()
        script = installed / "backup.sh"
        script.write_text("#!/bin/sh\necho ran > '$LARES_MAINTENANCE_TEST_PREFIX/ran'\n", encoding="utf8")
        script.chmod(0o750)
        gate = prefix / "var/lib/lares-maintenance/admission/service-gate.lock"
        gate_fd = os.open(gate, os.O_RDONLY)
        saved197 = -1
        try:
            try:
                saved197 = os.dup(197)
            except OSError:
                pass
            os.dup2(gate_fd, 197, inheritable=True)
            result = subprocess.run(["python3", str(installed / "maintenance-custody.py"),
                                     "run-normal", str(prefix), "backup", "--test-owner", "--"],
                                    env=self._test_env(prefix), pass_fds=(197,), text=True,
                                    capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 78)
            self.assertFalse((prefix / "ran").exists())
            forged = subprocess.run(["python3", str(installed / "maintenance-custody.py"),
                                     "assert-normal-held", str(prefix), "backup", "--test-owner"],
                                    env=self._test_env(prefix, LARES_MAINTENANCE_ADMITTED="1"),
                                    text=True, capture_output=True, timeout=5)
            self.assertEqual(forged.returncode, 78)
        finally:
            if saved197 >= 0:
                os.dup2(saved197, 197, inheritable=True)
                os.close(saved197)
            else:
                os.close(197)
            os.close(gate_fd)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux /proc/self/fdinfo is the production proof")
    def test_inherited_exclusive_lease_is_rejected_without_conversion(self) -> None:
        prefix, installed = self._installed_bundle()
        ran = self.root / "ran"
        script = installed / "backup.sh"
        script.write_text(f"#!/bin/sh\ntouch '{ran}'\n", encoding="utf8")
        script.chmod(0o750)
        gate = prefix / "var/lib/lares-maintenance/admission/service-gate.lock"
        gate_fd = os.open(gate, os.O_RDONLY)
        fcntl.flock(gate_fd, fcntl.LOCK_EX)
        saved197 = -1
        try:
            try:
                saved197 = os.dup(197)
            except OSError:
                pass
            os.dup2(gate_fd, 197, inheritable=True)
            result = subprocess.run(
                ["python3", str(installed / "maintenance-custody.py"),
                 "run-normal", str(prefix), "backup", "--test-owner", "--"],
                env=self._test_env(prefix),
                pass_fds=(197,), text=True, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 78, result.stdout + result.stderr)
            self.assertFalse(ran.exists())
            self.assertEqual(custody._linux_lock_mode_for_fd(197, os.fstat(gate_fd)), "WRITE")
        finally:
            if saved197 >= 0:
                os.dup2(saved197, 197, inheritable=True)
                os.close(saved197)
            else:
                os.close(197)
            fcntl.flock(gate_fd, fcntl.LOCK_UN)
            os.close(gate_fd)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux fdinfo ties evidence to fd197")
    def test_unrelated_shared_holder_cannot_authorize_unlocked_fd197(self) -> None:
        prefix, installed = self._installed_bundle()
        ran = self.root / "ran"
        script = installed / "backup.sh"
        script.write_text(f"#!/bin/sh\ntouch '{ran}'\n", encoding="utf8")
        script.chmod(0o750)
        gate = prefix / "var/lib/lares-maintenance/admission/service-gate.lock"
        gate_info = gate.stat()
        holder_fd = os.open(gate, os.O_RDONLY)
        unlocked_fd = os.open(gate, os.O_RDONLY)
        fcntl.flock(holder_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        saved197 = -1
        try:
            try:
                saved197 = os.dup(197)
            except OSError:
                pass
            os.dup2(unlocked_fd, 197, inheritable=True)
            self.assertIsNone(custody._linux_lock_mode_for_fd(197, gate_info))
            result = subprocess.run(
                ["python3", str(installed / "maintenance-custody.py"),
                 "run-normal", str(prefix), "backup", "--test-owner", "--"],
                env=self._test_env(prefix, LARES_MAINTENANCE_HOLDER_PID=str(os.getpid())),
                pass_fds=(197,), text=True, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 78, result.stdout + result.stderr)
            self.assertFalse(ran.exists())
            self.assertEqual(custody._linux_lock_mode_for_fd(holder_fd, gate_info), "READ")
            self.assertIsNone(custody._linux_lock_mode_for_fd(197, gate_info))
        finally:
            if saved197 >= 0:
                os.dup2(saved197, 197, inheritable=True)
                os.close(saved197)
            else:
                os.close(197)
            os.close(unlocked_fd)
            fcntl.flock(holder_fd, fcntl.LOCK_UN)
            os.close(holder_fd)

    def test_wrong_inherited_descriptor_refuses_without_starting_the_fixed_script(self) -> None:
        prefix, installed = self._installed_bundle()
        ran = self.root / "ran"
        script = installed / "backup.sh"
        script.write_text(f"#!/bin/sh\ntouch '{ran}'\n", encoding="utf8")
        script.chmod(0o750)
        decoy = self.root / "decoy"
        decoy.write_text("not the service gate", encoding="utf8")
        decoy_fd = os.open(decoy, os.O_RDONLY)
        saved197 = -1
        try:
            try:
                saved197 = os.dup(197)
            except OSError:
                pass
            os.dup2(decoy_fd, 197, inheritable=True)
            result = subprocess.run(
                ["python3", str(installed / "maintenance-custody.py"),
                 "run-normal", str(prefix), "backup", "--test-owner", "--"],
                env=self._test_env(prefix), pass_fds=(197,), text=True,
                capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 78, result.stdout + result.stderr)
            self.assertFalse(ran.exists())
        finally:
            if saved197 >= 0:
                os.dup2(saved197, 197, inheritable=True)
                os.close(saved197)
            else:
                os.close(197)
            os.close(decoy_fd)

    def test_lock_and_intent_open_races_to_fifo_fail_without_blocking(self) -> None:
        gate_path = self.admission_dir / "service-gate.lock"
        gate_fd = os.open(self.admission_dir, custody._DIRECTORY_FLAGS)
        original_open = os.open
        replaced = False

        def swap_gate(name: str | bytes, flags: int, *args: object, **kwargs: object) -> int:
            nonlocal replaced
            if name == "service-gate.lock" and kwargs.get("dir_fd") == gate_fd and not replaced:
                replaced = True
                gate_path.unlink()
                os.mkfifo(gate_path, 0o444)
            return original_open(name, flags, *args, **kwargs)

        try:
            started = time.monotonic()
            with patch.object(custody.os, "open", side_effect=swap_gate):
                with self.assertRaisesRegex(ValueError, "changed while opening"):
                    custody._open_fixed_file(gate_fd, "service-gate.lock", 0o444, self.owner)
            self.assertTrue(replaced)
            self.assertLess(time.monotonic() - started, 0.5)
        finally:
            os.close(gate_fd)

        gate_path.unlink()
        gate_path.write_bytes(b"")
        gate_path.chmod(0o444)
        admission_fd, directory_info = custody._open_directory(self.admission_dir, 0o755, self.owner)
        intent_path = self.admission_dir / "intent.json"
        replaced = False

        def swap_intent(name: str | bytes, flags: int, *args: object, **kwargs: object) -> int:
            nonlocal replaced
            if name == "intent.json" and kwargs.get("dir_fd") == admission_fd and not replaced:
                replaced = True
                intent_path.unlink()
                os.mkfifo(intent_path, 0o444)
            return original_open(name, flags, *args, **kwargs)

        try:
            started = time.monotonic()
            with patch.object(custody.os, "open", side_effect=swap_intent):
                with self.assertRaisesRegex(ValueError, "intent changed while opening"):
                    custody._read_fd(admission_fd, self.admission_dir, directory_info, self.owner)
            self.assertTrue(replaced)
            self.assertLess(time.monotonic() - started, 0.5)
        finally:
            os.close(admission_fd)
            intent_path.unlink(missing_ok=True)
            intent_path.write_bytes(custody._record(self.installation_id, 1, "normal"))
            intent_path.chmod(0o444)

    def test_intent_open_rejects_nonregular_descriptor_with_matching_identity(self) -> None:
        admission_fd, directory_info = custody._open_directory(self.admission_dir, 0o755, self.owner)
        original_open = os.open
        original_fstat = os.fstat
        intent_fd: int | None = None
        intent_info = custody._file_at(admission_fd, "intent.json", 0o444, self.owner,
                                       maximum_size=custody._MAX_INTENT_BYTES)

        def track_open(name: str | bytes, flags: int, *args: object, **kwargs: object) -> int:
            nonlocal intent_fd
            fd = original_open(name, flags, *args, **kwargs)
            if name == "intent.json" and kwargs.get("dir_fd") == admission_fd:
                intent_fd = fd
            return fd

        def report_fifo_for_intent(fd: int) -> os.stat_result | SimpleNamespace:
            info = original_fstat(fd)
            if fd != intent_fd:
                return info
            simulated_fifo = SimpleNamespace(
                st_dev=info.st_dev,
                st_ino=info.st_ino,
                st_nlink=info.st_nlink,
                st_uid=info.st_uid,
                st_mode=stat.S_IFIFO | stat.S_IMODE(info.st_mode),
                st_size=info.st_size,
            )
            self.assertTrue(custody._same_file(intent_info, simulated_fifo))
            self.assertFalse(stat.S_ISREG(simulated_fifo.st_mode))
            return simulated_fifo

        try:
            with patch.object(custody.os, "open", side_effect=track_open), \
                    patch.object(custody.os, "fstat", side_effect=report_fifo_for_intent):
                with self.assertRaisesRegex(ValueError, "intent changed while opening"):
                    custody._read_fd(admission_fd, self.admission_dir, directory_info, self.owner)
            self.assertIsNotNone(intent_fd)
        finally:
            os.close(admission_fd)

    def test_command_lock_contention_has_a_monotonic_deadline(self) -> None:
        path = self.custody_dir / "command.lock"
        first = os.open(path, os.O_RDWR)
        second = os.open(path, os.O_RDWR | os.O_NONBLOCK)
        try:
            fcntl.flock(first, fcntl.LOCK_EX | fcntl.LOCK_NB)
            started = time.monotonic()
            with self.assertRaisesRegex(ValueError, "busy"):
                custody._lock_with_deadline(second, fcntl.LOCK_EX, "test admission")
            elapsed = time.monotonic() - started
            self.assertGreaterEqual(elapsed, 0.9)
            self.assertLess(elapsed, 1.5)
        finally:
            fcntl.flock(first, fcntl.LOCK_UN)
            os.close(first)
            os.close(second)

    def test_entering_publishes_while_an_admitted_process_drains(self) -> None:
        prefix, installed = self._installed_bundle()
        started, release = self.root / "started", self.root / "release"
        script = installed / "backup.sh"
        script.write_text(f"""#!/bin/bash
set -euo pipefail
python3 \"$(dirname \"$0\")/maintenance-custody.py\" assert-normal-held \"$LARES_MAINTENANCE_TEST_PREFIX\" backup --test-owner
touch '{started}'
while [ ! -e '{release}' ]; do sleep 0.01; done
""", encoding="utf8")
        script.chmod(0o750)
        command = ["python3", str(installed / "maintenance-custody.py"), "run-normal",
                   str(prefix), "backup", "--test-owner", "--"]
        process = subprocess.Popen(command, env=self._test_env(prefix), text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while not started.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(started.exists(), "the admitted job did not start")
            receipt = custody.validate(prefix)
            custody.transition(prefix / "var/lib/lares-maintenance/custody",
                               prefix / "var/lib/lares-maintenance/admission",
                               receipt["installationId"], 1, "entering", expected_uid=self.owner)
            self.assertEqual(custody.read_intent(prefix / "var/lib/lares-maintenance/admission",
                                                 expected_uid=self.owner)["state"], "entering")
            nested = subprocess.run(command, env=self._test_env(prefix), text=True,
                                     capture_output=True, timeout=5)
            self.assertEqual(nested.returncode, 78)
            gate_fd = os.open(prefix / "var/lib/lares-maintenance/admission/service-gate.lock", os.O_RDONLY)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(gate_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(gate_fd)
        finally:
            release.touch()
            stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0, stdout + stderr)

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
    def test_keeper_candidate_tag_is_resolved_to_local_config_id_for_the_fixture_only(self) -> None:
        tree = ast.parse(IMAGE_PROBE.read_text(encoding="utf-8"), filename=str(IMAGE_PROBE))
        helper = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                      and node.name == "candidate_image_config_id")
        class ProbeFailure(Exception):
            pass
        calls: list[tuple[tuple[str, ...], dict[str, object]]] = []
        def docker(*args: str, **kwargs: object) -> SimpleNamespace:
            calls.append((args, kwargs))
            return SimpleNamespace(stdout="sha256:" + "a" * 64 + "\n", returncode=0)
        namespace: dict[str, object] = {"docker": docker, "re": __import__("re"),
                                        "ProbeFailure": ProbeFailure}
        exec(compile(ast.Module(body=[helper], type_ignores=[]), str(IMAGE_PROBE), "exec"), namespace)
        self.assertEqual(namespace["candidate_image_config_id"]("lares-keeper:test"),
                         "sha256:" + "a" * 64)
        self.assertEqual(calls[0][0], ("image", "inspect", "--format", "{{.Id}}", "lares-keeper:test"))
        self.assertEqual(calls[0][1], {"check": False, "timeout": 20})
        proof_function = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                              and node.name == "prove_update_history_client_lease")
        proof_source = ast.get_source_segment(IMAGE_PROBE.read_text(encoding="utf-8"), proof_function)
        self.assertIn('"ENGINE_IMAGE=" + shlex.quote(candidate_id)', proof_source)
        self.assertIn('info.get("Image") != candidate_id', proof_source)
        self.assertNotIn("engine_resolve_image", proof_source)

    def test_actual_embedded_fd9_inspector_accepts_linux_lock_format_and_rejects_bad_records(self) -> None:
        tree = ast.parse(IMAGE_PROBE.read_text(encoding="utf-8"), filename=str(IMAGE_PROBE))
        value = next(node.value for node in tree.body if isinstance(node, ast.Assign)
                     and any(isinstance(target, ast.Name) and target.id == "UPDATE_CLIENT_FD9_INSPECT"
                             for target in node.targets))
        inspector = ast.literal_eval(value)
        with tempfile.TemporaryDirectory(prefix="lares-fd9-inspector-") as temporary:
            root = Path(temporary)
            proc = root / "proc"
            process = proc / "1"
            (process / "fd").mkdir(parents=True)
            (process / "fdinfo").mkdir()
            target = root / "gate"
            target.write_text("gate", encoding="ascii")
            (process / "fd/9").symlink_to(target)
            (process / "exe").symlink_to(Path(sys.executable).with_name("node"))
            script = "/app/services/box/bin/update-record.ts"
            (process / "cmdline").write_bytes(b"node\0--import\0tsx/esm\0" + script.encode() + b"\0")
            info = target.stat()
            dev = f"{os.major(info.st_dev):02x}:{os.minor(info.st_dev):02x}"
            inode = info.st_ino
            def run(record: str) -> subprocess.CompletedProcess[str]:
                (process / "fdinfo/9").write_text(record, encoding="ascii")
                return subprocess.run([sys.executable, "-c", inspector, str(info.st_dev), str(inode),
                                       script, str(proc)], capture_output=True, text=True, timeout=3)
            records = [
                f"pos:\t0\nflags:\t0100000\nino:\t{inode}\nlock:   1:  FLOCK  ADVISORY  READ  1234 {dev}:{inode} 0 EOF\n",
                f"pos: 0\nflags: 0100000\nino: {inode}\nlock: 1: FLOCK ADVISORY READ 1234 {dev}:{inode} 0 EOF\n",
                f"pos: 0\nflags: 0100000\nino: {inode}\nlock: 1:\tFLOCK\tADVISORY\tREAD\t1234\t{dev}:{inode}\t0\tEOF\n",
            ]
            for record in records:
                with self.subTest(record=record):
                    self.assertEqual(run(record).returncode, 0)
            bad_base = records[1]
            bad_records = [
                bad_base.replace("READ 1234", "WRITE 1234"),
                bad_base.replace("FLOCK ADVISORY", "POSIX ADVISORY"),
                bad_base.replace("READ 1234", "READ not-a-pid"),
                bad_base.replace(" 0 EOF", " 1 EOF"),
                bad_base.replace(f"{dev}:{inode}", f"{dev}:{inode + 1}"),
                bad_base.replace(f"ino: {inode}", f"ino: {inode + 1}"),
                bad_base + f"ino: {inode}\n",
                bad_base.replace("READ 1234", "READ\v1234"),
                bad_base.replace("flags: 0100000", "flags: 0100001"),
                bad_base + "lock:" + bad_base.split("lock:", 1)[1],
            ]
            for record in bad_records:
                with self.subTest(record=record):
                    self.assertNotEqual(run(record).returncode, 0)

    def test_update_client_probe_recovers_only_exact_intent_and_isolates_cleanup(self) -> None:
        tree = ast.parse(IMAGE_PROBE.read_text(encoding="utf-8"), filename=str(IMAGE_PROBE))
        helpers = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)
                   and node.name in {"parse_update_client_intent", "update_client_info_matches",
                                     "run_cleanup_actions", "stop_and_reap_process",
                                     "finish_update_client_cleanup"}}
        self.assertEqual(set(helpers), {"parse_update_client_intent", "update_client_info_matches",
                                        "run_cleanup_actions", "stop_and_reap_process",
                                        "finish_update_client_cleanup"})
        signal_import = next((node for node in tree.body if isinstance(node, ast.Import)
                              and any(alias.name == "signal" for alias in node.names)), None)
        self.assertIsNotNone(signal_import, "probe must import signal in module scope")
        namespace: dict[str, object] = {"re": __import__("re"), "os": os,
                                        "subprocess": subprocess}
        exec(compile(ast.Module(body=[signal_import], type_ignores=[]), str(IMAGE_PROBE), "exec"), namespace)
        self.assertIs(namespace["signal"], __import__("signal"))
        exec(compile(ast.Module(body=list(helpers.values()), type_ignores=[]), str(IMAGE_PROBE), "exec"), namespace)
        parse_intent = namespace["parse_update_client_intent"]
        matches = namespace["update_client_info_matches"]
        run_actions = namespace["run_cleanup_actions"]
        token = "a" * 32
        name = "lares-update-client-" + token
        self.assertEqual(parse_intent(f"{name}\n{token}\nupdate\n"), (name, token))
        self.assertIsNone(parse_intent(f"{name}\n{token}\nrollback\n"))
        self.assertIsNone(parse_intent(f"lares-update-client-{'b' * 32}\n{token}\nupdate\n"))
        self.assertIsNone(parse_intent("x" * 129))

        container_id = "c" * 64
        info = {"Id": container_id, "Name": "/" + name,
                "Config": {"Labels": {"com.lares.maintenance.owner": token,
                                        "com.lares.maintenance.operation": "update"}}}
        self.assertTrue(matches(info, container_id, name, token, "update"))
        self.assertFalse(matches(info, "c" * 12, name, token, "update"))
        self.assertFalse(matches({**info, "Name": "/replacement"}, container_id, name, token, "update"))
        self.assertFalse(matches(info, container_id, name, "d" * 32, "update"))

        calls: list[str] = []
        def fail() -> bool:
            calls.append("first")
            raise RuntimeError("injected cleanup failure")
        def continue_cleanup() -> bool:
            calls.append("second")
            return True
        self.assertFalse(run_actions([fail, continue_cleanup]))
        self.assertEqual(calls, ["first", "second"])

        class FakeProcess:
            pid = 4242
            def poll(self) -> None:
                return None
            def wait(self, *, timeout: int) -> None:
                self.assert_timeout = timeout
        import signal
        observed: list[tuple[int, int]] = []
        fake_process = FakeProcess()
        with patch.object(os, "killpg", side_effect=lambda pid, sig: observed.append((pid, sig))):
            stopped = namespace["stop_and_reap_process"](fake_process)
        self.assertTrue(stopped)
        self.assertEqual(observed, [(4242, signal.SIGKILL)])
        self.assertEqual(fake_process.assert_timeout, 5)

        class FailingProcess(FakeProcess):
            def wait(self, *, timeout: int) -> None:
                self.assert_timeout = timeout
                raise TimeoutError("injected wait failure")
        actions_called: list[str] = []
        proof = {"stages": {}}
        with patch.object(os, "killpg", side_effect=PermissionError("injected kill failure")):
            finished = namespace["finish_update_client_cleanup"](
                [lambda: actions_called.append("owned-cleanup") is None], FailingProcess(), proof)
        self.assertFalse(finished)
        self.assertEqual(actions_called, ["owned-cleanup"])
        self.assertEqual(proof["stages"]["updateClientCleanupVerified"], False)

        proof_function = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                              and node.name == "prove_update_history_client_lease")
        calls_in_proof = [node.func.id for node in ast.walk(proof_function)
                          if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)]
        self.assertIn("parse_update_client_intent", calls_in_proof)
        self.assertIn("update_client_info_matches", calls_in_proof)
        self.assertIn("finish_update_client_cleanup", calls_in_proof)
        self.assertIn("post_exit_evidence", {node.id for node in ast.walk(proof_function)
                                             if isinstance(node, ast.Name)})

    def run_extracted_publication(self, *, fail_private_cleanup: bool,
                                  client_cleanup_failed: bool = False) -> tuple[int, dict[str, object], bool, tuple[bool, bool]]:
        with tempfile.TemporaryDirectory(prefix="lares-probe-publication-") as temporary:
            base = Path(temporary)
            fixture_root = base / "fixture-root"
            fixture_root.mkdir()
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
                "os": os,
                "subprocess": subprocess,
                "PROOF_PATH": str(output),
                "proof": {"status": "passed", "failedStage": None, "failureKind": None,
                          "cleanupOkay": False, "stages": {}},
            }
            tree = ast.parse(IMAGE_PROBE.read_text(encoding="utf-8"), filename=str(IMAGE_PROBE))
            needed = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)
                      and node.name in {"run_cleanup_actions", "stop_and_reap_process",
                                        "finish_update_client_cleanup", "cleanup", "publish_result"}}
            self.assertEqual(set(needed), {"run_cleanup_actions", "stop_and_reap_process",
                                           "finish_update_client_cleanup", "cleanup", "publish_result"})
            signal_import = next(node for node in tree.body if isinstance(node, ast.Import)
                                 and any(alias.name == "signal" for alias in node.names))
            module = ast.Module(body=[signal_import, needed["run_cleanup_actions"],
                                      needed["stop_and_reap_process"],
                                      needed["finish_update_client_cleanup"],
                                      needed["cleanup"], needed["publish_result"]], type_ignores=[])
            exec(compile(module, str(IMAGE_PROBE), "exec"), namespace)
            if client_cleanup_failed:
                class ExitedProcess:
                    pid = 4242
                    def poll(self) -> None:
                        return None
                    def wait(self, *, timeout: int) -> None:
                        self.assert_timeout = timeout
                observed: list[tuple[int, int]] = []
                final_actions: list[str] = []
                blocker = ExitedProcess()
                with patch.object(os, "killpg", side_effect=lambda pid, sig: observed.append((pid, sig))):
                    aggregate = namespace["finish_update_client_cleanup"](
                        [lambda: final_actions.append("last-action") is None], blocker,
                        namespace["proof"], False)
                self.assertFalse(aggregate)
                self.assertEqual(final_actions, ["last-action"])
                self.assertEqual(observed, [(4242, __import__("signal").SIGKILL)])
                self.assertEqual(blocker.assert_timeout, 5)
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

    def test_late_client_cleanup_failure_retains_probe_roots_and_publishes_failure(self) -> None:
        code, result, output_published, roots_exist = self.run_extracted_publication(
            fail_private_cleanup=False, client_cleanup_failed=True)
        self.assertEqual(code, 1)
        self.assertEqual(result["failureKind"], "cleanup")
        self.assertFalse(result["cleanupOkay"])
        self.assertTrue(output_published)
        self.assertEqual(roots_exist, (True, True))


if __name__ == "__main__":
    unittest.main()
