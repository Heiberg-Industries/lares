"""CI-only proof of the disposable external-HBA and cooperating lease primitives."""
from __future__ import annotations

import base64
import fcntl
import hashlib
import hmac
import importlib.util
import ipaddress
import json
import os
import pathlib
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid

if os.environ.get("CI") != "true":
    raise SystemExit("Maintenance fence image proof runs only in disposable CI")
if os.geteuid() != 0:
    raise SystemExit("Maintenance fence image proof requires the isolated CI root fixture")
if len(sys.argv) != 4:
    raise SystemExit("usage: maintenance-fence-image.probe.py <keeper-image> <source-sha> <proof.json>")

IMAGE, SOURCE_SHA, PROOF_PATH = sys.argv[1:]
REPO = pathlib.Path(__file__).resolve().parents[3]
PINNED_DB_IMAGE = "docker.io/pgvector/pgvector@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b"
if len(SOURCE_SHA) != 40 or any(char not in "0123456789abcdef" for char in SOURCE_SHA.lower()):
    raise SystemExit("Maintenance proof needs the checked-out source identity")

spec = importlib.util.spec_from_file_location(
    "maintenance_custody", REPO / "services/box/ops/maintenance-custody.py")
custody = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(custody)

root = pathlib.Path(tempfile.mkdtemp(prefix="lares-maintenance-proof-")).resolve()
root.chmod(0o755)
custody_dir = root / "custody"
admission_dir = root / "admission"
db_custody_dir = root / "database-custody"
db_admission_dir = root / "database-admission"
project = "lares-maintenance-" + uuid.uuid4().hex[:12]
network = project + "-network"
subnet = f"172.29.{secrets.randbelow(200) + 20}.0/24"
fixture_prefix = root / "installed-prefix"
fixture_prefix.mkdir(mode=0o755)
custody.prepare_fresh(fixture_prefix, subnet)
auth_dir = fixture_prefix / "var/lib/lares-maintenance/postgres-auth"
data_dir = root / "database-data"
secrets_dir = root / "compose-secrets"
marker_dir = root / "participant-markers"
for directory, mode in ((custody_dir, 0o700), (admission_dir, 0o755),
                        (db_custody_dir, 0o700), (db_admission_dir, 0o755),
                        (data_dir, 0o700), (secrets_dir, 0o755), (marker_dir, 0o755)):
    directory.mkdir(mode=mode)
    directory.chmod(mode)
marker_dir.chmod(0o777)  # contains only readiness markers written by disposable uid 10001 processes
os.chown(data_dir, 999, 999)

private_root = pathlib.Path(tempfile.mkdtemp(prefix="lares-maintenance-private-")).resolve()
private_root.chmod(0o700)
operator_path = private_root / "operator-password"
operator_password = secrets.token_urlsafe(32)
operator_path.write_text(operator_password + "\n", encoding="ascii")
operator_path.chmod(0o600)
app_password = secrets.token_urlsafe(32)
role_login_dir = private_root / "role-login-fixtures"
role_login_dir.mkdir(mode=0o700)
role_login_dir.chmod(0o700)
app_password_path: pathlib.Path
role_password_paths: dict[str, pathlib.Path] = {}

installation_id = str(uuid.uuid4())
epoch = 1
bootstrap_file = root / "bootstrap-compose.yml"
normal_file = root / "normal-compose.yml"
compose_files = ["-f", str(normal_file)]
bootstrap_files = ["-f", str(bootstrap_file)]
holder_names = [project + "-holder-a", project + "-holder-b"]
known_containers: list[str] = []
active_exclusive_fd: int | None = None
proof = {
    "format": 1,
    "sourceCommit": SOURCE_SHA,
    "databaseImage": PINNED_DB_IMAGE,
    "claims": {
        "actualRenderersUsed": False,
        "actualOperatorDbRunUsed": False,
        "externalHbaIsSelected": False,
        "normalPolicyAllowsOnlyIntendedRoles": False,
        "maintenanceHbaDeniesNewAppAndUnknownLogins": False,
        "existingAppSessionTerminatedExplicitly": False,
        "externalHbaSurvivesMaintenanceRestart": False,
        "operatorHostRouteMatchesApprovedRule": False,
        "missingExternalHbaRefusesStartup": False,
        "malformedExternalHbaRefusesStartup": False,
        "externalHbaSurvivesPermissivePgdataRestore": False,
        "twoCooperatingReadOnlyHoldersBlockExclusive": False,
        "durableEnteringDeniesNewAdmissionBeforeExclusive": False,
        "boundedIntentReadRefusesOversize": False,
        "scopeLimitedToExplicitParticipants": True,
    },
    "stages": {},
    "status": "running",
    "failedStage": None,
    "failureKind": None,
    "cleanupOkay": False,
}
stage = "fixture-setup"


class ProbeFailure(Exception):
    def __init__(self, kind: str = "assertion") -> None:
        self.kind = kind


def write_role_login_fixture(role: str, password: str) -> pathlib.Path:
    """Keep app-client credentials separate from root-only setup inputs."""
    path = role_login_dir / (role + "-password")
    path.write_text(password + "\n", encoding="ascii")
    os.chown(path, 10001, 10001)
    path.chmod(0o400)
    info = path.stat()
    if info.st_uid != 10001 or info.st_gid != 10001 or stat.S_IMODE(info.st_mode) != 0o400:
        raise ProbeFailure("credential-fixture")
    return path


def run(*args: str, check: bool = True, timeout: int = 60,
        input_data: str | bytes | None = None,
        env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(args, input=input_data, text=isinstance(input_data, str) or input_data is None,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                env=({**os.environ, **env} if env else None),
                                timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise ProbeFailure("timeout") from None
    if check and result.returncode != 0:
        raise ProbeFailure("command")
    return result


def docker(*args: str, check: bool = True, timeout: int = 60,
           input_data: str | bytes | None = None) -> subprocess.CompletedProcess:
    return run("docker", *args, check=check, timeout=timeout, input_data=input_data)


def compose(*args: str, bootstrap: bool = False, check: bool = True,
            timeout: int = 90) -> subprocess.CompletedProcess:
    return docker("compose", "-p", project, *(bootstrap_files if bootstrap else compose_files),
                  *args, check=check, timeout=timeout)


def engine_box(script: str, args: list[str], secret_files: list[pathlib.Path] = (),
               env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    mounts: list[str] = []
    for path in secret_files:
        mounts.extend(("--mount", f"type=bind,src={path},dst=/run/{path.name},readonly"))
    environment: list[str] = []
    for key, value in (env or {}).items():
        environment.extend(("--env", f"{key}={value}"))
    return docker("run", "--rm", "--network", "host", "--read-only", "--tmpfs", "/tmp",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", *mounts, *environment,
        "--workdir", "/app/services/box", "--entrypoint", "/app/services/keeper/node_modules/.bin/tsx",
        IMAGE, "/app/services/box/" + script, *args, check=False, timeout=120)


def write_hba(content: bytes) -> None:
    temporary = auth_dir / (".pg_hba-" + secrets.token_hex(8))
    temporary.write_bytes(content)
    temporary.chmod(0o644)
    os.replace(temporary, auth_dir / "pg_hba.conf")
    custody._sync_dir(auth_dir)


NORMAL_HBA = custody._normal_hba(subnet)
MAINTENANCE_HBA = (
    "# disposable fixture; exact offline operator only\n"
    "local all lares_operator scram-sha-256\n"
    f"host all lares_operator {subnet} scram-sha-256\n"
    "host replication all 0.0.0.0/0 reject\n"
    "host replication all ::/0 reject\n"
    "host all all 0.0.0.0/0 reject\n"
    "host all all ::/0 reject\n"
    "local all all reject\n"
).encode("ascii")


def generate_rendered_compose() -> None:
    source = {
        "secretsDir": str(secrets_dir), "socketDir": str(root / "socket"),
        "tasteDir": str(root / "taste"), "gatewayConfigFile": str(root / "gateway.yml"),
        "gatewayStartScript": str(root / "gateway-start.sh"), "caddyfile": str(root / "Caddyfile"),
        "caddyDataDir": str(root / "caddy-data"), "dbDataDir": str(data_dir),
        "databaseAuthDir": str(auth_dir),
        "network": network, "subnet": subnet, "domain": "proof.invalid",
        "consoleAllowedEmails": "owner@example.invalid", "ownerId": "proof-owner",
        "ownerHomeTz": "UTC", "modelAlias": "lares-brain", "pgDatabase": "lares_state",
    }
    for path in (root / "socket", root / "taste", root / "caddy-data"):
        path.mkdir(mode=0o755)
    for path in (root / "gateway.yml", root / "gateway-start.sh", root / "gateway-start.sh.admission_contract.py",
                 root / "gateway-start.sh.lares_gateway.py", root / "gateway.yml.profile.json", root / "Caddyfile"):
        path.write_text("fixture-only\n", encoding="ascii")
    for name in ("database-password", "console-session-secret", "eve-route-password", "gateway-key",
                 "gateway-master-key", "model-provider-key", "gateway-database-password", "token-enc-key"):
        (secrets_dir / name).write_text("fixture-only\n", encoding="ascii")
        (secrets_dir / name).chmod(0o600)
    release_path = REPO / "releases/2026-10-21-rc.12.json"
    release_in_container = "/release.json"
    docker_mounts = ["--mount", f"type=bind,src={root},dst={root}",
                     "--mount", f"type=bind,src={release_path},dst={release_in_container},readonly"]
    tsx = "/app/services/keeper/node_modules/.bin/tsx"
    common = ["run", "--rm", "--network", "none", *docker_mounts,
              "--workdir", "/app", "--entrypoint", tsx, IMAGE]
    python_check = docker("run", "--rm", "--network", "none", "--entrypoint", "python3", IMAGE,
                          "-c", "import sys; assert sys.version_info >= (3, 11)", check=False, timeout=20)
    if python_check.returncode != 0:
        raise ProbeFailure("image-runtime")
    bootstrap_args = [release_in_container, str(bootstrap_file), str(operator_path), str(data_dir),
                      network, subnet, str(auth_dir), str(fixture_prefix)]
    docker(*common, "/app/services/box/bin/render-database-bootstrap.ts", *bootstrap_args, timeout=45)
    installation_dir = root / "srv/lares/installation"
    stack_args = [release_in_container, str(normal_file), str(secrets_dir), str(root / "gateway.yml"),
                  str(root / "Caddyfile"), str(root / "caddy-data"), str(data_dir), network, subnet,
                  "proof.invalid", "lares_state", "lares-brain", "openai/gpt-4o-mini", str(root / "gateway-start.sh"),
                  "owner@example.invalid", str(root / "socket"), "proof-owner", "UTC", str(root / "taste"),
                  str(installation_dir), str(auth_dir), str(fixture_prefix)]
    docker(*common, "/app/services/box/bin/render-stack.ts", *stack_args, timeout=45)
    def assert_effective_auth(path: pathlib.Path) -> None:
        raw = path.read_text(encoding="utf-8")
        raw_auth_mount = re.search(
            r"- type: bind\n\s+source: " + re.escape(str(auth_dir)) +
            r"\n\s+target: /run/lares-auth\n\s+read_only: true\n\s+bind:\n\s+create_host_path: false(?:\n|$)",
            raw,
        )
        if raw_auth_mount is None:
            raise ProbeFailure("compose-source")
        effective = docker("compose", "-p", project, "-f", str(path), "config", "--format", "json", timeout=45)
        if effective.returncode != 0:
            raise ProbeFailure("compose-config")
        try:
            db = json.loads(effective.stdout)["services"]["db"]
        except (json.JSONDecodeError, KeyError, TypeError):
            raise ProbeFailure("compose-config") from None
        auth_mount = [mount for mount in db.get("volumes", [])
            if isinstance(mount, dict) and mount.get("target") == "/run/lares-auth"]
        bind_options = auth_mount[0].get("bind") if len(auth_mount) == 1 else None
        create_host_path_safe = isinstance(bind_options, dict) and (
            "create_host_path" not in bind_options or bind_options["create_host_path"] is False)
        if db.get("command") != ["postgres", "-c", "hba_file=/run/lares-auth/pg_hba.conf"] or \
           len(auth_mount) != 1 or auth_mount[0].get("source") != str(auth_dir) or \
           auth_mount[0].get("type") != "bind" or auth_mount[0].get("read_only") is not True or \
           not create_host_path_safe:
            raise ProbeFailure("compose-config")
    assert_effective_auth(bootstrap_file)
    assert_effective_auth(normal_file)
    # Supplemental simulations only: rewrite image references to approximate update/rollback
    # files and reuse the retained file for restore. These are not outputs from those scripts;
    # actual script-output acceptance lives in update/rollback/restore CI tests.
    original_stack = normal_file.read_text(encoding="utf-8")
    updated_stack = re.sub(r"(@sha256:)[a-f0-9]{64}", lambda match: match.group(1) + "b" * 64, original_stack)
    rollback_stack = re.sub(r"(@sha256:)[a-f0-9]{64}", lambda match: match.group(1) + "c" * 64, original_stack)
    for label, content in (("update-success", updated_stack), ("update-failure-restore", original_stack),
                           ("rollback", rollback_stack), ("restore-retained-file", original_stack)):
        scenario = root / ("simulated-image-variant-" + label + ".compose.yml")
        scenario.write_text(content, encoding="utf-8")
        assert_effective_auth(scenario)
        proof["stages"]["simulatedImageVariant-" + label + "EffectiveComposeAuth"] = True
    proof["claims"]["effectiveBootstrapAndNormalComposeAuthMatch"] = True
    proof["claims"]["simulatedImageReferenceVariantsRetainEffectiveComposeAuth"] = True

    # Both real renderer entry points must refuse a lexically redirected auth path before
    # touching output. This recreates the prefix/jump/../... class of mismatch at the CLI seam.
    redirect = fixture_prefix / "jump"
    target = fixture_prefix / "elsewhere/child"
    target.mkdir(parents=True)
    redirect.symlink_to(target, target_is_directory=True)
    redirected_auth = str(fixture_prefix / "jump/../var/lib/lares-maintenance/postgres-auth")
    rejected_bootstrap = root / "rejected-bootstrap.yml"
    bad_bootstrap_args = [*bootstrap_args]
    bad_bootstrap_args[1] = str(rejected_bootstrap)
    bad_bootstrap_args[6] = redirected_auth
    rejected = docker(*common, "/app/services/box/bin/render-database-bootstrap.ts", *bad_bootstrap_args,
                      check=False, timeout=45)
    if rejected.returncode == 0 or rejected_bootstrap.exists():
        raise ProbeFailure("renderer-path")
    rejected_stack = root / "rejected-stack.yml"
    bad_stack_args = [*stack_args]
    bad_stack_args[1] = str(rejected_stack)
    bad_stack_args[20] = redirected_auth
    rendered_gateway = (root / "gateway.yml").read_bytes()
    rendered_start = (root / "gateway-start.sh").read_bytes()
    rejected = docker(*common, "/app/services/box/bin/render-stack.ts", *bad_stack_args,
                      check=False, timeout=45)
    if rejected.returncode == 0 or rejected_stack.exists() or \
       (root / "gateway.yml").read_bytes() != rendered_gateway or \
       (root / "gateway-start.sh").read_bytes() != rendered_start:
        raise ProbeFailure("renderer-path")



def operator_call(compose_args: list[str], program: list[str], *, input_data: str | None = None,
                  check: bool = True, timeout: int = 60,
                  operator_timeout: int = 30) -> subprocess.CompletedProcess:
    compose_flags = " ".join("-f " + shlex.quote(compose_args[index + 1])
        for index in range(0, len(compose_args), 2) if compose_args[index] == "-f")
    command = " ".join(shlex.quote(value) for value in program)
    source = ". " + shlex.quote(str(REPO / "services/box/ops/engine-run.sh")) + "; operator_db_run -p " + \
        shlex.quote(project) + " " + compose_flags + " -- " + command
    # This is the actual host-side production helper. Password-bearing setup reaches psql over
    # stdin; only the protected file path is present in its environment.
    result = run("bash", "-ec", source, check=False, timeout=timeout, input_data=input_data,
                 env={"LARES_OPERATOR_PASSWORD_FILE": str(operator_path),
                      "OPERATOR_DB_TIMEOUT": str(operator_timeout)})
    if check and result.returncode != 0:
        raise ProbeFailure("operator-client")
    return result


def operator_query(compose_args: list[str], sql: str, *, check: bool = True) -> str:
    result = operator_call(compose_args, ["psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1",
                                         "-U", "lares_operator", "-d", "postgres", "-c", sql], check=check)
    return result.stdout.strip()


def operator_script(compose_args: list[str], script: str) -> subprocess.CompletedProcess:
    return operator_call(compose_args, ["psql", "-X", "-v", "ON_ERROR_STOP=1", "-U",
                                        "lares_operator", "-d", "postgres", "-f", "-"], input_data=script)


def wait_operator_ready(compose_args: list[str], budget_seconds: int = 90) -> None:
    deadline = time.monotonic() + budget_seconds
    while time.monotonic() < deadline:
        remaining = max(1, int(deadline - time.monotonic()))
        call_timeout = min(10, remaining)
        result = operator_call(compose_args, ["psql", "-X", "-A", "-t", "-q", "-v",
            "ON_ERROR_STOP=1", "-U", "lares_operator", "-d", "postgres", "-c", "SELECT 1"],
            check=False, timeout=call_timeout + 2, operator_timeout=max(1, call_timeout - 1))
        if result.returncode == 0 and result.stdout.strip() == "1":
            return
        time.sleep(min(0.5, max(0, deadline - time.monotonic())))
    raise ProbeFailure("database")


def scram_verifier(password: str) -> str:
    salt = secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 4096)
    client = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored = hashlib.sha256(client).digest()
    server = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    b64 = lambda value: base64.b64encode(value).decode("ascii")
    return "SCRAM-SHA-256$4096:" + b64(salt) + "$" + b64(stored) + ":" + b64(server)


def app_client(role: str, *, check: bool) -> subprocess.CompletedProcess:
    js = """const {Client}=require('pg');const fs=require('node:fs');
const c=new Client({host:'db',port:5432,database:'postgres',user:process.argv[1],password:fs.readFileSync('/run/app-password','utf8').trim(),connectionTimeoutMillis:4000});
c.connect().then(()=>c.query('SELECT 1')).then(r=>{if(r.rows[0]?.['?column?']!==1)process.exitCode=2;else process.stdout.write('connected');}).catch(()=>{process.exitCode=1;}).finally(()=>c.end().catch(()=>{}));"""
    password_path = role_password_paths.get(role, app_password_path)
    result = docker("run", "--rm", "--network", network, "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,mode=1777",
        "--user", "10001:10001", "--workdir", "/app/services/keeper",
        "--mount", f"type=bind,src={password_path},dst=/run/app-password,readonly",
        "--entrypoint", "node", IMAGE, "-e", js, role, check=check, timeout=20)
    return result


def wait_file(path: pathlib.Path, timeout: int = 20) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.is_file():
            return path.read_text(encoding="ascii").strip()
        time.sleep(0.1)
    raise ProbeFailure("timeout")


def test_admission_lifetime() -> None:
    custody.prepare(custody_dir, admission_dir, installation_id, epoch)
    oversized_custody = root / "oversized-custody"
    oversized_admission = root / "oversized-admission"
    oversized_custody.mkdir(mode=0o700)
    oversized_custody.chmod(0o700)
    oversized_admission.mkdir(mode=0o755)
    oversized_admission.chmod(0o755)
    custody.prepare(oversized_custody, oversized_admission, installation_id, epoch)
    oversized_intent = oversized_admission / "intent.json"
    oversized_intent.chmod(0o600)
    oversized_intent.write_bytes(b"x" * 257)
    oversized_intent.chmod(0o444)
    rejected = docker("run", "--rm", "--network", "none", "--user", "10001:10001",
        "--mount", f"type=bind,src={oversized_admission},dst=/proof/admission,readonly",
        "--entrypoint", "/bin/sh", IMAGE, "-ec",
        "/bin/sh /app/services/box/ops/maintenance-admission.sh /proof/admission " +
        installation_id + " 1 -- true", check=False)
    if rejected.returncode != 78:
        raise ProbeFailure()
    proof["claims"]["boundedIntentReadRefusesOversize"] = True
    ready_a = marker_dir / "holder-a-ready"
    ready_b = marker_dir / "holder-b-ready"
    for name, ready in zip(holder_names, (ready_a, ready_b)):
        command = ("exec /bin/sh /app/services/box/ops/maintenance-admission.sh /proof/admission " +
                   installation_id + " 1 -- sh -c 'touch /markers/" + ready.name + "; exec sleep 120'")
        # Register the exact generated name before Docker can create it, so an interrupted or
        # partially failing `run` still gives cleanup authority over only this fixture object.
        known_containers.append(name)
        docker("run", "--detach", "--rm", "--name", name, "--network", "none", "--user", "10001:10001",
               "--mount", f"type=bind,src={admission_dir},dst=/proof/admission,readonly",
               "--mount", f"type=bind,src={marker_dir},dst=/markers",
               "--entrypoint", "/bin/sh", IMAGE, "-ec", command)
        wait_file(ready)
    proof["claims"]["twoCooperatingReadOnlyHoldersBlockExclusive"] = True
    contender = docker("run", "--rm", "--network", "none", "--user", "10001:10001",
        "--mount", f"type=bind,src={admission_dir},dst=/proof/admission,readonly",
        "--entrypoint", "flock", IMAGE, "--exclusive", "--nonblock", "--conflict-exit-code", "75",
        "/proof/admission/service-gate.lock", "true", check=False)
    if contender.returncode != 75:
        raise ProbeFailure()
    custody.transition(custody_dir, admission_dir, installation_id, epoch, "entering")
    denied = docker("run", "--rm", "--network", "none", "--user", "10001:10001",
        "--mount", f"type=bind,src={admission_dir},dst=/proof/admission,readonly",
        "--entrypoint", "/bin/sh", IMAGE, "/app/services/box/ops/maintenance-admission.sh",
        "/proof/admission", installation_id, "1", "--", "true", check=False)
    if denied.returncode != 78:
        raise ProbeFailure()
    still_held = docker("run", "--rm", "--network", "none", "--user", "10001:10001",
        "--mount", f"type=bind,src={admission_dir},dst=/proof/admission,readonly",
        "--entrypoint", "flock", IMAGE, "--exclusive", "--nonblock", "--conflict-exit-code", "75",
        "/proof/admission/service-gate.lock", "true", check=False)
    if still_held.returncode != 75:
        raise ProbeFailure()
    proof["claims"]["durableEnteringDeniesNewAdmissionBeforeExclusive"] = True
    for name in holder_names:
        docker("rm", "--force", name)
        if name in known_containers:
            known_containers.remove(name)
    exclusive = docker("run", "--rm", "--network", "none", "--user", "10001:10001",
        "--mount", f"type=bind,src={admission_dir},dst=/proof/admission,readonly",
        "--entrypoint", "flock", IMAGE, "--exclusive", "--nonblock", "--conflict-exit-code", "75",
        "/proof/admission/service-gate.lock", "true", check=False)
    if exclusive.returncode != 0:
        raise ProbeFailure()
    custody.transition(custody_dir, admission_dir, installation_id, epoch, "blocked")
    proof["stages"]["cooperatingAdmission"] = True


def start_holder_session() -> tuple[str, pathlib.Path]:
    control = root / "session-control"
    control.mkdir(mode=0o777)
    control.chmod(0o777)
    script = root / "session-client.cjs"
    script.write_text("""const {Client}=require('pg'),fs=require('node:fs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{const c=new Client({host:'db',port:5432,database:'postgres',user:'lares_app',password:fs.readFileSync('/run/app-password','utf8').trim(),connectionTimeoutMillis:4000});
let expectedWindow=false, idleError=false, unexpectedError=false;
c.on('error',()=>{if(expectedWindow)idleError=true;else unexpectedError=true;});
await c.connect();const r=await c.query('SELECT pg_backend_pid() AS pid');fs.writeFileSync('/control/ready',String(r.rows[0].pid));
while(!fs.existsSync('/control/query'))await sleep(50);await c.query('SELECT 1');fs.writeFileSync('/control/still-works','ok');
while(!fs.existsSync('/control/expect-termination'))await sleep(50);expectedWindow=true;fs.writeFileSync('/control/armed','ok');
while(!fs.existsSync('/control/query-terminated'))await sleep(50);
let queryFailed=false;try{await c.query('SELECT 1');}catch{queryFailed=true;}
if(queryFailed&&idleError&&!unexpectedError)fs.writeFileSync('/control/terminated','ok');else process.exitCode=2;
await c.end().catch(()=>{});
})().catch(()=>{process.exitCode=2});""", encoding="utf-8")
    name = project + "-app-session"
    # As above, record the only name this probe is authorized to clean before container create.
    known_containers.append(name)
    docker("run", "--detach", "--rm", "--name", name, "--network", network, "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,mode=1777", "--user", "10001:10001",
        "--workdir", "/app/services/keeper",
        "--mount", f"type=bind,src={app_password_path},dst=/run/app-password,readonly",
        "--mount", f"type=bind,src={script},dst=/app/services/keeper/session-client.cjs,readonly",
        "--mount", f"type=bind,src={control},dst=/control",
        "--entrypoint", "node", IMAGE, "/app/services/keeper/session-client.cjs")
    return name, control


def run_database_proof() -> None:
    global stage, app_password_path, role_password_paths
    stage = "release-identity"
    release = json.loads((REPO / "releases/2026-10-21-rc.12.json").read_text(encoding="utf-8"))
    if release.get("images", {}).get("db") != PINNED_DB_IMAGE:
        raise ProbeFailure()
    creative_image = release.get("images", {}).get("creative", "")
    if not re.fullmatch(r"[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}", creative_image):
        raise ProbeFailure("workflow-image")
    credentials = {"operator-password": operator_password, "database-password": app_password,
        "financial-database-password": secrets.token_urlsafe(40),
        "workflow-provisioner-password": secrets.token_urlsafe(40),
        "workflow-password": secrets.token_urlsafe(40), "gateway-database-password": secrets.token_urlsafe(40)}
    credential_files: dict[str, pathlib.Path] = {}
    for name, value in credentials.items():
        path = private_root / name
        path.write_text(value + "\n", encoding="ascii")
        path.chmod(0o600)
        credential_files[name] = path
    role_password_paths = {
        "lares_app": write_role_login_fixture("lares_app", credentials["database-password"]),
        "lares_financial": write_role_login_fixture("lares_financial", credentials["financial-database-password"]),
        "lares_workflow_provisioner": write_role_login_fixture("lares_workflow_provisioner", credentials["workflow-provisioner-password"]),
        "lares_workflow": write_role_login_fixture("lares_workflow", credentials["workflow-password"]),
        "lares_gateway": write_role_login_fixture("lares_gateway", credentials["gateway-database-password"]),
    }
    app_password_path = role_password_paths["lares_app"]
    setup_files = list(credential_files.values())

    # Verify the exact pinned runtime image's declared user can read its own disposable
    # provisioner fixture before any database container is started.
    stage = "workflow-image-credential-readability"
    workflow_image_probe = docker("run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--mount", f"type=bind,src={role_password_paths['lares_workflow_provisioner']},dst=/run/workflow-provisioner-password,readonly",
        "--workdir", "/app/services/creative", "--entrypoint", "/bin/sh", creative_image, "-ec",
        'test "$(id -u)" = 10001 && test "$(id -g)" = 10001 && test -r /run/workflow-provisioner-password && test -n "$(cat /run/workflow-provisioner-password)"',
        timeout=60)
    if workflow_image_probe.returncode != 0:
        raise ProbeFailure("workflow-image-credential-readability")
    proof["stages"]["pinnedWorkflowImageCredentialReadableAsDefaultUid"] = True

    stage = "renderer"
    generate_rendered_compose()
    proof["claims"]["actualRenderersUsed"] = True
    proof["stages"]["renderers"] = True
    stage = "bootstrap-start"
    compose("up", "-d", "db", bootstrap=True, timeout=180)
    proof["stages"]["bootstrapStarted"] = True
    stage = "bootstrap-operator-login"
    wait_operator_ready(bootstrap_files, budget_seconds=90)
    proof["claims"]["actualOperatorDbRunUsed"] = True
    proof["stages"]["bootstrapOperatorAuthentication"] = True
    stage = "production-database-setup"
    setup_args = [
        "--operator-password-file", "/run/operator-password",
        "--app-password-file", "/run/database-password",
        "--financial-password-file", "/run/financial-database-password",
        "--workflow-provisioner-password-file", "/run/workflow-provisioner-password",
        "--workflow-password-file", "/run/workflow-password",
        "--gateway-password-file", "/run/gateway-database-password",
    ]
    setup = engine_box("bin/database-setup.ts", setup_args, setup_files, {"PGHOST": "127.0.0.1", "PGPORT": "5432"})
    if setup.returncode != 0:
        raise ProbeFailure("database-setup")
    proof["claims"]["productionDatabaseSetupUsed"] = True
    proof["stages"]["productionDatabaseSetup"] = True
    stage = "replace-bootstrap-with-normal-stack"
    compose("down", bootstrap=True, timeout=90)
    compose("up", "-d", "db", timeout=180)
    wait_operator_ready(compose_files, budget_seconds=90)
    proof["stages"]["normalDatabaseStarted"] = True
    stage = "production-workflow-template-setup"
    workflow_script = 'PGPASSWORD="$(cat /run/workflow-provisioner-password)"; export PGPASSWORD; exec node --input-type=module -e "$1"'
    workflow_program = (
        'import { Pool } from "pg"; import { setupDatabase } from "@workflow/world-postgres/cli"; '
        'const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 1 }); '
        'try { const r = await pool.query("SELECT current_user, session_user, current_database()"); '
        'if (r.rows[0]?.current_user !== "lares_workflow_owner" || r.rows[0]?.session_user !== "lares_workflow_provisioner" || '
        'r.rows[0]?.current_database !== "empty_workflow") throw new Error("workflow template authority check failed"); } '
        'finally { await pool.end(); } await setupDatabase();'
    )
    workflow_setup = docker("run", "--rm", "--network", "host", "--read-only", "--tmpfs", "/tmp",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "10001:10001",
        "--workdir", "/app/services/creative",
        "--mount", f"type=bind,src={role_password_paths['lares_workflow_provisioner']},dst=/run/workflow-provisioner-password,readonly",
        "--env", "PGPASSWORD_FILE=/run/workflow-provisioner-password", "--env", "PGOPTIONS=-c role=lares_workflow_owner",
        "--env", "WORKFLOW_POSTGRES_URL=postgres://lares_workflow_provisioner@127.0.0.1:5432/empty_workflow",
        "--entrypoint", "/bin/sh", creative_image, "-ec", workflow_script, "workflow", workflow_program,
        check=False, timeout=180)
    if workflow_setup.returncode != 0:
        raise ProbeFailure("workflow-template-setup")
    workflow_apply = engine_box("bin/workflow-template.ts", ["apply", "--host", "127.0.0.1", "--port", "5432",
        "--provisioner-password-file", "/run/workflow-provisioner-password",
        "--runtime-password-file", "/run/workflow-password"], setup_files, {"PGHOST": "127.0.0.1", "PGPORT": "5432"})
    workflow_finalize = engine_box("bin/database-setup.ts", ["--finalize-workflow-template",
        "--operator-password-file", "/run/operator-password",
        "--workflow-password-file", "/run/workflow-password"], setup_files, {"PGHOST": "127.0.0.1", "PGPORT": "5432"})
    if workflow_apply.returncode != 0 or workflow_finalize.returncode != 0:
        raise ProbeFailure("workflow-template-setup")
    proof["claims"]["productionWorkflowTemplatePathUsed"] = True
    proof["stages"]["productionWorkflowTemplatePath"] = True
    stage = "normal-container-secret-boundary"
    database_container = compose("ps", "-q", "db").stdout.strip()
    if not re.fullmatch(r"[a-f0-9]{12,64}", database_container):
        raise ProbeFailure("database")
    mounts = docker("inspect", "--format", "{{json .Mounts}}", database_container)
    env = docker("inspect", "--format", "{{json .Config.Env}}", database_container)
    try:
        mount_rows, env_rows = json.loads(mounts.stdout), json.loads(env.stdout)
    except json.JSONDecodeError:
        raise ProbeFailure("database") from None
    auth_mount = [item for item in mount_rows if item.get("Destination") == "/run/lares-auth"]
    if len(auth_mount) != 1 or auth_mount[0].get("Source") != str(auth_dir) or auth_mount[0].get("RW") is not False:
        raise ProbeFailure("database")
    if any(item.get("Source") == str(operator_path) for item in mount_rows) or any(
        item.split("=", 1)[0] == "POSTGRES_PASSWORD_FILE" for item in env_rows):
        raise ProbeFailure()
    proof["stages"]["normalContainerHasNoOperatorSecret"] = True
    stage = "external-hba-selected"
    selected = operator_query(compose_files,
        "SELECT current_setting('hba_file') || '|' || count(*)::text FROM pg_hba_file_rules WHERE error IS NOT NULL")
    if selected != "/run/lares-auth/pg_hba.conf|0":
        raise ProbeFailure("database")
    proof["claims"]["externalHbaIsSelected"] = True
    stage = "operator-host-route"
    source_address = operator_query(compose_files, "SELECT host(inet_client_addr())")
    try:
        parsed_source = ipaddress.ip_address(source_address)
        approved_network = ipaddress.ip_network(subnet)
    except ValueError:
        raise ProbeFailure("database") from None
    if not (parsed_source.is_loopback or parsed_source in approved_network):
        raise ProbeFailure("operator-client")
    proof["claims"]["operatorHostRouteMatchesApprovedRule"] = True
    stage = "normal-role-controls"
    intended = ("lares_app", "lares_financial", "lares_workflow_provisioner", "lares_workflow", "lares_gateway")
    operator_script(compose_files, "CREATE ROLE proof_unknown LOGIN PASSWORD '" + scram_verifier(app_password) + "';\n")
    if any(app_client(role, check=True).stdout.strip() != "connected" for role in intended):
        raise ProbeFailure("database")
    if app_client("proof_unknown", check=False).returncode == 0:
        raise ProbeFailure("database")
    proof["claims"]["normalPolicyAllowsOnlyIntendedRoles"] = True
    proof["stages"]["normalLoginControl"] = True

    stage = "existing-app-session"
    session_name, session_control = start_holder_session()
    backend_pid = wait_file(session_control / "ready")
    if not backend_pid.isdigit():
        raise ProbeFailure("database")
    custody.prepare(db_custody_dir, db_admission_dir, installation_id, epoch)
    custody.transition(db_custody_dir, db_admission_dir, installation_id, epoch, "entering")
    global active_exclusive_fd
    active_exclusive_fd = os.open(db_admission_dir / "service-gate.lock", os.O_RDONLY)
    fcntl.flock(active_exclusive_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    stage = "maintenance-hba-reload"
    write_hba(MAINTENANCE_HBA)
    if operator_query(compose_files, "SELECT pg_reload_conf()") != "t" or \
       operator_query(compose_files, "SELECT count(*)::text FROM pg_hba_file_rules WHERE error IS NOT NULL") != "0":
        raise ProbeFailure("database")
    proof["stages"]["maintenanceReloadParsed"] = True
    stage = "maintenance-reload-preserves-session"
    (session_control / "query").write_text("go\n", encoding="ascii")
    if wait_file(session_control / "still-works") != "ok":
        raise ProbeFailure("database")
    if any(app_client(role, check=False).returncode == 0 for role in (*intended, "proof_unknown")):
        raise ProbeFailure("database")
    if operator_query(compose_files, "SELECT current_user") != "lares_operator":
        raise ProbeFailure("database")
    proof["stages"]["existingSessionSurvivesReloadAndNewLoginsRefuse"] = True
    stage = "terminate-existing-session"
    (session_control / "expect-termination").write_text("go\n", encoding="ascii")
    if wait_file(session_control / "armed") != "ok" or \
       operator_query(compose_files, "SELECT pg_terminate_backend(" + backend_pid + ")") != "t":
        raise ProbeFailure("database")
    (session_control / "query-terminated").write_text("go\n", encoding="ascii")
    if wait_file(session_control / "terminated") != "ok":
        raise ProbeFailure("database")
    proof["claims"]["existingAppSessionTerminatedExplicitly"] = True
    proof["stages"]["existingSessionTerminated"] = True
    for _ in range(40):
        state = docker("inspect", "--format", "{{.State.Running}}", session_name, check=False)
        if state.returncode != 0:
            known_containers.remove(session_name)
            break
        if state.stdout.strip() == "false":
            docker("rm", "--force", session_name, check=False)
            if docker("inspect", session_name, check=False).returncode != 0:
                known_containers.remove(session_name)
            break
        time.sleep(0.1)

    stage = "maintenance-hba-restart"
    compose("restart", "db", timeout=120)
    wait_operator_ready(compose_files, budget_seconds=60)
    if operator_query(compose_files, "SELECT current_setting('hba_file')") != "/run/lares-auth/pg_hba.conf" or \
       any(app_client(role, check=False).returncode == 0 for role in (*intended, "proof_unknown")):
        raise ProbeFailure("database")
    proof["claims"]["maintenanceHbaDeniesNewAppAndUnknownLogins"] = True
    proof["claims"]["externalHbaSurvivesMaintenanceRestart"] = True
    proof["stages"]["maintenanceHbaRestart"] = True
    write_hba(NORMAL_HBA)
    custody._sync_dir(auth_dir)
    active_exclusive_fd = None

    def failed_auth_restart(content: bytes | None, claim: str, label: str, expected_error: re.Pattern[str]) -> None:
        compose("stop", "db", timeout=45)
        compose("rm", "--force", "db", timeout=45)
        hba = auth_dir / "pg_hba.conf"
        saved = auth_dir / "pg_hba.saved"
        os.replace(hba, saved)
        if content is not None:
            write_hba(content)
        try:
            created = compose("create", "db", timeout=90, check=False)
            container = compose("ps", "--all", "-q", "db", check=False).stdout.strip()
            if created.returncode != 0 or not re.fullmatch(r"[a-f0-9]{12,64}", container):
                raise ProbeFailure("database")
            # The production service restarts automatically. Disable that policy on this
            # disposable container before starting it so its first failure remains inspectable.
            docker("update", "--restart=no", container)
            started = docker("start", container, check=False, timeout=30)
            deadline = time.monotonic() + 12
            expected_refusal = False
            while time.monotonic() < deadline:
                inspected = docker("inspect", "--format", "{{.State.Status}}|{{.State.ExitCode}}|{{.State.Error}}", container, check=False)
                if inspected.returncode != 0:
                    raise ProbeFailure("database")
                fields = inspected.stdout.strip().split("|", 2)
                state = fields[0]
                exit_code = fields[1] if len(fields) > 1 else ""
                logs = docker("logs", "--tail", "100", container, check=False).stdout
                if state == "exited":
                    if exit_code.isdigit() and int(exit_code) != 0 and expected_error.search(logs):
                        expected_refusal = True
                        break
                    raise ProbeFailure("database")
                if state not in ("created", "running"):
                    raise ProbeFailure("database")
                time.sleep(0.25)
            if not expected_refusal:
                raise ProbeFailure("timeout")
            if started.returncode != 0 and not expected_error.search(started.stdout):
                raise ProbeFailure("database")
            proof["claims"][claim] = True
            return
        finally:
            current = auth_dir / "pg_hba.conf"
            if current.exists():
                current.unlink()
            os.replace(saved, current)
            custody._sync_dir(auth_dir)
            compose("up", "-d", "db", timeout=90)
            wait_operator_ready(compose_files, budget_seconds=60)

    stage = "missing-external-hba"
    failed_auth_restart(None, "missingExternalHbaRefusesStartup", "missing-auth", re.compile(r"could not open file .*/run/lares-auth/pg_hba\.conf", re.IGNORECASE))
    stage = "malformed-external-hba"
    failed_auth_restart(b"this is not a PostgreSQL HBA rule\n", "malformedExternalHbaRefusesStartup", "malformed-auth", re.compile(r"invalid authentication method|invalid connection type|syntax error in file", re.IGNORECASE))
    stage = "missing-external-auth-directory"
    compose("stop", "db", timeout=45)
    compose("rm", "--force", "db", timeout=45)
    saved_auth_dir = auth_dir.with_name("postgres-auth.saved")
    os.replace(auth_dir, saved_auth_dir)
    try:
        failed = compose("create", "db", timeout=60, check=False)
        if failed.returncode == 0 or str(auth_dir) not in failed.stdout or auth_dir.exists():
            raise ProbeFailure("database")
        if compose("ps", "--all", "-q", "db", check=False).stdout.strip():
            raise ProbeFailure("database")
        proof["claims"]["missingExternalAuthDirectoryRefusesComposeCreate"] = True
    finally:
        os.replace(saved_auth_dir, auth_dir)
        compose("up", "-d", "db", timeout=90)
        wait_operator_ready(compose_files, budget_seconds=60)
    stage = "permissive-pgdata-restore"
    # Model a restored PGDATA carrying a permissive in-data policy; the production mount must
    # remain authoritative across restart and normal PGDATA replacement.
    pgdata_hba = data_dir / "pg_hba.conf"
    if not pgdata_hba.is_file():
        raise ProbeFailure("database")
    pgdata_hba.write_text("host all all 0.0.0.0/0 trust\n", encoding="ascii")
    pgdata_hba.chmod(0o644)
    compose("restart", "db", timeout=120)
    wait_operator_ready(compose_files, budget_seconds=60)
    if operator_query(compose_files, "SELECT current_setting('hba_file')") != "/run/lares-auth/pg_hba.conf":
        raise ProbeFailure("database")
    if any(app_client(role, check=True).returncode != 0 for role in intended) or \
       app_client("proof_unknown", check=False).returncode == 0:
        raise ProbeFailure("database")
    proof["claims"]["externalHbaSurvivesPermissivePgdataRestore"] = True
    proof["stages"]["restartPreservesExternalPolicy"] = True


def cleanup() -> bool:
    okay = True
    for name in list(reversed(known_containers)):
        try:
            if docker("rm", "--force", name, check=False, timeout=20).returncode != 0:
                okay = False
        except Exception:
            okay = False
    if bootstrap_file.exists() or normal_file.exists():
        try:
            result = compose("down", "--remove-orphans", check=False, timeout=45)
            okay = okay and result.returncode == 0
            result = compose("down", "--remove-orphans", bootstrap=True, check=False, timeout=45)
            okay = okay and result.returncode == 0
        except Exception:
            okay = False
    for directory in (root, private_root):
        try:
            shutil.rmtree(directory)
        except FileNotFoundError:
            pass
        except Exception:
            okay = False
    return okay


def publish_result(exit_code: int) -> int:
    """Always record the sanitized outcome, including when fixture cleanup fails."""
    proof["cleanupOkay"] = cleanup()
    if not proof["cleanupOkay"]:
        proof["status"] = "failed"
        proof["failedStage"] = proof["failedStage"] or "cleanup"
        proof["failureKind"] = proof["failureKind"] or "cleanup"
        exit_code = 1
    output_path = pathlib.Path(PROOF_PATH)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(proof, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    output_path.chmod(0o644)
    return exit_code


exit_code = 0
try:
    stage = "admission-lifetime"
    test_admission_lifetime()
    stage = "external-auth-render"
    run_database_proof()
    proof["status"] = "passed"
except ProbeFailure as error:
    exit_code = 1
    proof["status"] = "failed"
    proof["failedStage"] = stage
    proof["failureKind"] = error.kind
except Exception:
    exit_code = 1
    proof["status"] = "failed"
    proof["failedStage"] = stage
    proof["failureKind"] = "unexpected"
finally:
    exit_code = publish_result(exit_code)
sys.exit(exit_code)
