"""CI-only proof of the generated Console startup admission path in the final image."""
from __future__ import annotations

import fcntl
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

if os.environ.get("CI") != "true" or os.geteuid() != 0:
    raise SystemExit("Console startup admission proof requires the isolated CI root fixture")
if len(sys.argv) != 4:
    raise SystemExit("usage: start-admission-image.probe.py <image> <source-sha> <proof.json>")

IMAGE, SOURCE_SHA, PROOF_PATH = sys.argv[1:]
if len(SOURCE_SHA) != 40:
    raise SystemExit("invalid Console startup admission proof identity")
REPO = pathlib.Path(__file__).resolve().parents[3]
root = pathlib.Path(tempfile.mkdtemp(prefix="lares-console-start-admission-", dir="/tmp")).resolve()
root.chmod(0o755)
prefix = root / "prefix"
prefix.mkdir(mode=0o755)
prefix.chmod(0o755)
etc = prefix / "etc/lares"
secrets = etc / "secrets"
installation = prefix / "srv/lares/installation"
socket_dir = prefix / "run/lares"
taste_dir = prefix / "srv/taste"
opt = prefix / "opt/lares"
for path in (secrets, installation, socket_dir, taste_dir, opt):
    path.mkdir(parents=True, mode=0o755)
admission = prefix / "var/lib/lares-maintenance/admission"
auth = prefix / "var/lib/lares-maintenance/postgres-auth"
subnet = f"172.30.{(os.getpid() % 180) + 20}.0/24"
project = "lares-console-admission-" + uuid.uuid4().hex[:10]
network_name = project + "-network"
stack_path = root / "generated.compose.yml"
missing_stack_path = root / "generated-missing.compose.yml"
override_path = root / "image-override.compose.yml"
missing_path = root / "missing-admission-source"
missing_override_path = root / "missing-bind.compose.yml"
proof = {
    "format": 1, "sourceCommit": SOURCE_SHA, "image": IMAGE, "status": "running",
    "failedStage": None,
    "candidateImageId": None,
    "containerImageId": None,
    "restartContainerImageId": None,
    "claims": {
        "actualOrdinaryRendererUsed": False,
        "positiveServiceMatchesGeneratedExceptImage": False,
        "runtimeMatchesCandidateImage": False,
        "imageDefaultsGuardAndSecretLoadingCommand": False,
        "oldComposeWithoutIdentityRefusedBeforeSecretRead": False,
        "serverPid1HoldsHostAdmissionLock": False,
        "runtimeProcessSampleAndDescendantLimitRecorded": False,
        "exclusiveLockBlockedLiveAndAvailableAfterStop": False,
        "restartRetainedAdmission": False,
        "wrongUuidEpochAndBlockedMalformedIntentRefused": False,
        "missingBindSourceRefusedWithoutCreation": False,
        "restoredBindSourceAccepted": False,
        "cleanupOkay": False,
    },
}
known_container: str | None = None


class ProbeFailure(Exception):
    pass


def run(*args: str, timeout: int = 60, check: bool = True) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise ProbeFailure("command-timeout") from None
    if check and result.returncode != 0:
        raise ProbeFailure("command-failed")
    return result


def docker(*args: str, timeout: int = 60, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run("docker", *args, timeout=timeout, check=check)


def compose(*args: str, timeout: int = 60, check: bool = True) -> subprocess.CompletedProcess[str]:
    return docker("compose", "-p", project, "-f", str(stack_path), "-f", str(override_path),
                  *args, timeout=timeout, check=check)


def write(path: pathlib.Path, data: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data, encoding="utf-8")
    path.chmod(mode)


def wait_ready(container: str) -> str:
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        state = docker("inspect", "-f", "{{.State.Running}}", container, check=False, timeout=8)
        if state.returncode != 0 or state.stdout.strip() != "true":
            time.sleep(0.25)
            continue
        request = docker("exec", container, "node", "-e",
                         "fetch('http://127.0.0.1:3000/api/auth/login?provider=other',{redirect:'manual'})"
                         ".then(r=>console.log(r.status+'|'+r.headers.get('location'))).catch(()=>process.exit(2))",
                         check=False, timeout=8)
        if request.returncode == 0 and request.stdout.strip() == "307|https://example.invalid/sign-in?error=failed":
            return request.stdout.strip()
        time.sleep(0.25)
    raise ProbeFailure("console-readiness-timeout")


def admission_fd_identity(container: str) -> tuple[str, str, str]:
    result = docker("exec", container, "sh", "-c",
                    "printf '%s\\n%s\\n%s\\n' "
                    "\"$(awk '/^Uid:/{print $2}' /proc/1/status)\" "
                    "\"$(tr '\\000' ' ' </proc/1/cmdline)\" "
                    "\"$(stat -Lc '%d:%i' /proc/1/fd/9)\"", timeout=8)
    lines = result.stdout.splitlines()
    if len(lines) != 3 or any(not line for line in lines):
        raise ProbeFailure("pid1-inspection-format")
    return lines[0], lines[1], lines[2]


def assert_admission_mount_contract(raw_text: str, service: dict[str, object], source: pathlib.Path) -> None:
    source_text = str(source)
    escaped_source = re.escape(source_text)
    raw_mount = re.compile(
        rf"(?m)^\s*- type: bind\n"
        rf"\s+source: {escaped_source}\n"
        rf"\s+target: /run/lares-maintenance/admission\n"
        rf"\s+read_only: true\n"
        rf"\s+bind:\n"
        rf"\s+create_host_path: false\s*$"
    )
    if len(raw_mount.findall(raw_text)) != 1:
        raise ProbeFailure("raw-admission-mount-contract")

    volumes = service.get("volumes")
    if not isinstance(volumes, list):
        raise ProbeFailure("canonical-admission-mount-format")
    targets = [volume for volume in volumes if isinstance(volume, dict)
               and volume.get("target") == "/run/lares-maintenance/admission"]
    sources = [volume for volume in volumes if isinstance(volume, dict)
               and isinstance(volume.get("source"), str)
               and os.path.realpath(volume["source"]) == os.path.realpath(source_text)]
    if len(targets) != 1 or targets != sources:
        raise ProbeFailure("canonical-admission-mount-count")
    mount = targets[0]
    bind = mount.get("bind")
    if (mount.get("type") != "bind" or mount.get("read_only") is not True
            or not isinstance(bind, dict)
            or ("create_host_path" in bind and bind["create_host_path"] is not False)):
        raise ProbeFailure("canonical-admission-mount-contract")


def process_sample(container: str, expected_fd: str) -> dict[str, object]:
    source = (
        "const fs=require('node:fs'), path=require('node:path'); const rows=[]; "
        "for(const pid of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)).slice(0,64)){try{"
        "const status=fs.readFileSync('/proc/'+pid+'/status','utf8');"
        "const ppid=Number(status.match(/^PPid:\\s+(\\d+)/m)?.[1]);"
        "const argv=fs.readFileSync('/proc/'+pid+'/cmdline').toString().replaceAll('\\0',' ');"
        "const exe=path.basename(fs.readlinkSync('/proc/'+pid+'/exe'));"
        "let fd9=null; try{const s=fs.statSync('/proc/'+pid+'/fd/9');fd9=s.dev+':'+s.ino;}catch{}"
        "rows.push({pid:Number(pid),ppid,executable:exe,consoleServer:argv.includes('services/console/server.js'),"
        "holdsAdmissionFd9:fd9===" + json.dumps(expected_fd) + "});}catch{}}"
        "console.log(JSON.stringify({processes:rows,truncated:rows.length>=64}));"
    )
    result = docker("exec", container, "node", "-e", source, timeout=8)
    value = json.loads(result.stdout)
    if not isinstance(value, dict) or not isinstance(value.get("processes"), list):
        raise ProbeFailure("process-sample-format")
    value["descendantLeaseLimit"] = "sampled readable /proc entries only; no process-tree-wide lease guarantee"
    return value


stage = "fixture-setup"
try:
    custody = REPO / "services/box/ops/maintenance-custody.py"
    run("python3", str(custody), "prepare-fresh", str(prefix), subnet, "--confirm-fresh")
    receipt = json.loads((prefix / "var/lib/lares-maintenance/custody/preparation.json").read_text())
    identity, epoch = receipt["installationId"], str(receipt["epoch"])
    for name in ("console-session-secret", "eve-route-password", "database-password", "token-enc-key",
                 "gateway-key", "gateway-master-key", "model-provider-key", "gateway-database-password"):
        write(secrets / name, "neutral-ci-fixture-value\n")
    release = root / "release.json"
    digest = "example.invalid/lares-fixture@sha256:" + "a" * 64
    write(release, json.dumps({"release": "2026-10-01", "images": {
        name: digest for name in ("db", "console", "lares-gateway", "caddy")},
        "migrations": {"box": "001_baseline.sql"}, "breaking": []}) + "\n")
    caddyfile = REPO / "services/box/ops/Caddyfile"
    args = [str(release), str(stack_path), str(secrets), str(etc / "litellm-config.yaml"),
            str(caddyfile), str(prefix / "var/lib/lares/caddy"), str(prefix / "var/lib/lares/postgres"),
            network_name, subnet, "example.invalid", "lares_state", "lares-brain",
            "neutral-model", str(etc / "gateway-start.sh"), "owner@example.invalid", str(socket_dir),
            "neutral-owner", "Europe/Oslo", str(taste_dir), str(installation), str(auth), str(prefix)]
    run("pnpm", "-C", str(REPO / "services/box"), "render-stack", "--", *args, timeout=90)
    proof["claims"]["actualOrdinaryRendererUsed"] = True
    write(override_path, "services:\n  console:\n    image: " + IMAGE + "\nnetworks:\n  " + network_name + ":\n    internal: true\n")
    resolved = json.loads(compose("config", "--format", "json").stdout)
    generated = json.loads(docker("compose", "-p", project, "-f", str(stack_path), "config", "--format", "json").stdout)
    raw_text = stack_path.read_text(encoding="utf-8")
    if resolved["services"]["console"]["image"] != IMAGE:
        raise ProbeFailure("generated-console-contract")
    assert_admission_mount_contract(raw_text, generated["services"]["console"], admission)
    assert_admission_mount_contract(raw_text, resolved["services"]["console"], admission)
    expected = dict(generated["services"]["console"])
    actual = dict(resolved["services"]["console"])
    expected.pop("image", None); actual.pop("image", None)
    if expected != actual:
        raise ProbeFailure("effective-service-diff")
    proof["claims"]["positiveServiceMatchesGeneratedExceptImage"] = True

    stage = "image-defaults"
    candidate_image_id = docker("image", "inspect", "-f", "{{.Id}}", IMAGE).stdout.strip()
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", candidate_image_id):
        raise ProbeFailure("candidate-image-id")
    proof["candidateImageId"] = candidate_image_id
    config = docker("image", "inspect", "-f",
                    "{{json .Config.Entrypoint}}|{{json .Config.Cmd}}|{{.Config.User}}", IMAGE).stdout.strip()
    if config != '["/usr/local/lib/lares/maintenance-admission-v1"]|["/usr/local/bin/lares-console-start"]|10001:10001':
        raise ProbeFailure("image-default-contract")
    default = docker("run", "--rm", "--network", "none", IMAGE, check=False, timeout=10)
    if default.returncode != 78 or "maintenance admission refused" not in default.stdout:
        raise ProbeFailure("old-compose-refusal")
    proof["claims"]["imageDefaultsGuardAndSecretLoadingCommand"] = True
    proof["claims"]["oldComposeWithoutIdentityRefusedBeforeSecretRead"] = True

    stage = "positive-runtime"
    compose("up", "-d", "--no-deps", "console", timeout=90)
    ids = compose("ps", "-q", "console").stdout.splitlines()
    if len(ids) != 1 or not ids[0].strip():
        raise ProbeFailure("container-id")
    known_container = ids[0].strip()
    container_image_id = docker("inspect", "-f", "{{.Image}}", known_container).stdout.strip()
    if container_image_id != candidate_image_id:
        raise ProbeFailure("container-image-id-mismatch")
    proof["containerImageId"] = container_image_id
    proof["claims"]["runtimeMatchesCandidateImage"] = True
    ready = wait_ready(known_container)
    lock_file = admission / "service-gate.lock"
    host_identity = f"{lock_file.stat().st_dev}:{lock_file.stat().st_ino}"
    uid, cmdline, container_identity = admission_fd_identity(known_container)
    if uid != "10001" or "server.js" not in cmdline or container_identity != host_identity:
        raise ProbeFailure("pid1-admission-identity")
    proof["processSample"] = process_sample(known_container, host_identity)
    if not any(item.get("pid") == 1 and item.get("holdsAdmissionFd9") is True
               for item in proof["processSample"]["processes"]):
        raise ProbeFailure("pid1-missing-from-process-sample")
    proof["claims"]["runtimeProcessSampleAndDescendantLimitRecorded"] = True
    with lock_file.open("rb") as held:
        try:
            fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            raise ProbeFailure("exclusive-lock-not-blocked")
    proof["claims"]["serverPid1HoldsHostAdmissionLock"] = True

    stage = "negative-intent"
    default_entrypoint = ["/usr/local/lib/lares/maintenance-admission-v1", "/run/lares-maintenance/admission", identity, epoch, "--",
                          "/usr/local/bin/lares-console-start"]
    common = ["run", "--rm", "--network", "none", "--user", "10001:10001", "-v",
              f"{admission}:/run/lares-maintenance/admission:ro", "--entrypoint",
              "/usr/local/lib/lares/maintenance-admission-v1", IMAGE]
    for bad in ("00000000-0000-4000-8000-000000000000", identity):
        args = default_entrypoint.copy()
        args[2] = bad
        if bad == identity: args[3] = str(int(epoch) + 1)
        failed = docker(*common, *args[1:], check=False, timeout=10)
        if failed.returncode != 78 or "maintenance admission refused" not in failed.stdout:
            raise ProbeFailure("wrong-identity-refusal")
    intent = admission / "intent.json"
    normal = intent.read_bytes()
    for contents in (normal.replace(b'"state":"normal"', b'"state":"blocked"'), b"{malformed\n"):
        intent.chmod(0o644); intent.write_bytes(contents); intent.chmod(0o444)
        failed = docker(*common, *default_entrypoint[1:], check=False, timeout=10)
        if failed.returncode != 78 or "maintenance admission refused" not in failed.stdout:
            raise ProbeFailure("unsafe-intent-refusal")
    intent.chmod(0o644); intent.write_bytes(normal); intent.chmod(0o444)
    proof["claims"]["wrongUuidEpochAndBlockedMalformedIntentRefused"] = True

    stage = "missing-bind-source"
    missing_stack = stack_path.read_text(encoding="utf-8").replace(network_name, network_name + "-missing")
    write(missing_stack_path, missing_stack)
    write(missing_override_path, "services:\n  console:\n    image: " + IMAGE + "\n    volumes:\n"
          "      - type: bind\n        source: " + str(missing_path) + "\n"
          "        target: /run/lares-maintenance/admission\n        read_only: true\n"
          "        bind:\n          create_host_path: false\n")
    missing = docker("compose", "-p", project + "-missing", "-f", str(missing_stack_path),
                     "-f", str(missing_override_path), "up", "-d", "--no-deps", "console", check=False, timeout=20)
    if missing.returncode == 0 or missing_path.exists():
        raise ProbeFailure("missing-admission-bind")
    proof["claims"]["missingBindSourceRefusedWithoutCreation"] = True
    shutil.copytree(admission, missing_path, copy_function=shutil.copy2)
    missing_path.chmod(0o755)
    restored = docker("run", "--rm", "--network", "none", "--user", "10001:10001", "-v",
                      f"{missing_path}:/run/lares-maintenance/admission:ro", "--entrypoint",
                      "/usr/local/lib/lares/maintenance-admission-v1", IMAGE,
                      "/run/lares-maintenance/admission", identity, epoch, "--", "/bin/true", check=False, timeout=10)
    if restored.returncode != 0:
        raise ProbeFailure("restored-admission-source-control")
    proof["claims"]["restoredBindSourceAccepted"] = True

    stage = "restart-and-stop"
    compose("restart", "console", timeout=45)
    restart_image_id = docker("inspect", "-f", "{{.Image}}", known_container).stdout.strip()
    if restart_image_id != candidate_image_id:
        raise ProbeFailure("restart-image-id-mismatch")
    proof["restartContainerImageId"] = restart_image_id
    ready = wait_ready(known_container)
    uid, cmdline, container_identity = admission_fd_identity(known_container)
    if uid != "10001" or "server.js" not in cmdline or container_identity != host_identity:
        raise ProbeFailure("restart-lost-admission")
    proof["claims"]["restartRetainedAdmission"] = True
    compose("stop", "-t", "10", "console", timeout=20)
    with lock_file.open("rb") as released:
        fcntl.flock(released.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(released.fileno(), fcntl.LOCK_UN)
    proof["claims"]["exclusiveLockBlockedLiveAndAvailableAfterStop"] = True
    proof["status"] = "passed"
except ProbeFailure as error:
    proof["status"] = "failed"
    proof["failedStage"] = stage + ":" + str(error)
    raise SystemExit(1)
except Exception as error:
    proof["status"] = "failed"
    proof["failedStage"] = stage + ":unexpected-" + type(error).__name__
    raise
finally:
    cleanup_failed = False
    try:
        for cleanup_project, compose_file, override_file in (
                (project, stack_path, override_path),
                (project + "-missing", missing_stack_path, missing_override_path)):
            result = docker("compose", "-p", cleanup_project, "-f", str(compose_file), "-f", str(override_file),
                            "down", "--volumes", "--remove-orphans", check=False, timeout=30)
            if result.returncode != 0:
                raise ProbeFailure("compose-down-failed")
        for label in (project, project + "-missing"):
            for resource_type in ("ps", "network", "volume"):
                listing_args = (["ps", "-aq"] if resource_type == "ps"
                                else [resource_type, "ls", "-q"])
                resources = docker(*listing_args, "--filter", f"label=com.docker.compose.project={label}",
                                   check=False, timeout=15)
                if resources.returncode != 0 or resources.stdout.splitlines():
                    raise ProbeFailure("compose-resources-remain")
        shutil.rmtree(root, ignore_errors=False)
        if root.exists():
            raise ProbeFailure("fixture-directory-remains")
        proof["claims"]["cleanupOkay"] = True
    except Exception:
        cleanup_failed = True
        proof["claims"]["cleanupOkay"] = False
        proof["status"] = "failed"
        proof["failedStage"] = "cleanup"
    pathlib.Path(PROOF_PATH).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(PROOF_PATH).write_text(json.dumps(proof, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    if cleanup_failed:
        raise SystemExit(1)
