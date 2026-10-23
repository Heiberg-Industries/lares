#!/usr/bin/env python3
"""Validate normal maintenance custody before starting the fixed foreground Squid."""

import fcntl
import errno
import json
import os
import re
import stat
import sys

ADMISSION_DIR = "/run/lares-maintenance/admission"
INTENT_NAME = "intent.json"
LOCK_NAME = "service-gate.lock"
INTENT_LIMIT = 256
LOCK_FD = 9
SQUID = "/usr/sbin/squid"
SQUID_ARGS = ("squid", "-N", "-f", "/config/squid.conf")
REFUSAL = "lares: egress maintenance admission refused"
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
    return installation_id, number


def _mode(info):
    return stat.S_IMODE(info.st_mode)


def _safe_directory(info, path, final=False):
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
        _fail()
    mode = _mode(info)
    if final:
        if mode != 0o755:
            _fail()
    elif mode & 0o022 and not (mode == 0o1777 and path in ("/tmp", "/var/tmp")):
        _fail()


def _open_directory(path):
    if path != ADMISSION_DIR or not os.path.isabs(path) or os.path.normpath(path) != path:
        _fail()
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptor = os.open("/", flags)
    current = ""
    try:
        _safe_directory(os.fstat(descriptor), "/")
        parts = [part for part in path.split("/") if part]
        for index, part in enumerate(parts):
            current += "/" + part
            next_descriptor = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
            opened = os.fstat(descriptor)
            _safe_directory(opened, current, final=index == len(parts) - 1)
            named = os.stat(current, follow_symlinks=False)
            if not stat.S_ISDIR(named.st_mode) or (opened.st_dev, opened.st_ino, opened.st_uid, _mode(opened)) != (
                    named.st_dev, named.st_ino, named.st_uid, _mode(named)):
                _fail()
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _check_ancestry(path):
    if path != ADMISSION_DIR:
        _fail()
    root = os.lstat("/")
    _safe_directory(root, "/")
    current = ""
    parts = [part for part in path.split("/") if part]
    for index, part in enumerate(parts):
        current += "/" + part
        _safe_directory(os.lstat(current), current, final=index == len(parts) - 1)


def _recheck_directory(path, descriptor):
    _check_ancestry(path)
    opened = os.fstat(descriptor)
    named = os.stat(path, follow_symlinks=False)
    _safe_directory(opened, path, final=True)
    _safe_directory(named, path, final=True)
    if (opened.st_dev, opened.st_ino, opened.st_uid, _mode(opened)) != (
            named.st_dev, named.st_ino, named.st_uid, _mode(named)):
        _fail()


def _named_file(directory_fd, name, *, maximum=None, empty=False):
    info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or _mode(info) != 0o444 or
            info.st_nlink != 1 or (empty and info.st_size != 0) or
            (maximum is not None and info.st_size > maximum)):
        _fail()
    return info


def _same_file(left, right):
    return (stat.S_ISREG(left.st_mode) and stat.S_ISREG(right.st_mode) and
            (left.st_dev, left.st_ino, left.st_uid, left.st_nlink, _mode(left), left.st_size) ==
            (right.st_dev, right.st_ino, right.st_uid, right.st_nlink, _mode(right), right.st_size))


def _open_checked(directory_fd, name, *, maximum=None, empty=False):
    named = _named_file(directory_fd, name, maximum=maximum, empty=empty)
    descriptor = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC,
                         dir_fd=directory_fd)
    try:
        opened = os.fstat(descriptor)
        if not _same_file(named, opened):
            _fail()
        return descriptor, opened
    except BaseException:
        os.close(descriptor)
        raise


def _read_intent(directory_fd, installation_id, epoch):
    descriptor, before = _open_checked(directory_fd, INTENT_NAME, maximum=INTENT_LIMIT)
    try:
        raw = os.read(descriptor, INTENT_LIMIT + 1)
        after = os.fstat(descriptor)
        named = _named_file(directory_fd, INTENT_NAME, maximum=INTENT_LIMIT)
        if len(raw) > INTENT_LIMIT or not _same_file(before, after) or not _same_file(after, named):
            _fail()
        expected = (json.dumps({"version": 1, "installationId": installation_id,
                                "epoch": epoch, "state": "normal"},
                               sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")
        if raw != expected or len(raw) != after.st_size:
            _fail()
    finally:
        os.close(descriptor)


def _recheck_gate(directory_fd, lock_fd):
    opened = os.fstat(lock_fd)
    named = _named_file(directory_fd, LOCK_NAME, empty=True)
    if not _same_file(opened, named):
        _fail()


def _fd9_is_absent():
    try:
        os.fstat(LOCK_FD)
    except OSError as error:
        if error.errno == errno.EBADF:
            return
        _fail()
    _fail()


def _guard(argv):
    if os.geteuid() != 0 or tuple(argv) != SQUID_ARGS:
        _fail()
    installation_id, epoch = _identity(
        os.environ.get("LARES_MAINTENANCE_INSTALLATION_ID"),
        os.environ.get("LARES_MAINTENANCE_EPOCH"))
    _fd9_is_absent()
    directory_fd = _open_directory(ADMISSION_DIR)
    lock_fd = -1
    try:
        _recheck_directory(ADMISSION_DIR, directory_fd)
        lock_fd, _opened = _open_checked(directory_fd, LOCK_NAME, empty=True)
        fcntl.flock(lock_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        _recheck_directory(ADMISSION_DIR, directory_fd)
        _recheck_gate(directory_fd, lock_fd)
        _read_intent(directory_fd, installation_id, epoch)
        _recheck_directory(ADMISSION_DIR, directory_fd)
        _recheck_gate(directory_fd, lock_fd)
        # Closing the directory before promoting the lease matters when the
        # admission walk consumed fd9 and the gate itself opened below fd9.
        os.close(directory_fd)
        directory_fd = -1
        if lock_fd != LOCK_FD:
            os.dup2(lock_fd, LOCK_FD, inheritable=True)
            os.close(lock_fd)
        else:
            os.set_inheritable(LOCK_FD, True)
        lock_fd = -1
        os.execv(SQUID, (SQUID, *SQUID_ARGS[1:]))
        _fail()
    finally:
        if lock_fd >= 0:
            os.close(lock_fd)
        if directory_fd >= 0:
            os.close(directory_fd)


def main(argv):
    try:
        _guard(argv)
    except Exception:
        print(REFUSAL, file=sys.stderr)
        raise SystemExit(78)


if __name__ == "__main__":
    main(sys.argv[1:])
