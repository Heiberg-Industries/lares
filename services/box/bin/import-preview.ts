#!/usr/bin/env node
/**
 * PR1a: inspect the real installation export without applying it.
 *
 * This is deliberately an inspection result, not an ImportManifest/ImportReceipt. The bounded
 * members evidence does not cover the remaining application categories or file stores.
 */
import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IMPORT_CATEGORIES, memberSchema } from "@lares/agent-kit/authority-contract";

const SOURCE_RELEASE = "2026-10-21-rc.12";
const INSPECTION_CHECKS = [
  "toc_too_large", "toc_encoding_invalid", "toc_archive_header_missing", "toc_selection_header_missing",
  "toc_entry_format_invalid", "toc_tokenization_failed", "toc_entry_tokens_empty", "toc_security_wrapper_invalid",
  "toc_comment_acl_wrapper_invalid", "toc_wrapped_object_missing", "toc_wrapped_schema_invalid",
  "toc_schema_declaration_invalid", "toc_default_acl_invalid", "toc_namespace_object_incomplete",
  "toc_global_object_invalid", "toc_object_type_unsupported", "toc_schema_identifier_invalid",
  "toc_explicit_schema_duplicate", "toc_entries_missing", "parser_internal_failure",
  "toc_read_failed", "parser_unavailable", "parser_launch_failed", "parser_output_limit", "parser_signaled",
  "parser_exit_unclassified", "parser_output_json_invalid", "parser_output_shape_invalid",
  "parser_schema_value_invalid", "parser_schema_order_invalid", "schema_list_mismatch",
] as const;
type InspectionCheck = typeof INSPECTION_CHECKS[number];
const PARSER_INSPECTION_CHECKS = new Set<string>(INSPECTION_CHECKS.slice(0, 20));
const DESTINATION_SCHEMA = "rc.13@ec0c6cd8b2a2072d0cf066c1192c8d46787f2134";
const EXPECTED_MIGRATIONS = [
  ["001_baseline.sql", "a2a50ac42a53b25ba28faf41e8b8970354292f131e0e673cb7cc2a0001fa725a"],
  ["002_standing_facts.sql", "8d1abbab5d997af30f185454aac3a46407bc6d96fde2f555065522fd0df7b58a"],
  ["003_outside_tool_seen.sql", "a7a43c6ae74466e398935afac6ec379f39ee2ccdf7d4ca8e78b2cdc482949cfa"],
  ["004_web_inbox.sql", "56c5e04433aa350c9ed7bbed4d7aa0eb533d910f921cba2fe526183ac262dd0b"],
  ["005_model_steps.sql", "e1ecab54f9c18c63b057f7970c70fa835ebeb0e09381b6295c4f64a20a91be66"],
  ["006_approval_session.sql", "2de295f5c742a004addeb28579d579865bb7832a5d5287be742d0e2e7944827b"],
] as const;

const MEMBER_TABLES = {
  users: ["id", "display_name", "primary_email", "created_at", "org_id", "org_role"],
  orgs: ["id", "display_name", "created_at", "domains"],
  org_member_policy: ["user_id", "allowed_capabilities", "may_create_agents", "spend_cap_usd_month"],
  user_aliases: ["system", "alias", "user_id", "created_at"],
} as const;
type MemberTable = keyof typeof MEMBER_TABLES;
const MAX_COPY_BYTES = 8 * 1024 * 1024;
const MAX_COPY_LINE_BYTES = 64 * 1024;
const MAX_COPY_ROWS = 100_000;
// Fixed for the known public-schema dump contract. REL_16_STABLE pg_backup_archiver.c emits
// this setup in order; archived search_path values are never parsed or executed here.
const RESTORE_SETUP = [
  "SET statement_timeout = 0;",
  "SET lock_timeout = 0;",
  "SET idle_in_transaction_session_timeout = 0;",
  "SET client_encoding = 'UTF8';",
  "SET standard_conforming_strings = on;",
  "SELECT pg_catalog.set_config('search_path', '', false);",
  "SET check_function_bodies = false;",
  "SET xmloption = content;",
  "SET client_min_messages = warning;",
  "SET row_security = off;",
] as const;
const MAX_MEMBER_MAP_BYTES = 1024 * 1024;
const memberId = memberSchema.shape.id;

type CopyTable = { count: number; checksum: string; ids: string[]; references: string[]; aliasKeys: string[] };

function decodeCopyField(field: string): string | null {
  if (field === "\\N") return null;
  const bytes: number[] = [];
  for (let i = 0; i < field.length; i++) {
    const char = field[i]!;
    if (char !== "\\") {
      const encoded = Buffer.from(char, "utf8");
      for (const byte of encoded) bytes.push(byte);
      continue;
    }
    const next = field[++i];
    if (next === undefined) throw new ImportInspectionRefused("malformed_copy_data");
    if (next === "b") bytes.push(8);
    else if (next === "f") bytes.push(12);
    else if (next === "n") bytes.push(10);
    else if (next === "r") bytes.push(13);
    else if (next === "t") bytes.push(9);
    else if (next === "v") bytes.push(11);
    else if (next === "\\") bytes.push(92);
    else if (next === "x") {
      const digits = /^[0-9a-fA-F]{1,2}/.exec(field.slice(i + 1))?.[0];
      if (!digits) throw new ImportInspectionRefused("malformed_copy_data");
      bytes.push(Number.parseInt(digits, 16));
      i += digits.length;
    } else if (/[0-7]/.test(next)) {
      const digits = next + (/^[0-7]{0,2}/.exec(field.slice(i + 1))?.[0] ?? "");
      bytes.push(Number.parseInt(digits, 8));
      i += digits.length - 1;
    } else throw new ImportInspectionRefused("malformed_copy_data");
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)); }
  catch { throw new ImportInspectionRefused("malformed_copy_data"); }
}

function parseMemberCopy(table: MemberTable, bytes: Buffer): CopyTable {
  if (bytes.byteLength > MAX_COPY_BYTES) throw new ImportInspectionRefused("copy_data_too_large");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ImportInspectionRefused("malformed_copy_data"); }
  const lines = text.split("\n");
  const expectedHeader = `COPY public.${table} (${MEMBER_TABLES[table].join(", ")}) FROM stdin;`;
  let header = -1;
  let restriction: string | undefined;
  let setupIndex = 0;
  let setupStarted = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (line === expectedHeader) {
      if (setupStarted && setupIndex !== RESTORE_SETUP.length) throw new ImportInspectionRefused("member_copy_envelope_invalid");
      header = i; break;
    }
    if (line === "" || line.startsWith("--")) continue;
    const restrictionMatch = /^\\restrict ([A-Za-z0-9]{63})$/.exec(line);
    if (!setupStarted && !restriction && restrictionMatch) { restriction = restrictionMatch[1]; continue; }
    if (setupIndex < RESTORE_SETUP.length && line === RESTORE_SETUP[setupIndex]) {
      setupStarted = true;
      setupIndex++;
      continue;
    }
    throw new ImportInspectionRefused("member_copy_envelope_invalid");
  }
  if (header < 0) throw new ImportInspectionRefused("source_table_missing_or_unsupported");
  const columns = MEMBER_TABLES[table];
  const index = (name: string): number => columns.indexOf(name as never);
  const hash = createHash("sha256");
  const ids: string[] = [];
  const idSet = new Set<string>();
  const references: string[] = [];
  const aliasKeys: string[] = [];
  const aliasSet = new Set<string>();
  let ended = false;
  let unrestricted = false;
  let count = 0;
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (Buffer.byteLength(line, "utf8") > MAX_COPY_LINE_BYTES) throw new ImportInspectionRefused("copy_row_too_large");
    if (line === "\\.") { if (ended) throw new ImportInspectionRefused("member_copy_envelope_invalid"); ended = true; continue; }
    if (ended) {
      if (restriction && !unrestricted && line === `\\unrestrict ${restriction}`) { unrestricted = true; continue; }
      if (line !== "" && !line.startsWith("--")) throw new ImportInspectionRefused("member_copy_envelope_invalid");
      continue;
    }
    if (line.startsWith("\\unrestrict") || /^\\restrict\b/.test(line)) throw new ImportInspectionRefused("member_copy_envelope_invalid");
    const fields = line.split("\t");
    if (fields.length !== columns.length) throw new ImportInspectionRefused("malformed_copy_data");
    hash.update(line, "utf8"); hash.update("\n");
    if (++count > MAX_COPY_ROWS) throw new ImportInspectionRefused("copy_row_limit_exceeded");
    const get = (column: string): string | null => decodeCopyField(fields[index(column)]!);
    if (table === "users" || table === "orgs") {
      const id = get("id");
      if (id === null || memberId.safeParse(id).data !== id || idSet.has(id)) throw new ImportInspectionRefused("invalid_or_duplicate_source_id");
      ids.push(id); idSet.add(id);
      if (table === "users") {
        const organisation = get("org_id");
        if (organisation === null || memberId.safeParse(organisation).data !== organisation) throw new ImportInspectionRefused("unresolved_member_organisation");
        references.push(organisation);
      }
    } else if (table === "org_member_policy") {
      const id = get("user_id");
      if (id === null || memberId.safeParse(id).data !== id || idSet.has(id)) throw new ImportInspectionRefused("invalid_or_duplicate_source_reference");
      ids.push(id); idSet.add(id);
    } else {
      const system = get("system"), alias = get("alias"), id = get("user_id");
      if (system === null || alias === null || id === null || memberId.safeParse(id).data !== id) throw new ImportInspectionRefused("invalid_source_alias_reference");
      const key = JSON.stringify([system, alias]);
      if (aliasSet.has(key)) throw new ImportInspectionRefused("duplicate_source_alias");
      aliasSet.add(key); aliasKeys.push(key); ids.push(id);
    }
  }
  if (!ended) throw new ImportInspectionRefused("malformed_copy_data");
  if (restriction && !unrestricted) throw new ImportInspectionRefused("member_copy_envelope_invalid");
  return { count, checksum: hash.digest("hex"), ids, references, aliasKeys };
}

export function mapMemberEvidence(copies: Record<MemberTable, Buffer>, mapInput?: unknown) {
  const parsed = Object.fromEntries(Object.keys(MEMBER_TABLES).map((table) => [table, parseMemberCopy(table as MemberTable, copies[table as MemberTable])])) as Record<MemberTable, CopyTable>;
  const userIds = parsed.users.ids;
  const organisationIds = parsed.orgs.ids;
  const userSet = new Set(userIds), orgSet = new Set(organisationIds);
  if (parsed.users.references.some((id) => !orgSet.has(id)) || parsed.org_member_policy.ids.some((id) => !userSet.has(id)) || parsed.user_aliases.ids.some((id) => !userSet.has(id))) {
    throw new ImportInspectionRefused("source_member_dependency_mismatch");
  }
  const input = mapInput === undefined ? { version: 1, members: [], organizations: [] } : mapInput;
  if (typeof input !== "object" || input === null || Object.keys(input).sort().join(",") !== "members,organizations,version" || (input as { version?: unknown }).version !== 1 || !Array.isArray((input as { members?: unknown }).members) || !Array.isArray((input as { organizations?: unknown }).organizations)) {
    throw new ImportInspectionRefused("member_map_invalid");
  }
  const parseEntries = (value: unknown, sources: Set<string>): Array<{ sourceId: string; destinationId: string }> => {
    if (!Array.isArray(value)) throw new ImportInspectionRefused("member_map_invalid");
    const result: Array<{ sourceId: string; destinationId: string }> = [];
    const sourceSeen = new Set<string>(), destinationSeen = new Set<string>();
    for (const item of value) {
      if (typeof item !== "object" || item === null || Object.keys(item).sort().join(",") !== "destinationId,sourceId") throw new ImportInspectionRefused("member_map_invalid");
      const sourceId = (item as { sourceId?: unknown }).sourceId, destinationId = (item as { destinationId?: unknown }).destinationId;
      if (typeof sourceId !== "string" || memberId.safeParse(sourceId).data !== sourceId || typeof destinationId !== "string" || memberId.safeParse(destinationId).data !== destinationId || !sources.has(sourceId) || sourceSeen.has(sourceId) || destinationSeen.has(destinationId)) {
        throw new ImportInspectionRefused("member_map_invalid");
      }
      sourceSeen.add(sourceId); destinationSeen.add(destinationId); result.push({ sourceId, destinationId });
    }
    return result;
  };
  const mappedMembers = parseEntries((input as { members: unknown }).members, userSet);
  const mappedOrganisations = parseEntries((input as { organizations: unknown }).organizations, orgSet);
  if (new Set([...mappedMembers.map((entry) => entry.destinationId), ...mappedOrganisations.map((entry) => entry.destinationId)]).size !== mappedMembers.length + mappedOrganisations.length) {
    throw new ImportInspectionRefused("member_map_invalid");
  }
  const memberMap = new Map(mappedMembers.map(({ sourceId, destinationId }) => [sourceId, destinationId]));
  const organisationMap = new Map(mappedOrganisations.map(({ sourceId, destinationId }) => [sourceId, destinationId]));
  const tableEvidence = (Object.keys(MEMBER_TABLES) as MemberTable[]).map((table) => ({ table, count: parsed[table].count, checksum: parsed[table].checksum }));
  const checksum = createHash("sha256").update(JSON.stringify(tableEvidence)).digest("hex");
  const complete = mappedMembers.length === userIds.length && mappedOrganisations.length === organisationIds.length;
  return {
    status: complete ? "inventoried" as const : "partially-inventoried" as const,
    count: userIds.length,
    checksum,
    sourceTables: tableEvidence,
    sourceMembers: userIds.map((sourceId) => ({ sourceId, destinationId: memberMap.get(sourceId) ?? null, provenance: "explicit-import-map" as const })),
    sourceOrganisations: organisationIds.map((sourceId) => ({ sourceId, destinationId: organisationMap.get(sourceId) ?? null, provenance: "explicit-import-map" as const })),
    unresolvedMemberIds: userIds.filter((id) => !memberMap.has(id)),
    unresolvedOrganisationIds: organisationIds.filter((id) => !organisationMap.has(id)),
    dependencies: { userOrganisationReferences: parsed.users.references.length, policyMemberReferences: parsed.org_member_policy.ids.length, aliasMemberReferences: parsed.user_aliases.ids.length, allReferencesResolved: true },
    authority: "mapping-evidence-only; destination existence and authority are not verified",
    omissions: [
      "org_member_policy values are inventoried as historical evidence and are not applied as grants or capabilities",
      "user_aliases values are inventoried as historical evidence and do not verify a provider identity",
    ],
  };
}

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
        if isinstance(manifest, dict) and ("inventoryVersion" not in manifest or "sourceInventory" not in manifest):
            raise ValueError("legacy_manifest_without_inventory")
        if not isinstance(manifest, dict) or set(manifest) != {"engineVersion", "date", "inventoryVersion", "files", "sourceInventory"}:
            raise ValueError("invalid_manifest")
        if manifest["inventoryVersion"] != 1:
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
        inventory = manifest["sourceInventory"]
        if not isinstance(inventory, dict) or set(inventory) != {"databaseCoverage", "databases", "dataRoots", "dataSelection", "absentDataRoots", "vaultRepositories", "vaultSelection", "supportFiles", "protectedMaterial", "unverified"}:
            raise ValueError("invalid_source_inventory")
        if inventory["databaseCoverage"] != "all-nontemplate-databases" or not isinstance(inventory["databases"], list):
            raise ValueError("invalid_source_inventory")
        db_names, db_members = set(), set()
        for item in inventory["databases"]:
            if not isinstance(item, dict) or set(item) != {"name", "member", "sha256", "schemas"}:
                raise ValueError("invalid_source_inventory")
            if not isinstance(item["name"], str) or not re.fullmatch(r"[A-Za-z0-9_-]+", item["name"]):
                raise ValueError("invalid_source_inventory")
            member = safe_name(item["member"])
            schemas = item["schemas"]
            if (member != item["name"] + ".dump" or member not in entries or entries[member]["sha256"] != item["sha256"] or
                not isinstance(schemas, list) or
                any(not isinstance(schema, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*", schema) for schema in schemas) or
                schemas != sorted(set(schemas)) or item["name"] in db_names):
                raise ValueError("invalid_source_inventory")
            db_names.add(item["name"]); db_members.add(member)
        if "lares_state" not in db_names or db_members != {name for name in entries if name.endswith(".dump")}:
            raise ValueError("source_inventory_mismatch")

        def validate_stores(key, suffix):
            records = inventory[key]
            if not isinstance(records, list): raise ValueError("invalid_source_inventory")
            members = set()
            for item in records:
                if not isinstance(item, dict) or set(item) != {"storeKind", "disposition", "member", "sha256"}:
                    raise ValueError("invalid_source_inventory")
                member = safe_name(item["member"])
                if (not isinstance(item["storeKind"], str) or not re.fullmatch(r"[a-z][a-z0-9-]*", item["storeKind"]) or
                    item["disposition"] != "included" or not member.endswith(suffix) or member not in entries or
                    entries[member]["sha256"] != item["sha256"] or member in members):
                    raise ValueError("invalid_source_inventory")
                members.add(member)
            if members != {name for name in entries if name.endswith(suffix)}:
                raise ValueError("source_inventory_mismatch")
            return members
        data_members = validate_stores("dataRoots", ".tar")
        vault_members = validate_stores("vaultRepositories", ".bundle")
        if inventory["dataSelection"] != ("configured" if data_members else "configured-empty"):
            raise ValueError("invalid_source_inventory")
        if not isinstance(inventory["absentDataRoots"], list): raise ValueError("invalid_source_inventory")
        absent = set()
        for item in inventory["absentDataRoots"]:
            if not isinstance(item, dict) or set(item) != {"storeKind", "disposition"} or item["disposition"] != "absent" or not isinstance(item["storeKind"], str) or not re.fullmatch(r"[a-z][a-z0-9-]*", item["storeKind"]) or item["storeKind"] in absent:
                raise ValueError("invalid_source_inventory")
            absent.add(item["storeKind"])
        if inventory["vaultSelection"] != ("configured" if vault_members else "configured-empty"):
            raise ValueError("invalid_source_inventory")
        support = inventory["supportFiles"]
        if (not isinstance(support, list) or len(support) != 1 or not isinstance(support[0], dict) or
            set(support[0]) != {"kind", "member", "sha256"} or support[0]["kind"] != "postgres-roles-without-passwords" or
            support[0]["member"] != "globals.sql" or "globals.sql" not in entries or entries["globals.sql"]["sha256"] != support[0]["sha256"]):
            raise ValueError("invalid_source_inventory")
        protected = inventory["protectedMaterial"]
        if (not isinstance(protected, dict) or protected != {"credentialFiles": "excluded", "encryptedDatabaseCredentials": "may-be-present", "ordinaryImport": "blocked"}):
            raise ValueError("invalid_source_inventory")
        if inventory["unverified"] != ["stores outside the configured export paths", "database table and row contents beyond the declared schema names", "source-version compatibility and identity mappings"]:
            raise ValueError("invalid_source_inventory")
        if db_members | data_members | vault_members | {"globals.sql"} != set(entries):
            raise ValueError("source_inventory_mismatch")
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
                          "verifiedFiles": len(entries), "kinds": kinds, "nestedRegularFiles": nested_files,
                          "sourceInventory": inventory}))
except Exception as exc:
    reason = str(exc) if str(exc) in {"unsafe_path", "secret_path", "unsafe_archive_entry", "duplicate_archive_path", "missing_manifest", "invalid_manifest", "legacy_manifest_without_inventory", "invalid_source_inventory", "source_inventory_mismatch", "manifest_file_set_mismatch", "checksum_mismatch", "unsupported_database_name", "unsupported_archive_file", "incomplete_export"} else "unreadable_archive"
    print(json.dumps({"error": reason}))
`;

export interface ArchiveInspection {
  engineVersion: string;
  date: string;
  verifiedFiles: number;
  kinds: { databaseDumps: number; dataArchives: number; vaultBundles: number; otherFiles: number };
  nestedRegularFiles: number;
  sourceInventory: {
    databases: Array<{ name: string; member: string; sha256: string; schemas: string[] }>;
    dataRoots: Array<{ storeKind: string; disposition: "included"; member: string; sha256: string }>;
    absentDataRoots: Array<{ storeKind: string; disposition: "absent" }>;
    vaultRepositories: Array<{ storeKind: string; disposition: "included"; member: string; sha256: string }>;
    protectedMaterial: { credentialFiles: "excluded"; encryptedDatabaseCredentials: "may-be-present"; ordinaryImport: "blocked" };
  };
}

export class ImportInspectionRefused extends Error {
  constructor(readonly reason: string, readonly inspectionCheck: InspectionCheck | null = null) { super(`import preview inspection refused (${reason})`); }
}

export function inspectExportArchive(archivePath: string): ArchiveInspection {
  let result: unknown;
  try {
    const stdout = childProcess.execFileSync("python3", ["-c", ARCHIVE_CHECK, archivePath], { encoding: "utf8", maxBuffer: 1024 * 1024 });
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

function isInspectionCheck(value: unknown): value is InspectionCheck {
  return typeof value === "string" && INSPECTION_CHECKS.includes(value as InspectionCheck);
}

function parserFailureCheck(stdout: unknown): InspectionCheck {
  if (typeof stdout !== "string" && !Buffer.isBuffer(stdout)) return "parser_output_json_invalid";
  const output = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : stdout;
  if (Buffer.byteLength(output, "utf8") > 64 * 1024) return "parser_output_limit";
  let parsed: unknown;
  try { parsed = JSON.parse(output); }
  catch { return "parser_output_json_invalid"; }
  if (typeof parsed !== "object" || parsed === null || Object.keys(parsed).length !== 2 ||
      (parsed as { error?: unknown }).error !== "unsupported_schema_metadata" ||
      !("inspectionCheck" in parsed)) return "parser_output_shape_invalid";
  const check = (parsed as { inspectionCheck: unknown }).inspectionCheck;
  return typeof check === "string" && PARSER_INSPECTION_CHECKS.has(check)
    ? check as InspectionCheck : "parser_exit_unclassified";
}

export function parseDatabaseSchemas(toc: Buffer): string[] {
  const refuse = (inspectionCheck: InspectionCheck): never => {
    throw new ImportInspectionRefused("source_schema_inventory_mismatch", inspectionCheck);
  };
  if (toc.byteLength > 256 * 1024) refuse("toc_too_large");
  let parser: string;
  try {
    parser = fileURLToPath(new URL("../ops/pg-restore-list-schemas.py", import.meta.url));
  } catch {
    return refuse("parser_unavailable");
  }
  let output: string;
  try {
    output = childProcess.execFileSync("python3", [parser], { input: toc, encoding: "utf8", maxBuffer: 64 * 1024 });
  } catch (error) {
    const failure = error as { code?: unknown; signal?: unknown; status?: unknown; stdout?: unknown };
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return refuse("parser_output_limit");
    if (typeof failure.signal === "string") return refuse("parser_signaled");
    if (failure.code === "ENOENT") return refuse("parser_unavailable");
    if (typeof failure.status === "number") return refuse(parserFailureCheck(failure.stdout));
    return refuse("parser_launch_failed");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(output); }
  catch { return refuse("parser_output_json_invalid"); }
  if (typeof parsed !== "object" || parsed === null || Object.keys(parsed).length !== 1 ||
      !Array.isArray((parsed as { schemas?: unknown }).schemas)) return refuse("parser_output_shape_invalid");
  const schemas = (parsed as { schemas: unknown[] }).schemas;
  if (schemas.some((schema) => typeof schema !== "string" || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema))) {
    return refuse("parser_schema_value_invalid");
  }
  if (JSON.stringify(schemas) !== JSON.stringify([...new Set(schemas)].sort())) return refuse("parser_schema_order_invalid");
  return schemas as string[];
}

export function verifyDatabaseSchemas(archive: ArchiveInspection, tocDirectory: string): void {
  for (const database of archive.sourceInventory.databases) {
    let toc: Buffer;
    try {
      toc = readFileSync(`${tocDirectory}/${database.name}.toc`);
    } catch {
      throw new ImportInspectionRefused("source_schema_inventory_mismatch", "toc_read_failed");
    }
    if (JSON.stringify(parseDatabaseSchemas(toc)) !== JSON.stringify(database.schemas)) {
      throw new ImportInspectionRefused("source_schema_inventory_mismatch", "schema_list_mismatch");
    }
  }
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

export function buildInspection(archive: ArchiveInspection, memberEvidence?: ReturnType<typeof mapMemberEvidence>) {
  if (archive.engineVersion !== SOURCE_RELEASE) throw new ImportInspectionRefused("unsupported_source_release");
  const sourceDumpChecksum = archive.sourceInventory.databases.find((database) => database.name === "lares_state")?.sha256;
  if (memberEvidence !== undefined && sourceDumpChecksum === undefined) throw new ImportInspectionRefused("source_schema_inventory_mismatch");
  const memberChecksum = memberEvidence === undefined ? undefined : createHash("sha256").update(JSON.stringify({
    sourceRelease: SOURCE_RELEASE,
    destinationSchema: DESTINATION_SCHEMA,
    sourceDumpChecksum,
    tables: memberEvidence.sourceTables,
  })).digest("hex");
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
    categories: IMPORT_CATEGORIES.map((category) => category === "members" && memberEvidence !== undefined ? {
      category,
      status: memberEvidence.status,
      count: memberEvidence.count,
      checksum: memberChecksum!,
      sourceDumpChecksum,
      sourceTables: memberEvidence.sourceTables,
      sourceMembers: memberEvidence.sourceMembers,
      sourceOrganisations: memberEvidence.sourceOrganisations,
      unresolvedMemberIds: memberEvidence.unresolvedMemberIds,
      unresolvedOrganisationIds: memberEvidence.unresolvedOrganisationIds,
      dependencies: memberEvidence.dependencies,
      authority: memberEvidence.authority,
      omissions: memberEvidence.omissions,
      reason: memberEvidence.status === "inventoried" ? "Source rows are fully counted and explicitly mapped; destination existence and authority remain unverified." : "Source rows are counted, but explicit member or organisation mappings are incomplete.",
    } : {
      category,
      status: "not-inventoried",
      count: null,
      checksum: null,
      reason: "The record mapper is incomplete; no category count is inferred from archive file counts.",
    }),
    sourceInventory: archive.sourceInventory,
    blockers: [
      "This slice does not inventory individual file resources or all configured storage outside the export's declared paths.",
      "Encrypted database credentials may be present and remain blocked from ordinary import; a separate protected transfer or reconnection decision is still required.",
      "The other 21 application categories, and their identity, provenance, dependency, and omission mappings, still need record-level mapping before an ImportManifest v1 can be produced.",
    ],
  } as const;
}

function readMemberCopies(directory: string): Record<MemberTable, Buffer> {
  const copies = {} as Record<MemberTable, Buffer>;
  for (const table of Object.keys(MEMBER_TABLES) as MemberTable[]) {
    const path = `${directory}/${table}.copy`;
    try {
      const size = statSync(path).size;
      if (size < 1 || size > MAX_COPY_BYTES) throw new ImportInspectionRefused("copy_data_too_large");
      copies[table] = readFileSync(path);
    } catch (error) {
      if (error instanceof ImportInspectionRefused) throw error;
      throw new ImportInspectionRefused("source_table_missing_or_unsupported");
    }
  }
  return copies;
}

function readMemberMap(path: string | undefined): unknown {
  if (path === undefined) return undefined;
  try {
    const size = statSync(path).size;
    if (size < 1 || size > MAX_MEMBER_MAP_BYTES) throw new ImportInspectionRefused("member_map_invalid");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof ImportInspectionRefused) throw error;
    throw new ImportInspectionRefused("member_map_invalid");
  }
}

function main(args: string[]): void {
  const checkOnly = args.length === 2 && args[0] === "--check-archive";
  const options = !checkOnly && (args.length === 8 || args.length === 10) && args[0] === "--archive" && args[2] === "--ledger-copy" && args[4] === "--database-toc-dir" && args[6] === "--copy-directory" && (args.length === 8 || args[8] === "--member-map")
    ? { archive: args[1]!, ledger: args[3]!, tocDirectory: args[5]!, copyDirectory: args[7]!, memberMapPath: args[9] }
    : null;
  if (!checkOnly && options === null) {
    process.stderr.write("Usage: import-preview.ts --check-archive <archive.tar> | --archive <archive.tar> --ledger-copy <file> --database-toc-dir <dir> --copy-directory <dir> [--member-map <file>]\n");
    process.exitCode = 64;
    return;
  }
  try {
    const archive = inspectExportArchive(checkOnly ? args[1]! : options!.archive);
    if (checkOnly) {
      if (archive.engineVersion !== SOURCE_RELEASE) throw new ImportInspectionRefused("unsupported_source_release");
      process.stdout.write('{"status":"archive-verified","importReadiness":"blocked"}\n');
      return;
    }
    verifySourceLedger(readFileSync(options!.ledger, "utf8"));
    verifyDatabaseSchemas(archive, options!.tocDirectory);
    const members = mapMemberEvidence(readMemberCopies(options!.copyDirectory), readMemberMap(options!.memberMapPath));
    const inspection = buildInspection(archive, members);
    process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
  } catch (error) {
    const reason = error instanceof ImportInspectionRefused ? error.reason : "inspection_failed";
    process.stderr.write(`lares import-preview: refused (${reason}); no import data was written.\n`);
    if (error instanceof ImportInspectionRefused && error.inspectionCheck !== null) {
      process.stderr.write(`lares import-preview inspectionCheck=${error.inspectionCheck}\n`);
    }
    process.exitCode = 78;
  }
}

if (process.argv[1]?.endsWith("import-preview.ts")) main(process.argv.slice(2));
