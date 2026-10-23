"""Focused filesystem/process regression checks for the privileged bootstrap writer."""

from __future__ import annotations

import importlib.util
import fcntl
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT = Path(__file__).parents[1] / "ops" / "owner-bootstrap.py"
spec = importlib.util.spec_from_file_location("owner_bootstrap", SCRIPT)
owner_bootstrap = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(owner_bootstrap)


class OwnerBootstrapSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="lares-owner-bootstrap-test-")
        self.prefix = Path(self.temporary.name)
        self.etc = self.prefix / "etc" / "lares"
        self.etc.mkdir(parents=True)
        self.install = self.etc / "installation.env"
        self.install.write_text("LARES_OWNER_ID=stable-owner\nLARES_DOMAIN=example.test\n", encoding="utf-8")
        self.install.chmod(0o640)
        self.keeper = self.etc / "keeper.json"
        self.keeper.write_text('{"designatedOwnerId":"stable-owner"}\n', encoding="utf-8")
        self.keeper.chmod(0o600)
        self.oauth = self.etc / "console-oauth.env"
        self.original = b"GOOGLE_CLIENT_ID_CONSOLE=synthetic-client\nGOOGLE_CLIENT_SECRET_CONSOLE=synthetic-secret\n"
        self.oauth.write_bytes(self.original)
        self.oauth.chmod(0o600)
        self.identity_a = {"issuer": "https://accounts.google.com", "subject": "synthetic-account-a"}
        self.identity_b = {"issuer": "https://accounts.google.com", "subject": "synthetic-account-b"}
        self.receipt_a = self.receipt(self.identity_a)
        self.receipt_b = self.receipt(self.identity_b)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @staticmethod
    def receipt(identity: dict[str, str]) -> str:
        origin = "https://example.test"
        return json.dumps({"installationOrigin": origin, "identity": identity,
                           "digest": owner_bootstrap.receipt_digest(origin, identity)})

    def root_context(self):
        return (
            patch.object(owner_bootstrap.os, "geteuid", return_value=0),
            patch.object(owner_bootstrap, "is_root_owned", return_value=True),
            patch.object(owner_bootstrap.os, "fchown", return_value=None),
        )

    def test_nonroot_refusal_and_protected_path_checks(self) -> None:
        with patch.object(owner_bootstrap.os, "geteuid", return_value=501):
            with self.assertRaisesRegex(PermissionError, "run this command as root"):
                owner_bootstrap.run(self.prefix, self.receipt_a)
        self.assertEqual(self.oauth.read_bytes(), self.original)

        symlink = self.etc / "oauth-link.env"
        symlink.symlink_to(self.oauth)
        with self.assertRaises(OSError):
            owner_bootstrap.read_protected(symlink, 0o600)
        with self.assertRaises(ValueError):
            owner_bootstrap.read_protected(self.oauth, 0o640)
        unsafe_dir = self.prefix / "unsafe"
        unsafe_dir.mkdir()
        unsafe_dir.chmod(0o777)
        with self.assertRaises(ValueError):
            owner_bootstrap.require_directory(unsafe_dir)
        self.assertFalse(owner_bootstrap.is_root_owned(self.oauth.stat()))
        fake_root_stat = os.stat_result([self.oauth.stat().st_mode, self.oauth.stat().st_ino,
                                         self.oauth.stat().st_dev, self.oauth.stat().st_nlink,
                                         0, self.oauth.stat().st_gid, self.oauth.stat().st_size,
                                         self.oauth.stat().st_atime, self.oauth.stat().st_mtime,
                                         self.oauth.stat().st_ctime])
        self.assertTrue(owner_bootstrap.is_root_owned(fake_root_stat))

    def test_preflight_refusal_preserves_bytes_and_releases_host_lock(self) -> None:
        geteuid, root_owned, fchown = self.root_context()
        with geteuid, root_owned, fchown, patch.object(owner_bootstrap, "run_preflight", side_effect=RuntimeError("synthetic refusal")):
            with self.assertRaisesRegex(RuntimeError, "synthetic refusal"):
                owner_bootstrap.run(self.prefix, self.receipt_a)
            self.assertEqual(self.oauth.read_bytes(), self.original)
            with patch.object(owner_bootstrap, "run_preflight", return_value=None):
                owner_bootstrap.run(self.prefix, self.receipt_a)
            self.assertIn(b"CONSOLE_BOOTSTRAP_IDENTITY=", self.oauth.read_bytes())

    def test_changed_oauth_file_during_preflight_is_preserved_and_refused(self) -> None:
        external = self.original + b"CONSOLE_OAUTH_REDIRECT=https://example.test/api/auth/callback\n"
        geteuid, root_owned, fchown = self.root_context()

        def concurrent_change(*_args) -> None:
            self.oauth.write_bytes(external)
            self.oauth.chmod(0o600)

        with geteuid, root_owned, fchown, patch.object(owner_bootstrap, "run_preflight", side_effect=concurrent_change):
            with self.assertRaisesRegex(RuntimeError, "changed during preflight"):
                owner_bootstrap.run(self.prefix, self.receipt_a)
        self.assertEqual(self.oauth.read_bytes(), external)

    def test_unsafe_lock_mode_refuses_before_preflight_or_replacement(self) -> None:
        lock = self.etc / ".console-oauth.bootstrap.lock"
        lock.write_text("", encoding="ascii")
        lock.chmod(0o644)
        geteuid, root_owned, fchown = self.root_context()
        with geteuid, root_owned, fchown, patch.object(owner_bootstrap, "run_preflight") as preflight:
            with self.assertRaisesRegex(ValueError, "lock file is unsafe"):
                owner_bootstrap.run(self.prefix, self.receipt_a)
        preflight.assert_not_called()
        self.assertEqual(self.oauth.read_bytes(), self.original)

    def test_host_lock_wait_is_bounded_and_retry_works_after_release(self) -> None:
        lock = self.etc / ".console-oauth.bootstrap.lock"
        held_fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(held_fd, fcntl.LOCK_EX)
        geteuid, root_owned, fchown = self.root_context()
        try:
            with geteuid, root_owned, fchown, \
                 patch.object(owner_bootstrap, "HOST_LOCK_TIMEOUT_SECONDS", 0.1), \
                 patch.object(owner_bootstrap, "run_preflight") as preflight:
                with self.assertRaisesRegex(TimeoutError, "another owner bootstrap"):
                    owner_bootstrap.run(self.prefix, self.receipt_a)
                preflight.assert_not_called()
                self.assertEqual(self.oauth.read_bytes(), self.original)
        finally:
            fcntl.flock(held_fd, fcntl.LOCK_UN)
            os.close(held_fd)
        geteuid, root_owned, fchown = self.root_context()
        with geteuid, root_owned, fchown, patch.object(owner_bootstrap, "run_preflight", return_value=None):
            owner_bootstrap.run(self.prefix, self.receipt_a)
        self.assertIn(b"CONSOLE_BOOTSTRAP_IDENTITY=", self.oauth.read_bytes())

    def test_competing_bootstrap_identities_have_one_winner_and_same_tuple_retry_is_safe(self) -> None:
        entered = threading.Event()
        release = threading.Event()
        calls = 0
        calls_lock = threading.Lock()

        def preflight(*_args) -> None:
            nonlocal calls
            with calls_lock:
                calls += 1
                current = calls
            if current == 1:
                entered.set()
                if not release.wait(3):
                    raise TimeoutError("test gate timed out")

        geteuid, root_owned, fchown = self.root_context()
        with geteuid, root_owned, fchown, patch.object(owner_bootstrap, "run_preflight", side_effect=preflight):
            outcomes: list[tuple[str, str]] = []
            def record(label: str, receipt: str) -> None:
                try:
                    owner_bootstrap.run(self.prefix, receipt)
                    outcomes.append((label, "selected"))
                except Exception:
                    outcomes.append(("refused", label))

            first = threading.Thread(target=record, args=("a", self.receipt_a))
            second = threading.Thread(target=record, args=("b", self.receipt_b))
            first.start()
            self.assertTrue(entered.wait(2))
            second.start()
            release.set()
            first.join(3)
            second.join(3)
            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())
            self.assertCountEqual([kind for kind, _message in outcomes], ["a", "refused"])
            saved = self.oauth.read_bytes()
            self.assertIn(b'"subject":"synthetic-account-a"', saved)
            self.assertNotIn(b"synthetic-account-b", saved)
            inode = self.oauth.stat().st_ino
            owner_bootstrap.run(self.prefix, self.receipt_a)
            self.assertEqual(self.oauth.stat().st_ino, inode)

    def test_atomic_writer_preserves_before_replace_and_reports_after_replace(self) -> None:
        target = self.prefix / "atomic.env"
        target.write_bytes(b"original")
        with patch.object(owner_bootstrap.os, "fchown", return_value=None), patch.object(owner_bootstrap.os, "replace", side_effect=OSError("before replace")):
            with self.assertRaises(OSError):
                owner_bootstrap.atomic_replace(target, b"new")
        self.assertEqual(target.read_bytes(), b"original")
        self.assertEqual([path.name for path in target.parent.glob(".atomic.env.*")], [])

        real_fsync = os.fsync
        fsync_calls = 0

        def fail_directory_sync(fd: int) -> None:
            nonlocal fsync_calls
            fsync_calls += 1
            if fsync_calls == 2:
                raise OSError("directory sync failed")
            real_fsync(fd)

        with patch.object(owner_bootstrap.os, "fchown", return_value=None), patch.object(owner_bootstrap.os, "fsync", side_effect=fail_directory_sync):
            with self.assertRaises(owner_bootstrap.ReplacementDurabilityUnconfirmed):
                owner_bootstrap.atomic_replace(target, b"new")
        self.assertEqual(target.read_bytes(), b"new")

    def test_timeout_stops_process_and_targets_only_generated_container_id(self) -> None:
        cid = "a" * 64
        script = self.prefix / "slow-preflight.sh"
        script.write_text('printf "%s" "$CONTAINER_ID" > "$LARES_OWNER_BOOTSTRAP_CIDFILE"\nsleep 30\n', encoding="utf-8")
        cidfile = self.prefix / "container.id"
        cleanup: list[str] = []

        def remove_exact(path: Path) -> bool:
            cleanup.append(path.read_text(encoding="ascii"))
            return cleanup[-1] == cid

        env = dict(os.environ)
        env.update({"LARES_PREFIX": str(self.prefix), "LARES_OWNER_BOOTSTRAP_CIDFILE": str(cidfile), "CONTAINER_ID": cid})
        with patch.dict(os.environ, {"CONTAINER_ID": cid}), \
             patch.object(owner_bootstrap, "PREFLIGHT_TIMEOUT_SECONDS", 0.1), \
             patch.object(owner_bootstrap, "PREFLIGHT_STOP_GRACE_SECONDS", 0.2), \
             patch.object(owner_bootstrap, "remove_preflight_container", side_effect=remove_exact):
            with self.assertRaisesRegex(RuntimeError, "timed out; settings were not changed"):
                owner_bootstrap.run_preflight(script, self.prefix, cidfile)
        self.assertEqual(cleanup, [cid])

        with patch.object(owner_bootstrap, "PREFLIGHT_TIMEOUT_SECONDS", 0.1), \
             patch.object(owner_bootstrap, "PREFLIGHT_STOP_GRACE_SECONDS", 0.2), \
             patch.object(owner_bootstrap, "remove_preflight_container", return_value=False):
            with self.assertRaises(owner_bootstrap.PreflightCleanupUnconfirmed):
                owner_bootstrap.run_preflight(script, self.prefix, cidfile)

    def test_timeout_kills_sigterm_ignoring_descendant_before_confirming_cleanup(self) -> None:
        pidfile = self.prefix / "descendant.pid"
        script = self.prefix / "descendant-preflight.sh"
        script.write_text(
            'python3 -c \'import os,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); '
            'open(os.environ["CHILD_PID_FILE"], "w").write(str(os.getpid())); time.sleep(30)\' &\n'
            'wait\n', encoding="utf-8")
        cidfile = self.prefix / "container.id"
        cidfile.write_text("d" * 64, encoding="ascii")
        process_groups: list[int] = []
        real_popen = owner_bootstrap.subprocess.Popen

        def record_popen(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            process_groups.append(process.pid)
            return process

        with patch.dict(os.environ, {"CHILD_PID_FILE": str(pidfile)}), \
             patch.object(owner_bootstrap.subprocess, "Popen", side_effect=record_popen), \
             patch.object(owner_bootstrap, "PREFLIGHT_TIMEOUT_SECONDS", 0.2), \
             patch.object(owner_bootstrap, "PREFLIGHT_STOP_GRACE_SECONDS", 0.1), \
             patch.object(owner_bootstrap, "remove_preflight_container", return_value=True):
            with self.assertRaisesRegex(RuntimeError, "timed out; settings were not changed"):
                owner_bootstrap.run_preflight(script, self.prefix, cidfile)
        self.assertTrue(pidfile.exists(), "the SIGTERM-ignoring child started")
        self.assertEqual(len(process_groups), 1)
        with self.assertRaises(ProcessLookupError):
            os.killpg(process_groups[0], 0)

    def test_timeout_with_missing_or_empty_container_id_is_unconfirmed(self) -> None:
        script = self.prefix / "no-container-id.sh"
        cidfile = self.prefix / "container.id"
        for body in ("sleep 30\n", 'printf "" > "$LARES_OWNER_BOOTSTRAP_CIDFILE"\nsleep 30\n'):
            with self.subTest(body=body[:10]):
                cidfile.unlink(missing_ok=True)
                script.write_text(body, encoding="utf-8")
                with patch.object(owner_bootstrap, "PREFLIGHT_TIMEOUT_SECONDS", 0.1), \
                     patch.object(owner_bootstrap, "PREFLIGHT_STOP_GRACE_SECONDS", 0.1):
                    with self.assertRaises(owner_bootstrap.PreflightCleanupUnconfirmed):
                        owner_bootstrap.run_preflight(script, self.prefix, cidfile)

    def test_run_timeout_preserves_settings_and_releases_lock_for_retry(self) -> None:
        cid = "c" * 64
        preflight = self.prefix / "owner-bootstrap-preflight.sh"
        preflight.write_text('printf "%s" "$CONTAINER_ID" > "$LARES_OWNER_BOOTSTRAP_CIDFILE"\nsleep 30\n', encoding="utf-8")
        geteuid, root_owned, fchown = self.root_context()
        with patch.dict(os.environ, {"CONTAINER_ID": cid}), \
             geteuid, root_owned, fchown, \
             patch.object(owner_bootstrap, "__file__", str(self.prefix / "owner-bootstrap.py")), \
             patch.object(owner_bootstrap, "PREFLIGHT_TIMEOUT_SECONDS", 0.1), \
             patch.object(owner_bootstrap, "PREFLIGHT_STOP_GRACE_SECONDS", 0.2), \
             patch.object(owner_bootstrap, "remove_preflight_container", return_value=True):
            with self.assertRaisesRegex(RuntimeError, "timed out; settings were not changed"):
                owner_bootstrap.run(self.prefix, self.receipt_a)
            self.assertEqual(self.oauth.read_bytes(), self.original)
            with patch.object(owner_bootstrap, "run_preflight", return_value=None):
                owner_bootstrap.run(self.prefix, self.receipt_a)
        self.assertIn(b"CONSOLE_BOOTSTRAP_IDENTITY=", self.oauth.read_bytes())

    def test_container_cleanup_requires_private_regular_id_file_and_uses_exact_id(self) -> None:
        cidfile = self.prefix / "container.id"
        self.assertFalse(owner_bootstrap.remove_preflight_container(cidfile))
        cidfile.write_text("\n", encoding="ascii")
        self.assertFalse(owner_bootstrap.remove_preflight_container(cidfile))
        cidfile.unlink()
        cid = "b" * 64
        target = self.prefix / "target.txt"
        target.write_text(cid, encoding="ascii")
        cidfile.symlink_to(target)
        self.assertFalse(owner_bootstrap.remove_preflight_container(cidfile))
        cidfile.unlink()
        cidfile.write_text("not-a-container-id\n", encoding="ascii")
        with patch.object(owner_bootstrap, "is_root_owned", return_value=True), patch.object(owner_bootstrap.subprocess, "run") as docker:
            self.assertFalse(owner_bootstrap.remove_preflight_container(cidfile))
        docker.assert_not_called()
        cidfile.write_text(cid + "\n", encoding="ascii")
        with patch.object(owner_bootstrap, "is_root_owned", return_value=True), \
             patch.object(owner_bootstrap.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as docker:
            self.assertTrue(owner_bootstrap.remove_preflight_container(cidfile))
        docker.assert_called_once()
        self.assertEqual(docker.call_args.args[0], ["docker", "rm", "-f", cid])
        self.assertEqual(docker.call_args.kwargs["timeout"], owner_bootstrap.CONTAINER_CLEANUP_TIMEOUT_SECONDS)

    def test_fifo_protected_settings_refuse_without_hanging_and_release_host_lock(self) -> None:
        fifo_child = '''
import importlib.util, sys
from pathlib import Path
from unittest.mock import patch
script = Path(sys.argv[1])
prefix = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("owner_bootstrap", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
receipt = sys.argv[3]
with patch.object(module.os, "geteuid", return_value=0), \\
     patch.object(module, "is_root_owned", return_value=True), \\
     patch.object(module.os, "fchown", return_value=None), \\
     patch.object(module, "run_preflight", return_value=None):
    try:
        module.run(prefix, receipt)
    except ValueError as error:
        assert "unsafe ownership or permissions" in str(error)
    else:
        raise AssertionError("FIFO was accepted as a protected settings file")
    path = prefix / "etc" / "lares" / "installation.env"
    path.unlink()
    path.write_text("LARES_OWNER_ID=stable-owner\\nLARES_DOMAIN=example.test\\n", encoding="utf-8")
    path.chmod(0o640)
    module.run(prefix, receipt)
'''
        self.install.unlink()
        os.mkfifo(self.install, 0o640)
        child = subprocess.run(
            [sys.executable, "-c", fifo_child, str(SCRIPT), str(self.prefix), self.receipt_a],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=3, check=False,
        )
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertIn(b"CONSOLE_BOOTSTRAP_IDENTITY=", self.oauth.read_bytes())

    def test_main_reports_post_replace_failure_as_changed(self) -> None:
        before = io.StringIO()
        with patch.object(owner_bootstrap.argparse.ArgumentParser, "parse_args", return_value=SimpleNamespace(prefix=self.prefix)), \
             patch.object(owner_bootstrap.getpass, "getpass", return_value="synthetic"), \
             patch.object(owner_bootstrap, "run", side_effect=OSError("pre-replace failure")):
            with redirect_stderr(before):
                result = owner_bootstrap.main()
        self.assertEqual(result, 1)
        self.assertIn("no settings were changed", before.getvalue())
        self.assertNotIn("settings were replaced", before.getvalue())

        error = io.StringIO()
        with patch.object(owner_bootstrap.argparse.ArgumentParser, "parse_args", return_value=SimpleNamespace(prefix=self.prefix)), \
             patch.object(owner_bootstrap.getpass, "getpass", return_value="synthetic"), \
             patch.object(owner_bootstrap, "run", side_effect=owner_bootstrap.ReplacementDurabilityUnconfirmed()):
            with redirect_stderr(error):
                result = owner_bootstrap.main()
        self.assertEqual(result, 1)
        self.assertIn("settings were replaced", error.getvalue())
        self.assertNotIn("no settings were changed", error.getvalue())

    def test_main_output_failure_does_not_claim_settings_were_unchanged(self) -> None:
        class BrokenStdout:
            def write(self, _value: str) -> int:
                raise BrokenPipeError("synthetic closed output")

        error = io.StringIO()
        with patch.object(owner_bootstrap.argparse.ArgumentParser, "parse_args", return_value=SimpleNamespace(prefix=self.prefix)), \
             patch.object(owner_bootstrap.getpass, "getpass", return_value="synthetic"), \
             patch.object(owner_bootstrap, "run", return_value="selected"), \
             patch.object(owner_bootstrap.sys, "stdout", BrokenStdout()), \
             patch.object(owner_bootstrap.sys, "stderr", error):
            result = owner_bootstrap.main()
        self.assertEqual(result, 1)
        self.assertIn("settings were selected", error.getvalue())
        self.assertIn("success message could not be delivered", error.getvalue())
        self.assertNotIn("no settings were changed", error.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=0)
