#!/usr/bin/env python3
"""Remove one orphaned LiteLLM key after a fresh-target Lares restore.

The export excludes runtime secrets. Run this only before reconciling a restored
agent whose plaintext gateway key is absent. Dry-run is the default.
"""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib import request


def refuse(message: str) -> None:
    raise SystemExit(f"restore-key: refusing — {message}")


def command(*args: str, input_text: str | None = None) -> str:
    result = subprocess.run(args, input=input_text, text=True, capture_output=True, check=False)
    if result.returncode:
        refuse("a local Docker/database check failed; inspect the service before retrying")
    return result.stdout.strip()


def rows(compose: Path, database: str, agent: str, sql: str) -> list[dict]:
    output = command(
        "docker", "compose", "-f", str(compose), "exec", "-T", "db",
        "psql", "-U", "lares", "-d", database, "-X", "-A", "-t",
        "-v", "ON_ERROR_STOP=1", "-v", f"agent={agent}", input_text=sql,
    )
    try:
        return [json.loads(line) for line in output.splitlines() if line]
    except json.JSONDecodeError:
        refuse("the database returned an unexpected row shape")


def gateway(master_key: str, endpoint: str, key_hash: str) -> list[dict]:
    body = json.dumps({"keys": [key_hash]}).encode()
    req = request.Request(
        f"http://127.0.0.1:4000/{endpoint}", data=body,
        headers={"Authorization": f"Bearer {master_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=10) as response:
            if endpoint == "key/delete":
                response.read()
                return []
            data = json.load(response)
    except Exception:
        refuse("the local gateway request failed; no key state is assumed")
    if not isinstance(data, dict) or not isinstance(data.get("info"), list):
        refuse("the local gateway returned an unexpected key lookup")
    return data["info"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", required=True, help="exact restored agent name")
    parser.add_argument("--execute", action="store_true", help="delete the one verified orphan hash")
    parser.add_argument("--compose", type=Path, default=Path("/opt/lares/compose.yaml"))
    parser.add_argument("--secrets-dir", type=Path, default=Path("/srv/lares/secrets"))
    parser.add_argument("--master-key-file", type=Path,
                        default=Path("/etc/lares/secrets/gateway-master-key"))
    args = parser.parse_args()
    name = args.agent
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,30}", name):
        refuse("invalid agent name")
    if args.execute and os.geteuid() != 0:
        refuse("--execute requires root on the restored target")
    if not args.compose.is_file():
        refuse("the installed Compose file is missing")
    if os.path.lexists(args.secrets_dir / f"{name}-gateway-key"):
        refuse("the agent plaintext gateway key exists; this is not an orphan")
    running = command(
        "docker", "ps", "-a", "--filter", f"label=com.docker.compose.service=lares-{name}",
        "--format", "{{.ID}}",
    )
    if running:
        refuse("an agent container still exists; stop and remove it before rotating a restored key")

    resource = rows(args.compose, "lares_state", name, """
SELECT row_to_json(r) FROM (
  SELECT name, state, ownership, runtime_control_token=ownership_token AS controlled
  FROM agent_resources WHERE name=:'agent'
) r;
""")
    if len(resource) != 1 or resource[0] != {
        "name": name, "state": "ready", "ownership": "owned", "controlled": True,
    }:
        refuse("the restored agent is not one owned ready resource")
    key = rows(args.compose, "litellm", name, """
SELECT row_to_json(k) FROM (
  SELECT token, key_alias, key_type, max_budget, budget_duration, models, metadata
  FROM "LiteLLM_VerificationToken" WHERE key_alias='lares-agent-' || :'agent'
) k;
""")
    if len(key) != 1:
        refuse("the gateway database must contain exactly one matching alias")
    item = key[0]
    metadata = item.get("metadata")
    models = item.get("models")
    prefix = None
    if isinstance(models, list) and len(models) == 5 and all(isinstance(model, str) for model in models):
        prefix = models[0].removesuffix("-brain") if models[0].endswith("-brain") else None
    if (item.get("key_alias") != f"lares-agent-{name}"
            or item.get("key_type") != "llm_api"
            or item.get("max_budget") != 5
            or item.get("budget_duration") != "1d"
            or not isinstance(metadata, dict)
            or metadata.get("managed_by") != "lares"
            or metadata.get("agent") != name
            or not prefix or not re.fullmatch(r"[a-z0-9]+", prefix)
            or set(models) != {f"{prefix}-{purpose}" for purpose in ("brain", "writer", "utility", "gate", "embed")}
            or not re.fullmatch(r"[0-9a-f]{64}", str(item.get("token", "")))):
        refuse("the matching alias does not have the exact managed-key policy")

    master_file = args.master_key_file
    if not master_file.is_file():
        refuse("the installed gateway master key is missing")
    master = master_file.read_text().strip()
    if not master.startswith("sk-") or len(master) < 16:
        refuse("the installed gateway master key is invalid")
    found = gateway(master, "v2/key/info", item["token"])
    if len(found) != 1 or not isinstance(found[0], dict) or found[0].get("key_alias") != item["key_alias"]:
        refuse("the local gateway does not identify the same single key")
    if not args.execute:
        print(f"restore-key: verified one orphaned managed key for {name}; no change made. Re-run with --execute on this restored target.")
        return
    gateway(master, "key/delete", item["token"])
    if gateway(master, "v2/key/info", item["token"]):
        refuse("the gateway still reports the key; do not reconcile yet")
    print(f"restore-key: removed one orphaned managed key for {name}. Run audited definition.reconcile and verify the replacement runtime.")


if __name__ == "__main__":
    main()
