#!/usr/bin/env python3
"""Exercise the unpacked host admission boundary in independent systemd services.

The payload is a temporary settings file that exits before backup work begins. This
proves Linux flock evidence and descriptor lifetime without contacting any service.
"""
from __future__ import annotations

import importlib.util
import fcntl
import os
import pwd
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


SCRIPTS = ("backup.sh", "backup-verify.sh", "restore-drill.sh")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def run(command: list[str], *, timeout: float = 15) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, text=True, capture_output=True, timeout=timeout)


def unit_load_state(unit: str) -> str:
    result = run(["sudo", "systemctl", "show", "--property=LoadState", "--value", unit])
    if result.returncode != 0:
        raise RuntimeError(f"could not inspect owned systemd unit {unit}: {result.stderr}")
    return result.stdout.strip()


def stop_owned_unit(unit: str) -> None:
    state = unit_load_state(unit)
    if state == "not-found":
        return
    result = run(["sudo", "systemctl", "stop", unit])
    if result.returncode != 0:
        raise RuntimeError(f"could not stop owned systemd unit {unit}: {result.stderr}")
    run(["sudo", "systemctl", "reset-failed", unit])
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if unit_load_state(unit) == "not-found":
            return
        time.sleep(0.05)
    raise RuntimeError(f"owned systemd unit remains loaded after cleanup: {unit}")


def exclusive_gate_available(gate: Path) -> bool:
    fd = os.open(gate, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        fcntl.flock(fd, fcntl.LOCK_UN)
        return True
    finally:
        os.close(fd)


def main() -> int:
    if not sys.platform.startswith("linux"):
        raise RuntimeError("this proof requires Linux systemd")
    if os.geteuid() == 0:
        raise RuntimeError("run this proof as the CI user, not root")

    ops = Path(sys.argv[1]).resolve(strict=True)
    helper = ops / "maintenance-custody.py"
    require(helper.is_file(), "unpacked maintenance helper is missing")
    for name in SCRIPTS:
        require((ops / name).is_file(), f"unpacked entrypoint is missing: {name}")
    spec = importlib.util.spec_from_file_location("unpacked_maintenance_custody", helper)
    require(spec is not None and spec.loader is not None, "cannot load unpacked maintenance helper")
    custody = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(custody)

    user = pwd.getpwuid(os.geteuid())
    unique = uuid.uuid4().hex
    prefix_parent = Path(tempfile.mkdtemp(prefix=f"lares-admission-{unique}-"))
    prefix = prefix_parent / "installation"
    prefix.mkdir(mode=0o755)
    settings = prefix_parent / "backup.env"
    started = prefix_parent / "started"
    release = prefix_parent / "release"
    sourced = prefix_parent / "settings-sourced"
    settings.write_text(
        f"printf '%s\\n' \"$LARES_CASE\" >> {str(sourced)!r}\n"
        "if [ \"${LARES_CASE:-}\" = backup ]; then\n"
        f"  touch {str(started)!r}\n"
        f"  while [ ! -e {str(release)!r} ]; do sleep 0.02; done\n"
        "fi\n"
        "exit 0\n",
        encoding="utf-8",
    )
    settings.chmod(0o600)

    # Establish only fresh, user-owned custody, then place the actual unpacked files
    # at the path the entrypoints resolve through SCRIPT_DIR.
    custody.prepare_fresh(prefix, "172.30.0.0/24", expected_uid=os.geteuid())
    installed = prefix / "opt/lares"
    installed.mkdir(parents=True, mode=0o755)
    for name in (*SCRIPTS, "maintenance-custody.py"):
        shutil.copy2(ops / name, installed / name)

    names: list[str] = []
    starter: subprocess.Popen[str] | None = None
    cleanup_ok = False
    try:
        def launch(name: str, script: str, *, wait: bool) -> subprocess.CompletedProcess[str] | subprocess.Popen[str]:
            unit = f"lares-admission-{unique}-{name}.service"
            names.append(unit)
            command = [
                "sudo", "systemd-run", "--quiet", f"--unit={unit}", "--collect",
                f"--property=User={user.pw_name}", f"--property=Group={user.pw_gid}",
                "--property=RuntimeMaxSec=30s",
                "--setenv=LARES_MAINTENANCE_TESTING=1",
                f"--setenv=LARES_MAINTENANCE_TEST_PREFIX={prefix}",
                f"--setenv=AGENT_BOX_BACKUP_ENV={settings}",
                f"--setenv=LARES_CASE={name}",
            ]
            if wait:
                return subprocess.Popen(command + ["--wait", "/bin/bash", str(installed / script)], text=True,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            return run(command + ["--wait", "/bin/bash", str(installed / script)])

        starter = launch("backup", "backup.sh", wait=True)  # type: ignore[assignment]
        require(isinstance(starter, subprocess.Popen), "could not start independent backup service")
        deadline = time.monotonic() + 10
        while not started.exists() and starter.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        require(started.exists(), "systemd backup service did not reach its sourced settings")

        receipt = custody.validate(prefix, "172.30.0.0/24")
        custody.transition(prefix / "var/lib/lares-maintenance/custody",
                           prefix / "var/lib/lares-maintenance/admission",
                           receipt["installationId"], receipt["epoch"], "entering",
                           expected_uid=os.geteuid())

        gate = prefix / "var/lib/lares-maintenance/admission/service-gate.lock"
        require(not exclusive_gate_available(gate),
                "the independent backup service did not retain a shared lease")

        for name, script in (("verify", "backup-verify.sh"), ("drill", "restore-drill.sh")):
            result = launch(name, script, wait=False)
            require(isinstance(result, subprocess.CompletedProcess), "systemd refusal invocation did not return")
            require(result.returncode == 78, f"refusal case {name} did not exit with admission status 78: {result.stdout} {result.stderr}")
            unit = names[-1]
            deadline = time.monotonic() + 10
            while unit_load_state(unit) != "not-found" and time.monotonic() < deadline:
                time.sleep(0.05)
            require(unit_load_state(unit) == "not-found", f"refusal service was not collected: {unit}")

        require(sourced.read_text(encoding="utf-8").splitlines() == ["backup"],
                "a refusal case unexpectedly sourced backup settings")
        release.touch()
        stdout, stderr = starter.communicate(timeout=15)
        require(starter.returncode == 0, f"admitted backup service failed: {stdout} {stderr}")

        # Once the independent Bash process exits, the exclusive transition lock is
        # available again. This is descriptor-lifetime evidence, not descendant proof.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if exclusive_gate_available(gate):
                cleanup_ok = True
                break
            time.sleep(0.05)
        require(cleanup_ok, "shared lease remained after the admitted systemd service exited")
        print("systemd maintenance admission proof passed: independent process, Linux shared lease, entering refusal, fd lifetime")
        return 0
    finally:
        release.touch(exist_ok=True)
        for unit in reversed(names):
            stop_owned_unit(unit)
        if starter is not None and starter.poll() is None:
            starter.communicate(timeout=15)
        # Verify no service still owns this unique prefix before deleting the fixture.
        for unit in names:
            require(unit_load_state(unit) == "not-found", f"fixture cleanup left systemd unit loaded: {unit}")
        gate = prefix / "var/lib/lares-maintenance/admission/service-gate.lock"
        if names:
            require(gate.is_file(), "owned systemd fixture lost its service gate before cleanup")
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not exclusive_gate_available(gate):
                time.sleep(0.05)
            require(exclusive_gate_available(gate),
                    "service lease remains after stopping the uniquely owned systemd units")
        shutil.rmtree(prefix_parent)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"maintenance admission systemd proof failed: {error}", file=sys.stderr)
        raise SystemExit(1)
