"""Root-only custody primitives for fixed maintenance operations.

It owns a root-only command mutex separately from the read-only admission
directory mounted into participating runtimes.
"""
from __future__ import annotations

import fcntl
import json
import os
import hashlib
import ipaddress
import re
import sys
import secrets
import stat
import uuid
import time
from pathlib import Path

_STATES = ("normal", "entering", "blocked")
_MAX_INTENT_BYTES = 256
_DIRECTORY_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
_LEASE_FD = 197
_LOCK_WAIT_SECONDS = 1.0
_NORMAL_OPERATIONS = {
    "backup": "backup.sh",
    "backup-verify": "backup-verify.sh",
    "restore-drill": "restore-drill.sh",
    "setup-backups": "setup-backups.sh",
    "refresh-recovery": "refresh-recovery.sh",
    "update": "update.sh",
    "rollback": "rollback.sh",
}


def _safe_parent(info: os.stat_result, path: Path, uid: int) -> None:
    mode = stat.S_IMODE(info.st_mode)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, uid):
        raise ValueError("custody ancestry is unsafe")
    if mode & 0o022:
        # The only writable ancestors accepted are the conventional root-owned sticky temp dirs.
        if info.st_uid != 0 or mode != 0o1777 or str(path) not in ("/tmp", "/var/tmp", "/private/tmp"):
            raise ValueError("custody ancestry is writable")


def _open_directory(path: Path, mode: int, uid: int) -> tuple[int, os.stat_result]:
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("custody path must be absolute and normalized")
    parts = path.parts[1:]
    fd = os.open("/", _DIRECTORY_FLAGS)
    current = Path("/")
    try:
        root_info = os.fstat(fd)
        _safe_parent(root_info, current, uid)
        for index, part in enumerate(parts):
            current = current / part
            next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            info = os.fstat(fd)
            if index == len(parts) - 1:
                if stat.S_IMODE(info.st_mode) != mode or info.st_uid != uid:
                    raise ValueError("custody directory ownership or mode is unsafe")
            else:
                _safe_parent(info, current, uid)
        info = os.fstat(fd)
        if not parts:
            if stat.S_IMODE(info.st_mode) != mode or info.st_uid != uid:
                raise ValueError("custody directory ownership or mode is unsafe")
        _assert_path_matches(path, info, uid)
        result, fd = fd, -1
        return result, info
    finally:
        if fd >= 0:
            os.close(fd)


def _assert_path_matches(path: Path, expected: os.stat_result, uid: int) -> None:
    fd, current = _open_directory_unchecked_ancestry(path, uid)
    try:
        if (current.st_dev, current.st_ino, current.st_uid, stat.S_IMODE(current.st_mode)) != (
            expected.st_dev, expected.st_ino, expected.st_uid, stat.S_IMODE(expected.st_mode)):
            raise ValueError("custody directory path changed")
    finally:
        os.close(fd)


def _open_directory_unchecked_ancestry(path: Path, uid: int) -> tuple[int, os.stat_result]:
    """Reopen the entire chain to detect replacement; callers still use the pinned original fd."""
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("custody path must be absolute and normalized")
    fd = os.open("/", _DIRECTORY_FLAGS)
    current = Path("/")
    try:
        _safe_parent(os.fstat(fd), current, uid)
        for part in path.parts[1:]:
            current = current / part
            next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            _safe_parent(os.fstat(fd), current, uid)
        info = os.fstat(fd)
        result, fd = fd, -1
        return result, info
    finally:
        if fd >= 0:
            os.close(fd)


def _file_at(directory_fd: int, name: str, mode: int, uid: int,
             *, maximum_size: int | None = None) -> os.stat_result:
    if "/" in name or name in ("", ".", ".."):
        raise ValueError("custody filename is invalid")
    info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ValueError("custody file is unsafe")
    if info.st_uid != uid or stat.S_IMODE(info.st_mode) != mode or info.st_nlink != 1:
        raise ValueError("custody file ownership or mode is unsafe")
    if maximum_size is not None and info.st_size > maximum_size:
        raise ValueError("custody file is oversized")
    return info


def _record(installation_id: str, epoch: int, state: str) -> bytes:
    if not isinstance(installation_id, str):
        raise ValueError("installation identity is invalid")
    try:
        if str(uuid.UUID(installation_id)) != installation_id:
            raise ValueError("installation identity is invalid")
    except (ValueError, AttributeError) as error:
        raise ValueError("installation identity is invalid") from error
    if not isinstance(epoch, int) or isinstance(epoch, bool) or not 1 <= epoch <= 2_147_483_647:
        raise ValueError("epoch is invalid")
    if state not in _STATES:
        raise ValueError("state is invalid")
    return (json.dumps({"version": 1, "installationId": installation_id,
                        "epoch": epoch, "state": state},
                       sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def _same_file(left: os.stat_result, right: os.stat_result) -> bool:
    return (left.st_dev, left.st_ino, left.st_nlink, left.st_uid, stat.S_IMODE(left.st_mode)) == (
        right.st_dev, right.st_ino, right.st_nlink, right.st_uid, stat.S_IMODE(right.st_mode))


def _sync_dir(path: Path) -> None:
    fd = os.open(path, _DIRECTORY_FLAGS)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _read_fd(admission_fd: int, admission_path: Path,
             directory_info: os.stat_result, uid: int) -> dict[str, object]:
    _file_at(admission_fd, "service-gate.lock", 0o444, uid)
    intent_info = _file_at(admission_fd, "intent.json", 0o444, uid,
                           maximum_size=_MAX_INTENT_BYTES)
    intent_fd = os.open("intent.json", os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0),
                        dir_fd=admission_fd)
    try:
        opened_info = os.fstat(intent_fd)
        if (not stat.S_ISREG(opened_info.st_mode) or not _same_file(intent_info, opened_info)
                or opened_info.st_size > _MAX_INTENT_BYTES):
            raise ValueError("intent changed while opening")
        raw = os.read(intent_fd, _MAX_INTENT_BYTES + 1)
        if len(raw) > _MAX_INTENT_BYTES or len(raw) != opened_info.st_size:
            raise ValueError("intent is oversized or changed")
        if not _same_file(opened_info, os.fstat(intent_fd)):
            raise ValueError("intent changed while reading")
    finally:
        os.close(intent_fd)
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("intent is malformed") from error
    if not isinstance(value, dict) or set(value) != {"version", "installationId", "epoch", "state"}:
        raise ValueError("intent shape is invalid")
    expected = _record(value.get("installationId"), value.get("epoch"), value.get("state"))
    if raw != expected or value.get("version") != 1:
        raise ValueError("intent is not canonical")
    _assert_path_matches(admission_path, directory_info, uid)
    return value


def prepare(custody_dir: str | Path, admission_dir: str | Path, installation_id: str,
            epoch: int, *, expected_uid: int = 0) -> None:
    """Create separate root-only command custody and runtime-readable admission custody."""
    custody = Path(custody_dir)
    admission = Path(admission_dir)
    custody_fd = admission_fd = -1
    try:
        custody_fd, custody_info = _open_directory(custody, 0o700, expected_uid)
        admission_fd, admission_info = _open_directory(admission, 0o755, expected_uid)
        lock_fd = os.open("service-gate.lock", os.O_CREAT | os.O_EXCL | os.O_WRONLY |
                          getattr(os, "O_NOFOLLOW", 0), 0o444, dir_fd=admission_fd)
        try:
            os.fchmod(lock_fd, 0o444)
            os.fsync(lock_fd)
        finally:
            os.close(lock_fd)
        command_fd = os.open("command.lock", os.O_CREAT | os.O_EXCL | os.O_RDWR |
                             getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=custody_fd)
        try:
            os.fchmod(command_fd, 0o600)
            os.fsync(command_fd)
        finally:
            os.close(command_fd)
        _publish_fd(admission_fd, admission, admission_info, installation_id, epoch,
                    "normal", expected_uid)
        os.fsync(custody_fd)
        _assert_path_matches(custody, custody_info, expected_uid)
        _assert_path_matches(admission, admission_info, expected_uid)
    finally:
        if custody_fd >= 0:
            os.close(custody_fd)
        if admission_fd >= 0:
            os.close(admission_fd)


def _publish_fd(admission_fd: int, admission_path: Path, directory_info: os.stat_result,
                installation_id: str, epoch: int, state: str, uid: int) -> None:
    payload = _record(installation_id, epoch, state)
    temporary = ".intent-" + secrets.token_hex(12)
    fd = None
    try:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY |
                     getattr(os, "O_NOFOLLOW", 0), 0o444, dir_fd=admission_fd)
        os.fchmod(fd, 0o444)
        with os.fdopen(fd, "wb", closefd=True) as stream:
            fd = None
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, "intent.json", src_dir_fd=admission_fd, dst_dir_fd=admission_fd)
        os.fsync(admission_fd)
        _file_at(admission_fd, "service-gate.lock", 0o444, uid)
        _assert_path_matches(admission_path, directory_info, uid)
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(temporary, dir_fd=admission_fd)
        except FileNotFoundError:
            pass


def transition(custody_dir: str | Path, admission_dir: str | Path,
               installation_id: str, epoch: int, next_state: str,
               *, expected_uid: int = 0) -> None:
    """Durably advance normal -> entering -> blocked; there is intentionally no thaw."""
    custody, admission = Path(custody_dir), Path(admission_dir)
    custody_fd = admission_fd = command_fd = -1
    try:
        custody_fd, custody_info = _open_directory(custody, 0o700, expected_uid)
        admission_fd, admission_info = _open_directory(admission, 0o755, expected_uid)
        command_fd, _ = _open_fixed_file(custody_fd, "command.lock", 0o600, expected_uid,
                                         writable=True)
        _lock_with_deadline(command_fd, fcntl.LOCK_EX, "maintenance transition")
        current = _read_fd(admission_fd, admission, admission_info, expected_uid)
        if current["installationId"] != installation_id or current["epoch"] != epoch:
            raise ValueError("custody generation changed")
        allowed = {"normal": "entering", "entering": "blocked"}
        if allowed.get(str(current["state"])) != next_state:
            raise ValueError("custody transition is not allowed")
        _publish_fd(admission_fd, admission, admission_info, installation_id, epoch,
                    next_state, expected_uid)
        _assert_path_matches(custody, custody_info, expected_uid)
    finally:
        for fd in (command_fd, custody_fd, admission_fd):
            if fd >= 0:
                os.close(fd)


def read_intent(admission_dir: str | Path, *, expected_uid: int = 0) -> dict[str, object]:
    """Strict validation seam used by local tests and the CI fixture controller."""
    admission = Path(admission_dir)
    admission_fd, directory_info = _open_directory(admission, 0o755, expected_uid)
    try:
        return _read_fd(admission_fd, admission, directory_info, expected_uid)
    finally:
        os.close(admission_fd)


_NORMAL_POLICY_VERSION = 2


def _normal_hba(subnet: str) -> bytes:
    network = ipaddress.ip_network(subnet, strict=True)
    if network.version != 4:
        raise ValueError("installation database subnet must be IPv4")
    roles = ("lares_app", "lares_financial", "lares_workflow_provisioner",
             "lares_workflow", "lares_gateway", "lares_outside_custody")
    lines = [
        "# Lares normal authentication policy v2; generated during explicit fresh preparation.",
        "local all lares_operator scram-sha-256",
        "host all lares_operator 127.0.0.1/32 scram-sha-256",
        "host all lares_operator ::1/128 scram-sha-256",
        f"host all lares_operator {network.with_prefixlen} scram-sha-256",
        # These named roles have checked production loopback routes: workflow setup uses the
        # host-network container, and database-setup verifies the outside-custody login there.
        "host all lares_workflow_provisioner 127.0.0.1/32 scram-sha-256",
        "host all lares_workflow 127.0.0.1/32 scram-sha-256",
        "host all lares_outside_custody 127.0.0.1/32 scram-sha-256",
    ]
    lines.extend(f"host all {role} {network.with_prefixlen} scram-sha-256" for role in roles)
    lines.extend((
        "host replication all 0.0.0.0/0 reject",
        "host replication all ::/0 reject",
        "host all all 0.0.0.0/0 reject",
        "host all all ::/0 reject",
        "local all all reject",
        ""))
    return "\n".join(lines).encode("ascii")


def _open_safe_chain(path: Path, uid: int) -> tuple[int, os.stat_result]:
    """Pin an existing absolute directory and validate every ancestor without following links."""
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("installation prefix must be absolute and normalized")
    fd = os.open("/", _DIRECTORY_FLAGS)
    current = Path("/")
    try:
        _safe_parent(os.fstat(fd), current, uid)
        for part in path.parts[1:]:
            current /= part
            next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            info = os.fstat(fd)
            _safe_parent(info, current, uid)
        info = os.fstat(fd)
        result, fd = fd, -1
        return result, info
    finally:
        if fd >= 0:
            os.close(fd)


def _open_child_dir(parent_fd: int, name: str, mode: int, uid: int, *, create: bool = False) -> int:
    try:
        fd = os.open(name, _DIRECTORY_FLAGS, dir_fd=parent_fd)
    except FileNotFoundError:
        if not create:
            raise
        os.mkdir(name, mode, dir_fd=parent_fd)
        fd = os.open(name, _DIRECTORY_FLAGS, dir_fd=parent_fd)
        os.fchown(fd, uid, os.getegid() if uid == os.geteuid() else 0)
        os.fchmod(fd, mode)
        os.fsync(fd)
        os.fsync(parent_fd)
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != mode:
        os.close(fd)
        raise ValueError("maintenance custody directory ownership or mode is unsafe")
    return fd


def _create_child_dir_exclusive(parent_fd: int, name: str, mode: int, uid: int) -> int:
    """Create a new custody root relative to its pinned parent; never adopt EEXIST."""
    os.mkdir(name, mode, dir_fd=parent_fd)
    fd = os.open(name, _DIRECTORY_FLAGS, dir_fd=parent_fd)
    try:
        os.fchown(fd, uid, os.getegid() if uid == os.geteuid() else 0)
        os.fchmod(fd, mode)
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != mode:
            raise ValueError("new maintenance custody root ownership or mode is unsafe")
        os.fsync(fd)
        os.fsync(parent_fd)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _write_exclusive_at(directory_fd: int, name: str, payload: bytes, mode: int, uid: int) -> None:
    fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
                 mode, dir_fd=directory_fd)
    try:
        os.fchown(fd, uid, os.getegid() if uid == os.geteuid() else 0)
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb", closefd=True) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.fsync(directory_fd)
    except BaseException:
        raise


def _existing_path(prefix_fd: int, parts: tuple[str, ...]) -> bool:
    """Return true for any existing evidence, refusing symlinked or non-directory ancestors."""
    fd = os.dup(prefix_fd)
    try:
        for index, part in enumerate(parts):
            try:
                info = os.stat(part, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                return False
            if stat.S_ISLNK(info.st_mode):
                return True
            if index == len(parts) - 1:
                return True
            if not stat.S_ISDIR(info.st_mode):
                return True
            next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return False
    finally:
        os.close(fd)


def _receipt(identity: str, epoch: int, subnet: str, hba: bytes) -> bytes:
    value = {"version": 1, "installationId": identity, "epoch": epoch,
             "normalPolicyVersion": _NORMAL_POLICY_VERSION,
             "databaseSubnet": str(ipaddress.ip_network(subnet, strict=True)),
             "hbaSha256": hashlib.sha256(hba).hexdigest(), "complete": True}
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def prepare_fresh(prefix: str | Path, subnet: str, *, expected_uid: int | None = None) -> None:
    """Create first-install authentication custody. Existing or partial state is never adopted."""
    requested = Path(prefix)
    if not requested.is_absolute() or ".." in requested.parts:
        raise ValueError("installation prefix must be absolute and normalized")
    uid = 0 if expected_uid is None else expected_uid
    if expected_uid is None and os.geteuid() != 0:
        raise PermissionError("fresh maintenance custody preparation requires root")
    if expected_uid is not None and (uid != os.geteuid() or uid == 0):
        raise PermissionError("the internal test-owner seam is only available to a non-root test process")
    prefix_fd, prefix_info = _open_safe_chain(requested, uid)
    evidence = (
        ("srv", "lares"), ("srv", "taste"), ("srv", "vault"),
        ("etc", "lares", "installation.env"), ("etc", "lares", "database-bootstrap-complete"),
        ("etc", "lares", "operator"), ("etc", "lares", "secrets"),
        ("var", "lib", "lares", "postgres"), ("var", "lib", "lares", "budget-financial"),
        ("var", "lib", "lares", "budget-native"), ("var", "lib", "lares-vault-git"),
        ("var", "lib", "lares-maintenance"),
        ("opt", "lares", "compose.yaml"), ("opt", "lares", "compose.lares-keeper.yaml"),
        ("opt", "lares", "database-bootstrap-complete"),
    )
    try:
        if any(_existing_path(prefix_fd, item) for item in evidence):
            raise ValueError("existing installation or maintenance evidence found; fresh custody cannot adopt it")
        # Parent directories are opened and pinned one component at a time. No realpath or
        # recursive mkdir can redirect writes through an unsafe prefix/var symlink.
        var_fd = _open_child_dir(prefix_fd, "var", 0o755, uid, create=True)
        try:
            lib_fd = _open_child_dir(var_fd, "lib", 0o755, uid, create=True)
        finally:
            os.close(var_fd)
    except BaseException:
        os.close(prefix_fd)
        raise
    hba = _normal_hba(subnet)
    identity, epoch = str(uuid.uuid4()), 1
    root_fd = custody_fd = admission_fd = auth_fd = -1
    try:
        root_fd = _create_child_dir_exclusive(lib_fd, "lares-maintenance", 0o755, uid)
        custody_fd = _open_child_dir(root_fd, "custody", 0o700, uid, create=True)
        admission_fd = _open_child_dir(root_fd, "admission", 0o755, uid, create=True)
        auth_fd = _open_child_dir(root_fd, "postgres-auth", 0o755, uid, create=True)
        # A closed marker is durable before any policy becomes visible. Validation refuses it;
        # it is removed only after receipt and directory durability have been acknowledged.
        _write_exclusive_at(custody_fd, "preparation.pending", b"incomplete\n", 0o600, uid)
        _write_exclusive_at(auth_fd, "pg_hba.conf", hba, 0o644, uid)
        _write_exclusive_at(admission_fd, "service-gate.lock", b"", 0o444, uid)
        _write_exclusive_at(custody_fd, "command.lock", b"", 0o600, uid)
        _write_exclusive_at(admission_fd, "intent.json", _record(identity, epoch, "normal"), 0o444, uid)
        _assert_path_matches(requested, prefix_info, uid)
        _assert_path_matches(requested / "var/lib/lares-maintenance", os.fstat(root_fd), uid)
        _assert_path_matches(requested / "var/lib/lares-maintenance/custody", os.fstat(custody_fd), uid)
        _assert_path_matches(requested / "var/lib/lares-maintenance/admission", os.fstat(admission_fd), uid)
        _assert_path_matches(requested / "var/lib/lares-maintenance/postgres-auth", os.fstat(auth_fd), uid)
        _write_exclusive_at(custody_fd, "preparation.json", _receipt(identity, epoch, subnet, hba), 0o600, uid)
        os.fsync(root_fd)
        os.fsync(lib_fd)
        os.fsync(prefix_fd)
        # The durable receipt plus the root/lib/prefix syncs above are the commit point.
        # Before it, the pending marker keeps normal validation closed. After it, a failed
        # cleanup sync is uncertainty about marker removal, not a failed authority commit.
        os.unlink("preparation.pending", dir_fd=custody_fd)
        try:
            os.fsync(custody_fd)
        except OSError as error:
            try:
                _write_exclusive_at(custody_fd, "preparation.pending", b"uncertain\n", 0o600, uid)
            except OSError as marker_error:
                print(f"maintenance custody committed; pending-marker cleanup durability is uncertain "
                      f"({error}; marker recreation also failed: {marker_error})", file=sys.stderr)
                validate(prefix, subnet)
                return
            raise OSError(f"maintenance custody is committed but pending-marker cleanup is uncertain: {error}") from error
        validate(prefix, subnet)
    finally:
        for fd in (auth_fd, admission_fd, custody_fd, root_fd, lib_fd, prefix_fd):
            if fd >= 0:
                os.close(fd)


def prepare_outside_custody_key(prefix: str | Path, *, expected_uid: int | None = None) -> str:
    """Create one fresh Keeper-only root key. Existing or partial state is never adopted."""
    requested = Path(prefix)
    uid = 0 if expected_uid is None else expected_uid
    if (not requested.is_absolute() or ".." in requested.parts or str(requested) != str(prefix) or
            expected_uid is None and os.geteuid() != 0 or
            expected_uid is not None and (uid != os.geteuid() or uid == 0 or os.environ.get("LARES_MAINTENANCE_TESTING") != "1")):
        raise PermissionError("outside custody key preparation requires a normalized root-owned installation prefix")
    prefix_fd, _ = _open_safe_chain(requested, uid)
    lares_fd = outside_fd = key_fd = -1
    key = bytearray(secrets.token_bytes(32))
    try:
        var_fd = _open_child_dir(prefix_fd, "var", 0o755, uid, create=True)
        try:
            lib_fd = _open_child_dir(var_fd, "lib", 0o755, uid, create=True)
        finally:
            os.close(var_fd)
        try:
            lares_fd = _open_child_dir(lib_fd, "lares", 0o755, uid, create=True)
        finally:
            os.close(lib_fd)
        outside_fd = _create_child_dir_exclusive(lares_fd, "outside-custody", 0o700, uid)
        key_fd = os.open("key", os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
                         0o400, dir_fd=outside_fd)
        os.fchown(key_fd, uid, 0 if uid == 0 else os.getegid())
        os.fchmod(key_fd, 0o400)
        with os.fdopen(key_fd, "wb", closefd=True) as stream:
            key_fd = -1
            stream.write(key)
            stream.flush()
            os.fsync(stream.fileno())
        os.fsync(outside_fd)
        return hashlib.sha256(key).hexdigest()
    finally:
        key[:] = b"\0" * len(key)
        for fd in (key_fd, outside_fd, lares_fd, prefix_fd):
            if fd >= 0:
                os.close(fd)


def _open_fixed_file(directory_fd: int, name: str, mode: int, uid: int,
                    *, writable: bool = False) -> tuple[int, os.stat_result]:
    before = _file_at(directory_fd, name, mode, uid)
    flags = (os.O_RDWR if writable else os.O_RDONLY) | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(name, flags, dir_fd=directory_fd)
    try:
        opened = os.fstat(fd)
        if not _same_file(before, opened) or not stat.S_ISREG(opened.st_mode):
            raise ValueError("maintenance lock changed while opening")
        return fd, opened
    except BaseException:
        os.close(fd)
        raise


def _lock_with_deadline(fd: int, kind: int, description: str) -> None:
    deadline = time.monotonic() + _LOCK_WAIT_SECONDS
    while True:
        try:
            fcntl.flock(fd, kind | fcntl.LOCK_NB)
            return
        except BlockingIOError as error:
            if time.monotonic() >= deadline:
                raise ValueError(f"{description} is busy") from error
            time.sleep(min(0.01, max(0.0, deadline - time.monotonic())))


def _linux_lock_mode_for_fd(fd: int, expected: os.stat_result) -> str | None:
    """Return this descriptor's kernel-reported flock mode for its exact inode."""
    if not Path("/proc/self/fdinfo").is_dir():
        return None
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or not _same_file(opened, expected):
            return None
        with open(f"/proc/self/fdinfo/{fd}", "r", encoding="ascii") as source:
            lines = source.read(4097).splitlines()
    except OSError:
        return None
    if len(lines) > 32 or not any(line == f"ino:\t{expected.st_ino}" for line in lines):
        return None
    major, minor = os.major(expected.st_dev), os.minor(expected.st_dev)
    modes: list[str] = []
    for line in lines:
        fields = line.split()
        if len(fields) < 7 or fields[0] != "lock:" or fields[2:4] != ["FLOCK", "ADVISORY"]:
            continue
        try:
            device = fields[6].split(":")
            if len(device) != 3:
                continue
            record_major, record_minor = int(device[0], 16), int(device[1], 16)
            record_inode = int(device[2], 10)
        except ValueError:
            continue
        if (record_major, record_minor, record_inode) == (major, minor, expected.st_ino):
            modes.append(fields[4])
    return modes[0] if len(modes) == 1 else None


def _other_shared_lock_present(admission_fd: int, info: os.stat_result, uid: int) -> bool:
    """Non-Linux test-owner fallback; never changes fd 197."""
    fd, opened = _open_fixed_file(admission_fd, "service-gate.lock", 0o444, uid)
    try:
        if not _same_file(info, opened):
            return False
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        else:
            fcntl.flock(fd, fcntl.LOCK_UN)
            return False
    finally:
        os.close(fd)


def _open_namespace(prefix: Path, uid: int) -> tuple[list[int], dict[str, int], dict[str, os.stat_result]]:
    """Pin the complete custody ancestry used by admission and its lock files."""
    if not prefix.is_absolute() or ".." in prefix.parts:
        raise ValueError("installation prefix must be absolute and normalized")
    fds: list[int] = []
    try:
        prefix_fd, prefix_info = _open_safe_chain(prefix, uid)
        fds.append(prefix_fd)
        var_fd = _open_child_dir(prefix_fd, "var", 0o755, uid)
        fds.append(var_fd)
        lib_fd = _open_child_dir(var_fd, "lib", 0o755, uid)
        fds.append(lib_fd)
        root_fd = _open_child_dir(lib_fd, "lares-maintenance", 0o755, uid)
        fds.append(root_fd)
        custody_fd = _open_child_dir(root_fd, "custody", 0o700, uid)
        fds.append(custody_fd)
        admission_fd = _open_child_dir(root_fd, "admission", 0o755, uid)
        fds.append(admission_fd)
        auth_fd = _open_child_dir(root_fd, "postgres-auth", 0o755, uid)
        fds.append(auth_fd)
        by_name = {"prefix": prefix_fd, "var": var_fd, "lib": lib_fd, "root": root_fd,
                   "custody": custody_fd, "admission": admission_fd, "auth": auth_fd}
        infos = {name: os.fstat(fd) for name, fd in by_name.items()}
        return fds, by_name, infos
    except BaseException:
        for fd in reversed(fds):
            os.close(fd)
        raise


def _assert_namespace_paths(prefix: Path, by_name: dict[str, int], infos: dict[str, os.stat_result], uid: int) -> None:
    paths = {
        "prefix": prefix,
        "var": prefix / "var",
        "lib": prefix / "var/lib",
        "root": prefix / "var/lib/lares-maintenance",
        "custody": prefix / "var/lib/lares-maintenance/custody",
        "admission": prefix / "var/lib/lares-maintenance/admission",
        "auth": prefix / "var/lib/lares-maintenance/postgres-auth",
    }
    for name, path in paths.items():
        _assert_path_matches(path, infos[name], uid)


def _assert_inherited_lease(prefix: Path, by_name: dict[str, int], uid: int,
                            *, test_owner: bool) -> None:
    try:
        lease_info = os.fstat(_LEASE_FD)
    except OSError as error:
        raise ValueError("inherited maintenance lease is absent") from error
    gate_info = _file_at(by_name["admission"], "service-gate.lock", 0o444, uid)
    if not _same_file(lease_info, gate_info):
        raise ValueError("inherited maintenance lease is for another file")
    shared = _linux_lock_mode_for_fd(_LEASE_FD, gate_info) == "READ"
    if (not shared and test_owner and os.geteuid() != 0 and
            not Path("/proc/self/fdinfo").is_dir()):
        shared = _other_shared_lock_present(by_name["admission"], lease_info, uid)
    if not shared:
        raise ValueError("inherited maintenance lease is not a proven shared lock")
    _assert_namespace_paths(prefix, by_name, {name: os.fstat(fd) for name, fd in by_name.items()}, uid)


def _acquire_normal_lease(prefix: Path, uid: int) -> None:
    fds, by_name, infos = _open_namespace(prefix, uid)
    command_fd = gate_fd = -1
    locked_command = False
    try:
        command_fd, command_info = _open_fixed_file(by_name["custody"], "command.lock", 0o600, uid,
                                                    writable=True)
        _lock_with_deadline(command_fd, fcntl.LOCK_EX, "maintenance admission")
        locked_command = True
        gate_fd, gate_info = _open_fixed_file(by_name["admission"], "service-gate.lock", 0o444, uid)
        try:
            fcntl.flock(gate_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("maintenance service gate is busy") from error
        if not _same_file(gate_info, os.fstat(gate_fd)) or not _same_file(
                gate_info, _file_at(by_name["admission"], "service-gate.lock", 0o444, uid)):
            raise ValueError("maintenance service gate changed while locking")
        receipt = validate(str(prefix))
        if receipt["installationId"] != _read_fd(
                by_name["admission"], prefix / "var/lib/lares-maintenance/admission", infos["admission"], uid
        )["installationId"]:
            raise ValueError("maintenance receipt changed during admission")
        _assert_namespace_paths(prefix, by_name, infos, uid)
        if _LEASE_FD in (command_fd, gate_fd):
            raise ValueError("reserved maintenance descriptor collided")
        os.dup2(gate_fd, _LEASE_FD, inheritable=True)
        if not _same_file(os.fstat(_LEASE_FD), gate_info):
            raise ValueError("maintenance lease descriptor changed")
    finally:
        if locked_command:
            fcntl.flock(command_fd, fcntl.LOCK_UN)
        for fd in (command_fd, gate_fd):
            if fd >= 0:
                os.close(fd)
        for fd in reversed(fds):
            os.close(fd)


def _validate_inherited_normal(prefix: Path, uid: int, *, test_owner: bool) -> None:
    fds, by_name, infos = _open_namespace(prefix, uid)
    command_fd = -1
    locked_command = False
    try:
        command_fd, _ = _open_fixed_file(by_name["custody"], "command.lock", 0o600, uid,
                                         writable=True)
        _lock_with_deadline(command_fd, fcntl.LOCK_EX, "maintenance admission")
        locked_command = True
        validate(str(prefix))
        _assert_inherited_lease(prefix, by_name, uid, test_owner=test_owner)
        _assert_namespace_paths(prefix, by_name, infos, uid)
    finally:
        if locked_command:
            fcntl.flock(command_fd, fcntl.LOCK_UN)
        if command_fd >= 0:
            os.close(command_fd)
        for fd in reversed(fds):
            os.close(fd)


def _normal_uid(test_owner: bool) -> int:
    if test_owner:
        if os.geteuid() == 0 or os.environ.get("LARES_MAINTENANCE_TESTING") != "1":
            raise PermissionError("test-owner admission is available only to an explicit non-root test")
        return os.geteuid()
    if os.geteuid() != 0:
        raise PermissionError("maintenance operation admission requires root")
    return 0


def _run_normal(prefix: str, operation: str, args: list[str], *, test_owner: bool) -> None:
    if operation not in _NORMAL_OPERATIONS:
        raise ValueError("maintenance operation is not supported")
    uid = _normal_uid(test_owner)
    target = Path(prefix)
    if not target.is_absolute() or ".." in target.parts:
        raise ValueError("installation prefix must be absolute and normalized")
    try:
        os.fstat(_LEASE_FD)
    except OSError:
        _acquire_normal_lease(target, uid)
    else:
        _validate_inherited_normal(target, uid, test_owner=test_owner)
    script = Path(__file__).resolve().with_name(_NORMAL_OPERATIONS[operation])
    script_info = os.lstat(script)
    if not stat.S_ISREG(script_info.st_mode) or script_info.st_uid != uid or stat.S_IMODE(script_info.st_mode) & 0o022:
        raise ValueError("maintenance operation script is unsafe")
    env = os.environ.copy()
    env["LARES_MAINTENANCE_ADMITTED"] = "1"
    os.execve("/bin/bash", ["bash", str(script), *args], env)


def _assert_normal_held(prefix: str, operation: str, *, test_owner: bool) -> None:
    if operation not in _NORMAL_OPERATIONS:
        raise ValueError("maintenance operation is not supported")
    uid = _normal_uid(test_owner)
    target = Path(prefix)
    if not target.is_absolute() or ".." in target.parts:
        raise ValueError("installation prefix must be absolute and normalized")
    _validate_inherited_normal(target, uid, test_owner=test_owner)


def validate(prefix: str | Path, subnet: str | None = None) -> dict[str, object]:
    requested = Path(prefix)
    if not requested.is_absolute() or ".." in requested.parts:
        raise ValueError("installation prefix must be absolute and normalized")
    uid = os.geteuid()
    prefix_fd, _ = _open_safe_chain(requested, uid)
    var_fd = lib_fd = root_fd = custody_fd = admission_fd = auth_fd = -1
    try:
        var_fd = _open_child_dir(prefix_fd, "var", 0o755, uid)
        lib_fd = _open_child_dir(var_fd, "lib", 0o755, uid)
        root_fd = _open_child_dir(lib_fd, "lares-maintenance", 0o755, uid)
        custody_fd = _open_child_dir(root_fd, "custody", 0o700, uid)
        admission_fd = _open_child_dir(root_fd, "admission", 0o755, uid)
        auth_fd = _open_child_dir(root_fd, "postgres-auth", 0o755, uid)
        try:
            _file_at(custody_fd, "preparation.pending", 0o600, uid, maximum_size=128)
        except FileNotFoundError:
            pass
        else:
            raise ValueError("maintenance preparation is incomplete or uncertain")

        def read(name: str, directory_fd: int, mode: int, maximum_size: int = 4096) -> bytes:
            info = _file_at(directory_fd, name, mode, uid, maximum_size=maximum_size)
            fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0), dir_fd=directory_fd)
            try:
                opened = os.fstat(fd)
                if not _same_file(info, opened):
                    raise ValueError("maintenance custody file changed while opening")
                data = os.read(fd, maximum_size + 1)
                if len(data) != opened.st_size or len(data) > maximum_size or not _same_file(opened, os.fstat(fd)):
                    raise ValueError("maintenance custody file changed while reading")
            finally:
                os.close(fd)
            return data

        expected_subnet = str(ipaddress.ip_network(subnet, strict=True)) if subnet else None
        hba = read("pg_hba.conf", auth_fd, 0o644)
        receipt_raw = read("preparation.json", custody_fd, 0o600)
        try:
            receipt = json.loads(receipt_raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("maintenance preparation receipt is malformed") from error
        if not isinstance(receipt, dict) or receipt_raw != (json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii"):
            raise ValueError("maintenance preparation receipt is not canonical")
        required = {"version", "installationId", "epoch", "normalPolicyVersion", "databaseSubnet", "hbaSha256", "complete"}
        if (set(receipt) != required or type(receipt["version"]) is not int or receipt["version"] != 1 or
                type(receipt["epoch"]) is not int or receipt["epoch"] != 1 or
                type(receipt["normalPolicyVersion"]) is not int or receipt["normalPolicyVersion"] != _NORMAL_POLICY_VERSION or
                type(receipt["complete"]) is not bool or receipt["complete"] is not True or
                not isinstance(receipt["databaseSubnet"], str) or not isinstance(receipt["hbaSha256"], str) or
                not re.fullmatch(r"[0-9a-f]{64}", receipt["hbaSha256"])):
            raise ValueError("maintenance preparation receipt is incomplete or unsupported")
        try:
            if not isinstance(receipt["installationId"], str) or str(uuid.UUID(receipt["installationId"])) != receipt["installationId"]:
                raise ValueError
            normalized_subnet = str(ipaddress.ip_network(receipt["databaseSubnet"], strict=True))
        except (ValueError, TypeError, AttributeError) as error:
            raise ValueError("maintenance preparation identity or subnet is invalid") from error
        approved_hba = _normal_hba(receipt["databaseSubnet"])
        if (receipt["hbaSha256"] != hashlib.sha256(hba).hexdigest() or hba != approved_hba or
                receipt["databaseSubnet"] != normalized_subnet):
            raise ValueError("maintenance preparation receipt does not match the normal policy")
        if expected_subnet is not None and receipt["databaseSubnet"] != expected_subnet:
            raise ValueError("maintenance preparation subnet changed")
        _file_at(custody_fd, "command.lock", 0o600, uid)
        admission_path = requested / "var/lib/lares-maintenance/admission"
        intent = _read_fd(admission_fd, admission_path, os.fstat(admission_fd), uid)
        if intent["installationId"] != receipt["installationId"] or intent["epoch"] != receipt["epoch"] or intent["state"] != "normal":
            raise ValueError("maintenance admission state is not normal for this preparation receipt")
        for path, fd in ((requested, prefix_fd), (requested / "var/lib/lares-maintenance", root_fd),
                         (requested / "var/lib/lares-maintenance/custody", custody_fd),
                         (admission_path, admission_fd),
                         (requested / "var/lib/lares-maintenance/postgres-auth", auth_fd)):
            _assert_path_matches(path, os.fstat(fd), uid)
        return receipt
    finally:
        for fd in (auth_fd, admission_fd, custody_fd, root_fd, lib_fd, var_fd, prefix_fd):
            if fd >= 0:
                os.close(fd)


def validate_update_target(prefix: str, compose_dir: str, compose_files: str,
                           database_secret: str, operator_secret: str,
                           pg_host: str, pg_port: str, pg_database: str,
                           *, test_owner: bool = False) -> None:
    """Bind update/rollback inputs to one canonical installation and its fixed local DB."""
    root = Path(prefix)
    if (not root.is_absolute() or ".." in root.parts or prefix != str(root)
            or not root.is_dir() or root.is_symlink() or root.resolve(strict=True) != root):
        raise ValueError("installation prefix is not a canonical directory")
    expected_compose = root / "opt/lares"
    requested_compose = Path(compose_dir)
    if (compose_dir != str(expected_compose) or requested_compose != expected_compose or not requested_compose.is_dir()
            or requested_compose.is_symlink() or requested_compose.resolve(strict=True) != expected_compose):
        raise ValueError("Compose directory does not match this installation prefix")
    names = compose_files.split()
    if not names:
        raise ValueError("Compose file list is empty")
    for name in names:
        requested = Path(name)
        if ".." in requested.parts or name != os.path.normpath(name):
            raise ValueError("Compose file path is not canonical")
        candidate = requested if requested.is_absolute() else expected_compose / requested
        try:
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(expected_compose)
            info = candidate.lstat()
        except (OSError, ValueError) as error:
            raise ValueError("Compose file is missing or outside this installation") from error
        if (candidate != resolved or not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
            raise ValueError("Compose file is not a canonical regular file")

    expected_database_secret = root / "etc/lares/secrets/database-password"
    expected_operator_secret = root / "etc/lares/operator/database-password"
    credentials = (
        (database_secret, expected_database_secret, 0o440, 10001),
        (operator_secret, expected_operator_secret, 0o600, 0),
    )
    expected_uid = os.geteuid() if test_owner else 0
    for supplied, expected, expected_mode, expected_gid in credentials:
        path = Path(supplied)
        try:
            info = path.lstat()
        except OSError as error:
            raise ValueError("installation database credential is missing or unsafe") from error
        if (supplied != str(expected) or path != expected or path.resolve(strict=True) != expected or stat.S_ISLNK(info.st_mode)
                or not stat.S_ISREG(info.st_mode) or info.st_uid != expected_uid
                or info.st_gid != (os.getegid() if test_owner else expected_gid)
                or stat.S_IMODE(info.st_mode) != expected_mode or info.st_nlink != 1 or info.st_size < 1):
            raise ValueError("installation database credential is missing or unsafe")
    if (pg_host, pg_port, pg_database) != ("127.0.0.1", "5432", "lares_state"):
        raise ValueError("update and rollback require the installed local Lares database")


def main(argv: list[str]) -> int:
    try:
        if len(argv) == 5 and argv[1] == "prepare-fresh" and argv[4] == "--confirm-fresh":
            if os.geteuid() != 0 and os.environ.get("LARES_MAINTENANCE_TESTING") == "1":
                prepare_fresh(argv[2], argv[3], expected_uid=os.geteuid())
            else:
                prepare_fresh(argv[2], argv[3])
        elif len(argv) == 4 and argv[1] == "prepare-outside-custody-key" and argv[3] == "--confirm-fresh":
            print(json.dumps({"keyFingerprint": prepare_outside_custody_key(argv[2])}, separators=(",", ":")))
        elif (len(argv) == 6 and argv[1] == "prepare-fresh" and argv[4] == "--confirm-fresh" and
              argv[5] == "--test-owner" and os.geteuid() != 0 and os.environ.get("LARES_MAINTENANCE_TESTING") == "1"):
            prepare_fresh(argv[2], argv[3], expected_uid=os.geteuid())
        elif len(argv) == 4 and argv[1] == "validate":
            if os.geteuid() != 0 and os.environ.get("LARES_MAINTENANCE_TESTING") != "1":
                raise PermissionError("maintenance custody validation requires root")
            validate(argv[2], argv[3])
        elif len(argv) == 4 and argv[1] == "validate-identity":
            if os.geteuid() != 0 and os.environ.get("LARES_MAINTENANCE_TESTING") != "1":
                raise PermissionError("maintenance custody validation requires root")
            receipt = validate(argv[2], argv[3])
            # Emit only the independently validated identity needed by generated Compose.
            # Never expose the rest of the custody receipt through this narrow interface.
            print(json.dumps({"installationId": receipt["installationId"], "epoch": receipt["epoch"]},
                             separators=(",", ":")))
        elif (len(argv) == 5 and argv[1] == "validate" and argv[4] == "--test-owner" and
              os.geteuid() != 0 and os.environ.get("LARES_MAINTENANCE_TESTING") == "1"):
            validate(argv[2], argv[3])
        elif (len(argv) == 5 and argv[1] == "validate-identity" and argv[4] == "--test-owner" and
              os.geteuid() != 0 and os.environ.get("LARES_MAINTENANCE_TESTING") == "1"):
            receipt = validate(argv[2], argv[3])
            print(json.dumps({"installationId": receipt["installationId"], "epoch": receipt["epoch"]},
                             separators=(",", ":")))
        elif len(argv) == 10 and argv[1] == "validate-update-target" and os.geteuid() == 0:
            validate_update_target(*argv[2:10], test_owner=False)
        elif (len(argv) == 11 and argv[1] == "validate-update-target" and
              argv[10] == "--test-owner" and os.geteuid() != 0 and
              os.environ.get("LARES_MAINTENANCE_TESTING") == "1"):
            validate_update_target(*argv[2:10], test_owner=True)
        elif len(argv) >= 5 and argv[1] == "run-normal":
            test_owner = len(argv) > 4 and argv[4] == "--test-owner"
            separator = 5 if test_owner else 4
            if separator >= len(argv) or argv[separator] != "--":
                raise ValueError("usage: run-normal <prefix> <operation-id> [--test-owner] -- [arguments]")
            _run_normal(argv[2], argv[3], argv[separator + 1:], test_owner=test_owner)
        elif len(argv) in (4, 5) and argv[1] == "assert-normal-held":
            test_owner = len(argv) == 5 and argv[4] == "--test-owner"
            if len(argv) == 5 and not test_owner:
                raise ValueError("usage: assert-normal-held <prefix> <operation-id> [--test-owner]")
            _assert_normal_held(argv[2], argv[3], test_owner=test_owner)
        else:
            raise ValueError("unsupported maintenance custody command")
        return 0
    except (OSError, ValueError) as error:
        if len(argv) > 1 and argv[1] in ("run-normal", "assert-normal-held", "validate-update-target"):
            print("maintenance admission: refused", file=sys.stderr)
            return 78
        print(f"maintenance custody: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
