#!/usr/bin/env node
/**
 * PR1a: inspect the real installation export without applying it.
 *
 * This is deliberately an inspection result, not an ImportManifest/ImportReceipt. The later
 * category mapper must account for application rows and file stores before an import plan exists.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { IMPORT_CATEGORIES } from "@lares/agent-kit/authority-contract";

const SOURCE_RELEASE = "2026-10-21-rc.12";
const DESTINATION_SCHEMA = "rc.13@ec0c6cd8b2a2072d0cf066c1192c8d46787f2134";
const EXPECTED_MIGRATIONS = [
  ["001_baseline.sql", "a2a50ac42a53b25ba28faf41e8b8970354292f131e0e673cb7cc2a0001fa725a"],
  ["002_standing_facts.sql", "8d1abbab5d997af30f185454aac3a46407bc6d96fde2f555065522fd0df7b58a"],
  ["003_outside_tool_seen.sql", "a7a43c6ae74466e398935afac6ec379f39ee2ccdf7d4ca8e78b2cdc482949cfa"],
  ["004_web_inbox.sql", "56c5e04433aa350c9ed7bbed4d7aa0eb533d910f921cba2fe526183ac262dd0b"],
  ["005_model_steps.sql", "e1ecab54f9c18c63b057f7970c70fa835ebeb0e09381b6295c4f64a20a91be66"],
  ["006_approval_session.sql", "2de295f5c742a004addeb28579d579865bb7832a5d5287be742d0e2e7944827b"],
] as const;

const ARCHIVE_CHECK = String.raw`
import hashlib, json, re, sys, tarfile

SECRET = re.compile(r"^(?:\.env|secrets|.*\.age|.*-key|.*-secret)$", re.I)
SAFE_DB = re.compile(r"^(?:postgres|lares_state|lares_[a-f0-9]{32})\.dump$")

def safe_name(raw, is_dir=False):
    if not isinstance(raw, str) or not raw or "\\" in raw or "\0" in raw:
        raise ValueError("unsafe_path")
    name = raw
    while name.startswith("./"):
        name = name[2:]
    if is_dir and name.endswith("/") and not name.endswith("//"):
        name = name[:-1]
    if name in ("", "."):
        return "."
    if name.startswith("/") or any(part in ("", ".", "..") for part in name.split("/")):
        raise ValueError("unsafe_path")
    if any(SECRET.fullmatch(part) for part in name.split("/")):
        raise ValueError("secret_path")
    return name

def require_regular(tf, member, allow_root_dir=False):
    if member.isdir() and allow_root_dir and safe_name(member.name) == ".":
        return None
    if not member.isfile():
        raise ValueError("unsafe_archive_entry")
    return tf.extractfile(member)

def inspect_nested_tar(raw):
    count = 0
    with tarfile.open(fileobj=raw, mode="r|*") as nested:
        names = set()
        for member in nested:
            name = safe_name(member.name, member.isdir())
            if name == "." and member.isdir(): continue
            if name in names: raise ValueError("duplicate_archive_path")
            names.add(name)
            if member.isdir(): continue
            if not member.isfile(): raise ValueError("unsafe_archive_entry")
            count += 1
    return count

try:
    archive = sys.argv[1]
    with tarfile.open(archive, mode="r:*") as tf:
        members, by_name = [], {}
        for item in tf:
            name = safe_name(item.name, item.isdir())
            if name == "." and item.isdir(): continue
            if name in by_name: raise ValueError("duplicate_archive_path")
            stream = require_regular(tf, item, allow_root_dir=True)
            by_name[name] = (item, stream)
            members.append(name)
        if "manifest.json" not in by_name: raise ValueError("missing_manifest")
        manifest_member, manifest_stream = by_name["manifest.json"]
        if manifest_member.size > 1024 * 1024: raise ValueError("invalid_manifest")
        manifest_bytes = manifest_stream.read(1024 * 1024 + 1)
        if len(manifest_bytes) > 1024 * 1024 or len(manifest_bytes) != manifest_member.size:
            raise ValueError("invalid_manifest")
        manifest = json.loads(manifest_bytes)
        if not isinstance(manifest, dict) or set(manifest) != {"engineVersion", "date", "files"}:
            raise ValueError("invalid_manifest")
        if not isinstance(manifest["engineVersion"], str) or not isinstance(manifest["date"], str) or not isinstance(manifest["files"], list):
            raise ValueError("invalid_manifest")
        entries = {}
        for entry in manifest["files"]:
            if not isinstance(entry, dict) or set(entry) != {"name", "size", "sha256"}:
                raise ValueError("invalid_manifest")
            name = safe_name(entry["name"])
            if name == "manifest.json" or name in entries: raise ValueError("invalid_manifest")
            if not isinstance(entry["size"], int) or entry["size"] < 0 or not re.fullmatch(r"[0-9a-f]{64}", str(entry["sha256"])):
                raise ValueError("invalid_manifest")
            entries[name] = entry
        if set(entries) != (set(by_name) - {"manifest.json"}): raise ValueError("manifest_file_set_mismatch")
        kinds = {"databaseDumps": 0, "dataArchives": 0, "vaultBundles": 0, "otherFiles": 0}
        nested_files = 0
        for name, entry in entries.items():
            member, stream = by_name[name]
            digest, size = hashlib.sha256(), 0
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk: break
                size += len(chunk); digest.update(chunk)
            if size != entry["size"] or digest.hexdigest() != entry["sha256"]:
                raise ValueError("checksum_mismatch")
            if name.endswith(".dump"):
                if not SAFE_DB.fullmatch(name): raise ValueError("unsupported_database_name")
                kinds["databaseDumps"] += 1
            elif name.endswith(".tar"):
                kinds["dataArchives"] += 1
                nested_files += inspect_nested_tar(tf.extractfile(member))
            elif name.endswith(".bundle"):
                kinds["vaultBundles"] += 1
            elif name == "globals.sql":
                kinds["otherFiles"] += 1
            else:
                raise ValueError("unsupported_archive_file")
        if "lares_state.dump" not in entries or kinds["databaseDumps"] < 2 or "globals.sql" not in entries:
            raise ValueError("incomplete_export")
        print(json.dumps({"engineVersion": manifest["engineVersion"], "date": manifest["date"],
                          "verifiedFiles": len(entries), "kinds": kinds, "nestedRegularFiles": nested_files}))
except Exception as exc:
    reason = str(exc) if str(exc) in {"unsafe_path", "secret_path", "unsafe_archive_entry", "duplicate_archive_path", "missing_manifest", "invalid_manifest", "manifest_file_set_mismatch", "checksum_mismatch", "unsupported_database_name", "unsupported_archive_file", "incomplete_export"} else "unreadable_archive"
    print(json.dumps({"error": reason}))
`;

export interface ArchiveInspection {
  engineVersion: string;
  date: string;
  verifiedFiles: number;
  kinds: { databaseDumps: number; dataArchives: number; vaultBundles: number; otherFiles: number };
  nestedRegularFiles: number;
}

export class ImportInspectionRefused extends Error {
  constructor(readonly reason: string) { super(`import preview inspection refused (${reason})`); }
}

export function inspectExportArchive(archivePath: string): ArchiveInspection {
  let result: unknown;
  try {
    const stdout = execFileSync("python3", ["-c", ARCHIVE_CHECK, archivePath], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    result = JSON.parse(stdout);
  } catch {
    throw new ImportInspectionRefused("unreadable_archive");
  }
  if (typeof result !== "object" || result === null || "error" in result) {
    const reason = typeof result === "object" && result !== null && "error" in result && typeof result.error === "string" ? result.error : "unreadable_archive";
    throw new ImportInspectionRefused(reason);
  }
  return result as ArchiveInspection;
}

export function verifySourceLedger(copyOutput: string): void {
  const rows = new Map<string, string>();
  const lines = copyOutput.replace(/\r/g, "").split("\n");
  let columns: string[] | undefined;
  let checksumColumn = -1;
  let filenameColumn = -1;
  let foundCopy = false;
  for (const line of lines) {
    if (!foundCopy) {
      const match = /^COPY (?:public\.)?schema_migrations \(([^)]+)\) FROM stdin;$/.exec(line);
      if (!match) continue;
      columns = match[1]!.split(/,\s*/);
      checksumColumn = columns.indexOf("checksum");
      filenameColumn = columns.indexOf("filename");
      if (checksumColumn < 0 || filenameColumn < 0) throw new ImportInspectionRefused("source_schema_mismatch");
      foundCopy = true;
      continue;
    }
    if (line === "\\.") break;
    const cells = line.split("\t");
    const name = cells[filenameColumn];
    const checksum = cells[checksumColumn];
    if (!name || !checksum || !/^[0-9a-f]{64}$/.test(checksum) || rows.has(name)) {
      throw new ImportInspectionRefused("source_schema_mismatch");
    }
    rows.set(name, checksum);
  }
  if (!foundCopy || rows.size !== EXPECTED_MIGRATIONS.length) throw new ImportInspectionRefused("source_schema_mismatch");
  for (const [filename, checksum] of EXPECTED_MIGRATIONS) {
    if (rows.get(filename) !== checksum) throw new ImportInspectionRefused("source_schema_mismatch");
  }
}

export function buildInspection(archive: ArchiveInspection) {
  if (archive.engineVersion !== SOURCE_RELEASE) throw new ImportInspectionRefused("unsupported_source_release");
  return {
    format: "lares.import-inspection",
    inspectionVersion: 1,
    status: "inspection-only",
    importReadiness: "blocked",
    source: { release: SOURCE_RELEASE, schema: "verified-from-lares_state-schema_migrations" },
    destination: { schema: DESTINATION_SCHEMA },
    archive: {
      checksumStatus: "verified",
      verifiedFiles: archive.verifiedFiles,
      databaseDumpCount: archive.kinds.databaseDumps,
      dataArchiveCount: archive.kinds.dataArchives,
      vaultBundleCount: archive.kinds.vaultBundles,
      nestedRegularFileCount: archive.nestedRegularFiles,
    },
    categories: IMPORT_CATEGORIES.map((category) => ({
      category,
      status: "not-inventoried",
      count: null,
      checksum: null,
      reason: "The complete record and resource mapper is PR1b; no category count is inferred from archive file counts.",
    })),
    blockers: [
      "PR1a verifies the supported source archive and Box schema only; it does not inventory application records or file resources.",
      "PR1b must map every application category, selection, stable identity, provenance, dependency, and omission before an ImportManifest v1 can be produced.",
    ],
  } as const;
}

function main(args: string[]): void {
  const checkOnly = args.length === 2 && args[0] === "--check-archive";
  if (!checkOnly && (args.length !== 4 || args[0] !== "--archive" || args[2] !== "--ledger-copy")) {
    process.stderr.write("Usage: import-preview.ts --check-archive <archive.tar> | --archive <archive.tar> --ledger-copy <schema-migrations-copy.txt>\n");
    process.exitCode = 64;
    return;
  }
  try {
    const archive = inspectExportArchive(args[1]!);
    if (checkOnly) {
      if (archive.engineVersion !== SOURCE_RELEASE) throw new ImportInspectionRefused("unsupported_source_release");
      process.stdout.write('{"status":"archive-verified","importReadiness":"blocked"}\n');
      return;
    }
    verifySourceLedger(readFileSync(args[3]!, "utf8"));
    const inspection = buildInspection(archive);
    process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
  } catch (error) {
    const reason = error instanceof ImportInspectionRefused ? error.reason : "inspection_failed";
    process.stderr.write(`lares import-preview: refused (${reason}); no import data was written.\n`);
    process.exitCode = 78;
  }
}

if (process.argv[1]?.endsWith("import-preview.ts")) main(process.argv.slice(2));
