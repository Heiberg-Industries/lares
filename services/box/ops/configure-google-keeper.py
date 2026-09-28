#!/usr/bin/env python3
"""Connect an explicitly configured Google data client to a fresh Keeper install.

Run as root after adding GOOGLE_CLIENT_ID_<ORG> and GOOGLE_CLIENT_SECRET_<ORG>
to the console's root-only OAuth env file. No credential is passed on argv or printed.
Restart only the Keeper after this exits successfully; the script does not touch Docker.
"""

import argparse
import json
import os
import re
import stat
import tempfile
from pathlib import Path


def read_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value
    return values


def atomic_write(path: Path, value: bytes, mode: int, gid: int) -> None:
    fd, temp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchown(fd, 0, gid)
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--org", required=True, help="explicit lower-case Google organisation id")
    parser.add_argument("--env-file", type=Path, default=Path("/etc/lares/console-oauth.env"))
    parser.add_argument("--keeper-config", type=Path, default=Path("/etc/lares/keeper.json"))
    parser.add_argument("--secrets-dir", type=Path, default=Path("/etc/lares/secrets"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if os.geteuid() != 0:
        parser.error("run as root")
    if not re.fullmatch(r"[a-z][a-z0-9_-]*", args.org):
        parser.error("org must be a lower-case id")
    env_stat = args.env_file.lstat()
    config_stat = args.keeper_config.lstat()
    dir_stat = args.secrets_dir.lstat()
    if (not stat.S_ISREG(env_stat.st_mode) or env_stat.st_uid != 0
            or env_stat.st_mode & 0o077):
        parser.error("OAuth env file must be root-owned and mode 0600")
    if (not stat.S_ISREG(config_stat.st_mode) or config_stat.st_uid != 0
            or config_stat.st_mode & 0o077):
        parser.error("Keeper config must be root-owned and private")
    if (not stat.S_ISDIR(dir_stat.st_mode) or dir_stat.st_uid != 0
            or ((dir_stat.st_mode & 0o777) not in (0o700, 0o750))
            or ((dir_stat.st_mode & 0o777) == 0o750 and dir_stat.st_gid != 10001)):
        parser.error("secrets directory must be root-only or root:runtime 0750")

    values = read_values(args.env_file)
    suffix = args.org.upper()
    client_id = values.get(f"GOOGLE_CLIENT_ID_{suffix}", "")
    client_secret = values.get(f"GOOGLE_CLIENT_SECRET_{suffix}", "")
    if not client_id or not client_secret or "\n" in client_id or "\n" in client_secret:
        parser.error(f"OAuth env file needs both Google data client fields for {args.org}")

    config = json.loads(args.keeper_config.read_text())
    lifecycle = config["lifecycle"]
    runtime = lifecycle["runtime"]
    owner = lifecycle["defaultBindings"]["chief-of-staff"]["ownerId"]
    if values.get("CONSOLE_PRINCIPAL_ID", owner) != owner:
        parser.error("console Google principal must match the installed owner")
    token_key = args.secrets_dir / "token-enc-key"
    if not token_key.is_file():
        parser.error("installed token encryption key is missing")
    google = runtime.get("google", {"principal": owner, "tokenKeyFile": str(token_key), "clients": {}})
    if google["principal"] != owner or google["tokenKeyFile"] != str(token_key):
        parser.error("existing Keeper Google principal or token key differs from this installation")
    client_id_file = args.secrets_dir / f"google-client-id-{args.org}"
    client_secret_file = args.secrets_dir / f"google-client-secret-{args.org}"
    google["clients"][args.org] = {
        "clientIdFile": str(client_id_file),
        "clientSecretFile": str(client_secret_file),
    }
    runtime["google"] = google

    if args.dry_run:
        print(f"Would configure Google org {args.org} for installed owner {owner}; no files changed.")
        return
    atomic_write(client_id_file, (client_id + "\n").encode(), 0o440, 10001)
    atomic_write(client_secret_file, (client_secret + "\n").encode(), 0o440, 10001)
    atomic_write(args.keeper_config, (json.dumps(config, indent=2) + "\n").encode(), 0o600, 0)
    print(f"Configured Google org {args.org} for Keeper. Restart only the Keeper before connecting an agent.")


if __name__ == "__main__":
    main()
