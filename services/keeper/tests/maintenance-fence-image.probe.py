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
import signal
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
        "keeperGeneratedComposeUsesBakedAdmissionEntryPoint": False,
        "keeperMainProcessRetainsSharedLeaseAfterComposeReturns": False,
        "updateHistoryClientRetainsIndependentAdmissionLease": False,
        "updateHistoryClientLeaseSurvivesCallerExit": False,
        "updateHistoryClientOwnedContainerCleanupVerified": False,
        "migrationClientRetainsIndependentAdmissionLease": False,
        "migrationClientLeaseSurvivesCallerExit": False,
        "migrationClientOwnedContainerCleanupVerified": False,
        "keeperCommandOverrideReceivesRestoredWorkingDirectory": False,
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
    "candidateKeeperImageConfigId": None,
    "clientLeaseDiagnostics": {},
}
stage = "fixture-setup"


class ProbeFailure(Exception):
    def __init__(self, kind: str = "assertion") -> None:
        self.kind = kind


def parse_update_client_intent(contents: str) -> tuple[str, str] | None:
    """Accept only the fixed name/token/operation record written before docker create."""
    if len(contents) > 128:
        return None
    lines = contents.splitlines()
    if (len(lines) != 3 or lines[2] != "update" or
            not re.fullmatch(r"[a-f0-9]{32}", lines[1]) or
            lines[0] != "lares-update-client-" + lines[1]):
        return None
    return lines[0], lines[1]


def update_client_info_matches(info: dict[str, object], container_id: str,
                               name: str, owner: str, operation: str) -> bool:
    labels = info.get("Config", {}).get("Labels", {})  # type: ignore[union-attr]
    return (re.fullmatch(r"[a-f0-9]{64}", container_id) is not None and
            info.get("Id") == container_id and info.get("Name") == "/" + name and
            labels.get("com.lares.maintenance.owner") == owner and
            labels.get("com.lares.maintenance.operation") == operation)


def run_cleanup_actions(actions: list[object]) -> bool:
    """Run every bounded cleanup action, even if an earlier action raises or fails."""
    okay = True
    for action in actions:
        try:
            if not action():  # type: ignore[operator]
                okay = False
        except Exception:
            okay = False
    return okay


UPDATE_CLIENT_FD9_INSPECT = r"""import os,re,stat,sys
proc=sys.argv[4] if len(sys.argv)>4 else '/proc'
expected_dev,expected_ino=int(sys.argv[1]),int(sys.argv[2])
info=os.stat(proc+'/1/fd/9')
assert stat.S_ISREG(info.st_mode) and (info.st_dev,info.st_ino)==(expected_dev,expected_ino)
assert os.path.basename(os.readlink(proc+'/1/exe'))=='node'
expected_script=sys.argv[3].encode('ascii')
lines=open(proc+'/1/fdinfo/9',encoding='ascii').read().splitlines()
flags=[line.split(':',1)[1].strip() for line in lines if line.startswith('flags:')]
inos=[line.split(':',1)[1].strip() for line in lines if line.startswith('ino:')]
locks=[line for line in lines if line.startswith('lock:')]
assert len(flags)==1 and re.fullmatch(r'[0-7]+',flags[0],re.ASCII)
assert int(flags[0],8)&os.O_ACCMODE==os.O_RDONLY
assert len(inos)==1 and re.fullmatch(r'[0-9]+',inos[0],re.ASCII) and int(inos[0])==expected_ino
pattern=r'lock:[ \t]+[0-9]+:[ \t]+FLOCK[ \t]+ADVISORY[ \t]+READ[ \t]+[0-9]+[ \t]+([0-9a-f]+):([0-9a-f]+):([0-9]+)[ \t]+0[ \t]+EOF'
match=re.fullmatch(pattern,locks[0],re.ASCII) if len(locks)==1 else None
assert match and match.groups()==(format(os.major(expected_dev),'02x'),format(os.minor(expected_dev),'02x'),str(expected_ino))
assert expected_script in open(proc+'/1/cmdline','rb').read().split(b'\0')
print('ok')"""


def stop_and_reap_process(process: subprocess.Popen | None) -> bool:
    """Kill a remaining fixture process and always wait with a finite bound."""
    if process is None:
        return True
    okay = True
    try:
        if process.poll() is not None:
            return True
    except Exception:
        okay = False
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except Exception:
        okay = False
    try:
        process.wait(timeout=5)
    except Exception:
        okay = False
    return okay


def finish_update_client_cleanup(actions: list[object], blocker_cli: subprocess.Popen | None,
                                 proof_record: dict[str, object], prior_ok: bool = True) -> bool:
    """Publish the client cleanup marker only after all cleanup actions finish."""
    actions.append(lambda: stop_and_reap_process(blocker_cli))
    actions_ok = run_cleanup_actions(actions)
    okay = prior_ok and actions_ok
    proof_record["stages"]["updateClientCleanupVerified"] = okay  # type: ignore[index]
    return okay


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


def candidate_image_config_id(image_ref: str) -> str:
    """Resolve this CI-loaded candidate tag to its immutable local config ID."""
    result = docker("image", "inspect", "--format", "{{.Id}}", image_ref,
                    check=False, timeout=20)
    image_id = result.stdout.strip()
    if result.returncode != 0 or not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
        raise ProbeFailure("keeper-candidate-image")
    return image_id


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
    for path in (root / "gateway.yml", root / "gateway-start.sh", root / "gateway-start.sh.gateway_admission.py", root / "gateway-start.sh.admission_contract.py",
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
    rendered_guard = (root / "gateway-start.sh.gateway_admission.py").read_bytes()
    rejected = docker(*common, "/app/services/box/bin/render-stack.ts", *bad_stack_args,
                      check=False, timeout=45)
    if rejected.returncode == 0 or rejected_stack.exists() or \
       (root / "gateway.yml").read_bytes() != rendered_gateway or \
       (root / "gateway-start.sh").read_bytes() != rendered_start or \
       (root / "gateway-start.sh.gateway_admission.py").read_bytes() != rendered_guard:
        raise ProbeFailure("renderer-path")
    proof["claims"]["bothActualRenderersRejectRedirectedAuthWithoutOutputChanges"] = True


def prove_keeper_default_admission() -> None:
    """Exercise the committed Keeper Compose entrypoint with the image's baked guard.

    The real Keeper `serve` command is left as the generated default. This checks its actual
    container admission and main-process lease after detached Compose returns; it does not
    claim descendant/child-container inheritance or production quiescence.
    """
    keeper_root = fixture_prefix / "srv/lares"
    keeper_root.mkdir(parents=True, exist_ok=True, mode=0o755)
    agents_dir = keeper_root / "agents"
    retired_dir = keeper_root / "retired"
    backup_dir = keeper_root / "backup"
    egress_dir = keeper_root / "egress"
    for directory in (agents_dir, retired_dir, backup_dir, egress_dir,
                      fixture_prefix / "run/lares", fixture_prefix / "run/lares-host",
                      fixture_prefix / "etc/lares"):
        directory.mkdir(parents=True, exist_ok=True, mode=0o755)
    (egress_dir / "squid.conf").write_text("http_port 3128\nhttp_access deny all\n", encoding="ascii")

    # The actual renderer needs the same files Compose will mount. Credentials are disposable
    # fixture values provisioned for this isolated database proof.
    for name in ("database-password", "financial-database-password", "workflow-provisioner-password",
                 "workflow-password", "gateway-database-password"):
        source = private_root / name
        if source.exists():
            value = source.read_bytes()
        elif name == "gateway-database-password":
            value = (private_root / "gateway-database-password").read_bytes()
        else:
            value = (secrets.token_urlsafe(32) + "\n").encode("ascii")
        destination = secrets_dir / name
        destination.write_bytes(value)
        destination.chmod(0o600)
    for name in ("gateway-master-key", "eve-route-password", "console-vault-signing-key"):
        destination = secrets_dir / name
        destination.write_text(secrets.token_urlsafe(32) + "\n", encoding="ascii")
        destination.chmod(0o600)

    release_path = REPO / "releases/2026-10-21-rc.12.json"
    release_in_container = "/release.json"
    keeper_config = fixture_prefix / "etc/lares/keeper.json"
    keeper_env = fixture_prefix / "etc/lares/keeper.env"
    renderer_args = [
        release_in_container, str(keeper_config), str(keeper_env), str(keeper_config),
        project, str(keeper_root), str(agents_dir), str(retired_dir), str(backup_dir),
        str(egress_dir), str(secrets_dir), str(fixture_prefix / "run/lares"),
        str(fixture_prefix / "run/lares-host"), network, subnet,
        str(ipaddress.ip_network(subnet).network_address + 2),
        "http://gateway.invalid", "lares_state", "proof-owner", "owner@example.invalid",
        "proof.invalid", "UTC", str(fixture_prefix),
    ]
    render = docker("run", "--rm", "--network", "none",
        "--mount", f"type=bind,src={root},dst={root}",
        "--mount", f"type=bind,src={release_path},dst={release_in_container},readonly",
        "--workdir", "/app", "--entrypoint", "/app/services/keeper/node_modules/.bin/tsx",
        IMAGE, "/app/services/box/bin/render-keeper-config.ts", *renderer_args,
        check=False, timeout=60)
    if render.returncode != 0 or not keeper_config.is_file() or not keeper_env.is_file():
        raise ProbeFailure("keeper-render")

    compose_file = REPO / "services/box/compose.lares-keeper.yaml"
    compose_args = ["compose", "-p", project, "-f", str(compose_file), "--env-file", str(keeper_env)]
    local_image_env = {"LARES_KEEPER_IMAGE": IMAGE}
    image_config_result = docker("image", "inspect", "--format", "{{json .Config}}", IMAGE)
    try:
        image_config = json.loads(image_config_result.stdout)
    except json.JSONDecodeError:
        raise ProbeFailure("keeper-image-config") from None
    expected_image_entrypoint = ["/usr/local/lib/lares/maintenance-admission-v1"]
    expected_command = ["/app/services/keeper/node_modules/.bin/tsx",
        "/app/services/keeper/bin/keeper.ts", "serve"]
    if image_config.get("Entrypoint") != expected_image_entrypoint or \
       image_config.get("Cmd") != expected_command or image_config.get("Healthcheck") is not None:
        raise ProbeFailure("keeper-image-config")
    proof["claims"]["keeperImageConfigMatchesGuardedCommandAndHasNoHealthcheck"] = True
    effective = run("docker", *compose_args, "config", "--format", "json", check=False, timeout=45,
                    env=local_image_env)
    if effective.returncode != 0:
        raise ProbeFailure("keeper-compose-config")
    try:
        service = json.loads(effective.stdout)["services"]["lares-keeper"]
    except (json.JSONDecodeError, KeyError, TypeError):
        raise ProbeFailure("keeper-compose-config") from None
    identity = custody.validate(fixture_prefix, subnet)
    expected_entrypoint = ["/usr/local/lib/lares/maintenance-admission-v1",
        "/run/lares-maintenance/admission", identity["installationId"], str(identity["epoch"]), "--"]
    admission_mounts = [mount for mount in service.get("volumes", [])
        if isinstance(mount, dict) and mount.get("target") == "/run/lares-maintenance/admission"]
    if service.get("entrypoint") != expected_entrypoint or service.get("command") != expected_command or \
       len(admission_mounts) != 1 or admission_mounts[0].get("type") != "bind" or \
       admission_mounts[0].get("source") != str(fixture_prefix / "var/lib/lares-maintenance/admission") or \
       admission_mounts[0].get("read_only") is not True or any(
           mount.get("target") == "/usr/local/lib/lares/maintenance-admission-v1"
           for mount in service.get("volumes", []) if isinstance(mount, dict)):
        raise ProbeFailure("keeper-compose-contract")
    template = compose_file.read_text(encoding="utf-8")
    if "create_host_path: false" not in template:
        raise ProbeFailure("keeper-compose-contract")
    proof["claims"]["keeperGeneratedComposeUsesBakedAdmissionEntryPoint"] = True

    # Negative attempts get a FIFO keeper.json as a tripwire. If the fixed entrypoint ever
    # reaches Keeper before refusing, the normal synchronous config read hangs and cannot be
    # mistaken for the expected exit 78. The existing good Keeper remains the lock holder.
    sentinel_config = root / "keeper-config-must-not-be-read"
    os.mkfifo(sentinel_config, 0o600)
    keeper_container_name = project + "-keeper-admission"

    def socket_snapshot() -> tuple[tuple[int, int], tuple[int, int]]:
        app, host = app_socket.stat(), host_socket.stat()
        return (app.st_dev, app.st_ino), (host.st_dev, host.st_ino)

    def run_generated_refusal(label: str, admission_source: pathlib.Path,
                              command: list[str] | None = None) -> None:
        name = project + "-guard-deny-" + label
        attempt_env = {**local_image_env,
            "LARES_MAINTENANCE_ADMISSION_DIR": str(admission_source),
            "LARES_KEEPER_CONFIG": str(sentinel_config)}
        before_sockets = socket_snapshot()
        before_admission = {}
        if admission_source.is_dir():
            for path in sorted(admission_source.iterdir()):
                file_stat = path.lstat()
                before_admission[path.name] = (file_stat.st_dev, file_stat.st_ino,
                    stat.S_IMODE(file_stat.st_mode), path.is_symlink(),
                    path.read_bytes() if path.is_file() and not path.is_symlink() else None)
        attempt = run("docker", *compose_args, "run", "--detach", "--no-deps", "--name", name,
            "lares-keeper", *(command or []), check=False, timeout=30, env=attempt_env)
        known_containers.append(name)
        waited = docker("wait", name, check=False, timeout=8)
        inspected = docker("inspect", name, check=False, timeout=15)
        if inspected.returncode != 0:
            raise ProbeFailure("keeper-denied-inspect")
        try:
            state = json.loads(inspected.stdout)[0].get("State", {})
        except (json.JSONDecodeError, IndexError, TypeError):
            raise ProbeFailure("keeper-denied-inspect") from None
        logs = docker("logs", "--tail", "5", name, check=False, timeout=10)
        if attempt.returncode != 0 or waited.returncode != 0 or waited.stdout.strip() != "78" or \
           state.get("Running") is not False or state.get("ExitCode") != 78 or \
           logs.stdout.strip() != "maintenance admission refused" or socket_snapshot() != before_sockets:
            raise ProbeFailure("keeper-denied-outcome")
        after_admission = {}
        if admission_source.is_dir():
            for path in sorted(admission_source.iterdir()):
                file_stat = path.lstat()
                after_admission[path.name] = (file_stat.st_dev, file_stat.st_ino,
                    stat.S_IMODE(file_stat.st_mode), path.is_symlink(),
                    path.read_bytes() if path.is_file() and not path.is_symlink() else None)
        if after_admission != before_admission:
            raise ProbeFailure("keeper-denied-admission-preservation")
        container_remove = docker("rm", "--force", name, check=False, timeout=15)
        if container_remove.returncode != 0:
            raise ProbeFailure("keeper-denied-cleanup")
        known_containers.remove(name)
        holder = docker("inspect", keeper_container_name, check=False, timeout=10)
        try:
            holder_state = json.loads(holder.stdout)[0].get("State", {})
        except (json.JSONDecodeError, IndexError, TypeError):
            raise ProbeFailure("keeper-denied-holder") from None
        if holder.returncode != 0 or holder_state.get("Running") is not True or \
           run("flock", "--nonblock", "--exclusive", str(lock_path),
               "-c", "true", check=False).returncode != 1:
            raise ProbeFailure("keeper-denied-holder")
        proof["stages"]["keeperGeneratedRefusal-" + label] = True

    def copied_admission(label: str, mutate) -> pathlib.Path:
        candidate = root / ("admission-" + label)
        candidate.mkdir(mode=0o755)
        candidate.chmod(0o755)
        candidate_lock = candidate / "service-gate.lock"
        candidate_lock.write_bytes(lock_path.read_bytes())
        candidate_lock.chmod(0o444)
        intent = candidate / "intent.json"
        intent.write_bytes(custody._record(identity["installationId"], identity["epoch"], "normal"))
        intent.chmod(0o444)
        mutate(candidate, intent)
        return candidate

    name = keeper_container_name
    known_containers.append(name)
    created = run("docker", *compose_args, "run", "--detach", "--no-deps", "--name", name,
                  "lares-keeper", check=False, timeout=60, env=local_image_env)
    if created.returncode != 0:
        raise ProbeFailure("keeper-start")
    deadline = time.monotonic() + 45
    info: dict[str, object] | None = None
    lock_path = fixture_prefix / "var/lib/lares-maintenance/admission/service-gate.lock"
    app_socket = fixture_prefix / "run/lares/keeper.sock"
    host_socket = fixture_prefix / "run/lares-host/keeper.sock"
    readiness_request = (
        "const net=require('node:net');const s=net.createConnection(process.argv[1]);let b='';"
        "const t=setTimeout(()=>{s.destroy();process.exit(2)},3000);"
        "s.once('connect',()=>s.end(JSON.stringify({action:'credential.status',"
        "input:{slot:'notion:shared'},actor:'host'})+'\\n'));"
        "s.on('data',x=>b+=x);s.on('end',()=>{clearTimeout(t);let r;"
        "try{r=JSON.parse(b)}catch{process.exit(3)};"
        "if(r.ok!==true||r.result?.slot!=='notion:shared'||"
        "r.result?.state!=='host-administration-required'||"
        "r.result?.guidance!=='prepare-managed-slot')process.exit(4);"
        "console.log(JSON.stringify({ready:true,state:r.result.state}))});"
        "s.on('error',()=>{clearTimeout(t);process.exit(5)})"
    )
    readiness_result: subprocess.CompletedProcess | None = None
    while time.monotonic() < deadline:
        inspected = docker("inspect", name, check=False, timeout=15)
        if inspected.returncode == 0:
            try:
                info = json.loads(inspected.stdout)[0]
            except (json.JSONDecodeError, IndexError, TypeError):
                raise ProbeFailure("keeper-inspect") from None
            if info.get("State", {}).get("Running") is not True:
                raise ProbeFailure("keeper-startup-exited")
            if app_socket.is_socket() and host_socket.is_socket():
                readiness_result = docker("exec", name, "node", "-e", readiness_request,
                    "/run/lares-host/keeper.sock", check=False, timeout=8)
                if readiness_result.returncode == 0:
                    break
        time.sleep(0.25)
    if not info or info.get("State", {}).get("Running") is not True:
        raise ProbeFailure("keeper-startup-timeout")
    if not app_socket.is_socket() or not host_socket.is_socket() or \
       readiness_result is None or readiness_result.returncode != 0:
        raise ProbeFailure("keeper-ready-rpc-timeout")
    proof["claims"]["keeperDefaultServePassedDatabaseReadinessAndBothSockets"] = True
    proof["stages"]["keeperAuthenticatedReadinessRequest"] = True
    if info.get("Path") != expected_entrypoint[0] or info.get("Args") != [
        *expected_entrypoint[1:], *expected_command,
    ]:
        raise ProbeFailure("keeper-startup-command")
    if info.get("Config", {}).get("Entrypoint") != expected_entrypoint or \
       info.get("Config", {}).get("Cmd") != expected_command or \
       info.get("Config", {}).get("Healthcheck") is not None:
        raise ProbeFailure("keeper-container-config")
    mount = [item for item in info.get("Mounts", []) if item.get("Destination") == expected_entrypoint[1]]
    if len(mount) != 1 or mount[0].get("Source") != str(lock_path.parent) or mount[0].get("RW") is not False:
        raise ProbeFailure("keeper-admission-mount")
    host_lock = lock_path.stat()
    container_pid1_lock = docker("exec", name, "stat", "-Lc", "%d:%i", "/proc/1/fd/9")
    if container_pid1_lock.stdout.strip() != f"{host_lock.st_dev}:{host_lock.st_ino}":
        raise ProbeFailure("keeper-admission-inode")
    exclusive = run("flock", "--nonblock", "--exclusive", str(lock_path), "-c", "true", check=False)
    if exclusive.returncode != 1:
        raise ProbeFailure("keeper-admission-lease")
    proof["claims"]["keeperMainProcessRetainsSharedLeaseAfterComposeReturns"] = True
    proof["stages"]["keeperDefaultAdmissionLease"] = True

    # Exercise unsafe/missing states through the same generated Compose service and baked
    # entrypoint. Only disposable directories below this probe's root are mutated.
    variants = [
        ("missing-intent", lambda _d, intent: intent.unlink()),
        ("missing-lock", lambda d, _i: (d / "service-gate.lock").unlink()),
        ("symlink-intent", lambda d, i: (i.unlink(), i.symlink_to(root / "valid-intent-copy"))),
        ("hardlink-intent", lambda d, i: os.link(i, d / "intent-link")),
        ("unsafe-mode-intent", lambda _d, i: i.chmod(0o644)),
        ("oversize-intent", lambda _d, i: (i.write_bytes(b"x" * 257), i.chmod(0o444))),
        ("malformed-intent", lambda _d, i: (i.write_bytes(b"{\n"), i.chmod(0o444))),
        ("wrong-installation-id", lambda _d, i: (i.write_bytes(custody._record(str(uuid.uuid4()), identity["epoch"], "normal")), i.chmod(0o444))),
        ("wrong-epoch", lambda _d, i: (i.write_bytes(custody._record(identity["installationId"], identity["epoch"] + 1, "normal")), i.chmod(0o444))),
    ]
    for label, mutate in variants:
        candidate = copied_admission(label, mutate)
        run_generated_refusal(label, candidate)

    missing_source = root / "admission-missing-source"
    missing_env = {**local_image_env, "LARES_MAINTENANCE_ADMISSION_DIR": str(missing_source),
                   "LARES_KEEPER_CONFIG": str(sentinel_config)}
    missing_name = project + "-guard-deny-missing-source"
    missing_result = run("docker", *compose_args, "run", "--rm", "--no-deps", "--name", missing_name,
        "lares-keeper", check=False, timeout=30, env=missing_env)
    if missing_result.returncode == 0 or missing_source.exists() or \
       not re.search(r"does not exist|no such file|not found", missing_result.stdout, re.IGNORECASE):
        raise ProbeFailure("keeper-missing-source")
    proof["stages"]["keeperGeneratedRefusal-missing-source"] = True

    old_release = json.loads((REPO / "releases/2026-10-21-rc.12.json").read_text(encoding="utf-8"))
    old_keeper_image = old_release["images"]["lares-keeper"]
    old_image_result = run("docker", *compose_args, "run", "--rm", "--no-deps", "--name",
        project + "-old-keeper-image", "lares-keeper", check=False, timeout=45,
        env={**local_image_env, "LARES_KEEPER_IMAGE": old_keeper_image,
             "LARES_KEEPER_CONFIG": str(sentinel_config)})
    if old_image_result.returncode != 1 or \
       not re.search(r"maintenance-admission-v1.*(no such file|not found|executable file)|"
                     r"(no such file|not found|executable file).*maintenance-admission-v1",
                     old_image_result.stdout, re.IGNORECASE):
        raise ProbeFailure("keeper-old-image-entrypoint")
    proof["claims"]["pinnedPreGuardImageCannotStartThroughGeneratedCompose"] = True

    original_intent = lock_path.parent.joinpath("intent.json").read_bytes()

    def publish_test_state(state: str) -> None:
        replacement = lock_path.parent / (".probe-intent-" + secrets.token_hex(8))
        replacement.write_bytes(custody._record(identity["installationId"], identity["epoch"], state))
        replacement.chmod(0o444)
        os.replace(replacement, lock_path.parent / "intent.json")
        custody._sync_dir(lock_path.parent)

    def restart_refuses_for(state: str) -> None:
        expected_intent = lock_path.parent / "intent.json"
        intent_bytes = expected_intent.read_bytes()
        intent_inode = expected_intent.stat()
        before_sockets = socket_snapshot()
        override = root / ("keeper-restart-no-policy-" + state + ".yaml")
        override.write_text('services:\n  lares-keeper:\n    restart: "no"\n', encoding="ascii")
        restart_project = project + "-restart-" + state
        restart_args = ["compose", "-p", restart_project, "-f", str(compose_file), "-f", str(override),
                        "--env-file", str(keeper_env)]
        restart_env = {**local_image_env, "LARES_KEEPER_CONFIG": str(sentinel_config)}
        started = run("docker", *restart_args, "up", "-d", "--no-deps", "lares-keeper",
                      check=False, timeout=30, env=restart_env)
        listed = run("docker", *restart_args, "ps", "--all", "--quiet", "lares-keeper",
                     check=False, timeout=15, env=restart_env)
        container_id = listed.stdout.strip().splitlines()
        if not container_id or len(container_id) != 1:
            raise ProbeFailure("keeper-restart-container")
        cid = container_id[0]
        known_containers.append(cid)
        if started.returncode != 0:
            raise ProbeFailure("keeper-restart-start")
        waited = docker("wait", cid, check=False, timeout=15)
        before = docker("inspect", cid, check=False, timeout=10)
        if waited.returncode != 0 or waited.stdout.strip() != "78" or before.returncode != 0:
            raise ProbeFailure("keeper-restart-inspect")
        try:
            before_info = json.loads(before.stdout)[0]
            before_state = before_info.get("State", {})
            restart_policy = before_info.get("HostConfig", {}).get("RestartPolicy", {}).get("Name")
        except (json.JSONDecodeError, IndexError, TypeError):
            raise ProbeFailure("keeper-restart-inspect") from None
        if before_state.get("ExitCode") != 78 or restart_policy != "no" or \
           docker("logs", cid, check=False, timeout=10).stdout.strip() != "maintenance admission refused":
            raise ProbeFailure("keeper-restart-refusal")
        restarted = docker("start", cid, check=False, timeout=15)
        waited = docker("wait", cid, check=False, timeout=15)
        after = docker("inspect", cid, check=False, timeout=10)
        try:
            after_info = json.loads(after.stdout)[0]
            after_state = after_info.get("State", {})
        except (json.JSONDecodeError, IndexError, TypeError):
            raise ProbeFailure("keeper-restart-inspect") from None
        log_lines = docker("logs", cid, check=False, timeout=10).stdout.strip().splitlines()
        if restarted.returncode != 0 or waited.returncode != 0 or waited.stdout.strip() != "78" or \
           after_state.get("Running") is not False or after_state.get("ExitCode") != 78 or \
           log_lines != ["maintenance admission refused", "maintenance admission refused"] or \
           socket_snapshot() != before_sockets or \
           expected_intent.read_bytes() != intent_bytes or \
           (expected_intent.stat().st_dev, expected_intent.stat().st_ino) != \
           (intent_inode.st_dev, intent_inode.st_ino):
            raise ProbeFailure("keeper-restart-refusal")
        removed = docker("rm", "--force", cid, check=False, timeout=15)
        if removed.returncode != 0:
            raise ProbeFailure("keeper-restart-cleanup")
        known_containers.remove(cid)
        proof["stages"]["keeperGeneratedRestartRefusal-" + state] = True

    try:
        for state in ("entering", "blocked"):
            publish_test_state(state)
            run_generated_refusal(state + "-default", lock_path.parent)
            run_generated_refusal(state + "-command-override", lock_path.parent,
                                  ["sh", "-ec", "exit 42"])
            restart_refuses_for(state)
            if run("flock", "--nonblock", "--exclusive", str(lock_path),
                   "-c", "true", check=False).returncode != 1:
                raise ProbeFailure("keeper-held-while-denying")
            # This direct atomic write models a durable test fixture transition while an
            # admitted holder remains live; it is not an installed transition command/API.
            publish_test_state("normal")
    finally:
        temporary = lock_path.parent / (".probe-intent-restore-" + secrets.token_hex(8))
        temporary.write_bytes(original_intent)
        temporary.chmod(0o444)
        os.replace(temporary, lock_path.parent / "intent.json")
        custody._sync_dir(lock_path.parent)
    proof["claims"]["keeperGeneratedEnteringAndBlockedStartsAndRestartsRefuseBeforeConfig"] = True

    removed = docker("rm", "--force", name, check=False, timeout=20)
    if removed.returncode != 0:
        raise ProbeFailure("keeper-cleanup")
    known_containers.remove(name)
    exclusive = run("flock", "--nonblock", "--exclusive", str(lock_path), "-c", "true", check=False)
    if exclusive.returncode != 0:
        raise ProbeFailure("keeper-admission-release")

    # A harmless command override still passes through the same image entrypoint. Verify the
    # guard restores the image's physical WORKDIR before handing control to that command.
    cwd_probe = run("docker", *compose_args, "run", "--rm", "--no-deps", "lares-keeper",
        "sh", "-ec", 'test "$(pwd -P)" = /app', check=False, timeout=30, env=local_image_env)
    if cwd_probe.returncode != 0:
        raise ProbeFailure("keeper-cwd-restore")
    proof["claims"]["keeperCommandOverrideReceivesRestoredWorkingDirectory"] = True
    proof["stages"]["keeperAdmissionCwdRestored"] = True



def prove_update_history_client_lease() -> None:
    """Exercise both fixed consumers through engine_normal_client and prove real fd 9 leases."""
    import signal

    identity = custody.validate(fixture_prefix, subnet)
    lock_path = fixture_prefix / "var/lib/lares-maintenance/admission/service-gate.lock"
    lock_stat = lock_path.stat()

    def owned_info(container_id: str, owner: str, operation: str,
                   timeout: int = 10) -> dict[str, object]:
        if not re.fullmatch(r"[a-f0-9]{64}", container_id):
            raise ProbeFailure("update-client-identity")
        result = docker("inspect", container_id, check=False, timeout=timeout)
        if result.returncode != 0:
            raise ProbeFailure("update-client-identity")
        try:
            info = json.loads(result.stdout)[0]
        except (json.JSONDecodeError, IndexError, TypeError):
            raise ProbeFailure("update-client-identity") from None
        labels = info.get("Config", {}).get("Labels", {})
        if info.get("Id") != container_id or labels.get("com.lares.maintenance.owner") != owner or \
           labels.get("com.lares.maintenance.operation") != operation:
            raise ProbeFailure("update-client-identity")
        return info

    def cleanup_owned(container_id: str, owner: str, operation: str) -> bool:
        try:
            info = owned_info(container_id, owner, operation)
        except ProbeFailure:
            return False
        if info.get("State", {}).get("Running") is True:
            if docker("stop", "--time", "5", container_id, check=False, timeout=12).returncode != 0:
                return False
            try:
                info = owned_info(container_id, owner, operation)
            except ProbeFailure:
                return False
            if info.get("State", {}).get("Running") is not False:
                return False
        docker("rm", container_id, check=False, timeout=12)
        id_absence = docker("ps", "-aq", "--no-trunc", "--filter", "id=" + container_id,
                            check=False, timeout=8)
        name = str(info.get("Name", "")).lstrip("/")
        name_absence = docker("ps", "-aq", "--filter", "name=^/" + name + "$",
                              check=False, timeout=8)
        if id_absence.returncode != 0 or id_absence.stdout.strip() or \
           name_absence.returncode != 0 or name_absence.stdout.strip():
            return False
        if container_id in known_containers:
            known_containers.remove(container_id)
        return True

    def prove_one(script: str, program_args: list[str], credential: pathlib.Path,
                  pguser: str, table: str, query_needle: str) -> None:
        token = uuid.uuid4().hex
        blocker_name = project + "-client-lock-" + token[:12]
        blocker_cidfile = root / ("client-lock-" + token + ".cid")
        work_dir = root / ("client-work-" + token)
        work_dir.mkdir(mode=0o700)
        blocker_id = client_id = client_owner = ""
        client_name = ""
        blocker_cli: subprocess.Popen | None = None
        launcher: subprocess.Popen | None = None
        containers: list[tuple[str, str, str]] = []
        primary: BaseException | None = None
        cleanup_ok = True

        try:
            blocker = docker("create", "--name", blocker_name, "--cidfile", str(blocker_cidfile),
                "--label", "com.lares.maintenance.owner=" + token,
                "--label", "com.lares.maintenance.operation=probe-lock", "--network", "host",
                "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges",
                "--mount", f"type=bind,src={operator_path},dst=/run/operator-password,readonly",
                "--env", "PGHOST=127.0.0.1", "--env", "PGPORT=5432",
                "--env", "PGDATABASE=lares_state", "--env", "PGUSER=lares_operator",
                "--entrypoint", "/bin/sh", PINNED_DB_IMAGE,
                "-ec", 'export PGPASSWORD="$(cat /run/operator-password)"; exec psql -X -v ON_ERROR_STOP=1 '
                '-U lares_operator -d lares_state -c "BEGIN; LOCK TABLE ' + table +
                ' IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(120); COMMIT;"',
                check=False, timeout=45)
            blocker_id = blocker_cidfile.read_text(encoding="ascii").strip() if blocker_cidfile.is_file() else ""
            if blocker.returncode != 0 or not re.fullmatch(r"[a-f0-9]{64}", blocker_id):
                raise ProbeFailure("update-client-lock-fixture")
            known_containers.append(blocker_id)
            containers.append((blocker_id, token, "probe-lock"))
            owned_info(blocker_id, token, "probe-lock")
            blocker_cli = subprocess.Popen(["docker", "start", "--attach", blocker_id],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                locks = observe_update_client_lock(compose_files, table)
                if locks == "1":
                    break
                if blocker_cli.poll() is not None:
                    raise ProbeFailure("update-client-lock-fixture")
                time.sleep(0.25)
            else:
                raise ProbeFailure("update-client-lock-fixture")

            if script == "bin/update-record.ts":
                client_args = ["--ro", str(credential), "--env", "DATABASE_PASSWORD_FILE=" + str(credential),
                    "--env", "PGHOST=127.0.0.1", "--env", "PGPORT=5432",
                    "--env", "PGDATABASE=lares_state", "--env", "PGUSER=" + pguser,
                    "bin/update-record.ts", *program_args]
            else:
                client_args = ["--ro", str(credential), "--env", "DATABASE_PASSWORD_FILE=" + str(credential),
                    "--env", "LARES_OPERATOR_PASSWORD_FILE=" + str(credential),
                    "--env", "PGHOST=127.0.0.1", "--env", "PGPORT=5432",
                    "--env", "PGDATABASE=lares_state", "--env", "PGUSER=" + pguser,
                    "migrate.ts", *program_args]
            candidate_id = candidate_image_config_id(IMAGE)
            proof["candidateKeeperImageConfigId"] = candidate_id
            launch = "\n".join([
                "set -euo pipefail",
                "HERE=" + shlex.quote(str(REPO / "services/box/ops")),
                "BOX_DIR=" + shlex.quote(str(REPO / "services/box")),
                "ADMISSION_PREFIX=" + shlex.quote(str(fixture_prefix)),
                "LARES_SUBNET=" + shlex.quote(subnet),
                "WORK=" + shlex.quote(str(work_dir)),
                "MAINTENANCE_TEST_OWNER=0",
                ". \"$HERE/engine-run.sh\"",
                "ENGINE_IMAGE=" + shlex.quote(candidate_id),
                shlex.join(["engine_normal_client", "update", *client_args]),
            ])

            try:
                os.fstat(custody._LEASE_FD)
            except OSError:
                pass
            else:
                raise ProbeFailure("update-client-host-lease-fixture")
            custody._acquire_normal_lease(fixture_prefix, os.geteuid())
            try:
                launcher = subprocess.Popen(["bash", "-ec", launch],
                    env=os.environ.copy(),
                    pass_fds=(custody._LEASE_FD,), stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, start_new_session=True)
            finally:
                os.close(custody._LEASE_FD)

            deadline = time.monotonic() + 45
            cidfiles: list[pathlib.Path] = []
            while time.monotonic() < deadline:
                intents = list(work_dir.glob("engine-client-*.intent"))
                if len(intents) == 1 and intents[0].is_file():
                    intent = parse_update_client_intent(intents[0].read_text(encoding="ascii"))
                    if intent is not None:
                        client_name, client_owner = intent
                cidfiles = list(work_dir.glob("engine-client-*.cid"))
                if len(cidfiles) == 1 and cidfiles[0].is_file():
                    client_id = cidfiles[0].read_text(encoding="ascii").strip()
                    if re.fullmatch(r"[a-f0-9]{64}", client_id):
                        break
                if launcher.poll() is not None:
                    raise ProbeFailure("update-client-launch")
                time.sleep(0.1)
            if not re.fullmatch(r"[a-f0-9]{64}", client_id) or not client_name:
                raise ProbeFailure("update-client-launch")
            try:
                info_result = docker("inspect", client_id, check=False, timeout=10)
                info = json.loads(info_result.stdout)[0] if info_result.returncode == 0 else {}
            except (json.JSONDecodeError, IndexError, TypeError):
                info = {}
            if not update_client_info_matches(info, client_id, client_name, client_owner, "update"):
                raise ProbeFailure("update-client-identity")
            if info.get("Image") != candidate_id:
                raise ProbeFailure("update-client-image")
            containers.append((client_id, client_owner, "update"))
            known_containers.append(client_id)
            if info.get("Id") != client_id:
                raise ProbeFailure("update-client-identity")
            expected_script = "/app/services/box/" + script
            expected_args = ["/run/lares-maintenance/admission", identity["installationId"],
                str(identity["epoch"]), "--", "node", "--import", "tsx/esm",
                expected_script, *program_args]
            if info.get("Path") != "/usr/local/lib/lares/maintenance-admission-v1" or \
               info.get("Args") != expected_args or \
               info.get("Config", {}).get("Entrypoint") != ["/usr/local/lib/lares/maintenance-admission-v1"]:
                raise ProbeFailure("update-client-command")
            mounts = info.get("Mounts", [])
            admission = fixture_prefix / "var/lib/lares-maintenance/admission"
            admission_mount = [m for m in mounts if m.get("Destination") == "/run/lares-maintenance/admission"]
            credential_mount = [m for m in mounts if m.get("Destination") == str(credential)]
            if len(admission_mount) != 1 or admission_mount[0].get("Source") != str(admission) or \
               admission_mount[0].get("RW") is not False or len(credential_mount) != 1 or \
               credential_mount[0].get("Source") != str(credential) or credential_mount[0].get("RW") is not False:
                raise ProbeFailure("update-client-mount")

            inspect_script = UPDATE_CLIENT_FD9_INSPECT

            query_user = pguser
            query_pattern = query_needle.replace("'", "''")
            def inspect_fd9(timeout: int) -> bool:
                evidence = docker("exec", client_id, "python3", "-c", inspect_script,
                    str(lock_stat.st_dev), str(lock_stat.st_ino),
                    "/app/services/box/" + script, check=False, timeout=min(8, timeout))
                return evidence.returncode == 0 and evidence.stdout.strip() == "ok"

            def observe_database_wait(timeout: int) -> bool:
                waiting = operator_query(compose_files,
                    "SELECT count(*)::text FROM pg_stat_activity WHERE datname='lares_state' " +
                    "AND usename='" + query_user + "' AND wait_event_type='Lock' AND query LIKE '%" +
                    query_pattern + "%'", check=False, timeout=timeout,
                    operator_timeout=timeout)
                return waiting == "1"

            def deny_host_exclusive(timeout: int) -> bool:
                return run("flock", "--nonblock", "--exclusive", str(lock_path),
                           "-c", "true", check=False, timeout=timeout).returncode == 1

            stem = "updateHistoryClient" if script == "bin/update-record.ts" else "migrationClient"
            retained, lease_diagnostics = poll_update_client_lease(
                time.monotonic() + 45,
                inspect_owned=lambda timeout: owned_info(client_id, client_owner, "update", timeout),
                launcher_alive=lambda: launcher.poll() is None,
                fd9_check=inspect_fd9,
                database_wait=observe_database_wait,
                exclusive_denied=deny_host_exclusive,
                monotonic=time.monotonic,
                sleep=time.sleep,
            )
            proof["clientLeaseDiagnostics"][stem] = lease_diagnostics
            if not retained:
                raise ProbeFailure("update-client-lease")

            os.killpg(launcher.pid, signal.SIGKILL)
            try:
                launcher.wait(timeout=5)
            except subprocess.TimeoutExpired:
                raise ProbeFailure("update-client-caller-cleanup") from None
            info = owned_info(client_id, client_owner, "update")
            post_exit_evidence = docker("exec", client_id, "python3", "-c", inspect_script,
                str(lock_stat.st_dev), str(lock_stat.st_ino),
                "/app/services/box/" + script, check=False, timeout=8)
            if info.get("State", {}).get("Running") is not True or \
               post_exit_evidence.returncode != 0 or post_exit_evidence.stdout.strip() != "ok" or \
               run("flock", "--nonblock", "--exclusive", str(lock_path), "-c", "true", check=False).returncode != 1:
                raise ProbeFailure("update-client-caller-cleanup")
            if not cleanup_owned(client_id, client_owner, "update"):
                raise ProbeFailure("update-client-cleanup")
            containers.remove((client_id, client_owner, "update"))
            if run("flock", "--nonblock", "--exclusive", str(lock_path), "-c", "true", check=False).returncode != 0:
                raise ProbeFailure("update-client-release")

            proof["claims"][stem + "RetainsIndependentAdmissionLease"] = True
            proof["claims"][stem + "LeaseSurvivesCallerExit"] = True
            proof["claims"][stem + "OwnedContainerCleanupVerified"] = True
            proof["stages"][stem + "SameProcessFd9"] = True
            proof["stages"][stem + "CallerLostLeaseHeld"] = True
            proof["stages"][stem + "StopAbsenceAndRelease"] = True
        except BaseException as error:
            primary = error
        finally:
            if launcher is not None and launcher.poll() is None:
                try:
                    os.killpg(launcher.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except Exception:
                    cleanup_ok = False
                try:
                    launcher.wait(timeout=5)
                except Exception:
                    cleanup_ok = False
            if not any(item[2] == "update" for item in containers):
                # Recover a create that completed before the host received a cidfile or
                # completed the identity check. The fixed intent is written before create.
                try:
                    intents = list(work_dir.glob("engine-client-*.intent"))
                    if len(intents) == 1 and intents[0].is_file():
                        intent = parse_update_client_intent(intents[0].read_text(encoding="ascii"))
                        if intent is not None:
                            client_name, client_owner = intent
                            recovered = docker("inspect", "--format", "{{json .}}", client_name,
                                               check=False, timeout=8)
                            if recovered.returncode == 0:
                                item = json.loads(recovered.stdout)
                                recovered_id = item.get("Id", "")
                                if update_client_info_matches(item, recovered_id, client_name,
                                                              client_owner, "update"):
                                    client_id = recovered_id
                                    containers.append((client_id, client_owner, "update"))
                                    known_containers.append(client_id)
                                else:
                                    cleanup_ok = False
                            else:
                                absence = docker("ps", "-aq", "--filter", "name=^/" + client_name + "$",
                                                 check=False, timeout=8)
                                if absence.returncode != 0 or absence.stdout.strip():
                                    cleanup_ok = False
                        else:
                            cleanup_ok = False
                except Exception:
                    cleanup_ok = False
            if not blocker_id:
                try:
                    partial = docker("inspect", "--format",
                        '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.lares.maintenance.owner"}}|{{index .Config.Labels "com.lares.maintenance.operation"}}',
                        blocker_name, check=False, timeout=8)
                    if partial.returncode == 0:
                        fields = partial.stdout.strip().split("|")
                        if (len(fields) == 4 and re.fullmatch(r"[a-f0-9]{64}", fields[0])
                                and fields[1] == "/" + blocker_name and fields[2] == token
                                and fields[3] == "probe-lock"):
                            blocker_id = fields[0]
                            known_containers.append(blocker_id)
                            containers.append((blocker_id, token, "probe-lock"))
                        else:
                            cleanup_ok = False
                    else:
                        absence = docker("ps", "-aq", "--filter", "name=^/" + blocker_name + "$",
                                         check=False, timeout=8)
                        if absence.returncode != 0 or absence.stdout.strip():
                            cleanup_ok = False
                except Exception:
                    cleanup_ok = False
            cleanup_ok = finish_update_client_cleanup([
                lambda container_id=container_id, owner=owner, operation=operation:
                    cleanup_owned(container_id, owner, operation)
                for container_id, owner, operation in reversed(containers)
            ], blocker_cli, proof, cleanup_ok)
            if primary is not None and not cleanup_ok:
                proof["failureKind"] = "cleanup"
        if primary is not None:
            if not cleanup_ok:
                raise ProbeFailure("update-client-cleanup")
            raise primary
        if not cleanup_ok:
            raise ProbeFailure("update-client-cleanup")

    prove_one("bin/update-record.ts", ["previous-release"],
              secrets_dir / "database-password", "lares_app", "update_history", "FROM update_history")
    prove_one("migrate.ts", ["--schema-owner"], operator_path,
              "lares_operator", "schema_migrations", "schema_migrations")


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


def operator_query(compose_args: list[str], sql: str, *, check: bool = True,
                   database: str = "postgres", timeout: int = 60,
                   operator_timeout: int = 30) -> str:
    result = operator_call(compose_args, ["psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1",
                                         "-U", "lares_operator", "-d", database, "-c", sql],
                           check=check, timeout=timeout, operator_timeout=operator_timeout)
    return result.stdout.strip()


def update_client_lock_query(table: str) -> str:
    return ("SELECT count(*)::text FROM pg_locks WHERE database=(SELECT oid FROM pg_database "
            "WHERE datname=current_database()) AND relation='" + table +
            "'::regclass AND mode='AccessExclusiveLock' AND granted AND pid<>pg_backend_pid()")


def observe_update_client_lock(compose_args: list[str], table: str) -> str:
    return operator_query(compose_args, update_client_lock_query(table), check=False,
                          database="lares_state")


def poll_update_client_lease(deadline: float, *, inspect_owned, launcher_alive,
                             fd9_check, database_wait, exclusive_denied,
                             monotonic, sleep) -> tuple[bool, dict[str, object]]:
    """Wait for a verified running client and require every independent lease signal."""
    diagnostics: dict[str, object] = {
        "pollCount": 0,
        "createdSeen": False,
        "runningSeen": False,
        "stateClass": "not-observed",
        "fd9Observed": False,
        "databaseWaitObserved": False,
        "exclusiveDenialObserved": False,
        "failureClass": "client-start-timeout",
    }

    def fail(category: str) -> tuple[bool, dict[str, object]]:
        diagnostics["failureClass"] = category
        return False, diagnostics

    def remaining_timeout() -> int | None:
        remaining = deadline - monotonic()
        if remaining < 1:
            return None
        return int(remaining)

    def expired() -> bool:
        return monotonic() >= deadline

    def launcher_is_alive() -> bool | None:
        try:
            alive = bool(launcher_alive())
        except Exception:
            return None
        if expired():
            return None
        return alive

    def deadline_failure() -> tuple[bool, dict[str, object]]:
        if diagnostics["createdSeen"] and not diagnostics["runningSeen"]:
            return fail("client-created-timeout")
        if diagnostics["runningSeen"]:
            missing = []
            if not diagnostics["fd9Observed"]:
                missing.append("fd9")
            if not diagnostics["databaseWaitObserved"]:
                missing.append("database-wait")
            if not diagnostics["exclusiveDenialObserved"]:
                missing.append("host-exclusive-denial")
            diagnostics["missingPredicates"] = missing
            return fail("lease-observation-deadline")
        return fail("client-start-timeout")

    while monotonic() < deadline:
        diagnostics["pollCount"] = int(diagnostics["pollCount"]) + 1
        timeout = remaining_timeout()
        if timeout is None:
            return deadline_failure()
        try:
            info = inspect_owned(timeout)
        except Exception:
            if expired():
                return deadline_failure()
            return fail("client-identity-unverified")
        if expired():
            return deadline_failure()
        state = info.get("State", {}) if isinstance(info, dict) else {}
        status = state.get("Status") if isinstance(state, dict) else None
        running = state.get("Running") if isinstance(state, dict) else None

        if status == "created" and running is False:
            diagnostics["createdSeen"] = True
            diagnostics["stateClass"] = "created"
            alive = launcher_is_alive()
            if alive is None:
                if expired():
                    return deadline_failure()
                return fail("client-launcher-state-unknown")
            if not alive:
                return fail("client-launcher-exited")
            remaining = deadline - monotonic()
            if remaining <= 0:
                return deadline_failure()
            sleep(min(0.25, remaining))
            if expired():
                return deadline_failure()
            continue

        if status != "running" or running is not True:
            terminal = {"exited", "dead", "paused", "restarting", "removing"}
            is_terminal = isinstance(status, str) and status in terminal
            diagnostics["stateClass"] = status if is_terminal else "unexpected"
            return fail("client-state-terminal" if is_terminal else "client-state-unexpected")

        diagnostics["runningSeen"] = True
        diagnostics["stateClass"] = "running"

        alive = launcher_is_alive()
        if alive is None:
            if expired():
                return deadline_failure()
            return fail("client-launcher-state-unknown")
        if not alive:
            return fail("client-launcher-exited")

        def observe(callback) -> bool | None:
            timeout = remaining_timeout()
            if timeout is None:
                return None
            try:
                result = bool(callback(timeout))
            except Exception:
                result = False
            if expired():
                return None
            alive_now = launcher_is_alive()
            if alive_now is None or not alive_now:
                diagnostics["failureClass"] = (
                    "client-launcher-exited" if alive_now is False
                    else "client-launcher-state-unknown")
                return None
            if expired():
                return None
            return result

        try:
            fd9_result = observe(fd9_check)
            if fd9_result is None:
                if diagnostics["failureClass"] in {"client-launcher-exited", "client-launcher-state-unknown"}:
                    return False, diagnostics
                return deadline_failure()
            fd9_ok = fd9_result
            diagnostics["fd9Observed"] = bool(diagnostics["fd9Observed"]) or fd9_ok
            database_result = observe(database_wait)
            if database_result is None:
                if diagnostics["failureClass"] in {"client-launcher-exited", "client-launcher-state-unknown"}:
                    return False, diagnostics
                return deadline_failure()
            database_ok = database_result
            diagnostics["databaseWaitObserved"] = (
                bool(diagnostics["databaseWaitObserved"]) or database_ok)
        except Exception:
            return fail("lease-observation-failed")

        # Preserve the original independent exclusive-refusal check: reach it only after
        # the same poll observed the real descriptor and the matching blocked DB query.
        if fd9_ok and database_ok:
            exclusive_result = observe(exclusive_denied)
            if exclusive_result is None:
                if diagnostics["failureClass"] in {"client-launcher-exited", "client-launcher-state-unknown"}:
                    return False, diagnostics
                return deadline_failure()
            exclusive_ok = exclusive_result
            diagnostics["exclusiveDenialObserved"] = exclusive_ok
            if not exclusive_ok:
                return fail("host-exclusive-not-denied")
            if expired():
                return deadline_failure()
            alive = launcher_is_alive()
            if alive is None:
                if expired():
                    return deadline_failure()
                return fail("client-launcher-state-unknown")
            if not alive:
                return fail("client-launcher-exited")
            if expired():
                return deadline_failure()
            diagnostics["failureClass"] = "none"
            return True, diagnostics

        alive = launcher_is_alive()
        if alive is None:
            if expired():
                return deadline_failure()
            return fail("client-launcher-state-unknown")
        if not alive:
            return fail("client-launcher-exited")
        remaining = deadline - monotonic()
        if remaining <= 0:
            return deadline_failure()
        sleep(min(0.25, remaining))
        if expired():
            return deadline_failure()

    if expired():
        return deadline_failure()
    alive = launcher_is_alive()
    if alive is None:
        if expired():
            return deadline_failure()
        return fail("client-launcher-state-unknown")
    if not alive:
        return fail("client-launcher-exited")
    if expired():
        return deadline_failure()
    if diagnostics["createdSeen"] and not diagnostics["runningSeen"]:
        return fail("client-created-timeout")
    if diagnostics["runningSeen"]:
        missing = []
        if not diagnostics["fd9Observed"]:
            missing.append("fd9")
        if not diagnostics["databaseWaitObserved"]:
            missing.append("database-wait")
        if not diagnostics["exclusiveDenialObserved"]:
            missing.append("host-exclusive-denial")
        diagnostics["missingPredicates"] = missing
        return fail("lease-predicate-not-observed" if missing else "lease-predicates-not-concurrent")
    return fail("client-start-timeout")


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
    stage = "production-schema-owner-migrations"
    migrate = engine_box("migrate.ts", ["--schema-owner"], [operator_path], {
        "DATABASE_PASSWORD_FILE": "/run/operator-password",
        "LARES_OPERATOR_PASSWORD_FILE": "/run/operator-password",
        "PGHOST": "127.0.0.1", "PGPORT": "5432", "PGDATABASE": "lares_state",
        "PGUSER": "lares_operator",
    })
    if migrate.returncode != 0:
        raise ProbeFailure("schema-owner-migrations")
    proof["claims"]["productionSchemaOwnerMigrationPathUsed"] = True
    proof["stages"]["productionSchemaOwnerMigrations"] = True
    stage = "production-installation-settings"
    settings = engine_box("bin/installation-settings.ts", [], [credential_files["database-password"]], {
        "DATABASE_PASSWORD_FILE": "/run/database-password",
        "PGHOST": "127.0.0.1", "PGPORT": "5432", "PGDATABASE": "lares_state",
        "PGUSER": "lares_app",
    })
    if settings.returncode != 0:
        raise ProbeFailure("installation-settings")
    proof["claims"]["productionInstallationSettingsPathUsed"] = True
    proof["stages"]["productionInstallationSettings"] = True
    stage = "keeper-default-entrypoint-admission"
    prove_keeper_default_admission()
    stage = "update-history-client-admission"
    prove_update_history_client_lease()
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
    okay = proof.get("stages", {}).get("updateClientCleanupVerified") is not False
    for name in list(reversed(known_containers)):
        try:
            if docker("rm", "--force", name, check=False, timeout=20).returncode != 0:
                okay = False
            elif re.fullmatch(r"[a-f0-9]{64}", name):
                absence = docker("ps", "-aq", "--no-trunc", "--filter", "id=" + name,
                                 check=False, timeout=8)
                if absence.returncode != 0 or absence.stdout.strip():
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
    if okay:
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
