#!/usr/bin/env python3
"""Receipt-bound process admission for the pinned LiteLLM runtime image."""

import os
import re
import stat
import sys

try:
    import fcntl
except ImportError:
    fcntl = None

ADMISSION_DIR = "/run/lares-maintenance/admission"
START_SCRIPT = "/usr/local/bin/lares-gateway-start"
INTENT_NAME = "intent.json"
LOCK_NAME = "service-gate.lock"
MAX_INTENT = 256
REFUSAL = "lares: gateway maintenance admission refused"
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")


class Refused(Exception):
    pass


def _fail():
    raise Refused()


def _identity(installation_id, epoch):
    if not isinstance(installation_id, str) or UUID.fullmatch(installation_id) is None:
        _fail()
    if not isinstance(epoch, str) or not re.fullmatch(r"[1-9][0-9]{0,9}", epoch):
        _fail()
    number = int(epoch)
    if number > 2147483647 or str(number) != epoch:
        _fail()
    return installation_id, epoch


def _mode(info):
    return stat.S_IMODE(info.st_mode)


def _check_ancestry(path):
    if path != ADMISSION_DIR or not os.path.isabs(path) or os.path.normpath(path) != path:
        _fail()
    parts = [part for part in path.split("/") if part]
    root = os.lstat("/")
    if not stat.S_ISDIR(root.st_mode) or root.st_uid != 0 or _mode(root) & 0o022:
        _fail()
    current = ""
    for index, part in enumerate(parts):
        current += "/" + part
        info = os.lstat(current)
        mode = _mode(info)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
            _fail()
        if index == len(parts) - 1:
            if mode != 0o755:
                _fail()
        elif mode & 0o022 and not (mode == 0o1777 and current in ("/tmp", "/var/tmp", "/private/tmp")):
            _fail()


def _named_file(dir_fd, name, descriptor=None):
    info = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or _mode(info) != 0o444 or info.st_nlink != 1:
        _fail()
    if descriptor is not None:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            _fail()
    return info


def _open_checked(dir_fd, name):
    descriptor = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    try:
        _named_file(dir_fd, name, descriptor)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _intent(dir_fd, installation_id, epoch):
    fd = _open_checked(dir_fd, INTENT_NAME)
    try:
        before = os.fstat(fd)
        raw = os.read(fd, MAX_INTENT + 1)
        after = os.fstat(fd)
        named = _named_file(dir_fd, INTENT_NAME, fd)
        if len(raw) > MAX_INTENT or (before.st_dev, before.st_ino, before.st_size) != (after.st_dev, after.st_ino, after.st_size):
            _fail()
        expected = ('{"epoch":' + epoch + ',"installationId":"' + installation_id + '","state":"normal","version":1}\n').encode("ascii")
        if raw != expected or named.st_size != len(expected):
            _fail()
    finally:
        os.close(fd)


def _open_directory(path):
    if path != ADMISSION_DIR or not os.path.isabs(path) or os.path.normpath(path) != path:
        _fail()
    parts = [part for part in path.split("/") if part]
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open("/", flags)
    try:
        root = os.fstat(fd)
        if not stat.S_ISDIR(root.st_mode) or root.st_uid != 0 or _mode(root) & 0o022:
            _fail()
        current = ""
        for index, part in enumerate(parts):
            current += "/" + part
            next_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            opened = os.fstat(fd)
            mode = _mode(opened)
            if not stat.S_ISDIR(opened.st_mode) or opened.st_uid != 0:
                _fail()
            if index == len(parts) - 1:
                if mode != 0o755:
                    _fail()
            elif mode & 0o022 and not (mode == 0o1777 and current in ("/tmp", "/var/tmp", "/private/tmp")):
                _fail()
        named = os.stat(path, follow_symlinks=False)
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino, opened.st_uid, _mode(opened)) != (
            named.st_dev, named.st_ino, named.st_uid, _mode(named)):
            _fail()
        return fd
    except BaseException:
        os.close(fd)
        raise


def _recheck_directory(path, descriptor):
    _check_ancestry(path)
    named = os.stat(path, follow_symlinks=False)
    opened = os.fstat(descriptor)
    if not stat.S_ISDIR(named.st_mode) or not stat.S_ISDIR(opened.st_mode) or \
            (named.st_dev, named.st_ino, named.st_uid, _mode(named)) != \
            (opened.st_dev, opened.st_ino, opened.st_uid, _mode(opened)):
        _fail()


def _recheck_lock(directory_fd, descriptor):
    opened = os.fstat(descriptor)
    named = _named_file(directory_fd, LOCK_NAME)
    if (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
        _fail()


def _lock_fdinfo(descriptor):
    # Linux exposes the lock mode for an inherited descriptor in fdinfo. Reject an
    # unexpected exclusive lease before reapplying SH, which would otherwise downgrade it.
    try:
        with open("/proc/self/fdinfo/" + str(descriptor), "rb") as source:
            data = source.read(4097)
        if len(data) > 4096:
            _fail()
        lines = [line for line in data.splitlines() if line.startswith(b"lock:")]
        if any(re.search(rb"\bWRITE\b", line) for line in lines):
            _fail()
    except OSError:
        _fail()


def _verify_held(directory, installation_id, epoch):
    if fcntl is None:
        _fail()
    installation_id, epoch = _identity(installation_id, epoch)
    if os.geteuid() != 0:
        _fail()
    dir_fd = _open_directory(directory)
    try:
        _recheck_directory(directory, dir_fd)
        _recheck_lock(dir_fd, 9)
        _named_file(dir_fd, INTENT_NAME)
        _lock_fdinfo(9)
        fcntl.flock(9, fcntl.LOCK_SH | fcntl.LOCK_NB)
        _recheck_directory(directory, dir_fd)
        _recheck_lock(dir_fd, 9)
        _intent(dir_fd, installation_id, epoch)
        _recheck_directory(directory, dir_fd)
        _recheck_lock(dir_fd, 9)
    finally:
        os.close(dir_fd)


def _guard(argv):
    if fcntl is None:
        _fail()
    if os.geteuid() != 0 or len(argv) != 6 or argv[0] != "guard" or argv[1] != ADMISSION_DIR or argv[4] != "--" or argv[5] != START_SCRIPT:
        _fail()
    installation_id, epoch = _identity(argv[2], argv[3])
    dir_fd = _open_directory(argv[1])
    lock_fd = -1
    try:
        lock_fd = _open_checked(dir_fd, LOCK_NAME)
        fcntl.flock(lock_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        _named_file(dir_fd, LOCK_NAME, lock_fd)
        _intent(dir_fd, installation_id, epoch)
        _recheck_directory(argv[1], dir_fd)
        _recheck_lock(dir_fd, lock_fd)
        _check_ancestry(argv[1])
        # The pathname walk can itself have consumed fd9. Close it before
        # promoting the gate so a later directory close cannot release the lease.
        os.close(dir_fd)
        dir_fd = -1
        if lock_fd != 9:
            os.dup2(lock_fd, 9, inheritable=True)
            os.close(lock_fd)
            lock_fd = 9
        else:
            os.set_inheritable(9, True)
        os.environ["LARES_MAINTENANCE_ADMISSION_DIR"] = argv[1]
        os.environ["LARES_MAINTENANCE_INSTALLATION_ID"] = installation_id
        os.environ["LARES_MAINTENANCE_EPOCH"] = epoch
        os.execv(START_SCRIPT, [START_SCRIPT])
    finally:
        if lock_fd >= 0:
            try:
                os.close(lock_fd)
            except OSError:
                pass
        if dir_fd >= 0:
            try:
                os.close(dir_fd)
            except OSError:
                pass


def main(argv):
    if argv and argv[0] == "verify" and len(argv) == 1:
        _verify_held(os.environ.get("LARES_MAINTENANCE_ADMISSION_DIR", ""),
                     os.environ.get("LARES_MAINTENANCE_INSTALLATION_ID", ""),
                     os.environ.get("LARES_MAINTENANCE_EPOCH", ""))
        return 0
    if argv and argv[0] == "guard":
        _guard(argv)
        return 78
    _fail()


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception:
        print(REFUSAL, file=sys.stderr)
        raise SystemExit(78)
