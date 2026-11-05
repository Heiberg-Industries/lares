#!/usr/bin/env python3
"""Install Lares the way the guide says, on a disposable CI server, and use it.

Earlier proofs seed the database and start pieces by hand, so bugs on the real installed path never
reached them. This one runs get-lares.sh and install.sh from an ordinary folder, then signs in,
runs `lares owner-bootstrap`, `lares budget setup`, creates and adopts an agent on the console's
real pages, sets the member limit there, runs `lares agent start`, holds a chat where a tool runs,
an approval card is answered and the conversation carries on, sets up `lares backups`, then runs a
real `lares update` to a second build, runs `lares doctor`, and finishes by simulating a reboot and waiting for the agent to come back by itself. Nothing here writes to the
database or edits an installation file the installer owns.

WHAT IS NOT REAL, AND WHY. A CI server has no public address and cannot sign in to Google or spend
on a model. So, outside the installation:
  - the model provider and the sign-in provider are stand-ins (real-install/fake-internet.mjs) at
    their real names, over TLS from a throwaway test authority;
  - images come from a throwaway registry reached as ghcr.io, because the installer accepts only
    registry names without a port; nothing is published;
  - the domain ends in .internal, so Caddy issues its certificate from that authority (seeded into
    Caddy's data folder before the install) instead of from a public one;
  - the console and gateway images are the built or pinned ones plus that one authority, so they
    trust it. The compose files, settings and engine code are exactly what an owner gets.
Limits are also recorded in the proof file, so a green run cannot be read as more than it is.

This changes the machine it runs on (hosts file, firewall redirect, trust store), so it refuses to
run anywhere but a GitHub-hosted runner.
"""

from __future__ import annotations

import base64
import json
import os
import pathlib
import pty
import re
import select
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import date

REPO = pathlib.Path(__file__).resolve().parents[3]
HERE = pathlib.Path(__file__).resolve().parent / "real-install"
DOMAIN = "lares.internal"
OWNER_EMAIL = f"owner@{DOMAIN}"
AGENT = "proof-agent"
NETWORK = "lares-network"
REGISTRY_ADDRESS = "10.99.0.2"
FAKE_ADDRESS = "172.30.0.240"
ROUTE_ADDRESS = "172.30.0.241"
FAKE_HOSTS = ("api.anthropic.com", "accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com", f"uptime.{DOMAIN}")
TOOL_PROMPT = "PROOF_USE_A_TOOL please look at the tracks."
FOLLOW_UP_PROMPT = "PROOF_CARRY_ON and what did you find?"
APPROVAL_PROMPT = "PROOF_ASK_APPROVAL please make the track."
APPROVAL_TOOL = "track_create"
APPROVAL_TRACK = "proof-track"
APPROVAL_INPUT = {"trackId": APPROVAL_TRACK, "name": "Proof track", "purpose": "Shows an approval answer reaches the tool.",
                  "steps": ["Open", "Done"], "closingSteps": ["Done"]}
APPROVAL_REPLY = "PROOF_APPROVED_TOOL_RAN"
NOTE_PROMPT = "PROOF_ASK_NOTE please save the note."
NOTE_TOOL = "agent-kit__vault_write"
NOTE_INPUT = {"area": "private", "title": "Proof note", "body": "PROOF_NOTE_BODY saved from an approved card."}
NOTE_REPLY = "PROOF_APPROVED_NOTE_SAVED"
TOOL_REPLY = "PROOF_TOOL_RESULT_RECEIVED"
FOLLOW_UP_REPLY = "PROOF_CONVERSATION_KEPT"
MEMBER_LIMIT = "15"
INSTALL_TIMEOUT = 1500
LIMITS = [
    "The model provider and the sign-in provider are stand-ins: a real provider's replies are copied, not called.",
    "Images come from a throwaway registry, so pulling from the real registry is not covered.",
    "The console and gateway images carry one extra test certificate authority; a real server uses a public certificate.",
    "The certificate is issued by Caddy's own authority, so getting a public certificate is not covered.",
    "The sync-jobs image is named but never started on a fresh install, so it is not built or pulled here. The Notion sync is only checked up to its gate (nothing starts without an accepted preview); reaching Notion is not covered.",
    "Backups go to the same machine, and the uptime address is a stand-in: a real restore onto a new server is not covered.",
    "The approval step answers one card as the member who started the conversation; refusing other people's answers is covered by the private chat proof, not here.",
    "The update goes to a second build of the same code (a new label, so new digests): a release that changes code or adds migrations is not covered.",
    "Saving a definition in the console after the update is not exercised; agent start and the agent's restart are.",
    "The change of budget month is not covered: this run does not move the clock.",
    "One person only: a second member, and a real spending-limit refusal, are not covered.",
    "A real agent answer is not covered: the stand-in decides what the model says.",
    "A reboot is simulated by stopping Docker, deleting the keeper's folders under /run and starting Docker again; the kernel, the firewall tables and systemd units are not restarted, and the agent is only asked for its health answer.",
]

proof: dict = {"format": 1, "status": "running", "stage": "start", "checks": {}, "limits": LIMITS, "commit": None}
proof_path: pathlib.Path | None = None


def save_proof() -> None:
    if proof_path:
        proof_path.write_text(json.dumps(proof, indent=2) + "\n")


def stage(name: str) -> None:
    proof["stage"] = name
    save_proof()
    print(f"\n=== {name} ({time.strftime('%H:%M:%S')}) ===", flush=True)


def passed(check: str) -> None:
    proof["checks"][check] = True
    save_proof()
    print(f"PASS: {check}", flush=True)


def run(*command: str, timeout: int = 300, check: bool = True, env: dict | None = None, cwd: str | None = None,
        stdin: str | None = None, show: bool = True) -> subprocess.CompletedProcess:
    if show:
        print("+ " + " ".join(command)[:300], flush=True)
    merged = {**os.environ, **(env or {})}
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, env=merged, cwd=cwd, input=stdin)
    if show and result.stdout.strip():
        print(result.stdout.rstrip()[-6000:], flush=True)
    if show and result.stderr.strip():
        print(result.stderr.rstrip()[-3000:], flush=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"{command[0]} {' '.join(command[1:3])} exited {result.returncode}")
    return result


def output(*command: str, timeout: int = 120) -> str:
    return run(*command, timeout=timeout, show=False).stdout.strip()


# --- the throwaway outside world ---------------------------------------------------------------

def make_authority(work: pathlib.Path) -> dict[str, pathlib.Path]:
    """One test authority, in the form Caddy reads as its own, and leaf certificates from it."""
    tls = work / "tls"
    tls.mkdir()
    ca_key, ca_cert = tls / "root.key", tls / "root.crt"
    run("openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", str(ca_key), show=False)
    run("openssl", "req", "-x509", "-new", "-key", str(ca_key), "-sha256", "-days", "30", "-subj", "/CN=Lares real-install proof authority",
        "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", str(ca_cert), show=False)

    def leaf(name: str, hosts: tuple[str, ...]) -> tuple[pathlib.Path, pathlib.Path]:
        key, cert, csr, ext = tls / f"{name}-key.pem", tls / f"{name}.pem", tls / f"{name}.csr", tls / f"{name}.ext"
        ext.write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n"
                       "subjectAltName=" + ",".join(f"DNS:{host}" for host in hosts) + "\n")
        run("openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", str(key), show=False)
        run("openssl", "req", "-new", "-key", str(key), "-subj", f"/CN={hosts[0]}", "-out", str(csr), show=False)
        run("openssl", "x509", "-req", "-in", str(csr), "-CA", str(ca_cert), "-CAkey", str(ca_key), "-CAcreateserial", "-days", "30",
            "-sha256", "-extfile", str(ext), "-out", str(cert), show=False)
        return key, cert

    fake_key, fake_cert = leaf("fake", FAKE_HOSTS)
    registry_key, registry_cert = leaf("registry", ("ghcr.io",))
    return {"ca_key": ca_key, "ca_cert": ca_cert, "fake_key": fake_key, "fake_cert": fake_cert,
            "registry_key": registry_key, "registry_cert": registry_cert}


def trust_authority(tls: dict[str, pathlib.Path]) -> None:
    shutil.copy(tls["ca_cert"], "/usr/local/share/ca-certificates/lares-real-install-proof.crt")
    run("update-ca-certificates", show=False)
    # The docker daemon's own view of the throwaway registry.
    certs = pathlib.Path("/etc/docker/certs.d/ghcr.io")
    certs.mkdir(parents=True, exist_ok=True)
    shutil.copy(tls["ca_cert"], certs / "ca.crt")


def seed_caddy_authority(tls: dict[str, pathlib.Path]) -> None:
    """Caddy keeps an authority it finds here, rather than making its own."""
    authority = pathlib.Path("/var/lib/lares/caddy/caddy/pki/authorities/local")
    authority.mkdir(parents=True)
    shutil.copy(tls["ca_cert"], authority / "root.crt")
    shutil.copy(tls["ca_key"], authority / "root.key")


def trusting_image(work: pathlib.Path, base: str, tag: str, tls: dict[str, pathlib.Path], node: bool) -> None:
    """The image as built or pinned, plus the test authority. Never pushed anywhere that outlives this run."""
    context = work / f"image-{tag.replace('/', '-').replace(':', '-')}"
    context.mkdir()
    shutil.copy(tls["ca_cert"], context / "proof-authority.pem")
    if node:
        dockerfile = f"FROM {base}\nCOPY proof-authority.pem /etc/lares-proof-authority.pem\nENV NODE_EXTRA_CA_CERTS=/etc/lares-proof-authority.pem\n"
    else:
        # The gateway reads SSL_CERT_FILE as its one TLS trust setting.
        dockerfile = (f"FROM {base}\nCOPY proof-authority.pem /etc/lares-proof-authority.pem\n"
                      "ENV SSL_CERT_FILE=/etc/lares-proof-authority.pem\n")
    (context / "Dockerfile").write_text(dockerfile)
    run("docker", "build", "-q", "-t", tag, str(context), timeout=300)


def start_registry(work: pathlib.Path, tls: dict[str, pathlib.Path]) -> None:
    """Reached as ghcr.io:443 by a redirect, so nothing listens on 443 for the installer's port check to find."""
    certs = work / "registry-tls"
    certs.mkdir()
    shutil.copy(tls["registry_cert"], certs / "server.pem")
    shutil.copy(tls["registry_key"], certs / "server-key.pem")
    os.chmod(certs / "server-key.pem", 0o644)
    run("docker", "run", "-d", "--name", "proof-registry", "--restart", "unless-stopped", "-p", "127.0.0.1:5000:5000",
        "-v", f"{certs}:/certs:ro", "-e", "REGISTRY_HTTP_ADDR=0.0.0.0:5000",
        "-e", "REGISTRY_HTTP_TLS_CERTIFICATE=/certs/server.pem", "-e", "REGISTRY_HTTP_TLS_KEY=/certs/server-key.pem", "registry:2.8.3")
    run("iptables", "-t", "nat", "-A", "OUTPUT", "-p", "tcp", "-d", REGISTRY_ADDRESS, "--dport", "443", "-j", "REDIRECT", "--to-ports", "5000")


def wait_for_registry(tls: dict[str, pathlib.Path]) -> None:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        answer = run("curl", "-sS", "--cacert", str(tls["ca_cert"]), "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", "https://ghcr.io/v2/", check=False, show=False)
        if answer.stdout == "200":
            return
        time.sleep(1)
    run("curl", "-v", "--cacert", str(tls["ca_cert"]), "--max-time", "5", "https://ghcr.io/v2/", check=False)
    run("iptables", "-t", "nat", "-S", "OUTPUT", check=False)
    run("ss", "-ltnp", check=False)
    raise RuntimeError("the throwaway registry does not answer as ghcr.io")


def publish_locally(local: str, name: str) -> str:
    """Into the throwaway registry; the digest is the reference the release file names."""
    target = f"ghcr.io/{name}:proof"
    run("docker", "tag", local, target, show=False)
    run("docker", "push", "-q", target, timeout=600)
    digests = json.loads(output("docker", "image", "inspect", "--format", "{{json .RepoDigests}}", target))
    match = [digest for digest in digests if digest.startswith(f"ghcr.io/{name}@sha256:")]
    if not match:
        raise RuntimeError(f"{target} has no digest after the push")
    return match[0]


def write_release(work: pathlib.Path, images: dict[str, str], tls: dict[str, pathlib.Path], name: str = "real.install.proof") -> pathlib.Path:
    releases = sorted((REPO / "releases").glob("*.json"))
    newest = json.loads(releases[-1].read_text())
    box_sql = sorted(path.name for path in (REPO / "services/box/sql").glob("*.sql"))[-1]
    release = {
        "release": f"{date.today().isoformat()}-{name}",
        "images": {**newest["images"], **images},
        "migrations": {**newest["migrations"], "box": box_sql},
        "breaking": [],
    }
    path = work / f"{name}.json"
    path.write_text(json.dumps(release, indent=2) + "\n")
    print(json.dumps(release["images"], indent=2), flush=True)
    return path


def second_build(work: pathlib.Path, local: str, tag: str) -> None:
    """The same image with one more label: the code is unchanged and the digest is new, as an update needs."""
    context = work / f"second-{tag.replace('/', '-').replace(':', '-')}"
    context.mkdir()
    (context / "Dockerfile").write_text(f"FROM {local}\nLABEL org.lares.proof.build=second\n")
    run("docker", "build", "-q", "-t", tag, str(context), timeout=300)


def running_images() -> set[str]:
    ids = output("docker", "ps", "-q").split()
    return set(output("docker", "inspect", "--format", "{{.Config.Image}}", *ids).split()) if ids else set()


def agent_image() -> str | None:
    """The image the proof agent's running container was started from; None when it is not running."""
    ids = output("docker", "ps", "-q", "--filter", f"label=com.docker.compose.service=lares-{AGENT}").split()
    return output("docker", "inspect", "--format", "{{.Config.Image}}", ids[0]) if ids else None


def keeper_held_lines() -> list[str]:
    """What the keeper logged about held agents: fixed phrases, no values."""
    ids = output("docker", "ps", "-q", "--filter", "label=com.docker.compose.service=lares-keeper").split()
    if not ids:
        return ["the keeper is not running"]
    logs = run("docker", "logs", ids[0], check=False, show=False)
    return [line for line in (logs.stdout + logs.stderr).splitlines() if " is held: " in line or " is no longer held" in line]


def agent_answers() -> bool:
    """The proof agent's container is running and its health address says ok."""
    ids = output("docker", "ps", "-q", "--filter", f"label=com.docker.compose.service=lares-{AGENT}").split()
    if not ids:
        return False
    for address in output("docker", "inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", ids[0]).split():
        answer = run("curl", "-sS", "--max-time", "3", f"http://{address}:3000/eve/v1/health", check=False, show=False)
        if answer.returncode == 0 and re.search(r'"ok"\s*:\s*true', answer.stdout):
            return True
    return False


def simulate_reboot() -> None:
    """What a boot does to this server: every container goes down, /run starts empty, and Docker then
    starts all containers with a restart policy at the same moment. The keeper's own folders under
    /run (its sockets, and the model-purpose folder the agent mounts) are gone until the keeper makes
    them again, which is exactly the race a real reboot runs."""
    run("systemctl", "stop", "docker.socket", "docker", timeout=300)
    run("rm", "-rf", "/run/lares", "/run/lares-host")
    run("systemctl", "start", "docker", timeout=300)


def host_address() -> str:
    return output("hostname", "-I").split()[0]


def start_fake_internet(work: pathlib.Path, tls: dict[str, pathlib.Path], fixture_image: str, key_value: str) -> pathlib.Path:
    fixture = work / "fake"
    fixture.mkdir()
    shutil.copy(HERE / "fake-internet.mjs", fixture / "fake-internet.mjs")
    shutil.copy(tls["fake_cert"], fixture / "server.pem")
    shutil.copy(tls["fake_key"], fixture / "server-key.pem")
    os.chmod(fixture / "server-key.pem", 0o644)
    (fixture / "calls.jsonl").touch()
    os.chmod(fixture / "calls.jsonl", 0o666)
    (fixture / "settings.json").write_text(json.dumps({
        "clientId": CLIENT_ID, "clientSecret": CLIENT_SECRET, "subject": "proof-owner-subject", "email": OWNER_EMAIL,
        "providerKey": key_value, "uptimeHost": f"uptime.{DOMAIN}",
        "toolPrompt": "PROOF_USE_A_TOOL", "followUpPrompt": "PROOF_CARRY_ON", "toolReply": TOOL_REPLY, "followUpReply": FOLLOW_UP_REPLY,
        "toolPreference": ["tracks_list", "vault_list"],
        "approvalPrompt": "PROOF_ASK_APPROVAL", "approvalTool": APPROVAL_TOOL, "approvalInput": APPROVAL_INPUT, "approvalReply": APPROVAL_REPLY,
        "notePrompt": "PROOF_ASK_NOTE", "noteTool": NOTE_TOOL, "noteInput": NOTE_INPUT, "noteReply": NOTE_REPLY,
    }))
    run("docker", "run", "-d", "--name", "proof-fake", "--restart", "unless-stopped", "--user", "0:0", "--entrypoint", "node",
        "-v", f"{fixture}:/fixture", fixture_image, "/fixture/fake-internet.mjs", "serve", "/fixture")
    return fixture


CLIENT_ID = "100000000000-realinstallproof.apps.googleusercontent.com"
CLIENT_SECRET = "proof-client-secret-" + uuid.uuid4().hex


def bridge_address(container: str) -> str:
    return output("docker", "inspect", "--format", "{{.NetworkSettings.Networks.bridge.IPAddress}}", container)


def write_hosts(fake_ip: str) -> None:
    """Replaces any line naming these hosts: a hosted runner can already pin some of them."""
    wanted = {DOMAIN: host_address(), "ghcr.io": REGISTRY_ADDRESS, **{host: fake_ip for host in FAKE_HOSTS}}
    path = pathlib.Path("/etc/hosts")
    kept = [line for line in path.read_text().splitlines() if not set(line.split("#")[0].split()[1:]) & set(wanted)]
    path.write_text("\n".join(kept + [f"{address} {host}" for host, address in wanted.items()]) + "\n")
    # A push must never reach the real registry, so check before the first one.
    for host, address in wanted.items():
        found = output("getent", "ahostsv4", host).split()[0]
        if found != address:
            raise RuntimeError(f"{host} resolves to {found}, not {address}")


class WorldConnector(threading.Thread):
    """Join the stand-ins to the installation's network once the normal stack exists.

    Sooner would stop the installer: its bootstrap network must be removable, and an extra container
    on it would refuse that. This is the only thing done to a network the installer made.
    """

    def __init__(self, fixture_image: str) -> None:
        super().__init__(daemon=True)
        self.fixture_image = fixture_image
        self.stopping = threading.Event()
        self.joined = threading.Event()
        self.error: str | None = None

    def run(self) -> None:
        while not self.stopping.is_set():
            found = run("docker", "ps", "-q", "--filter", "label=com.docker.compose.service=console", check=False, show=False).stdout.strip()
            if found:
                try:
                    run("docker", "network", "connect", "--ip", FAKE_ADDRESS, *alias_flags(FAKE_HOSTS), NETWORK, "proof-fake")
                    # A container reaches the public address as on a real server: out, and back in through Caddy.
                    run("docker", "run", "-d", "--name", "proof-route", "--restart", "unless-stopped", "--network", NETWORK, "--ip", ROUTE_ADDRESS,
                        "--network-alias", DOMAIN, "--user", "0:0", "--entrypoint", "node",
                        "-v", f"{HERE / 'fake-internet.mjs'}:/fixture/fake-internet.mjs:ro", self.fixture_image,
                        "/fixture/fake-internet.mjs", "forward", host_address())
                    self.joined.set()
                except Exception as error:  # Reported by the main thread, which is watching the install.
                    self.error = str(error)
                return
            time.sleep(1)


def alias_flags(hosts: tuple[str, ...]) -> list[str]:
    return [flag for host in hosts for flag in ("--alias", host)]


def fake_calls(fixture: pathlib.Path) -> list[dict]:
    return [json.loads(line) for line in (fixture / "calls.jsonl").read_text().splitlines() if line.strip()]


# --- the owner's steps ---------------------------------------------------------------------------

def wait_for_quiet_network() -> None:
    """Chromium drops requests in flight whenever a container's network interface appears."""
    deadline = time.monotonic() + 60
    seen, since = "", time.monotonic()
    while time.monotonic() < deadline:
        now = output("ip", "-o", "link")
        if now != seen:
            seen, since = now, time.monotonic()
        elif time.monotonic() - since >= 8:
            return
        time.sleep(1)


def browser(step: str, settings_file: pathlib.Path, tls: dict[str, pathlib.Path]) -> None:
    """Tries again only when the browser itself reports that interface change, never on a page's answer."""
    for attempt in range(3):
        wait_for_quiet_network()
        result = run("node", str(HERE / "browser.mjs"), step, str(settings_file), timeout=420, cwd=str(HERE),
                     env={"NODE_EXTRA_CA_CERTS": str(tls["ca_cert"])}, check=False)
        if result.returncode == 0:
            passed(f"browser:{step}")
            return
        if "ERR_NETWORK_CHANGED" not in result.stdout:
            break
    raise RuntimeError(f"the browser step {step} failed")


def wait_for_sign_in_offer() -> None:
    """The console answers, over the real certificate check, and sends a person on to sign in."""
    deadline = time.monotonic() + 120
    answer = ""
    while time.monotonic() < deadline:
        answer = run("curl", "-sS", "-o", "/dev/null", "-w", "%{http_code} %{redirect_url}", "--max-time", "10",
                     f"https://{DOMAIN}/api/auth/login", check=False, show=False).stdout
        if re.match(r"30[27] https://accounts\.google\.com/", answer):
            return
        time.sleep(2)
    raise RuntimeError(f"the console does not offer sign-in: {answer}")


def owner_bootstrap(receipt: str) -> str:
    """`lares owner-bootstrap` reads the JSON at a no-echo prompt, so give it a real terminal."""
    pid, fd = pty.fork()
    if pid == 0:
        os.execv("/usr/local/bin/lares", ["lares", "owner-bootstrap"])
    text = b""
    sent = False
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 1)
        if ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            text += chunk
        if not sent and b"Paste the owner setup JSON" in text:
            os.write(fd, receipt.encode() + b"\n")
            sent = True
    _, status = os.waitpid(pid, 0)
    said = text.decode(errors="replace")
    print(said, flush=True)
    if os.waitstatus_to_exitcode(status) != 0:
        raise RuntimeError("lares owner-bootstrap refused")
    return said


def read_only_query(sql: str, release: dict) -> str:
    """A read for checking results. The financial login is the one allowed to read these tables."""
    password = pathlib.Path("/etc/lares/secrets/financial-database-password").read_text().strip()
    return run("docker", "run", "--rm", "--network", "host", "-e", f"PGPASSWORD={password}", "-e", "PGOPTIONS=-c default_transaction_read_only=on",
               "--entrypoint", "psql", release["images"]["db"], "-h", "127.0.0.1", "-U", "lares_financial", "-d", "lares_state", "-Atc", sql, show=False).stdout.strip()


def keeper_host_action(action: str, payload: dict) -> dict:
    """One action over the keeper's host socket, the way the lares commands reach it. Returns the reply as sent."""
    import socket
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(180)
        connection.connect("/run/lares-host/keeper.sock")
        connection.sendall((json.dumps({"action": action, "input": payload, "actor": "host"}) + "\n").encode())
        connection.shutdown(socket.SHUT_WR)
        data = b""
        while True:
            chunk = connection.recv(65536)
            if not chunk:
                break
            data += chunk
    return json.loads(data)


def notion_sync_containers() -> str:
    return output("docker", "ps", "-a", "-q", "--filter", "label=com.docker.compose.service=lares-notion-sync")


def diagnostics(fixture: pathlib.Path | None) -> None:
    print("\n=== diagnostics ===", flush=True)
    run("docker", "info", "--format", "{{.ServerVersion}} {{.Driver}} {{.DriverStatus}}", check=False)
    run("docker", "ps", "-a", "--format", "table {{.Names}}\t{{.Status}}\t{{.Image}}", check=False)
    # Who owns the installation's folders and files, for a refusal that names no path.
    run("stat", "-c", "%u %g %a %n", "/", "/etc", "/opt", "/srv", "/var", "/var/lib", check=False)
    run("find", "/etc/lares", "/opt/lares", "/srv/lares", "/var/lib/lares-maintenance", "/var/lib/lares-budget-setup", "-maxdepth", "2", "-printf", "%U %G %m %y %p\n", check=False)
    names = run("docker", "ps", "-a", "--format", "{{.Names}}", check=False, show=False).stdout.split()
    for name in names:
        if "buildkit" in name:
            continue
        print(f"\n--- logs: {name} ---", flush=True)
        logs = run("docker", "logs", "--tail", "120", name, check=False, show=False)
        print((logs.stdout + logs.stderr)[-6000:], flush=True)
    if fixture and (fixture / "calls.jsonl").exists():
        print("\n--- stand-in calls ---", flush=True)
        print((fixture / "calls.jsonl").read_text()[-8000:], flush=True)


def match_fresh_server_folders() -> None:
    """A hosted runner's /opt is wide open and makes every new folder wide open, whatever the umask.

    The installation's safety checks rightly refuse that, and a fresh Ubuntu server does not do it.
    """
    os.umask(0o022)
    if not shutil.which("setfacl"):
        run("apt-get", "update", "-qq", timeout=300, show=False)
        run("apt-get", "install", "-y", "-qq", "acl", timeout=300, show=False)
    run("setfacl", "-b", "/opt")
    os.chmod("/opt", 0o755)
    trial = pathlib.Path("/opt/lares-proof-folder-trial")
    trial.mkdir()
    mode = trial.stat().st_mode & 0o777
    trial.rmdir()
    if mode != 0o755:
        raise RuntimeError(f"a new folder under /opt is still mode {mode:o}")


def main(argv: list[str]) -> int:
    global proof_path
    if len(argv) != 8 or os.environ.get("GITHUB_ACTIONS") != "true" or os.geteuid() != 0:
        print("usage (root, on a GitHub-hosted runner only): real-install-image.probe.py <keeper> <egress> <firewall> <console> <chief> <creative> <commit> <proof.json>", file=sys.stderr)
        return 64
    keeper, egress, firewall, console, chief, creative, commit, proof_file = argv
    proof_path = pathlib.Path(proof_file)
    proof_path.parent.mkdir(parents=True, exist_ok=True)
    proof["commit"] = commit
    save_proof()
    match_fresh_server_folders()
    work = pathlib.Path(tempfile.mkdtemp(prefix="lares-real-install-", dir="/var/tmp"))
    os.chmod(work, 0o755)
    fixture: pathlib.Path | None = None
    try:
        stage("the outside world")
        tls = make_authority(work)
        trust_authority(tls)
        newest = json.loads(sorted((REPO / "releases").glob("*.json"))[-1].read_text())
        console_trusting, gateway_trusting = "proof/console-trusting:local", "proof/gateway-trusting:local"
        trusting_image(work, console, console_trusting, tls, node=True)
        # Pulled from the real registry before the hosts file points that name at the throwaway one.
        trusting_image(work, newest["images"]["lares-gateway"], gateway_trusting, tls, node=False)
        model_key = "sk-ant-api03-" + base64.urlsafe_b64encode(os.urandom(40)).decode().rstrip("=")
        fixture = start_fake_internet(work, tls, console, model_key)
        start_registry(work, tls)
        write_hosts(bridge_address("proof-fake"))
        wait_for_registry(tls)
        # Docker keeps its copy of the hosts file for five seconds after any lookup, and it just pulled.
        time.sleep(10)
        # Release key -> (the local image, its name in the registry). The gateway is not rebuilt for
        # the update, so the update also proves it leaves an unchanged image alone.
        engine_images = {
            "lares-keeper": (keeper, "heiberg-industries/lares-engine-keeper"),
            "lares-egress-proxy": (egress, "heiberg-industries/lares-engine-egress-proxy"),
            "lares-firewall-helper": (firewall, "heiberg-industries/lares-engine-firewall-helper"),
            "console": (console_trusting, "heiberg-industries/lares-engine-console"),
            "chief-of-staff": (chief, "heiberg-industries/lares-engine-chief-of-staff-runtime"),
            "creative": (creative, "heiberg-industries/lares-engine-creative-runtime"),
        }
        release_file = write_release(work, {
            **{key: publish_locally(local, name) for key, (local, name) in engine_images.items()},
            "lares-gateway": publish_locally(gateway_trusting, "berriai/litellm"),
        }, tls)
        release = json.loads(release_file.read_text())
        passed("registry-holds-the-images")

        stage("the owner's answers, before the installer runs")
        seed_caddy_authority(tls)
        # The guide has the owner save the Google client before running the installer.
        etc = pathlib.Path("/etc/lares")
        etc.mkdir(mode=0o755, exist_ok=True)
        oauth = etc / "console-oauth.env"
        oauth.write_text(f"GOOGLE_CLIENT_ID_CONSOLE={CLIENT_ID}\nGOOGLE_CLIENT_SECRET_CONSOLE={CLIENT_SECRET}\n")
        os.chown(oauth, 0, 0)
        os.chmod(oauth, 0o600)
        home = pathlib.Path("/home/lares-proof-owner")
        home.mkdir(mode=0o755)
        key_file = home / "model-key"
        key_file.write_text(model_key + "\n")
        os.chmod(key_file, 0o600)
        shutil.copy(REPO / "services/box/ops/get-lares.sh", home / "get-lares.sh")
        shutil.copy(release_file, home / "release.json")

        stage("get-lares.sh and install.sh, from an ordinary folder")
        connector = WorldConnector(console)
        connector.start()
        install = subprocess.Popen(["bash", "get-lares.sh", "--release-file", "release.json", "--yes", "--domain", DOMAIN, "--email", OWNER_EMAIL,
                                    "--name", "Proof Owner", "--model-key-file", str(key_file)], cwd=home, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        pump = threading.Thread(target=lambda: [print(line, end="", flush=True) for line in install.stdout], daemon=True)
        pump.start()
        code = install.wait(timeout=INSTALL_TIMEOUT)
        connector.stopping.set()
        pump.join(timeout=5)
        if connector.error:
            raise RuntimeError(f"joining the stand-ins to the installation's network failed: {connector.error}")
        if code != 0:
            raise RuntimeError(f"the install exited {code}")
        if not connector.joined.wait(timeout=30):
            raise RuntimeError("the installer finished without the console ever running")
        if not pathlib.Path("/usr/local/bin/lares").is_symlink():
            raise RuntimeError("the installer finished without installing the lares command")
        passed("install-finished-from-an-ordinary-folder")
        wait_for_sign_in_offer()
        passed("console-answers-over-https-and-offers-sign-in")

        stage("first owner sign-in and owner-bootstrap")
        shots = pathlib.Path(proof_file).parent / "real-install-screenshots"
        shots.mkdir(exist_ok=True)
        settings_file = work / "browser.json"
        settings_file.write_text(json.dumps({
            "domain": DOMAIN, "agent": AGENT, "memberLimit": MEMBER_LIMIT, "toolPrompt": TOOL_PROMPT, "followUpPrompt": FOLLOW_UP_PROMPT,
            "approvalPrompt": APPROVAL_PROMPT, "approvalReply": APPROVAL_REPLY, "notePrompt": NOTE_PROMPT, "noteReply": NOTE_REPLY, "toolReply": TOOL_REPLY, "followUpReply": FOLLOW_UP_REPLY, "receiptFile": str(work / "receipt.json"), "stateFile": str(work / "browser-state.json"),
            "screenshotDir": str(shots),
        }))
        browser("discover-owner", settings_file, tls)
        owner_bootstrap((work / "receipt.json").read_text())
        passed("owner-bootstrap-accepted-the-receipt")
        # The guide's command for this step, word for word.
        run("docker", "compose", "-f", "/opt/lares/compose.yaml", "up", "-d", "--no-deps", "--force-recreate", "console", env={"COMPOSE_IGNORE_ORPHANS": "1"}, timeout=180)
        wait_for_sign_in_offer()
        browser("sign-in", settings_file, tls)

        stage("sudo lares budget setup")
        run("lares", "budget", "setup", "--installation-limit", "30", "--person-limit", MEMBER_LIMIT, "--yes", timeout=600)
        passed("budget-setup-finished")

        stage("create, adopt and limit on the console's pages")
        browser("create-agent", settings_file, tls)
        browser("adopt", settings_file, tls)
        browser("member-limit", settings_file, tls)

        stage("sudo lares agent start")
        run("lares", "agent", "start", AGENT, timeout=600)
        passed("agent-start-finished")

        stage("a chat where a tool runs and the conversation carries on")
        browser("chat", settings_file, tls)
        models = [call for call in fake_calls(fixture) if call["kind"] == "model"]
        tool_calls = [index for index, call in enumerate(models) if call["answer"].get("tool")]
        if not tool_calls:
            raise RuntimeError("the model was never answered with a tool call")
        follow_up = models[tool_calls[0] + 1:]
        if not any({"type": "direct"} in call["returnedCallers"] for call in follow_up):
            raise RuntimeError("no later request carried the tool call back with its caller")
        passed("tool-call-came-back-to-the-provider-with-its-caller")
        proof["modelCalls"] = [{"tool": call["answer"].get("tool"), "messages": call["messages"], "returnedCallers": call["returnedCallers"], "toolResults": call["toolResults"]} for call in models]
        save_proof()
        # Recorded now and reported at the end, so one fault does not hide the steps after it.
        deferred: list[str] = []
        failed_tools = [result for call in models for result in call["toolResults"] if result["isError"]]
        if failed_tools:
            deferred.append(f"a tool call came back as failed: {failed_tools}")
        written = list(pathlib.Path("/srv/vault").rglob(f"tracks/{APPROVAL_TRACK}/track.md"))
        if len(written) == 1:
            passed("approval-answer-ran-the-tool-and-wrote-the-file")
        else:
            deferred.append(f"the approved tool did not write its one file: {written}")
        notes = list(pathlib.Path("/srv/vault").rglob("private/*/_inbox/proof-note.md"))
        if len(notes) == 1 and "PROOF_NOTE_BODY" in notes[0].read_text():
            passed("approved-vault-note-was-written-to-the-private-area")
        else:
            deferred.append(f"the approved Vault note did not write its one private file: {notes}")
        deadline = time.monotonic() + 60
        while True:
            attempts = read_only_query("SELECT state, count(*) FROM budget_attempts GROUP BY state ORDER BY state", release)
            states = dict(line.split("|") for line in attempts.splitlines())
            if int(states.get("settled", 0)) >= len(models) and not set(states) - {"settled", "retired"}:
                break
            if time.monotonic() > deadline:
                raise RuntimeError(f"not every model call settled in the budget ledger ({len(models)} calls): {attempts}")
            time.sleep(3)
        print(f"budget attempts by state:\n{attempts}", flush=True)
        passed("every-model-call-settled-in-the-budget-ledger")

        stage("sudo lares backups")
        run("apt-get", "update", "-qq", timeout=300, show=False)
        run("apt-get", "install", "-y", "-qq", "restic", "age", timeout=300, show=False)
        age_key = run("age-keygen", show=False).stdout
        recipient = re.search(r"public key: (age1\S+)", age_key)
        run("lares", "backups", "--yes", "--password-saved", "--accept-same-machine", "--repository", "/var/backups/lares-proof",
            "--age-recipient", recipient.group(1), "--hc-url", f"https://uptime.{DOMAIN}/ping", timeout=900)
        passed("backup-restore-rehearsal-and-check-ran")

        stage("a second build, and sudo lares update to it")
        second_images = {}
        for key, (local, name) in engine_images.items():
            second = f"proof/second-{key}:local"
            second_build(work, local, second)
            second_images[key] = publish_locally(second, name)
        second_images["lares-gateway"] = release["images"]["lares-gateway"]
        update_file = write_release(work, second_images, tls, name="real.install.proof.update")
        update = json.loads(update_file.read_text())
        shutil.copy(update_file, home / "update-release.json")
        agent_image_before = agent_image()
        # No --even-though-the-backup-is-unproven: the backup set up above is proven, and the update must see that.
        updated = run("lares", "update", "--release-file", str(home / "update-release.json"), "--yes", timeout=1500, check=False, cwd=str(home))
        said = updated.stdout + updated.stderr
        if updated.returncode != 0:
            raise RuntimeError(f"lares update exited {updated.returncode}")
        if "unproven backup" in said:
            raise RuntimeError("lares update did not see the proven backup")
        if not re.search(r"snapshot [0-9a-f]+ saved", said):
            raise RuntimeError("lares update did not take its own backup first")
        passed("update-saw-the-proven-backup-and-took-its-own")
        if os.readlink("/opt/lares/current") != f"releases/{update['release']}":
            raise RuntimeError(f"current points at {os.readlink('/opt/lares/current')} after the update")
        running = running_images()
        for key in ("console", "lares-keeper", "lares-egress-proxy"):
            if update["images"][key] not in running or release["images"][key] in running:
                raise RuntimeError(f"{key} is not running the second build after the update: {sorted(running)}")
        if release["images"]["lares-gateway"] not in running:
            raise RuntimeError(f"the unchanged gateway is not running after the update: {sorted(running)}")
        passed("update-runs-the-second-build")
        wait_for_sign_in_offer()
        kept = (len(list(pathlib.Path("/srv/vault").rglob(f"tracks/{APPROVAL_TRACK}/track.md"))) == len(written) and
                len(list(pathlib.Path("/srv/vault").rglob("private/*/_inbox/proof-note.md"))) == len(notes))
        settled_after = read_only_query("SELECT count(*) FROM budget_attempts WHERE state = 'settled'", update)
        if not kept or int(settled_after or 0) < int(states.get("settled", 0)):
            raise RuntimeError(f"the update lost data: Vault files kept {kept}, settled calls {settled_after}")
        passed("update-kept-the-data-and-sign-in")
        proof["agentImage"] = {"beforeUpdate": agent_image_before, "afterUpdate": agent_image(), "secondBuild": update["images"]["chief-of-staff"]}
        proof["keeperHeldAfterUpdate"] = keeper_held_lines()
        save_proof()
        if f"{AGENT} restarted on this release" not in said or proof["agentImage"]["afterUpdate"] != update["images"]["chief-of-staff"]:
            raise RuntimeError(f"the running agent did not move to the second build: {proof['agentImage']}")
        passed("update-moved-the-running-agent-to-the-second-build")
        # What the owner ran on a real server after an update: it must find the agent running, not held.
        again = run("lares", "agent", "start", AGENT, timeout=300, check=False)
        if again.returncode != 0 or f"{AGENT} is already running" not in again.stdout + again.stderr:
            proof["keeperHeldAfterUpdate"] = keeper_held_lines()
            save_proof()
            raise RuntimeError("lares agent start after the update did not find the agent running")
        passed("agent-start-after-the-update-finds-it-running")

        stage("sudo lares doctor")
        doctor = run("lares", "doctor", timeout=180, check=False)
        said = doctor.stdout + doctor.stderr
        if doctor.returncode != 0:
            raise RuntimeError("lares doctor reported a failed check")
        if "Every migration on disk has already been applied." not in said:
            raise RuntimeError("lares doctor gave no real answer on migrations")
        passed("doctor-answers-on-migrations")
        parity = [line for line in said.splitlines() if "Matches the release" in line]
        if len(parity) != 1 or not parity[0].startswith("PASS"):
            raise RuntimeError(f"the parity check did not read ok on this install: {parity or 'no such line'}")
        passed("doctor-parity-reads-ok-on-a-fresh-install")

        # One harmless hand-set key in keeper.json must be named by path and fail the doctor; the
        # file is put back byte for byte afterwards (the keeper only reads it when it starts).
        keeper_json = pathlib.Path("/etc/lares/keeper.json")
        keeper_record = pathlib.Path("/etc/lares/keeper.json.rendered")
        json_before, record_before, json_mode = keeper_json.read_bytes(), keeper_record.read_bytes(), keeper_json.stat().st_mode & 0o777
        try:
            edited = json.loads(json_before)
            edited["handSetProbeKey"] = True
            keeper_json.write_text(json.dumps(edited, indent=2) + "\n")
            os.chmod(keeper_json, json_mode)
            tampered = run("lares", "doctor", timeout=180, check=False)
            tampered_said = tampered.stdout + tampered.stderr
        finally:
            keeper_json.write_bytes(json_before)
            os.chmod(keeper_json, json_mode)
        if keeper_json.read_bytes() != json_before or keeper_record.read_bytes() != record_before:
            raise RuntimeError("keeper.json or its installer record was not restored exactly")
        if tampered.returncode == 0 or "handSetProbeKey" not in tampered_said:
            raise RuntimeError("the parity check did not name a hand-set keeper.json key and fail")
        passed("doctor-parity-names-a-hand-set-key-and-fails")

        stage("the Notion sync is off, and stays off without an accepted preview")
        services_file = pathlib.Path(json.loads(pathlib.Path("/etc/lares/keeper.json").read_text())["lifecycle"]["services"]["composeFile"])
        if notion_sync_containers() or services_file.exists():
            raise RuntimeError("a fresh install has a Notion sync container or a rendered services file")
        passed("no-sync-container-on-a-fresh-install")
        reply = keeper_host_action("sync.notion_get", {})
        if reply.get("ok") is not True or reply["result"]["phase"] != "off":
            raise RuntimeError(f"the Notion sync did not report itself off: {reply}")
        # Switched on, with no preview ever accepted: still nothing may start or be written for it.
        reply = keeper_host_action("sync.notion_set", {"enabled": True, "peopleDataSource": ""})
        if reply.get("ok") is not True or reply["result"]["phase"] == "on":
            raise RuntimeError(f"switching the Notion sync on without a preview put it on: {reply}")
        if notion_sync_containers() or services_file.exists():
            raise RuntimeError("the Notion sync started, or its files were rendered, without an accepted preview")
        refused = keeper_host_action("sync.notion_accept", {"hash": "0" * 64})
        if refused.get("ok") is not False:
            raise RuntimeError(f"accepting a preview that was never run was not refused: {refused}")
        if keeper_host_action("sync.notion_set", {"enabled": False, "peopleDataSource": ""}).get("ok") is not True:
            raise RuntimeError("switching the Notion sync off again failed")
        passed("notion-sync-starts-nothing-without-an-accepted-preview")

        stage("a reboot: the agent comes back with no one running a command")
        simulate_reboot()
        deadline = time.monotonic() + 420
        while not agent_answers():
            if time.monotonic() > deadline:
                listing = run("docker", "ps", "-a", "--format", "{{.Names}}: {{.Status}}", check=False, show=False).stdout
                raise RuntimeError(f"after the simulated reboot the agent was not running and answering within 7 minutes. Containers:\n{listing}")
            time.sleep(5)
        passed("agent-comes-back-after-a-reboot-without-agent-start")

        stage("faults recorded along the way")
        if deferred:
            raise RuntimeError("; ".join(deferred))

        proof["status"] = "passed"
        proof["stage"] = "done"
        save_proof()
        print("\nThe real install path passed. Its limits:\n- " + "\n- ".join(LIMITS), flush=True)
        return 0
    except Exception as error:
        proof["status"] = "failed"
        proof["failure"] = str(error)[:600]
        save_proof()
        print(f"\nFAILED at '{proof['stage']}': {error}", flush=True)
        diagnostics(fixture)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
