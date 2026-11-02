#!/usr/bin/env python3
"""Install Lares the way the guide says, on a disposable CI server, and use it.

Earlier proofs seed the database and start pieces by hand, so bugs on the real installed path never
reached them. This one runs get-lares.sh and install.sh from an ordinary folder, then signs in,
runs `lares owner-bootstrap`, `lares budget setup`, creates and adopts an agent on the console's
real pages, sets the member limit there, runs `lares agent start`, holds a chat where a tool runs
and the conversation carries on, and finishes with `lares backups` and `lares doctor`. Nothing here
writes to the database or edits an installation file the installer owns.

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
TOOL_REPLY = "PROOF_TOOL_RESULT_RECEIVED"
FOLLOW_UP_REPLY = "PROOF_CONVERSATION_KEPT"
MEMBER_LIMIT = "15"
INSTALL_TIMEOUT = 1500
LIMITS = [
    "The model provider and the sign-in provider are stand-ins: a real provider's replies are copied, not called.",
    "Images come from a throwaway registry, so pulling from the real registry is not covered.",
    "The console and gateway images carry one extra test certificate authority; a real server uses a public certificate.",
    "The certificate is issued by Caddy's own authority, so getting a public certificate is not covered.",
    "The sync-jobs image is named but never started on a fresh install, so it is not built or pulled here.",
    "Backups go to the same machine, and the uptime address is a stand-in: a real restore onto a new server is not covered.",
    "One person only: a second member, and a real spending-limit refusal, are not covered.",
    "A real agent answer is not covered: the stand-in decides what the model says.",
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


def write_release(work: pathlib.Path, images: dict[str, str], tls: dict[str, pathlib.Path]) -> pathlib.Path:
    releases = sorted((REPO / "releases").glob("*.json"))
    newest = json.loads(releases[-1].read_text())
    box_sql = sorted(path.name for path in (REPO / "services/box/sql").glob("*.sql"))[-1]
    release = {
        "release": f"{date.today().isoformat()}-real.install.proof",
        "images": {**newest["images"], **images},
        "migrations": {**newest["migrations"], "box": box_sql},
        "breaking": [],
    }
    path = work / "release.json"
    path.write_text(json.dumps(release, indent=2) + "\n")
    print(json.dumps(release["images"], indent=2), flush=True)
    return path


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

def browser(step: str, settings_file: pathlib.Path) -> None:
    run("node", str(HERE / "browser.mjs"), step, str(settings_file), timeout=420, cwd=str(HERE))
    passed(f"browser:{step}")


def wait_for_sign_in_offer() -> None:
    """The console answers, over the real certificate check, and sends a person on to sign in."""
    deadline = time.monotonic() + 120
    answer = ""
    while time.monotonic() < deadline:
        answer = run("curl", "-sS", "-o", "/dev/null", "-w", "%{http_code} %{redirect_url}", "--max-time", "10",
                     f"https://{DOMAIN}/api/auth/login", check=False, show=False).stdout
        if answer.startswith("302 https://accounts.google.com/"):
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


def diagnostics(fixture: pathlib.Path | None) -> None:
    print("\n=== diagnostics ===", flush=True)
    run("docker", "info", "--format", "{{.ServerVersion}} {{.Driver}} {{.DriverStatus}}", check=False)
    run("docker", "ps", "-a", "--format", "table {{.Names}}\t{{.Status}}\t{{.Image}}", check=False)
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
        release_file = write_release(work, {
            "lares-keeper": publish_locally(keeper, "heiberg-industries/lares-engine-keeper"),
            "lares-egress-proxy": publish_locally(egress, "heiberg-industries/lares-engine-egress-proxy"),
            "lares-firewall-helper": publish_locally(firewall, "heiberg-industries/lares-engine-firewall-helper"),
            "console": publish_locally(console_trusting, "heiberg-industries/lares-engine-console"),
            "chief-of-staff": publish_locally(chief, "heiberg-industries/lares-engine-chief-of-staff-runtime"),
            "creative": publish_locally(creative, "heiberg-industries/lares-engine-creative-runtime"),
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
            "toolReply": TOOL_REPLY, "followUpReply": FOLLOW_UP_REPLY, "receiptFile": str(work / "receipt.json"), "stateFile": str(work / "browser-state.json"),
            "screenshotDir": str(shots),
        }))
        browser("discover-owner", settings_file)
        owner_bootstrap((work / "receipt.json").read_text())
        passed("owner-bootstrap-accepted-the-receipt")
        # The guide's command for this step, word for word.
        run("docker", "compose", "-f", "/opt/lares/compose.yaml", "up", "-d", "--no-deps", "--force-recreate", "console", env={"COMPOSE_IGNORE_ORPHANS": "1"}, timeout=180)
        wait_for_sign_in_offer()
        browser("sign-in", settings_file)

        stage("sudo lares budget setup")
        run("lares", "budget", "setup", "--installation-limit", "30", "--person-limit", MEMBER_LIMIT, "--yes", timeout=600)
        passed("budget-setup-finished")

        stage("create, adopt and limit on the console's pages")
        browser("create-agent", settings_file)
        browser("adopt", settings_file)
        browser("member-limit", settings_file)

        stage("sudo lares agent start")
        run("lares", "agent", "start", AGENT, timeout=600)
        passed("agent-start-finished")

        stage("a chat where a tool runs and the conversation carries on")
        browser("chat", settings_file)
        models = [call for call in fake_calls(fixture) if call["kind"] == "model"]
        tool_calls = [index for index, call in enumerate(models) if call["answer"].get("tool")]
        if not tool_calls:
            raise RuntimeError("the model was never answered with a tool call")
        follow_up = models[tool_calls[0] + 1:]
        if not any({"type": "direct"} in call["returnedCallers"] for call in follow_up):
            raise RuntimeError("no later request carried the tool call back with its caller")
        passed("tool-call-came-back-to-the-provider-with-its-caller")
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

        stage("sudo lares doctor")
        doctor = run("lares", "doctor", timeout=180, check=False)
        said = doctor.stdout + doctor.stderr
        if doctor.returncode != 0:
            raise RuntimeError("lares doctor reported a failed check")
        if "Every migration on disk has already been applied." not in said:
            raise RuntimeError("lares doctor gave no real answer on migrations")
        passed("doctor-answers-on-migrations")

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
