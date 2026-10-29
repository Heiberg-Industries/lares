// export.sh is the whole-installation export: every database dump, a
// git bundle per vault path, a tar per data path, and a manifest.json naming the
// engine version, the date, and each file's name/size/sha256 — all wrapped into one
// lares-export-<date>.tar. It shares no code with backup.sh (copies the dump
// technique instead: read the database list first, dump each one with </dev/null,
// assert all of them landed non-empty) and must never let a secret leave the box.
//
// Only `docker` is stubbed (Python, matching the style of
// tests/backup-lares.test.ts) — no real Docker or Postgres is ever touched. Real
// `git`, `tar`, `sha256sum`/`shasum` and coreutils run as themselves: they are safe,
// deterministic and already exercised directly elsewhere in this package (see
// tests/brain-source.test.ts for real git usage on real bare repos).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { denylistPatterns } from "./helpers/denylist.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "export.sh");

let dir: string;
let binDir: string;
let envFile: string;
let vault1: string;
let vault2: string;
let dataLares: string;
let dataTaste: string;
let exportDir: string;
let workdirRoot: string;
let prefix: string;
let operatorPasswordFile: string;
let dockerLog: string;

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
}

// A real bare repo with one commit — `git bundle create --all` refuses to bundle a
// repo with no refs at all, so every fixture vault needs at least one.
function makeBareVault(bareDir: string, seed: string) {
  const work = mkdtempSync(join(tmpdir(), "export-vault-work-"));
  execFileSync("git", ["init", "-q", "-b", "main", work], { stdio: "pipe" });
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "user.name", "Test");
  writeFileSync(join(work, "seed.md"), seed);
  git(work, "add", "seed.md");
  git(work, "commit", "-q", "-m", "seed");
  execFileSync("git", ["clone", "-q", "--bare", work, bareDir], { stdio: "pipe" });
  rmSync(work, { recursive: true, force: true });
}

// docker stub: pg_isready always succeeds, psql prints the configured database
// list (one per line, matching `-tAc`'s output), pg_dumpall prints fixture roles,
// and pg_dump prints deterministic fixture bytes for every database except
// `failDb`, which it fails for — simulating a database that cannot be dumped.
function writeDockerStub(dbs: string[], failDb?: string, tocLines = ["SCHEMA - public fixture_owner"]) {
  writeFileSync(
    join(binDir, "docker"),
    `#!/usr/bin/env python3
import sys
a = sys.argv
dbs = ${JSON.stringify(dbs)}
fail_db = ${JSON.stringify(failDb ?? "")}
toc_lines = ${JSON.stringify(tocLines)}
with open(${JSON.stringify(dockerLog)}, "a") as log:
    log.write(" ".join(a[1:]) + "\\n")
if a[1:3] == ["compose", "-f"] and "config" in a:
    print('{"services":{"db":{"image":"postgres:16-alpine"}}}')
elif "pg_isready" in a:
    sys.exit(0)
elif "pg_dumpall" in a:
    print("-- fixture role definitions; hashes excluded")
elif "pg_restore" in a:
    print("; Archive created at fixture")
    print("; Selected TOC Entries:")
    for index, line in enumerate(toc_lines, 3):
        print(f"{index}; 1259 16385 {line}")
elif "pg_dump" in a:
    db = a[-1]
    if fail_db and db == fail_db:
        sys.stderr.write("pg_dump: fixture failure for " + db + "\\n")
        sys.exit(1)
    print("x" * 2048)
elif "psql" in a:
    print("\\n".join(dbs))
`,
    { mode: 0o755 },
  );
  writeFileSync(join(binDir, "timeout"), "#!/bin/bash\n[ \"$1\" = 120 ] || exit 125\nshift\nexec \"$@\"\n", { mode: 0o755 });
}

function baseEnv(overrides: Record<string, string> = {}) {
  return {
    ...process.env,
    PATH: binDir + ":" + process.env.PATH,
    LARES_PREFIX: prefix,
    LARES_OPERATOR_PASSWORD_FILE: operatorPasswordFile,
    DOCKER_LOG: dockerLog,
    AGENT_BOX_EXPORT_ENV: envFile,
    EXPORT_VAULT_PATHS: `${vault1} ${vault2}`,
    EXPORT_DATA_PATHS: `${dataLares} ${dataTaste}`,
    EXPORT_DIR: exportDir,
    EXPORT_WORKDIR_ROOT: workdirRoot,
    LARES_ENGINE_VERSION: "9.9.9-fixture",
    ...overrides,
  };
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

const roots: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "export-"));
  roots.push(dir);
  binDir = join(dir, "bin");
  mkdirSync(binDir);

  vault1 = join(dir, "vault1.git");
  vault2 = join(dir, "vault2.git");
  makeBareVault(vault1, "brain-seed");
  makeBareVault(vault2, "atlas-seed");

  dataLares = join(dir, "data-lares");
  dataTaste = join(dir, "data-taste");
  mkdirSync(join(dataLares, "agents", "example"), { recursive: true });
  writeFileSync(join(dataLares, "agents", "example", "agent.json"), '{"name":"example"}');
  mkdirSync(dataTaste, { recursive: true });
  writeFileSync(join(dataTaste, "notes.txt"), "taste notes");

  exportDir = join(dir, "export-out");
  workdirRoot = join(dir, "workdir-root");
  mkdirSync(workdirRoot, { recursive: true });
  prefix = join(dir, "prefix");
  operatorPasswordFile = join(prefix, "etc", "lares", "operator", "database-password");
  mkdirSync(dirname(operatorPasswordFile), { recursive: true });
  writeFileSync(operatorPasswordFile, "offline-fixture-operator-password\n", { mode: 0o600 });
  dockerLog = join(dir, "docker.log");
  writeFileSync(dockerLog, "");
  writeFileSync(join(binDir, "stat"), `#!/bin/sh\nif [ "$3" = "${operatorPasswordFile}" ]; then printf '0:600\\n'; else exec /usr/bin/stat "$@"; fi\n`, { mode: 0o755 });

  // No settings are actually needed from the sourced file in these tests (everything
  // is passed as real env vars instead, exactly what AGENT_BOX_EXPORT_ENV would set
  // in production) — it only has to exist for `source` to succeed under `set -e`.
  envFile = join(dir, "export.env");
  writeFileSync(envFile, "");
});

afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

it("produces one archive with a dump per database, both vault bundles, both data tars and a source inventory manifest", () => {
  writeDockerStub(["lares_state", "postgres"], undefined, ["TABLE public schema_migrations fixture_owner", "TABLE DATA public schema_migrations fixture_owner"]);
  const result = spawnSync("bash", [SCRIPT], { env: baseEnv(), encoding: "utf8" });
  expect(result.status).toBe(0);
  const calls = readFileSync(dockerLog, "utf8");
  expect(calls).toContain(`-v ${operatorPasswordFile}:/run/secrets/database-operator:ro`);
  expect(calls).toContain("pg_dumpall -U lares_operator -l postgres --globals-only --no-role-passwords");
  expect(calls).toContain("pg_dump -U lares_operator --create --format=custom lares_state");
  expect(calls).toContain("pg_dump -U lares_operator --create --format=custom postgres");
  expect(calls).toContain("pg_restore --list -");
  expect(calls).toContain("run --rm -i --network host");
  expect(calls).not.toContain("compose exec");
  expect(calls).not.toContain("/etc/lares/secrets:");

  const finalPath = join(exportDir, `lares-export-${todayUTC()}.tar`);
  expect(existsSync(finalPath)).toBe(true);

  const entries = execFileSync("tar", ["-tf", finalPath], { encoding: "utf8" });
  for (const name of [
    "globals.sql",
    "lares_state.dump",
    "postgres.dump",
    "vault1.bundle",
    "vault2.bundle",
    "data-lares.tar",
    "data-taste.tar",
    "manifest.json",
  ]) {
    expect(entries).toContain(name);
  }

  const extractDir = mkdtempSync(join(tmpdir(), "export-extract-"));
  roots.push(extractDir);
  execFileSync("tar", ["-xf", finalPath, "-C", extractDir]);
  expect(readFileSync(join(extractDir, "globals.sql"), "utf8")).not.toMatch(/password|md5|scram/i);
  const manifest: any = JSON.parse(readFileSync(join(extractDir, "manifest.json"), "utf8"));
  expect(manifest.engineVersion).toBe("9.9.9-fixture");
  expect(manifest.inventoryVersion).toBe(1);
  expect(typeof manifest.date).toBe("string");
  const byName = new Map(manifest.files.map((f: any) => [f.name, f]));
  for (const name of ["globals.sql", "lares_state.dump", "postgres.dump", "vault1.bundle", "data-lares.tar"]) {
    const entry = byName.get(name) as any;
    expect(entry, `manifest is missing ${name}`).toBeTruthy();
    expect(typeof entry.size).toBe("number");
    expect(entry.size).toBeGreaterThan(0);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(manifest.sourceInventory.databases).toEqual([
    { name: "lares_state", member: "lares_state.dump", sha256: (byName.get("lares_state.dump") as any).sha256, schemas: ["public"] },
    { name: "postgres", member: "postgres.dump", sha256: (byName.get("postgres.dump") as any).sha256, schemas: ["public"] },
  ]);
  expect(manifest.sourceInventory.dataRoots.map((store: any) => [store.storeKind, store.disposition, store.member])).toEqual([
    ["configured-data-directory", "included", "data-lares.tar"],
    ["configured-data-directory", "included", "data-taste.tar"],
  ]);
  expect(manifest.sourceInventory.dataSelection).toBe("configured");
  expect(manifest.sourceInventory.protectedMaterial).toEqual({
    credentialFiles: "excluded", encryptedDatabaseCredentials: "may-be-present", ordinaryImport: "blocked",
  });
  expect(JSON.stringify(manifest)).not.toContain(dataLares);
  expect(JSON.stringify(manifest)).not.toContain(dataTaste);
});

it("records an empty dump-observed schema list when valid TOC metadata has no schema evidence", () => {
  writeDockerStub(["lares_state", "postgres"], undefined, ["DATABASE - lares_state fixture_owner"]);
  const result = spawnSync("bash", [SCRIPT], { env: baseEnv(), encoding: "utf8" });
  expect(result.status).toBe(0);
  const archive = join(exportDir, `lares-export-${todayUTC()}.tar`);
  const extractDir = mkdtempSync(join(tmpdir(), "export-empty-schema-extract-"));
  roots.push(extractDir);
  execFileSync("tar", ["-xf", archive, "-C", extractDir]);
  const manifest: any = JSON.parse(readFileSync(join(extractDir, "manifest.json"), "utf8"));
  expect(manifest.sourceInventory.databases.map((database: any) => database.schemas)).toEqual([[], []]);
});

it("removes the work dir after a successful export", () => {
  writeDockerStub(["lares_state"]);
  const result = spawnSync("bash", [SCRIPT], { env: baseEnv(), encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(readdirSync(workdirRoot)).toEqual([]);
});

it("keeps a verified export when another export runs on the same day", () => {
  writeDockerStub(["lares_state"]);
  const first = spawnSync("bash", [SCRIPT], { env: baseEnv(), encoding: "utf8" });
  expect(first.status).toBe(0);
  const firstPath = join(exportDir, `lares-export-${todayUTC()}.tar`);
  const firstBytes = readFileSync(firstPath);

  writeFileSync(join(dataTaste, "notes.txt"), "newer preferences");
  const second = spawnSync("bash", [SCRIPT], { env: baseEnv(), encoding: "utf8" });
  expect(second.status).toBe(0);
  const secondPath = join(exportDir, `lares-export-${todayUTC()}-2.tar`);
  expect(readFileSync(firstPath)).toEqual(firstBytes);
  expect(existsSync(secondPath)).toBe(true);
  expect(readFileSync(secondPath)).not.toEqual(firstBytes);
  expect(readdirSync(exportDir).sort()).toEqual([firstPath, secondPath].map((path) => path.split("/").at(-1)!).sort());
  expect(readdirSync(workdirRoot)).toEqual([]);
});

it("fails loudly when a database dump fails, and leaves no archive or work dir behind", () => {
  writeDockerStub(["dbone", "dbtwo"], "dbtwo");
  const result = spawnSync("bash", [SCRIPT], { env: baseEnv(), encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(existsSync(exportDir) ? readdirSync(exportDir) : []).toEqual([]);
  expect(readdirSync(workdirRoot)).toEqual([]);
});

describe("hard refusals — a configured path never leaves the box", () => {
  const cases: Array<[string, (d: string) => string]> = [
    ["under /etc/agent-box", (d) => "/etc/agent-box/oops"],
    ["under /etc/lares", (d) => "/etc/lares/oops"],
    ["under maintenance custody", (d) => join(prefix, "var/lib/lares-maintenance/postgres-auth")],
    ["under /run/secrets", (d) => "/run/secrets/oops"],
    ["named .env", (d) => join(d, ".env")],
    ["ending in .age", (d) => join(d, "identity.age")],
  ];

  for (const [label, makePath] of cases) {
    it(`refuses a configured data path ${label}`, () => {
      const badPath = makePath(dir);
      const result = spawnSync("bash", [SCRIPT], {
        env: baseEnv({ EXPORT_DATA_PATHS: badPath }),
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("refusing");
      expect(existsSync(exportDir) ? readdirSync(exportDir) : []).toEqual([]);
    });
  }
});

it("refuses a nested .env file found deeper inside a data path, without exporting it", () => {
  writeDockerStub(["lares_state"]);
  mkdirSync(join(dataLares, "nested", "deep"), { recursive: true });
  writeFileSync(join(dataLares, "nested", "deep", ".env"), "SECRET=1");
  const result = spawnSync("bash", [SCRIPT], { env: baseEnv(), encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(".env");
  expect(existsSync(exportDir) ? readdirSync(exportDir) : []).toEqual([]);
  expect(readdirSync(workdirRoot)).toEqual([]);
});

it("refuses a nested *.age file found deeper inside a data path, without exporting it", () => {
  writeDockerStub(["lares_state"]);
  mkdirSync(join(dataTaste, "nested"), { recursive: true });
  writeFileSync(join(dataTaste, "nested", "identity.age"), "age-ciphertext");
  const result = spawnSync("bash", [SCRIPT], { env: baseEnv(), encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(".age");
  expect(existsSync(exportDir) ? readdirSync(exportDir) : []).toEqual([]);
  expect(readdirSync(workdirRoot)).toEqual([]);
});

it("refuses a nested secrets directory on the current installation layout", () => {
  writeDockerStub(["lares_state"]);
  mkdirSync(join(dataLares, "secrets"));
  writeFileSync(join(dataLares, "secrets", "agent-gateway-key"), "fixture-only");
  const result = spawnSync("bash", [SCRIPT], { env: baseEnv(), encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("secrets");
  expect(existsSync(exportDir) ? readdirSync(exportDir) : []).toEqual([]);
});

it("contains no network call and no push", () => {
  const script = readFileSync(SCRIPT, "utf8");
  expect(/curl|wget|git\s+push|scp|rsync/.test(script)).toBe(false);
  expect(script).not.toContain("datname<>'postgres'");
});

// "lares" is the engine's own Postgres role name (used the same way throughout
// backup.sh, restore-drill.sh and even restore-drill.test.ts) and the @lares/
// package scope — not a person, host or installation, so it is not in this list.
// /srv/brain.git, /srv/atlas.git, /srv/lares and /srv/taste are the script's own
// overridable defaults, not an installation's names.
it("names no person, host or installation", () => {
  const script = readFileSync(SCRIPT, "utf8");
  for (const re of denylistPatterns()) expect(re.test(script)).toBe(false);
});
