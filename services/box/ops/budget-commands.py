#!/usr/bin/env python3
"""`lares budget setup` and `lares agent start`: switch model spending on for an installation.

Runs as root on the host, with no Node on the host. Anything that holds money rules runs in a
throwaway container of the pinned engine image, or inside the keeper over its host-only socket:
the ledgers, the budget policy arithmetic and the staged gateway settings. This file only asks
the owner, orders the steps and applies the outcome.

Applying the stage touches exactly two things: compose.yaml, and the four budget lines in
keeper.env. The stage's own keeper.json is never used, because it drops settings it does not
render (outside tools, credentials).

Running either command again continues from what is actually on disk and in the database. The
one step that cannot be repeated is creating the two ledgers; the journal has no reset, so a
leftover from an interrupted creation stops the command and says so.

Exit codes: 0 ok · 64 bad usage · 77 not root · 78 refused or stopped; the reason is printed.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import secrets
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

EX_USAGE = 64
EX_NOTROOT = 77
EX_REFUSED = 78
ROOT_UID = 0
ROOT_GID = 0

FINANCIAL_DIRECTORY = "/var/lib/lares/budget-financial"
NATIVE_DIRECTORY = "/var/lib/lares/budget-native"
POLICY_FILE = "/etc/lares/native-policy.json"
SERVICE_KEY_FILE = "/etc/lares/secrets/gateway-budget-service-key"
OPERATOR_FILE = "/etc/lares/operator/database-password"
STATE_FILE = "/etc/lares/budget-setup.json"
STAGE_PARENT = "/var/lib/lares-budget-setup"
BUDGET_ENV_LINES = (
    "LARES_GATEWAY_BUDGET_SERVICE_KEY_FILE",
    "LARES_NATIVE_POLICY_FILE",
    "LARES_GATEWAY_BUDGET_SERVICE_KEY_TARGET",
    "LARES_NATIVE_POLICY_TARGET",
)
KEEPER_CLI = "/app/services/keeper/bin/budget-financial.ts"
BOX_TSX = "/app/services/box/node_modules/.bin/tsx"
PREPARE_TIMEOUT_SECONDS = 120
HELPER_TIMEOUT_SECONDS = 120
COMPOSE_TIMEOUT_SECONDS = 180
KEEPER_START_SECONDS = 120
GATEWAY_WATCH_SECONDS = 20
QUERY_TIMEOUT_SECONDS = 10
NATIVE_TIMEOUT_SECONDS = 25
RECONCILE_TIMEOUT_SECONDS = 90
MAX_REPLY_BYTES = 1_048_576

# USD per million tokens from the provider's pricing page, checked 2 November 2026. The owner
# confirms them; any other model means typing prices in. A model whose price changes with prompt
# length is left out, because the budget system has no way to express that.
PRICES_CHECKED = "2 November 2026"
SUGGESTED_PRICES = {
    "anthropic/claude-opus-5": {"input": "5", "output": "25", "cacheRead": "0.5", "cacheWrite": "6.25"},
    "anthropic/claude-opus-5-5": {"input": "4", "output": "20", "cacheRead": "0.2", "cacheWrite": "5"},
    "anthropic/claude-sonnet-5-5": {"input": "2", "output": "10", "cacheRead": "0.1", "cacheWrite": "2.5"},
}
PRICE_NAMES = (("input", "input"), ("output", "output"), ("cacheRead", "cache read"), ("cacheWrite", "cache write"))


class Stop(Exception):
    """Stop here and tell the owner why. The message is written for them."""


class KeeperRefused(Exception):
    """The keeper answered and said no."""

    def __init__(self, message: str = "", stdout: str = "") -> None:
        super().__init__(message)
        self.stdout = stdout


class KeeperUnclear(Exception):
    """The keeper could not be reached, or the outcome of the action is not known."""


def say(message: str) -> None:
    print(message, flush=True)


def is_private_file(info: os.stat_result) -> bool:
    return (stat.S_ISREG(info.st_mode) and info.st_uid == ROOT_UID and info.st_gid == ROOT_GID and
            stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1)


def write_atomic(path: Path, data: bytes, mode: int) -> None:
    """Replace a file in one step, so an interruption leaves the old file or the new one."""
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(6)}.partial")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
    try:
        os.fchown(fd, ROOT_UID, ROOT_GID)
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        os.close(fd)
        temporary.unlink(missing_ok=True)
        raise
    os.close(fd)
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def parse_settings(text: str) -> dict[str, str]:
    """Read NAME=value lines as the shell would, for the files install.sh writes."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        name, raw = line.split("=", 1)
        parts = shlex.split(raw)
        values[name.strip()] = parts[0] if parts else ""
    return values


def env_with_budget_lines(current: str, staged: str) -> str:
    """keeper.env with only the four budget lines taken from the stage."""
    wanted = {}
    for line in staged.splitlines():
        name = line.split("=", 1)[0]
        if name in BUDGET_ENV_LINES:
            if name in wanted:
                raise Stop("The staged keeper settings name a budget line twice. Nothing was applied.")
            wanted[name] = line
    if set(wanted) != set(BUDGET_ENV_LINES):
        raise Stop("The staged keeper settings do not name the four budget lines. Nothing was applied.")
    seen = set()
    lines = []
    for line in current.splitlines():
        name = line.split("=", 1)[0]
        if name in BUDGET_ENV_LINES:
            if name in seen:
                raise Stop("keeper.env names a budget line twice. Nothing was applied.")
            seen.add(name)
            lines.append(wanted[name])
        else:
            lines.append(line)
    if seen != set(BUDGET_ENV_LINES):
        raise Stop("keeper.env does not have the four budget lines the installer writes. Nothing was applied.")
    return "\n".join(lines) + "\n"


class Installation:
    """One installation's paths, settings and the ways to reach its containers and keeper."""

    def __init__(self, prefix: str, image: str, release: str) -> None:
        self.prefix = prefix.rstrip("/")
        self.image = image
        self.release = release

    def at(self, logical: str) -> Path:
        return Path(self.prefix + logical)

    def read_settings(self, logical: str) -> dict[str, str]:
        try:
            return parse_settings(self.at(logical).read_text(encoding="utf-8"))
        except OSError:
            raise Stop(f"{self.at(logical)} could not be read. Is this a finished installation?") from None

    def keeper_env(self) -> dict[str, str]:
        return self.read_settings("/etc/lares/keeper.env")

    def keeper_config(self) -> dict[str, Any]:
        try:
            value = json.loads(self.at("/etc/lares/keeper.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise Stop(f"{self.at('/etc/lares/keeper.json')} could not be read. Nothing was changed.") from None
        if not isinstance(value, dict):
            raise Stop("keeper.json is not a settings object. Nothing was changed.")
        return value

    def save_keeper_config(self, config: dict[str, Any]) -> None:
        write_atomic(self.at("/etc/lares/keeper.json"), (json.dumps(config, indent=2) + "\n").encode(), 0o600)

    def load_state(self) -> dict[str, Any] | None:
        path = self.at(STATE_FILE)
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            raise Stop(f"{path} could not be read. Nothing was changed.") from None

    def save_state(self, state: dict[str, Any]) -> None:
        write_atomic(self.at(STATE_FILE), (json.dumps(state, indent=2) + "\n").encode(), 0o600)

    def mount(self, logical: str, readonly: bool = True) -> list[str]:
        spec = f"type=bind,src={self.at(logical)},dst={logical}"
        return ["--mount", spec + (",readonly" if readonly else "")]

    def run_keeper_cli(self, *arguments: str) -> str:
        """The ledger commands, through the image's maintenance guard, with the keeper's own rights."""
        env = self.keeper_env()
        try:
            admission = env["LARES_MAINTENANCE_ADMISSION_DIR"]
            identity = [env["LARES_MAINTENANCE_INSTALLATION_ID"], env["LARES_MAINTENANCE_EPOCH"]]
            network = env["LARES_NETWORK"]
        except KeyError:
            raise Stop("keeper.env is missing the installation's identity or network. Nothing was changed.") from None
        command = ["docker", "run", "--rm", "--network", network, "--read-only", "--tmpfs", "/tmp",
                   "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE",
                   "--security-opt", "no-new-privileges", "--user", "0:0", "-e", "HOME=/tmp", "-w", "/app",
                   "--mount", f"type=bind,src={admission},dst=/run/lares-maintenance/admission,readonly",
                   *self.mount("/etc/lares/keeper.json"), *self.mount("/etc/lares/secrets"), *self.mount(OPERATOR_FILE),
                   *self.mount("/var/lib/lares", readonly=False),
                   self.image, "/run/lares-maintenance/admission", *identity, "--",
                   "node", "--import", "tsx/esm", KEEPER_CLI, *arguments]
        result = subprocess.run(command, capture_output=True, text=True, timeout=PREPARE_TIMEOUT_SECONDS, check=False)
        if result.returncode != 0:
            raise KeeperRefused(result.stderr.strip(), result.stdout)
        return result.stdout

    def run_box_program(self, script: str, stdin: str, *arguments: str, mounts: list[str] | None = None) -> str:
        """A box program with no network, as the installer runs them, but with its stdin connected."""
        command = ["docker", "run", "--rm", "-i", "--network", "none", "--read-only", "--tmpfs", "/tmp",
                   "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "0:0",
                   "-e", "HOME=/tmp", "-w", "/app/services/box", *(mounts or []),
                   "--entrypoint", BOX_TSX, self.image, f"/app/services/box/{script}", *arguments]
        result = subprocess.run(command, input=stdin, capture_output=True, text=True, timeout=HELPER_TIMEOUT_SECONDS, check=False)
        if result.returncode != 0:
            raise KeeperRefused(result.stderr.strip())
        return result.stdout

    def keeper_compose(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        # keeper.env names its own COMPOSE_FILE, including the Vault overlay when there is one.
        env = {key: value for key, value in os.environ.items() if key != "COMPOSE_FILE"}
        return subprocess.run(["docker", "compose", "--env-file", str(self.at("/etc/lares/keeper.env")), *arguments],
                              capture_output=True, text=True, timeout=COMPOSE_TIMEOUT_SECONDS, check=False, env=env)

    def stack_compose(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["docker", "compose", "-f", str(self.at("/opt/lares/compose.yaml")), *arguments],
                              capture_output=True, text=True, timeout=COMPOSE_TIMEOUT_SECONDS, check=False)

    def host_action(self, action: str, payload: dict[str, Any], timeout: float = QUERY_TIMEOUT_SECONDS) -> Any:
        """One request to the keeper's root-only socket, inside one absolute deadline."""
        deadline = time.monotonic() + timeout
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        reply = bytearray()
        try:
            client.settimeout(timeout)
            client.connect(str(self.at("/run/lares-host/keeper.sock")))
            client.sendall((json.dumps({"action": action, "input": payload}) + "\n").encode())
            try:
                client.shutdown(socket.SHUT_WR)
            except OSError:
                pass  # The keeper may already have answered and closed; its answer is still readable.
            while True:
                client.settimeout(max(0.001, deadline - time.monotonic()))
                chunk = client.recv(65536)
                if not chunk:
                    break
                reply.extend(chunk)
                if len(reply) > MAX_REPLY_BYTES:
                    raise KeeperUnclear("The keeper's answer was too large.")
        except OSError as error:
            raise KeeperUnclear(f"The keeper did not answer ({type(error).__name__}).") from None
        finally:
            client.close()
        try:
            answer = json.loads(reply.decode())
        except ValueError:
            raise KeeperUnclear("The keeper's answer could not be read.") from None
        if answer.get("ok") is True:
            return answer.get("result")
        if answer.get("outcome") == "refused":
            raise KeeperRefused(str(answer.get("error") or "The keeper refused."))
        raise KeeperUnclear(str(answer.get("error") or "The keeper could not confirm the outcome."))

    def lock(self) -> int:
        """Two copies of these commands must never interleave their steps."""
        fd = os.open(self.at("/etc/lares/.budget-commands.lock"), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            raise Stop("Another budget command is already running on this server.") from None
        return fd


def ask(question: str) -> str:
    try:
        return input(question).strip()
    except EOFError:
        raise Stop("No answer was given, so nothing was changed. Run this in a terminal, or pass the answers as options.") from None


def ask_for_answers(installation: Installation, options: argparse.Namespace, settings: dict[str, str]) -> dict[str, Any]:
    """Everything the owner decides, before anything on the server changes."""
    model = settings.get("LARES_MODEL", "")
    alias = settings.get("LARES_MODEL_ALIAS", "")
    gateway_url = settings.get("GATEWAY_URL", "")
    if not model or not alias or not gateway_url:
        raise Stop("installation.env does not name the model, its alias and the gateway address. Nothing was changed.")
    say(f"This installation's model is {model}.")
    installation_limit = options.installation_limit or ask("Most the whole installation may spend per month, in US dollars: ")
    person_limit = options.person_limit or ask("Most one person may spend per month, in US dollars: ")
    suggested = SUGGESTED_PRICES.get(model)
    if options.prices:
        parts = options.prices.split(",")
        if len(parts) != 4:
            raise Stop("--prices needs four numbers: input,output,cacheRead,cacheWrite. Nothing was changed.")
        prices = {name: part.strip() for (name, _), part in zip(PRICE_NAMES, parts)}
    elif suggested and options.yes:
        prices = dict(suggested)
    else:
        prices = {}
        if suggested:
            say(f"Prices for this model, checked {PRICES_CHECKED}. Check them against your provider's current page.")
            say("US dollars per million tokens: " + ", ".join(f"{label} ${suggested[name]}" for name, label in PRICE_NAMES))
            if ask("Use these prices? [Y/n] ").lower() in ("", "y", "yes"):
                prices = dict(suggested)
        if not prices:
            say("Type this model's prices in US dollars per million tokens.")
            prices = {name: ask(f"  {label}: ") for name, label in PRICE_NAMES}
    # A model of its own for a purpose, if installation.env names one. The reviewed policy has to describe the gateway as it runs.
    purpose_models = {purpose: settings[f"LARES_MODEL_{purpose.upper()}"] for purpose in ("writer", "utility", "gate")
                      if settings.get(f"LARES_MODEL_{purpose.upper()}")}
    # The embedding model, if installation.env names one, for the same reason.
    embedding = ({"model": settings["LARES_EMBED_MODEL"], "baseUrl": settings["LARES_EMBED_BASE_URL"],
                  **({"maxInputTokens": settings["LARES_EMBED_MAX_INPUT_TOKENS"]} if settings.get("LARES_EMBED_MAX_INPUT_TOKENS") else {})}
                 if settings.get("LARES_EMBED_MODEL") and settings.get("LARES_EMBED_BASE_URL") else None)
    try:
        rendered = json.loads(installation.run_box_program("bin/render-native-policy.ts", json.dumps({
            "alias": alias, "providerModel": model, "gatewayUrl": gateway_url,
            "installationLimit": installation_limit, "personLimit": person_limit, "prices": prices,
            **({"purposeModels": purpose_models} if purpose_models else {}),
            **({"embedding": embedding} if embedding else {}),
        })))
    except KeeperRefused as error:
        raise Stop(f"{error} Nothing was changed.") from None
    except ValueError:
        raise Stop("The budget policy could not be read back. Nothing was changed.") from None
    say("")
    say(f"Model: {rendered['model']}")
    say("Prices per million tokens: " + ", ".join(f"{label} ${rendered['prices'][name]}" for name, label in PRICE_NAMES))
    say(f"Installation limit: ${rendered['installationLimit']} a month. It cannot be changed after the first agent starts.")
    say(f"Per-person limit: ${rendered['personLimit']} a month, for anyone without a limit of their own.")
    say(f"Each model call holds up to ${rendered['maximumLiability']} of those limits until it finishes.")
    unpriced = rendered.get("unpricedAliases") or []
    if unpriced:
        say(f"Not priced yet: {', '.join(unpriced)}. Each of these runs a model of its own (or embeds), and this setup prices only {model}.")
        say("Until they are priced, calls to them are refused. Prices for them are a later step.")
    say("")
    if not options.yes and ask("Switch model spending on with these settings? [y/N] ").lower() not in ("y", "yes"):
        raise Stop("Nothing was changed.")
    return {"version": 1, "complete": False, "model": rendered["model"], "alias": alias,
            "installationLimit": rendered["installationLimit"], "personLimit": rendered["personLimit"],
            "prices": rendered["prices"], "maximumLiability": rendered["maximumLiability"],
            "policy": rendered["policy"], "stageDirectory": None, "bindings": {}}


def check_first_run(installation: Installation) -> None:
    config = installation.keeper_config()
    if "budgetFinancial" in config or "budgetNative" in config or "gatewayBudget" in config:
        raise Stop("This server already has budget settings that this command did not make, and it will not adopt them. Nothing was changed.")
    agents = installation.at("/srv/lares/agents")
    if agents.is_dir() and any(not entry.name.startswith(".") for entry in agents.iterdir()):
        raise Stop("An agent already exists. Budget setup has to run before the first agent is created. Nothing was changed.")


def check_ready(installation: Installation) -> None:
    oauth = installation.at("/etc/lares/console-oauth.env")
    try:
        confirmed = any(line.startswith("CONSOLE_BOOTSTRAP_IDENTITY=") for line in oauth.read_text(encoding="utf-8").splitlines())
    except OSError:
        confirmed = False
    if not confirmed:
        raise Stop("The owner is not confirmed yet. Run sudo lares owner-bootstrap first. Nothing was changed.")
    operator = installation.at(OPERATOR_FILE)
    try:
        info = operator.lstat()
        usable = stat.S_ISREG(info.st_mode) and info.st_uid == ROOT_UID and not info.st_mode & 0o077 and info.st_size > 0
    except OSError:
        usable = False
    if not usable:
        raise Stop(f"{operator} is missing or is not a root-only file. Nothing was changed.")


def prepare_ledger(installation: Installation, directory: str, key: str, step: str, arguments: list[str]) -> str | None:
    """Create one ledger. The one step here that cannot be repeated once it has written anything."""
    if key in installation.keeper_config():
        return None
    if os.path.lexists(installation.at(directory)):
        raise Stop(f"{directory} exists but nothing records it, so {step} was interrupted earlier. This step cannot be "
                   "repeated and has no reset. No agent has spent anything yet: on a new server, wipe it and install "
                   "again. Keep the folder if this server holds anything you need, and ask for help first.")
    try:
        return installation.run_keeper_cli(*arguments)
    except (KeeperRefused, subprocess.TimeoutExpired):
        if os.path.lexists(installation.at(directory)):
            raise Stop(f"{step.capitalize()} did not finish and left files behind. This step cannot be repeated and has "
                       "no reset. No agent has spent anything yet: on a new server, wipe it and install again.") from None
        raise Stop(f"{step.capitalize()} was refused before it wrote anything. Check that the database is running "
                   "(docker compose -f /opt/lares/compose.yaml ps), then run this command again.") from None


def write_service_key(installation: Installation) -> None:
    path = installation.at(SERVICE_KEY_FILE)
    try:
        info = path.lstat()
    except FileNotFoundError:
        write_atomic(path, secrets.token_bytes(32), 0o600)
        return
    if not is_private_file(info) or info.st_size != 32:
        raise Stop(f"{path} already exists but is not the key this command makes. Nothing further was changed.")


def write_policy(installation: Installation, policy: bytes) -> None:
    path = installation.at(POLICY_FILE)
    try:
        if path.read_bytes() == policy and is_private_file(path.lstat()):
            return
    except FileNotFoundError:
        pass
    write_atomic(path, policy, 0o600)


def run_stage(installation: Installation, state: dict[str, Any]) -> Path:
    """Render the stage, or reuse a complete one from an interrupted run that may be half applied."""
    recorded = state.get("stageDirectory")
    if recorded and (installation.at(recorded) / ".complete.json").is_file():
        return installation.at(recorded)
    parent = installation.at(STAGE_PARENT)
    parent.mkdir(mode=0o700, exist_ok=True)
    os.chown(parent, ROOT_UID, ROOT_GID)
    os.chmod(parent, 0o700)
    if recorded:
        shutil.rmtree(installation.at(recorded), ignore_errors=True)
    logical = f"{STAGE_PARENT}/stage-{uuid.uuid4().hex}"
    state["stageDirectory"] = logical
    installation.save_state(state)
    config = installation.keeper_config()
    env = installation.keeper_env()
    lifecycle = config.get("lifecycle") or {}
    release = os.path.realpath(installation.release)
    request = {
        "prefix": installation.prefix or "/", "releaseFile": release, "project": config.get("project"),
        "network": lifecycle.get("network"), "subnet": lifecycle.get("subnet"),
        "proxyAddress": env.get("LARES_PROXY_ADDRESS"), "pgDatabase": (config.get("db") or {}).get("database"),
    }
    if not all(request.values()):
        raise Stop("keeper.json or keeper.env is missing a setting the gateway stage needs. Run this command again after repairing the installation.")
    # The renderer sees the installation at its real paths, as install.sh's renderers do.
    mounts = []
    for path, access in (("/etc/lares", ",readonly"), ("/opt/lares", ",readonly"), ("/var/lib/lares-maintenance", ",readonly"),
                         (STAGE_PARENT, ""), ("/srv/lares/installation", ",readonly")):
        if installation.at(path).is_dir():
            mounts += ["--mount", f"type=bind,src={installation.at(path)},dst={installation.at(path)}{access}"]
    try:
        installation.run_box_program("bin/render-gateway-authority-stage.ts", json.dumps(request),
                                     str(installation.at(logical)), mounts=mounts)
    except KeeperRefused as error:
        raise Stop(f"Preparing the gateway settings was refused: {error}. Nothing was applied, and the keeper stays "
                   "stopped until this command finishes. Fix what it names and run this command again.") from None
    return installation.at(logical)


def apply_stage(installation: Installation, stage: Path) -> None:
    """Only compose.yaml and the four budget lines. Never the stage's keeper.json."""
    keeper_env = installation.at("/etc/lares/keeper.env")
    merged = env_with_budget_lines(keeper_env.read_text(encoding="utf-8"), (stage / "keeper.env").read_text(encoding="utf-8"))
    write_atomic(installation.at("/opt/lares/compose.yaml"), (stage / "compose.yaml").read_bytes(), 0o640)
    write_atomic(keeper_env, merged.encode(), 0o640)


def wait_for_keeper(installation: Installation) -> None:
    deadline = time.monotonic() + KEEPER_START_SECONDS
    while True:
        try:
            installation.host_action("definition.list", {})
            return
        except (KeeperRefused, KeeperUnclear):
            if time.monotonic() >= deadline:
                raise Stop("The keeper did not come back. See: env -u COMPOSE_FILE docker compose --env-file "
                           "/etc/lares/keeper.env logs --tail 100 lares-keeper. Then run this command again.") from None
            time.sleep(2)


def watch_gateway(installation: Installation) -> None:
    """A gateway without its settings crash-loops while `up -d` exits 0, so look again later."""
    time.sleep(GATEWAY_WATCH_SECONDS)
    found = installation.stack_compose("ps", "-q", "lares-gateway")
    identity = found.stdout.strip()
    state = subprocess.run(["docker", "inspect", "--format", "{{.State.Running}} {{.RestartCount}}", identity],
                           capture_output=True, text=True, timeout=COMPOSE_TIMEOUT_SECONDS, check=False) if identity else None
    if not state or state.returncode != 0 or state.stdout.strip() != "true 0":
        raise Stop("The gateway did not stay up. See: docker compose -f /opt/lares/compose.yaml logs --tail 100 "
                   "lares-gateway. Then run this command again.")


def budget_setup(installation: Installation, options: argparse.Namespace) -> int:
    state = installation.load_state()
    if state and state.get("complete"):
        say("Model budget setup is already done. Limits cannot be changed with this command.")
        return 0
    check_ready(installation)
    if state:
        say("Continuing the model budget setup that was stopped earlier, with the answers you gave then.")
    else:
        check_first_run(installation)
        state = ask_for_answers(installation, options, installation.read_settings("/etc/lares/installation.env"))
        # Saved first, so an interruption after this point never asks again or changes an answer.
        installation.save_state(state)

    say("Stopping the keeper while the ledgers are created. The console cannot manage agents until this finishes.")
    stopped = installation.keeper_compose("stop", "lares-keeper")
    if stopped.returncode != 0:
        raise Stop(f"The keeper could not be stopped: {stopped.stderr.strip()} Nothing else was changed. Run this command again.")

    say("Creating the spending ledger.")
    printed = prepare_ledger(installation, FINANCIAL_DIRECTORY, "budgetFinancial", "creating the spending ledger",
                             ["prepare-fresh", "--confirm-fresh-installation", "--operator-password-file", OPERATOR_FILE])
    if printed is not None:
        try:
            binding = json.loads(printed.strip().splitlines()[-1])["budgetFinancial"]
        except (ValueError, KeyError, IndexError):
            raise Stop("The spending ledger was created but its result could not be read. This step cannot be repeated: "
                       "on a new server, wipe it and install again.") from None
        config = installation.keeper_config()
        config["budgetFinancial"] = binding
        installation.save_keeper_config(config)

    say("Creating the key ledger.")
    printed = prepare_ledger(installation, NATIVE_DIRECTORY, "budgetNative", "creating the key ledger",
                             ["prepare-native", "--confirm-fresh-native-custody", "--operator-password-file", OPERATOR_FILE])
    if printed is not None:
        config = installation.keeper_config()
        config["budgetNative"] = {"directory": NATIVE_DIRECTORY}
        installation.save_keeper_config(config)

    say("Writing the gateway's key and the budget policy.")
    write_service_key(installation)
    write_policy(installation, json.dumps(state["policy"], separators=(",", ":")).encode())
    config = installation.keeper_config()
    config["budgetNative"] = {"directory": NATIVE_DIRECTORY, "reviewedPolicyFile": POLICY_FILE}
    config["gatewayBudget"] = {"serviceKeyFile": SERVICE_KEY_FILE}
    installation.save_keeper_config(config)

    say("Preparing and applying the gateway settings.")
    stage = run_stage(installation, state)
    apply_stage(installation, stage)

    say("Restarting the keeper and starting the gateway.")
    restarted = installation.keeper_compose("up", "-d", "--force-recreate", "lares-keeper")
    if restarted.returncode != 0:
        raise Stop(f"The keeper could not be restarted: {restarted.stderr.strip()} Run this command again.")
    wait_for_keeper(installation)
    started = installation.stack_compose("up", "-d", "lares-gateway")
    if started.returncode != 0:
        raise Stop(f"The gateway could not be started: {started.stderr.strip()} Run this command again.")
    watch_gateway(installation)

    stage_directory = state.get("stageDirectory")
    state["complete"] = True
    state["stageDirectory"] = None
    installation.save_state(state)
    if stage_directory:
        shutil.rmtree(installation.at(stage_directory), ignore_errors=True)
    say("")
    say("Model budget setup is done. Spending stays off until an agent is started.")
    say("Next: create your first agent in the console, adopt it on its Access tab, then run:")
    say("  sudo lares agent start <name>")
    return 0


def describe_blocker(name: str, status: dict[str, Any], owner_asked: bool, alias: str) -> str | None:
    agent = status.get("agent")
    member = status.get("member")
    if not agent:
        return f"No agent is called {name}. Create it in the console first."
    if agent["status"] != "valid":
        return f"The saved definition of {name} is {agent['status']}. Fix it in the console first."
    if not agent["owned"] or not agent["incarnation"] or agent["state"] != "ready":
        return f"{name} is not ready to start yet. Open it in the console and check that it saved without errors."
    if agent["pending"]:
        return f"{name} is waiting: {agent['pendingReason'] or 'the keeper has work in progress'}."
    if agent["model"] != alias:
        return f"{name} uses the model name {agent['model']}, but budget setup covers only {alias}. Change the agent's model in the console."
    if not member:
        return ("The owner's account was not found." if owner_asked else
                "Nobody with that email or id has joined. Invite them on the Members page; they sign in once, then run this again.")
    if not member["active"]:
        return "That person is not an active member."
    if not member["verified"]:
        return "That person has not signed in yet. They need to sign in once, then run this again."
    if not member["canUse"]:
        return (f"You have not adopted {name} yet. Adopt it on its Access tab in the console, then run this again." if owner_asked else
                f"That person has no access to {name}. Give them access on its Access tab in the console, then run this again.")
    if status.get("account") and status["account"]["state"] != "closed" and not status.get("binding"):
        return ("This person is already connected to another agent. Today one person can be connected to one agent only, "
                "because their budget account can be opened once.")
    return None


def agent_start(installation: Installation, options: argparse.Namespace) -> int:
    state = installation.load_state()
    if not state or not state.get("complete"):
        raise Stop("Model budget setup has not finished. Run sudo lares budget setup first.")
    name = options.name
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,30}", name):
        raise Stop(f"{name} is not an agent name. Agent names are lower case, for example my-agent.")
    request: dict[str, Any] = {"agent": name}
    if options.member:
        request["member"] = options.member
    status = installation.host_action("budget.agent-start-status", request)
    blocker = describe_blocker(name, status, not options.member, state["alias"])
    if blocker:
        raise Stop(f"{blocker} Nothing was changed.")
    member_id = status["member"]["id"]
    if not status["member"]["limit"]:
        installation.host_action("budget.apply-default-member-limit", {"memberId": member_id, "monthlyLimit": state["personLimit"]})
        say(f"This person had no monthly limit, so they now have the default of ${state['personLimit']}.")

    if not status["binding"]:
        # Repeating this for the same person reuses their account and month.
        say("Opening their budget account.")
        installation.host_action("budget.provision-accounts", {"installationCap": state["installationLimit"], "memberIds": [member_id]})
        key = f"{name}/{member_id}/{status['agent']['incarnation']}"
        binding = state["bindings"].get(key)
        if not binding:
            # Written before the first attempt: a retry must carry the same id, never a second key.
            binding = {"bindingId": str(uuid.uuid4()), "credentialGeneration": "0"}
            state["bindings"][key] = binding
            installation.save_state(state)
        say("Creating their key at the gateway. It stays blocked until the next step.")
        try:
            installation.host_action("budget.provision-native", {**binding, "memberId": member_id, "agent": name,
                                     "incarnation": status["agent"]["incarnation"], "purposeAlias": state["alias"]}, NATIVE_TIMEOUT_SECONDS)
        except KeeperRefused:
            raise Stop("The keeper refused to create the key. If an earlier run was interrupted at this step, Lares cannot "
                       "tell whether the key was made, so it will not try again. That key stays blocked and cannot spend. "
                       "There is no clean-up command yet: on a test server, wipe it and install again.") from None
        status = installation.host_action("budget.agent-start-status", request)
        if not status["binding"]:
            raise Stop("The keeper reported the key but it is not on record. Nothing else was changed. Run this command again.")

    if status["account"]["state"] == "closed":
        say("Opening spending for this person and agent.")
        installation.host_action("budget.activate-native", {"bindingId": status["binding"]["id"],
                                 "credentialGeneration": status["binding"]["credentialGeneration"]}, NATIVE_TIMEOUT_SECONDS)

    listed = installation.host_action("definition.list", {})
    agent = next((entry for entry in listed if entry.get("name") == name), None)
    if not agent or not agent.get("hash"):
        raise Stop(f"{name} is not listed by the keeper any more. Spending is open for this person; run this command again.")
    # Reconciling a running agent restarts it, so a running agent is left alone: adding a second
    # person never interrupts the first.
    running = (installation.host_action("definition.get", {"name": name}).get("runtime") or {}).get("running")
    if running is True:
        say(f"{name} is already running, and this person can now use it.")
        return 0
    if running is not False:
        raise Stop(f"The keeper cannot tell whether {name} is running, so it was not started. Spending is open for this person. Check docker on this server, then run this command again.")
    say(f"Starting {name}. This can take a minute.")
    result = installation.host_action("definition.reconcile", {"name": name, "hash": agent["hash"]}, RECONCILE_TIMEOUT_SECONDS)
    if not result or result.get("running") is not True or result.get("healthy") is not True:
        reason = (result or {}).get("reason") or "it did not report healthy in time"
        raise Stop(f"{name} did not start: {reason}. Run this command again.")
    say(f"{name} is running. Open the console to talk to it.")
    return 0


def agent_refresh(installation: Installation, options: argparse.Namespace) -> int:
    """After an update: restart each running agent onto the software this release names. An agent with
    changes waiting, or one the keeper cannot read, is left alone and named."""
    wait_for_keeper(installation)
    left = 0
    for entry in installation.host_action("definition.list", {}):
        name = entry.get("name")
        if entry.get("status") != "valid" or not isinstance(name, str):
            continue
        try:
            result = installation.host_action("definition.refresh-image", {"name": name}, RECONCILE_TIMEOUT_SECONDS) or {}
        except KeeperRefused as error:
            say(f"{name} stays on the previous software: the keeper refused ({error}).")
            left += 1
            continue
        except (KeeperUnclear, subprocess.TimeoutExpired):
            say(f"{name}: the keeper could not confirm the restart in time. Check it with: sudo lares agent start {name}")
            left += 1
            continue
        if result.get("moved"):
            if result.get("running") is True:
                say(f"{name} restarted on this release.")
            else:
                say(f"{name} did not come back up: {result.get('reason') or 'it did not report healthy in time'}. "
                    f"Start it with: sudo lares agent start {name}")
                left += 1
        elif result.get("state") in ("current", "stopped"):
            say(f"{name}: {result.get('reason')}.")
        else:
            say(f"{name} stays on the previous software: {result.get('reason') or 'the keeper did not say why'}.")
            left += 1
    return 0 if left == 0 else EX_REFUSED


FREEZE_WORDS = {"restore": "a restore froze it before replacing the database",
                "continuity": "the database and the ledger disagreed",
                "uncertain": "an interrupted step could not be settled"}


def recovery_report(installation: Installation, mode: str) -> tuple[dict[str, Any], bool]:
    """What the proof found, read back from the keeper image. True when every money record matched."""
    try:
        report = json.loads(installation.run_keeper_cli("recover", mode))
    except KeeperRefused as error:
        # A failed proof exits non-zero but still prints its report.
        try:
            report = json.loads(error.stdout)
        except (json.JSONDecodeError, TypeError):
            report = None
        if report is None:
            raise Stop("The ledger could not be opened: its files are missing, damaged or owned by another process. "
                       "Nothing was changed. Do not edit its files; see docs/budget-financial-journal.md.") from None
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        if mode == "--apply":
            raise Stop("The recovery did not finish, so whether it wrote anything is not known. Run this command again: "
                       "it checks what happened first.") from None
        raise Stop("The check did not finish. Nothing was changed. Run this command again.") from None
    say(f"Spending is {'frozen' if report['frozen'] else 'not frozen'}.")
    for reason in report.get("freezeReasons", []):
        say(f"  Why: {FREEZE_WORDS.get(reason, reason)}.")
    if report.get("interrupted"):
        say(f"  One step was interrupted: {report['interrupted']}.")
    if report.get("tornLine"):
        say("  A power cut tore the last ledger line. It was never confirmed; a copy is kept beside the ledger.")
    held = report.get("held")
    if held:
        say(f"  {held['attempts']} calls have no final cost, holding ${held['amount']}. This command leaves them counted.")
    if report.get("publicationUnfinished"):
        say("  A member removal, erasure or key step stopped after its money step, so the key store's half may not have run. "
            "Recovering settles the money only. That key needs checking by hand; no command finishes it yet.")
    if report.get("keyStore") == "uncertain":
        say("  The key store stopped itself. Recovering checks its files and lets the keeper open it, keeping every key as it is.")
    result = report.get("result")
    if result == "could-not-apply":
        raise Stop("The money records matched, but the recovery could not be finished: the ledger could not be written, or the "
                   "key store's files did not verify. Run this command again. If it repeats, do not edit those files.")
    if result == "database-silent":
        raise Stop("The database did not answer, so nothing could be proved and nothing was changed. Run this command again once it is up.")
    if result == "different":
        say("The money records do not match the ledger, so this command will not clear anything:")
        difference = report.get("difference") or {}
        if difference.get("database"):
            say("  This is a different database from the one the ledger belongs to. A restore does this.")
        for table in difference.get("tables", []):
            if table["changed"] or table["expected"] != table["found"]:
                say(f"  {table['table']}: the ledger expects {table['expected']}, the database has {table['found']}, {table['changed']} differ.")
        say("If this followed a restore from an older backup, money spent since that backup is missing from the database. "
            "There is no command for that yet. Spending stays off; everything else keeps working.")
    return report, result != "different"


def budget_recover(installation: Installation, options: argparse.Namespace) -> int:
    if not os.path.lexists(installation.at(FINANCIAL_DIRECTORY)):
        say("Spending has not been set up, so there is nothing to recover.")
        return 0
    report, provable = recovery_report(installation, "--check")
    if options.check or not provable:
        if options.check and provable and report["frozen"]:
            say("The money records match. `sudo lares budget recover` would clear this.")
        return 0 if provable else EX_REFUSED
    if not report["frozen"] and not report.get("interrupted") and report.get("keyStore") != "uncertain":
        say("Nothing to recover.")
        return 0
    if ask("The money records match. This stops the keeper for a moment, adds lines to the ledger, changes no money "
           "record, then starts the keeper. Type recover to go on: ") != "recover":
        say("Nothing was changed.")
        return 0
    stopped = installation.keeper_compose("stop", "lares-keeper")
    if stopped.returncode != 0:
        raise Stop(f"The keeper could not be stopped: {stopped.stderr.strip()} Nothing was changed.")
    try:
        final, provable = recovery_report(installation, "--apply")
    finally:
        restarted = installation.keeper_compose("up", "-d", "lares-keeper")
        if restarted.returncode != 0:
            say(f"The keeper could not be restarted: {restarted.stderr.strip()} Start it with: docker compose up -d lares-keeper")
    if restarted.returncode != 0:
        raise Stop("The keeper is stopped. Start it, then run `lares doctor`.")
    if not provable or not final.get("applied"):
        raise Stop("The second check did not pass, so nothing was cleared.")
    wait_for_keeper(installation)
    say("Recovered. Spending is open again.")
    return 0


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="lares", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--release", required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    setup = commands.add_parser("setup")
    setup.add_argument("--installation-limit")
    setup.add_argument("--person-limit")
    setup.add_argument("--prices", help="input,output,cacheRead,cacheWrite in US dollars per million tokens")
    setup.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    recover = commands.add_parser("recover")
    recover.add_argument("--check", action="store_true", help="report only; changes nothing")
    start = commands.add_parser("agent-start")
    start.add_argument("name")
    start.add_argument("--member", help="the person's sign-in email or member id; the owner when left out")
    commands.add_parser("agent-refresh", help="restart running agents onto this release's software (lares update runs this)")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    try:
        options = parse_arguments(argv)
    except SystemExit as error:
        return EX_USAGE if error.code else 0
    if os.geteuid() != ROOT_UID:
        print("lares: this needs to run as root.", file=sys.stderr)
        return EX_NOTROOT
    installation = Installation(options.prefix, options.image, options.release)
    try:
        lock = installation.lock()
        try:
            if options.command == "recover":
                return budget_recover(installation, options)
            if options.command == "agent-refresh":
                return agent_refresh(installation, options)
            return budget_setup(installation, options) if options.command == "setup" else agent_start(installation, options)
        finally:
            os.close(lock)
    except Stop as error:
        print(f"lares: {error}", file=sys.stderr)
    except KeeperRefused as error:
        print(f"lares: the keeper refused this step: {error} Run this command again once that is fixed.", file=sys.stderr)
    except KeeperUnclear as error:
        print(f"lares: {error} This step's outcome is not known. Run this command again: it checks what happened before "
              "doing anything, and it will say so if it cannot continue.", file=sys.stderr)
    except subprocess.TimeoutExpired:
        print("lares: a step took too long and was stopped. Run this command again: it continues from what is on record.", file=sys.stderr)
    except KeyboardInterrupt:
        print("lares: interrupted. Run this command again to continue. It will say so if it cannot.", file=sys.stderr)
    return EX_REFUSED


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
