"""Configured outside discovery proof; Linux disposable CI only."""
import ast
import hashlib
import ipaddress
import copy
import importlib.util
import json
import os
import pathlib
import platform
import re
import selectors
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import stat
from unittest.mock import patch

DB_IMAGE = "docker.io/pgvector/pgvector@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b"
repo = pathlib.Path(__file__).resolve().parents[3]
self_test_mode = sys.argv[1:] == ["--self-test"]
image_store_mode = sys.argv[1:] == ["--prepare-image-store"]
if self_test_mode or image_store_mode:
    keeper_ref = squid_ref = firewall_ref = expected_sha = output = ""
else:
    keeper_ref, squid_ref, firewall_ref, expected_sha, output = sys.argv[1:]
report = {"format": 1, "source": os.environ.get("GITHUB_SHA"), "status": "not-started",
          "checks": [], "unproven": [
              "source spoof and missing selected source refusal",
              "TLS/URL mismatch, malformed/cursor/depth/byte/stall refusals",
              "abort physical closure and competing namespace ordering",
              "delayed SQL expiry, validator lifetime and lost COMMIT acknowledgements",
              "revocation lock orders, capacity, and graceful shutdown drain",
              "unchanged executable head/candidate under a second consent",
          ], "cleanupOkay": False}
root = None
network = None
agent_container_id = None
owner = uuid.uuid4().hex
worker_container = "lares-outside-worker-" + owner[:10]
worker_container_id = None
resource_names = []
worker_stopped = True
cleanup_failures = []
phase = "guards"
network_stage = "network"
NETWORK_FAILURE_STAGES = frozenset({
    "container-name-preflight", "network-name-preflight", "docker-network-inventory",
    "docker-network-inspect", "route-inventory", "subnet-selection", "network-create",
    "network-inspect", "network-isolation-check", "network-ipam-check",
    "network-address-validation", "firewall-preflight",
})
ACKNOWLEDGEMENT_REASONS = frozenset({
    "invalid-input", "deadline-before-connect", "connection-error", "dns-failure",
    "connection-refused", "local-source-unavailable", "network-unreachable", "connection-reset",
    "socket-timeout", "source-mismatch", "response-too-large", "deadline-no-response",
    "response-not-ended", "incomplete-headers", "status-not-403", "stage-absent", "stage-multiple",
    "stage-mismatch", "malformed-headers", "allow-marker", "response-invalid",
})
SAFE_FAILURE_PHASES = {"guards", "loaded-images", "network", "fixture-files", "database", "engine-roles",
                      "proxy-config", "compose-held-runtime", "https-peer", "configured-discovery",
                      "first-hop-evidence", "postconditions"}


def run(*args, input=None, timeout=90, check=True):
    """Capture all command output; failure messages never echo config or credentials."""
    try:
        result = subprocess.run(args, input=input, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError("fixture command timed out") from None
    if check and result.returncode:
        raise RuntimeError("fixture command failed")
    return result


def command(*args, input=None, timeout=90):
    return run(*args, input=input, timeout=timeout).stdout.strip()


def load_maintenance_custody():
    helper_path = repo / "services/box/ops/maintenance-custody.py"
    spec = importlib.util.spec_from_file_location("outside_maintenance_custody", helper_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("maintenance custody helper is unavailable")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper


def prepare_normal_admission_fixture(root_path, subnet, custody):
    prefix = root_path / "fixture-prefix"
    prefix.mkdir(mode=0o755)
    prefix.chmod(0o755)
    prefix_info = prefix.stat()
    if prefix_info.st_uid != os.geteuid() or stat.S_IMODE(prefix_info.st_mode) != 0o755:
        raise RuntimeError("fixture prefix ownership or mode is unsafe")
    custody.prepare_fresh(prefix, str(subnet))
    receipt = custody.validate(prefix, str(subnet))
    identity, epoch = receipt.get("installationId"), receipt.get("epoch")
    try:
        valid_identity = isinstance(identity, str) and str(uuid.UUID(identity)) == identity
    except (ValueError, TypeError, AttributeError):
        valid_identity = False
    if (not valid_identity or type(epoch) is not int or epoch != 1 or
            receipt.get("complete") is not True or receipt.get("databaseSubnet") != str(subnet)):
        raise RuntimeError("fixture preparation receipt is incomplete")
    admission = prefix / "var/lib/lares-maintenance/admission"
    admission_info = admission.stat()
    if admission_info.st_uid != os.geteuid() or stat.S_IMODE(admission_info.st_mode) != 0o755:
        raise RuntimeError("fixture admission directory ownership or mode is unsafe")
    if custody.read_intent(admission) != {
            "version": 1, "installationId": identity, "epoch": epoch, "state": "normal"}:
        raise RuntimeError("fixture admission intent is not normal for its receipt")
    return {"hostDirectory": str(admission), "installationId": identity, "epoch": epoch}


def create_squid_config_directory(root_path):
    egress = root_path / "egress"
    egress.mkdir(mode=0o755)
    egress.chmod(0o755)
    return egress


def write_initial_squid_config(egress):
    config = egress / "squid.conf"
    config.write_text("", encoding="ascii")
    config.chmod(0o644)
    return config


def outside_proxy_start_args(proxy_container, owner_token, network_name, proxy_ip,
                             squid_image, egress, lifecycle):
    admission = lifecycle["maintenanceAdmission"]
    identity, epoch = admission["installationId"], admission["epoch"]
    admission_path = pathlib.Path(admission["hostDirectory"])
    if (not identity or type(epoch) is not int or
            admission_path.name != "admission" or not admission_path.is_absolute()):
        raise RuntimeError("validated proxy admission coordinates are unavailable")
    return (
        "docker", "run", "-d", "--init", "--name", proxy_container,
        "--label", "lares.proof.owner=" + owner_token,
        "--network", network_name, "--network-alias", "lares-egress-proxy", "--ip", proxy_ip,
        "--env", "LARES_MAINTENANCE_INSTALLATION_ID=" + identity,
        "--env", "LARES_MAINTENANCE_EPOCH=" + str(epoch),
        "--mount", f"type=bind,src={egress},dst=/config,readonly",
        "--mount", f"type=bind,src={admission_path},dst=/run/lares-maintenance/admission,readonly",
        squid_image,
    )


PROXY_READINESS_PROBE = r"""const net=require('node:net');
const source=process.env.FIXTURE_SOURCE_IP, deadline=Date.now()+10000;
let done=false;
const finish=ok=>{if(done)return;done=true;clearTimeout(globalTimer);process.exit(ok?0:1)};
const globalTimer=setTimeout(()=>finish(false),10000);
function probe(){
 if(done||Date.now()>=deadline)return finish(false);
 const socket=net.createConnection({host:'lares-egress-proxy',port:8888,localAddress:source,family:4});
 let connected=false,closed=false,refused=false,buffer=Buffer.alloc(0);
 const attemptTimer=setTimeout(()=>{socket.destroy();finish(false)},Math.min(1500,Math.max(1,deadline-Date.now())));
 const retryAfterClose=()=>{if(!refused)return;clearTimeout(attemptTimer);setTimeout(probe,100)};
 socket.once('error',error=>{
  if(!connected&&buffer.length===0&&error.code==='ECONNREFUSED'){refused=true;socket.destroy();if(closed)retryAfterClose();return}
  clearTimeout(attemptTimer);socket.destroy();finish(false);
 });
 socket.once('close',()=>{closed=true;if(refused)retryAfterClose()});
 socket.once('connect',()=>{
  connected=true;
  if(socket.localAddress!==source){clearTimeout(attemptTimer);socket.destroy();finish(false);return}
  const host='lares-route-readiness.invalid';
  socket.write('CONNECT '+host+':443 HTTP/1.1\r\nHost: '+host+':443\r\nProxy-Connection: close\r\n\r\n');
 });
 socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>8192){clearTimeout(attemptTimer);socket.destroy();finish(false)}});
 socket.once('end',()=>{
  clearTimeout(attemptTimer);
  const end=buffer.indexOf(Buffer.from('\r\n\r\n'));
  const headers=end<0?'':buffer.subarray(0,end).toString('latin1');
  const lines=headers.split('\r\n');
  const valid=end>=0&&/^HTTP\/1\.[01] 403(?:[ \t].*)?$/.test(lines[0]||'')&&
   !lines.slice(1).some(line=>/^x-lares-route-stage(?:[: \t]|$)/i.test(line.trim()))&&
   !buffer.includes(Buffer.from('CI_PROXY_DESTINATION_OK'));
  socket.destroy();finish(valid);
 });
}
probe();"""


def proxy_readiness_start_args(container_name, owner_token, network_name, source_ip, keeper_image):
    source = ipaddress.ip_address(source_ip)
    if not re.fullmatch(r"lares-outside-proof-[a-f0-9]{10}-proxy-ready", container_name) or \
            not re.fullmatch(r"[a-f0-9]{32}", owner_token) or \
            not re.fullmatch(r"lares-outside-proof-[a-f0-9]{10}", network_name) or \
            source.version != 4 or not source.is_private or source.is_loopback or \
            source.is_unspecified or source.is_multicast:
        raise RuntimeError("proxy readiness probe coordinates are invalid")
    return (
        "docker", "run", "--rm", "--name", container_name,
        "--label", "lares.proof.owner=" + owner_token,
        "--network", network_name, "--ip", source_ip,
        "--env", "FIXTURE_SOURCE_IP=" + source_ip,
        "--read-only", "--cap-drop", "ALL", "--entrypoint", "node",
        keeper_image, "-e", PROXY_READINESS_PROBE,
    )


def verify_proxy_readiness_target(proxy_container, owner_token, network_name, proxy_ip,
                                  squid_image_id, egress, lifecycle):
    facts = container_facts(proxy_container)
    expected_mounts = {
        (str(egress), "/config", False),
        (lifecycle["maintenanceAdmission"]["hostDirectory"], "/run/lares-maintenance/admission", False),
    }
    mounts = {(item.get("Source"), item.get("Destination"), item.get("RW")) for item in facts["mounts"]} if facts else set()
    if not facts or facts["labels"].get("lares.proof.owner") != owner_token or \
            facts["running"] is not True or facts["imageId"] != squid_image_id or mounts != expected_mounts:
        raise RuntimeError("owned deny-only proxy identity could not be verified")
    raw_networks = command("docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}", proxy_container)
    try:
        networks = json.loads(raw_networks)
    except json.JSONDecodeError:
        raise RuntimeError("owned deny-only proxy network could not be verified") from None
    endpoint = networks.get(network_name) if isinstance(networks, dict) else None
    aliases = endpoint.get("Aliases") if isinstance(endpoint, dict) else None
    if not isinstance(networks, dict) or len(networks) != 1 or not isinstance(endpoint, dict) or \
            endpoint.get("IPAddress") != proxy_ip or not isinstance(aliases, list) or \
            "lares-egress-proxy" not in aliases:
        raise RuntimeError("owned deny-only proxy network could not be verified")


def record(label, ok):
    if not ok:
        raise RuntimeError("proof assertion failed: " + label)
    report["checks"].append(label)


def offline_proxy_admission_self_test():
    """Exercise the real preparation/launch helpers with a stubbed custody boundary."""
    custody = load_maintenance_custody()
    identity = "123e4567-e89b-12d3-a456-426614174000"
    subnet = ipaddress.ip_network("192.0.2.0/24")
    receipt = {"installationId": identity, "epoch": 1, "complete": True,
               "databaseSubnet": str(subnet)}
    calls = []

    def prepare_stub(prefix, requested_subnet):
        calls.append(("prepare", pathlib.Path(prefix), requested_subnet))
        admission = pathlib.Path(prefix) / "var/lib/lares-maintenance/admission"
        admission.mkdir(parents=True, mode=0o755)
        admission.chmod(0o755)

    def validate_stub(prefix, requested_subnet):
        calls.append(("validate", pathlib.Path(prefix), requested_subnet))
        return dict(receipt)

    def intent_stub(admission):
        calls.append(("intent", pathlib.Path(admission)))
        return {"version": 1, "installationId": identity, "epoch": 1, "state": "normal"}

    with tempfile.TemporaryDirectory(prefix="lares-outside-proxy-selftest-") as directory:
        root_path = pathlib.Path(directory)
        root_path.chmod(0o700)
        egress = create_squid_config_directory(root_path)
        config = write_initial_squid_config(egress)
        lifecycle = {"maintenanceAdmission": None}
        with patch.object(custody, "prepare_fresh", side_effect=prepare_stub), \
                patch.object(custody, "validate", side_effect=validate_stub), \
                patch.object(custody, "read_intent", side_effect=intent_stub):
            lifecycle["maintenanceAdmission"] = prepare_normal_admission_fixture(
                root_path, subnet, custody)
        prefix = root_path / "fixture-prefix"
        admission = prefix / "var/lib/lares-maintenance/admission"
        if calls != [
                ("prepare", prefix, str(subnet)), ("validate", prefix, str(subnet)),
                ("intent", admission)]:
            raise RuntimeError("fixture did not prepare and validate normal admission in order")
        if (stat.S_IMODE(prefix.stat().st_mode) != 0o755 or
                stat.S_IMODE(admission.stat().st_mode) != 0o755 or
                stat.S_IMODE(egress.stat().st_mode) != 0o755 or
                stat.S_IMODE(config.stat().st_mode) != 0o644):
            raise RuntimeError("proxy fixture directory or config permissions changed")
        if lifecycle["maintenanceAdmission"] != {
                "hostDirectory": str(admission), "installationId": identity, "epoch": 1}:
            raise RuntimeError("proxy lifecycle admission did not use the validated receipt")
        args = outside_proxy_start_args("proof-proxy", "a" * 32, "proof-network", "192.0.2.11",
                                        "lares-squid:test@sha256:" + "b" * 64, egress, lifecycle)
        expected_mounts = [
            f"type=bind,src={egress},dst=/config,readonly",
            f"type=bind,src={admission},dst=/run/lares-maintenance/admission,readonly",
        ]
        actual_mounts = [args[index + 1] for index, value in enumerate(args[:-1]) if value == "--mount"]
        if (args[:4] != ("docker", "run", "-d", "--init") or "--entrypoint" in args or
                "--env-file" in args or args[-1] != "lares-squid:test@sha256:" + "b" * 64 or
                actual_mounts != expected_mounts or
                "LARES_MAINTENANCE_INSTALLATION_ID=" + identity not in args or
                "LARES_MAINTENANCE_EPOCH=1" not in args or
                any("custody" in mount for mount in actual_mounts)):
            raise RuntimeError("proxy launch did not preserve the exact guarded admission contract")


def offline_proxy_readiness_self_test():
    """Check the deny-only readiness client's pinned identity, source and response contract."""
    args = proxy_readiness_start_args("lares-outside-proof-0123456789-proxy-ready", "a" * 32,
                                      "lares-outside-proof-0123456789", "192.0.2.14",
                                      "lares-keeper:test@sha256:" + "b" * 64)
    if args[:12] != ("docker", "run", "--rm", "--name", "lares-outside-proof-0123456789-proxy-ready",
                     "--label", "lares.proof.owner=" + "a" * 32, "--network",
                     "lares-outside-proof-0123456789", "--ip", "192.0.2.14", "--env") or \
            args[12] != "FIXTURE_SOURCE_IP=192.0.2.14" or args[-2] != "-e" or \
            args[-1] != PROXY_READINESS_PROBE or args[-3] != "lares-keeper:test@sha256:" + "b" * 64:
        raise RuntimeError("deny-only readiness probe did not use its exact pinned fixture boundary")
    required = ("host:'lares-egress-proxy'", "port:8888", "localAddress:source", "family:4",
                "Date.now()+10000", "error.code==='ECONNREFUSED'", "socket.once('close'",
                "buffer.length>8192", "HTTP\\/1\\.[01] 403", "CI_PROXY_DESTINATION_OK",
                "x-lares-route-stage")
    if any(value not in PROXY_READINESS_PROBE for value in required) or \
            "X-Lares-Route-Stage" in PROXY_READINESS_PROBE:
        raise RuntimeError("deny-only readiness response contract changed")
    for invalid in (
            ("bad-name", "a" * 32, "lares-outside-proof-0123456789", "192.0.2.14"),
            ("lares-outside-proof-0123456789-proxy-ready", "not-an-owner", "lares-outside-proof-0123456789", "192.0.2.14"),
            ("lares-outside-proof-0123456789-proxy-ready", "a" * 32, "lares-outside-proof-0123456789", "127.0.0.1")):
        try:
            proxy_readiness_start_args(*invalid, "lares-keeper:test@sha256:" + "b" * 64)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("invalid deny-only readiness probe identity was accepted")


def set_network_stage(stage):
    global network_stage
    network_stage = stage if stage in NETWORK_FAILURE_STAGES else "network"


def fixture_failure_record(failure_phase, failure_network_stage):
    safe_phase = failure_phase if failure_phase in SAFE_FAILURE_PHASES else "fixture"
    failure = {"phase": safe_phase, "reason": "fixture operation failed"}
    if safe_phase == "network":
        failure["networkStage"] = (failure_network_stage if failure_network_stage in NETWORK_FAILURE_STAGES
                                   else "network")
    return failure


def offline_network_diagnostics_self_test():
    """Execute production network AST with stub failures, without running network commands."""
    secret_like = "sentinel-secret-config-route-value"
    if NETWORK_FAILURE_STAGES != frozenset({
            "container-name-preflight", "network-name-preflight", "docker-network-inventory",
            "docker-network-inspect", "route-inventory", "subnet-selection", "network-create",
            "network-inspect", "network-isolation-check", "network-ipam-check",
            "network-address-validation", "firewall-preflight"}):
        raise RuntimeError("network diagnostic stage allowlist changed unexpectedly")

    source = ast.parse(pathlib.Path(__file__).read_text(encoding="utf-8"))
    main_try = next(node for node in source.body if isinstance(node, ast.Try) and any(
        isinstance(statement, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "phase"
        for target in statement.targets) and isinstance(statement.value, ast.Constant) and
        statement.value.value == "network" for statement in node.body))

    def phase_assignment(statement, value):
        return isinstance(statement, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "phase" for target in statement.targets
        ) and isinstance(statement.value, ast.Constant) and statement.value.value == value

    def report_network_assignment(statement):
        return isinstance(statement, ast.Assign) and any(
            isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name) and
            target.value.id == "report" and isinstance(target.slice, ast.Constant) and
            target.slice.value == "network" for target in statement.targets)

    setup_start = next(index for index, node in enumerate(main_try.body) if phase_assignment(node, "network"))
    setup_end = next(index for index in range(setup_start, len(main_try.body))
                     if report_network_assignment(main_try.body[index]))
    setup_nodes = main_try.body[setup_start:setup_end + 1]
    selector_node = next(node for node in source.body if isinstance(node, ast.FunctionDef)
                         and node.name == "choose_unused_subnet")
    selector_call = ast.Expr(value=ast.Call(func=ast.Name(id="choose_unused_subnet", ctx=ast.Load()),
                                            args=[], keywords=[]))
    setter_node = next(node for node in source.body if isinstance(node, ast.FunctionDef)
                       and node.name == "set_network_stage")
    firewall_start = next(index for index, node in enumerate(main_try.body) if any(
        isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and
        call.func.id == "set_network_stage" and call.args and
        isinstance(call.args[0], ast.Constant) and call.args[0].value == "firewall-preflight"
        for call in ast.walk(node)))
    firewall_end = next(index for index in range(firewall_start + 1, len(main_try.body))
                        if phase_assignment(main_try.body[index], "fixture-files"))
    firewall_nodes = main_try.body[firewall_start:firewall_end]

    def execute(nodes, namespace):
        module = ast.Module(body=[copy.deepcopy(node) for node in nodes], type_ignores=[])
        exec(compile(ast.fix_missing_locations(module), __file__, "exec"), namespace)

    def base_namespace():
        namespace = {
            "__name__": "outside_network_diagnostic_selftest",
            "NETWORK_FAILURE_STAGES": NETWORK_FAILURE_STAGES,
            "SAFE_FAILURE_PHASES": SAFE_FAILURE_PHASES,
            "fixture_failure_record": fixture_failure_record,
            "json": json, "ipaddress": ipaddress, "secrets": secrets,
            "owner": "a" * 32, "worker_container": "lares-outside-worker-aaaaaaaaaa",
            "network_stage": "network", "report": {},
        }
        execute([setter_node, selector_node], namespace)
        return namespace

    def failure_for(namespace, nodes, expected_stage):
        try:
            execute(nodes, namespace)
        except Exception:
            failure = fixture_failure_record(namespace.get("phase", "network"),
                                             namespace.get("network_stage", "network"))
        else:
            raise RuntimeError("stubbed network operation did not fail")
        if failure != {"phase": "network", "reason": "fixture operation failed",
                       "networkStage": expected_stage}:
            raise RuntimeError("production network operation selected the wrong diagnostic stage")
        if secret_like in json.dumps(failure, sort_keys=True):
            raise RuntimeError("network failure evidence exposed stub output")
        return failure

    selector_stages = {
        "docker-network-inventory": ("inventory",),
        "docker-network-inspect": ("inspect",),
        "route-inventory": ("routes",),
        "subnet-selection": ("no-subnet",),
    }
    for expected_stage, fault in selector_stages.items():
        namespace = base_namespace()

        def selector_command(*args, **kwargs):
            if args[:3] == ("docker", "network", "ls"):
                if fault[0] == "inventory":
                    raise RuntimeError(secret_like)
                return "b" * 64 + "\n" if fault[0] == "inspect" else ""
            if args[:3] == ("docker", "network", "inspect"):
                if fault[0] == "inspect":
                    return secret_like
                raise RuntimeError("unexpected Docker inspect in selector stub")
            if args[:2] == ("ip", "-j"):
                if fault[0] == "routes":
                    raise RuntimeError(secret_like)
                if fault[0] == "no-subnet":
                    return json.dumps([{"dst": "10.0.0.0/8"}])
            raise RuntimeError("unexpected selector command")

        namespace["command"] = selector_command
        failure_for(namespace, [selector_call], expected_stage)

    def selected_from_networks(networks, draws=(0, 0), route_rows=()):
        namespace = base_namespace()
        ids = ["network-" + str(index) for index in range(len(networks))]
        draw_values = iter(draws)
        namespace["secrets"] = type("DeterministicSubnetDraws", (), {
            "randbelow": staticmethod(lambda limit: next(draw_values))})
        calls = []

        def inventory_command(*args, **kwargs):
            calls.append(args)
            if args[:3] == ("docker", "network", "ls"):
                return "\n".join(ids)
            if args[:3] == ("docker", "network", "inspect"):
                return json.dumps(networks)
            if args == ("ip", "-j", "-4", "route", "show"):
                return json.dumps(route_rows)
            raise RuntimeError("unexpected selector inventory command")

        namespace["command"] = inventory_command
        return namespace["choose_unused_subnet"](), namespace, calls

    def network_record(driver, config, *, include_config=True):
        ipam = {"Driver": "default", "Options": None}
        if include_config:
            ipam["Config"] = config
        return {"Name": "fixture", "Driver": driver, "IPAM": ipam}

    builtin_networks = [
        network_record("bridge", [{"Subnet": "172.17.0.0/16"}]),
        network_record("host", None),
        network_record("null", None),
    ]
    selected, namespace, calls = selected_from_networks(builtin_networks)
    if str(selected) != "10.32.0.0/24" or namespace["network_stage"] != "subnet-selection" or \
            calls[-1] != ("ip", "-j", "-4", "route", "show"):
        raise RuntimeError("builtin null-IPAM networks did not preserve normal subnet selection")
    selected, namespace, _ = selected_from_networks([network_record("overlay", [])])
    if str(selected) != "10.32.0.0/24" or namespace["network_stage"] != "subnet-selection":
        raise RuntimeError("empty Docker IPAM config list was not treated as a valid inventory")

    malformed_networks = [
        ("inspect response is not a list", {"Driver": "bridge", "IPAM": {"Config": []}}),
        ("network entry is not an object", [None]),
        ("driver is missing", [{"IPAM": {"Config": []}}]),
        ("driver is not a string", [{"Driver": None, "IPAM": {"Config": []}}]),
        ("IPAM is missing", [{"Driver": "bridge"}]),
        ("IPAM is not an object", [{"Driver": "bridge", "IPAM": None}]),
        ("Config is missing", [network_record("bridge", None, include_config=False)]),
        ("bridge Config is null", [network_record("bridge", None)]),
        ("unknown-driver Config is null", [network_record("custom", None)]),
        ("Config is not a list", [network_record("bridge", {"Subnet": "10.32.0.0/24"})]),
        ("Config entry is null", [network_record("bridge", [None])]),
        ("Config entry is not an object", [network_record("bridge", ["10.32.0.0/24"])]),
        ("Subnet is missing", [network_record("bridge", [{}])]),
        ("Subnet is empty", [network_record("bridge", [{"Subnet": ""}])]),
        ("Subnet is not a string", [network_record("bridge", [{"Subnet": 7}])]),
        ("Subnet is invalid", [network_record("bridge", [{"Subnet": secret_like}])]),
    ]
    for label, inspect_value in malformed_networks:
        namespace = base_namespace()
        namespace["command"] = lambda *args, value=inspect_value, **kwargs: (
            "network-id" if args[:3] == ("docker", "network", "ls") else
            json.dumps(value) if args[:3] == ("docker", "network", "inspect") else
            "[]" if args == ("ip", "-j", "-4", "route", "show") else
            (_ for _ in ()).throw(RuntimeError("unexpected malformed network stub")))
        try:
            namespace["choose_unused_subnet"]()
        except Exception as error:
            if namespace["network_stage"] != "docker-network-inspect" or \
                    label in str(error) or secret_like in str(error) or \
                    "10.32.0.0/24" in str(error):
                raise RuntimeError("malformed network metadata was not safely refused") from None
        else:
            raise RuntimeError("malformed network metadata was accepted: " + label)

    selected, namespace, _ = selected_from_networks(
        [network_record("bridge", [{"Subnet": "10.32.0.0/16"}])], draws=(0, 0, 1, 0))
    if str(selected) != "10.33.0.0/24" or namespace["network_stage"] != "subnet-selection":
        raise RuntimeError("overlapping Docker subnet was not skipped before selecting the next range")

    setup_faults = {
        "container-name-preflight", "network-name-preflight", "network-create",
        "network-inspect", "network-isolation-check", "network-ipam-check",
        "network-address-validation",
    }
    for fault in setup_faults:
        namespace = base_namespace()
        selected_subnet = ipaddress.ip_network(
            "2001:db8::/128" if fault == "network-address-validation" else "192.0.2.0/24")
        namespace["choose_unused_subnet"] = lambda selected=selected_subnet: selected

        def container_stub(name):
            if fault == "container-name-preflight":
                raise RuntimeError(secret_like)
            return None

        def setup_command(*args, **kwargs):
            if args[:3] == ("docker", "network", "ls") and "--filter" in args:
                if fault == "network-name-preflight":
                    raise RuntimeError(secret_like)
                return ""
            if args[:3] == ("docker", "network", "create"):
                if fault == "network-create":
                    raise RuntimeError(secret_like)
                return ""
            if args[:3] == ("docker", "network", "inspect"):
                if fault == "network-inspect":
                    return secret_like
                internal = fault != "network-isolation-check"
                configured = str(selected_subnet)
                if fault == "network-ipam-check":
                    configured = "192.0.3.0/24"
                metadata = {"Internal": internal,
                            "Labels": {"lares.proof": "outside-discovery",
                                       "lares.proof.owner": namespace["owner"]},
                            "IPAM": {"Config": [{"Subnet": configured}]}}
                return json.dumps([metadata])
            raise RuntimeError("unexpected fixture setup command")

        namespace["container_facts"] = container_stub
        namespace["command"] = setup_command
        failure_for(namespace, setup_nodes, fault)

    namespace = base_namespace()
    selected_subnet = ipaddress.ip_network("192.0.2.0/24")
    namespace["choose_unused_subnet"] = lambda: selected_subnet
    namespace["container_facts"] = lambda name: None
    namespace["command"] = lambda *args, **kwargs: (
        json.dumps([{"Internal": True,
                     "Labels": {"lares.proof": "outside-discovery",
                                "lares.proof.owner": namespace["owner"]},
                     "IPAM": {"Config": [{"Subnet": str(selected_subnet)}]}}])
        if args[:3] == ("docker", "network", "inspect") else "")
    execute(setup_nodes, namespace)
    if namespace["report"].get("network", {}).get("subnet") != str(selected_subnet):
        raise RuntimeError("production network setup success path changed in offline context")
    namespace["nft_host"] = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError(secret_like))
    failure_for(namespace, firewall_nodes, "firewall-preflight")

    namespace = base_namespace()
    namespace["set_network_stage"]("untrusted-stage-" + secret_like)
    failure = fixture_failure_record("network", namespace["network_stage"])
    if failure != {"phase": "network", "reason": "fixture operation failed", "networkStage": "network"}:
        raise RuntimeError("unexpected network stage did not use the fixed fallback")
    if secret_like in json.dumps(failure, sort_keys=True):
        raise RuntimeError("network fallback evidence exposed untrusted stage text")
    if "networkStage" in fixture_failure_record("database", "network-create"):
        raise RuntimeError("network stage leaked outside network failure phase")


def write_secret(path, value, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(value, encoding="utf-8")
    path.chmod(mode)


def inspect_local_digest(reference, expected_tag, role):
    if role not in {"keeper", "squid", "firewall"}:
        raise ImageResolutionRefusal("keeper", "reference", "invalid_role")
    if not re.fullmatch(r"[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}", reference):
        raise ImageResolutionRefusal(role, "reference", "invalid_digest_reference")
    if not reference.startswith(expected_tag + "@sha256:"):
        raise ImageResolutionRefusal(role, "reference", "unexpected_tag")
    try:
        digest_output = _image_store_command(
            "digest", "docker", "image", "inspect", reference, "--format", "{{json .Id}}",
            timeout=15, limit=512)
    except ImageStoreRefusal as refusal:
        category = "digest_not_loaded" if refusal.category == "command_failed" else refusal.category
        raise ImageResolutionRefusal(role, "digest", category) from None
    try:
        digest_id = _parse_immutable_image_id(digest_output)
    except RuntimeError:
        raise ImageResolutionRefusal(role, "digest", "invalid_image_id") from None
    try:
        tag_output = _image_store_command(
            "tag", "docker", "image", "inspect", expected_tag, "--format", "{{json .Id}}",
            timeout=15, limit=512)
    except ImageStoreRefusal as refusal:
        category = "tag_not_loaded" if refusal.category == "command_failed" else refusal.category
        raise ImageResolutionRefusal(role, "tag", category) from None
    try:
        tag_id = _parse_immutable_image_id(tag_output)
    except RuntimeError:
        raise ImageResolutionRefusal(role, "tag", "invalid_image_id") from None
    if digest_id != tag_id:
        raise ImageResolutionRefusal(role, "identity", "image_id_mismatch")
    return {"reference": reference, "imageId": digest_id}


class ImageStoreRefusal(Exception):
    def __init__(self, stage, category):
        super().__init__(category)
        self.stage = stage
        self.category = category


class ImageResolutionRefusal(Exception):
    def __init__(self, role, stage, category):
        super().__init__(category)
        self.role = role
        self.stage = stage
        self.category = category


def _parse_immutable_image_id(output):
    try:
        value = json.loads(output.strip())
    except (json.JSONDecodeError, AttributeError):
        raise RuntimeError("local image identity is invalid") from None
    if not isinstance(value, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", value):
        raise RuntimeError("local image identity is invalid")
    return value


def _merge_snapshotter_feature(document):
    if not isinstance(document, dict):
        raise ImageStoreRefusal("config", "non_object")
    result = copy.deepcopy(document)
    features = result.get("features", {})
    if not isinstance(features, dict):
        raise ImageStoreRefusal("config", "features_non_object")
    features["containerd-snapshotter"] = True
    result["features"] = features
    return result


def _unique_json_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate key")
        value[key] = item
    return value


def _reject_json_constant(_value):
    raise ValueError("nonstandard JSON constant")


def _parse_daemon_config(data):
    try:
        value = json.loads(data.decode("utf-8", "strict"), object_pairs_hook=_unique_json_object,
                           parse_constant=_reject_json_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise ImageStoreRefusal("config", "invalid_json") from None
    if not isinstance(value, dict):
        raise ImageStoreRefusal("config", "non_object")
    if "features" in value and not isinstance(value["features"], dict):
        raise ImageStoreRefusal("config", "features_non_object")
    return value


def _safe_config_directory(directory, expected_uid):
    path = pathlib.Path(directory)
    try:
        info = os.lstat(path)
    except OSError:
        raise ImageStoreRefusal("config", "directory_unavailable") from None
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != expected_uid or info.st_mode & 0o022:
        raise ImageStoreRefusal("config", "unsafe_directory")
    return path


def _safe_docker_config_ancestry():
    for directory in ("/etc", "/etc/docker"):
        _safe_config_directory(directory, 0)


def _read_safe_daemon_config(path, expected_uid):
    path = pathlib.Path(path)
    directory = _safe_config_directory(path.parent, expected_uid)
    directory_fd = None
    descriptor = None
    try:
        directory_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) |
                               getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
        directory_info = os.fstat(directory_fd)
        if not stat.S_ISDIR(directory_info.st_mode) or directory_info.st_uid != expected_uid or \
                directory_info.st_mode & 0o022:
            raise ImageStoreRefusal("config", "unsafe_directory")
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0) | \
            getattr(os, "O_NONBLOCK", 0)
        try:
            descriptor = os.open(path.name, flags, dir_fd=directory_fd)
        except FileNotFoundError:
            return {}, None, 0o644, os.getegid()
        except OSError:
            raise ImageStoreRefusal("config", "unsafe_file") from None
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != expected_uid or info.st_nlink != 1 or \
                info.st_mode & 0o022 or info.st_size > 65536:
            raise ImageStoreRefusal("config", "unsafe_file")
        chunks = []
        remaining = 65537
        while remaining:
            chunk = os.read(descriptor, min(8192, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > 65536:
            raise ImageStoreRefusal("config", "oversized")
        return (_parse_daemon_config(data),
                (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns),
                stat.S_IMODE(info.st_mode), info.st_gid)
    finally:
        try:
            if descriptor is not None:
                os.close(descriptor)
        finally:
            if directory_fd is not None:
                os.close(directory_fd)


def _atomic_write_daemon_config(path, document, expected_uid, expected_identity, mode, group_id):
    path = pathlib.Path(path)
    directory = _safe_config_directory(path.parent, expected_uid)
    directory_fd = None
    temporary_name = ".daemon.json.lares-" + uuid.uuid4().hex
    descriptor = None
    try:
        directory_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) |
                               getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
        directory_info = os.fstat(directory_fd)
        if not stat.S_ISDIR(directory_info.st_mode) or directory_info.st_uid != expected_uid or directory_info.st_mode & 0o022:
            raise ImageStoreRefusal("config", "unsafe_directory")
        try:
            current = os.stat(path.name, dir_fd=directory_fd, follow_symlinks=False)
            current_identity = (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns)
        except FileNotFoundError:
            current_identity = None
        except OSError:
            raise ImageStoreRefusal("config", "unsafe_file") from None
        if current_identity != expected_identity:
            raise ImageStoreRefusal("config", "changed_during_update")
        descriptor = os.open(temporary_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                             getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
                             0o600, dir_fd=directory_fd)
        os.fchown(descriptor, expected_uid, group_id)
        os.fchmod(descriptor, mode)
        payload = (json.dumps(document, indent=2, sort_keys=True) + "\n").encode("utf-8")
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise ImageStoreRefusal("config", "write_failed")
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.replace(temporary_name, path.name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        os.fsync(directory_fd)
    except ImageStoreRefusal:
        raise
    except OSError:
        raise ImageStoreRefusal("config", "write_failed") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if directory_fd is not None:
            try:
                os.unlink(temporary_name, dir_fd=directory_fd)
            except FileNotFoundError:
                pass
            os.close(directory_fd)


def _image_store_host_guard(env, uid, system, machine):
    if env.get("CI") != "true" or env.get("GITHUB_ACTIONS") != "true" or \
            env.get("RUNNER_ENVIRONMENT") != "github-hosted":
        raise ImageStoreRefusal("guards", "not_github_hosted_ci")
    if uid != 0 or system != "Linux" or machine != "x86_64":
        raise ImageStoreRefusal("guards", "runner_identity")
    if env.get("LARES_DOCKER_OVERRIDE_PRESENT") != "false" or env.get("DOCKER_HOST") or env.get("DOCKER_CONTEXT"):
        raise ImageStoreRefusal("guards", "docker_override")


def _image_store_command(stage, *args, timeout=10, limit=8192):
    if not isinstance(timeout, (int, float)) or timeout <= 0 or not isinstance(limit, int) or limit <= 0:
        raise ImageStoreRefusal(stage, "invalid_bounds")
    try:
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, bufsize=0, close_fds=True)
    except OSError:
        raise ImageStoreRefusal(stage, "command_unavailable") from None
    deadline = time.monotonic() + timeout
    selector = None
    output = bytearray()
    refusal = None
    result = None
    cleanup_ok = True
    try:
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ImageStoreRefusal(stage, "command_timeout")
            events = selector.select(remaining)
            if not events:
                raise ImageStoreRefusal(stage, "command_timeout")
            for key, _ in events:
                try:
                    chunk = os.read(key.fd, min(4096, limit + 1 - len(output)))
                except OSError:
                    raise ImageStoreRefusal(stage, "command_read_error") from None
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                output.extend(chunk)
                if len(output) > limit:
                    raise ImageStoreRefusal(stage, "command_output_limit")
        remaining = deadline - time.monotonic()
        if process.poll() is None and remaining <= 0:
            raise ImageStoreRefusal(stage, "command_timeout")
        try:
            returncode = process.wait(timeout=max(0.001, remaining))
        except subprocess.TimeoutExpired:
            raise ImageStoreRefusal(stage, "command_timeout") from None
        if returncode != 0:
            raise ImageStoreRefusal(stage, "command_failed")
        try:
            result = bytes(output).decode("utf-8", "strict").strip()
        except UnicodeDecodeError:
            raise ImageStoreRefusal(stage, "command_encoding") from None
    except ImageStoreRefusal as error:
        refusal = error
    except (OSError, ValueError):
        refusal = ImageStoreRefusal(stage, "command_read_error")
    finally:
        if selector is not None:
            try:
                selector.close()
            except (OSError, ValueError):
                cleanup_ok = False
        try:
            running = process.poll() is None
        except (OSError, ValueError):
            running = True
            cleanup_ok = False
        if running:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            except (OSError, ValueError):
                cleanup_ok = False
        try:
            process.wait(timeout=2)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            cleanup_ok = False
        try:
            process.stdout.close()
        except (OSError, ValueError):
            cleanup_ok = False
    if not cleanup_ok:
        raise ImageStoreRefusal(stage, "command_cleanup")
    if refusal is not None:
        raise refusal
    return result


def _docker_socket_guard():
    try:
        mode = os.lstat("/var/run/docker.sock").st_mode
    except OSError:
        raise ImageStoreRefusal("daemon", "socket_unavailable") from None
    if not stat.S_ISSOCK(mode):
        raise ImageStoreRefusal("daemon", "socket_not_local")


def _docker_context_identity(deadline=None):
    def call(stage, *args, limit=8192):
        timeout = 10
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ImageStoreRefusal("readiness", "readiness_timeout")
            timeout = min(timeout, remaining)
        return _image_store_command(stage, *args, timeout=timeout, limit=limit)

    context = call("daemon", "docker", "context", "show", limit=256)
    if context != "default":
        raise ImageStoreRefusal("daemon", "non_default_context")
    endpoint = call("daemon", "docker", "context", "inspect", "default", "--format",
                    "{{json .Endpoints.docker.Host}}", limit=512)
    try:
        if json.loads(endpoint) != "unix:///var/run/docker.sock":
            raise ImageStoreRefusal("daemon", "non_local_endpoint")
    except json.JSONDecodeError:
        raise ImageStoreRefusal("daemon", "context_metadata") from None
    _docker_socket_guard()
    daemon_id = call("daemon", "docker", "info", "--format", "{{json .ID}}", limit=512)
    try:
        value = json.loads(daemon_id)
    except json.JSONDecodeError:
        raise ImageStoreRefusal("daemon", "daemon_metadata") from None
    if not isinstance(value, str) or not value or len(value) > 128:
        raise ImageStoreRefusal("daemon", "daemon_metadata")
    security = call("daemon", "docker", "info", "--format", "{{json .SecurityOptions}}", limit=4096)
    try:
        options = json.loads(security)
    except json.JSONDecodeError:
        raise ImageStoreRefusal("daemon", "daemon_metadata") from None
    if not isinstance(options, list) or any("rootless" in str(item).lower() for item in options):
        raise ImageStoreRefusal("daemon", "rootless_daemon")
    return value


def _require_no_containers():
    inventory = _image_store_command("container_guard", "docker", "ps", "--all", "--quiet", "--no-trunc",
                                     timeout=15, limit=16384)
    if inventory:
        raise ImageStoreRefusal("container_guard", "containers_present")


def _snapshotter_driver_ready():
    rendered = _image_store_command("driver", "docker", "info", "--format", "{{json .DriverStatus}}",
                                    timeout=10, limit=8192)
    try:
        status = json.loads(rendered)
    except json.JSONDecodeError:
        raise ImageStoreRefusal("driver", "driver_metadata") from None
    if not isinstance(status, list):
        return False
    matches = [pair for pair in status if isinstance(pair, list) and len(pair) == 2 and
               pair[0] == "driver-type" and pair[1] == "io.containerd.snapshotter.v1"]
    return len(matches) == 1


def prepare_image_store():
    _image_store_host_guard(os.environ, os.geteuid(), platform.system(), platform.machine())
    if not re.fullmatch(r"[0-9a-f]{40}", os.environ.get("GITHUB_SHA", "")):
        raise ImageStoreRefusal("guards", "source_revision")
    actual_sha = _image_store_command("source", "git", "-C", str(repo), "rev-parse", "HEAD",
                                      timeout=5, limit=128)
    if actual_sha != os.environ["GITHUB_SHA"]:
        raise ImageStoreRefusal("source", "source_revision")
    daemon_id_before = _docker_context_identity()
    _require_no_containers()
    path = pathlib.Path("/etc/docker/daemon.json")
    _safe_docker_config_ancestry()
    original, identity, mode, group_id = _read_safe_daemon_config(path, 0)
    updated = _merge_snapshotter_feature(original)
    changed = updated != original
    if changed:
        _atomic_write_daemon_config(path, updated, 0, identity, mode, group_id)
        _image_store_command("restart", "systemctl", "restart", "docker", timeout=90, limit=2048)
    deadline = time.monotonic() + (90 if changed else 10)
    daemon_id_after = None
    last_category = None
    while time.monotonic() < deadline:
        try:
            daemon_id_after = _docker_context_identity(deadline)
            break
        except ImageStoreRefusal as refusal:
            last_category = refusal.category
            time.sleep(0.5)
    if daemon_id_after is None:
        raise ImageStoreRefusal("readiness", last_category or "daemon_unavailable")
    if daemon_id_after != daemon_id_before:
        raise ImageStoreRefusal("readiness", "daemon_identity_changed")
    _require_no_containers()
    if not _snapshotter_driver_ready():
        raise ImageStoreRefusal("driver", "snapshotter_unavailable")
    return {"changed": changed, "driver": "io.containerd.snapshotter.v1"}


def nft_host(*args, check=True):
    name = "lares-outside-nft-" + owner[:10] + "-" + uuid.uuid4().hex[:6]
    result = run("docker", "run", "--name", name, "--label", "lares.proof.owner=" + owner,
                 "--network", "host", "--read-only", "--cap-drop", "ALL", "--cap-add", "NET_ADMIN",
                 "--entrypoint", "nft", firewall_ref, *args, check=check, timeout=30)
    remove_owned_container(name, owner, timeout=15)
    return result


def container_facts(name):
    result = run("docker", "inspect", "--format",
                 "{{json .Id}}|{{json .Config.Labels}}|{{json .State.Running}}|{{json .State.Status}}|{{json .State.ExitCode}}|{{json .Image}}|{{json .Mounts}}",
                 name, check=False, timeout=15)
    if result.returncode:
        if re.fullmatch(r"[a-f0-9]{64}", name):
            remaining = run("docker", "ps", "--all", "--quiet", "--no-trunc", "--filter", "id=" + name,
                            check=False, timeout=15)
        else:
            remaining = run("docker", "ps", "--all", "--quiet", "--no-trunc", "--filter", "name=^/" + name + "$",
                            check=False, timeout=15)
        if remaining.returncode == 0 and not remaining.stdout.strip():
            return None
        raise RuntimeError("fixture container state could not be verified")
    parts = result.stdout.strip().split("|")
    if len(parts) != 7:
        raise RuntimeError("fixture container ownership could not be verified")
    try:
        facts = [json.loads(part) for part in parts]
    except json.JSONDecodeError:
        raise RuntimeError("fixture container ownership could not be verified") from None
    if not isinstance(facts[0], str) or not re.fullmatch(r"[a-f0-9]{64}", facts[0]):
        raise RuntimeError("fixture container identity is invalid")
    return {"id": facts[0], "labels": facts[1] or {}, "running": facts[2], "status": facts[3],
            "exitCode": facts[4], "imageId": facts[5], "mounts": facts[6] or []}


def remove_owned_container(name, expected_owner, timeout=30):
    facts = container_facts(name)
    if facts is None:
        return True
    if facts["labels"].get("lares.proof.owner") != expected_owner:
        raise RuntimeError("fixture refused to remove a container without its exact owner label")
    pinned_id = facts["id"]
    if facts["running"] is True:
        run("docker", "stop", "--time", "3", pinned_id, timeout=timeout)
    facts = container_facts(pinned_id)
    if facts is None:
        return container_facts(name) is None
    if facts["id"] != pinned_id or facts["labels"].get("lares.proof.owner") != expected_owner or facts["running"] is True:
        raise RuntimeError("owned fixture container did not stop safely")
    run("docker", "rm", pinned_id, timeout=timeout)
    remaining_id = container_facts(pinned_id)
    remaining_name = container_facts(name)
    if remaining_name is not None and remaining_name["id"] != pinned_id:
        raise RuntimeError("fixture name was replaced after ownership inspection")
    return remaining_id is None and remaining_name is None


def stop_pinned_worker(pinned_id, expected_owner):
    facts = container_facts(pinned_id)
    if facts is None:
        return True, False
    if facts["id"] != pinned_id or facts["labels"].get("lares.proof.owner") != expected_owner:
        return False, False
    stop_failed = False
    if facts["running"] is True:
        try:
            stopped = run("docker", "stop", "--time", "3", pinned_id, check=False, timeout=15)
            stop_failed = stopped.returncode != 0
        except Exception:
            stop_failed = True
    try:
        final = container_facts(pinned_id)
    except Exception:
        return False, True
    stopped = final is None or (final["id"] == pinned_id and
        final["labels"].get("lares.proof.owner") == expected_owner and final["running"] is False)
    return stopped, stop_failed


def stop_worker_then_helpers(pinned_id, expected_owner, root_path):
    stopped, stop_failed = stop_pinned_worker(pinned_id, expected_owner)
    if not stopped:
        return False, stop_failed, False
    remove_owned_docker_helpers(root_path)
    return True, stop_failed, True


def discover_owned_docker_helpers(root_path):
    """Find only real ownedDocker helper children bound to this unique proof directory."""
    ids = command("docker", "ps", "--all", "--quiet", "--no-trunc").splitlines()
    if len(ids) > 2000 or any(not re.fullmatch(r"[a-f0-9]{64}", value) for value in ids):
        raise RuntimeError("fixture helper inventory could not be verified")
    expected_images = {report.get("images", {}).get("squid", {}).get("imageId"),
                       report.get("images", {}).get("firewall", {}).get("imageId")}
    sources = {str(root_path / "egress")}
    matches = []
    for container_id in ids:
        result = run("docker", "inspect", "--format", "{{json .Id}}|{{json .Image}}|{{json .State.Running}}|{{json .Mounts}}",
                     container_id, check=False, timeout=15)
        if result.returncode:
            raise RuntimeError("fixture helper inventory changed during inspection")
        try:
            identity, image_id, running, mounts = (json.loads(value) for value in result.stdout.strip().split("|"))
        except (ValueError, json.JSONDecodeError):
            raise RuntimeError("fixture helper inventory could not be parsed") from None
        if not isinstance(mounts, list):
            raise RuntimeError("fixture helper mount inventory is invalid")
        if identity != container_id:
            raise RuntimeError("fixture helper identity changed during inspection")
        exact_mount = any(mount.get("Type") == "bind" and mount.get("Source") in sources for mount in mounts)
        if exact_mount and image_id in expected_images:
            matches.append({"id": identity, "running": running})
    return matches


def remove_owned_docker_helpers(root_path):
    helpers = discover_owned_docker_helpers(root_path)
    failed = False
    for helper in helpers:
        try:
            if helper["running"] is True:
                run("docker", "stop", "--time", "3", helper["id"], timeout=15)
            facts = run("docker", "inspect", "--format", "{{json .Id}}|{{json .Image}}|{{json .State.Running}}|{{json .Mounts}}",
                        helper["id"], check=False, timeout=15)
            if facts.returncode:
                continue
            try:
                identity, image_id, running, mounts = (json.loads(value) for value in facts.stdout.strip().split("|"))
            except (ValueError, json.JSONDecodeError):
                raise RuntimeError("fixture helper cleanup ownership could not be verified") from None
            if identity != helper["id"] or image_id not in {
                    report.get("images", {}).get("squid", {}).get("imageId"),
                    report.get("images", {}).get("firewall", {}).get("imageId")} or running is True or not any(
                        mount.get("Type") == "bind" and mount.get("Source") == str(root_path / "egress")
                        for mount in mounts if isinstance(mount, dict)):
                raise RuntimeError("fixture helper cleanup ownership could not be verified")
            run("docker", "rm", helper["id"], timeout=15)
        except Exception:
            failed = True
    if discover_owned_docker_helpers(root_path):
        failed = True
    if failed:
        raise RuntimeError("owned Docker helpers did not all stop and disappear")


def remove_labelled_containers(expected_owner):
    ids = command("docker", "ps", "--all", "--quiet", "--no-trunc", "--filter",
                  "label=lares.proof.owner=" + expected_owner).splitlines()
    if len(ids) > 64 or any(not re.fullmatch(r"[a-f0-9]{64}", value) for value in ids):
        raise RuntimeError("fixture owned-container inventory is invalid")
    failed = False
    for container_id in ids:
        try:
            facts = container_facts(container_id)
            if facts is None or facts["id"] != container_id or facts["labels"].get("lares.proof.owner") != expected_owner:
                raise RuntimeError("fixture refused to remove a container without exact ownership")
            if facts["running"] is True:
                run("docker", "stop", "--time", "3", container_id, timeout=20)
            facts = container_facts(container_id)
            if facts is None:
                continue
            if facts["id"] != container_id or facts["labels"].get("lares.proof.owner") != expected_owner or facts["running"] is True:
                raise RuntimeError("owned fixture container did not stop safely")
            run("docker", "rm", container_id, timeout=20)
            if container_facts(container_id) is not None:
                raise RuntimeError("owned container ID remained after removal")
        except Exception:
            failed = True
    remaining = command("docker", "ps", "--all", "--quiet", "--no-trunc", "--filter",
                        "label=lares.proof.owner=" + expected_owner)
    if failed or remaining.strip():
        raise RuntimeError("owned fixture container remained after cleanup")


def cleanup_exact_network(name, expected_owner):
    if not name:
        return
    ids = command("docker", "network", "ls", "--quiet", "--no-trunc", "--filter", "name=^" + name + "$").splitlines()
    if len(ids) > 1 or any(not re.fullmatch(r"[a-f0-9]{64}", value) for value in ids):
        raise RuntimeError("fixture network inventory is ambiguous")
    if not ids:
        return
    metadata = json.loads(command("docker", "network", "inspect", ids[0]))
    if len(metadata) != 1 or metadata[0].get("Name") != name or metadata[0].get("Labels", {}).get("lares.proof.owner") != expected_owner:
        raise RuntimeError("fixture refused to remove a network without exact ownership")
    if metadata[0].get("Containers"):
        raise RuntimeError("fixture network still has attached containers")
    command("docker", "network", "rm", ids[0])
    remaining = command("docker", "network", "ls", "--quiet", "--no-trunc", "--filter", "name=^" + name + "$")
    if remaining.strip():
        raise RuntimeError("owned fixture network remained after cleanup")


def remove_generated_firewall(root_path, expected_source):
    table_lines = nft_host("list", "tables", check=False)
    if table_lines.returncode:
        raise RuntimeError("fixture firewall inventory could not be verified")
    exists = any(line.strip() == "table inet lares_egress" for line in table_lines.stdout.splitlines())
    if not exists:
        return
    installed = root_path / "egress" / "installed-stage"
    try:
        stage = installed.read_text(encoding="ascii").strip()
    except OSError:
        raise RuntimeError("fixture firewall ownership evidence is missing") from None
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", stage):
        raise RuntimeError("fixture firewall stage identity is invalid")
    generated = root_path / "egress" / (stage + ".nft")
    try:
        contents = generated.read_text(encoding="ascii")
    except OSError:
        raise RuntimeError("fixture generated firewall source is missing") from None
    if "# Generated by keeper; apply the whole file atomically with nft -f." not in contents or \
            not re.search(r"ip saddr != \{[^}]*\b" + re.escape(expected_source) + r"\b[^}]*\}", contents):
        raise RuntimeError("fixture firewall stage does not identify its selected source")
    nft_host("delete", "table", "inet", "lares_egress")
    after = nft_host("list", "tables", check=False)
    if after.returncode or any(line.strip() == "table inet lares_egress" for line in after.stdout.splitlines()):
        raise RuntimeError("fixture firewall table remained after cleanup")


def safe_cleanup(label, action):
    global cleanup_failures
    try:
        action()
        return True
    except Exception:
        cleanup_failures.append(label)
        return False


def import_worker_evidence(root_path):
    """Accept only fixed worker fields and enum values; never copy arbitrary worker output."""
    worker_path = root_path / "worker.json"
    try:
        value = json.loads(worker_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    valid_checks = {
        "actual configured lares_app and lares_outside_custody logins",
        "neutral definition, finite human session and real owner adoption/use grant",
        "public saved lifecycle installed and acknowledged generated route without native authority",
        "direct target traffic increments generated drop counter and closes TCP before TLS",
        "normal consentAndDiscover returned bounded two-page JSON and SSE projection",
        "durable result decrypts under generated key/AAD and rejects changed request identity",
        "executable definition, ownership and applied state remain unchanged",
    }
    phases = {"configuration", "role identities", "neutral authorization fixture",
              "generated route admission", "direct-path firewall counter", "worker"}
    route_boundaries = {"runtime-stop", "squid-validation", "firewall-check", "firewall-apply",
                        "proxy-reload", "route-acknowledgement"}
    checks = value.get("checks")
    failure = value.get("failure")
    if not isinstance(checks, list) or any(not isinstance(item, str) or item not in valid_checks for item in checks):
        return None
    if value.get("success") is True and set(checks) != valid_checks:
        return None
    evidence = {"checks": checks, "firewallApplied": value.get("firewallApplied") is True,
                "directTargetBlocked": value.get("directTargetBlocked") is True,
                "success": value.get("success") is True}
    if isinstance(failure, dict):
        phase_value = failure.get("phase")
        reason_value = failure.get("reason")
        route_boundary = failure.get("routeBoundary")
        if "routeBoundary" in failure and (phase_value != "generated route admission" or
                                             not isinstance(route_boundary, str) or
                                             route_boundary not in route_boundaries):
            return None
        acknowledgement_reason = failure.get("acknowledgementReason")
        if "acknowledgementReason" in failure and (phase_value != "generated route admission" or
                                                     route_boundary != "route-acknowledgement" or
                                                     not isinstance(acknowledgement_reason, str) or
                                                     acknowledgement_reason not in ACKNOWLEDGEMENT_REASONS):
            return None
        evidence["failure"] = {
            "phase": phase_value if phase_value in phases else "worker",
            "reason": reason_value if reason_value == "configured outside discovery worker failed" else "worker failed",
        }
        if "routeBoundary" in failure:
            evidence["failure"]["routeBoundary"] = route_boundary
        if "acknowledgementReason" in failure:
            evidence["failure"]["acknowledgementReason"] = acknowledgement_reason
    return evidence


def offline_cleanup_self_test():
    """Exercise partial starts, pinned names, stop recovery, timeout continuation and safe evidence."""
    secret_like = "sentinel-secret-config-route-value"
    probe_owner = "a" * 32
    container_id = "b" * 64
    facts = {"id": container_id, "labels": {"lares.proof.owner": probe_owner},
             "running": True, "status": "running", "exitCode": 0, "imageId": "sha256:" + "c" * 64, "mounts": []}
    present = {container_id: facts}
    actions = []

    def fake_command(*args, **kwargs):
        if args[:4] == ("docker", "ps", "--all", "--quiet"):
            return "\n".join(present)
        raise AssertionError("unexpected cleanup command")

    def fake_facts(name):
        return present.get(name)

    def fake_run(*args, **kwargs):
        actions.append(args[1])
        if args[1] == "stop":
            present[container_id]["running"] = False
        elif args[1] == "rm":
            present.pop(container_id, None)
        return subprocess.CompletedProcess(args, 0, "", "")

    with patch(__name__ + ".command", fake_command), patch(__name__ + ".container_facts", fake_facts), \
            patch(__name__ + ".run", fake_run):
        remove_labelled_containers(probe_owner)
    if actions != ["stop", "rm"] or present:
        raise RuntimeError("partial-start owner cleanup regression")

    original_id, replacement_id = "d" * 64, "e" * 64
    name_map = {"replaceable-worker": original_id}
    by_id = {
        original_id: {"id": original_id, "labels": {"lares.proof.owner": probe_owner}, "running": True},
        replacement_id: {"id": replacement_id, "labels": {"lares.proof.owner": "f" * 32}, "running": True},
    }
    targeted = []

    def replacement_facts(identity):
        target = name_map.get(identity, identity)
        return by_id.get(target)

    def replacement_run(*args, **kwargs):
        action, target = args[1], args[-1]
        targeted.append((action, target))
        if action == "stop" and target == original_id:
            by_id[original_id]["running"] = False
            name_map["replaceable-worker"] = replacement_id
        elif action == "rm" and target == original_id:
            by_id.pop(original_id, None)
        return subprocess.CompletedProcess(args, 0, "", "")

    with patch(__name__ + ".container_facts", replacement_facts), patch(__name__ + ".run", replacement_run):
        try:
            remove_owned_container("replaceable-worker", probe_owner)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("container-name replacement was not detected")
    if targeted != [("stop", original_id), ("rm", original_id)] or replacement_id not in by_id:
        raise RuntimeError("cleanup acted on a replacement container name")

    timed_worker_id = "9" * 64
    timed_worker = {"id": timed_worker_id, "labels": {"lares.proof.owner": probe_owner}, "running": True}
    timed_actions = []
    prior_timeout = True
    worker_stopped = False
    helper_cleanup = []

    def timed_facts(identity):
        return timed_worker if identity == timed_worker_id else None

    def timed_run(*args, **kwargs):
        timed_actions.append(args[1:])
        if args[1] == "stop":
            timed_worker["running"] = False
        return subprocess.CompletedProcess(args, 0, "", "")

    with patch(__name__ + ".container_facts", timed_facts), patch(__name__ + ".run", timed_run), \
            patch(__name__ + ".remove_owned_docker_helpers", lambda path: helper_cleanup.append(path)):
        worker_stopped, stop_failed, helpers_removed = stop_worker_then_helpers(
            timed_worker_id, probe_owner, pathlib.Path("/fixture-root"))
    if not prior_timeout or not worker_stopped or stop_failed or not helpers_removed or not helper_cleanup:
        raise RuntimeError("verified worker stop did not release helper cleanup after the main timeout")
    if not timed_actions or timed_actions[0][0:3] != ("stop", "--time", "3") or timed_actions[0][-1] != timed_worker_id:
        raise RuntimeError("worker cleanup did not stop the pinned ID")

    cleanup_failures.clear()
    continued = []
    def timed_out_action():
        raise RuntimeError("simulated bounded cleanup timeout")
    safe_cleanup("simulated-timeout", timed_out_action)
    safe_cleanup("following-cleanup", lambda: continued.append(True))
    if continued != [True] or cleanup_failures != ["simulated-timeout"]:
        raise RuntimeError("cleanup timeout prevented independent cleanup")

    with tempfile.TemporaryDirectory(prefix="lares-outside-proof-selftest-") as directory:
        worker_path = pathlib.Path(directory) / "worker.json"
        worker_path.write_text(json.dumps({"success": False, "checks": [],
            "failure": {"phase": "generated route admission", "reason": "credential-secret-detail"}}), encoding="utf-8")
        evidence = import_worker_evidence(pathlib.Path(directory))
        if not evidence or evidence.get("failure") != {
                "phase": "generated route admission", "reason": "worker failed"}:
            raise RuntimeError("worker failure artifact was not reduced to allowlisted fields")
        worker_path.write_text(json.dumps({"success": False, "checks": [],
            "failure": {"phase": "generated route admission", "reason": "worker failed",
                        "routeBoundary": "firewall-check"}}), encoding="utf-8")
        evidence = import_worker_evidence(pathlib.Path(directory))
        if not evidence or evidence.get("failure", {}).get("routeBoundary") != "firewall-check":
            raise RuntimeError("fixed route boundary label was not retained")
        for reason in sorted(ACKNOWLEDGEMENT_REASONS):
            worker_path.write_text(json.dumps({"success": False, "checks": [],
                "failure": {"phase": "generated route admission", "reason": "worker failed",
                            "routeBoundary": "route-acknowledgement", "acknowledgementReason": reason}}), encoding="utf-8")
            evidence = import_worker_evidence(pathlib.Path(directory))
            if not evidence or evidence.get("failure", {}).get("acknowledgementReason") != reason:
                raise RuntimeError("fixed acknowledgement reason was not retained")
        for phase, boundary, reason in (
                ("worker", "route-acknowledgement", "stage-absent"),
                ("generated route admission", "firewall-check", "stage-absent"),
                ("generated route admission", "route-acknowledgement", secret_like),
                ("generated route admission", "route-acknowledgement", {"reason": "connection-error"})):
            worker_path.write_text(json.dumps({"success": False, "checks": [],
                "failure": {"phase": phase, "reason": "worker failed", "routeBoundary": boundary,
                            "acknowledgementReason": reason}}), encoding="utf-8")
            if import_worker_evidence(pathlib.Path(directory)) is not None:
                raise RuntimeError("unsafe acknowledgement reason was accepted")
        for untrusted in ("credential-secret-detail", "firewall-check /secret", "", ["firewall-check"],
                          {"label": "firewall-check"}):
            worker_path.write_text(json.dumps({"success": False, "checks": [],
                "failure": {"phase": "generated route admission", "reason": "worker failed",
                            "routeBoundary": untrusted}}), encoding="utf-8")
            if import_worker_evidence(pathlib.Path(directory)) is not None:
                raise RuntimeError("unrecognized route boundary detail was not rejected")
        worker_path.write_text(json.dumps({"success": False, "checks": [],
            "failure": {"phase": "worker", "reason": "worker failed",
                        "routeBoundary": "firewall-check"}}), encoding="utf-8")
        if import_worker_evidence(pathlib.Path(directory)) is not None:
            raise RuntimeError("route boundary label was accepted outside its fixed phase")


def postgres_ready(container, password):
    for _ in range(90):
        result = run("docker", "exec", "-e", "PGPASSWORD=" + password, container,
                     "psql", "-X", "-h", "127.0.0.1", "-U", "proof", "-d", "proof",
                     "-Atc", "SELECT 1", timeout=5, check=False)
        if result.returncode == 0 and result.stdout.strip() == "1":
            return
        time.sleep(.2)
    raise RuntimeError("isolated fixture database did not become ready")


def choose_unused_subnet():
    global network_stage
    set_network_stage("docker-network-inventory")
    ids = command("docker", "network", "ls", "--quiet").splitlines()
    occupied = []
    if ids:
        set_network_stage("docker-network-inspect")
        networks = json.loads(command("docker", "network", "inspect", *ids))
        if not isinstance(networks, list):
            raise RuntimeError("existing Docker network inventory is invalid")
        for network_info in networks:
            if not isinstance(network_info, dict):
                raise RuntimeError("existing Docker network metadata is invalid")
            driver = network_info.get("Driver")
            ipam = network_info.get("IPAM")
            if not isinstance(driver, str) or not isinstance(ipam, dict) or "Config" not in ipam:
                raise RuntimeError("existing Docker network address metadata is invalid")
            config = ipam["Config"]
            if config is None and driver in {"host", "null"}:
                continue
            if not isinstance(config, list):
                raise RuntimeError("existing Docker network address metadata is invalid")
            for entry in config:
                if not isinstance(entry, dict):
                    raise RuntimeError("existing Docker network address metadata is invalid")
                value = entry.get("Subnet")
                if not isinstance(value, str) or not value:
                    raise RuntimeError("existing Docker network address metadata is invalid")
                try:
                    occupied.append(ipaddress.ip_network(value, strict=False))
                except ValueError:
                    raise RuntimeError("existing Docker network has invalid address metadata") from None
    set_network_stage("route-inventory")
    routes = json.loads(command("ip", "-j", "-4", "route", "show"))
    for route in routes:
        destination = route.get("dst")
        if destination and destination != "default":
            try:
                occupied.append(ipaddress.ip_network(destination, strict=False))
            except ValueError:
                raise RuntimeError("runner route has invalid address metadata") from None
    set_network_stage("subnet-selection")
    for _ in range(128):
        candidate = ipaddress.ip_network(f"10.{secrets.randbelow(192) + 32}.{secrets.randbelow(256)}.0/24")
        if not any(candidate.overlaps(value) for value in occupied):
            return candidate
    raise RuntimeError("no unused private Docker subnet was found")


def offline_image_store_self_test():
    original = {"debug": False, "features": {"other-feature": True}, "registry-mirrors": ["https://mirror.invalid"]}
    merged = _merge_snapshotter_feature(original)
    if merged.get("debug") is not False or merged.get("registry-mirrors") != original["registry-mirrors"] or \
            merged["features"] != {"other-feature": True, "containerd-snapshotter": True} or \
            original["features"] != {"other-feature": True}:
        raise RuntimeError("daemon config merge regression")
    if _merge_snapshotter_feature({"features": {"containerd-snapshotter": True}})["features"]["containerd-snapshotter"] is not True:
        raise RuntimeError("enabled snapshotter was not preserved")
    if _merge_snapshotter_feature({"features": {"containerd-snapshotter": False}})["features"]["containerd-snapshotter"] is not True:
        raise RuntimeError("disabled snapshotter was not enabled")
    for content, category in ((b"[]", "non_object"), (b'{"features":[]}', "features_non_object"),
                              (b'{"x":1,"x":2}', "invalid_json"), (b"{", "invalid_json"),
                              (b'{"count":NaN}', "invalid_json")):
        try:
            _parse_daemon_config(content)
        except ImageStoreRefusal as refusal:
            if refusal.category != category:
                raise RuntimeError("daemon config refusal category changed") from None
        else:
            raise RuntimeError("unsafe daemon config was accepted")

    uid = os.geteuid()
    with tempfile.TemporaryDirectory(prefix="lares-image-store-selftest-") as directory:
        parent = pathlib.Path(directory)
        config = parent / "daemon.json"
        payload = json.dumps(original).encode("utf-8")
        config.write_bytes(payload)
        config.chmod(0o640)
        loaded, identity, mode, group_id = _read_safe_daemon_config(config, uid)
        if loaded != original or identity is None or mode != 0o640 or group_id != os.stat(config).st_gid:
            raise RuntimeError("safe daemon config read regression")
        _atomic_write_daemon_config(config, merged, uid, identity, mode, group_id)
        if _read_safe_daemon_config(config, uid)[0] != merged or stat.S_IMODE(os.stat(config).st_mode) != mode:
            raise RuntimeError("atomic daemon config merge regression")
        link = parent / "daemon-link.json"
        link.symlink_to(config)
        try:
            _read_safe_daemon_config(link, uid)
        except ImageStoreRefusal as refusal:
            if refusal.category != "unsafe_file":
                raise RuntimeError("daemon config symlink refusal category changed") from None
        else:
            raise RuntimeError("daemon config symlink was accepted")
        fifo = parent / "daemon-fifo.json"
        os.mkfifo(fifo, 0o600)
        opened_descriptors = []
        real_open = os.open

        def track_open(*args, **kwargs):
            descriptor = real_open(*args, **kwargs)
            opened_descriptors.append(descriptor)
            return descriptor

        start = time.monotonic()
        with patch(__name__ + ".os.open", side_effect=track_open):
            try:
                _read_safe_daemon_config(fifo, uid)
            except ImageStoreRefusal as refusal:
                if refusal.category != "unsafe_file":
                    raise RuntimeError("FIFO config refusal category changed") from None
            else:
                raise RuntimeError("FIFO daemon config was accepted")
        if time.monotonic() - start >= 1 or len(opened_descriptors) != 2:
            raise RuntimeError("FIFO daemon config refusal was not bounded")
        for descriptor in opened_descriptors:
            try:
                os.fstat(descriptor)
            except OSError:
                continue
            raise RuntimeError("daemon config refusal leaked a file descriptor")
        absent = parent / "absent-daemon.json"
        empty, empty_identity, empty_mode, empty_group = _read_safe_daemon_config(absent, uid)
        if empty != {} or empty_identity is not None or empty_mode != 0o644 or empty_group != os.getegid():
            raise RuntimeError("absent daemon config handling regression")
        _atomic_write_daemon_config(absent, _merge_snapshotter_feature(empty), uid,
                                    empty_identity, empty_mode, empty_group)
        if _read_safe_daemon_config(absent, uid)[0] != {"features": {"containerd-snapshotter": True}}:
            raise RuntimeError("new daemon config creation regression")

    env = {"CI": "true", "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
           "LARES_DOCKER_OVERRIDE_PRESENT": "false"}
    _image_store_host_guard(env, 0, "Linux", "x86_64")
    for changed, expected in (({**env, "RUNNER_ENVIRONMENT": "self-hosted"}, "not_github_hosted_ci"),
                             ({**env, "LARES_DOCKER_OVERRIDE_PRESENT": "true"}, "docker_override"),
                             ({**env, "DOCKER_HOST": "tcp://example.invalid"}, "docker_override"),
                             ({**env, "DOCKER_CONTEXT": "remote"}, "docker_override")):
        try:
            _image_store_host_guard(changed, 0, "Linux", "x86_64")
        except ImageStoreRefusal as refusal:
            if refusal.category != expected:
                raise RuntimeError("image store host guard category changed") from None
        else:
            raise RuntimeError("image store host guard accepted a forbidden environment")
    try:
        _image_store_host_guard(env, 501, "Linux", "x86_64")
    except ImageStoreRefusal as refusal:
        if refusal.category != "runner_identity":
            raise RuntimeError("image store root guard category changed") from None
    else:
        raise RuntimeError("image store host guard accepted a non-root runner")

    tag = "lares-keeper:test"
    reference = tag + "@sha256:" + "a" * 64
    same_id = '"sha256:' + "b" * 64 + '"\n'
    with patch(__name__ + "._image_store_command", side_effect=[same_id.strip(), same_id.strip()]) as mocked:
        resolved = inspect_local_digest(reference, tag, "keeper")
    if resolved != {"reference": reference, "imageId": "sha256:" + "b" * 64} or mocked.call_count != 2 or \
            mocked.call_args_list[0].args[4] != reference or mocked.call_args_list[1].args[4] != tag:
        raise RuntimeError("exact local tag and digest resolution regression")
    cases = [
        ([same_id.strip(), '"sha256:' + "c" * 64 + '"'], "identity", "image_id_mismatch"),
        ([ImageStoreRefusal("digest", "command_failed")], "digest", "digest_not_loaded"),
        ([ImageStoreRefusal("digest", "command_output_limit")], "digest", "command_output_limit"),
        ([ImageStoreRefusal("digest", "command_timeout")], "digest", "command_timeout"),
        ([ImageStoreRefusal("digest", "command_read_error")], "digest", "command_read_error"),
        ([ImageStoreRefusal("digest", "command_cleanup")], "digest", "command_cleanup"),
        (["not-json"], "digest", "invalid_image_id"),
        ([same_id.strip(), ImageStoreRefusal("tag", "command_failed")], "tag", "tag_not_loaded"),
        ([same_id.strip(), ImageStoreRefusal("tag", "command_timeout")], "tag", "command_timeout"),
        ([same_id.strip(), "not-json"], "tag", "invalid_image_id"),
    ]
    for results, expected_stage, expected_category in cases:
        with patch(__name__ + "._image_store_command", side_effect=results):
            try:
                inspect_local_digest(reference, tag, "keeper")
            except ImageResolutionRefusal as refusal:
                if (refusal.role, refusal.stage, refusal.category) != (
                        "keeper", expected_stage, expected_category):
                    raise RuntimeError("safe image resolution category regression") from None
            else:
                raise RuntimeError("unverified local image identity was accepted")

    class FakeBoundedProcess:
        def __init__(self, stdout, *, cleanup_timeout=False):
            self.stdout = stdout
            self.returncode = None
            self.killed = False
            self.waited = False
            self.cleanup_timeout = cleanup_timeout

        def poll(self):
            return self.returncode

        def kill(self):
            self.killed = True
            self.returncode = -9

        def wait(self, timeout=None):
            self.waited = True
            if self.cleanup_timeout:
                raise subprocess.TimeoutExpired("fixed-command", timeout)
            if self.returncode is None:
                self.returncode = 0
            return self.returncode

    def pipe_process(payload=b"", *, keep_open=False, cleanup_timeout=False):
        read_fd, write_fd = os.pipe()
        if payload:
            os.write(write_fd, payload)
        if not keep_open:
            os.close(write_fd)
            write_fd = None
        return FakeBoundedProcess(os.fdopen(read_fd, "rb", buffering=0),
                                  cleanup_timeout=cleanup_timeout), write_fd

    process, writer = pipe_process(b"12345")
    try:
        with patch(__name__ + ".subprocess.Popen", return_value=process) as popen:
            try:
                _image_store_command("oversize", "fixed-command", timeout=1, limit=4)
            except ImageStoreRefusal as refusal:
                if refusal.category != "command_output_limit":
                    raise RuntimeError("bounded output refusal category changed") from None
            else:
                raise RuntimeError("oversized command output was accepted")
        if not process.killed or not process.waited or not process.stdout.closed or \
                popen.call_args.kwargs.get("stderr") != subprocess.DEVNULL:
            raise RuntimeError("oversized command was not killed, reaped and closed")
    finally:
        if writer is not None:
            os.close(writer)

    process, writer = pipe_process(b"x", keep_open=True)
    try:
        with patch(__name__ + ".subprocess.Popen", return_value=process):
            try:
                _image_store_command("timeout", "fixed-command", timeout=0.02, limit=4)
            except ImageStoreRefusal as refusal:
                if refusal.category != "command_timeout":
                    raise RuntimeError("bounded timeout refusal category changed") from None
            else:
                raise RuntimeError("stalled command output was accepted")
        if not process.killed or not process.waited or not process.stdout.closed:
            raise RuntimeError("timed-out command was not killed, reaped and closed")
    finally:
        os.close(writer)

    process, writer = pipe_process(b"x")
    try:
        with patch(__name__ + ".subprocess.Popen", return_value=process), \
                patch(__name__ + ".os.read", side_effect=OSError("private read failure")):
            try:
                _image_store_command("read", "fixed-command", timeout=1, limit=4)
            except ImageStoreRefusal as refusal:
                if refusal.category != "command_read_error":
                    raise RuntimeError("bounded read-error refusal category changed") from None
            else:
                raise RuntimeError("command read failure was accepted")
        if not process.killed or not process.waited or not process.stdout.closed:
            raise RuntimeError("read-error command was not killed, reaped and closed")
    finally:
        if writer is not None:
            os.close(writer)

    process, writer = pipe_process(b"12345", cleanup_timeout=True)
    try:
        with patch(__name__ + ".subprocess.Popen", return_value=process):
            try:
                _image_store_command("cleanup", "fixed-command", timeout=1, limit=4)
            except ImageStoreRefusal as refusal:
                if refusal.category != "command_cleanup":
                    raise RuntimeError("bounded cleanup refusal category changed") from None
            else:
                raise RuntimeError("unreaped command was accepted")
        if not process.killed or not process.waited or not process.stdout.closed:
            raise RuntimeError("cleanup-timeout command closure regression")
    finally:
        if writer is not None:
            os.close(writer)

    with patch(__name__ + "._image_store_command",
               side_effect=AssertionError("invalid reference reached Docker")):
        for invalid_reference, expected_stage, expected_category in (
                (tag + ":latest@sha256:" + "a" * 64, "reference", "unexpected_tag"),
                (tag + "@sha256:" + "A" * 64, "reference", "invalid_digest_reference")):
            try:
                inspect_local_digest(invalid_reference, tag, "squid")
            except ImageResolutionRefusal as refusal:
                if (refusal.role, refusal.stage, refusal.category) != (
                        "squid", expected_stage, expected_category):
                    raise RuntimeError("safe image reference category regression") from None
            else:
                raise RuntimeError("invalid build digest reference was accepted")

    workflow = pathlib.Path(".github/workflows/keeper-runtime-images.yml").read_text(encoding="utf-8")
    keeper_job = workflow[workflow.index("\n  keeper:\n"):]
    ordered = ["uses: actions/checkout@v4", "name: Prepare disposable hosted Docker image store",
              "uses: docker/setup-buildx-action@v3", "uses: docker/login-action@v3",
              "id: keeper-image", "id: squid-image", "id: firewall-image"]
    positions = [keeper_job.index(item) for item in ordered]
    setup_step = keeper_job[positions[1]:positions[2]]
    if positions != sorted(positions) or "--prepare-image-store" not in setup_step or \
            '"DOCKER_CONFIG=$docker_config"' not in setup_step:
        raise RuntimeError("image-store preparation workflow order regression")


if self_test_mode:
    offline_proxy_admission_self_test()
    offline_proxy_readiness_self_test()
    offline_image_store_self_test()
    offline_cleanup_self_test()
    offline_network_diagnostics_self_test()
    print("outside proof cleanup self-test passed")
    raise SystemExit(0)


if image_store_mode:
    try:
        result = prepare_image_store()
        print(json.dumps({"status": "ready", **result}, sort_keys=True))
    except ImageStoreRefusal as refusal:
        print(json.dumps({"status": "refused", "stage": refusal.stage,
                          "category": refusal.category}, sort_keys=True), file=sys.stderr)
        raise SystemExit(1) from None
    except Exception:
        print(json.dumps({"status": "refused", "stage": "setup",
                          "category": "internal_failure"}, sort_keys=True), file=sys.stderr)
        raise SystemExit(1) from None
    raise SystemExit(0)


try:
    if os.environ.get("CI") != "true" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("proof is restricted to disposable GitHub CI")
    if platform.system() != "Linux" or platform.machine() != "x86_64" or os.geteuid() != 0:
        raise RuntimeError("proof requires a disposable root-owned Linux runner")
    if not re.fullmatch(r"[0-9a-f]{40}", expected_sha) or expected_sha != report["source"]:
        raise RuntimeError("source revision identity mismatch")
    actual_sha = command("git", "-C", str(repo), "rev-parse", "HEAD")
    record("checked out proof source matches the workflow revision", actual_sha == expected_sha)

    phase = "loaded-images"
    report["images"] = {"keeper": inspect_local_digest(keeper_ref, "lares-keeper:test", "keeper"),
                        "squid": inspect_local_digest(squid_ref, "lares-squid:test", "squid"),
                        "firewall": inspect_local_digest(firewall_ref, "lares-nft:test", "firewall")}
    report["postgresImage"] = DB_IMAGE

    phase = "network"
    suffix = owner[:10]
    network = "lares-outside-proof-" + suffix
    project = "outsideproof" + suffix
    db_container = network + "-db"
    proxy_container = network + "-proxy"
    proxy_readiness_container = network + "-proxy-ready"
    peer_container = network + "-peer"
    role_container = "lares-outside-role-" + suffix
    generator_container = "lares-outside-generator-" + suffix
    agent = "fixture-agent"
    agent_container = "lares-" + agent
    resource_names = [db_container, proxy_container, proxy_readiness_container, peer_container, worker_container,
                      role_container, generator_container]
    set_network_stage("container-name-preflight")
    if any(container_facts(name) is not None for name in resource_names):
        raise RuntimeError("unique fixture container name is already in use")
    set_network_stage("network-name-preflight")
    if command("docker", "network", "ls", "--quiet", "--no-trunc", "--filter",
               "name=^" + network + "$").strip():
        raise RuntimeError("unique fixture network name is already in use")
    subnet = choose_unused_subnet()
    set_network_stage("network-create")
    command("docker", "network", "create", "--internal", "--subnet", str(subnet),
            "--label", "lares.proof=outside-discovery", "--label", "lares.proof.owner=" + owner, network)
    set_network_stage("network-inspect")
    network_metadata = json.loads(command("docker", "network", "inspect", network))[0]
    set_network_stage("network-isolation-check")
    if network_metadata.get("Internal") is not True or network_metadata.get("Labels", {}).get("lares.proof") != "outside-discovery" or network_metadata.get("Labels", {}).get("lares.proof.owner") != owner:
        raise RuntimeError("proof network isolation or ownership labels were not established")
    set_network_stage("network-ipam-check")
    configured_subnets = {entry.get("Subnet") for entry in network_metadata.get("IPAM", {}).get("Config", [])}
    if str(subnet) not in configured_subnets:
        raise RuntimeError("proof network static-address subnet did not match the selected range")
    set_network_stage("network-address-validation")
    if subnet.version != 4 or subnet.num_addresses < 32:
        raise RuntimeError("Docker selected an unsuitable isolated IPv4 subnet")
    ips = {"db": str(subnet.network_address + 10), "proxy": str(subnet.network_address + 11),
           "peer": str(subnet.network_address + 12), "agent": str(subnet.network_address + 13),
           "source": str(subnet.network_address + 14)}
    report["network"] = {"internal": True, "subnet": str(subnet), "fixtureAddresses": ips}

    # The generated firewall owns this one table. It may replace it on the
    # disposable runner, so refuse any pre-existing table and verify removal.
    set_network_stage("firewall-preflight")
    existing_tables = nft_host("list", "tables").stdout.splitlines()
    if any(line.strip() == "table inet lares_egress" for line in existing_tables):
        raise RuntimeError("disposable runner already has the Lares egress firewall table")

    phase = "fixture-files"
    root = pathlib.Path(tempfile.mkdtemp(prefix="lares-outside-discovery-proof-"))
    root.chmod(0o700)
    egress = create_squid_config_directory(root)
    (root / "certs").mkdir(mode=0o700)
    (root / "config").mkdir(mode=0o700)
    key_dir = root / "outside-custody"
    key_dir.mkdir(mode=0o700)
    key = secrets.token_bytes(32)
    (key_dir / "key").write_bytes(key)
    (key_dir / "key").chmod(0o400)
    key_fingerprint = hashlib.sha256(key).hexdigest()

    # The local CA is used through Node's ordinary extra-CA mechanism; TLS validation remains on.
    command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=Lares isolated outside proof CA", "-keyout", str(root / "certs/ca.key"),
            "-out", str(root / "certs/ca.pem"))
    (root / "certs/server.ext").write_text("subjectAltName=DNS:mcp.example.org\nextendedKeyUsage=serverAuth\n", encoding="ascii")
    command("openssl", "req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=mcp.example.org",
            "-keyout", str(root / "certs/server.key"), "-out", str(root / "certs/server.csr"))
    command("openssl", "x509", "-req", "-days", "1", "-in", str(root / "certs/server.csr"),
            "-CA", str(root / "certs/ca.pem"), "-CAkey", str(root / "certs/ca.key"),
            "-CAcreateserial", "-extfile", str(root / "certs/server.ext"), "-out", str(root / "certs/server.pem"))

    password = secrets.token_urlsafe(32)
    app_password = secrets.token_urlsafe(32)
    outside_password = secrets.token_urlsafe(32)
    admin_password = secrets.token_urlsafe(32)
    workflow_password = secrets.token_urlsafe(32)
    session_token = secrets.token_urlsafe(32)
    bearer = secrets.token_urlsafe(32)
    incarnation = str(uuid.uuid4())
    env_file = root / "fixture.env"
    env_values = {
        "PGPASSWORD": password, "PROOF_ADMIN_PASSWORD": password, "PROOF_APP_PASSWORD": app_password,
        "PROOF_OUTSIDE_PASSWORD": outside_password, "PROOF_WORKFLOW_PASSWORD": workflow_password,
        "PROOF_ADMIN_ROLE_PASSWORD": admin_password, "FIXTURE_SESSION_TOKEN": session_token,
        "FIXTURE_BEARER": bearer, "FIXTURE_NETWORK": network, "FIXTURE_ROOT": str(root),
        "FIXTURE_DB_IP": ips["db"], "FIXTURE_PROXY_IP": ips["proxy"], "FIXTURE_PEER_IP": ips["peer"],
        "FIXTURE_AGENT_IP": ips["agent"], "FIXTURE_SOURCE_IP": ips["source"],
        "FIXTURE_PROJECT": project, "FIXTURE_AGENT": agent, "FIXTURE_KEY_FINGERPRINT": key_fingerprint,
        "FIXTURE_KEY_HEX": key.hex(), "FIXTURE_INCARNATION": incarnation,
        "NODE_EXTRA_CA_CERTS": str(root / "certs/ca.pem"), "FIXTURE_PEER_REPORT": str(root / "peer.json"),
        "FIXTURE_WORKER_REPORT": str(root / "worker.json"),
    }
    env_file.write_text("".join(f"{name}={value}\n" for name, value in env_values.items()), encoding="ascii")
    env_file.chmod(0o600)
    role_env = root / "roles.env"
    role_env.write_text(f"PGPASSWORD={password}\nFIXTURE_ROOT={root}\n", encoding="ascii")
    role_env.chmod(0o600)
    peer_env = root / "peer.env"
    peer_env.write_text(f"FIXTURE_BEARER={bearer}\nFIXTURE_PEER_REPORT=/fixture/peer.json\n", encoding="ascii")
    peer_env.chmod(0o600)
    worker_env = root / "worker.env"
    worker_keys = ("PROOF_ADMIN_PASSWORD", "FIXTURE_SESSION_TOKEN", "FIXTURE_BEARER", "FIXTURE_ROOT",
                   "FIXTURE_AGENT", "FIXTURE_INCARNATION", "FIXTURE_KEY_HEX", "FIXTURE_SOURCE_IP",
                   "FIXTURE_AGENT_IP", "FIXTURE_PEER_REPORT", "FIXTURE_WORKER_REPORT", "FIXTURE_OWNER",
                   "NODE_EXTRA_CA_CERTS")
    env_values["FIXTURE_OWNER"] = owner
    env_values["FIXTURE_FIREWALL_IMAGE"] = firewall_ref
    worker_keys += ("FIXTURE_FIREWALL_IMAGE",)
    worker_env.write_text("".join(f"{name}={env_values[name]}\n" for name in worker_keys), encoding="ascii")
    worker_env.chmod(0o600)
    for filename, value in (("proof-password", password), ("app-password", app_password),
                            ("outside-password", outside_password), ("workflow-password", workflow_password),
                            ("admin-password", admin_password)):
        write_secret(root / "config" / filename, value)

    maintenance_admission = prepare_normal_admission_fixture(
        root, subnet, load_maintenance_custody())
    record("root-owned fixture prefix has a validated normal admission receipt", True)
    lifecycle = {
        "network": network, "subnet": str(subnet), "reservedAddresses": [],
        "maintenanceAdmission": maintenance_admission,
        "composeFile": str(root / "compose.yaml"), "egressDir": str(root / "egress"),
        "imageByRole": {"chief-of-staff": keeper_ref, "creative": keeper_ref},
        "proxyContainer": proxy_container, "squidImage": squid_ref, "firewallImage": firewall_ref,
        "adminDb": {"host": "proof-db", "port": 5432, "database": "postgres",
            "user": "lares_workflow_provisioner", "passwordFile": str(root / "config/admin-password")},
        "workflowTemplate": "empty_workflow", "workflowOwner": "lares_workflow_owner",
        "runtime": {"schedulesLive": False, "databaseUrl": "postgresql://lares_app@proof-db:5432/proof",
            "workflowServer": "postgresql://lares_workflow@proof-db:5432", "gatewayUrl": "https://gateway.example.invalid",
            "proxyUrl": "http://lares-egress-proxy:8888/", "passwordFile": str(root / "config/app-password"),
            "workflowPasswordFile": str(root / "config/workflow-password"), "gatewayKeys": {}},
        "egress": {"endpoints": {}, "legacyConsumers": [{"name": "outside-proof-source", "address": ips["source"], "hosts": ["mcp.example.org"]}],
            "internalNetworks": [ips["db"] + "/32", ips["proxy"] + "/32"], "directDestinations": [], "infrastructureHosts": []},
        "installationPrepared": True,
    }
    config = {"mode": "rendered", "project": project, "dir": str(root), "files": [str(root / "compose.yaml")],
        "agentsDir": str(root / "agents"), "retiredDir": str(root / "retired"), "secretsDir": str(root / "secrets"),
        "rolesDir": "/app/packages/agent-kit/templates", "templatesDir": "/app/packages/agent-kit/templates",
        "backupDir": str(root / "backup"), "db": {"host": "proof-db", "port": 5432, "database": "proof",
            "user": "lares_app", "passwordFile": str(root / "config/app-password")},
        "lifecycle": lifecycle, "outsideCustody": {"db": {"host": "proof-db", "port": 5432,
            "database": "proof", "user": "lares_outside_custody", "passwordFile": str(root / "config/outside-password")},
            "keyFile": "/var/lib/lares/outside-custody/key", "keyFingerprint": key_fingerprint,
            "routeConsumerName": "outside-proof-source"}}
    (root / "agents").mkdir(mode=0o700)
    (root / "retired").mkdir(mode=0o700)
    (root / "secrets").mkdir(mode=0o700)
    (root / "backup").mkdir(mode=0o700)
    (root / "config/keeper.json").write_text(json.dumps(config), encoding="utf-8")
    (root / "config/keeper.json").chmod(0o600)
    write_initial_squid_config(egress)

    phase = "database"
    db_env = root / "postgres.env"
    db_env.write_text(f"POSTGRES_USER=proof\nPOSTGRES_PASSWORD={password}\nPOSTGRES_DB=proof\n", encoding="ascii")
    db_env.chmod(0o600)
    command("docker", "run", "-d", "--name", db_container, "--label", "lares.proof.owner=" + owner,
            "--network", network,
            "--network-alias", "proof-db", "--ip", ips["db"], "--env-file", str(db_env), DB_IMAGE)
    postgres_ready(db_container, password)
    migrations = sorted((repo / "services/box/sql").glob("[0-9][0-9][0-9]_*.sql"))
    if not migrations or migrations[0].name != "001_baseline.sql":
        raise RuntimeError("numbered engine migrations are incomplete")
    applied = []
    for migration in migrations:
        command("docker", "exec", "-i", db_container, "psql", "-X", "-v", "ON_ERROR_STOP=1",
                "-U", "proof", "-d", "proof", input=migration.read_text(encoding="utf-8"), timeout=90)
        applied.append(migration.name)
    on_disk = {path.name for path in (repo / "services/box/sql").iterdir()
               if path.name[:3].isdigit() and path.name.endswith(".sql")}
    record("every numbered engine migration applied", set(applied) == on_disk)

    phase = "engine-roles"
    role_code = """import{Pool}from'pg';import{readFileSync}from'node:fs';import{provisionEngineDatabasePrivileges}from'/app/services/box/lib/database-privileges.ts';
const p=new Pool({host:'proof-db',database:'proof',user:'proof',password:process.env.PGPASSWORD,max:1,connectionTimeoutMillis:3000});
void(async()=>{try{const c=await p.connect();try{const r=await provisionEngineDatabasePrivileges(c,{expectedDatabase:'proof',passwords:{application:readFileSync(process.env.FIXTURE_ROOT+'/config/app-password'),financial:Buffer.from('fixture-financial-password-0123456789'),outsideCustody:readFileSync(process.env.FIXTURE_ROOT+'/config/outside-password')}});if(!['applied','verified'].includes(r.status))throw Error();}finally{c.release()}console.log('roles-ready')}finally{await p.end()}})().catch(()=>{process.exitCode=1});"""
    command("docker", "run", "--rm", "--name", role_container, "--label", "lares.proof.owner=" + owner,
            "--network", network, "--env-file", str(role_env),
            "--mount", f"type=bind,src={root},dst={root},readonly", "--entrypoint",
            "/app/services/keeper/node_modules/.bin/tsx", keeper_ref, "-e", role_code)

    phase = "proxy-config"
    generator = "import('/app/services/keeper/lib/egress.ts').then(({generateEgress})=>require('node:fs').writeFileSync(process.env.FIXTURE_ROOT+'/egress/squid.conf',generateEgress([]).squid))"
    command("docker", "run", "--rm", "--name", generator_container, "--label", "lares.proof.owner=" + owner,
            "--network", "none", "--env-file", str(env_file),
            "--mount", f"type=bind,src={root},dst={root}", "--entrypoint",
            "/app/services/keeper/node_modules/.bin/tsx", keeper_ref, "-e", generator)
    command("docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--cap-add", "SETUID", "--cap-add", "SETGID", "--mount",
            f"type=bind,src={root / 'egress'},dst=/config,readonly", "--entrypoint", "squid",
            squid_ref, "-k", "parse", "-f", "/config/squid.conf")
    command(*outside_proxy_start_args(proxy_container, owner, network, ips["proxy"],
                                      squid_ref, egress, lifecycle))
    verify_proxy_readiness_target(proxy_container, owner, network, ips["proxy"],
                                  report["images"]["squid"]["imageId"], egress, lifecycle)
    command(*proxy_readiness_start_args(proxy_readiness_container, owner, network, ips["source"], keeper_ref),
            timeout=20)
    if container_facts(proxy_readiness_container) is not None:
        raise RuntimeError("deny-only proxy readiness client did not remove itself")
    record("uniquely owned proxy returns an exact source-bound deny before the worker starts", True)

    phase = "compose-held-runtime"
    compose = f"""services:
  {agent_container}:
    image: {keeper_ref}
    entrypoint: [\"/bin/sh\", \"-c\"]
    command: [\"sleep 600\"]
    labels:
      lares.incarnation: {incarnation}
      lares.proof.owner: {owner}
    networks:
      proof:
        ipv4_address: {ips['agent']}
networks:
  proof:
    name: {network}
    external: true
"""
    (root / "compose.yaml").write_text(compose, encoding="utf-8")
    pre_compose_hash = hashlib.sha256((root / "compose.yaml").read_bytes()).hexdigest()
    existing_project_containers = command("docker", "ps", "--all", "--quiet", "--filter",
                                          "label=com.docker.compose.project=" + project)
    if existing_project_containers:
        raise RuntimeError("fixture Compose project identifier is already in use")
    command("docker", "compose", "--project-name", project, "--project-directory", str(root),
            "-f", str(root / "compose.yaml"), "create", agent_container)
    agent_container_id = command("docker", "compose", "--project-name", project, "--project-directory", str(root),
                                 "-f", str(root / "compose.yaml"), "ps", "--all", "--quiet")
    if not re.fullmatch(r"[0-9a-f]{12,64}", agent_container_id):
        raise RuntimeError("neutral Compose-created service identity unavailable")
    state = json.loads(command("docker", "inspect", "--format", "{{json .State}}", agent_container_id))
    record("neutral owned service is created but never started", state.get("Running") is False and state.get("StartedAt", "").startswith("0001-"))
    record("fixture Compose file has stable pre-lifecycle hash", hashlib.sha256((root / "compose.yaml").read_bytes()).hexdigest() == pre_compose_hash)

    phase = "https-peer"
    peer_report_path = root / "peer.json"
    peer_report_path.write_text(json.dumps({"ready": False}), encoding="ascii")
    peer_report_path.chmod(0o600)
    command("docker", "run", "-d", "--name", peer_container, "--label", "lares.proof.owner=" + owner,
            "--network", network,
            "--network-alias", "mcp.example.org", "--ip", ips["peer"], "--env-file", str(peer_env),
            "--mount", f"type=bind,src={root / 'certs'},dst=/fixture/certs,readonly",
            "--mount", f"type=bind,src={peer_report_path},dst=/fixture/peer.json",
            "--mount",
            f"type=bind,src={repo / 'services/keeper/tests/outside-discovery-image.probe.mts'},dst=/app/services/keeper/tests/outside-discovery-image.probe.mts,readonly", "--entrypoint",
            "/app/services/keeper/node_modules/.bin/tsx", keeper_ref,
            "/app/services/keeper/tests/outside-discovery-image.probe.mts", "peer")
    for _ in range(100):
        if command("docker", "inspect", "--format", "{{.State.Running}}", peer_container) != "true":
            raise RuntimeError("local MCP peer did not stay ready")
        try:
            peer_ready = json.loads((root / "peer.json").read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            peer_ready = {}
        if peer_ready.get("ready") is True:
            break
        time.sleep(.1)
    else:
        raise RuntimeError("local MCP peer did not become ready")
    peer_ready = json.loads((root / "peer.json").read_text(encoding="utf-8"))
    record("local MCP peer is listening with generated hostname certificate", peer_ready.get("ready") is True)

    phase = "configured-discovery"
    # Initial denial is installed before the real Keeper path applies its generated route.
    # No service is ever started by this fixture.
    worker_result = run("docker", "run", "-d", "--name", worker_container,
            "--label", "lares.proof.owner=" + owner, "--network", network, "--ip", ips["source"],
            "--env-file", str(worker_env), "--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
            "--mount", f"type=bind,src={root},dst={root}", "--mount",
            f"type=bind,src={key_dir},dst=/var/lib/lares/outside-custody,readonly", "--mount",
            f"type=bind,src={repo / 'services/keeper/tests/outside-discovery-image.probe.mts'},dst=/app/services/keeper/tests/outside-discovery-image.probe.mts,readonly", "--entrypoint",
            "/app/services/keeper/node_modules/.bin/tsx", keeper_ref,
            "/app/services/keeper/tests/outside-discovery-image.probe.mts", "run", check=False, timeout=30)
    facts = container_facts(worker_container)
    if facts is None or facts["labels"].get("lares.proof.owner") != owner or facts["imageId"] != report["images"]["keeper"]["imageId"] or not any(
            mount.get("Type") == "bind" and mount.get("Source") == str(root) for mount in facts["mounts"]):
        raise RuntimeError("configured worker identity and fixture mount could not be verified")
    worker_container_id = facts["id"]
    if worker_result.returncode != 0 and facts["status"] not in {"created", "exited", "dead"}:
        raise RuntimeError("configured worker start did not settle to a known state")
    worker_stopped = facts["running"] is False
    deadline = time.monotonic() + 120
    while not worker_stopped and time.monotonic() < deadline:
        time.sleep(.25)
        facts = container_facts(worker_container_id)
        if facts is None or facts["id"] != worker_container_id or facts["labels"].get("lares.proof.owner") != owner:
            raise RuntimeError("configured worker ownership changed while running")
        worker_stopped = facts["running"] is False
    if not worker_stopped:
        run("docker", "stop", "--time", "3", worker_container_id, check=False, timeout=15)
        facts = container_facts(worker_container_id)
        worker_stopped = facts is not None and facts["id"] == worker_container_id and \
            facts["labels"].get("lares.proof.owner") == owner and facts["running"] is False
        raise RuntimeError("configured worker exceeded its bounded lifetime")
    facts = container_facts(worker_container_id)
    if facts is None or facts["id"] != worker_container_id or facts["status"] != "exited" or facts["exitCode"] != 0:
        worker_evidence = import_worker_evidence(root)
        if worker_evidence:
            report["workerFailure"] = worker_evidence
        raise RuntimeError("configured production discovery worker did not complete")
    worker_evidence = import_worker_evidence(root)
    if not worker_evidence or worker_evidence.get("success") is not True:
        raise RuntimeError("configured production discovery worker did not complete")
    report["configuredDiscovery"] = worker_evidence
    record("normal configured consentAndDiscover completes through the actual route", True)
    record("selected-source direct target traffic is firewall-dropped and socket closes", worker_evidence.get("directTargetBlocked") is True)

    phase = "first-hop-evidence"
    peer_final = json.loads((root / "peer.json").read_text(encoding="utf-8"))
    record("MCP peer observed exact path, protocol, session and fixed discovery exchange",
           peer_final.get("methods") == ["initialize", "notifications/initialized", "tools/list", "tools/list"] and
           peer_final.get("requestCount") == 4 and peer_final.get("bearerMatches") is True and
           peer_final.get("tlsServername") is True and peer_final.get("pathMatches") is True and
           peer_final.get("protocolVersionMatches") is True and peer_final.get("initializeMatches") is True and
           peer_final.get("paginationCursorMatches") is True and peer_final.get("sessionMatches") is True)
    access_log = command("docker", "exec", proxy_container, "sh", "-c", "cat /var/log/squid/access.log 2>/dev/null || true")
    access_lines = [line for line in access_log.splitlines() if "mcp.example.org:443" in line]
    record("Squid access log attributes CONNECT to the selected Keeper source", bool(access_lines) and all(ips["source"] in line for line in access_lines))
    report["peerEvidence"] = {"methods": peer_final.get("methods", []), "bearerMatches": peer_final.get("bearerMatches") is True,
                              "tlsServername": peer_final.get("tlsServername") is True,
                              "pathMatches": peer_final.get("pathMatches") is True,
                              "protocolVersionMatches": peer_final.get("protocolVersionMatches") is True,
                              "paginationCursorMatches": peer_final.get("paginationCursorMatches") is True,
                              "sessionMatches": peer_final.get("sessionMatches") is True,
                              "requestCount": peer_final.get("requestCount", 0)}

    phase = "postconditions"
    state_after = json.loads(command("docker", "inspect", "--format", "{{json .State}}", agent_container_id))
    record("held service remains stopped after lifecycle and discovery", state_after.get("Running") is False and state_after.get("StartedAt", "").startswith("0001-"))
    record("lifecycle did not replace the supplied Compose file", hashlib.sha256((root / "compose.yaml").read_bytes()).hexdigest() == pre_compose_hash)
    report["status"] = "bounded-discovery-passed"
    report["success"] = True
except Exception as error:
    report["status"] = "failed"
    # Never place subprocess output, config values, credentials or arbitrary exception text in evidence.
    if isinstance(error, ImageResolutionRefusal):
        report["failure"] = {"phase": "loaded-images", "reason": "local image resolution failed",
                             "role": error.role, "resolutionStage": error.stage,
                             "category": error.category}
    else:
        report["failure"] = fixture_failure_record(phase, network_stage)
    if root is not None:
        worker_evidence = import_worker_evidence(root)
        if worker_evidence is not None and worker_evidence.get("success") is not True:
            report["workerFailure"] = worker_evidence
finally:
    phase_before_cleanup = phase
    try:
        named_worker = container_facts(worker_container)
    except Exception:
        named_worker = None
        worker_stopped = False
        cleanup_failures.append("worker-state-verification")
    if worker_container_id is None and named_worker is not None:
        if named_worker["labels"].get("lares.proof.owner") == owner:
            worker_container_id = named_worker["id"]
        else:
            worker_stopped = False
            cleanup_failures.append("worker-ownership-verification")
    if worker_container_id is not None:
        if named_worker is not None and named_worker["id"] != worker_container_id:
            worker_stopped = False
            cleanup_failures.append("worker-name-replaced")
        else:
            try:
                if root is not None:
                    worker_stopped, stop_failed, helpers_stopped = stop_worker_then_helpers(
                        worker_container_id, owner, root)
                else:
                    worker_stopped, stop_failed = stop_pinned_worker(worker_container_id, owner)
                    helpers_stopped = worker_stopped
                if stop_failed:
                    cleanup_failures.append("worker-stop-command")
            except Exception:
                worker_stopped = False
                helpers_stopped = False
                cleanup_failures.append("worker-state-verification")
    else:
        helpers_stopped = worker_stopped
        if root is not None and worker_stopped:
            helpers_stopped = safe_cleanup("owned-helper-stop", lambda: remove_owned_docker_helpers(root))
    if root is not None and not worker_stopped:
        cleanup_failures.append("worker-still-running")

    resources_removed = worker_stopped and helpers_stopped
    if resources_removed:
        resources_removed = safe_cleanup("owned-container-remove", lambda: remove_labelled_containers(owner))
    network_removed = resources_removed
    if network is not None and worker_stopped and helpers_stopped:
        network_removed = safe_cleanup("owned-network-remove", lambda: cleanup_exact_network(network, owner))

    # Only the absent-at-preflight table with a generated, installed stage that names this
    # source is owned by the proof. A fixed table name alone is never cleanup authority.
    expected_source = report.get("network", {}).get("fixtureAddresses", {}).get("source")
    if root is not None and worker_stopped and helpers_stopped and resources_removed and network_removed and expected_source:
        safe_cleanup("generated-firewall-remove", lambda: remove_generated_firewall(root, expected_source))

    if worker_stopped and helpers_stopped:
        safe_cleanup("owned-container-final-sweep", lambda: remove_labelled_containers(owner))
    consumers_absent = worker_stopped and helpers_stopped and resources_removed and network_removed
    if consumers_absent:
        try:
            remaining_owner = command("docker", "ps", "--all", "--quiet", "--no-trunc", "--filter",
                                      "label=lares.proof.owner=" + owner)
            remaining_network = command("docker", "network", "ls", "--quiet", "--no-trunc",
                                        "--filter", "name=^" + network + "$") if network else ""
            remaining_helpers = discover_owned_docker_helpers(root) if root is not None else []
            if remaining_owner.strip() or remaining_network.strip() or remaining_helpers:
                consumers_absent = False
                cleanup_failures.append("consumer-absence-verification")
        except Exception:
            consumers_absent = False
            cleanup_failures.append("consumer-absence-verification")

    if root is not None and consumers_absent:
        def remove_root():
            shutil.rmtree(root)
            if root.exists():
                raise RuntimeError("fixture directory remained after cleanup")
        safe_cleanup("fixture-root-remove", remove_root)
    elif root is not None:
        cleanup_failures.append("fixture-root-preserved-for-live-consumer")

    report["cleanupOkay"] = not cleanup_failures
    report["cleanupFailures"] = sorted(set(cleanup_failures))
    report["cleanupPhase"] = phase_before_cleanup
    report_path = pathlib.Path(output)
    try:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        report_path.chmod(0o644)
    except Exception:
        report["cleanupOkay"] = False
        report["cleanupFailures"] = sorted(set(report["cleanupFailures"] + ["artifact-write"]))
if not report.get("success") or not report.get("cleanupOkay"):
    raise SystemExit(1)
