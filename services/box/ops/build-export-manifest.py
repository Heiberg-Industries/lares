#!/usr/bin/env python3
"""Build a path-free export manifest from verified archive members and metadata."""
import hashlib
import json
import os
import re
import sys


def fail():
    raise ValueError("source_inventory_invalid")


def digest(path):
    value = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def main():
    if len(sys.argv) != 5:
        fail()
    root, engine_version, date, records_path = sys.argv[1:]
    inventory_dir = os.path.join(root, ".inventory")
    entries = []
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if name == "manifest.json" or name.startswith("."):
            continue
        if not os.path.isfile(path) or "/" in name or "\\" in name:
            fail()
        entries.append({"name": name, "size": os.path.getsize(path), "sha256": digest(path)})
    by_name = {entry["name"]: entry for entry in entries}
    if len(by_name) != len(entries):
        fail()

    databases = []
    for entry in entries:
        name = entry["name"]
        if not name.endswith(".dump"):
            continue
        database = name[:-5]
        if not re.fullmatch(r"[A-Za-z0-9_-]+", database):
            fail()
        schema_file = os.path.join(inventory_dir, database + ".json")
        with open(schema_file, encoding="utf-8") as stream:
            parsed = json.load(stream)
        schemas = parsed.get("schemas") if isinstance(parsed, dict) and set(parsed) == {"schemas"} else None
        if (not isinstance(schemas, list) or
                any(not isinstance(schema, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*", schema) for schema in schemas) or
                schemas != sorted(set(schemas))):
            fail()
        databases.append({"name": database, "member": name, "sha256": entry["sha256"], "schemas": schemas})
    if not databases or not any(item["name"] == "lares_state" for item in databases):
        fail()

    data_roots, vaults, absent = [], [], []
    with open(records_path, encoding="utf-8") as stream:
        for line in stream:
            fields = line.rstrip("\n").split("\t")
            if len(fields) != 4:
                fail()
            kind, store, disposition, member = fields
            if kind == "absent":
                if disposition != "absent" or member:
                    fail()
                absent.append({"storeKind": store, "disposition": "absent"})
                continue
            if kind not in {"data", "vault"} or disposition != "included" or member not in by_name:
                fail()
            ref = {"storeKind": store, "disposition": "included", "member": member, "sha256": by_name[member]["sha256"]}
            (data_roots if kind == "data" else vaults).append(ref)
    for records in (data_roots, vaults, absent):
        keys = [(item["storeKind"], item.get("member", "")) for item in records]
        if len(keys) != len(set(keys)):
            fail()
    if len({item["member"] for item in data_roots}) != len(data_roots) or len({item["member"] for item in vaults}) != len(vaults):
        fail()
    if {item["member"] for item in data_roots} != {name for name in by_name if name.endswith(".tar")}:
        fail()
    if {item["member"] for item in vaults} != {name for name in by_name if name.endswith(".bundle")}:
        fail()
    support = [by_name["globals.sql"]] if "globals.sql" in by_name else []
    if len(support) != 1:
        fail()
    if {item["member"] for item in databases} | {item["member"] for item in data_roots} | {item["member"] for item in vaults} | {item["name"] for item in support} != set(by_name):
        fail()

    manifest = {
        "engineVersion": engine_version,
        "date": date,
        "inventoryVersion": 1,
        "files": entries,
        "sourceInventory": {
            "databaseCoverage": "all-nontemplate-databases",
            "databases": databases,
            "dataRoots": data_roots,
            "dataSelection": "configured-empty" if not data_roots else "configured",
            "absentDataRoots": absent,
            "vaultRepositories": vaults,
            "vaultSelection": "configured-empty" if not vaults else "configured",
            "supportFiles": [{"kind": "postgres-roles-without-passwords", "member": "globals.sql", "sha256": support[0]["sha256"]}],
            "protectedMaterial": {
                "credentialFiles": "excluded",
                "encryptedDatabaseCredentials": "may-be-present",
                "ordinaryImport": "blocked",
            },
            "unverified": [
                "stores outside the configured export paths",
                "database table and row contents beyond the declared schema names",
                "source-version compatibility and identity mappings",
            ],
        },
    }
    output = os.path.join(root, "manifest.json")
    with open(output, "w", encoding="utf-8") as stream:
        json.dump(manifest, stream, separators=(",", ":"), sort_keys=True)
        stream.write("\n")


try:
    main()
except Exception:
    print("export: source inventory could not be verified", file=sys.stderr)
    sys.exit(1)
