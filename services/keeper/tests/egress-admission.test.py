"""Offline contract tests for the fixed egress startup guard."""
import fcntl
import io
import importlib.util
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from contextlib import redirect_stderr
from unittest.mock import patch

BAKED_GUARD = Path("/usr/local/lib/lares/maintenance-admission.py")
GUARD = (BAKED_GUARD if BAKED_GUARD.is_file() else
         Path(__file__).parents[3] / "images" / "egress-proxy" / "maintenance-admission.py")
SPEC = importlib.util.spec_from_file_location("egress_admission", GUARD)
guard = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(guard)
IDENTITY = "11111111-1111-4111-8111-111111111111"
OTHER_IDENTITY = "22222222-2222-4222-8222-222222222222"
TEMP_PARENT = "/private/tmp" if os.path.isdir("/private/tmp") else "/tmp"


def _record(identity=IDENTITY, epoch=1, state="normal"):
    return (json.dumps({"version": 1, "installationId": identity, "epoch": epoch, "state": state},
                       sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def _write(path, payload, mode=0o444):
    if path.exists() or path.is_symlink():
        path.unlink()
    path.write_bytes(payload)
    os.chmod(path, mode)


class EgressAdmissionTests(unittest.TestCase):
    def _assert_real_guard_refuses(self, admission, *, identity=IDENTITY, epoch="1"):
        error = io.StringIO()

        class ExecWasReached(BaseException):
            pass

        with patch.object(guard, "ADMISSION_DIR", str(admission)), \
                patch.dict(os.environ, {
                    "LARES_MAINTENANCE_INSTALLATION_ID": identity,
                    "LARES_MAINTENANCE_EPOCH": epoch,
                }), patch.object(guard.os, "execv", side_effect=ExecWasReached) as execv:
            with redirect_stderr(error):
                with self.assertRaises(SystemExit) as refused:
                    guard.main(list(guard.SQUID_ARGS))
            self.assertEqual(refused.exception.code, 78)
            self.assertEqual(error.getvalue(), guard.REFUSAL + "\n")
            execv.assert_not_called()

    def _fixture(self, root):
        root.chmod(0o700)
        admission = root / "admission"
        admission.mkdir(mode=0o755)
        _write(admission / "service-gate.lock", b"")
        _write(admission / "intent.json", _record())
        return admission

    def _with_fd9_closed(self):
        try:
            saved = os.dup(guard.LOCK_FD)
        except OSError:
            saved = -1
        else:
            os.close(guard.LOCK_FD)
        return saved

    def _restore_fd9(self, saved):
        try:
            os.close(guard.LOCK_FD)
        except OSError:
            pass
        if saved >= 0:
            os.dup2(saved, guard.LOCK_FD, inheritable=True)
            os.close(saved)

    def _run_guard_with_descriptor(self, lock_mode):
        saved = self._with_fd9_closed()
        with tempfile.NamedTemporaryFile() as file:
            file.write(b"decoy")
            file.flush()
            descriptor = os.open(file.name, os.O_RDWR)
            try:
                if lock_mode == "SH":
                    fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
                elif lock_mode == "EX":
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                os.dup2(descriptor, guard.LOCK_FD, inheritable=True)
                before = os.fstat(guard.LOCK_FD)
                with patch.object(guard.os, "geteuid", return_value=0), \
                        patch.dict(os.environ, {
                            "LARES_MAINTENANCE_INSTALLATION_ID": "11111111-1111-4111-8111-111111111111",
                            "LARES_MAINTENANCE_EPOCH": "1",
                        }), patch.object(guard, "_open_directory", side_effect=AssertionError("opened admission")):
                    with self.assertRaises(guard.Refused):
                        guard._guard(list(guard.SQUID_ARGS))
                after = os.fstat(guard.LOCK_FD)
                self.assertEqual((after.st_dev, after.st_ino), (before.st_dev, before.st_ino))

                contender = os.open(file.name, os.O_RDWR)
                try:
                    requested = fcntl.LOCK_EX if lock_mode == "SH" else fcntl.LOCK_SH
                    if lock_mode == "unlocked":
                        fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        fcntl.flock(contender, fcntl.LOCK_UN)
                    else:
                        with self.assertRaises(BlockingIOError):
                            fcntl.flock(contender, requested | fcntl.LOCK_NB)
                finally:
                    os.close(contender)
            finally:
                os.close(descriptor)
                self._restore_fd9(saved)

    def test_any_preexisting_reserved_fd9_refuses_without_replacing_or_converting_it(self):
        for mode in ("unlocked", "SH", "EX"):
            with self.subTest(mode=mode):
                self._run_guard_with_descriptor(mode)

    def test_missing_fd9_continues_to_protected_directory_validation(self):
        saved = self._with_fd9_closed()
        try:
            with patch.object(guard.os, "geteuid", return_value=0), \
                    patch.dict(os.environ, {
                        "LARES_MAINTENANCE_INSTALLATION_ID": "11111111-1111-4111-8111-111111111111",
                        "LARES_MAINTENANCE_EPOCH": "1",
                    }), patch.object(guard, "_open_directory", side_effect=guard.Refused) as open_directory:
                with self.assertRaises(guard.Refused):
                    guard._guard(list(guard.SQUID_ARGS))
                open_directory.assert_called_once_with(guard.ADMISSION_DIR)
        finally:
            self._restore_fd9(saved)

    def test_identity_and_exact_squid_command_are_bounded(self):
        for identity, epoch in (("not-a-uuid", "1"),
                                ("11111111-1111-4111-8111-111111111111", "01"),
                                ("11111111-1111-4111-8111-111111111111", "2147483648")):
            with self.subTest(identity=identity, epoch=epoch), self.assertRaises(guard.Refused):
                guard._identity(identity, epoch)
        with self.assertRaises(guard.Refused):
            guard._guard(["sh", "-c", "arbitrary command"])

    @unittest.skipUnless(os.geteuid() == 0, "root-owned filesystem refusal matrix runs in the Linux image")
    def test_real_guard_refusal_matrix_returns_78_before_exec(self):
        def wrong_intent(identity=IDENTITY, epoch=1, state="normal"):
            return lambda root, admission: _write(admission / "intent.json", _record(identity, epoch, state))

        def missing(name):
            return lambda root, admission: (admission / name).unlink()

        def oversized(root, admission):
            _write(admission / "intent.json", b"x" * (guard.INTENT_LIMIT + 1))

        def noncanonical(root, admission):
            _write(admission / "intent.json", _record().replace(b'"version":1', b'"version": 1'))

        def symlink_intent(root, admission):
            target = root / "outside-intent"
            _write(target, _record())
            (admission / "intent.json").unlink()
            os.symlink(target, admission / "intent.json")

        def foreign_owner(path):
            return lambda root, admission: os.chown(admission / path, 65534, 65534)

        def unsafe_mode(path):
            return lambda root, admission: os.chmod(admission / path, 0o640)

        def hardlink(path):
            return lambda root, admission: os.link(admission / path, root / (path + ".link"))

        def fifo(path):
            return lambda root, admission: ((admission / path).unlink(), os.mkfifo(admission / path, 0o444))

        def unsafe_ancestry(root, admission):
            root.chmod(0o777)

        cases = [
            ("blocked intent", wrong_intent(state="blocked"), IDENTITY, "1"),
            ("entering intent", wrong_intent(state="entering"), IDENTITY, "1"),
            ("intent UUID mismatch", wrong_intent(identity=OTHER_IDENTITY), IDENTITY, "1"),
            ("intent epoch mismatch", wrong_intent(epoch=2), IDENTITY, "1"),
            ("expected UUID mismatch", wrong_intent(), OTHER_IDENTITY, "1"),
            ("expected epoch mismatch", wrong_intent(), IDENTITY, "2"),
            ("missing intent", missing("intent.json"), IDENTITY, "1"),
            ("missing gate", missing("service-gate.lock"), IDENTITY, "1"),
            ("oversized intent", oversized, IDENTITY, "1"),
            ("noncanonical intent", noncanonical, IDENTITY, "1"),
            ("symlink intent", symlink_intent, IDENTITY, "1"),
            ("foreign-owned intent", foreign_owner("intent.json"), IDENTITY, "1"),
            ("unsafe intent mode", unsafe_mode("intent.json"), IDENTITY, "1"),
            ("hardlinked intent", hardlink("intent.json"), IDENTITY, "1"),
            ("foreign-owned gate", foreign_owner("service-gate.lock"), IDENTITY, "1"),
            ("unsafe gate mode", unsafe_mode("service-gate.lock"), IDENTITY, "1"),
            ("hardlinked gate", hardlink("service-gate.lock"), IDENTITY, "1"),
            ("FIFO intent", fifo("intent.json"), IDENTITY, "1"),
            ("FIFO gate", fifo("service-gate.lock"), IDENTITY, "1"),
            ("unsafe admission ancestry", unsafe_ancestry, IDENTITY, "1"),
        ]
        for label, mutate, identity, epoch in cases:
            with self.subTest(case=label), tempfile.TemporaryDirectory(prefix="lares-egress-negative-",
                                                                       dir="/tmp") as temporary:
                root = Path(temporary)
                admission = self._fixture(root)
                mutate(root, admission)
                try:
                    self._assert_real_guard_refuses(admission, identity=identity, epoch=epoch)
                finally:
                    root.chmod(0o700)

    @unittest.skipUnless(os.geteuid() == 0, "root-owned descriptor replacement cases run in the Linux image")
    def test_replaced_gate_or_intent_descriptor_returns_fixed_refusal(self):
        for filename in ("intent.json", "service-gate.lock"):
            with self.subTest(file=filename), tempfile.TemporaryDirectory(prefix="lares-egress-replaced-",
                                                                           dir="/tmp") as temporary:
                root = Path(temporary)
                admission = self._fixture(root)
                original_open = os.open
                replacement = root / "replacement"
                _write(replacement, _record() if filename == "intent.json" else b"")
                replaced = False

                def replace_before_open(path, *args, **kwargs):
                    nonlocal replaced
                    if path == filename and not replaced:
                        os.replace(admission / filename, root / "displaced")
                        os.replace(replacement, admission / filename)
                        replaced = True
                    return original_open(path, *args, **kwargs)

                with patch.object(guard.os, "open", side_effect=replace_before_open):
                    self._assert_real_guard_refuses(admission)
                self.assertTrue(replaced, "the race fixture did not replace the opened descriptor")

    @unittest.skipUnless(os.geteuid() == 0, "root-owned exclusive lease case runs in the Linux image")
    def test_held_exclusive_gate_returns_fixed_refusal_without_exec(self):
        with tempfile.TemporaryDirectory(prefix="lares-egress-exclusive-", dir="/tmp") as temporary:
            root = Path(temporary)
            admission = self._fixture(root)
            held = os.open(admission / "service-gate.lock", os.O_RDONLY)
            try:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self._assert_real_guard_refuses(admission)
            finally:
                os.close(held)

    def test_gate_lease_survives_fd9_promotion_when_low_descriptors_are_occupied(self):
        with tempfile.TemporaryDirectory(prefix="lares-egress-fd-collision-", dir=TEMP_PARENT) as temporary:
            temporary_root = Path(temporary)
            root = temporary_root / "parent" if len(temporary_root.parts) % 2 == 0 else temporary_root
            root.mkdir(mode=0o700, exist_ok=True)
            admission = self._fixture(root)
            original = {}
            for descriptor in (*range(3, 8), guard.LOCK_FD):
                try:
                    original[descriptor] = (
                        fcntl.fcntl(descriptor, fcntl.F_DUPFD_CLOEXEC, 20),
                        os.get_inheritable(descriptor),
                    )
                except OSError:
                    original[descriptor] = (-1, False)

            filler = source = -1
            try:
                for descriptor in (*range(3, 8), guard.LOCK_FD):
                    try:
                        os.close(descriptor)
                    except OSError:
                        pass
                filler = os.open("/dev/null", os.O_RDONLY)
                source = fcntl.fcntl(filler, fcntl.F_DUPFD_CLOEXEC, 20)
                os.close(filler)
                filler = -1
                for descriptor in range(3, 8):
                    os.dup2(source, descriptor, inheritable=True)

                class ExecWasReached(BaseException):
                    pass

                gate = admission / "service-gate.lock"

                def open_directory_walk(path):
                    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
                    descriptor = os.open("/", flags)
                    try:
                        for part in Path(path).parts[1:]:
                            next_descriptor = os.open(part, flags, dir_fd=descriptor)
                            os.close(descriptor)
                            descriptor = next_descriptor
                        self.assertEqual(descriptor, guard.LOCK_FD,
                                         "fixture did not place the admission directory on reserved fd9")
                        return descriptor
                    except BaseException:
                        os.close(descriptor)
                        raise

                def inspect_exec(path, argv):
                    self.assertEqual(path, guard.SQUID)
                    self.assertEqual(tuple(argv), (guard.SQUID, *guard.SQUID_ARGS[1:]))
                    opened = os.fstat(guard.LOCK_FD)
                    named = os.stat(gate, follow_symlinks=False)
                    self.assertEqual((opened.st_dev, opened.st_ino), (named.st_dev, named.st_ino))
                    contender = os.open(gate, os.O_RDONLY)
                    try:
                        with self.assertRaises(BlockingIOError):
                            fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    finally:
                        os.close(contender)
                    raise ExecWasReached()

                with patch.object(guard, "ADMISSION_DIR", str(admission)), \
                        patch.object(guard.os, "geteuid", return_value=0), \
                        patch.object(guard, "_open_directory", side_effect=open_directory_walk), \
                        patch.object(guard, "_recheck_directory"), \
                        patch.object(guard, "_named_file", side_effect=lambda directory_fd, name, **_kwargs:
                                     os.stat(name, dir_fd=directory_fd, follow_symlinks=False)), \
                        patch.dict(os.environ, {
                            "LARES_MAINTENANCE_INSTALLATION_ID": IDENTITY,
                            "LARES_MAINTENANCE_EPOCH": "1",
                        }), patch.object(guard.os, "execv", side_effect=inspect_exec):
                    with self.assertRaises(ExecWasReached):
                        guard.main(list(guard.SQUID_ARGS))
            finally:
                for descriptor in (*range(3, 8), guard.LOCK_FD):
                    try:
                        os.close(descriptor)
                    except OSError:
                        pass
                for descriptor in range(3, 8):
                    backup, inheritable = original[descriptor]
                    if backup >= 0:
                        os.dup2(backup, descriptor, inheritable=inheritable)
                backup, inheritable = original[guard.LOCK_FD]
                if backup >= 0:
                    os.dup2(backup, guard.LOCK_FD, inheritable=inheritable)
                for backup, _inheritable in original.values():
                    if backup >= 0:
                        os.close(backup)
                if filler >= 0:
                    os.close(filler)
                if source >= 0:
                    os.close(source)


if __name__ == "__main__":
    unittest.main()
