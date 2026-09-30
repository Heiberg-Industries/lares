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


def console_env_with_principal(contents: str, owner: str) -> str:
    """Keep existing OAuth secrets intact while pinning agent OAuth to this owner."""
    if not re.fullmatch(r"[A-Za-z0-9._@-]+", owner):
        raise ValueError("installed owner is not safe for an env assignment")
    assignments: list[str] = []
    for line in contents.splitlines():
        if line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() == "CONSOLE_PRINCIPAL_ID":
            if key != "CONSOLE_PRINCIPAL_ID":
                raise ValueError("console Google principal assignment is not canonical")
            assignments.append(value)
    if len(assignments) > 1 or (assignments and assignments[0] != owner):
        raise ValueError("console Google principal must match the installed owner exactly once")
    if assignments:
        return contents
    return contents + ("" if not contents or contents.endswith("\n") else "\n") + f"CONSOLE_PRINCIPAL_ID={owner}\n"


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
    try:
        console_env = console_env_with_principal(args.env_file.read_text(), owner)
    except ValueError as error:
        parser.error(str(error))
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
        print(f"Would configure Google org {args.org} for Keeper and console; no files changed.")
        return
    atomic_write(client_id_file, (client_id + "\n").encode(), 0o440, 10001)
    atomic_write(client_secret_file, (client_secret + "\n").encode(), 0o440, 10001)
    atomic_write(args.keeper_config, (json.dumps(config, indent=2) + "\n").encode(), 0o600, 0)
    if console_env != args.env_file.read_text():
        atomic_write(args.env_file, console_env.encode(), 0o600, 0)
    print(f"Configured Google org {args.org} for Keeper and console. Restart only Keeper and console before connecting an agent.")


if __name__ == "__main__":
    main()
