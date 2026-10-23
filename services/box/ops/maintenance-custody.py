"""Root-only custody primitives for the CI maintenance-admission proof.

This module is deliberately not wired into installation or startup.  It owns a
root-only command mutex separately from the read-only directory mounted into
participating runtimes.
"""
from __future__ import annotations

import fcntl
import json
import os
import secrets
import stat
import uuid
from pathlib import Path

_STATES = ("normal", "entering", "blocked")
_MAX_INTENT_BYTES = 256
_DIRECTORY_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)


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
    intent_fd = os.open("intent.json", os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
                        dir_fd=admission_fd)
    try:
        opened_info = os.fstat(intent_fd)
        if not _same_file(intent_info, opened_info) or opened_info.st_size > _MAX_INTENT_BYTES:
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
        command_info = _file_at(custody_fd, "command.lock", 0o600, expected_uid)
        command_fd = os.open("command.lock", os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
                             dir_fd=custody_fd)
        if not _same_file(command_info, os.fstat(command_fd)):
            raise ValueError("command lock changed while opening")
        fcntl.flock(command_fd, fcntl.LOCK_EX)
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
