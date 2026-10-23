#!/usr/bin/env python3
"""Pin a freshly verified owner identity after a database preflight.

The tuple arrives through a no-echo terminal prompt. It is never placed in argv, environment,
logs or generated shell text. This file changes only CONSOLE_BOOTSTRAP_IDENTITY in the existing
root-only Console OAuth env file; the callback remains the final database authority.
"""

from __future__ import annotations

import argparse
import fcntl
import getpass
import hashlib
import hmac
import json
import os
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

BOOTSTRAP_KEY = "CONSOLE_BOOTSTRAP_IDENTITY"
HOST_LOCK_TIMEOUT_SECONDS = 5
PREFLIGHT_TIMEOUT_SECONDS = 45
PREFLIGHT_STOP_GRACE_SECONDS = 3
CONTAINER_CLEANUP_TIMEOUT_SECONDS = 5


class ReplacementDurabilityUnconfirmed(Exception):
    """The new settings file was atomically installed, but durability was not confirmed."""


class PreflightCleanupUnconfirmed(Exception):
    """The timed-out preflight child stopped, but Docker cleanup could not be confirmed."""


def acquire_host_lock(fd: int) -> None:
    deadline = time.monotonic() + HOST_LOCK_TIMEOUT_SECONDS
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("another owner bootstrap is still running")
            time.sleep(min(0.05, remaining))


def remove_preflight_container(cidfile: Path) -> bool:
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
        fd = os.open(cidfile, flags)
    except FileNotFoundError:
        # Docker may have created a container before its client wrote the ID file.
        return False
    except OSError:
        return False
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or not is_root_owned(info) or info.st_mode & 0o022 or info.st_size > 128:
            return False
        raw = os.read(fd, 129)
    except OSError:
        return False
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
    if len(raw) > 128:
        return False
    try:
        container_id = raw.decode("ascii").strip()
    except UnicodeDecodeError:
        return False
    if not container_id:
        # An empty file is not proof that the daemon created nothing.
        return False
    if not __import__("re").fullmatch(r"[a-f0-9]{64}", container_id):
        return False
    try:
        result = subprocess.run(
            ["docker", "rm", "-f", container_id],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=CONTAINER_CLEANUP_TIMEOUT_SECONDS,
            start_new_session=True,
        )
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def stop_preflight_process(process: subprocess.Popen[bytes]) -> bool:
    process_group = process.pid

    def signal_group(sig: signal.Signals) -> bool:
        try:
            os.killpg(process_group, sig)
            return True
        except ProcessLookupError:
            return True
        except OSError:
            return False

    def group_is_gone() -> bool | None:
        try:
            os.killpg(process_group, 0)
            return False
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        except OSError:
            return None

    def wait_for_group_exit(seconds: float) -> bool:
        deadline = time.monotonic() + seconds
        while True:
            state = group_is_gone()
            if state is True:
                return True
            if state is None:
                return False
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            time.sleep(min(0.05, remaining))

    term_sent = signal_group(signal.SIGTERM)
    # Reap the leader when it exits, but do not confuse that with group cleanup:
    # a child may still hold the process group after the shell has gone away.
    try:
        process.wait(timeout=PREFLIGHT_STOP_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        pass
    term_group_gone = wait_for_group_exit(PREFLIGHT_STOP_GRACE_SECONDS)
    if term_sent and term_group_gone:
        return True

    kill_sent = signal_group(signal.SIGKILL)
    try:
        process.wait(timeout=PREFLIGHT_STOP_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        pass
    killed_group_gone = wait_for_group_exit(PREFLIGHT_STOP_GRACE_SECONDS)
    return kill_sent and killed_group_gone and process.poll() is not None


def run_preflight(preflight: Path, prefix: Path, cidfile: Path) -> None:
    process = subprocess.Popen(
        ["bash", str(preflight)],
        env={**os.environ, "LARES_PREFIX": str(prefix), "LARES_OWNER_BOOTSTRAP_CIDFILE": str(cidfile)},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        umask=0o077,
    )
    try:
        returncode = process.wait(timeout=PREFLIGHT_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        stopped = stop_preflight_process(process)
        cleaned = remove_preflight_container(cidfile)
        if not stopped or not cleaned:
            raise PreflightCleanupUnconfirmed from error
        raise RuntimeError("fresh-owner preflight timed out; settings were not changed") from error
    if returncode != 0:
        raise RuntimeError("fresh-owner database preflight refused; settings were not changed")


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def parse_receipt(raw: str) -> dict[str, Any]:
    receipt = json.loads(raw, object_pairs_hook=unique_object)
    if not isinstance(receipt, dict) or set(receipt) != {"installationOrigin", "identity", "digest"}:
        raise ValueError("receipt has an unexpected shape")
    origin = receipt["installationOrigin"]
    identity = receipt["identity"]
    if not isinstance(origin, str) or not __import__("re").fullmatch(r"https://[^/\s]+", origin):
        raise ValueError("receipt origin is invalid")
    if not isinstance(identity, dict) or set(identity) not in ({"issuer", "subject"}, {"issuer", "subject", "tenantId"}):
        raise ValueError("provider identity is invalid")
    if any(not isinstance(identity.get(key), str) or not identity[key].strip() for key in ("issuer", "subject")):
        raise ValueError("provider identity is invalid")
    if "tenantId" in identity and (not isinstance(identity["tenantId"], str) or not identity["tenantId"].strip()):
        raise ValueError("provider identity is invalid")
    normalized_identity = {"issuer": identity["issuer"], "subject": identity["subject"]}
    if "tenantId" in identity:
        normalized_identity["tenantId"] = identity["tenantId"]
    if not isinstance(receipt["digest"], str) or not __import__("re").fullmatch(r"[a-f0-9]{64}", receipt["digest"]):
        raise ValueError("receipt digest is invalid")
    return {"installationOrigin": origin, "identity": normalized_identity, "digest": receipt["digest"]}


def receipt_digest(installation_origin: str, identity: dict[str, str]) -> str:
    payload = {"purpose": "lares-owner-discovery-v1", "installationOrigin": installation_origin, "identity": identity}
    canonical = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def bootstrap_digest(owner_id: str, organisation_id: str, installation_origin: str, identity: dict[str, str]) -> str:
    payload = {"purpose": "lares-owner-bootstrap-v1", "ownerId": owner_id, "organisationId": organisation_id,
               "installationOrigin": installation_origin, "identity": identity}
    canonical = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def require_directory(path: Path) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or not is_root_owned(info) or info.st_mode & 0o022:
        raise ValueError("installation directory is unsafe")
    return info


def is_root_owned(info: os.stat_result) -> bool:
    return info.st_uid == 0


def read_protected(path: Path, mode: int, *, allow_group_read: bool = False) -> tuple[bytes, os.stat_result]:
    flags = (os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
             | getattr(os, "O_NONBLOCK", 0))
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        allowed = (info.st_mode & 0o777) == mode or (allow_group_read and (info.st_mode & 0o777) == mode)
        if not stat.S_ISREG(info.st_mode) or not is_root_owned(info) or not allowed:
            raise ValueError("installation file has unsafe ownership or permissions")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks), info
    finally:
        os.close(fd)


def read_settings(contents: str) -> dict[str, str]:
    settings: dict[str, str] = {}
    for line in contents.splitlines():
        candidate = line.lstrip()
        if not candidate or candidate.startswith("#"):
            continue
        selected = next((name for name in ("LARES_OWNER_ID", "LARES_DOMAIN")
                         if candidate == name or candidate.startswith(name + "=") or candidate.startswith(name + " ")), None)
        if selected is None:
            continue
        if candidate != line:
            raise ValueError("installation setting is malformed")
        key, sep, raw = candidate.partition("=")
        if key != selected or not sep:
            raise ValueError("installation setting is malformed")
        if key in settings:
            raise ValueError("installation settings are duplicated")
        values = shlex.split(raw, comments=False, posix=True)
        if len(values) != 1:
            raise ValueError("installation setting is malformed")
        settings[key] = values[0]
    if set(settings) != {"LARES_OWNER_ID", "LARES_DOMAIN"}:
        raise ValueError("installation owner or organisation is missing")
    if not settings["LARES_OWNER_ID"].strip() or not __import__("re").fullmatch(r"[a-z0-9.-]+", settings["LARES_DOMAIN"]) or "." not in settings["LARES_DOMAIN"]:
        raise ValueError("installation owner or organisation is invalid")
    return settings


def read_keeper_owner(contents: bytes) -> str:
    keeper = json.loads(contents.decode("utf-8"), object_pairs_hook=unique_object)
    if not isinstance(keeper, dict) or not isinstance(keeper.get("designatedOwnerId"), str) or not keeper["designatedOwnerId"].strip():
        raise ValueError("Keeper designated owner is missing")
    return keeper["designatedOwnerId"]


def persisted_context(settings: dict[str, str], keeper_owner: str, copied_origin: str) -> tuple[str, str, str]:
    if keeper_owner != settings["LARES_OWNER_ID"]:
        raise ValueError("Keeper and installation owner differ")
    organisation_id = settings["LARES_DOMAIN"]
    installation_origin = f"https://{organisation_id}"
    if copied_origin != installation_origin:
        raise ValueError("copied setup details do not match this installation")
    return keeper_owner, organisation_id, installation_origin


def compose_env_json(selection: dict[str, Any]) -> str:
    # env_file interpolates $NAME. Compose's $$ escape preserves a literal dollar in the
    # resulting container value, including inside this JSON string.
    return json.dumps(selection, ensure_ascii=False, separators=(",", ":")).replace("$", "$$")


def env_with_identity(contents: bytes, selection: dict[str, Any]) -> tuple[bytes, bool]:
    try:
        text = contents.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("Console OAuth env file is not UTF-8") from error
    lines = text.splitlines(keepends=True)
    found: list[tuple[int, str]] = []
    for index, line in enumerate(lines):
        body = line.rstrip("\r\n")
        if body.lstrip().startswith("#"):
            continue
        left, sep, value = body.partition("=")
        if left.strip() == BOOTSTRAP_KEY:
            if left != BOOTSTRAP_KEY or not sep:
                raise ValueError("bootstrap identity assignment is malformed")
            found.append((index, value))
        elif body.strip().startswith(BOOTSTRAP_KEY):
            raise ValueError("bootstrap identity assignment is ambiguous")
    if len(found) > 1:
        raise ValueError("bootstrap identity assignment is duplicated")
    expected = compose_env_json(selection)
    if found:
        if found[0][1] != expected:
            raise ValueError("a different bootstrap identity is already selected")
        return contents, True
    suffix = "" if not text or text.endswith(("\n", "\r")) else "\n"
    return contents + suffix.encode("utf-8") + f"{BOOTSTRAP_KEY}={expected}\n".encode("utf-8"), False


def atomic_replace(path: Path, contents: bytes, mode: int = 0o600) -> None:
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    fd_open = True
    replaced = False
    try:
        os.fchown(fd, 0, 0)
        os.fchmod(fd, mode)
        output = os.fdopen(fd, "wb")
        fd_open = False
        with output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        replaced = True
        try:
            dirfd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)
        except OSError as error:
            raise ReplacementDurabilityUnconfirmed from error
    finally:
        if fd_open:
            os.close(fd)
        if os.path.exists(temporary):
            try:
                os.unlink(temporary)
            except OSError as error:
                if replaced:
                    raise ReplacementDurabilityUnconfirmed from error
                raise


def run(prefix: Path, receipt_raw: str) -> str:
    if os.geteuid() != 0:
        raise PermissionError("run this command as root")
    etc = prefix / "etc" / "lares"
    require_directory(etc)
    oauth_path = etc / "console-oauth.env"
    install_path = etc / "installation.env"
    keeper_path = etc / "keeper.json"
    lock_path = etc / ".console-oauth.bootstrap.lock"
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    lock_fd = os.open(lock_path, flags, 0o600)
    file_replaced = False
    try:
        lock_stat = os.fstat(lock_fd)
        if not stat.S_ISREG(lock_stat.st_mode) or not is_root_owned(lock_stat) or lock_stat.st_mode & 0o077:
            raise ValueError("bootstrap lock file is unsafe")
        os.fchmod(lock_fd, 0o600)
        acquire_host_lock(lock_fd)
        install_bytes, _ = read_protected(install_path, 0o640, allow_group_read=True)
        keeper_bytes, _ = read_protected(keeper_path, 0o600)
        oauth_bytes, oauth_stat = read_protected(oauth_path, 0o600)
        settings = read_settings(install_bytes.decode("utf-8"))
        receipt = parse_receipt(receipt_raw)
        keeper_owner, organisation_id, installation_origin = persisted_context(
            settings, read_keeper_owner(keeper_bytes), receipt["installationOrigin"])
        expected_digest = receipt_digest(installation_origin, receipt["identity"])
        if not hmac.compare_digest(expected_digest, receipt["digest"]):
            raise ValueError("copied setup digest does not match")
        selection = {
            "ownerId": keeper_owner,
            "organisationId": organisation_id,
            "installationOrigin": installation_origin,
            "identity": receipt["identity"],
            "digest": bootstrap_digest(keeper_owner, organisation_id, installation_origin, receipt["identity"]),
        }
        updated, already = env_with_identity(oauth_bytes, selection)

        # This path is fixed beside the installed command, never selected by command input.
        preflight = Path(__file__).with_name("owner-bootstrap-preflight.sh")
        with tempfile.TemporaryDirectory(prefix="lares-owner-bootstrap-") as temporary_directory:
            run_preflight(preflight, prefix, Path(temporary_directory) / "container.id")

        current_install, _ = read_protected(install_path, 0o640, allow_group_read=True)
        current_keeper, _ = read_protected(keeper_path, 0o600)
        current_oauth, current_stat = read_protected(oauth_path, 0o600)
        if current_install != install_bytes or current_keeper != keeper_bytes or current_oauth != oauth_bytes or current_stat.st_ino != oauth_stat.st_ino:
            raise RuntimeError("installation configuration changed during preflight; retry after review")
        if not already:
            atomic_replace(oauth_path, updated)
            file_replaced = True
        return "The provider identity is selected for the current fresh install. Recreate only Console, then sign in again with the same account. This step issued no session."
    finally:
        try:
            os.close(lock_fd)
        except OSError as error:
            if file_replaced:
                raise ReplacementDurabilityUnconfirmed from error
            raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", type=Path, default=Path("/"))
    args = parser.parse_args()
    try:
        raw = getpass.getpass("Paste the owner setup JSON shown on the sign-in page: ")
        success_message = run(args.prefix, raw)
    except ReplacementDurabilityUnconfirmed:
        print("owner bootstrap warning: the selected settings were replaced, but final durability confirmation failed; inspect the settings before retrying", file=sys.stderr)
        return 1
    except PreflightCleanupUnconfirmed:
        print("owner bootstrap refused: preflight timed out; settings were not changed, but container cleanup could not be confirmed; inspect Docker state before retrying", file=sys.stderr)
        return 1
    except Exception:
        print("owner bootstrap refused; no settings were changed; verify installation state and retry after review", file=sys.stderr)
        return 1
    try:
        sys.stdout.write(success_message + "\n")
        return 0
    except OSError:
        sys.stderr.write("owner bootstrap warning: settings were selected, but the success message could not be delivered; inspect the settings before retrying\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
