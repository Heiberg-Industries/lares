#!/usr/bin/env python3
"""Install Lares the way the guide says, on a disposable CI server, and use it.

Earlier proofs seed the database and start pieces by hand, so bugs on the real installed path never
reached them. This one runs get-lares.sh and install.sh from an ordinary folder, then signs in,
runs `lares owner-bootstrap`, `lares budget setup`, creates and adopts an agent on the console's
real pages, sets the member limit there, runs `lares agent start`, holds a chat where a tool runs,
an approval card is answered and the conversation carries on, edits the started agent's description on
its page, then connects a Slack and a Telegram door on that page as the install guide orders it (the agent
already started) and sends one message through each, sets up `lares backups`, then runs a
real `lares update` to a second build, runs `lares doctor`, simulates a reboot and waits for the agent to come back by itself. Up to there nothing writes to the
database or edits an installation file the installer owns. It finishes by restoring a backup whose agent store the release before this
one left onto this machine wiped and installed again (the last stage, further down, says what it changes and why).

WHAT IS NOT REAL, AND WHY. A CI server has no public address and cannot sign in to Google or spend
on a model. So, outside the installation:
  - the model provider, the sign-in provider and Slack's and Telegram's APIs are stand-ins
    (real-install/fake-internet.mjs) at their real names, over TLS from a throwaway test authority;
  - images come from a throwaway registry reached as ghcr.io, because the installer accepts only
    registry names without a port; nothing is published;
  - the domain ends in .internal, so Caddy issues its certificate from that authority (seeded into
    Caddy's data folder before the install) instead of from a public one;
  - the console, gateway, keeper and chief-of-staff images are the built or pinned ones plus that
    one authority, so they trust it. The compose files, settings and engine code are exactly what an
    owner gets.
Limits are also recorded in the proof file, so a green run cannot be read as more than it is.

This changes the machine it runs on (hosts file, firewall redirect, trust store), so it refuses to
run anywhere but a GitHub-hosted runner.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
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
FAKE_HOSTS = ("api.anthropic.com", "accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com", f"uptime.{DOMAIN}",
              "slack.com", "api.telegram.org")
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
DOOR_PROMPT = "PROOF_DOOR_TURN"
DOOR_REPLY = "PROOF_DOOR_REPLY"
# Neutral ids for the person behind each door, and the private chat the door talks in.
DOOR_PERSON = {"slack": "U0PROOFOWNER", "telegram": "700000001"}
DOOR_CHAT = {"slack": "D0PROOF", "telegram": "700000001"}
CLAIM_REPLY = "Connected. Once setup finishes applying"
# A door's Connect and Apply restart the agent, which changes the runner's network while the page waits;
# in an earlier run each needed its last of three attempts.
DOOR_STEP_ATTEMPTS = 6
# Words of eve's error copy, which must never be what a door turn posts into the chat.
ERROR_COPY = ("I hit an error", "MODEL_CALL_FAILED", "/run/secrets")
MEMBER_LIMIT = "15"
EDITED_DESCRIPTION = "PROOF_EDITED_DESCRIPTION written on the console page while the agent runs."
SAVE_WARNING = "open web-chat conversations, and any approval waiting in them. Start a new conversation afterwards."
INSTALL_TIMEOUT = 1500
LIMITS = [
    "The model provider and the sign-in provider are stand-ins: a real provider's replies are copied, not called.",
    "Images come from a throwaway registry, so pulling from the real registry is not covered.",
    "The console, gateway, keeper and chief-of-staff images carry one extra test certificate authority; a real server uses a public certificate.",
    "The certificate is issued by Caddy's own authority, so getting a public certificate is not covered.",
    "The sync-jobs image is named but never started on a fresh install, so it is not built or pulled here. The Notion sync is only checked up to its gate (nothing starts without an accepted preview); reaching Notion is not covered.",
    "Backups go to the same machine, and the uptime address is a stand-in.",
    "The approval step answers two cards (a Track and a Vault note), both with Approve, as the member who started the conversation; refusing other people's answers is covered by the private chat proof, not here.",
    "Who pays is checked for one person and Approve only: how the call after a Deny is booked, and booking to a second member, are covered by the box tests, not here.",
    "The check of who pays after an answered card reads web chat only; it does not exercise Slack or Telegram turns (the door stage checks those).",
    "The update goes to a second build of the same code (a new label, so new digests): a release that changes code or adds migrations is not covered.",
    "Saving a definition in the console after the update is not exercised; agent start and the agent's restart are.",
    "A started agent takes one edit on the console page (its description) and, after it, a Slack and a Telegram door switched on and applied by Connect, before the update. Apply after a model change on a started agent is covered by keeper tests, not by an image run.",
    "The conversation the edit ends is a plain one with one message; that an approval waiting in such a conversation cannot be answered afterwards is covered by the agent's tests, not here.",
    "The change of budget month is not covered: this run does not move the clock.",
    "One person only: a second member, and a real spending-limit refusal, are not covered.",
    "A real agent answer is not covered: the stand-in decides what the model says.",
    "A reboot is simulated by stopping Docker, deleting the keeper's folders under /run and starting Docker again; the kernel, the firewall tables and systemd units are not restarted, and the agent is only asked for its health answer.",
    "Slack and Telegram are stand-ins at their real names: the probe signs the Slack event with the signing secret it pasted and sends the Telegram update with the secret the stand-in was given; a platform's retries, timing and payload variety are not covered.",
    "A door's claim is applied by pressing Apply on the agent's page after the claim was sent, not by the page's own watch-and-apply.",
    "One member connects both doors, so who pays when a second member connects a door is not covered.",
    "Web chat's approval cards are all answered before any door is claimed; how web-chat approvals behave once a door is claimed is not exercised.",
    "A scheduled brief sent into Slack or Telegram is not exercised here; that path is covered by unit tests only.",
    "Only a direct message is sent on Slack; a turn started by mentioning the agent in a room is not exercised.",
    "No refused door turn is exercised (another person, a Telegram group, a refusal by Keeper); the sentence a person then sees is covered by unit tests only.",
    "Each door's Connect and Apply restart the agent, which changes the runner's network while the page waits; the probe then tries the step again once the keeper has finished what the dropped attempt started, and the retry presses nothing that is already running or done (the attempts used are recorded under browserAttempts), so a single uninterrupted press is not shown here.",
    "The keeper writes no log line for a door turn's door.open, step claim or step consume; the proof reads the budget rows, the keeper's audit of each Apply and the agent's own log instead.",
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


def apt_get(*arguments: str) -> None:
    """apt-get on the runner: quiet when it works, never silent when it does not.

    The runner's package mirrors fail now and then. apt retries each download itself. Whatever apt
    wrote to stderr is shown even when it exits 0, because a mirror warning during `update` is the
    usual reason an `install` then cannot find a package.
    """
    result = run("apt-get", "-o", "Acquire::Retries=3", *arguments, timeout=300, check=False, show=False)
    if result.returncode != 0 or result.stderr.strip():
        print(f"+ apt-get {' '.join(arguments)} (exit {result.returncode})", flush=True)
        for text in (result.stdout, result.stderr):
            if text.strip():
                print(text.rstrip()[-3000:], flush=True)
    if result.returncode != 0:
        last = (result.stderr.strip() or result.stdout.strip() or "no output").splitlines()[-1][:300]
        raise RuntimeError(f"apt-get {' '.join(arguments)} exited {result.returncode}: {last}")


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


def gateway_replaced_files() -> list[str]:
    """Files mounted into the running gateway that were replaced on the host after it started: the
    kernel marks such a mount's root "//deleted", and the gateway still reads the old file."""
    ids = output("docker", "ps", "-q", "--filter", "label=com.docker.compose.service=lares-gateway").split()
    if not ids:
        raise RuntimeError("no gateway container is running")
    pid = output("docker", "inspect", "--format", "{{.State.Pid}}", ids[0]).strip()
    fields = [line.split(" ") for line in pathlib.Path(f"/proc/{pid}/mountinfo").read_text().splitlines()]
    return sorted(f[4] for f in fields if len(f) > 4 and f[3].endswith("//deleted"))


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
    return [line for line in (logs.stdout + logs.stderr).splitlines() if " is held: " in line or " is no longer held" in line
            or "the spending-key store was busy" in line or "the spending ledger was busy" in line]


def keeper_log_lines(*phrases: str) -> list[str]:
    """Lines of the keeper's log that contain any of these fixed phrases, each line once, in log order."""
    ids = output("docker", "ps", "-q", "--filter", "label=com.docker.compose.service=lares-keeper").split()
    if not ids:
        return ["the keeper is not running"]
    logs = run("docker", "logs", ids[0], check=False, show=False)
    return [line.strip()[:300] for line in (logs.stdout + logs.stderr).splitlines() if any(phrase in line for phrase in phrases)]


# A failed Apply as the keeper logs it: the caller's sentence ("Apply failed"), the action's own failure line
# ("keeper: definition.reconcile failed (<state>) for agent ...; cause: ..."), and a budget check that found the
# spending-key store or the spending ledger busy.
APPLY_FAILURE_PHRASES = ("Apply failed", "definition.reconcile failed", "the spending-key store was busy", "the spending ledger was busy")


def agent_started_at() -> str | None:
    """When the proof agent's running container was started; None when it is not running."""
    ids = output("docker", "ps", "-q", "--filter", f"label=com.docker.compose.service=lares-{AGENT}").split()
    return output("docker", "inspect", "--format", "{{.State.StartedAt}}", ids[0]) if ids else None


def conversation_calls(release: dict, saved_at: str | None = None) -> list[dict]:
    """Every call booked to a conversation: its conversation, state, payer, and whether it was made after
    `saved_at`, a time the database gave (the keeper's audit row of one save). A conversation the save ended
    takes no call after it: the budget check refuses before any attempt is recorded. Never compared with
    `agent_definitions.valid_at`: the running agent moves that on at every fresh definition read."""
    after = f"a.created_at >= '{saved_at}'::timestamptz" if saved_at else "false"
    rows = read_only_query(
        "SELECT coalesce(json_agg(json_build_object('session', a.authority_reference#>>'{binding,sessionId}', 'state', a.state, "
        f"'payer', coalesce(a.live_member_id, ''), 'afterSave', {after}) ORDER BY a.created_at, a.id), '[]') "
        "FROM budget_attempts a WHERE a.authority_reference->>'kind' = 'human'", release)
    return json.loads(rows or "[]")


def keeper_audit_mark(release: dict) -> str:
    """The newest row of the keeper's audit log now, so a later read finds only the rows written after it."""
    return read_only_query("SELECT coalesce(max(id), 0) FROM keeper_audit", release) or "0"


def this_save_started_at(release: dict, mark: str) -> tuple[str | None, int]:
    """When the keeper began the one definition save made after `mark` for the proof agent, as the database
    recorded it (`keeper_audit.at`, written once when the action starts), and how many such saves there were.
    The save must be the one whose recorded hash is the definition's hash now."""
    rows = read_only_query(
        "SELECT k.at::text, k.detail = '{\"hash\":\"' || d.hash || '\"}' FROM keeper_audit k JOIN agent_definitions d ON d.name = k.input->>'name' "
        f"WHERE k.id > {int(mark)} AND k.action = 'definition.save' AND k.outcome = 'ok' AND k.input->>'name' = '{AGENT}' ORDER BY k.id", release)
    saves = [line.split("|") for line in rows.splitlines() if line]
    current = [at for at, matches in saves if matches == "t"]
    return (current[0] if len(saves) == 1 and len(current) == 1 else None), len(saves)


def agent_permission_denied_lines() -> list[str]:
    """Lines of the proof agent's container log where the database refused it something. A chat can
    still answer while its job queue is refused a call, so the answer alone does not show it."""
    ids = output("docker", "ps", "-a", "-q", "--filter", f"label=com.docker.compose.service=lares-{AGENT}").split()
    if not ids:
        return ["the proof agent has no container"]
    logs = run("docker", "logs", ids[0], check=False, show=False)
    return [redact(line.strip())[:300] for line in (logs.stdout + logs.stderr).splitlines() if "permission denied" in line]


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
        "doorPrompt": DOOR_PROMPT, "doorReply": DOOR_REPLY,
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


def browser(step: str, settings_file: pathlib.Path, tls: dict[str, pathlib.Path], attempts: int = 3, before_retry=None) -> None:
    """Tries again only when the browser itself reports that interface change, never on a page's answer,
    and at most `attempts` times. A step that restarts the agent (a door's Connect or Apply) changes the
    runner's interfaces while its request is in flight, so it gets more attempts, and `before_retry` runs
    before each retry: there it waits until the keeper has finished what the dropped attempt started, so
    the retry finds the result and never starts the same Connect or Apply a second time.
    Every step's attempts are recorded in the proof file, so a pass on the last one is visible."""
    tries: list[str] = []
    proof.setdefault("browserAttempts", {})[step] = tries
    for attempt in range(attempts):
        if attempt and before_retry:
            before_retry()
        wait_for_quiet_network()
        result = run("node", str(HERE / "browser.mjs"), step, str(settings_file), timeout=420, cwd=str(HERE),
                     env={"NODE_EXTRA_CA_CERTS": str(tls["ca_cert"])}, check=False)
        if result.returncode == 0:
            tries.append("passed")
            passed(f"browser:{step}")
            return
        network_changed = "ERR_NETWORK_CHANGED" in result.stdout
        tries.append("failed: the network changed" if network_changed else "failed")
        save_proof()
        if not network_changed:
            break
    raise RuntimeError(f"the browser step {step} failed ({len(tries)} attempt(s): {tries})")


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


def check_charges_after_answered_cards(release: dict, deferred: list[str]) -> None:
    """Who paid for each call of the chat, and as what. Every call of the conversation is booked to
    the one signed-in member; the call after each approved card is booked as the answer to that card
    (`resume`, option `approve`), and those cards are exactly the ones approved in the conversation.
    Read with the financial login, which can read the budget tables and approval_asks. A fault is
    reported at the end, like the other checks of the chat, so it does not hide the stages after it."""
    members = [line for line in read_only_query("SELECT coalesce(live_member_id, '') FROM budget_accounts WHERE kind = 'member' ORDER BY id", release).splitlines()]
    if len(members) != 1 or not members[0]:
        deferred.append(f"who paid was not checked: expected one member budget account with a live member, found {len(members)}: {['set' if m else 'empty' for m in members]}")
        return
    member = members[0]
    rows = json.loads(read_only_query(
        "SELECT coalesce(json_agg(json_build_object('state', a.state, 'liveMember', a.live_member_id, 'accountKind', m.kind, "
        "'accountMember', m.live_member_id, 'hasReference', a.authority_reference IS NOT NULL, 'kind', a.authority_reference->>'kind', "
        "'bindingMember', a.authority_reference#>>'{binding,memberId}', 'session', a.authority_reference#>>'{binding,sessionId}', "
        "'requestId', a.authority_reference#>>'{resume,requestId}', 'option', a.authority_reference#>>'{resume,optionId}') "
        "ORDER BY a.created_at, a.id), '[]') FROM budget_attempts a JOIN budget_accounts m ON m.id = a.member_account_id", release))
    chat = [row for row in rows if row["kind"] in ("human", "resume")]
    owner_jobs = [row for row in rows if row["kind"] == "owner-job"]
    sessions = sorted({row["session"] for row in chat if row["session"]})
    cards = json.loads(read_only_query(
        "SELECT coalesce(json_agg(json_build_object('requestId', request_id, 'tool', tool, 'outcome', outcome, 'askedBy', acting_member_id, "
        "'answeredBy', resolved_by_member_id) ORDER BY asked_at), '[]') FROM approval_asks "
        f"WHERE agent = '{AGENT}' AND session_id IN (SELECT authority_reference#>>'{{binding,sessionId}}' FROM budget_attempts "
        "WHERE authority_reference->>'kind' IN ('human', 'resume'))", release))
    approved = sorted({card["requestId"] for card in cards if card["outcome"] == "approved"})
    resume_approved = sorted({row["requestId"] for row in chat if row["kind"] == "resume" and row["option"] == "approve" and row["state"] == "settled"})

    def who(value: str | None) -> str | None:
        return None if value is None else "the signed-in member" if value == member else "another member"

    proof["charges"] = {
        "attempts": [{"state": row["state"], "kind": row["kind"] if row["hasReference"] else None, "option": row["option"],
                      "requestId": row["requestId"], "session": sessions.index(row["session"]) + 1 if row["session"] in sessions else None,
                      "chargedTo": who(row["liveMember"]), "account": f"{row['accountKind']}: {who(row['accountMember'])}",
                      "bookedFor": who(row["bindingMember"])} for row in rows],
        "chatAttempts": len(chat), "ownerJobAttempts": len(owner_jobs), "sessions": len(sessions),
        "approvedCards": [{"requestId": card["requestId"], "tool": card["tool"], "askedBy": who(card["askedBy"]), "answeredBy": who(card["answeredBy"])}
                          for card in cards if card["outcome"] == "approved"],
        "otherCards": [{"requestId": card["requestId"], "tool": card["tool"], "outcome": card["outcome"]} for card in cards if card["outcome"] != "approved"],
        "resumeApproveRequestIds": len(resume_approved),
    }
    save_proof()
    print(f"budget attempts, who paid and as what:\n{json.dumps(proof['charges'], indent=2)}", flush=True)
    faults = []
    unbooked = [row for row in rows if row["kind"] not in ("human", "resume", "owner-job")]
    if unbooked:
        faults.append(f"{len(unbooked)} attempt(s) carry no conversation or owner-job reference (kinds {sorted({str(row['kind']) for row in unbooked})})")
    if not chat:
        faults.append("no attempt is booked to the conversation")
    strangers = [row for row in chat if not (row["liveMember"] == member and row["accountKind"] == "member" and row["accountMember"] == member and row["bindingMember"] == member)]
    if strangers:
        faults.append(f"{len(strangers)} chat attempt(s) are not charged to and booked for the signed-in member")
    if any(row["kind"] == "resume" and row["option"] != "approve" for row in chat):
        faults.append("a chat attempt is booked as the answer Deny (or no option), but every card was approved")
    if len(resume_approved) < 2:
        faults.append(f"settled calls are booked as the Approve answer of {len(resume_approved)} different card(s); two cards were approved")
    if resume_approved != approved:
        faults.append(f"the cards the calls were booked under ({resume_approved}) are not the cards approved in the conversation ({approved})")
    if faults:
        deferred.append("the calls of the chat were not charged as expected: " + "; ".join(faults))
    else:
        passed("the-call-after-each-answered-card-was-charged-to-the-asker-as-that-answer")


# --- a message on a chat door -------------------------------------------------------------------

def write_private(path: pathlib.Path, text: str | bytes) -> None:
    """Readable by this root process only, from the moment it exists."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(text.encode() if isinstance(text, str) else text)
    os.chmod(path, 0o600)


def send_door_message(kind: str, text: str, work: pathlib.Path, fixture: pathlib.Path, door_values: dict) -> int:
    """POSTs one message to the door's public address the way the platform does, and returns the final
    HTTP status. Only a 404 (changes still pending) or a 502 (the agent restarting) is sent again, with
    a fresh id and timestamp, for up to two minutes; nothing is sent again after a 2xx. Nothing about the
    request is printed: it carries the Slack signature or the Telegram secret."""
    url = f"https://{DOMAIN}/api/doors/{AGENT}/{kind}/events"
    body_file, header_file = work / f"door-{kind}-body.json", work / f"door-{kind}-headers"
    deadline = time.monotonic() + 120
    while True:
        if kind == "slack":
            event = {"type": "event_callback", "team_id": "T0PROOF", "api_app_id": "A0PROOF", "event_id": f"Ev0PROOF{uuid.uuid4().hex[:12].upper()}",
                     "event": {"type": "message", "channel": DOOR_CHAT["slack"], "channel_type": "im", "user": DOOR_PERSON["slack"], "text": text,
                               "ts": f"{time.time():.6f}"}}
            raw = json.dumps(event).encode()
            stamp = str(int(time.time()))
            signature = hmac.new(door_values["slackSigningSecret"].encode(), b"v0:" + stamp.encode() + b":" + raw, hashlib.sha256).hexdigest()
            headers = f"content-type: application/json\nx-slack-request-timestamp: {stamp}\nx-slack-signature: v0={signature}\n"
        else:
            hook = json.loads((fixture / "telegram-webhook.json").read_text())
            person = int(DOOR_PERSON["telegram"])
            update = {"update_id": int.from_bytes(os.urandom(3), "big") + 100000,
                      "message": {"message_id": int.from_bytes(os.urandom(2), "big") + 1, "date": int(time.time()),
                                  "chat": {"id": person, "type": "private", "first_name": "Proof"},
                                  "from": {"id": person, "is_bot": False, "first_name": "Proof"}, "text": text}}
            raw = json.dumps(update).encode()
            headers = f"content-type: application/json\nx-telegram-bot-api-secret-token: {hook['secretToken']}\n"
        write_private(body_file, raw)
        write_private(header_file, headers)
        answer = run("curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "30", "-X", "POST", "-H", f"@{header_file}",
                     "--data-binary", f"@{body_file}", url, check=False, show=False)
        status = int(answer.stdout.strip()) if answer.stdout.strip().isdigit() else 0
        if status in (404, 502) and time.monotonic() < deadline:
            time.sleep(5)
            continue
        return status


def agent_log_evidence() -> dict:
    """The agent's own words about the gateway key file. The full path is matched: the doors' own
    secret readers throw the same words with their own paths."""
    ids = output("docker", "ps", "-q", "--filter", f"label=com.docker.compose.service=lares-{AGENT}").split()
    if not ids:
        return {"gatewayKeyLines": [], "secretFileNotReadableLines": 0, "note": "the agent is not running"}
    logs = run("docker", "logs", ids[0], check=False, show=False)
    lines = (logs.stdout + "\n" + logs.stderr).splitlines()
    return {"gatewayKeyLines": [redact(line)[:300] for line in lines if "/run/secrets/gateway-key" in line][:5],
            "secretFileNotReadableLines": sum(1 for line in lines if "secret file not readable" in line)}


def agent_container() -> dict | None:
    """The proof agent's running container: its id and when it started. None when none runs."""
    ids = output("docker", "ps", "-q", "--filter", f"label=com.docker.compose.service=lares-{AGENT}").split()
    if not ids:
        return None
    found = output("docker", "inspect", "--format", "{{.Id}} {{.State.StartedAt}}", ids[0]).split()
    return {"id": found[0][:12], "startedAt": found[1]} if len(found) == 2 else None


def keeper_busy(release: dict, mark: str) -> list[str]:
    """Keeper actions on the proof agent begun after `mark` that have not finished. Each action's audit row is
    written as `pending` before it runs, so an Apply still waiting for the keeper's lock is counted too."""
    return read_only_query(f"SELECT action FROM keeper_audit WHERE id > {int(mark)} AND outcome = 'pending' AND input->>'name' = '{AGENT}' ORDER BY id",
                           release).splitlines()


def wait_for_keeper_idle(release: dict, mark: str) -> None:
    """Before a door step is tried again: what the dropped attempt started has finished in the keeper,
    and the agent answers (or waits for an Apply that never came). Bounded: the retry decides then."""
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        pending = read_only_query(f"SELECT coalesce(pending::text, '') FROM agent_resources WHERE name = '{AGENT}'", release)
        if not keeper_busy(release, mark) and (pending == "true" or agent_answers()):
            return
        time.sleep(3)


def door_applies(release: dict, mark: str) -> list[dict]:
    """Every Apply (`definition.reconcile`) of the proof agent after `mark`, with the keeper's own times."""
    rows = read_only_query(
        "SELECT coalesce(json_agg(json_build_object('at', at, 'completedAt', completed_at, 'outcome', outcome) ORDER BY id), '[]') "
        f"FROM keeper_audit WHERE id > {int(mark)} AND action = 'definition.reconcile' AND input->>'name' = '{AGENT}'", release)
    return json.loads(rows or "[]")


def agent_log_tail(lines: int = 150) -> dict:
    """What survives the container: the running agent container's id, start time and its last log lines
    (each through `redact` and cut), plus every line about Keeper's `door.open`, if the agent wrote one."""
    container = agent_container()
    if not container:
        return {"container": None, "tail": [], "doorOpenLines": []}
    logs = run("docker", "logs", container["id"], check=False, show=False)
    every = [redact(line)[:300] for line in (logs.stdout + "\n" + logs.stderr).splitlines() if line.strip()]
    return {"container": container, "tail": every[-lines:], "doorOpenLines": [line for line in every if "door.open" in line][:20]}


def settled_agent(kind: str, record: dict, release: dict, mark: str) -> dict:
    """Waits until the agent is settled before the door's message: the same container (id and start
    time) twice about 10 seconds apart, answering, nothing waiting, its applied definition the saved one,
    and no keeper action on it still running. A hard check: a message into a restarting agent proves nothing."""
    query = ("SELECT json_build_object('pending', r.pending, 'appliedIsSaved', r.applied_definition = d.definition) "
             f"FROM agent_resources r JOIN agent_definitions d ON d.name = r.name WHERE r.name = '{AGENT}'")
    deadline = time.monotonic() + 240
    seen: dict = {}
    while True:
        first = agent_container()
        if first and agent_answers():
            time.sleep(10)
            state = json.loads(read_only_query(query, release) or "null") or {}
            busy = keeper_busy(release, mark)
            second = agent_container()
            seen = {"first": first, "second": second, "answers": agent_answers(), "pending": state.get("pending"),
                    "appliedIsSaved": state.get("appliedIsSaved"), "keeperBusy": busy}
            if first == second and seen["answers"] and state.get("pending") is False and state.get("appliedIsSaved") is True and not busy:
                record["settledBeforeMessage"] = {**seen, **agent_log_tail()}
                save_proof()
                return first
        if time.monotonic() > deadline:
            record["settledBeforeMessage"] = {**seen, **agent_log_tail()}
            record["checks"][f"{kind}-agent-settled-before-the-message"] = False
            proof["checks"][f"{kind}-agent-settled-before-the-message"] = False
            save_proof()
            raise RuntimeError(f"{kind}-agent-settled-before-the-message failed: the agent did not settle within 4 minutes: {seen}")
        time.sleep(3)


# The keeper's own reason when a save of a door, role, personal account or model stops a started agent
# until Apply restarts it (Lares ADR-0027). That stop is the design; any other reason is not.
DESIGNED_STOP = "takes effect when Apply restarts it"


def check_door_enable_applied(kind: str, record: dict, stops_before: int, apply_failures_before: int, audit_mark: str, release: dict) -> None:
    """Connect on a started agent saves the door switched on and applies it, which restarts the agent. A hard
    check: afterwards the agent runs and answers, the applied definition has the door on, nothing is waiting,
    and neither the keeper's log nor its audit shows a refused or failed save or Apply, or a stop for any
    reason but the designed one. Before the change "a started agent takes an edit" this save stopped the
    agent and Apply put the door back off."""
    deadline = time.monotonic() + 90
    while not agent_answers() and time.monotonic() < deadline:
        time.sleep(3)
    answers = agent_answers()
    state = json.loads(read_only_query(
        "SELECT json_build_object('pending', r.pending, 'doorOn', EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(r.applied_definition->'doors', '[]'::jsonb)) d "
        f"WHERE d->>'kind' = '{kind}' AND (d->>'enabled')::boolean)) FROM agent_resources r WHERE r.name = '{AGENT}'", release) or "null") or {}
    stops = keeper_log_lines("was stopped after a save")[stops_before:]
    apply_failures = keeper_log_lines(*APPLY_FAILURE_PHRASES)[apply_failures_before:]
    audits = [line.split("|") for line in read_only_query(
        f"SELECT action, outcome FROM keeper_audit WHERE id > {int(audit_mark)} AND input->>'name' = '{AGENT}' "
        "AND action IN ('definition.save', 'definition.reconcile') ORDER BY id", release).splitlines() if line]
    record["enableAfterStart"] = {"agentAnswers": answers, "pending": state.get("pending"), "doorOnInAppliedDefinition": state.get("doorOn"),
                                  "keeperStopsAfterASave": [redact(line) for line in stops], "keeperApplyFailedLines": [redact(line) for line in apply_failures],
                                  "savesAndApplies": [{"action": action, "outcome": outcome} for action, outcome in audits]}
    save_proof()
    problems = []
    if not answers:
        problems.append("the agent is not running and answering")
    if state.get("doorOn") is not True:
        problems.append("the door is not on in the applied definition")
    if state.get("pending") is not False:
        problems.append("the agent still has changes waiting to be applied")
    if [line for line in stops if DESIGNED_STOP not in line]:
        problems.append(f"the keeper stopped the agent after a save for another reason than the door change: {[line for line in stops if DESIGNED_STOP not in line][0]}")
    if apply_failures:
        problems.append(f"the keeper logged a failed Apply or a busy budget check: {apply_failures[0]}")
    if not any(action == "definition.save" and outcome == "ok" for action, outcome in audits) or \
            not any(action == "definition.reconcile" and outcome == "ok" for action, outcome in audits):
        problems.append(f"the keeper's audit does not show the save and the Apply both done: {audits}")
    if any(outcome != "ok" for _, outcome in audits):
        problems.append(f"the keeper's audit shows a save or Apply that did not finish ok: {audits}")
    if problems:
        record["checks"]["door-enable-after-start-applied"] = False
        proof["checks"]["door-enable-after-start-applied"] = False
        save_proof()
        raise RuntimeError(f"door-enable-after-start-applied failed for {kind}: " + "; ".join(problems))
    record["checks"]["door-enable-after-start-applied"] = True
    passed("door-enable-after-start-applied")


def door_turn(kind: str, work: pathlib.Path, fixture: pathlib.Path, settings_file: pathlib.Path, tls: dict[str, pathlib.Path],
              door_values: dict, door_codes: pathlib.Path, release: dict, deferred: list[str]) -> None:
    """Connects the door on the started agent's page (which saves it switched on and applies it), claims it
    as the owner, applies the claim, then sends one ordinary message and reads what happened: did it reach
    the model through the keeper, who was charged and as what, and was the answer posted back into the
    chat. The door's setup is a hard check; the three about the message are reported at the end, like
    the chat's."""
    chat, person = DOOR_CHAT[kind], DOOR_PERSON[kind]
    # A post into the chat; Telegram's typing indicator is not one.
    reply_methods = ((lambda method: method.startswith("chat.")) if kind == "slack"
                     else (lambda method: method.startswith(("send", "edit")) and method != "sendChatAction"))
    record: dict = {"checks": {}}
    proof.setdefault("doorTurns", {})[kind] = record

    def door_calls(since: int) -> list[dict]:
        return [call for call in fake_calls(fixture)[since:] if call["kind"] == kind]

    def failed(check: str, why: str) -> None:
        record["checks"][check] = False
        proof["checks"][check] = False
        save_proof()
        print(f"FAIL (reported at the end): {check}: {why}", flush=True)
        deferred.append(f"{check}: {why}")

    # The owner connects the door on the started agent, and sends the one-time step from the platform.
    calls_at_connect = len(fake_calls(fixture))
    stops_before = len(keeper_log_lines("was stopped after a save"))
    apply_failures_before = len(keeper_log_lines(*APPLY_FAILURE_PHRASES))
    audit_mark = keeper_audit_mark(release)
    browser(f"connect-{kind}", settings_file, tls, attempts=DOOR_STEP_ATTEMPTS, before_retry=lambda: wait_for_keeper_idle(release, audit_mark))
    check_door_enable_applied(kind, record, stops_before, apply_failures_before, audit_mark, release)
    code = (door_codes / kind).read_text().strip()
    if kind == "slack":
        if not re.fullmatch(r"claim [A-Z0-9]{24}", code):
            raise RuntimeError(f"the Slack door page showed no one-time code in the expected form ({len(code)} characters)")
        claim = code
    else:
        if not re.fullmatch(r"[A-Z0-9]{24}", code):
            raise RuntimeError(f"the Telegram door page showed no tap-to-connect code in the expected form ({len(code)} characters)")
        hook_url = json.loads((fixture / "telegram-webhook.json").read_text()).get("url") if (fixture / "telegram-webhook.json").exists() else None
        if hook_url != f"https://{DOMAIN}/api/doors/{AGENT}/telegram/events":
            raise RuntimeError(f"the keeper registered the Telegram webhook at {hook_url!r}, not at the door's public address")
        claim = f"/start {code}"
    record["claimStatus"] = send_door_message(kind, claim, work, fixture, door_values)
    save_proof()
    principal = ""
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        principal = read_only_query(f"SELECT coalesce(principal, '') FROM agent_door_connections WHERE agent = '{AGENT}' AND kind = '{kind}'", release)
        if principal:
            break
        time.sleep(3)
    if not principal:
        record["standInCallsSinceConnect"] = [{"method": call["method"], "chat": call.get("channel", call.get("chat")), "text": call.get("text", "")[:300]}
                                             for call in door_calls(calls_at_connect)]
        record["agentLog"] = agent_log_evidence()
        save_proof()
        raise RuntimeError(f"the {kind} claim was not recorded within 60 seconds (the door answered HTTP {record['claimStatus']})")
    finish_mark = keeper_audit_mark(release)
    browser(f"finish-{kind}", settings_file, tls, attempts=DOOR_STEP_ATTEMPTS, before_retry=lambda: wait_for_keeper_idle(release, audit_mark))

    # The claim's Apply has finished and the agent it started is the one that will take the message.
    container = settled_agent(kind, record, release, audit_mark)
    applies = door_applies(release, finish_mark)
    record["claimApplies"] = applies
    save_proof()
    if len(applies) != 1 or applies[0]["outcome"] != "ok":
        record["checks"][f"{kind}-apply-pressed-once"] = False
        proof["checks"][f"{kind}-apply-pressed-once"] = False
        save_proof()
        raise RuntimeError(f"{kind}-apply-pressed-once failed: the keeper ran {len(applies)} Apply(s) for this claim: {applies}")
    record["checks"][f"{kind}-apply-pressed-once"] = True
    passed(f"{kind}-apply-pressed-once")

    # The door is claimed by the owner and applied, and the claim was answered in the chat.
    row = json.loads(read_only_query(
        "SELECT json_build_object('principal', c.principal, 'applied', coalesce(c.revision = c.applied_revision, false), 'owner', c.owner_email, "
        "'pending', r.pending) FROM agent_door_connections c JOIN agent_resources r ON r.name = c.agent "
        f"WHERE c.agent = '{AGENT}' AND c.kind = '{kind}'", release) or "null")
    claim_replies = [call for call in door_calls(calls_at_connect)
                     if call.get("channel", call.get("chat")) == chat and str(call.get("text", "")).startswith(CLAIM_REPLY)]
    members = read_only_query("SELECT coalesce(live_member_id, '') FROM budget_accounts WHERE kind = 'member' ORDER BY id", release).splitlines()
    owners = json.loads(read_only_query(f"SELECT coalesce(json_agg(id), '[]') FROM users WHERE lower(primary_email) = lower('{OWNER_EMAIL}')", release))
    problems = []
    if not row or row["principal"] != person:
        problems.append(f"the door's owner is {row and row['principal']!r}, not {person!r}")
    if not row or not row["applied"]:
        problems.append("the claim's revision is not the applied one")
    if not row or row["owner"] != OWNER_EMAIL:
        problems.append("the claim is not held by the signed-in owner's address")
    if not row or row["pending"] is not False:
        problems.append("the agent still has changes waiting to be applied")
    if not claim_replies:
        problems.append(f"the stand-in recorded no claim reply into {chat}")
    if len(owners) != 1 or len(members) != 1 or not members[0] or owners[0] != members[0]:
        problems.append(f"the claimer is not exactly one member: {len(owners)} user(s) with the owner's address, {len(members)} member budget account(s), same member {owners[:1] == members[:1]}")
    if problems:
        record["claimProblems"] = problems
        save_proof()
        raise RuntimeError(f"{kind}-door-claimed-and-applied failed: " + "; ".join(problems))
    claimer = members[0]
    record["checks"][f"{kind}-door-claimed-and-applied"] = True
    passed(f"{kind}-door-claimed-and-applied")

    # One ordinary message, and what came of it.
    t0 = read_only_query("SELECT now()", release)
    calls_before = len(fake_calls(fixture))
    marker = f"{DOOR_PROMPT} {kind}"
    record["eventStatus"] = send_door_message(kind, f"{marker}: please answer", work, fixture, door_values)
    save_proof()
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if any(reply_methods(call["method"]) and call.get("channel", call.get("chat")) == chat for call in door_calls(calls_before)):
            break
        time.sleep(3)
    time.sleep(10)

    def attempts() -> list[dict]:
        return json.loads(read_only_query(
            "SELECT coalesce(json_agg(json_build_object('state', a.state, 'kind', a.authority_reference->>'kind', 'door', a.authority_reference#>>'{binding,door}', "
            "'liveMember', a.live_member_id, "
            "'keys', (SELECT coalesce(json_agg(k.key ORDER BY k.key), '[]') FROM jsonb_object_keys(CASE WHEN jsonb_typeof(a.authority_reference) = 'object' "
            "THEN a.authority_reference ELSE '{}'::jsonb END) AS k(key))) ORDER BY a.created_at, a.id), '[]') "
            f"FROM budget_attempts a WHERE a.created_at >= '{t0}'::timestamptz", release))

    def turn_rows(rows: list[dict]) -> list[dict]:
        # Schedules start once a door is claimed and may add owner-job rows; those never count.
        return [row for row in rows if row["kind"] != "owner-job"]

    def marked_model_calls() -> list[dict]:
        return [call for call in fake_calls(fixture)[calls_before:]
                if call["kind"] == "model" and (marker in (call.get("lastText") or "") or call.get("doorTurn") == marker)]

    rows = attempts()
    deadline = time.monotonic() + 60
    while True:
        # Charged as a door turn of THIS door, to the claimer.
        charged = bool(turn_rows(rows)) and all(row["state"] == "settled" and row["kind"] == "door" and row["door"] == kind and row["liveMember"] == claimer
                                                for row in turn_rows(rows))
        if charged or time.monotonic() > deadline:
            break
        time.sleep(3)
        rows = attempts()
    # Read after the settle wait: a scheduled post into the same chat can end the reply wait above
    # before the door turn's own model call has been made.
    model_calls = marked_model_calls()
    reached = bool(model_calls) and bool(turn_rows(rows))
    posts = [call for call in door_calls(calls_before) if reply_methods(call["method"]) and call.get("channel", call.get("chat")) == chat]
    replies = [call for call in posts if DOOR_REPLY in str(call.get("text", ""))]
    error_posts = [call for call in posts if any(words in str(call.get("text", "")) for words in ERROR_COPY)]

    def who(value: str | None) -> str | None:
        return None if value is None else "the claimer" if value == claimer else "another member"

    # Evidence that outlives the container: who took the turn, what it logged, and every Apply since the claim.
    at_end = agent_log_tail()
    record.update({
        "containerAtMessage": container,
        "agentAtTheEnd": at_end,
        "sameContainerThroughTheTurn": at_end["container"] == container,
        "keeperAppliesSinceTheClaim": door_applies(release, finish_mark),
        "modelCallsWithMarker": len(model_calls),
        "budgetAttemptsSinceMessage": [{"state": row["state"], "kind": row["kind"], "door": row["door"], "chargedTo": who(row["liveMember"]), "referenceKeys": row["keys"]}
                                       for row in rows],
        "errorCopiesPosted": len(error_posts),
        "standInCallsSinceMessage": [{"method": call["method"], "chat": call.get("channel", call.get("chat")), "text": str(call.get("text", ""))[:300]}
                                     for call in door_calls(calls_before)],
        "agentLog": agent_log_evidence(),
    })
    save_proof()
    print(f"the {kind} turn, as recorded:\n{json.dumps(record, indent=2)}", flush=True)
    turn = turn_rows(rows)
    if reached:
        record["checks"][f"{kind}-turn-reached-the-model-through-keeper"] = True
        passed(f"{kind}-turn-reached-the-model-through-keeper")
    else:
        failed(f"{kind}-turn-reached-the-model-through-keeper",
               f"{len(model_calls)} model call(s) carried the marker and {len(turn)} budget attempt(s) other than owner jobs were made since the message (event HTTP {record['eventStatus']})")
    if charged:
        record["checks"][f"{kind}-turn-settled-and-charged"] = True
        passed(f"{kind}-turn-settled-and-charged")
    else:
        failed(f"{kind}-turn-settled-and-charged",
               f"the attempts since the message are not all settled as a {kind} door turn charged to the claimer: "
               f"{[(row['state'], row['kind'], row['door'], who(row['liveMember'])) for row in turn] or 'there are none'}")
    if replies:
        record["checks"][f"{kind}-reply-posted"] = True
        passed(f"{kind}-reply-posted")
    else:
        failed(f"{kind}-reply-posted", f"no reply containing {DOOR_REPLY} was posted into {chat}")
    if error_posts:
        failed(f"{kind}-no-error-copy-posted", f"{len(error_posts)} post(s) into {chat} since the message carry an error copy, first: "
               f"{redact(str(error_posts[0].get('text', '')))[:200]}")
    else:
        record["checks"][f"{kind}-no-error-copy-posted"] = True
        passed(f"{kind}-no-error-copy-posted")


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


# --- a backup from the release before, restored onto this server installed again -----------------
#
# The last stage. On the server the stages above built, the proof agent's store is rebuilt the way
# the release before this one built every store, a real nightly backup is taken, the bundle of
# settings the guide tells the owner to copy is taken out of it with the owner's age key, everything
# Lares put on this machine is removed, the release is installed again from an ordinary folder, the
# spending ledger is prepared, and `lares restore` is run three times: once failing on purpose at
# the store upgrade, once beside a leftover store step (refused), once to the end. This stage writes
# to the database by design (the old store, and a setting on the provisioner login that it removes
# again); nothing above it does.

# The release before this one, by name: its creative image still carries the workflow package that
# leaves the 20 schema steps this release upgrades from, and its keeper image the grants it gave.
# Not rc.12: whether its package left exactly those 20 steps was never checked. The newest file by
# sort order is a test build of rc.14 with the same images, so the release itself is named.
PREVIOUS_RELEASE_FILE = "2026-11-10-rc.14.json"
BACKUP_REPOSITORY = "/var/backups/lares-proof"
INSTALLED_OPS = "/opt/lares/current/services/box/ops"
PROVISIONER_FILE = "/etc/lares/secrets/workflow-provisioner-password"
BUNDLE_PATHS = ("etc/lares/installation.env", "etc/lares/console-oauth.env", "etc/lares/backup.env",
                "etc/lares/restic-password", "etc/lares/secrets", "srv/lares/secrets")
RESTORE_LIMITS = [
    "The older backup comes from this release's server with its one agent store rebuilt the way the release before built stores (that release's creative image ran its own schema step, its keeper image gave its own grants); the main database, Vault and folders in it are this release's.",
    "The new server is this machine with everything Lares put on it removed, then installed again: a second machine, and its own disk and network, are not covered.",
    "The budget rows restore puts back are compared, row for row, from the snapshot's own dump restored into a private database; on the live server, where the restarted keeper may settle a row, only that no row is lost.",
    "The first restore fails on purpose because the provisioner login is set to read-only transactions: the upgrade stops at its first change. An upgrade that dies after some of its steps relies on all of them being one transaction, which is proven by the integration test, not here.",
]
LIMITS.extend(RESTORE_LIMITS)

proof_secrets: set[str] = set()
SECRET_WORD = r"(?:password|passwd|secret|token|key)"
SECRET_VALUE = r"""(?!['"]?/)('[^']*'|"[^"]*"|[^\s'"]+)"""
REDACTED = "<redacted>"
REDACTION_PATTERNS = (
    (re.compile(r"([a-z][a-z0-9+.-]*://[^\s:/@]+):[^\s@]+@", re.IGNORECASE), r"\1:" + REDACTED + "@"),
    (re.compile(r"(\bBearer\s+)[^\s'\"]+", re.IGNORECASE), r"\1" + REDACTED),
    (re.compile(r"\beyJ[\w-]+\.[\w-]+\.[\w-]+"), REDACTED),
    (re.compile(r"SCRAM-SHA-256\$[^\s'\"]+"), "SCRAM-SHA-256$" + REDACTED),
    (re.compile(r"\bAGE-SECRET-KEY-[0-9A-Z]+"), REDACTED),
    (re.compile(r"(?<![\w-])(--?[\w-]*" + SECRET_WORD + r"(?:=|\s+))(?!-)" + SECRET_VALUE, re.IGNORECASE), r"\1" + REDACTED),
    (re.compile(r"(\b[\w.-]*" + SECRET_WORD + r"\w*\s*=\s*)" + SECRET_VALUE, re.IGNORECASE), r"\1" + REDACTED),
)
LOG_HEAD, LOG_TAIL = 1500, 4500


def remember_secrets(*values: str) -> None:
    """Every secret this stage can see, by value: what it was handed, every line of the secret folders
    and the operator file, and the values of secret-named settings. Kept across the wipe."""
    proof_secrets.update(value for value in values if value and len(value) >= 8)
    for folder in ("/etc/lares/secrets", "/etc/lares/operator", "/srv/lares/secrets"):
        for path in pathlib.Path(folder).rglob("*") if pathlib.Path(folder).is_dir() else []:
            try:
                if path.is_file() and not path.is_symlink() and path.stat().st_size <= 8192:
                    proof_secrets.update(line.strip() for line in path.read_text(errors="replace").splitlines() if len(line.strip()) >= 8)
            except OSError:
                pass
    for path in ("/etc/lares/restic-password", "/etc/lares/console-oauth.env", "/etc/lares/backup.env", "/etc/lares/installation.env"):
        try:
            lines = pathlib.Path(path).read_text(errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            name, separator, value = line.partition("=")
            value = value.strip().strip("'\"")
            if path.endswith("restic-password") and len(line.strip()) >= 8:
                proof_secrets.add(line.strip())
            elif separator and re.search(SECRET_WORD, name, re.IGNORECASE) and len(value) >= 8 and not value.startswith("/"):
                proof_secrets.add(value)


def redact(text: str) -> str:
    """Known values first, by value; then the patterns as a second net."""
    for value in sorted(proof_secrets, key=len, reverse=True):
        text = text.replace(value, REDACTED)
    for pattern, replacement in REDACTION_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def trimmed(text: str) -> str:
    if len(text) <= LOG_HEAD + LOG_TAIL:
        return text
    return text[:LOG_HEAD] + f"\n[... {len(text) - LOG_HEAD - LOG_TAIL} characters omitted ...]\n" + text[-LOG_TAIL:]


def restore_failed(substep: str, why: str, stdout: str | bytes | None = "", stderr: str | bytes | None = "") -> None:
    """Prints the failing sub-step and what it printed, redacted and trimmed, then stops the probe."""
    remember_secrets()
    as_text = lambda value: value.decode(errors="replace") if isinstance(value, bytes) else (value or "")
    print(f"\nRESTORE PROOF FAILED at sub-step '{substep}': {redact(why)}", flush=True)
    for label, text in (("output", as_text(stdout)), ("errors", as_text(stderr))):
        if text.strip():
            print(f"--- {label} (redacted, trimmed) ---\n{trimmed(redact(text.rstrip()))}", flush=True)
    raise RuntimeError(f"restore proof, {substep}: {redact(why)}"[:600])


def step(substep: str, *command: str, timeout: int = 300, stdin: str | None = None, ok: tuple[int, ...] = (0,),
         cwd: str | None = None, show: bool = False) -> subprocess.CompletedProcess:
    """One command of this stage. Output is captured, and printed (redacted, trimmed) only when show
    is set or the command fails. Never used for `docker inspect` or an environment listing."""
    print(f"+ [{substep}] {redact(' '.join(command))[:240]}", flush=True)
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, input=stdin, cwd=cwd)
    except subprocess.TimeoutExpired as error:
        restore_failed(substep, f"{command[0]} did not finish within {timeout} seconds", error.stdout, error.stderr)
    if result.returncode not in ok:
        restore_failed(substep, f"{command[0]} exited {result.returncode}", result.stdout, result.stderr)
    if show:
        said = (result.stdout + result.stderr).rstrip()
        if said:
            print(trimmed(redact(said)), flush=True)
    return result


def operator_sql(substep: str, database: str, sql: str) -> str:
    """SQL as the offline operator, through the engine's own operator_db_run (a short-lived client
    in the database image; the password is read inside it)."""
    return step(substep, "bash", "-c", '. "$1/engine-run.sh"; shift; operator_db_run -f /opt/lares/compose.yaml -- "$@"', "operator-sql",
                INSTALLED_OPS, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", "-F", "\t", "-d", database, stdin=sql).stdout.strip()


def store_step(substep: str, image: str, mode: str, store: str) -> list[str]:
    """The installed release's own store step (engine-run.sh, workflow_store_step), as install, update and restore run it."""
    return step(substep, "bash", "-c", 'HERE="$1"; . "$HERE/engine-run.sh"; workflow_store_step "$2" "$3" "$4" 127.0.0.1 5432 "$5"',
                "store-step", INSTALLED_OPS, image, mode, store, PROVISIONER_FILE, timeout=600).stdout.strip().splitlines()[-1:]


def workflow_runtime_file() -> str:
    return json.loads(pathlib.Path("/etc/lares/keeper.json").read_text())["lifecycle"]["runtime"]["workflowPasswordFile"]


def store_contents(substep: str, store: str) -> dict:
    """What the agents wrote into the store, and how many schema steps it records, read as the operator."""
    said = operator_sql(substep, store, (
        "SELECT 'step', count(*)::text FROM workflow_drizzle.workflow_migrations;"
        "SELECT 'run', id || ' ' || extract(epoch FROM created_at)::text FROM workflow.workflow_runs ORDER BY 2;"
        "SELECT 'event', id || ' ' || run_id FROM workflow.workflow_events ORDER BY 2;"))
    found: dict = {"steps": None, "runs": [], "events": []}
    for line in said.splitlines():
        kind, _, value = line.partition("\t")
        if kind == "step":
            found["steps"] = int(value)
        elif kind in ("run", "event"):
            found[kind + "s"].append(value)
    return found


def budget_rows(substep: str, database: str = "lares_state", keys: bool = False) -> dict[str, list[str]]:
    """Every row of the owner's budget tables, as a fingerprint per row, read as the operator. With
    keys, only each row's primary key (the whole row where a table has none): a row the keeper
    settles keeps its key, a lost row does not."""
    columns = ("coalesce((SELECT string_agg(format('x.%I', a.attname), ',' ORDER BY k.ord) FROM pg_index i "
               "CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord) "
               "JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum "
               "WHERE i.indrelid = c.oid AND i.indisprimary), 'x.*')") if keys else "'x.*'"
    said = operator_sql(substep, database,
        f"SELECT format('SELECT %L, md5(row(%s)::text) FROM public.%I x', c.relname, {columns}, c.relname) "
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'budget%' ORDER BY c.relname \\gexec\n")
    rows: dict[str, list[str]] = {}
    for line in said.splitlines():
        table, _, fingerprint = line.partition("\t")
        rows.setdefault(table, []).append(fingerprint)
    return {table: sorted(values) for table, values in rows.items()}


def leftover_job_containers() -> list[str]:
    said = step("leftover-containers", "docker", "ps", "--all", "--filter", "name=lares-workflow-store-", "--filter", "name=lares-restore-",
                "--format", "{{.Names}}").stdout
    return sorted(said.split())


def restore_runs_left() -> list[str]:
    root = pathlib.Path("/var/lib/lares-maintenance/restore-runs")
    return sorted(path.name for path in root.iterdir()) if root.is_dir() else []


def newest_nightly(substep: str) -> str:
    said = step(substep, "restic", "-r", BACKUP_REPOSITORY, "--password-file", "/etc/lares/restic-password",
                "snapshots", "--json", "--tag", "nightly", timeout=300).stdout
    snapshots = json.loads(said)
    if not snapshots:
        restore_failed(substep, "the repository holds no nightly snapshot")
    return max(snapshots, key=lambda snapshot: snapshot["time"])["id"]


def previous_release_store(release: dict, previous: dict, store: str, token: str) -> None:
    """The proof agent's store, built again the way the release before this one built every store:
    its creative image runs its own package's schema step (that release's installer's own command, on
    this store instead of the template it cloned stores from), its keeper image gives that release's
    grants, and the agents' login writes rows into it."""
    runtime_file = workflow_runtime_file()
    operator_sql("old-store:recreate", "postgres",
        f'DROP DATABASE IF EXISTS "{store}" WITH (FORCE);\n'
        f'CREATE DATABASE "{store}" OWNER lares_workflow_owner;\n'
        f"COMMENT ON DATABASE \"{store}\" IS 'lares-owned:{token}';\n")
    step("old-store:previous-schema-step", "docker", "run", "--rm", "--network", "host", "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL",
         "--security-opt", "no-new-privileges", "-w", "/app/services/creative",
         "-v", f"{PROVISIONER_FILE}:/run/secrets/workflow-provisioner:ro",
         "-e", "PGPASSWORD_FILE=/run/secrets/workflow-provisioner", "-e", "PGOPTIONS=-c role=lares_workflow_owner",
         "-e", f"WORKFLOW_POSTGRES_URL=postgres://lares_workflow_provisioner@127.0.0.1:5432/{store}",
         "--entrypoint", "/bin/sh", previous["images"]["creative"], "-ec",
         'PGPASSWORD="$(cat "$PGPASSWORD_FILE")"; export PGPASSWORD; exec node --input-type=module -e \''
         'import { Pool } from "pg"; import { setupDatabase } from "@workflow/world-postgres/cli"; '
         'const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 1 }); '
         'try { const r = await pool.query("SELECT current_user, session_user"); '
         'if (r.rows[0]?.current_user !== "lares_workflow_owner" || r.rows[0]?.session_user !== "lares_workflow_provisioner") throw new Error("authority check failed"); } '
         "finally { await pool.end(); } await setupDatabase();'", timeout=600)
    # That release's own grant and check functions, from its keeper image, as its template step ran them.
    grants = """
(async () => {
  const { readFileSync } = await import("node:fs");
  const pg = (await import("pg")).default;
  const lib = await import("/app/services/box/lib/workflow-database-privileges.ts");
  const login = (user, file) => new pg.Pool({ host: "127.0.0.1", port: 5432, database: process.env.STORE, user, password: readFileSync(file, "utf8").trim(), max: 1 });
  const owner = login("lares_workflow_provisioner", "/run/proof/provisioner");
  const client = await owner.connect();
  try { await client.query('SET ROLE "lares_workflow_owner"'); await lib.applyWorkflowRuntimePrivileges(client); }
  finally { try { await client.query("RESET ROLE"); } finally { client.release(); } }
  await owner.end();
  const runtime = login("lares_workflow", "/run/proof/runtime");
  try { await lib.verifyWorkflowRuntimePrivileges(runtime); } finally { await runtime.end(); }
})().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
"""
    step("old-store:previous-grants", "docker", "run", "--rm", "--network", "host", "--user", "0:0", "-w", "/app/services/box",
         "-v", f"{PROVISIONER_FILE}:/run/proof/provisioner:ro", "-v", f"{runtime_file}:/run/proof/runtime:ro", "-e", f"STORE={store}",
         "--entrypoint", "/app/services/box/node_modules/.bin/tsx", previous["images"]["lares-keeper"], "-e", grants, timeout=300)
    # Rows as the agents' login writes them: every required column filled by its type.
    seed = """
import pg from "pg";
import { readFileSync } from "node:fs";
const pool = new pg.Pool({ host: "127.0.0.1", port: 5432, database: process.env.STORE, user: "lares_workflow", password: readFileSync("/run/proof/runtime", "utf8").trim(), max: 1 });
async function seedRow(table, fixed) {
  const columns = (await pool.query(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
      CASE WHEN t.typtype = 'e' THEN t.oid::regtype::text END AS enum_type
    FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
    WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull AND NOT a.atthasdef AND a.attidentity = ''`, [`workflow.${table}`])).rows;
  const values = { ...fixed };
  for (const column of columns) {
    if (column.name in values) continue;
    if (column.enum_type) values[column.name] = (await pool.query(`SELECT (enum_range(NULL::${column.enum_type}))[1]::text AS label`)).rows[0].label;
    else if (column.type === "bytea") values[column.name] = Buffer.from([1, 2, 3]);
    else if (column.type.startsWith("timestamp")) values[column.name] = "2026-11-01T10:00:00.000Z";
    else if (column.type === "boolean") values[column.name] = false;
    else if (/int|numeric/.test(column.type)) values[column.name] = 1;
    else if (column.type.startsWith("json")) values[column.name] = "{}";
    else values[column.name] = `seed-${column.name}`;
  }
  const names = Object.keys(values);
  await pool.query(`INSERT INTO workflow.${table}(${names.map((name) => `"${name}"`).join(",")}) VALUES(${names.map((_, at) => `$${at + 1}`).join(",")})`, names.map((name) => values[name]));
}
try {
  await seedRow("workflow_runs", { id: "run_restore_proof_one" });
  await seedRow("workflow_runs", { id: "run_restore_proof_two" });
  await seedRow("workflow_events", { id: "evt_restore_proof", run_id: "run_restore_proof_one" });
} finally { await pool.end(); }
"""
    step("old-store:agent-rows", "docker", "run", "--rm", "-i", "--network", "host", "--user", "0:0", "-w", "/app/services/creative",
         "-v", f"{runtime_file}:/run/proof/runtime:ro", "-e", f"STORE={store}",
         "--entrypoint", "node", previous["images"]["creative"], "--input-type=module", "-", stdin=seed, timeout=300)
    said = store_step("old-store:this-release-sees-old", release["images"]["creative"], "check", store)
    if said != ["old"]:
        restore_failed("old-store:this-release-sees-old", f"this release's own check of the rebuilt store says {said}, not old")


def wipe_server() -> None:
    """Everything Lares put on this machine goes: what a new server does not have. The stand-ins, the
    throwaway registry and the backup repository stay; they are the outside world."""
    timers = ["lares-backup.timer", "lares-backup-verify.timer", "lares-restore-drill.timer"]
    step("wipe:timers", "systemctl", "disable", "--now", *timers, ok=(0, 1, 5))
    units = sorted(pathlib.Path("/etc/systemd/system").glob("lares-*"))
    running = [unit.name for unit in units if unit.suffix in (".service", ".timer")]
    if running:
        step("wipe:units", "systemctl", "stop", *running, ok=(0, 1, 5))
    if units:
        step("wipe:units", "rm", "-rf", *map(str, units))
    step("wipe:units", "systemctl", "daemon-reload")
    keep = {"proof-registry", "proof-fake"}
    names = step("wipe:containers", "docker", "ps", "--all", "--format", "{{.Names}}").stdout.split()
    gone = [name for name in names if name not in keep and "buildkit" not in name]
    if gone:
        step("wipe:containers", "docker", "rm", "--force", *gone, timeout=300)
    step("wipe:networks", "docker", "network", "disconnect", "--force", NETWORK, "proof-fake", ok=(0, 1))
    step("wipe:networks", "docker", "network", "prune", "--force")
    step("wipe:volumes", "docker", "volume", "prune", "--all", "--force", timeout=300)
    if shutil.which("nft"):
        step("wipe:firewall", "nft", "delete", "table", "inet", "lares_egress", ok=(0, 1))
    paths = ["/etc/lares", "/opt/lares", "/srv/lares", "/srv/taste", "/srv/vault", "/var/lib/lares", "/var/backups/pg",
             "/run/lares", "/run/lares-host", "/usr/local/bin/lares", *map(str, pathlib.Path("/var/lib").glob("lares-*"))]
    step("wipe:files", "rm", "-rf", "--one-file-system", *paths, timeout=300)
    left = [path for path in paths if os.path.lexists(path)]
    if left:
        restore_failed("wipe:files", f"still there after the wipe: {left}")


def reinstall(home: pathlib.Path, console: str) -> None:
    """The guide's step 5 on the new server: get-lares.sh with the release, reusing the copied files."""
    connector = WorldConnector(console)
    connector.start()
    install = subprocess.Popen(["bash", "get-lares.sh", "--release-file", "update-release.json", "--yes"], cwd=home,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    said: list[str] = []

    def pump_lines() -> None:
        for count, line in enumerate(install.stdout):
            if count % 25 == 0:
                remember_secrets()
            said.append(line)
            print(redact(line), end="", flush=True)
    pump = threading.Thread(target=pump_lines, daemon=True)
    pump.start()
    try:
        code = install.wait(timeout=INSTALL_TIMEOUT)
    except subprocess.TimeoutExpired:
        install.kill()
        code = -1
    connector.stopping.set()
    pump.join(timeout=5)
    if connector.error:
        restore_failed("reinstall:stand-ins", f"joining the stand-ins to the installation's network failed: {connector.error}")
    if code != 0:
        restore_failed("reinstall", f"the install on the wiped server exited {code}", "".join(said))
    if not connector.joined.wait(timeout=30):
        restore_failed("reinstall", "the install finished without the console ever running")


def lares_restore(substep: str, *arguments: str) -> tuple[int, str]:
    result = step(substep, "lares", "restore", *arguments, "--yes", "--old-server-stopped", timeout=1800, ok=(0, 64, 75, 77, 78))
    said = result.stdout + result.stderr
    print(f"--- {substep}: exit {result.returncode} (redacted, trimmed) ---\n{trimmed(redact(said.rstrip()))}", flush=True)
    return result.returncode, said


def older_backup_restores(work: pathlib.Path, home: pathlib.Path, tls: dict[str, pathlib.Path], console: str,
                          update: dict, age_key_file: pathlib.Path) -> None:
    remember_secrets(CLIENT_SECRET, pathlib.Path(home / "model-key").read_text().strip(), age_key_file.read_text())
    previous = json.loads((REPO / "releases" / PREVIOUS_RELEASE_FILE).read_text())
    project = json.loads(pathlib.Path("/etc/lares/keeper.json").read_text()).get("project") or "lares"

    stage("an older backup: the proof agent's store as the release before left it")
    stores = [line.split("\t") for line in operator_sql("old-store:find", "lares_state",
              "SELECT workflow_database, ownership_token FROM agent_resources WHERE workflow_database IS NOT NULL ORDER BY 1;").splitlines()]
    if len(stores) != 1 or not re.fullmatch(r"lares_[a-f0-9]{32}", stores[0][0]):
        restore_failed("old-store:find", f"expected exactly one agent store, found {len(stores)}")
    store, token = stores[0]
    # As update.sh does before its backup: the keeper first, so it starts nothing, then the agents.
    step("old-store:stop-keeper", "env", "-u", "COMPOSE_FILE", "docker", "compose", "--env-file", "/etc/lares/keeper.env", "stop", timeout=300)
    step("old-store:stop-agents", "docker", "compose", "--project-name", project, "--project-directory", "/srv/lares",
         "-f", "/srv/lares/compose.lares-agents.yaml", "stop", timeout=300)
    previous_release_store(update, previous, store, token)
    before = store_contents("old-store:contents", store)
    if before["steps"] != 20 or len(before["runs"]) != 2 or len(before["events"]) != 1:
        restore_failed("old-store:contents", f"the rebuilt store holds {before['steps']} steps, {len(before['runs'])} runs, {len(before['events'])} events")
    budget_before = budget_rows("old-store:budget-records")
    budget_keys_before = budget_rows("old-store:budget-records", keys=True)
    if not budget_before.get("budget_attempts"):
        restore_failed("old-store:budget-records", "the owner's budget records hold no model call")
    passed("older-store-built-by-the-previous-release-and-seen-as-old")

    stage("an older backup: a real nightly backup, and the owner's bundle out of it")
    print("+ [backup] systemctl start lares-backup.service", flush=True)
    backup = subprocess.run(["systemctl", "start", "lares-backup.service"], capture_output=True, text=True, timeout=1800)
    if backup.returncode != 0:
        journal = subprocess.run(["journalctl", "-u", "lares-backup.service", "-n", "80", "--no-pager"], capture_output=True, text=True, timeout=60)
        restore_failed("backup", f"the nightly backup service exited {backup.returncode}", journal.stdout, backup.stderr)
    snapshot = newest_nightly("backup:snapshot")
    listing = step("backup:holds-the-store", "restic", "-r", BACKUP_REPOSITORY, "--password-file", "/etc/lares/restic-password",
                   "ls", snapshot, "/var/backups/pg", timeout=300).stdout
    if f"/var/backups/pg/{store}.dump" not in listing.split():
        restore_failed("backup:holds-the-store", "the nightly snapshot has no dump of the agent store")
    sealed, bundle = work / "bundle.tar.age", work / "bundle.tar"
    with open(sealed, "wb") as out:
        dumped = subprocess.run(["restic", "-r", BACKUP_REPOSITORY, "--password-file", "/etc/lares/restic-password", "dump", snapshot,
                                 "/var/backups/pg/secrets/agent-box-secrets.tar.age"], stdout=out, stderr=subprocess.PIPE, timeout=300)
    if dumped.returncode != 0:
        restore_failed("backup:bundle", f"restic dump exited {dumped.returncode}", "", dumped.stderr)
    step("backup:bundle", "age", "-d", "-i", str(age_key_file), "-o", str(bundle), str(sealed))
    members = step("backup:bundle", "tar", "-tf", str(bundle)).stdout.split()
    missing = [path for path in BUNDLE_PATHS if not any(member.rstrip("/") == path or member.startswith(path + "/") for member in members)]
    if missing:
        restore_failed("backup:bundle", f"the settings bundle lacks {missing}")
    proof["restore"] = {"snapshot": snapshot[:8], "store": store, "previousRelease": previous["release"]}
    save_proof()
    passed("nightly-backup-holds-the-older-store-and-the-settings-bundle")

    stage("a new server: everything removed, the owner's files copied, the release installed again")
    remember_secrets()
    wipe_server()
    step("new-server:copy-the-bundle", "tar", "-C", "/", "-xf", str(bundle), *BUNDLE_PATHS)
    seed_caddy_authority(tls)
    reinstall(home, console)
    if not pathlib.Path("/opt/lares/current/services/box/engine-image").is_file():
        restore_failed("new-server:image-mode", "the installed engine has no engine-image file, so restore would not run its jobs from the images")
    installed = json.loads(pathlib.Path("/opt/lares/current/release.json").read_text())
    if installed["images"].get("creative") != update["images"]["creative"] or not re.search(r"@sha256:[a-f0-9]{64}$", installed["images"]["creative"]):
        restore_failed("new-server:release-file", "/opt/lares/current/release.json does not name this release's creative image by digest")
    step("new-server:prepare-custody", "lares", "budget", "setup", "--installation-limit", "30", "--person-limit", MEMBER_LIMIT, "--yes", timeout=600)
    if not json.loads(pathlib.Path("/etc/lares/keeper.json").read_text()).get("budgetFinancial"):
        restore_failed("new-server:prepare-custody", "budget setup finished without preparing the spending ledger")
    remember_secrets()
    passed("new-server-installed-again-with-prepared-custody")

    stage("lares restore, failing on purpose at the store upgrade")
    # Read-only transactions for the provisioner login only: the store check reads and passes, the
    # upgrade's first change is refused inside the creative image's own step. Not in any backup.
    operator_sql("first-run:read-only-provisioner", "postgres", "ALTER ROLE lares_workflow_provisioner SET default_transaction_read_only = on;")
    code, said = lares_restore("first-run", "--snapshot", "latest")
    short = snapshot[:8]
    expected = [f"the newest nightly snapshot is {short}", "draining native custody and permanently freezing prepared financial custody",
                f"restore: upgrading the agent store {store}.",
                f"This restore stopped while upgrading the agent stores from snapshot {short}, before your main database",
                "so this server still counts as a fresh install",
                f"with --snapshot {short} in place of latest"]
    if code != 75 or any(text not in said for text in expected):
        restore_failed("first-run", f"expected exit 75 and the fresh-install wording, got exit {code}; missing: {[text for text in expected if text not in said]}")
    after_failure = store_contents("first-run:store-as-the-backup-had-it", store)
    if after_failure != before:
        restore_failed("first-run:store-as-the-backup-had-it", f"the store changed: {after_failure['steps']} steps, {len(after_failure['runs'])} runs")
    if operator_sql("first-run:main-database-untouched", "lares_state", "SELECT count(*) FROM agent_definitions;") != "0":
        restore_failed("first-run:main-database-untouched", "the main database was replaced by a run that stopped at the agent stores")
    if any(pathlib.Path("/srv/lares/agents").iterdir()) or leftover_job_containers() or restore_runs_left():
        restore_failed("first-run:nothing-left", f"left behind: agents {sorted(p.name for p in pathlib.Path('/srv/lares/agents').iterdir())}, "
                       f"containers {leftover_job_containers()}, run records {restore_runs_left()}")
    passed("failed-upgrade-stops-with-the-server-still-fresh-and-the-store-as-backed-up")

    stage("lares restore beside a store step that is still running")
    leftover = "lares-workflow-store-" + os.urandom(8).hex()
    step("leftover:start", "docker", "run", "-d", "--name", leftover, "--label", "lares.maintenance=workflow-store",
         "--entrypoint", "sleep", update["images"]["db"], "600")
    try:
        code, said = lares_restore("leftover:refused", "--snapshot", short)
    finally:
        step("leftover:remove", "docker", "rm", "--force", leftover)
    if code != 78 or f"an agent store step from an earlier attempt is still running ({leftover})" not in said or "This run has changed nothing" not in said \
            or "draining native custody" in said:
        restore_failed("leftover:refused", f"expected a refusal (exit 78) naming {leftover} before anything changed, got exit {code}")
    passed("restore-refuses-beside-a-running-store-step")

    stage("lares restore again, as the message said, to the end")
    operator_sql("second-run:provisioner-as-installed", "postgres", "ALTER ROLE lares_workflow_provisioner RESET default_transaction_read_only;")
    code, said = lares_restore("second-run", "--snapshot", short)
    expected = ["draining native custody and permanently freezing prepared financial custody", f"restore: upgrading the agent store {store}.",
                f"restored snapshot {short}:", "Financial recovery is required. Protected custody remains permanently frozen"]
    if code != 0 or any(text not in said for text in expected):
        restore_failed("second-run", f"expected exit 0, got {code}; missing: {[text for text in expected if text not in said]}")
    after = store_contents("second-run:store-upgraded-with-its-rows", store)
    if after["steps"] != 31 or after["runs"] != before["runs"] or after["events"] != before["events"]:
        restore_failed("second-run:store-upgraded-with-its-rows", f"the store holds {after['steps']} steps; runs kept {after['runs'] == before['runs']}, events kept {after['events'] == before['events']}")
    passed("store-ends-on-this-release-with-its-rows")
    runtime = step("second-run:agents-login", "docker", "run", "--rm", "--network", "host", "--user", "0:0",
                   "-v", f"{workflow_runtime_file()}:/run/proof/runtime:ro", "--entrypoint", "/bin/sh", update["images"]["db"], "-ec",
                   'export PGPASSWORD="$(cat /run/proof/runtime)"; exec psql -X -At -v ON_ERROR_STOP=1 -h 127.0.0.1 -U lares_workflow -d "$1" '
                   '-c "SELECT count(*) FROM workflow.workflow_runs" -c "SELECT count(*) FROM workflow.workflow_invocations" '
                   '-c "SELECT count(*) FROM workflow_drizzle.workflow_migrations"', "agents-login", store).stdout.split()
    if runtime != ["2", "0", "31"]:
        restore_failed("second-run:agents-login", f"the agents' login read {runtime}, expected 2 runs, the new table and 31 steps")
    passed("agents-login-reads-the-upgraded-store")
    # The keeper that restore starts may settle a row, so the live database is checked by key (no row
    # lost), and the exact rows restore put back are read from the snapshot's own dump, restored into
    # a private database the keeper never opens: they must equal the old server's, row for row.
    keys_after = budget_rows("second-run:budget-records-kept", keys=True)
    lost = {table: len(set(rows) - set(keys_after.get(table, []))) for table, rows in budget_keys_before.items()
            if set(rows) - set(keys_after.get(table, []))}
    if lost:
        restore_failed("second-run:budget-records-kept", f"budget rows missing after the restore: {lost}")
    main_dump = work / "lares_state.dump"
    with open(main_dump, "wb") as out:
        dumped = subprocess.run(["restic", "-r", BACKUP_REPOSITORY, "--password-file", "/etc/lares/restic-password", "dump", snapshot,
                                 "/var/backups/pg/lares_state.dump"], stdout=out, stderr=subprocess.PIPE, timeout=300)
    if dumped.returncode != 0:
        restore_failed("second-run:budget-records-restored", f"restic dump exited {dumped.returncode}", "", dumped.stderr)
    scratch_db = "restore_proof_budget"
    operator_sql("second-run:budget-records-restored", "postgres", f'CREATE DATABASE "{scratch_db}" OWNER lares_operator;')
    try:
        step("second-run:budget-records-restored", "bash", "-c",
             '. "$1/engine-run.sh"; operator_db_run -f /opt/lares/compose.yaml -- pg_restore --exit-on-error -d "$2" < "$3"',
             "operator-restore", INSTALLED_OPS, scratch_db, str(main_dump), timeout=600)
        restored_rows = budget_rows("second-run:budget-records-restored", scratch_db)
    finally:
        operator_sql("second-run:budget-records-restored", "postgres", f'DROP DATABASE IF EXISTS "{scratch_db}" WITH (FORCE);')
    if restored_rows != budget_before:
        differ = sorted(table for table in set(budget_before) | set(restored_rows) if budget_before.get(table) != restored_rows.get(table))
        restore_failed("second-run:budget-records-restored", f"the budget rows restore put back differ from the old server's in {differ}")
    live_rows = budget_rows("second-run:budget-records-live")
    changed_live = {table: len(set(rows) - set(live_rows.get(table, []))) for table, rows in budget_before.items()}
    proof.setdefault("restore", {})["budgetRowsChangedSinceKeeperStart"] = {table: n for table, n in changed_live.items() if n}
    passed("owner-budget-records-whole-after-the-restore")
    if not (pathlib.Path("/srv/lares/agents") / AGENT).is_dir() or leftover_job_containers() or restore_runs_left():
        restore_failed("second-run:nothing-left", f"agent folder restored {(pathlib.Path('/srv/lares/agents') / AGENT).is_dir()}, "
                       f"containers {leftover_job_containers()}, run records {restore_runs_left()}")
    proof["restore"].update({"stepsBefore": before["steps"], "stepsAfter": after["steps"], "agentRows": len(after["runs"]) + len(after["events"]),
                             "budgetTables": {table: len(rows) for table, rows in budget_before.items()}})
    save_proof()
    passed("older-backup-restored-onto-a-reinstalled-server-in-image-mode")


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
        # The keeper checks a door's bot with Slack or Telegram itself, and the agent reaches them
        # through the egress proxy with TLS ending in the agent: both trust the stand-ins' authority.
        keeper_trusting, chief_trusting = "proof/keeper-trusting:local", "proof/chief-trusting:local"
        trusting_image(work, keeper, keeper_trusting, tls, node=True)
        trusting_image(work, chief, chief_trusting, tls, node=True)
        # Pulled from the real registry before the hosts file points that name at the throwaway one.
        trusting_image(work, newest["images"]["lares-gateway"], gateway_trusting, tls, node=False)
        # The release before this one, for the last stage's older store: also pulled while the
        # registry's name still points at the real one.
        # A failed pull stops only that stage, which then counts as not proven.
        previous = json.loads((REPO / "releases" / PREVIOUS_RELEASE_FILE).read_text())
        previous_pull_failure: str | None = None
        for key in ("creative", "lares-keeper"):
            try:
                pulled = run("docker", "pull", "-q", previous["images"][key], timeout=900, check=False)
                failed_with = None if pulled.returncode == 0 else f"docker pull exited {pulled.returncode}"
            except subprocess.TimeoutExpired:
                failed_with = "docker pull did not finish within 900 seconds"
            if failed_with:
                previous_pull_failure = f"could not fetch the older release's images ({PREVIOUS_RELEASE_FILE}, {key}: {failed_with})"
                print(previous_pull_failure, flush=True)
                break
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
            "lares-keeper": (keeper_trusting, "heiberg-industries/lares-engine-keeper"),
            "lares-egress-proxy": (egress, "heiberg-industries/lares-engine-egress-proxy"),
            "lares-firewall-helper": (firewall, "heiberg-industries/lares-engine-firewall-helper"),
            "console": (console_trusting, "heiberg-industries/lares-engine-console"),
            "chief-of-staff": (chief_trusting, "heiberg-industries/lares-engine-chief-of-staff-runtime"),
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
        # Test values for the doors, in the shapes the keeper accepts. Never printed.
        door_values = {"slackBotToken": f"xoxb-proof-{uuid.uuid4().hex}", "slackSigningSecret": os.urandom(16).hex(),
                       "telegramBotToken": f"123456789:PROOF{uuid.uuid4().hex}"}
        remember_secrets(*door_values.values())
        door_codes = work / "door-codes"
        door_codes.mkdir(mode=0o700)
        write_private(settings_file, json.dumps({
            "domain": DOMAIN, "agent": AGENT, "memberLimit": MEMBER_LIMIT, "toolPrompt": TOOL_PROMPT, "followUpPrompt": FOLLOW_UP_PROMPT,
            "approvalPrompt": APPROVAL_PROMPT, "approvalReply": APPROVAL_REPLY, "notePrompt": NOTE_PROMPT, "noteReply": NOTE_REPLY, "toolReply": TOOL_REPLY, "followUpReply": FOLLOW_UP_REPLY,
            # Any message the stand-in does not recognise is answered with PROOF_OK.
            "afterUpdatePrompt": "PROOF_AFTER_THE_UPDATE", "afterUpdateReply": "PROOF_OK", "receiptFile": str(work / "receipt.json"), "stateFile": str(work / "browser-state.json"),
            "beforeEditPrompt": "PROOF_BEFORE_THE_EDIT", "oldConversationPrompt": "PROOF_OLD_CONVERSATION_AFTER_THE_EDIT", "afterEditPrompt": "PROOF_AFTER_THE_EDIT",
            "editedDescription": EDITED_DESCRIPTION, "saveWarning": SAVE_WARNING,
            "screenshotDir": str(shots), "doorCodeDir": str(door_codes), **door_values,
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
        check_charges_after_answered_cards(release, deferred)
        denied = agent_permission_denied_lines()
        if denied:
            proof["agentPermissionDenied"] = denied[:40]
            save_proof()
            deferred.append(f"the agent's log has {len(denied)} database permission errors, first: {denied[0]}")
        else:
            passed("the-agent-log-has-no-database-permission-errors")

        stage("a started agent takes an edit")
        # A change to a running agent applies from the console alone, and saving it ends the agent's open
        # web-chat conversations, with a warning on the page first (Lares ADR-0027).
        started_before = agent_started_at()
        sessions_before = {call["session"] for call in conversation_calls(release)}
        audit_mark = keeper_audit_mark(release)
        browser("edit-after-start", settings_file, tls)
        # What the browser step itself checked: the warning, the save, the old conversation ended on the page with
        # no further answer, and a new conversation answered.
        passed("on-the-page-the-old-conversation-ended-unanswered-and-a-new-one-was-answered")
        if agent_started_at() != started_before or started_before is None:
            deferred.append(f"the agent's container was stopped or restarted by a description save (started {started_before}, now {agent_started_at()})")
        else:
            passed("a-description-save-did-not-stop-or-restart-the-agent")
        saved = read_only_query("SELECT json_build_object('description', d.definition->>'description', 'applied', r.applied_definition->>'description', "
                                f"'pending', r.pending) FROM agent_definitions d JOIN agent_resources r ON r.name = d.name WHERE d.name = '{AGENT}'", release)
        saved = json.loads(saved) if saved else {}
        proof["editAfterStart"] = {"savedDescriptionEdited": saved.get("description") == EDITED_DESCRIPTION,
                                   "appliedAtSave": saved.get("applied") == EDITED_DESCRIPTION, "pending": saved.get("pending")}
        save_proof()
        if saved.get("description") == EDITED_DESCRIPTION and saved.get("applied") == EDITED_DESCRIPTION and saved.get("pending") is False:
            passed("the-saved-definition-carries-the-edit-applied-with-nothing-pending")
        else:
            deferred.append(f"after the description save the definition is {proof['editAfterStart']}")
        stopped = keeper_log_lines("was stopped after a save")
        if stopped:
            deferred.append(f"the keeper logged a stop after the save: {stopped[0]}")
        else:
            passed("the-keeper-log-has-no-stop-after-a-save")
        # The browser step itself proves the old conversation was refused on the page and was not answered.
        # Here the budget ledger says the same at the money layer, and that the new one was charged.
        owner = read_only_query("SELECT coalesce(live_member_id, '') FROM budget_accounts WHERE kind = 'member'", release)
        # The save's own time, from the keeper's audit row for this one save (database clock, as created_at is).
        saved_at, saves = this_save_started_at(release, audit_mark)
        proof["editAfterStart"]["saveFoundInAudit"] = {"definitionSaves": saves, "found": saved_at is not None}
        save_proof()
        if saved_at is None:
            deferred.append(f"the keeper's audit log does not show exactly one definition save for this edit ({saves} found), so the ledger was not checked")
        if saved_at is not None:
            deadline = time.monotonic() + 60
            while True:
                calls = [call for call in conversation_calls(release, saved_at) if call["session"] not in sessions_before]
                old = {call["session"] for call in calls if not call["afterSave"]}
                new = {call["session"] for call in calls if call["afterSave"]} - old
                charged = [call for call in calls if call["session"] in new and call["state"] == "settled"]
                if charged or time.monotonic() > deadline:
                    break
                time.sleep(3)
            sessions = list(dict.fromkeys(call["session"] for call in calls))
            proof["editAfterStart"]["conversationCalls"] = [{"conversation": sessions.index(call["session"]) + 1, "state": call["state"],
                                                             "afterTheSave": call["afterSave"], "paidByOwner": call["payer"] == owner} for call in calls]
            save_proof()
            late = [call for call in calls if call["session"] in old and call["afterSave"]]
            if old and not late:
                passed("the-conversation-from-before-the-save-took-no-call-after-it")
            else:
                deferred.append(f"the conversation from before the save took {len(late)} call(s) after it, or none was found: {proof['editAfterStart']['conversationCalls']}")
            if charged and all(call["payer"] == owner for call in calls if call["session"] in new):
                passed("a-new-conversation-after-the-save-was-answered-and-charged-to-the-owner")
            else:
                deferred.append(f"no call of a new conversation after the save settled for the owner: {proof['editAfterStart']['conversationCalls']}")

        stage("a Slack and a Telegram message reach the model through Keeper")
        for kind in ("slack", "telegram"):
            door_turn(kind, work, fixture, settings_file, tls, door_values, door_codes, release, deferred)

        stage("sudo lares backups")
        apt_get("update", "-qq")
        apt_get("install", "-y", "-qq", "restic", "age")
        age_key = run("age-keygen", show=False).stdout
        recipient = re.search(r"public key: (age1\S+)", age_key)
        # The owner keeps this key off the server; here it stays in the work folder for the restore stage.
        age_key_file = work / "backup-age.key"
        age_key_file.write_text(age_key)
        os.chmod(age_key_file, 0o600)
        run("lares", "backups", "--yes", "--password-saved", "--accept-same-machine", "--repository", BACKUP_REPOSITORY,
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
        # The gateway image does not change here, but the installer rewrites its code and settings;
        # a gateway left running reads the previous release's files and refuses every model call.
        stale = gateway_replaced_files()
        if stale:
            raise RuntimeError(f"the gateway still reads files the update replaced: {stale}")
        passed("update-restarted-the-gateway-onto-the-new-files")
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

        # Everything above can pass while every model call is refused; only a chat shows it.
        stage("a chat after the update")
        calls_before = len([call for call in fake_calls(fixture) if call["kind"] == "model"])
        # Only web-chat calls count: with a door claimed, a scheduled call (an owner job) may settle in the same window.
        chat_settled = "SELECT count(*) FROM budget_attempts WHERE state = 'settled' AND authority_reference->>'kind' = 'human'"
        chat_settled_before = int(read_only_query(chat_settled, update) or 0)
        browser("chat-after-update", settings_file, tls)
        if len([call for call in fake_calls(fixture) if call["kind"] == "model"]) <= calls_before:
            raise RuntimeError("the chat after the update answered without a model call reaching the provider")
        deadline = time.monotonic() + 60
        while int(read_only_query(chat_settled, update) or 0) <= chat_settled_before:
            if time.monotonic() > deadline:
                raise RuntimeError("the model call after the update did not settle in the budget ledger")
            time.sleep(3)
        passed("chat-after-the-update-reached-the-model-and-settled")

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

        # Last: it replaces this server. Faults recorded so far are kept in the proof file first.
        proof["deferredFaults"] = deferred
        save_proof()
        if previous_pull_failure:
            stage("an older backup: not run")
            proof["restore"] = {"status": "not proven", "reason": previous_pull_failure}
            deferred.append(f"{previous_pull_failure}; the older-backup restore stage did not run, so it is not proven")
        else:
            older_backup_restores(work, home, tls, console, update, age_key_file)

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
