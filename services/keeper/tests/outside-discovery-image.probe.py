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
projection_check_mode = sys.argv[1:] == ["--projection-check"]
if self_test_mode or image_store_mode or projection_check_mode:
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
routed_network = None
forward_rule_marker = None
forward_rule_source = None
forward_rule_target = None
forward_rule_diagnostic = None
forward_rule_insert_succeeded = False
forward_rule_insert_return_code = None
forward_rule_observed_lines = []
forward_rule_cleanup_status = "not-needed"
agent_container_id = None
owner = uuid.uuid4().hex
worker_container = "lares-outside-worker-" + owner[:10]
worker_container_id = None
peer_container_id = None
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
NETWORK_IPAM_DIAGNOSTICS = frozenset({
    "ipam-config-shape", "subnet-mismatch", "gateway-missing", "gateway-invalid", "gateway-mismatch",
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
                      "same-bridge direct-path control", "routed direct-path control",
                      "routed direct-path firewall counter",
                      "first-hop-evidence", "postconditions"}
DIRECT_ERROR_CATEGORIES = {"none", "dns-failure", "connection-refused", "network-unreachable",
                           "connection-reset", "socket-timeout", "deadline-triggered", "tls-error", "request-error",
                           "socket-close-timeout"}
COUNTER_FAILURE_CATEGORIES = {"none", "command-timeout", "command-not-found", "permission-denied",
                              "command-failed", "counter-missing", "counter-invalid",
                              "projection-mismatch", "stage-unavailable"}
MAX_REPORTED_FIREWALL_PACKETS = 1_000_000_000_000
FORWARD_RULE_DIAGNOSTICS = frozenset({
    "invalid-address", "invalid-rule-identity", "forward-chain-unavailable", "owned-rule-shape-mismatch",
    "owned-rule-already-present", "rule-insert-rejected", "rule-insert-not-visible", "installed",
    "cleanup-rule-identity-mismatch", "cleanup-rule-remained", "removed", "owned-rule-line-unsafe",
})


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


def inspect_fixture_ipam(metadata, expected_subnet, requested_gateway):
    """Return a fixed failure category and only the actually inspected gateway."""
    ipam = metadata.get("IPAM") if isinstance(metadata, dict) else None
    configs = ipam.get("Config") if isinstance(ipam, dict) else None
    if not isinstance(configs, list) or len(configs) != 1 or not isinstance(configs[0], dict):
        return "ipam-config-shape", None
    config = configs[0]
    if config.get("Subnet") != str(expected_subnet):
        return "subnet-mismatch", None
    observed = config.get("Gateway")
    if observed is None or observed == "":
        return "gateway-missing", None
    if not isinstance(observed, str):
        return "gateway-invalid", None
    try:
        parsed = ipaddress.ip_address(observed)
    except ValueError:
        return "gateway-invalid", None
    if parsed.version != expected_subnet.version or str(parsed) != observed or parsed not in expected_subnet:
        return "gateway-invalid", None
    if observed != requested_gateway:
        return "gateway-mismatch", observed
    return None, observed


def offline_network_diagnostics_self_test():
    """Execute production network AST with stub failures, without running network commands."""
    pinned = "b" * 64
    network_id = "a" * 64
    image_id = "sha256:" + "c" * 64
    endpoint_facts = {"id": pinned, "labels": {"lares.proof.owner": owner}, "imageId": image_id, "running": False}
    inspected_endpoint = [{"Id": pinned, "NetworkSettings": {"Networks": {
        "fixture-net": {"NetworkID": network_id, "IPAddress": "192.0.2.44", "IPPrefixLen": 24}}}}]
    prior_images = report.get("images")
    report["images"] = {"keeper": {"imageId": image_id}}
    with patch(__name__ + ".container_facts", lambda identity: endpoint_facts if identity in {"worker", pinned} else None), \
            patch(__name__ + ".command", lambda *args, **kwargs: json.dumps(inspected_endpoint)):
        endpoint = inspect_owned_bridge_endpoint("worker", pinned, "fixture-net", network_id, False)
    if endpoint != {"containerId": pinned, "imageId": image_id, "networkId": network_id, "ipv4": "192.0.2.44"}:
        raise RuntimeError("exact inspected shared-bridge endpoint was not retained")
    with patch(__name__ + ".container_facts", lambda identity: endpoint_facts if identity in {"worker", pinned} else None), \
            patch(__name__ + ".command", lambda *args, **kwargs: json.dumps(inspected_endpoint)):
        try:
            inspect_owned_bridge_endpoint("worker", pinned, "fixture-net", network_id, True)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("an endpoint inspected after its container stopped was treated as a live snapshot")
    wrong_identity = json.loads(json.dumps(inspected_endpoint))
    wrong_identity[0]["Id"] = "e" * 64
    with patch(__name__ + ".container_facts", lambda identity: endpoint_facts if identity in {"worker", pinned} else None), \
            patch(__name__ + ".command", lambda *args, **kwargs: json.dumps(wrong_identity)):
        try:
            inspect_owned_bridge_endpoint("worker", pinned, "fixture-net", network_id, False)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("a Docker inspect response for a different pinned ID was accepted")
    wrong_owner = {**endpoint_facts, "labels": {"lares.proof.owner": "f" * 32}}
    with patch(__name__ + ".container_facts", lambda identity: wrong_owner if identity in {"worker", pinned} else None):
        try:
            verify_owned_container("worker", pinned, False)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("a container with a different owner label was accepted")
    inspected_endpoint[0]["NetworkSettings"]["Networks"]["foreign"] = {
        "NetworkID": "d" * 64, "IPAddress": "192.0.2.45", "IPPrefixLen": 24}
    with patch(__name__ + ".container_facts", lambda identity: endpoint_facts if identity in {"worker", pinned} else None), \
            patch(__name__ + ".command", lambda *args, **kwargs: json.dumps(inspected_endpoint)):
        try:
            inspect_owned_bridge_endpoint("worker", pinned, "fixture-net", network_id, False)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("unexpected second network was accepted for the shared-bridge endpoint")
    inspected_endpoint[0]["NetworkSettings"]["Networks"] = {
        "fixture-net": {"NetworkID": network_id, "IPAddress": "", "IPPrefixLen": 24}}
    with patch(__name__ + ".container_facts", lambda identity: endpoint_facts if identity in {"worker", pinned} else None), \
            patch(__name__ + ".command", lambda *args, **kwargs: json.dumps(inspected_endpoint)):
        try:
            inspect_owned_bridge_endpoint("worker", pinned, "fixture-net", network_id, False)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("an empty Docker-assigned endpoint address was accepted")
    inspected_endpoint[0]["NetworkSettings"]["Networks"] = {
        "fixture-net": {"NetworkID": network_id, "IPAddress": "192.0.2.44", "IPPrefixLen": 24}}
    if prior_images is None:
        report.pop("images", None)
    else:
        report["images"] = prior_images

    nft_calls = []
    nft_cleanup = []
    nft_events = []
    def nft_run(*args, **kwargs):
        nft_calls.append((args, kwargs))
        nft_events.append("run")
        return subprocess.CompletedProcess(args, 0, "", "")
    def nft_remove(*args, **kwargs):
        nft_cleanup.append(args)
        nft_events.append("cleanup")
        return True
    with patch(__name__ + ".run", nft_run), patch(__name__ + ".remove_owned_container", nft_remove):
        nft_host("-f", "-", input="delete table inet lares_egress\n")
        nft_host("list", "tables")
    if ("--interactive" not in nft_calls[0][0] or nft_calls[0][1].get("input") != "delete table inet lares_egress\n" or
            "--interactive" in nft_calls[1][0] or nft_events != ["run", "cleanup", "run", "cleanup"] or
            len(nft_cleanup) != 2 or any(call[1] != owner for call in nft_cleanup)):
        raise RuntimeError("nft helper did not forward batch input through an interactive container")
    for family, rules in (("inet", ["ip saddr != { 192.0.2.10, 192.0.2.11 } accept", "ct state established,related accept",
                                     "ip daddr 192.0.2.20 accept", "udp dport 53 accept", "tcp dport 53 accept", "counter drop"]),
                          ("bridge", ["ether type != ip accept", "ether type ip ip saddr != { 192.0.2.10, 192.0.2.11 } accept",
                                       "ct state established,related accept", "ip daddr 192.0.2.20 accept",
                                       "udp dport 53 accept", "tcp dport 53 accept", "counter drop"])):
        hook = "type filter hook forward priority -10; policy accept;" if family == "inet" else \
            "type filter hook forward priority 0; policy accept;"
        generated = f"table {family} lares_egress {{\n chain forward {{\n  {hook}\n" + \
            "".join(f"  {rule}\n" for rule in rules) + " }\n}\n"
        live_rules = rules[:-1] + ["counter packets 4 bytes 256 drop # handle 19"]
        live = f"table {family} lares_egress {{\n chain forward {{\n  {hook}\n" + \
            "".join(f"  {rule}\n" for rule in live_rules) + " }\n}\n"
        if firewall_projection_hash(generated, live, family) is None:
            raise RuntimeError("generated firewall and normalized live projection did not match")
        alternate_hook = "type filter hook forward priority filter - 10; policy accept;" if family == "inet" else \
            "type filter hook forward priority filter; policy accept;"
        equivalent = live.replace(hook, alternate_hook).replace(
            "192.0.2.10, 192.0.2.11", "192.0.2.11, 192.0.2.10").replace(
            "ct state established,related", "ct state related,established").replace(
            "ip daddr 192.0.2.20 accept", "ip daddr 192.0.2.20/32 accept")
        if firewall_projection_hash(generated, equivalent, family) is None:
            raise RuntimeError("supported nft text forms did not preserve exact generated firewall semantics")
        changed = live.replace("ct state established,related accept\n",
                               "ct state established,related accept\n  ip daddr 192.0.2.99 accept\n")
        if firewall_projection_hash(generated, changed, family) is not None:
            raise RuntimeError("firewall projection accepted an extra rule")
        changed = live.replace(hook, re.sub(r"priority [^;]+", "priority input", hook))
        if firewall_projection_hash(generated, changed, family) is not None:
            raise RuntimeError("firewall projection accepted a changed hook")
        changed = live.replace("ct state established,related accept\n", "ct state established,related accept\n  counter drop\n")
        if firewall_projection_hash(generated, changed, family) is not None:
            raise RuntimeError("firewall projection accepted a non-terminal counter rule")
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
    worker_keys = next(node.value for node in main_try.body if isinstance(node, ast.Assign) and
        any(isinstance(target, ast.Name) and target.id == "worker_keys" for target in node.targets) and isinstance(node.value, ast.Tuple))
    worker_key_names = {item.value for item in worker_keys.elts if isinstance(item, ast.Constant) and isinstance(item.value, str)}
    if not {"FIXTURE_PEER_IP", "FIXTURE_SOURCE_IP"}.issubset(worker_key_names) or \
            {"FIXTURE_DB_IP", "FIXTURE_PROXY_IP"} & worker_key_names:
        raise RuntimeError("isolated discovery worker control target/source allowlist changed unexpectedly")
    env_values = next(node.value for node in main_try.body if isinstance(node, ast.Assign) and
        any(isinstance(target, ast.Name) and target.id == "env_values" for target in node.targets) and isinstance(node.value, ast.Dict))
    env_value_names = {key.value for key in env_values.keys if isinstance(key, ast.Constant) and isinstance(key.value, str)}
    if not {"FIXTURE_PEER_IP", "FIXTURE_SOURCE_IP"}.issubset(env_value_names):
        raise RuntimeError("discovery worker control target/source are not configured")

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
            "NETWORK_IPAM_DIAGNOSTICS": NETWORK_IPAM_DIAGNOSTICS,
            "SAFE_FAILURE_PHASES": SAFE_FAILURE_PHASES,
            "fixture_failure_record": fixture_failure_record,
            "inspect_fixture_ipam": inspect_fixture_ipam,
            "json": json, "ipaddress": ipaddress, "re": re, "secrets": secrets,
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
            raise RuntimeError("production network operation selected the wrong diagnostic stage: " +
                               json.dumps({"expected": expected_stage, "actual": failure}, sort_keys=True))
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

    ipam_subnet = ipaddress.ip_network("192.0.2.0/24")
    requested_gateway = "192.0.2.1"
    ipam_cases = [
        ("valid", {"IPAM": {"Config": [{"Subnet": str(ipam_subnet), "Gateway": requested_gateway}]}},
         None, requested_gateway),
        ("omitted gateway", {"IPAM": {"Config": [{"Subnet": str(ipam_subnet)}]}},
         "gateway-missing", None),
        ("null gateway", {"IPAM": {"Config": [{"Subnet": str(ipam_subnet), "Gateway": None}]}},
         "gateway-missing", None),
        ("malformed gateway", {"IPAM": {"Config": [{"Subnet": str(ipam_subnet), "Gateway": secret_like}]}},
         "gateway-invalid", None),
        ("wrong gateway", {"IPAM": {"Config": [{"Subnet": str(ipam_subnet), "Gateway": "192.0.2.2"}]}},
         "gateway-mismatch", "192.0.2.2"),
        ("duplicate gateway entries", {"IPAM": {"Config": [
            {"Subnet": str(ipam_subnet), "Gateway": requested_gateway},
            {"Subnet": str(ipam_subnet), "Gateway": requested_gateway}]}},
         "ipam-config-shape", None),
        ("wrong subnet", {"IPAM": {"Config": [{"Subnet": "192.0.3.0/24", "Gateway": "192.0.3.1"}]}},
         "subnet-mismatch", None),
        ("missing config", {"IPAM": {"Config": None}}, "ipam-config-shape", None),
    ]
    for label, metadata, expected_category, expected_gateway in ipam_cases:
        category, observed = inspect_fixture_ipam(metadata, ipam_subnet, requested_gateway)
        if (category, observed) != (expected_category, expected_gateway):
            raise RuntimeError("IPAM metadata was not safely classified: " + label)
        if category is not None and category not in NETWORK_IPAM_DIAGNOSTICS:
            raise RuntimeError("IPAM classifier returned a non-enumerated diagnostic")
        if label == "malformed gateway" and (secret_like in str(observed) or secret_like in str(category)):
            raise RuntimeError("IPAM diagnostic exposed malformed metadata")

    setup_faults = {
        "container-name-preflight", "network-name-preflight", "network-create",
        "network-inspect", "network-isolation-check", "network-ipam-check",
        "network-address-validation", "network-owner-check",
    }
    for fault in setup_faults:
        namespace = base_namespace()
        selected_subnet = ipaddress.ip_network(
            "2001:db8::/64" if fault == "network-address-validation" else "192.0.2.0/24")
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
                internal = fault == "network-isolation-check"
                configured = str(selected_subnet)
                if fault == "network-ipam-check":
                    configured = "192.0.3.0/24"
                inspected_owner = "f" * 32 if fault == "network-owner-check" else namespace["owner"]
                metadata = {"Internal": internal,
                            "Name": args[3] if len(args) > 3 else namespace["network"],
                            "Id": "a" * 64,
                            "Labels": {"lares.proof": "outside-discovery",
                                       "lares.proof.owner": inspected_owner},
                            "IPAM": {"Config": [{"Subnet": configured,
                                "Gateway": str(ipaddress.ip_network(configured).network_address + 1)}]}}
                return json.dumps([metadata])
            raise RuntimeError("unexpected fixture setup command")

        namespace["container_facts"] = container_stub
        namespace["command"] = setup_command
        failure_for(namespace, setup_nodes,
                    "network-isolation-check" if fault == "network-owner-check" else fault)
        if fault == "network-ipam-check":
            if namespace["report"].get("networkSetupDiagnostic") != "subnet-mismatch":
                raise RuntimeError("owned network IPAM failure lacked its fixed subnet diagnostic")
        elif namespace["report"].get("networkSetupDiagnostic") is not None:
            raise RuntimeError("network diagnostic was emitted before ownership and IPAM validation")

    namespace = base_namespace()
    selected_subnet = ipaddress.ip_network("192.0.2.0/24")
    namespace["choose_unused_subnet"] = lambda: selected_subnet
    namespace["container_facts"] = lambda name: None
    setup_calls = []

    def successful_setup_command(*args, **kwargs):
        setup_calls.append(args)
        if args[:3] == ("docker", "network", "inspect"):
            return json.dumps([{"Name": args[3], "Id": "a" * 64, "Internal": False,
                                "Labels": {"lares.proof": "outside-discovery",
                                           "lares.proof.owner": namespace["owner"]},
                                "IPAM": {"Config": [{"Subnet": str(selected_subnet),
                                    "Gateway": str(selected_subnet.network_address + 1)}]}}])
        return ""

    namespace["command"] = successful_setup_command
    execute(setup_nodes, namespace)
    if namespace["report"].get("network", {}).get("subnet") != str(selected_subnet):
        raise RuntimeError("production network setup success path changed in offline context")
    network_create = next(args for args in setup_calls if args[:3] == ("docker", "network", "create"))
    if "--internal" in network_create or "--gateway" not in network_create or \
            network_create[network_create.index("--gateway") + 1] != "192.0.2.1" or \
            namespace["report"].get("networkSetupDiagnostic") is not None:
        raise RuntimeError("network setup did not request and accept its observed gateway exactly")

    routed_start = next(index for index, node in enumerate(main_try.body)
                        if isinstance(node, ast.Assign) and any(
                            isinstance(target, ast.Name) and target.id == "routed_subnet"
                            for target in node.targets))
    routed_end = next(index for index in range(routed_start, len(main_try.body))
                      if isinstance(main_try.body[index], ast.Assign) and any(
                          isinstance(target, ast.Name) and target.id == "routed_gateway"
                          for target in main_try.body[index].targets))
    routed_nodes = main_try.body[routed_start:routed_end + 1]

    def run_routed_setup(inspected_gateway):
        namespace = base_namespace()
        routed_subnet = ipaddress.ip_network("198.51.100.0/24")
        namespace.update({"subnet": selected_subnet, "routed_network": "fixture-routed",
                          "choose_unused_subnet": lambda: routed_subnet})
        routed_calls = []

        def routed_command(*args, **kwargs):
            routed_calls.append(args)
            if args[:3] == ("docker", "network", "inspect"):
                return json.dumps([{"Name": "fixture-routed", "Id": "d" * 64,
                                    "Internal": False,
                                    "Labels": {"lares.proof": "outside-discovery-routed-target",
                                               "lares.proof.owner": namespace["owner"]},
                                    "IPAM": {"Config": [{"Subnet": str(routed_subnet),
                                        "Gateway": inspected_gateway}]}}])
            return ""

        namespace["command"] = routed_command
        try:
            execute(routed_nodes, namespace)
        except RuntimeError:
            if namespace["report"].get("routedNetworkSetupDiagnostic") is None:
                raise
        create = next(args for args in routed_calls if args[:3] == ("docker", "network", "create"))
        return namespace, create

    routed_namespace, routed_create = run_routed_setup("198.51.100.1")
    if "--gateway" not in routed_create or \
            routed_create[routed_create.index("--gateway") + 1] != "198.51.100.1" or \
            routed_namespace.get("routed_gateway") != "198.51.100.1":
        raise RuntimeError("routed target network did not request and use its observed gateway exactly")
    routed_mismatch, _ = run_routed_setup("198.51.100.2")
    if routed_mismatch["report"].get("routedNetworkSetupDiagnostic") != "gateway-mismatch":
        raise RuntimeError("routed target gateway mismatch lacked its fixed diagnostic")

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


def nft_host(*args, check=True, input=None):
    name = "lares-outside-nft-" + owner[:10] + "-" + uuid.uuid4().hex[:6]
    interactive = ("--interactive",) if input is not None else ()
    result = run("docker", "run", *interactive, "--name", name, "--label", "lares.proof.owner=" + owner,
                 "--network", "host", "--read-only", "--cap-drop", "ALL", "--cap-add", "NET_ADMIN",
                 "--entrypoint", "nft", firewall_ref, *args, input=input, check=check, timeout=30)
    remove_owned_container(name, owner, timeout=15)
    return result


def docker_user_rule_entries(marker, source_ip, target_ip):
    global forward_rule_diagnostic
    try:
        source = ipaddress.ip_address(source_ip)
        target = ipaddress.ip_address(target_ip)
    except ValueError:
        forward_rule_diagnostic = "invalid-address"
        raise RuntimeError("owned routed fixture allow rule addresses are invalid") from None
    if (source.version != 4 or target.version != 4 or str(source) != source_ip or
            str(target) != target_ip or not re.fullmatch(r"lares-outside-proof-route-[a-f0-9]{32}", marker)):
        forward_rule_diagnostic = "invalid-rule-identity"
        raise RuntimeError("owned routed fixture allow rule identity is invalid")
    result = nft_host("--handle", "list", "chain", "ip", "filter", "DOCKER-USER", check=False)
    if result.returncode:
        forward_rule_diagnostic = "forward-chain-unavailable"
        raise RuntimeError("owned routed fixture requires the Docker forward-user chain")
    expected = re.compile(r"^\s*ip saddr " + re.escape(source_ip) + r" ip daddr " +
                          re.escape(target_ip) + r" tcp dport 443 accept comment \"" +
                          re.escape(marker) + r"\" # handle ([0-9]+)$")
    entries = []
    for line in result.stdout.splitlines():
        normalized = line.lstrip(" \t")
        if marker not in normalized:
            continue
        if len(line) > 512 or not re.fullmatch(r"[A-Za-z0-9_.#:\"=/,() -]+", normalized):
            forward_rule_diagnostic = "owned-rule-line-unsafe"
            raise RuntimeError("owned routed fixture allow rule output was not safe to inspect")
        forward_rule_observed_lines.append(normalized)
        match = expected.fullmatch(normalized)
        handle = re.search(r"# handle ([0-9]+)$", normalized)
        entries.append({"line": normalized, "handle": handle.group(1) if handle else None,
                        "shapeValid": match is not None})
        if match is None:
            forward_rule_diagnostic = "owned-rule-shape-mismatch"
    return entries


def docker_user_rule_handles(marker, source_ip, target_ip):
    return [entry["handle"] for entry in docker_user_rule_entries(marker, source_ip, target_ip)
            if entry["handle"] is not None]


def routed_forward_rule_evidence():
    lines = list(dict.fromkeys(forward_rule_observed_lines))[:2]
    insert_result = "not-attempted" if forward_rule_insert_return_code is None else (
        "accepted" if forward_rule_insert_return_code == 0 else "rejected")
    return {"insertResult": insert_result, "insertReturnCode": forward_rule_insert_return_code,
            "markerMatchedRuleCount": min(len(set(forward_rule_observed_lines)), 3),
            "markerMatchedRules": lines, "cleanup": forward_rule_cleanup_status}


def install_routed_forward_allow(source_ip, target_ip):
    global forward_rule_marker, forward_rule_diagnostic, forward_rule_insert_succeeded, forward_rule_insert_return_code
    marker = "lares-outside-proof-route-" + owner
    if docker_user_rule_entries(marker, source_ip, target_ip):
        forward_rule_diagnostic = "owned-rule-already-present"
        raise RuntimeError("unique routed fixture allow rule already exists")
    forward_rule_marker = marker
    result = nft_host("insert", "rule", "ip", "filter", "DOCKER-USER", "ip", "saddr", source_ip,
                      "ip", "daddr", target_ip, "tcp", "dport", "443", "accept", "comment", marker,
                      check=False)
    forward_rule_insert_return_code = result.returncode if type(result.returncode) is int else 255
    if result.returncode:
        forward_rule_diagnostic = "rule-insert-rejected"
        raise RuntimeError("owned routed fixture allow rule insertion was refused")
    forward_rule_insert_succeeded = True
    entries = docker_user_rule_entries(marker, source_ip, target_ip)
    if len(entries) != 1 or not entries[0]["shapeValid"] or entries[0]["handle"] is None:
        forward_rule_diagnostic = "rule-insert-not-visible"
        raise RuntimeError("owned routed fixture allow rule could not be verified")
    forward_rule_diagnostic = "installed"
    return marker


def remove_routed_forward_allow(marker, source_ip, target_ip):
    global forward_rule_diagnostic, forward_rule_cleanup_status
    entries = docker_user_rule_entries(marker, source_ip, target_ip)
    if not entries:
        forward_rule_cleanup_status = "verified-absent"
        return
    if len(entries) != 1 or not forward_rule_insert_succeeded:
        forward_rule_cleanup_status = "ownership-unproven"
        forward_rule_diagnostic = "cleanup-rule-identity-mismatch"
        raise RuntimeError("owned routed fixture allow rule identity could not be verified")
    handle = entries[0]["handle"]
    if handle is None:
        forward_rule_cleanup_status = "handle-unavailable"
        forward_rule_diagnostic = "cleanup-rule-identity-mismatch"
        raise RuntimeError("owned routed fixture allow rule handle could not be verified")
    deleted = nft_host("delete", "rule", "ip", "filter", "DOCKER-USER", "handle", handle, check=False)
    if deleted.returncode:
        forward_rule_cleanup_status = "delete-failed"
        raise RuntimeError("owned routed fixture allow rule could not be deleted")
    if docker_user_rule_entries(marker, source_ip, target_ip):
        forward_rule_cleanup_status = "rule-remained"
        forward_rule_diagnostic = "cleanup-rule-remained"
        raise RuntimeError("owned routed fixture allow rule remained after cleanup")
    forward_rule_cleanup_status = "removed"
    forward_rule_diagnostic = "removed"


def offline_routed_forward_allow_self_test():
    global forward_rule_insert_succeeded, forward_rule_insert_return_code, forward_rule_observed_lines, forward_rule_cleanup_status
    source, target, marker = "172.30.0.14", "172.31.0.12", "lares-outside-proof-route-" + owner
    rules = []
    calls = []
    forward_rule_insert_succeeded = False
    forward_rule_insert_return_code = None
    forward_rule_observed_lines = []
    forward_rule_cleanup_status = "not-needed"

    def fake_nft(*args, **kwargs):
        calls.append((args, kwargs))
        if args[:4] == ("--handle", "list", "chain", "ip"):
            return subprocess.CompletedProcess(args, 0, "\n".join(rules), "")
        if args[:3] == ("insert", "rule", "ip"):
            rules.append(f'\t\t ip saddr {source} ip daddr {target} tcp dport 443 accept comment "{marker}" # handle 42')
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[:3] == ("delete", "rule", "ip") and args[-2] == "handle":
            handle = args[-1]
            rules[:] = [line for line in rules if not line.endswith("# handle " + handle)]
            return subprocess.CompletedProcess(args, 0, "", "")
        raise RuntimeError("unexpected nft test operation")

    with patch(__name__ + ".nft_host", fake_nft):
        if install_routed_forward_allow(source, target) != marker or len(rules) != 1:
            raise RuntimeError("exact routed fixture forward rule was not installed")
        if len(docker_user_rule_handles(marker, source, target)) != 1:
            raise RuntimeError("exact routed fixture forward rule handle was not discovered")
        remove_routed_forward_allow(marker, source, target)
        if rules or forward_rule_cleanup_status != "removed":
            raise RuntimeError("routed fixture forward rule cleanup left a rule behind")
        rules.append(f'\t\t ip saddr {source} ip daddr 172.31.0.13 tcp dport 443 accept comment "{marker}" # handle 43')
        entry = docker_user_rule_entries(marker, source, target)
        if len(entry) != 1 or entry[0]["shapeValid"] or entry[0]["handle"] != "43":
            raise RuntimeError("unexpected marker rule shape was not retained with its handle")
        remove_routed_forward_allow(marker, source, target)
        if rules:
            raise RuntimeError("verified run-owned mismatched rule was not removed by its handle")
        rules.clear()
        rules.extend([f'\t\t ip saddr {source} ip daddr {target} tcp dport 443 accept comment "{marker}" # handle 44',
                      f'\t\t ip saddr {source} ip daddr {target} tcp dport 443 accept comment "{marker}" # handle 45'])
        try:
            remove_routed_forward_allow(marker, source, target)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("ambiguous marker rules were removed without unique ownership")
        if len(rules) != 2:
            raise RuntimeError("ambiguous marker rules were changed during cleanup")
        rules.clear()
        rules.append(f' ip saddr {source} ip daddr {target} tcp dport 443 accept comment "{marker}"')
        try:
            remove_routed_forward_allow(marker, source, target)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("marker rule without a handle was treated as safely removable")
        if len(rules) != 1:
            raise RuntimeError("marker rule without a handle was changed during cleanup")
        rules.clear()
        rules.append(f'  ip saddr {source}\tip daddr {target} tcp dport 443 accept comment "{marker}" # handle 46')
        try:
            docker_user_rule_entries(marker, source, target)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("embedded tab was accepted inside an owned rule")
        if len(rules) != 1 or "# handle 46" not in rules[0]:
            raise RuntimeError("unsafe embedded-tab rule was changed during inspection")
        rules.clear()
        try:
            docker_user_rule_handles(marker, "172.30.0.014", target)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("a non-canonical source address was accepted")
    if not any(call[0][0:3] == ("insert", "rule", "ip") for call in calls) or \
            not any(call[0][0:3] == ("delete", "rule", "ip") for call in calls):
        raise RuntimeError("forward rule insert and handle cleanup were not exercised")


def firewall_table_projection(text, family, normalize_bridge_payload=False):
    lines = text.splitlines()
    table_line = f"table {family} lares_egress {{"
    starts = [index for index, line in enumerate(lines) if line.strip() == table_line]
    if len(starts) != 1:
        return None
    table_start = starts[0]
    depth, chain_start, chain_end, table_end, chain_count = 1, -1, -1, -1, 0
    for index in range(table_start + 1, len(lines)):
        line = lines[index].strip()
        if line == "chain forward {" and depth == 1:
            chain_count += 1
            chain_start = index
        depth += line.count("{") - line.count("}")
        if chain_start >= 0 and chain_end < 0 and depth == 1:
            chain_end = index
        if depth == 0:
            table_end = index
            break
        if depth < 0:
            return None
    if (table_end < 0 or chain_count != 1 or chain_start < 0 or chain_end <= chain_start or
            any(line.strip() for line in lines[table_start + 1:chain_start]) or
            any(line.strip() for line in lines[chain_end + 1:table_end])):
        return None
    body = [line.strip() for line in lines[chain_start + 1:chain_end] if line.strip()]
    if len(body) < 2:
        return None
    hook = canonical_firewall_hook(body[0], family)
    if hook is None:
        return None
    rules = []
    packets = None
    for raw in body[1:]:
        line = re.sub(r"\s+", " ", re.sub(r"\s+#\s*handle\s+\d+$", "", raw))
        counter = re.fullmatch(r"counter packets (\d+) bytes \d+ drop", line)
        if counter:
            if packets is not None:
                return None
            packets = int(counter.group(1))
            rules.append("counter drop")
        else:
            normalized = canonical_firewall_rule(line, family, normalize_bridge_payload)
            if normalized is None:
                return None
            rules.append(normalized)
    return {"hook": hook, "rules": rules, "packets": packets}


def canonical_firewall_hook(raw, family):
    match = re.fullmatch(r"type (filter) hook (forward) priority (.+); policy (accept);",
                         re.sub(r"\s+", " ", raw.strip()))
    if not match:
        return None
    priority = match.group(3)
    accepted = {"-10", "filter - 10"} if family == "inet" else {"0", "filter"}
    if priority not in accepted:
        return None
    return f"type filter hook forward priority {-10 if family == 'inet' else 0}; policy accept;"


def canonical_ipv4_prefix(value):
    parts = value.split("/")
    if len(parts) > 2:
        return None
    try:
        address = ipaddress.ip_address(parts[0])
    except ValueError:
        return None
    if address.version != 4:
        return None
    if len(parts) == 1:
        return str(address)
    try:
        prefix = int(parts[1])
    except ValueError:
        return None
    if str(prefix) != parts[1] or not 0 <= prefix <= 32:
        return None
    return str(address) if prefix == 32 else f"{address}/{prefix}"


def canonical_firewall_rule(raw, family, normalize_bridge_payload):
    line = re.sub(r"\s+", " ", raw.strip())
    source = re.fullmatch(r"(ether type ip )?ip saddr != \{ (.+) \} accept", line)
    if source:
        if source.group(1) and family != "bridge":
            return None
        members = [canonical_ipv4_prefix(value) for value in source.group(2).split(", ")]
        if any(value is None for value in members) or len(set(members)) != len(members):
            return None
        # In bridge tables, `ip saddr` carries the IPv4 payload dependency.
        # The pinned nft listing omits the equivalent explicit EtherType guard.
        prefix = "" if normalize_bridge_payload and family == "bridge" else (source.group(1) or "")
        return prefix + "ip saddr != { " + ", ".join(sorted(members)) + " } accept"
    state = re.fullmatch(r"ct state (.+) accept", line)
    if state:
        members = sorted(state.group(1).split(","))
        return "ct state established,related accept" if members == ["established", "related"] else None
    destination = re.fullmatch(r"ip daddr (.+) accept", line)
    if destination:
        raw_members = destination.group(1)
        members = raw_members[2:-2].split(", ") if raw_members.startswith("{ ") else [raw_members]
        members = [canonical_ipv4_prefix(value) for value in members]
        if any(value is None for value in members) or len(set(members)) != len(members):
            return None
        values = sorted(members)
        return f"ip daddr {values[0]} accept" if len(values) == 1 else \
            "ip daddr { " + ", ".join(values) + " } accept"
    return line


def valid_generated_firewall_projection(family, rules):
    if not rules:
        return False
    index = 0
    if family == "bridge":
        if rules[index] != "ether type != ip accept":
            return False
        index += 1
        if not re.fullmatch(r"ether type ip ip saddr != \{ [0-9./, ]+ \} accept", rules[index]):
            return False
        index += 1
    elif not re.fullmatch(r"ip saddr != \{ [0-9./, ]+ \} accept", rules[index]):
        return False
    else:
        index += 1
    if index >= len(rules) or rules[index] != "ct state established,related accept":
        return False
    index += 1
    while index < len(rules) and re.fullmatch(r"ip daddr .+ accept", rules[index]):
        index += 1
    return (rules[index:index + 2] == ["udp dport 53 accept", "tcp dport 53 accept"] and
            rules[index + 2:] == ["counter drop"])


def firewall_projection_hash(generated, live, family):
    expected = firewall_table_projection(generated, family)
    normalized_expected = firewall_table_projection(generated, family, normalize_bridge_payload=True)
    actual = firewall_table_projection(live, family, normalize_bridge_payload=True)
    hook = f"type filter hook forward priority {-10 if family == 'inet' else 0}; policy accept;"
    if (not expected or not normalized_expected or not actual or expected["hook"] != hook or actual["hook"] != hook or
            not valid_generated_firewall_projection(family, expected["rules"]) or
            normalized_expected["rules"] != actual["rules"] or actual["packets"] is None):
        return None
    canonical = json.dumps({"family": family, "hook": hook, "rules": normalized_expected["rules"]},
                           separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("ascii")).hexdigest()


def live_firewall_projection_hashes(root_path, expected_source):
    try:
        stage = (root_path / "egress" / "installed-stage").read_text(encoding="ascii").strip()
        if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", stage):
            return None
        generated = (root_path / "egress" / (stage + ".nft")).read_text(encoding="ascii")
    except OSError:
        return None
    if ("# Generated by keeper; apply the whole file atomically with nft -f." not in generated or
            not re.search(r"ip saddr != \{[^}]*\b" + re.escape(expected_source) + r"\b[^}]*\}", generated)):
        return None
    projections = {}
    for family in ("inet", "bridge"):
        if f"table {family} lares_egress {{" not in generated:
            return None
        live = nft_host("list", "table", family, "lares_egress", check=False)
        if live.returncode:
            return None
        projection_hash = firewall_projection_hash(generated, live.stdout, family)
        if projection_hash is None:
            return None
        projections[family] = projection_hash
    return projections


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


def verify_owned_container(name, pinned_id, expected_running):
    facts = container_facts(pinned_id)
    if (facts is None or facts["id"] != pinned_id or facts["labels"].get("lares.proof.owner") != owner or
            facts["imageId"] != report["images"]["keeper"]["imageId"] or facts["running"] is not expected_running):
        raise RuntimeError("shared-bridge container identity or ownership changed")
    named = container_facts(name)
    if named is None or named["id"] != pinned_id:
        raise RuntimeError("shared-bridge fixture name no longer identifies its pinned container")
    return facts


def inspect_owned_bridge_endpoint(name, pinned_id, network_name, network_id, expected_running):
    facts = verify_owned_container(name, pinned_id, expected_running)
    try:
        inspected = json.loads(command("docker", "inspect", pinned_id))
        if len(inspected) != 1 or inspected[0].get("Id") != pinned_id:
            raise ValueError
        endpoint_map = inspected[0].get("NetworkSettings", {}).get("Networks", {})
        if set(endpoint_map) != {network_name}:
            raise ValueError
        endpoint = endpoint_map[network_name]
        address = endpoint.get("IPAddress")
        prefix = endpoint.get("IPPrefixLen")
        parsed = ipaddress.ip_address(address)
        if (endpoint.get("NetworkID") != network_id or parsed.version != 4 or str(parsed) != address or
                type(prefix) is not int or not 1 <= prefix <= 32):
            raise ValueError
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        raise RuntimeError("shared-bridge endpoint inventory could not be verified") from None
    return {"containerId": pinned_id, "imageId": facts["imageId"], "networkId": network_id, "ipv4": address}


def inspect_shared_bridge_endpoints(network_id, worker, peer):
    verify_owned_container(worker_container, worker_container_id, False)
    verify_owned_container(peer_container, peer_container_id, True)
    if worker["ipv4"] == peer["ipv4"]:
        raise RuntimeError("shared-bridge endpoint addresses are not distinct")
    endpoints = {"networkId": network_id, "worker": worker, "peer": peer}
    report["sharedBridgeEndpoints"] = endpoints
    return endpoints


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
    tables = {line.strip() for line in table_lines.stdout.splitlines()}
    owned_families = [family for family in ("inet", "bridge") if f"table {family} lares_egress" in tables]
    if not owned_families:
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
    if ("# Generated by keeper; apply the whole file atomically with nft -f." not in contents or
            not re.search(r"ip saddr != \{[^}]*\b" + re.escape(expected_source) + r"\b[^}]*\}", contents) or
            any(f"table {family} lares_egress {{" not in contents for family in ("inet", "bridge"))):
        raise RuntimeError("fixture firewall stage does not identify its selected source")
    nft_host("-f", "-", input="".join(f"delete table {family} lares_egress\n" for family in owned_families))
    after = nft_host("list", "tables", check=False)
    if after.returncode or any(f"table {family} lares_egress" in {line.strip() for line in after.stdout.splitlines()}
                               for family in ("inet", "bridge")):
        raise RuntimeError("fixture firewall table remained after cleanup")


def safe_cleanup(label, action):
    global cleanup_failures
    try:
        action()
        return True
    except Exception:
        cleanup_failures.append(label)
        return False


WORKER_PHASES = {"configuration", "role identities", "neutral authorization fixture", "outside custody organisation gate contention",
              "outside custody human review and activation",
              "same-bridge direct-path control", "routed direct-path control",
              "generated route admission", "direct-path firewall counter",
              "routed direct-path firewall counter", "outside discovery preview", "outside discovery preview response",
              "prepare outside consent request", "outside consent and discover", "outside consent and discover response", "worker"}


def import_worker_evidence(root_path, shared_endpoints=None, firewall_hashes=None, diagnostics=None):
    """Accept only fixed worker fields and enum values; never copy arbitrary worker output."""
    def reject(field):
        if diagnostics is not None:
            diagnostics["workerEvidenceStatus"] = "rejected:" + field
        return None

    worker_path = root_path / "worker.json"
    try:
        value = json.loads(worker_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        status = "worker-file-missing"
    except (OSError, UnicodeError):
        status = "worker-file-unreadable"
    except json.JSONDecodeError:
        status = "worker-file-invalid-json"
    else:
        status = None
    if status is not None:
        if diagnostics is not None:
            diagnostics["workerEvidenceStatus"] = status
        return None
    if not isinstance(value, dict):
        return reject("checks")
    valid_checks = {
        "actual configured lares_app and lares_outside_custody logins",
        "neutral definition, finite human session and real owner adoption/use grant",
        "reciprocal authenticated actors wait at the shared organisation gate before member and session locks",
        "public saved lifecycle installed and acknowledged generated route without native authority",
        "same-bridge direct target closes before TLS and increments the bridge-family drop counter",
        "routed direct target closes before TLS and increments the inet-family drop counter after a verified positive control",
        "default HTTPS URL without an explicit port completed the guarded discovery exchange",
        "authenticated publication, current editor acceptance and exact custodian preview/stage/apply complete",
        "stage and apply request deadlines expire while a PostgreSQL lock blocks the discovery revision read",
        "exact stage and apply replays recover receipts while current custody and editor grants remain valid",
        "changed apply replay selectors are denied without changing the receipt or active head",
        "historical acceptance survives editor logout and current edit grant revocation blocks replay",
        "durable result decrypts under generated key/AAD and rejects changed request identity",
        "executable definition, ownership and applied state remain unchanged",
    }
    recovery_stages = {"claim-admission", "claim-authority", "claim-capture", "claim-route-review", "claim-storage",
                       "authority-check", "initialize", "initialized-notification", "tools-list", "persist-result", "cleanup"}
    peer_fields = {"requestCount", "initializeSeen", "initializedNotificationSeen", "toolsListCount", "bearerMatches",
                   "tlsServernameMatches", "pathMatches", "protocolVersionMatches", "initializeMatches",
                   "paginationCursorMatches", "sessionMatches"}
    route_boundaries = {"runtime-stop", "squid-validation", "firewall-check", "firewall-apply",
                        "proxy-reload", "route-acknowledgement"}
    checks = value.get("checks")
    failure = value.get("failure")
    if not isinstance(checks, list) or any(not isinstance(item, str) or item not in valid_checks for item in checks):
        return reject('checks')
    if value.get("success") is True and set(checks) != valid_checks:
        return reject('success')
    evidence = {"checks": checks, "firewallApplied": value.get("firewallApplied") is True,
                "workerReportedDirectTargetBlocked": value.get("directTargetBlocked") is True,
                "directTargetBlocked": value.get("directTargetBlocked") is True,
                "success": value.get("success") is True}
    if "shutdownFailure" in value:
        if type(value["shutdownFailure"]) is not bool:
            return reject('shutdownFailure')
        evidence["shutdownFailure"] = value["shutdownFailure"]
    predicate_fields = {
        "controlTlsComplete", "controlSocketClosed", "controlLookupMatchesTarget", "controlSourceMatchesConfigured",
        "controlPeerMatchesTarget", "directLookupMatchesTarget", "directSourceMatchesConfiguredOrMissing",
        "directPeerMatchesTargetOrMissing", "directTlsDidNotComplete", "directSocketClosed",
        "beforeCountersAvailable", "afterCountersAvailable", "requiredFamilyIncreased", "otherFamilyDidNotIncrease",
        "exactRequiredCounterComparisonMatches", "exactOtherCounterComparisonMatches", "blocked",
    }
    predicate_diagnostics = value.get("directPathPredicateDiagnostics")
    if "directPathPredicateDiagnostics" in value:
        if (not isinstance(predicate_diagnostics, dict) or not predicate_diagnostics or
                set(predicate_diagnostics) - {"sameBridge", "routed"}):
            return reject('directPathPredicateDiagnostics')
        safe_predicates = {}
        for path_name, path_values in predicate_diagnostics.items():
            if (not isinstance(path_values, dict) or set(path_values) != predicate_fields or
                    any(type(path_values[field]) is not bool for field in predicate_fields)):
                return reject('directPathPredicateDiagnostics')
            safe_predicates[path_name] = {field: path_values[field] for field in sorted(predicate_fields)}
        evidence["directPathPredicateDiagnostics"] = safe_predicates
    response_fields = {
        "previewResponseDiagnostics": {"agentDefinitionHashPresent", "agentAccessRevisionPresent", "outsideConnectionPresent",
                                        "allowListPresent", "readListPresent"},
        "discoveryResponseDiagnostics": {"protocolVersionMatches", "serverNameMatches", "toolCountMatches",
                                         "firstToolMatches", "secondToolMatches"},
    }
    for field, expected_fields in response_fields.items():
        response_values = value.get(field)
        if field not in value:
            continue
        if (not isinstance(response_values, dict) or set(response_values) != expected_fields or
                any(type(response_values[key]) is not bool for key in expected_fields)):
            return reject(field)
        evidence[field] = {key: response_values[key] for key in sorted(expected_fields)}
    peer_values = value.get("peerDiagnostics")
    if "peerDiagnostics" in value:
        if (not isinstance(peer_values, dict) or set(peer_values) != peer_fields or
                type(peer_values.get("requestCount")) is not int or not 0 <= peer_values["requestCount"] <= 12 or
                type(peer_values.get("toolsListCount")) is not int or not 0 <= peer_values["toolsListCount"] <= 10 or
                any(type(peer_values[key]) is not bool for key in peer_fields - {"requestCount", "toolsListCount"})):
            return reject('peerDiagnostics')
        evidence["peerDiagnostics"] = {key: peer_values[key] for key in sorted(peer_fields)}
    direct_diagnostics = value.get("directPathDiagnostics")
    routed_diagnostics = value.get("routedPathDiagnostics")
    if direct_diagnostics is not None or routed_diagnostics is not None:
        if not isinstance(direct_diagnostics, dict):
            return reject("directPathDiagnostics")
        if not isinstance(routed_diagnostics, dict):
            return reject("routedPathDiagnostics")

        def counter_projection(item, family):
            if (not isinstance(item, dict) or not isinstance(item.get("failure"), str) or
                    item["failure"] not in COUNTER_FAILURE_CATEGORIES):
                return None
            failure_category = item["failure"]
            packets = item.get("packets")
            if failure_category == "none":
                projection_hash = item.get("projectionHash")
                if (type(packets) is not int or not 0 <= packets <= MAX_REPORTED_FIREWALL_PACKETS or
                        not isinstance(projection_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", projection_hash)):
                    return None
                return {"packets": packets, "failure": failure_category, "projectionHash": projection_hash}
            if "packets" in item or "projectionHash" in item:
                return None
            projected = {"failure": failure_category}
            diagnostic = item.get("diagnostic")
            if diagnostic is not None:
                reasons = {"generated-table-unrecognized", "live-table-unrecognized", "hook-mismatch",
                           "rule-mismatch", "rule-count-mismatch", "counter-missing"}
                if (failure_category != "projection-mismatch" or not isinstance(diagnostic, dict) or
                        diagnostic.get("family") != family or diagnostic.get("reason") not in reasons or
                        not re.fullmatch(r"[a-f0-9]{64}", str(diagnostic.get("generatedHash", ""))) or
                        not re.fullmatch(r"[a-f0-9]{64}", str(diagnostic.get("liveHash", "")))):
                    return None
                safe_diagnostic = {"family": family, "reason": diagnostic["reason"],
                                   "generatedHash": diagnostic["generatedHash"],
                                   "liveHash": diagnostic["liveHash"]}
                if "mismatchIndex" in diagnostic:
                    if type(diagnostic["mismatchIndex"]) is not int or not 0 <= diagnostic["mismatchIndex"] <= 64:
                        return None
                    safe_diagnostic["mismatchIndex"] = diagnostic["mismatchIndex"]
                for key in ("generatedLine", "liveLine"):
                    if key in diagnostic:
                        line = diagnostic[key]
                        safe_nft_line = (isinstance(line, str) and len(line) <= 512 and line.isascii() and any(
                            re.fullmatch(pattern, line) for pattern in (
                                r"type filter hook forward priority [-0-9A-Za-z ]+; policy accept;",
                                r"(?:ether type ip )?ip saddr != \{ [0-9./, ]+ \} accept",
                                r"ether type != ip accept", r"ct state (?:established,related|related,established) accept",
                                r"ip daddr (?:\{ [0-9./, ]+ \}|[0-9./]+) accept",
                                r"(?:udp|tcp) dport 53 accept", r"counter drop",
                                r"counter packets [0-9]+ bytes [0-9]+ drop")))
                        if not safe_nft_line:
                            return None
                        safe_diagnostic[key] = line
                projected["diagnostic"] = safe_diagnostic
            elif failure_category == "projection-mismatch":
                return None
            return projected

        def family_counter_projection(item):
            if not isinstance(item, dict) or set(item) != {"inet", "bridge"}:
                return None
            inet, bridge = counter_projection(item.get("inet"), "inet"), counter_projection(item.get("bridge"), "bridge")
            return {"inet": inet, "bridge": bridge} if inet is not None and bridge is not None else None

        def socket_projection(item):
            if item == {"status": "not-attempted"}:
                return {"status": "not-attempted"}
            keys = {"tlsCompleted", "socketClosed", "errorCategory", "lookupAddress",
                    "assignedSourceAddress", "connectedPeerAddress"}
            if (not isinstance(item, dict) or not keys.issubset(item) or type(item.get("tlsCompleted")) is not bool or
                    type(item.get("socketClosed")) is not bool or not isinstance(item.get("errorCategory"), str) or
                    item["errorCategory"] not in DIRECT_ERROR_CATEGORIES):
                return None
            addresses = {}
            for key in ("lookupAddress", "assignedSourceAddress", "connectedPeerAddress"):
                address = item.get(key)
                if address is not None:
                    if not isinstance(address, str):
                        return None
                    try:
                        parsed = ipaddress.ip_address(address)
                    except ValueError:
                        return None
                    if parsed.version != 4 or str(parsed) != address:
                        return None
                addresses[key] = address
            return {"tlsCompleted": item["tlsCompleted"], "socketClosed": item["socketClosed"],
                    "errorCategory": item["errorCategory"], **addresses}

        endpoint_context_valid = (isinstance(shared_endpoints, dict) and
                                  set(shared_endpoints) == {"networkId", "worker", "peer"} and
                                  re.fullmatch(r"[a-f0-9]{64}", str(shared_endpoints.get("networkId", ""))) is not None)
        evidence_context_supplied = shared_endpoints is not None and firewall_hashes is not None
        firewall_projection_hashes_available = (isinstance(firewall_hashes, dict) and
                                  set(firewall_hashes) == {"inet", "bridge"} and
                                  all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)
                                      for value in firewall_hashes.values()))
        context_verified = endpoint_context_valid and firewall_projection_hashes_available
        endpoint_identity_valid = True
        if context_verified:
            for endpoint_name in ("worker", "peer"):
                endpoint = shared_endpoints[endpoint_name]
                if (not isinstance(endpoint, dict) or
                        set(endpoint) != {"containerId", "imageId", "networkId", "ipv4"} or
                        not re.fullmatch(r"[a-f0-9]{64}", str(endpoint.get("containerId", ""))) or
                        not re.fullmatch(r"sha256:[a-f0-9]{64}", str(endpoint.get("imageId", ""))) or
                        endpoint.get("networkId") != shared_endpoints["networkId"]):
                    endpoint_identity_valid = False
                    context_verified = False
                    break
        expected = ({"FIXTURE_SOURCE_IP": shared_endpoints["worker"]["ipv4"],
                     "FIXTURE_PEER_IP": shared_endpoints["peer"]["ipv4"]}
                    if context_verified else None)
        source_peer_addresses_valid = context_verified
        if context_verified:
            try:
                for endpoint_key in ("FIXTURE_SOURCE_IP", "FIXTURE_PEER_IP"):
                    value_ip = expected[endpoint_key]
                    parsed_ip = ipaddress.ip_address(value_ip)
                    if parsed_ip.version != 4 or str(parsed_ip) != value_ip:
                        source_peer_addresses_valid = False
                        context_verified = False
                        break
            except (KeyError, TypeError, ValueError):
                source_peer_addresses_valid = False
                context_verified = False
        if not context_verified:
            expected = None
        routed_target_configured_exactly_once_and_valid = False
        if context_verified:
            try:
                key = "FIXTURE_ROUTED_TARGET_IP"
                gateway = None
                for line in (root_path / "fixture.env").read_text(encoding="ascii").splitlines():
                    name, separator, raw = line.partition("=")
                    if separator and name == key:
                        if gateway is not None:
                            context_verified = False
                            break
                        parsed = ipaddress.ip_address(raw)
                        if parsed.version != 4 or str(parsed) != raw:
                            context_verified = False
                            break
                        gateway = raw
                if gateway is None:
                    context_verified = False
                else:
                    routed_target_configured_exactly_once_and_valid = True
                    expected[key] = gateway
            except (OSError, ValueError, TypeError):
                context_verified = False
            if not context_verified:
                expected = None

        certification_diagnostics = {
            "evidenceContextSupplied": evidence_context_supplied,
            "endpointContextValid": endpoint_context_valid,
            "endpointIdentityValid": endpoint_identity_valid,
            "sourcePeerAddressesValid": source_peer_addresses_valid,
            "routedTargetConfiguredExactlyOnceAndValid": routed_target_configured_exactly_once_and_valid,
            "firewallProjectionHashesAvailable": firewall_projection_hashes_available,
            "contextVerified": context_verified,
            "sameBridge": {},
            "routed": {},
        }

        def project_path(path_name, diagnostic, expected_peer_key, required_family):
            before = family_counter_projection(diagnostic.get("before"))
            after_value = diagnostic.get("after")
            after = family_counter_projection(after_value)
            if after is None and after_value == {"status": "not-attempted"}:
                after = {"status": "not-attempted"}
            control = socket_projection(diagnostic.get("control"))
            direct = socket_projection(diagnostic.get("direct"))
            inet_increased = diagnostic.get("inetCounterIncreased")
            bridge_increased = diagnostic.get("bridgeCounterIncreased")
            if (before is None or after is None or control is None or direct is None or
                    type(inet_increased) is not bool or type(bridge_increased) is not bool):
                certification_diagnostics[path_name] = {"pathInputsValid": False, "contextVerified": context_verified,
                    "beforeCountersAvailable": False, "afterCountersAvailable": False,
                    "inetBeforeProjectionMatchesLive": False, "inetAfterProjectionMatchesLive": False,
                    "bridgeBeforeProjectionMatchesLive": False, "bridgeAfterProjectionMatchesLive": False,
                    "projectionHashesMatchLive": False, "exactCounterDeltasMatchReported": False,
                    "controlLookupMatchesExpectedPeer": False, "controlSourceMatchesInspectedSource": False,
                    "controlPeerMatchesExpectedPeer": False, "controlTlsCompleted": False,
                    "controlSocketClosed": False, "controlErrorNone": False,
                    "directLookupMatchesExpectedPeer": False, "directSourceMatchesExpectedOrMissing": False,
                    "directPeerMatchesExpectedOrMissing": False,
                    "directSocketClosedBeforeTls": False, "requiredFamilyIncreased": False,
                    "otherFamilyDidNotIncrease": False, "certified": False}
                return None
            before_ok = all(before[family]["failure"] == "none" for family in ("inet", "bridge"))
            after_ok = after.get("status") is None and all(
                after[family]["failure"] == "none" for family in ("inet", "bridge"))
            if not context_verified or expected is None:
                evidence["pathEvidenceCertified"] = False
                certification_diagnostics[path_name] = {"pathInputsValid": True, "contextVerified": False,
                    "beforeCountersAvailable": before_ok, "afterCountersAvailable": after_ok,
                    "inetBeforeProjectionMatchesLive": False, "inetAfterProjectionMatchesLive": False,
                    "bridgeBeforeProjectionMatchesLive": False, "bridgeAfterProjectionMatchesLive": False,
                    "projectionHashesMatchLive": False, "exactCounterDeltasMatchReported": False,
                    "controlLookupMatchesExpectedPeer": False, "controlSourceMatchesInspectedSource": False,
                    "controlPeerMatchesExpectedPeer": False, "controlTlsCompleted": False,
                    "controlSocketClosed": False, "controlErrorNone": False,
                    "directLookupMatchesExpectedPeer": False, "directSourceMatchesExpectedOrMissing": False,
                    "directPeerMatchesExpectedOrMissing": False,
                    "directSocketClosedBeforeTls": False, "requiredFamilyIncreased": False,
                    "otherFamilyDidNotIncrease": False, "certified": False}
                return ({"control": control, "before": before, "direct": direct, "after": after,
                         "inetCounterIncreased": inet_increased, "bridgeCounterIncreased": bridge_increased}, False)
            peer = expected[expected_peer_key]
            successful_control = (control.get("status") is None and control["tlsCompleted"] is True and
                                  control["socketClosed"] is True and control["errorCategory"] == "none" and
                                  control["lookupAddress"] == peer and
                                  control["assignedSourceAddress"] == expected["FIXTURE_SOURCE_IP"] and
                                  control["connectedPeerAddress"] == peer)
            control_lookup_matches_expected_peer = control["lookupAddress"] == peer
            control_source_matches_inspected_source = control["assignedSourceAddress"] == expected["FIXTURE_SOURCE_IP"]
            control_peer_matches_expected_peer = control["connectedPeerAddress"] == peer
            direct_lookup_matches_expected_peer = direct.get("lookupAddress") == peer
            direct_source_matches_expected_or_missing = direct.get("assignedSourceAddress") in (None, expected["FIXTURE_SOURCE_IP"])
            direct_peer_matches_expected_or_missing = direct.get("connectedPeerAddress") in (None, peer)
            direct_attempted = direct.get("status") is None
            hashes_match = before_ok and after_ok and not any(
                    before[family]["projectionHash"] != firewall_hashes[family] or
                    after[family]["projectionHash"] != firewall_hashes[family]
                    for family in ("inet", "bridge"))
            projection_matches = {f"{family}{position}ProjectionMatchesLive":
                before_ok and after_ok and before[family]["projectionHash"] == firewall_hashes[family] and
                after[family]["projectionHash"] == firewall_hashes[family]
                for family in ("inet", "bridge") for position in ("Before", "After")}
            increased = {}
            if before_ok and after_ok:
                for family in ("inet", "bridge"):
                    previous, current = before[family]["packets"], after[family]["packets"]
                    if previous == MAX_REPORTED_FIREWALL_PACKETS or current == MAX_REPORTED_FIREWALL_PACKETS:
                        increased[family] = None
                    else:
                        increased[family] = current > previous
                if (increased["inet"] is not None and inet_increased != increased["inet"] or
                        increased["bridge"] is not None and bridge_increased != increased["bridge"]):
                    certification_diagnostics[path_name] = {"pathInputsValid": True, "contextVerified": True,
                        "beforeCountersAvailable": before_ok, "afterCountersAvailable": after_ok,
                        **projection_matches,
                        "projectionHashesMatchLive": hashes_match,
                        "exactCounterDeltasMatchReported": False,
                        "controlLookupMatchesExpectedPeer": control_lookup_matches_expected_peer,
                        "controlSourceMatchesInspectedSource": control_source_matches_inspected_source,
                        "controlPeerMatchesExpectedPeer": control_peer_matches_expected_peer,
                        "controlTlsCompleted": control["tlsCompleted"], "controlSocketClosed": control["socketClosed"],
                        "controlErrorNone": control["errorCategory"] == "none",
                        "directLookupMatchesExpectedPeer": direct_lookup_matches_expected_peer,
                        "directSourceMatchesExpectedOrMissing": direct_source_matches_expected_or_missing,
                        "directPeerMatchesExpectedOrMissing": direct_peer_matches_expected_or_missing,
                        "directSocketClosedBeforeTls": direct.get("tlsCompleted") is False and direct.get("socketClosed") is True,
                        "requiredFamilyIncreased": (bridge_increased if required_family == "bridge" else inet_increased) is True,
                        "otherFamilyDidNotIncrease": (inet_increased if required_family == "bridge" else bridge_increased) is False,
                        "certified": False}
                    return None
            exact_counter_deltas_match_reported = (before_ok and after_ok and
                all(increased.get(family) is not None and
                    ((inet_increased if family == "inet" else bridge_increased) == increased[family])
                    for family in ("inet", "bridge")))
            direct_addresses_match_expected_endpoint = (direct_lookup_matches_expected_peer and
                direct_source_matches_expected_or_missing and direct_peer_matches_expected_or_missing)
            selected_increased = (bridge_increased if required_family == "bridge" else inet_increased)
            other_increased = (inet_increased if required_family == "bridge" else bridge_increased)
            diagnostic_base = {"pathInputsValid": True, "contextVerified": True,
                "beforeCountersAvailable": before_ok, "afterCountersAvailable": after_ok,
                **projection_matches,
                "projectionHashesMatchLive": hashes_match,
                "exactCounterDeltasMatchReported": exact_counter_deltas_match_reported,
                "controlLookupMatchesExpectedPeer": control_lookup_matches_expected_peer,
                "controlSourceMatchesInspectedSource": control_source_matches_inspected_source,
                "controlPeerMatchesExpectedPeer": control_peer_matches_expected_peer,
                "controlTlsCompleted": control["tlsCompleted"], "controlSocketClosed": control["socketClosed"],
                "controlErrorNone": control["errorCategory"] == "none",
                "directLookupMatchesExpectedPeer": direct_lookup_matches_expected_peer,
                "directSourceMatchesExpectedOrMissing": direct_source_matches_expected_or_missing,
                "directPeerMatchesExpectedOrMissing": direct_peer_matches_expected_or_missing,
                "directSocketClosedBeforeTls": direct.get("tlsCompleted") is False and direct.get("socketClosed") is True,
                "requiredFamilyIncreased": selected_increased is True,
                "otherFamilyDidNotIncrease": other_increased is False, "certified": False}
            if not direct_attempted:
                unchanged_counters = (before_ok and after_ok and
                                      all(before[family]["packets"] == after[family]["packets"]
                                          for family in ("inet", "bridge")) and
                                      inet_increased is False and bridge_increased is False)
                unavailable_before_attempt = (not before_ok and after == {"status": "not-attempted"} and
                                              inet_increased is False and bridge_increased is False)
                control_succeeded = (control.get("tlsCompleted") is True and control.get("socketClosed") is True and
                                     control.get("errorCategory") == "none")
                if not (unavailable_before_attempt or (unchanged_counters and not control_succeeded)):
                    certification_diagnostics[path_name] = diagnostic_base
                    return None
                certification_diagnostics[path_name] = diagnostic_base
                return ({"control": control, "before": before, "direct": direct, "after": after,
                         "inetCounterIncreased": inet_increased, "bridgeCounterIncreased": bridge_increased}, False)
            if ((direct_attempted and not before_ok) or
                    (after.get("status") is not None and not after_ok and (inet_increased or bridge_increased))):
                certification_diagnostics[path_name] = diagnostic_base
                return None
            direct_address_evidence = direct_addresses_match_expected_endpoint
            counts_known = before_ok and after_ok and all(value is not None for value in increased.values())
            successful_block = (hashes_match and successful_control and direct_attempted and direct_address_evidence and counts_known and
                                direct["tlsCompleted"] is False and direct["socketClosed"] is True and
                                selected_increased is True and other_increased is False)
            diagnostic_base["certified"] = successful_block
            certification_diagnostics[path_name] = diagnostic_base
            return ({"control": control, "before": before, "direct": direct, "after": after,
                     "inetCounterIncreased": inet_increased, "bridgeCounterIncreased": bridge_increased},
                    successful_block)

        direct_projection = project_path("sameBridge", direct_diagnostics, "FIXTURE_PEER_IP", "bridge")
        routed_projection = project_path("routed", routed_diagnostics, "FIXTURE_ROUTED_TARGET_IP", "inet")
        if direct_projection is None or routed_projection is None:
            return reject("directPathDiagnostics" if direct_projection is None else "routedPathDiagnostics")
        evidence["directPathDiagnostics"], direct_success = direct_projection
        evidence["routedPathDiagnostics"], routed_success = routed_projection
        successful_block = context_verified and direct_success and routed_success
        certification_diagnostics["allPathsCertified"] = successful_block
        evidence["pathCertificationDiagnostics"] = certification_diagnostics
        evidence["pathEvidenceCertified"] = successful_block
        if value.get("success") is True and not successful_block:
            return reject('success')
        evidence["directTargetBlocked"] = successful_block
    elif evidence["directTargetBlocked"]:
        return reject('directTargetBlocked')
    if isinstance(failure, dict):
        phase_value = failure.get("phase")
        reason_value = failure.get("reason")
        route_boundary = failure.get("routeBoundary")
        if "routeBoundary" in failure and (phase_value != "generated route admission" or
                                             not isinstance(route_boundary, str) or
                                             route_boundary not in route_boundaries):
            return reject('failure')
        acknowledgement_reason = failure.get("acknowledgementReason")
        if "acknowledgementReason" in failure and (phase_value != "generated route admission" or
                                                     route_boundary != "route-acknowledgement" or
                                                     not isinstance(acknowledgement_reason, str) or
                                                     acknowledgement_reason not in ACKNOWLEDGEMENT_REASONS):
            return reject('failure')
        evidence["failure"] = {
            "phase": phase_value if phase_value in WORKER_PHASES else "worker",
            "reason": reason_value if reason_value == "configured outside discovery worker failed" else "worker failed",
        }
        category = failure.get("category", "unknown")
        if not isinstance(category, str) or category not in {"request-refused", "recovery-required", "unknown"}:
            return reject('failure')
        evidence["failure"]["category"] = category
        if "recoveryStage" in failure:
            recovery_stage = failure["recoveryStage"]
            if (category != "recovery-required" or phase_value != "outside consent and discover" or
                    not isinstance(recovery_stage, str) or recovery_stage not in recovery_stages):
                return reject('failure')
            evidence["failure"]["recoveryStage"] = recovery_stage
        if evidence["failure"]["phase"] == "direct-path firewall counter" and "directPathDiagnostics" not in evidence:
            return reject('failure')
        if "routeBoundary" in failure:
            evidence["failure"]["routeBoundary"] = route_boundary
        if "acknowledgementReason" in failure:
            evidence["failure"]["acknowledgementReason"] = acknowledgement_reason
    return evidence


def preserve_worker_stage(report, root_path):
    """Project the phase only through the worker evidence phase allow-list."""
    try:
        stage = json.loads((root_path / "worker-stage.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return
    if isinstance(stage, dict) and set(stage) == {"phase"} and isinstance(stage["phase"], str) and stage["phase"] in WORKER_PHASES:
        report["workerLastPhase"] = stage["phase"]


def preserve_worker_exit(report, root_path, facts):
    report["workerFileExisted"] = (root_path / "worker.json").exists()
    if isinstance(facts, dict) and type(facts.get("exitCode")) is int:
        report["workerExitCode"] = facts["exitCode"]
    preserve_worker_stage(report, root_path)


def preserve_worker_failure_evidence(report, root_path):
    """Keep an earlier context-rich import; mark fallback evidence explicitly unavailable."""
    if "workerFailure" in report or "workerEvidenceStatus" in report:
        return
    evidence = import_worker_evidence(root_path, diagnostics=report)
    if evidence is None:
        return
    report["workerFailure"] = evidence


def offline_worker_diagnostics_self_test():
    """No arbitrary values survive rejection, hard-death phases or exit diagnostics."""
    with tempfile.TemporaryDirectory(prefix="lares-worker-diagnostics-") as directory:
        root_path = pathlib.Path(directory)
        worker_path = root_path / "worker.json"
        stage_path = root_path / "worker-stage.json"
        def rejected(expected):
            diagnostics = {}
            if import_worker_evidence(root_path, diagnostics=diagnostics) is not None or diagnostics != {
                    "workerEvidenceStatus": expected}:
                raise RuntimeError("worker rejection diagnostic regression")
            preserve_worker_failure_evidence(diagnostics, root_path)
            if diagnostics != {"workerEvidenceStatus": expected}:
                raise RuntimeError("worker rejection diagnostic was overwritten")
        rejected("worker-file-missing")
        worker_path.mkdir()
        rejected("worker-file-unreadable")
        worker_path.rmdir()
        worker_path.write_bytes(b"\xff")
        rejected("worker-file-unreadable")
        worker_path.write_text("not-json", encoding="utf-8")
        rejected("worker-file-invalid-json")
        worker_path.write_text("[]", encoding="utf-8")
        rejected("rejected:checks")
        for field, invalid in (
                ("checks", ["SECRET_SENTINEL"]), ("success", True),
                ("shutdownFailure", "SECRET_SENTINEL"),
                ("directPathPredicateDiagnostics", {"SECRET_SENTINEL": True}),
                ("previewResponseDiagnostics", {"SECRET_SENTINEL": True}),
                ("discoveryResponseDiagnostics", {"SECRET_SENTINEL": True}),
                ("peerDiagnostics", {"SECRET_SENTINEL": True}),
                ("directPathDiagnostics", "SECRET_SENTINEL"),
                ("routedPathDiagnostics", "SECRET_SENTINEL"),
                ("directTargetBlocked", True),
                ("failure", {"phase": "configuration", "category": "SECRET_SENTINEL"})):
            value = {"checks": [], field: invalid}
            if field == "routedPathDiagnostics":
                value["directPathDiagnostics"] = {}
            worker_path.write_text(json.dumps(value), encoding="utf-8")
            rejected("rejected:" + field)
        worker_path.unlink()
        diagnostics = {}
        preserve_worker_exit(diagnostics, root_path, {"exitCode": 137})
        if diagnostics != {"workerFileExisted": False, "workerExitCode": 137}:
            raise RuntimeError("missing worker file or integer exit code diagnostic regression")
        worker_path.write_text("{}", encoding="utf-8")
        for code in (True, "137", None):
            diagnostics = {}
            preserve_worker_exit(diagnostics, root_path, {"exitCode": code})
            if diagnostics != {"workerFileExisted": True}:
                raise RuntimeError("non-integer worker exit code was reported")
        for phase in WORKER_PHASES:
            stage_path.write_text(json.dumps({"phase": phase}), encoding="utf-8")
            diagnostics = {}
            preserve_worker_exit(diagnostics, root_path, {"exitCode": 1})
            if diagnostics != {"workerFileExisted": True, "workerExitCode": 1, "workerLastPhase": phase}:
                raise RuntimeError("safe last worker phase was lost")
        for unsafe in ({"phase": "SECRET_SENTINEL"}, {"phase": []},
                       {"phase": "configuration", "secret": "SECRET_SENTINEL"}, [], None):
            stage_path.write_text(json.dumps(unsafe), encoding="utf-8")
            diagnostics = {}
            preserve_worker_stage(diagnostics, root_path)
            if diagnostics:
                raise RuntimeError("unsafe last worker phase was reported")
        stage_path.write_text("not-json", encoding="utf-8")
        diagnostics = {}
        preserve_worker_stage(diagnostics, root_path)
        if diagnostics:
            raise RuntimeError("invalid stage JSON was reported")
    # Verify every worker phase transition persists only the phase before its work starts.
    worker_source = pathlib.Path(__file__).with_suffix(".mts").read_text(encoding="utf-8")
    transitions = re.findall(r"startPhase\('([^']+)'\);", worker_source)
    if (not transitions or any(phase not in WORKER_PHASES for phase in transitions) or
            "writeReport(resolve(output,'../worker-stage.json'),{phase});" not in worker_source or
            "startPhase(phase);\n  try{" not in worker_source or
            re.search(r"^    phase='", worker_source, re.MULTILINE)):
        raise RuntimeError("worker phase persistence contract changed")


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
                "phase": "generated route admission", "reason": "worker failed", "category": "unknown"}:
            raise RuntimeError("worker failure artifact was not reduced to allowlisted fields")
        worker_path.write_text(json.dumps({"success": False, "checks": [],
            "failure": {"phase": "generated route admission", "reason": "worker failed",
                        "routeBoundary": "firewall-check"}}), encoding="utf-8")
        evidence = import_worker_evidence(pathlib.Path(directory))
        if not evidence or evidence.get("failure", {}).get("routeBoundary") != "firewall-check":
            raise RuntimeError("fixed route boundary label was not retained")
        preview_response = {"agentDefinitionHashPresent": True, "agentAccessRevisionPresent": True,
            "outsideConnectionPresent": True, "allowListPresent": True, "readListPresent": True}
        discovery_response = {"protocolVersionMatches": True, "serverNameMatches": True, "toolCountMatches": True,
            "firstToolMatches": True, "secondToolMatches": True}
        for phase in ("outside discovery preview", "outside discovery preview response", "prepare outside consent request",
                      "outside consent and discover", "outside consent and discover response"):
            phase_response_field = ("discoveryResponseDiagnostics" if phase == "outside consent and discover response"
                                    else "previewResponseDiagnostics")
            phase_response = (discovery_response if phase_response_field == "discoveryResponseDiagnostics"
                              else preview_response)
            worker_path.write_text(json.dumps({"success": False, "checks": [], phase_response_field: phase_response,
                "failure": {"phase": phase, "reason": "configured outside discovery worker failed",
                            "category": "request-refused"}}), encoding="utf-8")
            evidence = import_worker_evidence(pathlib.Path(directory))
            if not evidence or evidence.get("failure", {}).get("phase") != phase or \
                    evidence.get("failure", {}).get("category") != "request-refused" or \
                    evidence.get(phase_response_field) != phase_response:
                raise RuntimeError("operation-specific phase or safe refusal category was not retained")
        safe_peer = {"requestCount": 2, "initializeSeen": True, "initializedNotificationSeen": True,
                     "toolsListCount": 0, "bearerMatches": True, "tlsServernameMatches": True, "pathMatches": True,
                     "protocolVersionMatches": True, "initializeMatches": True, "paginationCursorMatches": True,
                     "sessionMatches": True}
        worker_path.write_text(json.dumps({"success": False, "checks": [], "peerDiagnostics": safe_peer,
            "failure": {"phase": "outside consent and discover", "reason": "configured outside discovery worker failed",
                        "category": "recovery-required", "recoveryStage": "initialized-notification"}}), encoding="utf-8")
        evidence = import_worker_evidence(pathlib.Path(directory))
        if (not evidence or evidence.get("failure", {}).get("recoveryStage") != "initialized-notification" or
                evidence.get("peerDiagnostics") != safe_peer):
            raise RuntimeError("fixed discovery recovery stage and safe peer diagnostics were not retained")
        for unsafe_stage in ("credential-secret-detail", {"method": "initialize"}):
            worker_path.write_text(json.dumps({"success": False, "checks": [],
                "failure": {"phase": "outside consent and discover", "reason": "worker failed",
                            "category": "recovery-required", "recoveryStage": unsafe_stage}}), encoding="utf-8")
            if import_worker_evidence(pathlib.Path(directory)) is not None:
                raise RuntimeError("unallowlisted recovery-stage detail was retained")
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
        source_ip, peer_ip, gateway_ip = "172.18.0.23", "172.18.0.31", "172.18.0.1"
        shared_endpoints = {"networkId": "a" * 64,
            "worker": {"containerId": "b" * 64, "imageId": "sha256:" + "c" * 64,
                       "networkId": "a" * 64, "ipv4": source_ip},
            "peer": {"containerId": "d" * 64, "imageId": "sha256:" + "c" * 64,
                     "networkId": "a" * 64, "ipv4": peer_ip}}
        (pathlib.Path(directory) / "fixture.env").write_text(
            f"FIXTURE_SOURCE_IP={source_ip}\nFIXTURE_PEER_IP={peer_ip}\nFIXTURE_ROUTED_TARGET_IP={gateway_ip}\n",
            encoding="ascii")
        def socket(tls, closed, error, lookup, source, peer, **extra):
            return {"tlsCompleted": tls, "socketClosed": closed, "errorCategory": error,
                    "lookupAddress": lookup, "assignedSourceAddress": source,
                    "connectedPeerAddress": peer, **extra}
        test_rules = {"inet": ["ip saddr != { 192.0.2.10 } accept", "ct state established,related accept",
                               "ip daddr 192.0.2.20/32 accept", "udp dport 53 accept", "tcp dport 53 accept", "counter drop"],
                      "bridge": ["ether type != ip accept", "ether type ip ip saddr != { 192.0.2.10 } accept",
                                 "ct state established,related accept", "ip daddr 192.0.2.20 accept",
                                 "udp dport 53 accept", "tcp dport 53 accept", "counter drop"]}
        projection_hashes = {}
        for family, rules in test_rules.items():
            hook = "type filter hook forward priority -10; policy accept;" if family == "inet" else \
                "type filter hook forward priority 0; policy accept;"
            generated = f"table {family} lares_egress {{\n chain forward {{\n  {hook}\n" + \
                "".join(f"  {rule}\n" for rule in rules) + " }\n}\n"
            live = generated.replace("counter drop", "counter packets 0 bytes 0 drop")
            projection_hashes[family] = firewall_projection_hash(generated, live, family)
        def counters(inet, bridge):
            return {"inet": {"packets": inet, "failure": "none", "projectionHash": projection_hashes["inet"]},
                    "bridge": {"packets": bridge, "failure": "none", "projectionHash": projection_hashes["bridge"]}}
        diagnostic = {
            "control": socket(True, True, "none", peer_ip, source_ip, peer_ip),
            "before": counters(14, 21),
            "direct": socket(False, True, "network-unreachable", peer_ip, None, None,
                             rawError=secret_like),
            "after": counters(14, 22), "inetCounterIncreased": False,
            "bridgeCounterIncreased": True, "raw": secret_like}
        routed_diagnostic = {
            "control": socket(True, True, "none", gateway_ip, source_ip, gateway_ip),
            "before": counters(14, 22),
            "direct": socket(False, True, "network-unreachable", gateway_ip, None, None),
            "after": counters(15, 22), "inetCounterIncreased": True,
            "bridgeCounterIncreased": False}
        predicate_fields = {
            "controlTlsComplete", "controlSocketClosed", "controlLookupMatchesTarget", "controlSourceMatchesConfigured",
            "controlPeerMatchesTarget", "directLookupMatchesTarget", "directSourceMatchesConfiguredOrMissing",
            "directPeerMatchesTargetOrMissing", "directTlsDidNotComplete", "directSocketClosed",
            "beforeCountersAvailable", "afterCountersAvailable", "requiredFamilyIncreased", "otherFamilyDidNotIncrease",
            "exactRequiredCounterComparisonMatches", "exactOtherCounterComparisonMatches", "blocked",
        }
        predicate_ok = {field: True for field in predicate_fields}
        preview_response = {"agentDefinitionHashPresent": True, "agentAccessRevisionPresent": True,
            "outsideConnectionPresent": True, "allowListPresent": True, "readListPresent": True}
        discovery_response = {"protocolVersionMatches": True, "serverNameMatches": True, "toolCountMatches": True,
            "firstToolMatches": True, "secondToolMatches": True}
        def worker_value(*, blocked=True, direct_path=None, routed_path=None, path_predicates=None,
                         phase="routed direct-path firewall counter", category="unknown",
                         preview_diagnostics=None, discovery_diagnostics=None):
            value = {"success": False, "checks": [], "directTargetBlocked": blocked}
            if direct_path is not None:
                value["directPathDiagnostics"] = direct_path
            if routed_path is not None:
                value["routedPathDiagnostics"] = routed_path
            if path_predicates is not None:
                value["directPathPredicateDiagnostics"] = path_predicates
            if preview_diagnostics is not None:
                value["previewResponseDiagnostics"] = preview_diagnostics
            if discovery_diagnostics is not None:
                value["discoveryResponseDiagnostics"] = discovery_diagnostics
            value["failure"] = {"phase": phase, "reason": "configured outside discovery worker failed", "category": category}
            return value
        worker_path.write_text(json.dumps(worker_value(direct_path=diagnostic, routed_path=routed_diagnostic,
            path_predicates={"sameBridge": predicate_ok, "routed": predicate_ok},
            preview_diagnostics=preview_response, discovery_diagnostics=discovery_response)),
                               encoding="utf-8")
        evidence = import_worker_evidence(pathlib.Path(directory), shared_endpoints, projection_hashes)
        expected_direct = {"control": socket(True, True, "none", peer_ip, source_ip, peer_ip),
                           "before": counters(14, 21),
                           "direct": socket(False, True, "network-unreachable", peer_ip, None, None),
                           "after": counters(14, 22), "inetCounterIncreased": False,
                           "bridgeCounterIncreased": True}
        expected_routed = {"control": socket(True, True, "none", gateway_ip, source_ip, gateway_ip),
                           "before": counters(14, 22),
                           "direct": socket(False, True, "network-unreachable", gateway_ip, None, None),
                           "after": counters(15, 22), "inetCounterIncreased": True,
                           "bridgeCounterIncreased": False}
        if not evidence or evidence.get("directPathDiagnostics") != expected_direct or \
                evidence.get("routedPathDiagnostics") != expected_routed or secret_like in json.dumps(evidence):
            raise RuntimeError("observed direct/routed path evidence was not safely projected")
        if (evidence.get("directPathPredicateDiagnostics") != {"sameBridge": predicate_ok, "routed": predicate_ok} or
                evidence.get("pathCertificationDiagnostics", {}).get("sameBridge", {}).get("certified") is not True or
                evidence.get("pathCertificationDiagnostics", {}).get("routed", {}).get("certified") is not True):
            raise RuntimeError("bounded path predicates or certification gates were not preserved")
        if (evidence.get("previewResponseDiagnostics") != preview_response or
                evidence.get("discoveryResponseDiagnostics") != discovery_response or
                evidence.get("failure", {}).get("phase") != "routed direct-path firewall counter" or
                evidence.get("failure", {}).get("category") != "unknown"):
            raise RuntimeError("safe operation phase, category, or response diagnostics were not retained")
        if evidence.get("pathEvidenceCertified") is not True:
            raise RuntimeError("complete inventory and live projections did not certify the direct-path evidence")
        false_predicates = {"sameBridge": predicate_ok, "routed": {**predicate_ok,
            "controlLookupMatchesTarget": False, "blocked": False}}
        worker_path.write_text(json.dumps(worker_value(blocked=False, direct_path=diagnostic,
            routed_path=routed_diagnostic, path_predicates=false_predicates)), encoding="utf-8")
        false_evidence = import_worker_evidence(pathlib.Path(directory), shared_endpoints, projection_hashes)
        if (not false_evidence or false_evidence.get("directPathPredicateDiagnostics", {}).get("routed", {}).get("blocked") is not False or
                false_evidence.get("directPathPredicateDiagnostics", {}).get("routed", {}).get("controlLookupMatchesTarget") is not False or
                false_evidence.get("workerReportedDirectTargetBlocked") is not False or
                false_evidence.get("directTargetBlocked") is not True):
            raise RuntimeError("worker predicate and independent certification results were not kept separate")
        unsafe_predicates = {"sameBridge": {**predicate_ok, "address": source_ip}, "routed": predicate_ok}
        worker_path.write_text(json.dumps(worker_value(direct_path=diagnostic, routed_path=routed_diagnostic,
            path_predicates=unsafe_predicates)), encoding="utf-8")
        if import_worker_evidence(pathlib.Path(directory), shared_endpoints, projection_hashes) is not None:
            raise RuntimeError("non-enum path predicate details escaped the strict diagnostic allowlist")
        for unsafe_category in ("raw exception text", ["request-refused"]):
            worker_path.write_text(json.dumps(worker_value(category=unsafe_category, direct_path=diagnostic,
                routed_path=routed_diagnostic, path_predicates={"sameBridge": predicate_ok, "routed": predicate_ok})),
                encoding="utf-8")
            if import_worker_evidence(pathlib.Path(directory), shared_endpoints, projection_hashes) is not None:
                raise RuntimeError("unsafe operation failure category escaped the fixed allowlist")
        unsafe_response = {**preview_response, "rawValue": "unsafe"}
        worker_path.write_text(json.dumps(worker_value(direct_path=diagnostic, routed_path=routed_diagnostic,
            path_predicates={"sameBridge": predicate_ok, "routed": predicate_ok}, preview_diagnostics=unsafe_response)),
            encoding="utf-8")
        if import_worker_evidence(pathlib.Path(directory), shared_endpoints, projection_hashes) is not None:
            raise RuntimeError("unsafe operation response details escaped the fixed allowlist")
        worker_path.write_text(json.dumps(worker_value(direct_path=diagnostic, routed_path=routed_diagnostic,
            path_predicates=None)), encoding="utf-8")
        malformed_predicates = json.loads(worker_path.read_text(encoding="utf-8"))
        malformed_predicates["directPathPredicateDiagnostics"] = None
        worker_path.write_text(json.dumps(malformed_predicates), encoding="utf-8")
        if import_worker_evidence(pathlib.Path(directory), shared_endpoints, projection_hashes) is not None:
            raise RuntimeError("null worker predicate diagnostics were accepted as absent")
        malformed_response = worker_value(direct_path=diagnostic, routed_path=routed_diagnostic,
            path_predicates={"sameBridge": predicate_ok, "routed": predicate_ok}, preview_diagnostics=None)
        malformed_response["previewResponseDiagnostics"] = None
        worker_path.write_text(json.dumps(malformed_response), encoding="utf-8")
        if import_worker_evidence(pathlib.Path(directory), shared_endpoints, projection_hashes) is not None:
            raise RuntimeError("null operation response diagnostics were accepted as absent")
        mismatched_projection = json.loads(json.dumps(diagnostic))
        mismatched_projection["before"]["bridge"]["projectionHash"] = "0" * 64
        worker_path.write_text(json.dumps(worker_value(blocked=True, direct_path=mismatched_projection,
            routed_path=routed_diagnostic, path_predicates={"sameBridge": predicate_ok, "routed": predicate_ok})),
            encoding="utf-8")
        projection_evidence = import_worker_evidence(pathlib.Path(directory), shared_endpoints, projection_hashes)
        if (not projection_evidence or projection_evidence.get("pathEvidenceCertified") is not False or
                projection_evidence.get("pathCertificationDiagnostics", {}).get("sameBridge", {}).get(
                    "bridgeBeforeProjectionMatchesLive") is not False or
                projection_evidence.get("pathCertificationDiagnostics", {}).get("routed", {}).get(
                    "projectionHashesMatchLive") is not True):
            raise RuntimeError("per-path projection equality mismatch was not identified safely")
        worker_path.write_text(json.dumps(worker_value(blocked=True,
            direct_path=diagnostic, routed_path=routed_diagnostic,
            path_predicates={"sameBridge": predicate_ok, "routed": predicate_ok})), encoding="utf-8")
        uncertified = import_worker_evidence(pathlib.Path(directory), shared_endpoints, None)
        if (not uncertified or uncertified.get("success") is not False or
                uncertified.get("directTargetBlocked") is not False or
                uncertified.get("pathEvidenceCertified") is not False or
                uncertified.get("directPathDiagnostics", {}).get("direct") != expected_direct["direct"] or
                uncertified.get("routedPathDiagnostics", {}).get("direct") != expected_routed["direct"]):
            raise RuntimeError("failure diagnostics were discarded or certified without live firewall projections")
        if (uncertified.get("pathCertificationDiagnostics", {}).get("firewallProjectionHashesAvailable") is not False or
                uncertified.get("pathCertificationDiagnostics", {}).get("sameBridge", {}).get("contextVerified") is not False or
                uncertified.get("pathCertificationDiagnostics", {}).get("evidenceContextSupplied") is not False):
            raise RuntimeError("missing projection context did not produce a bounded false certification diagnostic")

        preserved_report = {"workerFailure": evidence}
        preserve_worker_failure_evidence(preserved_report, pathlib.Path(directory))
        if preserved_report["workerFailure"] is not evidence:
            raise RuntimeError("context-rich worker evidence was overwritten by fallback import")
        malformed_path = pathlib.Path(directory) / "worker.json"
        malformed_path.write_text("not-json", encoding="utf-8")
        unavailable_report = {}
        preserve_worker_failure_evidence(unavailable_report, pathlib.Path(directory))
        if unavailable_report != {"workerEvidenceStatus": "worker-file-invalid-json"}:
            raise RuntimeError("unavailable worker evidence was not explicitly recorded")
        worker_path.write_text(json.dumps(worker_value(blocked=True, direct_path=diagnostic,
            routed_path=routed_diagnostic, path_predicates={"sameBridge": predicate_ok, "routed": predicate_ok})),
            encoding="utf-8")
        uncertified = import_worker_evidence(pathlib.Path(directory), None, projection_hashes)
        if (not uncertified or uncertified.get("directTargetBlocked") is not False or
                uncertified.get("pathEvidenceCertified") is not False or
                uncertified.get("directPathDiagnostics", {}).get("direct") != expected_direct["direct"]):
            raise RuntimeError("failure diagnostics were discarded or certified without inspected endpoints")
        mismatch = {"failure": "projection-mismatch", "diagnostic": {
            "family": "bridge", "reason": "hook-mismatch", "generatedHash": "1" * 64,
            "liveHash": "2" * 64, "mismatchIndex": 0,
            "generatedLine": "type filter hook forward priority filter; policy accept;",
            "liveLine": "type filter hook forward priority 0; policy accept;"}}
        worker_path.write_text(json.dumps(worker_value(blocked=True,
            direct_path={"control": diagnostic["control"],
                         "before": {"inet": counters(1, 1)["inet"], "bridge": mismatch},
                         "direct": {"status": "not-attempted"}, "after": {"status": "not-attempted"},
                         "inetCounterIncreased": False, "bridgeCounterIncreased": False},
            routed_path={"control": routed_diagnostic["control"],
                         "before": {"inet": counters(1, 1)["inet"], "bridge": counters(1, 1)["bridge"]},
                         "direct": {"status": "not-attempted"}, "after": {"status": "not-attempted"},
                         "inetCounterIncreased": False, "bridgeCounterIncreased": False})), encoding="utf-8")
        mismatch_evidence = import_worker_evidence(pathlib.Path(directory))
        preserved_mismatch = (mismatch_evidence or {}).get("directPathDiagnostics", {}).get("before", {}).get("bridge", {})
        if (not mismatch_evidence or mismatch_evidence.get("directTargetBlocked") is not False or
                preserved_mismatch.get("diagnostic", {}).get("liveLine") != mismatch["diagnostic"]["liveLine"]):
            raise RuntimeError("bounded exact firewall mismatch lines were not preserved as uncertified diagnostics: " +
                               json.dumps(mismatch_evidence, sort_keys=True))
        mismatch["diagnostic"]["liveLine"] = secret_like
        worker_path.write_text(json.dumps(worker_value(blocked=False,
            direct_path={"control": diagnostic["control"], "before": {"inet": counters(1, 1)["inet"], "bridge": mismatch},
                         "direct": {"status": "not-attempted"}, "after": {"status": "not-attempted"},
                         "inetCounterIncreased": False, "bridgeCounterIncreased": False},
            routed_path={"control": routed_diagnostic["control"], "before": {"inet": counters(1, 1)["inet"],
                         "bridge": counters(1, 1)["bridge"]}, "direct": {"status": "not-attempted"},
                         "after": {"status": "not-attempted"}, "inetCounterIncreased": False,
                         "bridgeCounterIncreased": False})), encoding="utf-8")
        if import_worker_evidence(pathlib.Path(directory)) is not None:
            raise RuntimeError("arbitrary firewall mismatch text escaped the fixed-line sanitizer")
        for mutation in (
                lambda d, r: d.pop("control"),
                lambda d, r: d["control"].update(connectedPeerAddress=source_ip),
                lambda d, r: r["control"].update(assignedSourceAddress=None),
                lambda d, r: d["direct"].update(connectedPeerAddress=source_ip),
                lambda d, r: d.update(inetCounterIncreased=True, bridgeCounterIncreased=False),
                lambda d, r: d["before"]["bridge"].update(projectionHash="0" * 64)):
            bad_direct, bad_routed = json.loads(json.dumps(diagnostic)), json.loads(json.dumps(routed_diagnostic))
            mutation(bad_direct, bad_routed)
            worker_path.write_text(json.dumps(worker_value(direct_path=bad_direct, routed_path=bad_routed)),
                                   encoding="utf-8")
            mutated = import_worker_evidence(pathlib.Path(directory), shared_endpoints, projection_hashes)
            if mutated is not None and (mutated.get("directTargetBlocked") is not False or
                                        mutated.get("pathEvidenceCertified") is not False):
                raise RuntimeError("forged or mismatched failure evidence was certified as a direct-path block")
        wrong_inventory = json.loads(json.dumps(shared_endpoints))
        wrong_inventory["peer"]["ipv4"] = "172.18.0.32"
        wrong_inventory_evidence = import_worker_evidence(pathlib.Path(directory), wrong_inventory, projection_hashes)
        if wrong_inventory_evidence is not None and (
                wrong_inventory_evidence.get("directTargetBlocked") is not False or
                wrong_inventory_evidence.get("pathEvidenceCertified") is not False):
            raise RuntimeError("socket observations were certified against a different inspected peer endpoint")
        worker_path.write_text(json.dumps(worker_value(direct_path=diagnostic, routed_path=routed_diagnostic)),
                               encoding="utf-8")
        (pathlib.Path(directory) / "fixture.env").write_text(
            f"FIXTURE_SOURCE_IP=172.18.0.99\nFIXTURE_PEER_IP=172.18.0.98\nFIXTURE_ROUTED_TARGET_IP={gateway_ip}\n",
            encoding="ascii")
        if import_worker_evidence(pathlib.Path(directory), shared_endpoints, projection_hashes) is None:
            raise RuntimeError("configured source and peer inputs overrode the inspected endpoint inventory")
        (pathlib.Path(directory) / "fixture.env").write_text(
            f"FIXTURE_SOURCE_IP={source_ip}\nFIXTURE_PEER_IP={peer_ip}\nFIXTURE_ROUTED_TARGET_IP={gateway_ip}\n",
            encoding="ascii")
        worker_path.write_text(json.dumps(worker_value(blocked=False,
            direct_path={"control": diagnostic["control"],
                         "before": {"inet": {"failure": "command-failed"}, "bridge": {"failure": "command-failed"}},
                         "direct": {"status": "not-attempted"}, "after": {"status": "not-attempted"},
                         "inetCounterIncreased": False, "bridgeCounterIncreased": False},
            routed_path={"control": routed_diagnostic["control"],
                         "before": {"inet": {"failure": "command-failed"}, "bridge": {"failure": "command-failed"}},
                         "direct": {"status": "not-attempted"}, "after": {"status": "not-attempted"},
                         "inetCounterIncreased": False, "bridgeCounterIncreased": False})), encoding="utf-8")
        evidence = import_worker_evidence(pathlib.Path(directory), shared_endpoints, projection_hashes)
        if (not evidence or evidence.get("directPathDiagnostics", {}).get("direct") != {"status": "not-attempted"} or
                evidence.get("routedPathDiagnostics", {}).get("direct") != {"status": "not-attempted"}):
            raise RuntimeError("before-counter refusal did not preserve not-attempted path stages")
        failed_control = socket(False, True, "deadline-triggered", gateway_ip, source_ip, None)
        unchanged = counters(14, 21)
        not_attempted_path = {"control": failed_control, "before": unchanged,
                              "direct": {"status": "not-attempted"}, "after": unchanged,
                              "inetCounterIncreased": False, "bridgeCounterIncreased": False}
        worker_path.write_text(json.dumps({"success": False, "checks": [], "directTargetBlocked": False,
            "directPathDiagnostics": not_attempted_path, "routedPathDiagnostics": not_attempted_path,
            "failure": {"phase": "routed direct-path control", "reason": "worker failed"}}), encoding="utf-8")
        evidence = import_worker_evidence(pathlib.Path(directory), shared_endpoints, projection_hashes)
        if (not evidence or evidence.get("pathEvidenceCertified") is not False or
                evidence.get("routedPathDiagnostics", {}).get("control", {}).get("errorCategory") != "deadline-triggered" or
                evidence.get("routedPathDiagnostics", {}).get("direct") != {"status": "not-attempted"}):
            raise RuntimeError("failed positive route control did not preserve safe, uncertified evidence")


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
    offline_worker_diagnostics_self_test()
    offline_proxy_admission_self_test()
    offline_proxy_readiness_self_test()
    offline_image_store_self_test()
    offline_cleanup_self_test()
    offline_network_diagnostics_self_test()
    offline_routed_forward_allow_self_test()
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


if projection_check_mode:
    try:
        payload = sys.stdin.buffer.read(256 * 1024 + 1)
        if len(payload) > 256 * 1024:
            raise ValueError
        request = json.loads(payload.decode("utf-8", "strict"))
        cases = request.get("cases") if isinstance(request, dict) and set(request) == {"cases"} else None
        if not isinstance(cases, list) or not 1 <= len(cases) <= 8:
            raise ValueError
        results = []
        for case in cases:
            if (not isinstance(case, dict) or set(case) != {"generated", "live"} or
                    not isinstance(case["generated"], str) or not isinstance(case["live"], str) or
                    len(case["generated"]) > 64 * 1024 or len(case["live"]) > 64 * 1024):
                raise ValueError
            families = {}
            for family in ("inet", "bridge"):
                projection_hash = firewall_projection_hash(case["generated"], case["live"], family)
                projection = firewall_table_projection(case["live"], family, normalize_bridge_payload=True)
                families[family] = ({"hash": projection_hash, "packets": projection["packets"]}
                                    if projection_hash is not None and projection is not None else None)
            results.append(families)
        print(json.dumps({"results": results}, sort_keys=True))
    except Exception:
        print(json.dumps({"failure": "invalid projection request"}, sort_keys=True), file=sys.stderr)
        raise SystemExit(2) from None
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
    routed_network = network + "-target"
    project = "outsideproof" + suffix
    db_container = network + "-db"
    proxy_container = network + "-proxy"
    proxy_readiness_container = network + "-proxy-ready"
    peer_container = network + "-peer"
    routed_peer_container = network + "-target-peer"
    role_container = "lares-outside-role-" + suffix
    generator_container = "lares-outside-generator-" + suffix
    agent = "fixture-agent"
    agent_container = "lares-" + agent
    resource_names = [db_container, proxy_container, proxy_readiness_container, peer_container, routed_peer_container, worker_container,
                      role_container, generator_container]
    set_network_stage("container-name-preflight")
    if any(container_facts(name) is not None for name in resource_names):
        raise RuntimeError("unique fixture container name is already in use")
    set_network_stage("network-name-preflight")
    if command("docker", "network", "ls", "--quiet", "--no-trunc", "--filter",
               "name=^" + network + "$").strip():
        raise RuntimeError("unique fixture network name is already in use")
    if command("docker", "network", "ls", "--quiet", "--no-trunc", "--filter",
               "name=^" + routed_network + "$").strip():
        raise RuntimeError("unique routed fixture network name is already in use")
    subnet = choose_unused_subnet()
    requested_gateway = str(subnet.network_address + 1)
    set_network_stage("network-create")
    command("docker", "network", "create", "--subnet", str(subnet), "--gateway", requested_gateway,
            "--label", "lares.proof=outside-discovery", "--label", "lares.proof.owner=" + owner, network)
    set_network_stage("network-inspect")
    network_metadata = json.loads(command("docker", "network", "inspect", network))[0]
    set_network_stage("network-isolation-check")
    if (network_metadata.get("Name") != network or
            not re.fullmatch(r"[a-f0-9]{64}", str(network_metadata.get("Id", ""))) or
            network_metadata.get("Internal") is not False or
            network_metadata.get("Labels", {}).get("lares.proof") != "outside-discovery" or
            network_metadata.get("Labels", {}).get("lares.proof.owner") != owner):
        raise RuntimeError("proof network ownership or non-internal topology was not established")
    set_network_stage("network-ipam-check")
    ipam_category, inspected_gateway = inspect_fixture_ipam(network_metadata, subnet, requested_gateway)
    if ipam_category is not None:
        report["networkSetupDiagnostic"] = ipam_category
        raise RuntimeError("proof network IPAM did not match its requested address contract")
    first_gateway = inspected_gateway
    set_network_stage("network-address-validation")
    if subnet.version != 4 or subnet.num_addresses < 32:
        raise RuntimeError("Docker selected an unsuitable isolated IPv4 subnet")
    ips = {"db": str(subnet.network_address + 10), "proxy": str(subnet.network_address + 11),
           "peer": str(subnet.network_address + 12), "agent": str(subnet.network_address + 13),
           "source": str(subnet.network_address + 14)}
    report["network"] = {"internal": False, "subnet": str(subnet), "fixtureAddresses": ips}

    # The generated firewall owns this one table. It may replace it on the
    # disposable runner, so refuse any pre-existing table and verify removal.
    set_network_stage("firewall-preflight")
    existing_tables = nft_host("list", "tables").stdout.splitlines()
    if any(line.strip() in {"table inet lares_egress", "table bridge lares_egress"} for line in existing_tables):
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

    phase = "https-peer"
    routed_subnet = choose_unused_subnet()
    if routed_subnet.version != 4 or routed_subnet.num_addresses < 16 or routed_subnet.overlaps(subnet):
        raise RuntimeError("routed target bridge address range is unsuitable")
    routed_target_ip = str(routed_subnet.network_address + 12)
    routed_requested_gateway = str(routed_subnet.network_address + 1)
    command("docker", "network", "create", "--subnet", str(routed_subnet), "--gateway", routed_requested_gateway,
            "--label", "lares.proof=outside-discovery-routed-target", "--label", "lares.proof.owner=" + owner,
            routed_network)
    routed_metadata = json.loads(command("docker", "network", "inspect", routed_network))[0]
    if (routed_metadata.get("Name") != routed_network or
            not re.fullmatch(r"[a-f0-9]{64}", str(routed_metadata.get("Id", ""))) or
            routed_metadata.get("Labels", {}).get("lares.proof") != "outside-discovery-routed-target" or
            routed_metadata.get("Labels", {}).get("lares.proof.owner") != owner or
            routed_metadata.get("Internal") is not False):
        raise RuntimeError("routed target bridge ownership or address range could not be verified")
    routed_ipam_category, routed_inspected_gateway = inspect_fixture_ipam(
        routed_metadata, routed_subnet, routed_requested_gateway)
    if routed_ipam_category is not None:
        report["routedNetworkSetupDiagnostic"] = routed_ipam_category
        raise RuntimeError("routed target bridge IPAM did not match its requested address contract")
    routed_gateway = routed_inspected_gateway
    routed_peer_report_path = root / "routed-peer.json"
    routed_peer_report_path.write_text(json.dumps({"ready": False}), encoding="ascii")
    routed_peer_report_path.chmod(0o600)
    command("docker", "run", "-d", "--name", routed_peer_container, "--label", "lares.proof.owner=" + owner,
            "--network", routed_network, "--ip", routed_target_ip,
            "--env", "FIXTURE_PEER_REPORT=/fixture/peer.json",
            "--env", "FIXTURE_ROUTED_TARGET_IP=" + routed_target_ip,
            "--mount", f"type=bind,src={root / 'certs'},dst=/fixture/certs,readonly",
            "--mount", f"type=bind,src={routed_peer_report_path},dst=/fixture/peer.json",
            "--mount", f"type=bind,src={repo / 'services/keeper/tests/outside-discovery-image.probe.mts'},dst=/app/services/keeper/tests/outside-discovery-image.probe.mts,readonly",
            "--entrypoint", "/app/services/keeper/node_modules/.bin/tsx", keeper_ref,
            "/app/services/keeper/tests/outside-discovery-image.probe.mts", "control-peer")
    routed_facts = container_facts(routed_peer_container)
    routed_inspect = json.loads(command("docker", "inspect", routed_peer_container))[0]
    routed_endpoint = routed_inspect.get("NetworkSettings", {}).get("Networks", {}).get(routed_network, {})
    if (routed_facts is None or routed_facts["labels"].get("lares.proof.owner") != owner or
            routed_facts["imageId"] != report["images"]["keeper"]["imageId"] or
            routed_endpoint.get("NetworkID") != routed_metadata["Id"] or routed_endpoint.get("IPAddress") != routed_target_ip or
            routed_inspect.get("HostConfig", {}).get("PortBindings") or
            any(binding for values in routed_inspect.get("NetworkSettings", {}).get("Ports", {}).values()
                for binding in (values or []))):
        raise RuntimeError("routed target identity, network endpoint or unpublished-port contract failed validation")
    for _ in range(100):
        try:
            routed_ready = json.loads(routed_peer_report_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            routed_ready = {}
        if routed_ready.get("ready") is True:
            break
        time.sleep(.1)
    else:
        raise RuntimeError("routed target TLS peer did not become ready")
    forward_rule_source, forward_rule_target = ips["source"], routed_target_ip
    forward_rule_marker = install_routed_forward_allow(forward_rule_source, forward_rule_target)
    report["routedTarget"] = {"owned": True, "firstBridgeGateway": first_gateway,
                              "targetBridgeGateway": routed_gateway,
                              "firstBridgeNetworkId": network_metadata["Id"],
                              "targetBridgeNetworkId": routed_metadata["Id"],
                              "sourceAddress": ips["source"], "targetAddress": routed_target_ip,
                              "targetPort": 443, "hostPublishedPort": False,
                              "ownedForwardAdmissionRule": True}
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
        "FIXTURE_ROUTED_TARGET_IP": routed_target_ip,
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
                   "FIXTURE_PEER_IP",
                   "FIXTURE_ROUTED_TARGET_IP",
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
    peer_facts = container_facts(peer_container)
    if (peer_facts is None or peer_facts["labels"].get("lares.proof.owner") != owner or
            peer_facts["imageId"] != report["images"]["keeper"]["imageId"]):
        raise RuntimeError("local MCP peer identity and ownership could not be verified")
    peer_container_id = peer_facts["id"]
    for _ in range(100):
        ready_facts = container_facts(peer_container_id)
        if ready_facts is None or ready_facts["id"] != peer_container_id or ready_facts["running"] is not True:
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
    peer_endpoint = inspect_owned_bridge_endpoint(peer_container, peer_container_id, network,
                                                  network_metadata["Id"], True)
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
    if facts["running"] is not True:
        raise RuntimeError("configured worker stopped before its assigned bridge endpoint was inspected")
    worker_endpoint = inspect_owned_bridge_endpoint(worker_container, worker_container_id, network,
                                                    network_metadata["Id"], True)
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
    shared_endpoints = inspect_shared_bridge_endpoints(network_metadata["Id"], worker_endpoint, peer_endpoint)
    live_projection_hashes = live_firewall_projection_hashes(root, shared_endpoints["worker"]["ipv4"])
    if facts is None or facts["id"] != worker_container_id or facts["status"] != "exited" or facts["exitCode"] != 0:
        worker_evidence = import_worker_evidence(root, shared_endpoints, live_projection_hashes, report)
        if worker_evidence:
            report["workerFailure"] = worker_evidence
        raise RuntimeError("configured production discovery worker did not complete")
    worker_evidence = import_worker_evidence(root, shared_endpoints, live_projection_hashes, report)
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
    if "ownedForwardRuleDiagnostic" not in report and forward_rule_diagnostic in FORWARD_RULE_DIAGNOSTICS:
        report["ownedForwardRuleDiagnostic"] = forward_rule_diagnostic
    if forward_rule_marker is not None:
        report["ownedForwardRuleEvidence"] = routed_forward_rule_evidence()
    if root is not None:
        if phase == "configured-discovery":
            worker_facts = None
            try:
                worker_facts = container_facts(worker_container_id or worker_container)
            except Exception:
                pass
            if worker_facts is not None and (worker_facts["labels"].get("lares.proof.owner") != owner or
                                             (worker_container_id and worker_facts["id"] != worker_container_id)):
                worker_facts = None
            preserve_worker_exit(report, root, worker_facts)
        preserve_worker_failure_evidence(report, root)
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

    if forward_rule_marker is not None:
        if worker_stopped and helpers_stopped and forward_rule_source and forward_rule_target:
            safe_cleanup("owned-routed-forward-rule-remove",
                         lambda: remove_routed_forward_allow(forward_rule_marker,
                             forward_rule_source, forward_rule_target))
        else:
            cleanup_failures.append("owned-routed-forward-rule-cleanup-skipped")

    resources_removed = worker_stopped and helpers_stopped
    if resources_removed:
        resources_removed = safe_cleanup("owned-container-remove", lambda: remove_labelled_containers(owner))
    network_removed = resources_removed
    if network is not None and worker_stopped and helpers_stopped:
        network_removed = safe_cleanup("owned-network-remove", lambda: cleanup_exact_network(network, owner))
    if routed_network is not None and worker_stopped and helpers_stopped:
        routed_network_removed = safe_cleanup("owned-routed-network-remove",
                                              lambda: cleanup_exact_network(routed_network, owner))
        network_removed = network_removed and routed_network_removed

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
            remaining_routed_network = command("docker", "network", "ls", "--quiet", "--no-trunc",
                                               "--filter", "name=^" + routed_network + "$") if routed_network else ""
            remaining_helpers = discover_owned_docker_helpers(root) if root is not None else []
            if remaining_owner.strip() or remaining_network.strip() or remaining_routed_network.strip() or remaining_helpers:
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
    if "ownedForwardRuleDiagnostic" not in report and forward_rule_diagnostic in FORWARD_RULE_DIAGNOSTICS:
        report["ownedForwardRuleDiagnostic"] = forward_rule_diagnostic
    if forward_rule_marker is not None:
        report["ownedForwardRuleEvidence"] = routed_forward_rule_evidence()
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
