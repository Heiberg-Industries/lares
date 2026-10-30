import { afterEach, describe, expect, it, vi } from "vitest";
const childProcessFixture = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      if (childProcessFixture.error !== null) throw childProcessFixture.error;
      return Reflect.apply(actual.execFileSync, actual, args);
    },
  };
});
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ImportInspectionRefused,
  buildInspection,
  inspectExportArchive,
  mapMemberEvidence,
  verifySourceLedger,
  verifyDatabaseSchemas,
  parseDatabaseSchemas,
} from "../bin/import-preview.js";
import { IMPORT_CATEGORIES } from "@lares/agent-kit/authority-contract";

const copy = (table: string, columns: string, rows: string[]): Buffer => Buffer.from(
  `COPY public.${table} (${columns}) FROM stdin;\n${rows.join("\n")}\n\\.\n`, "utf8",
);
const framed = (source: Buffer, key = "A".repeat(63)): Buffer => Buffer.concat([
  Buffer.from(`\\restrict ${key}\nSET statement_timeout = 0;\nSET lock_timeout = 0;\nSET idle_in_transaction_session_timeout = 0;\nSET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\nSELECT pg_catalog.set_config('search_path', '', false);\nSET check_function_bodies = false;\nSET xmloption = content;\nSET client_min_messages = warning;\nSET row_security = off;\n\n`),
  source,
  Buffer.from(`\\unrestrict ${key}\n`),
]);
const memberCopies = () => ({
  users: copy("users", "id, display_name, primary_email, created_at, org_id, org_role", [
    "member-a\tPRIVATE_NAME_SENTINEL\tprivate@example.invalid\t2026-10-21 00:00:00+00\torg-a\towner",
    "member-b\tSecond\\nPrivate Name\t\\N\t2026-10-21 00:00:00+00\torg-a\tmember",
  ]),
  orgs: copy("orgs", "id, display_name, created_at, domains", [
    "org-a\tPRIVATE_ORG_LABEL_SENTINEL\t2026-10-21 00:00:00+00\t{example.invalid}",
  ]),
  org_member_policy: copy("org_member_policy", "user_id, allowed_capabilities, may_create_agents, spend_cap_usd_month", [
    "member-a\t{agent:read,agent:write}\tt\t25.00",
  ]),
  user_aliases: copy("user_aliases", "system, alias, user_id, created_at", [
    "legacy-system\tPRIVATE_ALIAS\\tSENTINEL\tmember-a\t2026-10-21 00:00:00+00",
  ]),
});

const roots: string[] = [];
function fixtureArchive(options: { badChecksum?: boolean; badInventory?: boolean; legacy?: boolean; nestedName?: string; source?: string; oversizedManifest?: boolean; schemas?: string[] } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "import-preview-"));
  roots.push(root);
  const archive = join(root, "export.tar");
  const script = String.raw`
import hashlib, io, json, sys, tarfile
root, archive, bad, nested_name, source, oversized, bad_inventory, legacy, schemas_json = sys.argv[1:]
schemas = json.loads(schemas_json)
files = {
  "globals.sql": b"-- fixture globals without password material\n",
  "lares_state.dump": b"synthetic custom database dump",
  "postgres.dump": b"synthetic postgres dump",
}
nested = io.BytesIO()
with tarfile.open(fileobj=nested, mode="w") as tf:
    directory = tarfile.TarInfo("agents/example/")
    directory.type = tarfile.DIRTYPE
    tf.addfile(directory)
    content = b"synthetic agent definition\n"
    info = tarfile.TarInfo(nested_name)
    info.size = len(content)
    tf.addfile(info, io.BytesIO(content))
files["agents.tar"] = nested.getvalue()
manifest = {"engineVersion": source, "date": "x" * (1024 * 1024 + 1) if oversized == "yes" else "2026-10-21T00:00:00Z", "files": []}
for name, data in files.items():
    manifest["files"].append({"name": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
if bad == "yes": manifest["files"][0]["sha256"] = "0" * 64
if legacy != "yes":
    by_name = {entry["name"]: entry for entry in manifest["files"]}
    manifest["inventoryVersion"] = 1
    manifest["sourceInventory"] = {
        "databaseCoverage": "all-nontemplate-databases",
        "databases": [{"name": name, "member": name + ".dump", "sha256": by_name[name + ".dump"]["sha256"], "schemas": schemas} for name in ["lares_state", "postgres"]],
        "dataRoots": [{"storeKind": "agent-definitions", "disposition": "included", "member": "agents.tar", "sha256": by_name["agents.tar"]["sha256"]}],
        "dataSelection": "configured",
        "absentDataRoots": [{"storeKind": "installation-inventory", "disposition": "absent"}],
        "vaultRepositories": [], "vaultSelection": "configured-empty",
        "supportFiles": [{"kind": "postgres-roles-without-passwords", "member": "globals.sql", "sha256": by_name["globals.sql"]["sha256"]}],
        "protectedMaterial": {"credentialFiles": "excluded", "encryptedDatabaseCredentials": "may-be-present", "ordinaryImport": "blocked"},
        "unverified": ["stores outside the configured export paths", "database table and row contents beyond the declared schema names", "source-version compatibility and identity mappings"],
    }
    if bad_inventory == "yes": manifest["sourceInventory"]["dataRoots"] = []
with tarfile.open(archive, mode="w") as tf:
    payloads = {**files, "manifest.json": json.dumps(manifest).encode()}
    for name, data in payloads.items():
        info = tarfile.TarInfo("./" + name)
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
`;
  execFileSync("python3", ["-c", script, root, archive, options.badChecksum ? "yes" : "no", options.nestedName ?? "agents/example/agent.json", options.source ?? "2026-10-21-rc.12", options.oversizedManifest ? "yes" : "no", options.badInventory ? "yes" : "no", options.legacy ? "yes" : "no", JSON.stringify(options.schemas ?? ["public"])]);
  return archive;
}

function ledgerCopy(extra?: string): string {
  const checksums = [
    "a2a50ac42a53b25ba28faf41e8b8970354292f131e0e673cb7cc2a0001fa725a",
    "8d1abbab5d997af30f185454aac3a46407bc6d96fde2f555065522fd0df7b58a",
    "a7a43c6ae74466e398935afac6ec379f39ee2ccdf7d4ca8e78b2cdc482949cfa",
    "56c5e04433aa350c9ed7bbed4d7aa0eb533d910f921cba2fe526183ac262dd0b",
    "e1ecab54f9c18c63b057f7970c70fa835ebeb0e09381b6295c4f64a20a91be66",
    "2de295f5c742a004addeb28579d579865bb7832a5d5287be742d0e2e7944827b",
  ];
  const names = ["001_baseline.sql", "002_standing_facts.sql", "003_outside_tool_seen.sql", "004_web_inbox.sql", "005_model_steps.sql", "006_approval_session.sql"];
  return [
    "COPY public.schema_migrations (filename, number, checksum, applied_at, how, took_ms, seq) FROM stdin;",
    ...names.map((name, i) => `${name}\t${i + 1}\t${checksums[i]}\t2026-10-21 00:00:00+00\tapplied\t0\t${i + 1}`),
    ...(extra ? [extra] : []),
    "\\.",
  ].join("\n");
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function installedHarness(mode: "success" | "overflow" | "timeout" | "inspect" = "success") {
  const root = mkdtempSync(join(tmpdir(), "lares-cli-harness-"));
  roots.push(root);
  const prefix = join(root, "prefix");
  const release = join(prefix, "opt", "lares", "releases", "fixture");
  const current = join(prefix, "opt", "lares", "current");
  const ops = join(release, "services", "box", "ops");
  const bin = join(root, "bin");
  const privateTmp = join(root, "tmp");
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "ops");
  mkdirSync(ops, { recursive: true });
  mkdirSync(bin);
  mkdirSync(privateTmp);
  symlinkSync(release, current);
  copyFileSync(join(repo, "lares"), join(ops, "lares"));
  copyFileSync(join(repo, "engine-run.sh"), join(ops, "engine-run.sh"));
  writeFileSync(join(release, "release.json"), JSON.stringify({ images: { "lares-keeper": `example.invalid/keeper@sha256:${"a".repeat(64)}` } }));
  const idPath = join(bin, "id");
  writeFileSync(idPath, "#!/bin/sh\n[ \"$1\" = -u ] && { echo 0; exit 0; }\nexit 1\n");
  chmodSync(idPath, 0o755);
  const dockerPath = join(bin, "docker");
  writeFileSync(dockerPath, `#!/bin/bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
frame_copy() {
  file="$1"
  { printf '%s\\n' '\\restrict AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' 'SET statement_timeout = 0;' 'SET lock_timeout = 0;' 'SET idle_in_transaction_session_timeout = 0;' "SET client_encoding = 'UTF8';" 'SET standard_conforming_strings = on;' "SELECT pg_catalog.set_config('search_path', '', false);" 'SET check_function_bodies = false;' 'SET xmloption = content;' 'SET client_min_messages = warning;' 'SET row_security = off;' ''; cat "$file"; printf '%s\\n' '\\unrestrict AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; } > "$file.framed"
  mv "$file.framed" "$file"
}
case "$*" in
  *--pull=never*)
    case "$DOCKER_MODE" in
      timeout) exit 124 ;;
      overflow)
        for arg in "$@"; do case "$arg" in *:/output:rw) target="${'${arg%:/output:rw}'}"; printf 'RAW-LEDGER-SECRET%s' "$(python3 -c 'print("x" * 140000)')" > "$target/schema-migrations.copy";; esac; done
        ;;
      success|inspect)
        for arg in "$@"; do case "$arg" in *:/output:rw)
          target="${'${arg%:/output:rw}'}"
          printf '%s' "$LEDGER_PAYLOAD" > "$target/schema-migrations.copy"
          mkdir -p "$target/database-toc"
          printf '%b\n' 'COPY public.users (id, display_name, primary_email, created_at, org_id, org_role) FROM stdin;\nmember-a\tPRIVATE_NAME_SENTINEL\tprivate@example.invalid\t2026-10-21 00:00:00+00\torg-a\towner\n\\.' > "$target/users.copy"
          printf '%b\n' 'COPY public.orgs (id, display_name, created_at, domains) FROM stdin;\norg-a\tPRIVATE_ORG_LABEL_SENTINEL\t2026-10-21 00:00:00+00\t{example.invalid}\n\\.' > "$target/orgs.copy"
          printf '%b\n' 'COPY public.org_member_policy (user_id, allowed_capabilities, may_create_agents, spend_cap_usd_month) FROM stdin;\nmember-a\t{agent:write}\tt\t25.00\n\\.' > "$target/org_member_policy.copy"
          printf '%b\n' 'COPY public.user_aliases (system, alias, user_id, created_at) FROM stdin;\nlegacy\tPRIVATE_ALIAS_SENTINEL\tmember-a\t2026-10-21 00:00:00+00\n\\.' > "$target/user_aliases.copy"
          frame_copy "$target/users.copy"
          frame_copy "$target/orgs.copy"
          frame_copy "$target/org_member_policy.copy"
          frame_copy "$target/user_aliases.copy"
          printf '; Archive created at fixture\n; Selected TOC Entries:\n3; 1259 16385 TABLE public schema_migrations fixture_owner\n4; 0 0 TABLE DATA public schema_migrations fixture_owner\n' > "$target/database-toc/lares_state.toc"
          cp "$target/database-toc/lares_state.toc" "$target/database-toc/postgres.toc"
          ;;
        esac; done
        ;;
    esac
    ;;
esac
if [ "$DOCKER_MODE" = inspect ] || [ "$DOCKER_MODE" = success ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = /app/services/box/ops/unpack-engine.sh ]; then
      shift
      exec bash "$PREVIEW_UNPACK" "$@"
    fi
    if [ "$1" = /app/services/box/bin/import-preview.ts ]; then
      shift
      TMPDIR="$PREVIEW_RUNTIME_TMP" exec "$PREVIEW_NODE" --import tsx/esm "$PREVIEW_SCRIPT" "$@"
    fi
    shift
  done
fi
exit 0
`);
  chmodSync(dockerPath, 0o755);
  const timeoutPath = join(bin, "timeout");
  writeFileSync(timeoutPath, "#!/bin/bash\n[ \"$1\" = --signal=INT ] || exit 125\nshift\n[ \"$1\" = --kill-after=10 ] || exit 125\nshift\n[ \"$1\" = 120 ] || exit 125\nshift\nexec \"$@\"\n");
  chmodSync(timeoutPath, 0o755);
  return { root, prefix, bin, privateTmp, cli: join(ops, "lares"), dockerLog: join(root, "docker.log") };
}

describe("PR1a export archive inspection", () => {
  it("verifies a real export-shaped archive and reports every category as uninspected", () => {
    const archive = inspectExportArchive(fixtureArchive());
    expect(archive).toMatchObject({ verifiedFiles: 4, kinds: { databaseDumps: 2, dataArchives: 1, vaultBundles: 0, otherFiles: 1 }, nestedRegularFiles: 1 });
    verifySourceLedger(ledgerCopy());
    const result = buildInspection(archive);
    expect(result).toMatchObject({ format: "lares.import-inspection", status: "inspection-only", importReadiness: "blocked" });
    expect(result.categories.map((entry) => entry.category)).toEqual(IMPORT_CATEGORIES);
    expect(result.categories.every((entry) => entry.status === "not-inventoried" && entry.count === null && entry.checksum === null)).toBe(true);
    expect(result.format).not.toBe("lares.import-manifest");
  });

  it("refuses a checksum mismatch without printing archived content", () => {
    expect(() => inspectExportArchive(fixtureArchive({ badChecksum: true }))).toThrowError(
      new ImportInspectionRefused("checksum_mismatch"),
    );
  });

  it("bounds manifest reads using the tar header and refuses oversized manifests", () => {
    expect(() => inspectExportArchive(fixtureArchive({ oversizedManifest: true }))).toThrowError(
      new ImportInspectionRefused("invalid_manifest"),
    );
  });

  it("refuses traversal and secret-bearing nested ordinary archives", () => {
    expect(() => inspectExportArchive(fixtureArchive({ nestedName: "../escape.txt" }))).toThrowError(
      new ImportInspectionRefused("unsafe_path"),
    );
    expect(() => inspectExportArchive(fixtureArchive({ nestedName: "agents/example/.env" }))).toThrowError(
      new ImportInspectionRefused("secret_path"),
    );
  });

  it("refuses an unknown exporter version or a changed/extra migration ledger", () => {
    expect(() => buildInspection(inspectExportArchive(fixtureArchive({ source: "unknown" })))).toThrowError(
      new ImportInspectionRefused("unsupported_source_release"),
    );
    expect(() => verifySourceLedger(ledgerCopy("unexpected.sql\t7\t" + "a".repeat(64) + "\t2026\tadopted\t0\t7"))).toThrowError(
      new ImportInspectionRefused("source_schema_mismatch"),
    );
  });

  it("requires matching dump schema metadata and redacts a rejected ledger", () => {
    const archive = fixtureArchive();
    const root = dirname(archive);
    const ledgerPath = join(root, "schema-migrations.copy");
    const tocDir = join(root, "database-toc");
    const copyDir = join(root, "copies");
    mkdirSync(tocDir);
    mkdirSync(copyDir);
    for (const [table, content] of Object.entries(memberCopies())) writeFileSync(join(copyDir, `${table}.copy`), content);
    const toc = [
      "; Archive created at fixture", "; Selected TOC Entries:",
      "3; 2615 2200 SCHEMA - public fixture_owner",
      "4; 1259 16385 TABLE public notes fixture_owner",
      "5; 0 0 SEQUENCE OWNED BY public notes_id_seq notes_id fixture_owner",
      "6; 0 0 SEQUENCE SET public notes_id_seq fixture_owner",
      "7; 0 0 TABLE DATA public notes fixture_owner",
      "",
    ].join("\n");
    writeFileSync(join(tocDir, "lares_state.toc"), toc);
    writeFileSync(join(tocDir, "postgres.toc"), toc);
    const script = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "import-preview.ts");
    writeFileSync(ledgerPath, ledgerCopy());
    const accepted = spawnSync(process.execPath, ["--import", "tsx/esm", script, "--archive", archive, "--ledger-copy", ledgerPath, "--database-toc-dir", tocDir, "--copy-directory", copyDir], { encoding: "utf8" });
    expect(accepted.status, accepted.stderr).toBe(0);
    const result = JSON.parse(accepted.stdout);
    expect(result).toMatchObject({ format: "lares.import-inspection", status: "inspection-only", importReadiness: "blocked", sourceInventory: { databases: [{ name: "lares_state", schemas: ["public"] }, { name: "postgres", schemas: ["public"] }] } });
    expect(result.categories[0]).toMatchObject({ category: "members", status: "partially-inventoried", unresolvedMemberIds: ["member-a", "member-b"], unresolvedOrganisationIds: ["org-a"] });
    const parser = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", "pg-restore-list-schemas.py");
    const parsed = spawnSync("python3", [parser], { input: toc, encoding: "utf8" });
    expect(parsed.status, parsed.stdout).toBe(0);
    expect(JSON.parse(parsed.stdout)).toEqual({ schemas: ["public"] });

    writeFileSync(ledgerPath, "SECRET-LEDGER-SENTINEL");
    const refused = spawnSync(process.execPath, ["--import", "tsx/esm", script, "--archive", archive, "--ledger-copy", ledgerPath, "--database-toc-dir", tocDir, "--copy-directory", copyDir], { encoding: "utf8" });
    expect(refused.status).toBe(78);
    expect(refused.stderr).toContain("source_schema_mismatch");
    expect(refused.stderr).not.toContain("SECRET-LEDGER-SENTINEL");

    writeFileSync(ledgerPath, ledgerCopy());
    writeFileSync(join(tocDir, "postgres.toc"), "; Archive created at fixture\n; Selected TOC Entries:\n3; 2615 2200 SCHEMA - unverified fixture_owner\n");
    let schemaMismatch: unknown;
    try { verifyDatabaseSchemas(inspectExportArchive(archive), tocDir); }
    catch (error) { schemaMismatch = error; }
    expect(schemaMismatch).toEqual(new ImportInspectionRefused("source_schema_inventory_mismatch", "schema_list_mismatch"));

    writeFileSync(join(tocDir, "postgres.toc"), "; Archive created at fixture\n; Selected TOC Entries:\n3; 1259 16385 UNKNOWN public SECRET_OBJECT_SENTINEL fixture_owner\n");
    const metadataRefusal = spawnSync(process.execPath, ["--import", "tsx/esm", script, "--archive", archive, "--ledger-copy", ledgerPath, "--database-toc-dir", tocDir, "--copy-directory", copyDir], { encoding: "utf8" });
    expect(metadataRefusal.status).toBe(78);
    expect(metadataRefusal.stderr).toContain("refused (source_schema_inventory_mismatch)");
    expect(metadataRefusal.stderr).toContain("inspectionCheck=toc_object_type_unsupported");
    expect(metadataRefusal.stderr).not.toContain("SECRET_OBJECT_SENTINEL");
    expect(metadataRefusal.stderr).not.toContain("fixture_owner");
  });

  it("refuses legacy manifests and omitted source stores", () => {
    expect(() => inspectExportArchive(fixtureArchive({ legacy: true }))).toThrowError(
      new ImportInspectionRefused("legacy_manifest_without_inventory"),
    );
    expect(() => inspectExportArchive(fixtureArchive({ badInventory: true }))).toThrowError(
      new ImportInspectionRefused("source_inventory_mismatch"),
    );
  });

  it("parses only unambiguous schema entries from PostgreSQL TOC metadata", () => {
    const parser = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", "pg-restore-list-schemas.py");
    const toc = "; Archive created at fixture\n; Selected TOC Entries:\n3; 1259 16385 TABLE public notes fixture_owner\n4; 0 0 TABLE DATA public notes fixture_owner\n";
    const accepted = spawnSync("python3", [parser], { input: toc, encoding: "utf8" });
    expect(accepted.status).toBe(0);
    expect(JSON.parse(accepted.stdout)).toEqual({ schemas: ["public"] });
    const emptyCustom = spawnSync("python3", [parser], { input: "; Archive created at fixture\n; Selected TOC Entries:\n3; 2615 2200 SCHEMA - custom fixture_owner\n", encoding: "utf8" });
    expect(emptyCustom.status).toBe(0);
    expect(JSON.parse(emptyCustom.stdout)).toEqual({ schemas: ["custom"] });
    const noSchemaEvidence = spawnSync("python3", [parser], { input: [
      "; Archive created at fixture", "; Selected TOC Entries:",
      "3; 0 0 ENCODING - UTF8", "4; 0 0 STDSTRINGS - ON", "5; 0 0 SEARCHPATH - \"$user\", public",
    ].join("\n") + "\n", encoding: "utf8" });
    expect(noSchemaEvidence.status).toBe(0);
    expect(JSON.parse(noSchemaEvidence.stdout)).toEqual({ schemas: [] });
    for (const invalid of [
      "", "; Archive created at fixture\n", "; Selected TOC Entries:\n3; 1259 16385 TABLE public notes owner\n",
      "; Archive created at fixture\n; Selected TOC Entries:\n3; broken\n", "; Archive created at fixture\n; Selected TOC Entries:\n3; 1259 16385 TABLE public\n",
      '3; 1259 16385 TABLE "two words" notes fixture_owner\n',
      "3; 1259 16385 UNKNOWN - object fixture_owner\n",
      "x".repeat(256 * 1024 + 1),
    ]) {
      const refused = spawnSync("python3", [parser], { input: invalid, encoding: "utf8" });
      expect(refused.status).not.toBe(0);
      expect(refused.stdout).not.toContain("two words");
      expect(refused.stdout).not.toContain("fixture_owner");
    }
  });

  it("keeps parser and subprocess refusal diagnostics fixed and redacted", () => {
    const malformed = Buffer.from("; Archive created at fixture\n; Selected TOC Entries:\n3; 1259 16385 UNKNOWN public SECRET_SENTINEL fixture_owner\n");
    expect(() => parseDatabaseSchemas(malformed)).toThrowError(
      new ImportInspectionRefused("source_schema_inventory_mismatch", "toc_object_type_unsupported"),
    );
    expect(() => parseDatabaseSchemas(Buffer.alloc(256 * 1024 + 1))).toThrowError(
      new ImportInspectionRefused("source_schema_inventory_mismatch", "toc_too_large"),
    );

    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ code: "ENOENT" }, "parser_unavailable"],
      [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "parser_output_limit"],
      [{ signal: "SIGTERM" }, "parser_signaled"],
      [{ code: "EACCES" }, "parser_launch_failed"],
      [{ status: 1, stdout: Buffer.from("SECRET_SENTINEL") }, "parser_output_json_invalid"],
      [{ status: 1, stdout: Buffer.from('{"error":"unsupported_schema_metadata","inspectionCheck":"SECRET_SENTINEL"}') }, "parser_exit_unclassified"],
      [{ status: 1, stdout: Buffer.from('{"error":"wrong","inspectionCheck":"toc_entries_missing"}') }, "parser_output_shape_invalid"],
      [{ status: 0, stdout: "not-json" }, "parser_output_json_invalid"],
      [{ status: 0, stdout: "{}" }, "parser_output_shape_invalid"],
      [{ status: 0, stdout: '{"schemas":["SECRET_SENTINEL BAD"]}' }, "parser_schema_value_invalid"],
      [{ status: 0, stdout: '{"schemas":["zeta","alpha"]}' }, "parser_schema_order_invalid"],
    ];
    for (const [failure, expected] of refusals) {
      const bin = mkdtempSync(join(tmpdir(), "import-preview-parser-stub-"));
      roots.push(bin);
      const python = join(bin, "python3");
      let script: string;
      const controlledChildError = failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || failure.signal !== undefined;
      if (failure.code === "ENOENT") {
        script = "";
      } else if (failure.code === "EACCES") {
        writeFileSync(python, "#!/bin/sh\nexit 0\n");
        chmodSync(python, 0o644);
        script = "";
      } else if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        script = "";
      } else if (failure.signal) {
        script = "";
      } else {
        const output = String(failure.stdout ?? "");
        const status = typeof failure.status === "number" ? failure.status : 0;
        script = `#!/bin/bash\nprintf '%s' '${output}'\nexit ${status}\n`;
      }
      if (script) {
        writeFileSync(python, script);
        chmodSync(python, 0o755);
      }
      const previousPath = process.env.PATH;
      process.env.PATH = bin;
      if (controlledChildError) childProcessFixture.error = Object.assign(new Error("controlled child-process fixture"), failure);
      try {
        let error: unknown;
        try { parseDatabaseSchemas(Buffer.from("bounded input")); }
        catch (caught) { error = caught; }
        expect(error, `expected parser refusal: ${expected}`).toBeInstanceOf(ImportInspectionRefused);
        expect((error as ImportInspectionRefused).reason).toBe("source_schema_inventory_mismatch");
        expect((error as ImportInspectionRefused).inspectionCheck).toBe(expected);
        expect(String(error)).not.toContain("SECRET_SENTINEL");
      } finally {
        childProcessFixture.error = null;
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    }
  });

  it("accepts an empty dump-observed schema list only when both declarations and TOCs agree", () => {
    const archive = fixtureArchive({ schemas: [] });
    const root = dirname(archive);
    const tocDir = join(root, "database-toc");
    mkdirSync(tocDir);
    for (const database of ["lares_state", "postgres"]) {
      writeFileSync(join(tocDir, `${database}.toc`), "; Archive created at fixture\n; Selected TOC Entries:\n3; 0 0 ENCODING - UTF8\n4; 0 0 STDSTRINGS - ON\n5; 0 0 SEARCHPATH - \"$user\", public\n");
    }
    expect(inspectExportArchive(archive).sourceInventory.databases.map((database) => database.schemas)).toEqual([[], []]);
    expect(() => verifyDatabaseSchemas(inspectExportArchive(archive), tocDir)).not.toThrow();
    writeFileSync(join(tocDir, "postgres.toc"), "; Archive created at fixture\n; Selected TOC Entries:\n3; 1259 16385 TABLE public notes fixture_owner\n");
    expect(() => verifyDatabaseSchemas(inspectExportArchive(archive), tocDir)).toThrowError(
      new ImportInspectionRefused("source_schema_inventory_mismatch", "schema_list_mismatch"),
    );
  });
});

describe("fixed rc.12 member evidence decoder", () => {
  it("accepts the fixed pg_restore envelope and rejects altered, reordered, or misplaced framing", () => {
    const copies = memberCopies();
    for (const table of Object.keys(copies) as Array<keyof typeof copies>) copies[table] = framed(copies[table]);
    expect(mapMemberEvidence(copies).status).toBe("partially-inventoried");

    const users = memberCopies().users.toString("utf8");
    const prefix = framed(Buffer.from(users)).toString("utf8").split(users)[0]!;
    const suffix = "\\unrestrict " + "A".repeat(63) + "\n";
    const rejects = (value: string) => {
      const invalid = memberCopies();
      invalid.users = Buffer.from(value);
      expect(() => mapMemberEvidence(invalid)).toThrowError(new ImportInspectionRefused("member_copy_envelope_invalid"));
    };
    rejects(prefix.replace("SET lock_timeout = 0;", "SET lock_timeout = 1;") + users + suffix);
    rejects(prefix.replace("SET lock_timeout = 0;\n", "") + users + suffix);
    rejects(prefix.replace("SET statement_timeout = 0;\n", "") + "SET statement_timeout = 0;\n" + users + suffix);
    rejects(prefix.replace("SET statement_timeout = 0;\n", `\\restrict ${"B".repeat(63)}\nSET statement_timeout = 0;\n`) + users + suffix);
    rejects(prefix.replace("set_config('search_path', '', false)", "set_config('search_path', 'public', false)") + users + suffix);
    rejects(prefix.replace("set_config('search_path', '', false)", "set_config('search_path', 'pg_catalog', false)") + users + suffix);
    rejects(prefix + users + "SET statement_timeout = 0;\n" + suffix);
    rejects(prefix.replace("SET lock_timeout = 0;", "DROP TABLE public.users;") + users + suffix);
    rejects(prefix + users + "\\unrestrict " + "B".repeat(63) + "\n");
    rejects(prefix + "\\unrestrict " + "A".repeat(63) + "\n" + users);
    rejects(prefix + users.replace("\\.\n", "") + suffix);
    rejects(prefix + users + suffix + users);
  });

  it("counts and hashes all four pinned candidate tables and accepts explicit unique maps", () => {
    const result = mapMemberEvidence(memberCopies(), {
      version: 1,
      members: [
        { sourceId: "member-a", destinationId: "dest-member-a" },
        { sourceId: "member-b", destinationId: "dest-member-b" },
      ],
      organizations: [{ sourceId: "org-a", destinationId: "dest-org-a" }],
    });
    expect(result).toMatchObject({
      status: "inventoried", count: 2,
      sourceTables: [
        { table: "users", count: 2 }, { table: "orgs", count: 1 },
        { table: "org_member_policy", count: 1 }, { table: "user_aliases", count: 1 },
      ],
      sourceMembers: [
        { sourceId: "member-a", destinationId: "dest-member-a", provenance: "explicit-import-map" },
        { sourceId: "member-b", destinationId: "dest-member-b", provenance: "explicit-import-map" },
      ],
      sourceOrganisations: [{ sourceId: "org-a", destinationId: "dest-org-a", provenance: "explicit-import-map" }],
      dependencies: { userOrganisationReferences: 2, policyMemberReferences: 1, aliasMemberReferences: 1, allReferencesResolved: true },
      authority: "mapping-evidence-only; destination existence and authority are not verified",
    });
    expect(result.sourceTables.every((table) => /^[a-f0-9]{64}$/.test(table.checksum))).toBe(true);
    const output = JSON.stringify(result);
    for (const privateValue of ["PRIVATE_NAME_SENTINEL", "private@example.invalid", "PRIVATE_ORG_LABEL_SENTINEL", "PRIVATE_ALIAS", "agent:write", "25.00"]) {
      expect(output).not.toContain(privateValue);
    }
    expect(JSON.stringify(mapMemberEvidence(memberCopies(), {
      version: 1,
      members: [
        { sourceId: "member-a", destinationId: "dest-member-a" },
        { sourceId: "member-b", destinationId: "dest-member-b" },
      ],
      organizations: [{ sourceId: "org-a", destinationId: "dest-org-a" }],
    }))).toBe(output);
  });

  it("keeps omissions explicit when member or organisation mappings are missing", () => {
    const result = mapMemberEvidence(memberCopies(), {
      version: 1,
      members: [{ sourceId: "member-a", destinationId: "dest-member-a" }],
      organizations: [],
    });
    expect(result.status).toBe("partially-inventoried");
    expect(result.unresolvedMemberIds).toEqual(["member-b"]);
    expect(result.unresolvedOrganisationIds).toEqual(["org-a"]);
  });

  it.each([
    ["duplicate destination", { version: 1, members: [{ sourceId: "member-a", destinationId: "same" }, { sourceId: "member-b", destinationId: "same" }], organizations: [] }],
    ["unknown source", { version: 1, members: [{ sourceId: "other", destinationId: "dest" }], organizations: [] }],
    ["unexpected map field", { version: 1, members: [], organizations: [], inferByEmail: true }],
  ])("refuses %s in the explicit map", (_name, map) => {
    expect(() => mapMemberEvidence(memberCopies(), map)).toThrowError(ImportInspectionRefused);
  });

  it("refuses altered column order, malformed escapes, duplicate rows, and unresolved references", () => {
    const copies = memberCopies();
    copies.users = copy("users", "display_name, id, primary_email, created_at, org_id, org_role", []);
    expect(() => mapMemberEvidence(copies)).toThrowError(ImportInspectionRefused);
    copies.users = copy("users", "id, display_name, primary_email, created_at, org_id, org_role", [
      "member\\q\tname\t\\N\t2026-10-21 00:00:00+00\torg-a\tmember",
    ]);
    expect(() => mapMemberEvidence(copies)).toThrowError(ImportInspectionRefused);
    copies.users = copy("users", "id, display_name, primary_email, created_at, org_id, org_role", [
      "member-a\tname\t\\N\t2026-10-21 00:00:00+00\torg-a\tmember",
      "member-a\tother\t\\N\t2026-10-21 00:00:00+00\torg-a\tmember",
    ]);
    expect(() => mapMemberEvidence(copies)).toThrowError(ImportInspectionRefused);
    copies.users = memberCopies().users;
    copies.user_aliases = copy("user_aliases", "system, alias, user_id, created_at", [
      "legacy\t\\303\\251\tmember-a\t2026-10-21 00:00:00+00",
      "legacy\té\tmember-a\t2026-10-21 00:00:00+00",
    ]);
    expect(() => mapMemberEvidence(copies)).toThrowError(ImportInspectionRefused);
    copies.users = copy("users", "id, display_name, primary_email, created_at, org_id, org_role", [
      "member-a\tname\t\\N\t2026-10-21 00:00:00+00\tmissing-org\tmember",
    ]);
    expect(() => mapMemberEvidence(copies)).toThrowError(ImportInspectionRefused);
  });

  it("bounds COPY inputs and requires a terminated stream with the exact pinned table shape", () => {
    const copies = memberCopies();
    copies.users = Buffer.alloc(8 * 1024 * 1024 + 1);
    expect(() => mapMemberEvidence(copies)).toThrowError(ImportInspectionRefused);
    copies.users = Buffer.from("COPY public.users (id, display_name, primary_email, created_at, org_id, org_role) FROM stdin;\nmember-a\tname\t\\N\t2026-10-21\torg-a\tmember\n");
    expect(() => mapMemberEvidence(copies)).toThrowError(ImportInspectionRefused);
  });
});

describe("installed import-preview command boundary", () => {
  it("uses the pinned local helper image and read-only archive mounts without DB credentials", () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", "lares");
    const cli = readFileSync(path, "utf8");
    expect(cli).toContain("lares import-preview <archive.tar>");
    expect(cli).toContain("--pull=never --network none --read-only --tmpfs /tmp");
    expect(cli).toContain("docker.io/pgvector/pgvector@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b");
    expect(cli).toContain("./lares_state.dump");
    expect(cli).toContain("-v \"$archive:/input.tar:ro\"");
    expect(cli).toContain("pg_restore --data-only --table=schema_migrations -f -");
    expect(cli).toContain("for table in users orgs org_member_policy user_aliases");
    expect(cli).toContain("--data-only --schema=public --table=\"$table\"");
    expect(cli).toContain("timeout --signal=INT --kill-after=10 120 docker run");
    expect(cli).toContain("ulimit -Sf 512");
    expect(cli).toContain("ulimit -Sf 16384; for table in users orgs org_member_policy user_aliases");
    expect(cli).toContain("bin/import-preview.ts --check-archive \"$archive\"");
    expect(cli).toContain("pg_restore --list");
    expect(cli).toContain("/output/database-toc/$db.toc");
    expect(cli).not.toContain("python3 /app/services/box/ops/pg-restore-list-schemas.py");
    expect(cli).toContain("engine_run --network-none --ro \"$archive\" --ro \"$ledger_file\" --ro \"$toc_dir\" --ro \"$scratch\"");
    expect(cli).toContain("--database-toc-dir \"$toc_dir\"");
    expect(cli).toContain("--copy-directory \"$scratch\"");
    const previewCommand = cli.split("cmd_import_preview() {")[1]?.split("cmd_owner_bootstrap()")[0] ?? "";
    expect(previewCommand).not.toMatch(/DATABASE_PASSWORD|LARES_OPERATOR_PASSWORD|docker\.sock/);
    expect(previewCommand).not.toMatch(/pg_restore[^\n]*\s-d\s/);
  });

  it("runs the wrapper's extracted dump-name expression through a shell", () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", "lares");
    const cli = readFileSync(path, "utf8");
    const sedExpression = cli.match(/sed -n ("[^"]+")/)?.[1];
    expect(sedExpression).toBeTruthy();
    const output = execFileSync("bash", ["-c", `printf '%s\\n' ./lares_state.dump ./postgres.dump ./manifest.json | sed -n ${sedExpression}`], { encoding: "utf8" });
    expect(output.trim().split("\n")).toEqual(["lares_state", "postgres"]);
  });

  it("keeps the metadata file limit in the parent while raising only the COPY subshell limit", () => {
    const output = execFileSync("bash", ["-c", [
      "ulimit -Sf 512",
      "parent_before=$(ulimit -Sf)",
      "hard_before=$(ulimit -Hf)",
      "copy_limit=$( (ulimit -Sf 16384; ulimit -Sf) )",
      "parent_after=$(ulimit -Sf)",
      "hard_after=$(ulimit -Hf)",
      "printf '%s %s %s %s %s\\n' \"$parent_before\" \"$copy_limit\" \"$parent_after\" \"$hard_before\" \"$hard_after\"",
    ].join("; ")], { encoding: "utf8" }).trim().split(/\s+/);
    expect(output[0]).toBe("512");
    expect(Number(output[1])).toBeGreaterThan(Number(output[0]));
    expect(output[2]).toBe(output[0]);
    expect(output[3]).toBe(output[4]);
  });

  it("keeps engine-run networking unchanged unless a caller explicitly disables it", () => {
    const script = String.raw`
docker() { printf 'CALL'; printf '|%s' "$@"; printf '\n'; }
. "$1"
ENGINE_IMAGE='example.invalid/keeper@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
engine_run --network-none bin/check.ts
engine_run bin/check.ts
`;
    const runner = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", "engine-run.sh");
    const output = execFileSync("bash", ["-c", script, "bash", runner], { encoding: "utf8" });
    expect(output).toContain("--network|none");
    expect(output).toContain("--network|host");
  });

  it("resolves the workflow's unpacked image and executes real archive and ledger inspection offline", () => {
    const harness = installedHarness("inspect");
    const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const workflow = readFileSync(join(repo, ".github/workflows/keeper-runtime-images.yml"), "utf8");
    const proofStep = workflow.split("- name: Prove packaged import preview reports only bounded member evidence")[1]!.split("- uses:")[0]!;
    const imageArgument = proofStep.match(/"(lares-keeper[^"\n]+)" "\$GITHUB_SHA"/)![1]!;
    const image = imageArgument.replace("${{ steps.keeper-image.outputs.digest }}", `sha256:${"a".repeat(64)}`);
    const archive = join(harness.root, "probe-export.tar");
    const memberMap = join(harness.root, "mapping input.json");
    writeFileSync(memberMap, JSON.stringify({ version: 1, members: [{ sourceId: "member-a", destinationId: "dest-member-a" }], organizations: [{ sourceId: "org-a", destinationId: "dest-org-a" }] }));
    const dump = join(harness.root, "synthetic.dump");
    writeFileSync(dump, "synthetic dump: the offline test never invokes PostgreSQL");
    execFileSync("python3", ["-B", "-c", String.raw`
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("proof", sys.argv[1])
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)
proof.archive_from_dump(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
`, join(repo, "services/keeper/tests/import-preview-image.probe.py"), dump, archive]);
    const runtimeTmp = join(harness.root, "runtime-tmp");
    mkdirSync(runtimeTmp);
    const env: NodeJS.ProcessEnv = {
      ...process.env, LARES_PREFIX: harness.prefix, TMPDIR: harness.privateTmp,
      PATH: `${harness.bin}:${process.env.PATH}`, DOCKER_LOG: harness.dockerLog,
      DOCKER_MODE: "inspect", LEDGER_PAYLOAD: ledgerCopy(), PREVIEW_RUNTIME_TMP: runtimeTmp, PREVIEW_NODE: process.execPath,
      PREVIEW_SCRIPT: join(repo, "services/box/bin/import-preview.ts"),
    };
    const guardBin = execFileSync("python3", ["-B", "-c", String.raw`
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("proof", sys.argv[1])
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)
guard, _ = proof.install_docker_guard(pathlib.Path(sys.argv[2]), sys.argv[3])
print(guard)
`, join(repo, "services/keeper/tests/import-preview-image.probe.py"), harness.root, image], { env, encoding: "utf8" }).trim();
    env.PATH = `${guardBin}:${env.PATH}`;
    env.LARES_PROBE_REAL_DOCKER = join(harness.bin, "docker");
    env.LARES_PROBE_KEEPER_REF = image;
    env.LARES_PROBE_EVENTS = join(harness.root, "docker-boundary-events");
    env.PREVIEW_UNPACK = join(repo, "services/box/ops/unpack-engine.sh");
    env.APP_ROOT = repo;
    env.OUT_ROOT = join(harness.prefix, "opt/lares/releases");
    delete env.LARES_ENGINE_IMAGE;
    delete env.BOX_DIR;
    const unpacked = spawnSync(join(guardBin, "docker"), [
      "run", "--rm", "--network", "none", "--user", "0:0", "--env", "OUT_ROOT=/out",
      "--mount", `type=bind,src=${env.OUT_ROOT},dst=/out`, "--entrypoint", "bash",
      image, "/app/services/box/ops/unpack-engine.sh", "fixture", image,
    ], { env, encoding: "utf8" });
    expect(unpacked.status, unpacked.stderr).toBe(0);
    const result = spawnSync("bash", [harness.cli, "import-preview", archive, "--member-map", memberMap], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(harness.prefix, "opt/lares/current/services/box/engine-image"), "utf8").trim()).toBe(image);
    const inspection = JSON.parse(result.stdout);
    expect(inspection).toMatchObject({ status: "inspection-only", importReadiness: "blocked", archive: { verifiedFiles: 4, nestedRegularFileCount: 1 }, sourceInventory: { databases: [{ name: "lares_state", schemas: ["public"] }, { name: "postgres", schemas: ["public"] }] } });
    expect(inspection.categories.map((entry: { category: string }) => entry.category)).toEqual(IMPORT_CATEGORIES);
    expect(inspection.categories[0]).toMatchObject({ category: "members", status: "inventoried", count: 1, sourceMembers: [{ sourceId: "member-a", destinationId: "dest-member-a" }], sourceOrganisations: [{ sourceId: "org-a", destinationId: "dest-org-a" }] });
    expect(inspection.categories.slice(1).every((entry: { status: string; count: unknown; checksum: unknown }) => entry.status === "not-inventoried" && entry.count === null && entry.checksum === null)).toBe(true);
    expect(result.stdout).not.toContain("PRIVATE_NAME_SENTINEL");
    expect(result.stdout).not.toContain("private@example.invalid");
    expect(result.stdout).not.toContain("PRIVATE_ALIAS_SENTINEL");
    expect(readFileSync(harness.dockerLog, "utf8").match(/--network none/g)).toHaveLength(4);
    expect(readFileSync(harness.dockerLog, "utf8")).toContain("/output/database-toc/$db.toc");
    const canonicalMemberMap = realpathSync(memberMap);
    expect(readFileSync(harness.dockerLog, "utf8")).toContain(`${canonicalMemberMap}:${canonicalMemberMap}:ro`);
    expect(readFileSync(harness.dockerLog, "utf8")).toContain("pg_restore --list");
    expect(readFileSync(env.LARES_PROBE_EVENTS!, "utf8").trim().split("\n")).toEqual([
      "keeper-preview-safe", "helper-safe", "keeper-preview-safe",
    ]);
    expect(readdirSync(harness.privateTmp)).toEqual([]);
  });

  it("runs the actual installed command without image overrides using only a Docker stub", () => {
    const harness = installedHarness();
    const archive = fixtureArchive();
    const runtimeTmp = join(harness.root, "runtime-tmp");
    mkdirSync(runtimeTmp);
    const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const env: NodeJS.ProcessEnv = {
      ...process.env, LARES_PREFIX: harness.prefix, TMPDIR: harness.privateTmp, PATH: `${harness.bin}:${process.env.PATH}`,
      DOCKER_LOG: harness.dockerLog, DOCKER_MODE: "success", LEDGER_PAYLOAD: ledgerCopy(),
      PREVIEW_RUNTIME_TMP: runtimeTmp, PREVIEW_NODE: process.execPath,
      PREVIEW_SCRIPT: join(repo, "services/box/bin/import-preview.ts"),
    };
    delete env.LARES_ENGINE_IMAGE;
    delete env.BOX_DIR;
    const result = spawnSync("bash", [harness.cli, "import-preview", archive], { env, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const inspection = JSON.parse(result.stdout);
    expect(inspection.categories[0]).toMatchObject({ category: "members", status: "partially-inventoried", count: 1, unresolvedMemberIds: ["member-a"], unresolvedOrganisationIds: ["org-a"] });
    expect(inspection.categories.slice(1).every((entry: { status: string }) => entry.status === "not-inventoried")).toBe(true);
    expect(readFileSync(harness.dockerLog, "utf8").match(/--network none/g)).toHaveLength(3);
    expect(readFileSync(harness.dockerLog, "utf8")).toContain("example.invalid/keeper@sha256:");
    expect(readdirSync(harness.privateTmp)).toEqual([]);
  });

  it.each(["overflow", "timeout"] as const)("cleans private output and redacts Docker diagnostics on %s", (mode) => {
    const harness = installedHarness(mode);
    const archive = fixtureArchive();
    const env: NodeJS.ProcessEnv = { ...process.env, LARES_PREFIX: harness.prefix, TMPDIR: harness.privateTmp, PATH: `${harness.bin}:${process.env.PATH}`, DOCKER_LOG: harness.dockerLog, DOCKER_MODE: mode, LEDGER_PAYLOAD: ledgerCopy() };
    delete env.LARES_ENGINE_IMAGE;
    delete env.BOX_DIR;
    const result = spawnSync("bash", [harness.cli, "import-preview", archive], { env, encoding: "utf8" });
    expect(result.status).toBe(64);
    expect(result.stderr).not.toContain("RAW-LEDGER-SECRET");
    expect(result.stderr).not.toContain("x".repeat(100));
    expect(readdirSync(harness.privateTmp)).toEqual([]);
  });
});
