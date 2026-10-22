#!/usr/bin/env python3
"""Validate fixed managed Vault roots before selecting the Keeper-only compose overlay."""
import json
import os
import re
import stat
import sys


def prefixed_path(prefix: str, logical: str) -> str:
    """Join a logical absolute installation path without producing //srv for root prefix."""
    if not logical.startswith("/") or "\0" in logical or "\n" in logical or "\r" in logical:
        raise ValueError("logical path must be an absolute, single-line path")
    root = os.path.normpath(prefix or "/")
    if not os.path.isabs(root):
        raise ValueError("installation prefix must be absolute")
    return os.path.join(root, logical.lstrip("/"))


def _physical_path(prefix: str, logical: str) -> str:
    return prefixed_path(os.path.realpath(prefix or "/"), logical)


def _directory(prefix: str, logical: str) -> bool:
    path = prefixed_path(prefix, logical)
    try:
        entry = os.lstat(path)
        return (
            stat.S_ISDIR(entry.st_mode)
            and not stat.S_ISLNK(entry.st_mode)
            and os.path.realpath(path) == _physical_path(prefix, logical)
        )
    except OSError:
        return False


def _inventory_is_ready(prefix: str) -> bool:
    inventory_path = prefixed_path(prefix, "/srv/lares/installation/vault-storage.json")
    try:
        entry = os.lstat(inventory_path)
        if not stat.S_ISREG(entry.st_mode) or stat.S_ISLNK(entry.st_mode):
            return False
        with open(inventory_path, encoding="utf-8") as stream:
            inventory = json.load(stream)
        if inventory.get("version") != 1 or not re.fullmatch(r"[a-f0-9-]{36}", inventory["backing"]["id"]):
            return False
        if not _directory(prefix, "/srv/vault") or not _directory(prefix, "/var/lib/lares-vault-git"):
            return False
        areas = inventory["areas"]
        if not isinstance(areas, list) or not areas:
            return False
        for area in areas:
            area_id, kind = area["areaId"], area["kind"]
            if not re.fullmatch(r"[a-f0-9-]{36}", area_id) or kind not in ("private", "shared"):
                return False
            if area["relativePath"] != f"vault/{kind}/{area_id}":
                return False
            if area["origin"] != f"/var/lib/lares-vault-git/{area_id}.git":
                return False
            if not _directory(prefix, f"/srv/{area['relativePath']}") or not _directory(prefix, area["origin"]):
                return False
        return True
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return False


def _roots_are_ready(prefix: str) -> bool:
    return _directory(prefix, "/srv/vault") and _directory(prefix, "/var/lib/lares-vault-git")


def main(argv: list[str]) -> int:
    if len(argv) == 4 and argv[1] == "path":
        try:
            print(prefixed_path(argv[2], argv[3]))
            return 0
        except ValueError as error:
            print(f"keeper-vault-roots: {error}", file=sys.stderr)
            return 1
    if len(argv) == 3 and argv[1] in ("validate", "roots"):
        ready = _inventory_is_ready(argv[2]) if argv[1] == "validate" else _roots_are_ready(argv[2])
        if ready:
            print("ready")
            return 0
        return 1
    print("usage: keeper-vault-roots.py path <prefix> <logical-path> | validate|roots <prefix>", file=sys.stderr)
    return 64


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
