// restore.sh puts an installation back from a nightly restic snapshot onto a fresh server
// (docs/install.md, "Restoring onto a new server"). These tests drive it with logging stubs
// on PATH (restic, docker, pnpm, id, df) and a temporary prefix, the same pattern as
// tests/setup-backups.test.ts. CI asks Compose to resolve the retained stack file after restore,
// without starting containers or touching Postgres.
//
// The properties that matter most are about what does NOT happen: every refusal must leave
// the server exactly as it was (no service stopped, no database dropped), a bad dump name must
// refuse before any database command, and the private scratch folder must be gone afterwards,
// pass or fail. A stub proves the order of the restore steps and the shape of the commands.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync, readFileSync, rmSync, existsSync, symlinkSync, statSync, lstatSync, realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKFLOW_SCHEMA_STEPS, WORKFLOW_SCHEMA_STEPS_BEFORE } from "../lib/workflow-database-privileges.js";

const here = dirname(fileURLToPath(import.meta.url));
const BOX = join(here, "..");
const SCRIPT = join(BOX, "ops", "restore.sh");
const NEWEST_SQL = readdirSync(join(BOX, "sql")).filter((f) => /^[0-9].*\.sql$/.test(f)).sort().pop()!;
const RESTORE_FIXTURE_CADDY_IMAGE = (JSON.parse(readFileSync(
  join(here, "..", "..", "..", "releases", "2026-10-21-rc.12.json"), "utf8",
)) as { images: { caddy: string } }).images.caddy;

vi.setConfig({ testTimeout: 15_000 });

let workflowData: string, workflowToc: string, workflowStoreDir: string;
let dir: string, binDir: string, prefix: string, log: string, archive: string, scratchParent: string, ledgerFile: string, restoreDbState: string, restoreDbQueryCount: string, restoreClientState: string;
const appDatabase = () => ({ host: '127.0.0.1', port: 5432, database: 'lares_state', user: 'lares_app', passwordFile: join(prefix, 'etc/lares/secrets/database-password') });
const financialBinding = () => ({ directory: '/var/lib/lares/budget-financial', db: { ...appDatabase(), user: 'lares_financial', passwordFile: join(prefix, 'etc/lares/secrets/financial-database-password') } });
const keeperConfig = (extra: Record<string, unknown> = {}) => JSON.stringify({
  project: 'lares', db: appDatabase(),
  lifecycle: { runtime: { workflowPasswordFile: join(prefix, 'etc/lares/secrets/workflow-database-password') } },
  ...extra,
});
const workflowDatabase = `lares_${'a'.repeat(32)}`;

function stub(name: string, body = "exit 0") {
  const p = join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '${name} %s\\n' "$*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(p, 0o755);
}
function write(rel: string, text: string, mode?: number) {
  const p = join(prefix, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  if (mode !== undefined) chmodSync(p, mode);
}
function writeArchive(rel: string, text: string, mode?: number) {
  const p = join(archive, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  if (mode !== undefined) chmodSync(p, mode);
}
/**
 * An agent store's layout as pg_restore prints it out of the store's dump: its record of schema
 * steps and job queue steps (--data-only), and its table list (-l). `steps` is how many of the
 * pinned steps it holds; `extra` adds steps this release does not know.
 */
function workflowLayout(steps: number, opts: { extra?: number; newTables?: boolean; queue?: number; noRecord?: boolean } = {}) {
  const rows = WORKFLOW_SCHEMA_STEPS.slice(0, steps).map(([when, hash], i) => `${i + 1}\t${hash}\t${when}`);
  for (let i = 0; i < (opts.extra ?? 0); i++) rows.push(`${steps + i + 1}\t${"e".repeat(64)}\t${1790300000000 + i}`);
  const queue = Array.from({ length: opts.queue ?? 18 }, (_, i) => `${i + 1}\t2026-01-01 00:00:00+00\tf`);
  writeFileSync(workflowData, [
    ...(opts.noRecord ? [] : ["COPY workflow_drizzle.workflow_migrations (id, hash, created_at) FROM stdin;", ...rows, "\\."]),
    "", "COPY graphile_worker.migrations (id, ts, breaking) FROM stdin;", ...queue, "\\.", "",
  ].join("\n"));
  const tables = ["workflow_runs", "workflow_events", ...((opts.newTables ?? steps >= WORKFLOW_SCHEMA_STEPS.length) ? ["workflow_invocations", "workflow_job_lock_holders", "workflow_snapshots", "workflow_start_hook_admissions"] : [])];
  writeFileSync(workflowToc, [";", "; Archive created at 2026-11-01", ";",
    ...tables.map((t, i) => `${200 + i}; 1259 ${16400 + i} TABLE workflow ${t} lares_workflow_owner`),
    ...((opts.newTables ?? steps >= WORKFLOW_SCHEMA_STEPS.length) ? ["300; 1259 16500 SEQUENCE workflow workflow_invocations_sequence_seq lares_workflow_owner"] : []),
    ...(opts.noRecord ? [] : ["301; 1259 16501 TABLE workflow_drizzle workflow_migrations lares_workflow_owner"]), ""].join("\n"));
}
function ledger(...names: string[]) {
  const rows = names.map((n, i) => `${n}\t${i + 1}\tchecksum\t2026-01-01 00:00:00+00\tapplied\t0\t${i + 1}`).join("\n");
  writeFileSync(
    ledgerFile,
    `--\n-- Data for Name: schema_migrations; Type: TABLE DATA\n--\n\nCOPY public.schema_migrations (filename, number, checksum, applied_at, how, took_ms, seq) FROM stdin;\n${rows}\n\\.\n\n`,
  );
}

/** System tools the script needs, linked into the stub directory so PATH holds nothing else. */
const SYSTEM_TOOLS = ["bash", "sh", "env", "cat", "sed", "grep", "awk", "tr", "head", "tail", "sort", "ls", "basename", "dirname",
  "mkdir", "cp", "mv", "rm", "rmdir", "mktemp", "chmod", "find", "wc", "cut", "date", "sleep", "python3", "cmp", "od"];
function linkSystemTools() {
  for (const t of SYSTEM_TOOLS) {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    if (found) symlinkSync(found, join(binDir, t));
  }
}
function installPythonFaultWrapper() {
  const executable = join(binDir, "python3");
  const realPython = realpathSync(executable);
  rmSync(executable);
  writeFileSync(executable, `#!/usr/bin/env bash
real_python='${realPython}'
if [ "$1" != "-" ]; then exec "$real_python" "$@"; fi
shift
tmp=$(mktemp)
cat > "$tmp"
unlock_script=0
grep -Fq 'for entry in sys.argv[1].splitlines()' "$tmp" && unlock_script=1
if [ "$unlock_script" = 1 ] && [ -n "\${RESTORE_FAIL_VAULT_UNLOCK:-}" ]; then rm -f "$tmp"; exit 1; fi
if [ -n "\${RESTORE_FAIL_INTENT_CLEAR_ONCE_FILE:-}" ] && [ "$2" = active ] && [ "$8" = 1 ] && [ ! -e "$RESTORE_FAIL_INTENT_CLEAR_ONCE_FILE" ]; then : > "$RESTORE_FAIL_INTENT_CLEAR_ONCE_FILE"; rm -f "$tmp"; exit 1; fi
if [ -n "\${RESTORE_FAIL_CLEANUP_READY_ONCE_FILE:-}" ] && [ "$2" = cleanup-ready ] && [ ! -e "$RESTORE_FAIL_CLEANUP_READY_ONCE_FILE" ]; then : > "$RESTORE_FAIL_CLEANUP_READY_ONCE_FILE"; rm -f "$tmp"; exit 1; fi
exec 3< "$tmp"
rm -f "$tmp"
exec "$real_python" - "$@" <&3
`);
  chmodSync(executable, 0o755);
}

function run(args: string[], opts: { env?: Record<string, string>; input?: string; script?: string } = {}) {
  const mode = (rel: string) => {
    try { return (lstatSync(join(prefix, rel)).mode & 0o777).toString(8); }
    catch { return "0"; }
  };
  const r = spawnSync("/bin/bash", [opts.script ?? SCRIPT, "--prefix", prefix, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    input: opts.input ?? "",
    env: {
      PATH: binDir, STUB_LOG: log, HOME: dir, ARCHIVE_ROOT: archive, LEDGER_FILE: ledgerFile, NIGHTLY_SNAPSHOTS,
      ENGINE_STEPS_LIST: join(BOX, "lib", "workflow-database-privileges.ts"),
      RESTORE_DB_STATE_FILE: restoreDbState,
      WORKFLOW_DATA_FILE: workflowData, WORKFLOW_TOC_FILE: workflowToc, WORKFLOW_STORE_DIR: workflowStoreDir,
      RESTORE_DB_QUERY_COUNT_FILE: restoreDbQueryCount,
      RESTORE_CLIENT_STATE_DIR: restoreClientState,
      DRILL_SCRATCH_ROOT: scratchParent, DRILL_MIN_FREE_MB: "1",
      WORKFLOW_ROWS: `${workflowDatabase}\towned\t11111111-1111-4111-8111-111111111111\tlares_workflow_owner\tlares-owned:11111111-1111-4111-8111-111111111111`,
      RESTORE_OPERATOR_MODE: mode("etc/lares/operator/database-password"),
      RESTORE_APP_MODE: mode("etc/lares/secrets/database-password"),
      RESTORE_FINANCIAL_MODE: mode("etc/lares/secrets/financial-database-password"),
      LARES_MAINTENANCE_TESTING: "1",
      RESTORE_OUTSIDE_CUSTODY_MODE: mode("etc/lares/secrets/outside-custody-database-password"),
      LARES_MAINTENANCE_TEST_PREFIX: prefix,
      ...opts.env,
    },
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, all: r.stdout + r.stderr };
}
const base = () => ["--snapshot", "abc123", "--yes", "--old-server-stopped"];
const latest = () => ["--snapshot", "latest", "--yes", "--old-server-stopped"];
// Two nightly snapshots, the newer one listed first, as restic snapshots --json prints them.
const NEWER_SNAPSHOT = "b".repeat(64), OLDER_SNAPSHOT = "a".repeat(64);
const NIGHTLY_SNAPSHOTS = JSON.stringify([
  { id: NEWER_SNAPSHOT, short_id: NEWER_SNAPSHOT.slice(0, 8), time: "2026-11-11T02:00:00.123456789+01:00", tags: ["nightly"] },
  { id: OLDER_SNAPSHOT, short_id: OLDER_SNAPSHOT.slice(0, 8), time: "2026-11-10T02:00:00.987654321+01:00", tags: ["nightly"] },
]);
function vaultInventory() {
  const areaId = randomUUID(), backingId = randomUUID(), planId = randomUUID();
  const inventory = {
    version: 1, planId, organisationId: "org.example.invalid", provisionerMemberId: "owner",
    backing: { id: backingId, kind: "git", root: "/srv" },
    areas: [{ areaId, kind: "private", owner: { kind: "member", id: "owner" }, relativePath: `vault/private/${areaId}`, origin: `/var/lib/lares-vault-git/${areaId}.git` }],
  };
  return { areaId, backingId, inventory };
}
function addVaultSnapshot() {
  const { areaId, backingId, inventory } = vaultInventory();
  write("opt/lares/vault-recovery-engine-image", `registry.example/lares-keeper@sha256:${"b".repeat(64)}\n`, 0o640);
  writeArchive("srv/lares/installation/vault-storage.json", `${JSON.stringify(inventory)}\n`);
  const work = `srv/vault/private/${areaId}`;
  writeArchive(`${work}/.lares-vault-area.json`, `${JSON.stringify({ version: 1, areaId, backingStoreId: backingId, relativePath: `vault/private/${areaId}`, kind: "private", owner: { kind: "member", id: "owner" } })}\n`);
  mkdirSync(join(archive, work, ".git"), { recursive: true });
  mkdirSync(join(archive, "srv/vault/shared"), { recursive: true });
  mkdirSync(join(archive, `var/lib/lares-vault-git/${areaId}.git`), { recursive: true });
}
function addTargetVault() {
  const { areaId, backingId, inventory } = vaultInventory();
  write("opt/lares/vault-recovery-engine-image", `registry.example/lares-keeper@sha256:${"b".repeat(64)}\n`, 0o640);
  write("srv/lares/installation/vault-storage.json", `${JSON.stringify(inventory)}\n`);
  const work = `srv/vault/private/${areaId}`;
  write(`${work}/.lares-vault-area.json`, `${JSON.stringify({ version: 1, areaId, backingStoreId: backingId, relativePath: `vault/private/${areaId}`, kind: "private", owner: { kind: "member", id: "owner" } })}\n`);
  mkdirSync(join(prefix, work, ".git"), { recursive: true });
  mkdirSync(join(prefix, "srv/vault/shared"), { recursive: true });
  mkdirSync(join(prefix, "var/lib/lares-vault-git", `${areaId}.git`), { recursive: true });
  // restore only locks the inventoried working repository. Bare repositories are read-only
  // verification inputs and do not have a separately owned lock in this helper.
  return [join(prefix, work, ".git/lares-vault.lock")];
}
function expectEffectiveRestoreAuth() {
  if (process.env.CI !== "true") return;
  const result = spawnSync("docker", ["compose", "-f", join(prefix, "opt/lares/compose.yaml"), "config", "--format", "json"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const effective = JSON.parse(result.stdout) as {
    services: { db?: { command?: string[]; volumes?: Array<{ type?: string; source?: string; target?: string; read_only?: boolean; bind?: { create_host_path?: boolean } }> } };
  };
  expect(effective.services.db?.command).toEqual(["postgres", "-c", "hba_file=/run/lares-auth/pg_hba.conf"]);
  const effectiveAuthMount = effective.services.db?.volumes?.find((volume) =>
    volume.source === join(prefix, "var/lib/lares-maintenance/postgres-auth") && volume.target === "/run/lares-auth");
  expect(effectiveAuthMount).toMatchObject({
    type: "bind",
    source: join(prefix, "var/lib/lares-maintenance/postgres-auth"),
    target: "/run/lares-auth",
    read_only: true,
  });
  const bind = effectiveAuthMount?.bind;
  expect(bind !== undefined && bind !== null && typeof bind === "object" && !Array.isArray(bind) &&
    (!("create_host_path" in bind) || bind.create_host_path === false)).toBe(true);
}
const logLines = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
const idx = (re: RegExp, from = 0) => logLines().findIndex((l, i) => i >= from && re.test(l));
const lastIdx = (re: RegExp) => logLines().map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
const CHANGING = /(compose[^\n]* stop( |$)|dropdb|createdb|pg_restore[^\n]* -d |pnpm|--exit-on-error| up -d)/;
const changes = () => logLines().filter((l) => CHANGING.test(l));
const scratchLeft = () => readdirSync(scratchParent);
const restoreRunNames = (runsRoot: string) => readdirSync(runsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("restore-"))
  .map((entry) => entry.name);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lares-restore-"));
  binDir = join(dir, "bin"); mkdirSync(binDir);
  prefix = join(dir, "root"); mkdirSync(prefix); prefix = realpathSync(prefix);
  archive = join(dir, "archive"); mkdirSync(archive);
  scratchParent = join(dir, "scratch"); mkdirSync(scratchParent); scratchParent = realpathSync(scratchParent);
  ledgerFile = join(dir, "ledger.txt");
  restoreDbState = join(dir, "restore-db-state"); writeFileSync(restoreDbState, "");
  restoreDbQueryCount = join(dir, "restore-db-query-count"); writeFileSync(restoreDbQueryCount, "0");
  restoreClientState = join(dir, "restore-client-state"); mkdirSync(restoreClientState);
  log = join(dir, "stubs.log"); writeFileSync(log, "");
  workflowData = join(dir, "workflow-data.txt"); workflowToc = join(dir, "workflow-toc.txt");
  workflowStoreDir = join(dir, "workflow-stores"); mkdirSync(workflowStoreDir);
  workflowLayout(WORKFLOW_SCHEMA_STEPS.length);
  linkSystemTools();
  const helper = join(BOX, "ops", "maintenance-custody.py");
  const prepareArgs = [helper, "prepare-fresh", prefix, "172.30.0.0/24", "--confirm-fresh"];
  if (process.getuid?.() !== 0) prepareArgs.push("--test-owner");
  const prepared = spawnSync("python3", prepareArgs, {
    encoding: "utf8",
    env: { ...process.env, LARES_MAINTENANCE_TESTING: "1" },
  });
  if (prepared.status !== 0) throw new Error(`could not prepare restore test admission: ${prepared.stderr}`);
  const stat = join(binDir, 'stat'); writeFileSync(stat, `#!/usr/bin/env bash
format="$2"; file="$3"
case "$file" in
  */etc/lares/operator/database-password) printf '%s:%s\\n' "\${RESTORE_OPERATOR_UID:-0}" "\${RESTORE_OPERATOR_MODE:-600}" ;;
  */etc/lares/secrets/database-password) printf '%s:%s:%s\\n' "\${RESTORE_APP_UID:-0}" "\${RESTORE_APP_GID:-10001}" "\${RESTORE_APP_MODE:-440}" ;;
  */etc/lares/secrets/financial-database-password) printf '%s:%s:%s\\n' "\${RESTORE_FINANCIAL_UID:-0}" "\${RESTORE_FINANCIAL_GID:-10001}" "\${RESTORE_FINANCIAL_MODE:-440}" ;;
  */etc/lares/secrets/outside-custody-database-password) printf '%s:%s:%s\\n' "\${RESTORE_OUTSIDE_CUSTODY_UID:-0}" "\${RESTORE_OUTSIDE_CUSTODY_GID:-10001}" "\${RESTORE_OUTSIDE_CUSTODY_MODE:-440}" ;;
  */opt/lares/vault-recovery-engine-image) printf '%s:640\\n' "\${RESTORE_VAULT_PIN_UID:-0}" ;;
  *) exit 1 ;;
esac
`); chmodSync(stat, 0o755);

  // A finished fresh install: stack, keeper, secrets, the owner-copied files, no agents.
  write("opt/lares/compose.yaml", `services:\n  caddy:\n    image: ${RESTORE_FIXTURE_CADDY_IMAGE}\n    environment:\n      LARES_DOMAIN: example.test\n  db:\n    image: postgres:16\n    command: [postgres, -c, hba_file=/run/lares-auth/pg_hba.conf]\n    volumes:\n      - ${prefix}/var/lib/lares/postgres:/var/lib/postgresql/data\n      - type: bind\n        source: ${prefix}/var/lib/lares-maintenance/postgres-auth\n        target: /run/lares-auth\n        read_only: true\n        bind:\n          create_host_path: false\n`);
  write("opt/lares/compose.lares-keeper.yaml", "services: {}\n");
  write("etc/lares/installation.env", "LARES_DOMAIN=example.test\n");
  write("etc/lares/keeper.env", `LARES_ROOT=/srv/lares\nLARES_HOST_SOCKET_DIR=${join(prefix, "run/lares-host")}\n`, 0o640);
  mkdirSync(join(prefix, "run/lares-host"), { recursive: true });
  write("etc/lares/keeper.json", `${keeperConfig()}\n`);
  write("etc/lares/backup.env", "RESTIC_REPOSITORY='/fake/repository'\nRESTIC_PASSWORD_FILE='/etc/lares/restic-password'\nLARES_CURRENT_LAYOUT='1'\n");
  write("etc/lares/restic-password", "not-a-real-password\n");
  write("etc/lares/secrets/database-password", "not-a-real-db-password\n", 0o440);
  write("etc/lares/secrets/financial-database-password", "not-a-real-financial-db-password\n", 0o440);
  write("etc/lares/secrets/outside-custody-database-password", "not-a-real-outside-custody-db-password\n", 0o440);
  write("etc/lares/secrets/workflow-database-password", "not-a-real-workflow-db-password\n");
  write("etc/lares/operator/database-password", "test-only-operator-password\n", 0o600);
  write("srv/lares/secrets/alpha-gateway-key", "not-a-real-key\n");
  write("srv/lares/secrets/alpha-telegram-token", "not-a-real-token\n");
  mkdirSync(join(prefix, "srv/lares/agents"), { recursive: true });
  mkdirSync(join(prefix, "srv/taste"), { recursive: true });

  // The snapshot.
  for (const db of ["lares_state", "postgres", "litellm", workflowDatabase]) writeArchive(`var/backups/pg/${db}.dump`, `dump of ${db}\n`);
  writeArchive("var/backups/pg/globals.sql", "-- roles\n");
  writeArchive("var/backups/pg/secrets/agent-box-secrets.tar.age", "ciphertext\n");
  writeArchive("srv/lares/agents/alpha/agent.json", '{"name":"alpha"}\n', 0o640);
  writeArchive("srv/lares/retired/old/agent.json", "{}\n");
  writeArchive("srv/taste/note.md", "taste\n");
  writeArchive("srv/lares/installation/calendar.json", "{}\n");
  ledger("001_baseline.sql");

  stub("id", 'echo "${FAKE_UID:-0}"');
  stub("df", 'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "stub 1 1 ${DF_AVAIL_KB:-99999999} 1% /"');
  stub("pnpm");
  stub("restic", `
if [ -n "\${RESTIC_FAIL:-}" ]; then echo "stub restic: boom" >&2; exit 1; fi
case " $* " in
  *" snapshots "*)
    [ -z "\${RESTIC_SNAPSHOTS_FAIL:-}" ] || { echo "stub restic: cannot list" >&2; exit 1; }
    printf '%s\\n' "\${RESTIC_SNAPSHOTS_JSON:-$NIGHTLY_SNAPSHOTS}"
    ;;
  *" restore "*)
    target=""; prev=""
    for a in "$@"; do [ "$prev" = "--target" ] && target="$a"; prev="$a"; done
    cp -Rp "$ARCHIVE_ROOT/." "$target/"
    [ -z "\${SCRATCH_SEEN:-}" ] || ls "$target" > "$SCRATCH_SEEN"
    ;;
esac
exit 0`);
  stub("timeout", `
exec python3 -c 'import math,os,signal,subprocess,sys
args=sys.argv[1:]
kill_after=5.0
if args and args[0].startswith("--kill-after="): kill_after=float(args.pop(0).split("=",1)[1])
if len(args)<2: sys.exit(125)
duration=float(args.pop(0)); scale=float(os.environ.get("RESTORE_TEST_TIMEOUT_SCALE","1"))
if duration in (1800,60): duration*=scale; kill_after*=scale
if not math.isfinite(duration) or duration<=0 or not math.isfinite(kill_after) or kill_after<=0: sys.exit(125)
process=subprocess.Popen(args,start_new_session=True)
try: sys.exit(process.wait(timeout=duration))
except subprocess.TimeoutExpired:
 try: os.killpg(process.pid,signal.SIGTERM)
 except ProcessLookupError: pass
 try: process.wait(timeout=kill_after*scale)
 except subprocess.TimeoutExpired:
  try: os.killpg(process.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  process.wait()
 sys.exit(124)' "$@"
`);
  stub("docker", `
if [ "$1" = image ] && [ "$2" = inspect ]; then
  case "$*" in *"--format"*) printf '["/usr/local/lib/lares/maintenance-admission-v1"]\\n' ;; esac
  exit 0
fi
client_state() { printf '%s/%s' "$RESTORE_CLIENT_STATE_DIR" "$1"; }
client_field() { sed -n "\${2}p" "$(client_state "$1")"; }
client_save() { printf '%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' "$2" "$3" "$4" "$5" "$6" "$7" > "$(client_state "$1")"; }
if [ "$1" = create ]; then
  name=""; cidfile=""; owner=""; operation=""; previous=""
  for arg in "$@"; do
    case "$previous" in
      name) name="$arg"; previous= ;;
      cidfile) cidfile="$arg"; previous= ;;
      label)
        case "$arg" in com.lares.restore.owner=*) owner="\${arg#*=}" ;; com.lares.restore.operation=*) operation="\${arg#*=}" ;; esac
        previous= ;;
    esac
    case "$arg" in --name) previous=name ;; --cidfile) previous=cidfile ;; --label) previous=label ;; esac
  done
  id=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
  client_save "$id" "$owner" "$operation" "$name" false 0 false
  if [ -z "\${RESTORE_CLIENT_CIDFILE_MISSING:-}" ] && [ "\${RESTORE_CLIENT_CIDFILE_MISSING_FOR:-@none@}" != "$operation" ]; then
    case "\${RESTORE_CLIENT_CIDFILE_FORMAT:-raw}" in
      raw) printf '%s' "$id" > "$cidfile" ;;
      newline) printf '%s\\n' "$id" > "$cidfile" ;;
      nonhex) printf '%sg' "\${id%?}" > "$cidfile" ;;
    esac
  fi
  printf '%s\\n' "$id"
  exit 0
fi
if [ "$1" = inspect ] && [ "$2" = --format ]; then
  format="$3"; id="$4"; [ -f "$(client_state "$id")" ] || exit 1
  owner=$(client_field "$id" 1); operation=$(client_field "$id" 2); name=$(client_field "$id" 3)
  running=$(client_field "$id" 4); status=$(client_field "$id" 5)
  case "$format" in
    *'.State.Running'*'.State.ExitCode'*) printf '%s|%s|%s|%s|%s\\n' "$id" "$running" "$status" "$owner" "$operation" ;;
    *'.State.Running'*'.Config.Labels'*'.Name'*) printf '%s|%s|%s|%s|/%s\\n' "$id" "$running" "$owner" "$operation" "$name" ;;
    *'.State.Running'*) printf '%s\\n' "$running" ;;
    *) printf '%s|/%s|%s|%s\\n' "$id" "$name" "$owner" "$operation" ;;
  esac
  exit 0
fi
if [ "$1" = start ] && [ "$2" = --attach ]; then
  id="$3"; operation=$(client_field "$id" 2); status=0
  [ "\${RESTORE_CLIENT_FAIL_OPERATION:-}" != "\${operation#*:}" ] || status=3
  if [ "$operation" = vault:verify-snapshot ]; then
    case "\${RESTORE_INTENT_MUTATION:-}" in
      missing) record=$(find "$LARES_PREFIX/var/lib/lares-maintenance/restore-runs" -name intent.json -type f); rm -f "$record" ;;
      tampered) record=$(find "$LARES_PREFIX/var/lib/lares-maintenance/restore-runs" -name intent.json -type f); sed 's/"oid":17234/"oid":99999/' "$record" > "$record.tampered"; mv "$record.tampered" "$record" ;;
    esac
  fi
  client_save "$id" "$(client_field "$id" 1)" "$operation" "$(client_field "$id" 3)" false "$status" false
  [ -z "\${RESTORE_CLIENT_START_DELAY:-}" ] || sleep "$RESTORE_CLIENT_START_DELAY"
  exit "$status"
fi
if [ "$1" = wait ]; then client_field "$2" 5; exit 0; fi
if [ "$1" = stop ]; then
  id="\${@: -1}"; client_save "$id" "$(client_field "$id" 1)" "$(client_field "$id" 2)" "$(client_field "$id" 3)" false 137 false; exit 0
fi
if [ "$1" = rm ]; then
  id="\${@: -1}"; client_save "$id" "$(client_field "$id" 1)" "$(client_field "$id" 2)" "$(client_field "$id" 3)" false "$(client_field "$id" 5)" true; exit 0
fi
if [ "$1" = ps ] && case "$*" in *label=lares.maintenance=workflow-store*) true ;; *) false ;; esac; then
  [ -z "\${RESTORE_LEFTOVER_STORE_STEP:-}" ] || printf '%s\\n' "$RESTORE_LEFTOVER_STORE_STEP"
  exit "\${RESTORE_LEFTOVER_PS_RC:-0}"
fi
if [ "$1" = ps ] && case "$*" in *service=lares-notion-sync*) true ;; *) false ;; esac; then
  [ -z "\${RESTORE_SYNC_CONTAINER:-}" ] || printf '%s\\n' "$RESTORE_SYNC_CONTAINER"
  exit 0
fi
if [ "$1" = ps ]; then
  filter=""; for arg in "$@"; do case "$arg" in id=*) filter="\${arg#id=}" ;; name=*) filter="name:\${arg#name=}" ;; esac; done
  for state in "$RESTORE_CLIENT_STATE_DIR"/*; do [ -f "$state" ] || continue; id="\${state##*/}"; removed=$(client_field "$id" 6); [ "$removed" = true ] && continue
    if [ "$filter" = "$id" ]; then printf '%s\\n' "$id"; continue; fi
    case "$filter" in name:*) expected_name="\${filter#name:^/}"; expected_name="\${expected_name%\$}"; [ "$(client_field "$id" 3)" = "$expected_name" ] && printf '%s\\n' "$id" ;; esac
  done
  exit 0
fi
# The keeper's own freeze; a stopped keeper (FREEZE_LIVE_FAIL) sends restore to the host fallback.
case "$*" in *"exec -T lares-keeper"*"budget-financial.ts freeze"*) [ -z "\${FREEZE_LIVE_FAIL:-}" ] || exit 1; exit 0 ;; esac
# The agent-store step (engine-run.sh, workflow_store_step): a role-image container fed the program.
# The engine image's own copy of the store step list (restore reads it with cat, nothing else).
case "$*" in *"run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint cat "*" /app/services/box/lib/workflow-database-privileges.ts")
  [ -z "\${RESTORE_STEPS_LIST_FAIL:-}" ] || { printf 'Unable to find image locally\\ndocker: Error response from daemon: manifest unknown (stub)\\n' >&2; exit 125; }
  [ -z "\${RESTORE_STEPS_LIST_HANG:-}" ] || exec sleep 30
  cat "$ENGINE_STEPS_LIST"; exit 0 ;;
esac
case "$*" in *"lares.maintenance=workflow-store"*)
  cat >/dev/null; mode="\${@: -2:1}"; db="\${@: -1}"; state="$WORKFLOW_STORE_DIR/$db"
  case "$mode" in
    check) if [ -n "\${STORE_CHECK_FAIL:-}" ]; then echo "workflow store: the check was refused (stub)" >&2; exit 3; fi; cat "$state" 2>/dev/null || echo old ;;
    upgrade) if [ -n "\${STORE_UPGRADE_FAIL:-}" ]; then echo "workflow store: the upgrade failed (stub)" >&2; exit 1; fi; echo current > "$state" ;;
    *) exit 78 ;;
  esac
  exit 0 ;;
esac
case "$*" in *"compose"*"config --format json"*) printf '{"services":{"db":{"image":"postgres:16"}}}\\n'; exit 0 ;; esac
case "$*" in
  *"verify-snapshot"*)
    case "\${RESTORE_INTENT_MUTATION:-}" in
      missing) record=$(find "$LARES_PREFIX/var/lib/lares-maintenance/restore-runs" -name intent.json -type f); rm -f "$record" ;;
      tampered) record=$(find "$LARES_PREFIX/var/lib/lares-maintenance/restore-runs" -name intent.json -type f); sed 's/"oid":17234/"oid":99999/' "$record" > "$record.tampered"; mv "$record.tampered" "$record" ;;
    esac
    exit 0 ;;
esac
case " $* " in
  *" pg_isready "*) cat >/dev/null 2>&1 </dev/null; exit "\${PG_ISREADY_RC:-0}" ;;
  *ownership_token*) printf '%s\\n' "\${WORKFLOW_ROWS:-}"; exit 0 ;;
  *"SELECT oid FROM pg_database"*) database=$(printf '%s' "$*" | sed -n "s/.*datname = '\\([^']*\\)'.*/\\1/p"); query_count=$(cat "$RESTORE_DB_QUERY_COUNT_FILE"); query_count=$((query_count + 1)); printf '%s' "$query_count" > "$RESTORE_DB_QUERY_COUNT_FILE"; if [ "$(cat "$RESTORE_DB_STATE_FILE")" = "$database" ]; then if [ -n "\${RESTORE_DB_OID_CHANGED:-}" ] && [ "$query_count" -ge 3 ]; then echo "\${RESTORE_CHANGED_DB_OID:-99999}"; else echo "\${RESTORE_DB_OID:-17234}"; fi; fi; exit 0 ;;
  *" createdb "*) database="\${@: -1}"; if [ -n "\${RESTORE_CREATEDB_PARTIAL_FAIL:-}" ]; then printf '%s' "$database" > "$RESTORE_DB_STATE_FILE"; exit 1; fi; printf '%s' "$database" > "$RESTORE_DB_STATE_FILE"; exit 0 ;;
  *" dropdb "*) if [ -n "\${RESTORE_DROPDB_FAIL:-}" ]; then exit 1; fi; if [ -n "\${RESTORE_DROPDB_FAIL_FIRST_FILE:-}" ] && [ ! -e "$RESTORE_DROPDB_FAIL_FIRST_FILE" ]; then : > "$RESTORE_DROPDB_FAIL_FIRST_FILE"; exit 1; fi; : > "$RESTORE_DB_STATE_FILE"; exit 0 ;;
  *" psql "*) echo "\${FRESH_COUNTS:-0 0 0}"; exit 0 ;;
  *" pg_restore -l "*) input=$(cat); case "$input" in "dump of lares_"[0-9a-f]*) cat "$WORKFLOW_TOC_FILE" ;; esac; exit 0 ;;
  *" pg_restore "*" -f - "*) input=$(cat); case "$input" in "dump of lares_"[0-9a-f]*) cat "$WORKFLOW_DATA_FILE" ;; *) cat "$LEDGER_FILE" ;; esac; exit 0 ;;
  *" pg_restore "*" drill_vault_restore_"*) cat >/dev/null; exit "\${RESTORE_TMP_PG_RESTORE_FAIL:-0}" ;;
  *" pg_restore "*) input=$(cat); [ "$input" != "dump of \${PG_RESTORE_FAIL_DB:-@none@}" ] || exit 1; exit 0 ;;
  *" ps -q"*) echo "\${AGENTS_RUNNING:-}"; exit 0 ;;
esac
exit 0`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("restore.sh: a good restore", () => {
  it("takes normal maintenance admission before reading install settings or calling Docker", () => {
    rmSync(join(prefix, "var/lib/lares-maintenance/custody/preparation.json"));
    const result = run(base(), { env: { LARES_ENGINE_IMAGE: `registry.example/keeper@sha256:${"a".repeat(64)}` } });
    expect(result.code).toBe(78);
    expect(result.all).toContain("maintenance admission: refused");
    expect(logLines()).toEqual(["id -u"]);
    expect(existsSync(join(prefix, "var/lib/lares-maintenance/restore-runs"))).toBe(false);
  });

  it("keeps the original refusal when cleanup runs before database helpers are defined", () => {
    rmSync(join(prefix, "opt/lares/compose.yaml"));
    const result = run(base());
    expect(result.code).toBe(78);
    expect(result.all).toContain("this is not a finished Lares installation");
    expect(result.all).not.toContain("command not found");
    expect(readdirSync(join(prefix, "var/lib/lares-maintenance/restore-runs"))).toEqual([]);
  });

  it("refuses a second restore while a prior active claim remains", () => {
    const runsRoot = join(prefix, "var/lib/lares-maintenance/restore-runs");
    mkdirSync(runsRoot, { mode: 0o700 });
    writeFileSync(join(runsRoot, "restore-active.lock"), "restore-existing\n", { mode: 0o600 });
    const result = run(base());
    expect(result.code).toBe(78);
    expect(result.all).toContain("could not create a private restore work record");
    expect(logLines().filter((line) => /^(docker|restic) /.test(line))).toEqual([]);
    expect(readFileSync(join(runsRoot, "restore-active.lock"), "utf8")).toBe("restore-existing\n");
  });

  it("retains Vault lock identity and restore evidence when owned-lock removal fails", () => {
    const lockFiles = addTargetVault();
    installPythonFaultWrapper();
    const result = run(base(), { env: {
      LARES_ENGINE_IMAGE: `registry.example/keeper@sha256:${"a".repeat(64)}`,
      RESTIC_FAIL: "1",
      RESTORE_FAIL_VAULT_UNLOCK: "1",
    } });
    expect(result.code).toBe(78);
    expect(result.all).toContain("stub restic: boom");
    expect(result.all).toContain("vault-unlock");
    expect(scratchLeft()).toHaveLength(1);
    const runsRoot = join(prefix, "var/lib/lares-maintenance/restore-runs");
    const [runName] = restoreRunNames(runsRoot);
    const record = JSON.parse(readFileSync(join(runsRoot, runName, "intent.json"), "utf8")) as {
      phase: string; scratch: string; cleanup: string;
    };
    expect(record.phase).toBe("cleanup-required");
    expect(record.cleanup).toContain("vault-unlock");
    expect(existsSync(record.scratch)).toBe(true);
    expect(existsSync(join(runsRoot, "restore-active.lock"))).toBe(true);
    for (const lock of lockFiles) {
      expect(readFileSync(lock, "utf8")).toMatch(/^[a-f0-9]{32}$/);
    }
  });

  it("does not retry an uncertain normal-path temporary database drop", () => {
    addVaultSnapshot();
    const failOnce = join(dir, "dropdb-failed-once");
    const result = run(base(), { env: {
      LARES_ENGINE_IMAGE: `registry.example/keeper@sha256:${"a".repeat(64)}`,
      RESTORE_DROPDB_FAIL_FIRST_FILE: failOnce,
    } });
    expect(result.code).toBe(78);
    expect(result.all).toContain("snapshot verification database cleanup is uncertain");
    expect(existsSync(failOnce)).toBe(true);
    expect(logLines().filter((line) => / dropdb /.test(line))).toHaveLength(1);
    expect(readFileSync(restoreDbState, "utf8")).toMatch(/^drill_vault_restore_[a-f0-9]{32}$/);
    const runsRoot = join(prefix, "var/lib/lares-maintenance/restore-runs");
    const [runName] = restoreRunNames(runsRoot);
    const record = JSON.parse(readFileSync(join(runsRoot, runName, "intent.json"), "utf8")) as {
      phase: string; scratch: string; temporaryDatabase: { name: string; state: string; oid: number }; cleanup: string;
    };
    expect(record.phase).toBe("cleanup-required");
    expect(record.cleanup).toContain("temporary-database-identity-or-drop-uncertain");
    expect(record.temporaryDatabase).toMatchObject({ name: readFileSync(restoreDbState, "utf8"), state: "owned", oid: 17234 });
    expect(existsSync(record.scratch)).toBe(true);
    expect(existsSync(join(runsRoot, "restore-active.lock"))).toBe(true);
  });

  it("retains the exact dropped database receipt when clearing its durable intent fails once", () => {
    addVaultSnapshot();
    installPythonFaultWrapper();
    const failOnce = join(dir, "intent-clear-failed-once");
    const result = run(base(), { env: {
      LARES_ENGINE_IMAGE: `registry.example/keeper@sha256:${"a".repeat(64)}`,
      RESTORE_FAIL_INTENT_CLEAR_ONCE_FILE: failOnce,
    } });
    expect(result.code).toBe(78);
    expect(result.all).toContain("snapshot verification database cleanup is uncertain");
    expect(existsSync(failOnce)).toBe(true);
    expect(readFileSync(restoreDbState, "utf8")).toBe("");
    const runsRoot = join(prefix, "var/lib/lares-maintenance/restore-runs");
    const [runName] = restoreRunNames(runsRoot);
    const record = JSON.parse(readFileSync(join(runsRoot, runName, "intent.json"), "utf8")) as {
      phase: string; scratch: string; temporaryDatabase: { name: string; state: string; oid: number }; cleanup: string;
    };
    expect(record.phase).toBe("cleanup-required");
    expect(record.cleanup).toContain("temporary-database-intent-clear-uncertain");
    expect(record.temporaryDatabase).toMatchObject({ name: expect.stringMatching(/^drill_vault_restore_[a-f0-9]{32}$/), state: "drop-confirmed", oid: 17234 });
    expect(existsSync(record.scratch)).toBe(true);
    expect(existsSync(join(runsRoot, "restore-active.lock"))).toBe(true);
  });

  it("retains scratch and the active claim when cleanup eligibility cannot be recorded", () => {
    installPythonFaultWrapper();
    const failOnce = join(dir, "cleanup-ready-failed-once");
    const result = run(base(), { env: { RESTORE_FAIL_CLEANUP_READY_ONCE_FILE: failOnce } });
    expect(result.code).toBe(75);
    expect(result.all).toContain("completion-eligibility-not-durable");
    expect(existsSync(failOnce)).toBe(true);
    expect(scratchLeft()).toHaveLength(1);
    const runsRoot = join(prefix, "var/lib/lares-maintenance/restore-runs");
    const [runName] = restoreRunNames(runsRoot);
    const record = JSON.parse(readFileSync(join(runsRoot, runName, "intent.json"), "utf8")) as {
      phase: string; scratch: string; cleanup: string;
    };
    expect(record.phase).toBe("cleanup-required");
    expect(record.cleanup).toContain("completion-eligibility-not-durable");
    expect(existsSync(record.scratch)).toBe(true);
    expect(existsSync(join(runsRoot, "restore-active.lock"))).toBe(true);
  });

  it("normalizes the default slash prefix without touching the host maintenance directory", () => {
    const source = readFileSync(SCRIPT, "utf8");
    const assignment = source.match(/if \[ "\$ADMISSION_PREFIX" = \/ \]; then[\s\S]*?\nfi/);
    expect(assignment).not.toBeNull();
    for (const [inputPrefix, expected] of [["/", "/var/lib/lares-maintenance/restore-runs"], ["/tmp/test-root/", "/tmp/test-root/var/lib/lares-maintenance/restore-runs"]]) {
      const result = spawnSync("/bin/bash", ["-c", `${assignment![0]}; printf '%s' "$RESTORE_WORK_ROOT"`], {
        encoding: "utf8", env: { ...process.env, ADMISSION_PREFIX: inputPrefix },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(expected);
    }
  });

  it("preserves the first restore error and durable scratch/database evidence when temp DB cleanup is uncertain", () => {
    addVaultSnapshot();
    const result = run(base(), { env: {
      LARES_ENGINE_IMAGE: `registry.example/keeper@sha256:${"a".repeat(64)}`,
      RESTORE_TMP_PG_RESTORE_FAIL: "1",
      RESTORE_DROPDB_FAIL: "1",
    } });
    expect(result.code).toBe(78);
    expect(result.all).toContain("snapshot database could not be verified before restoration");
    expect(result.all).toContain("cleanup is uncertain");
    expect(scratchLeft()).toHaveLength(1);
    const runsRoot = join(prefix, "var/lib/lares-maintenance/restore-runs");
    const [runName] = restoreRunNames(runsRoot);
    const runDirectory = join(runsRoot, runName);
    const record = JSON.parse(readFileSync(join(runDirectory, "intent.json"), "utf8")) as {
      phase: string; scratch: string; temporaryDatabase: { state: string; oid: number }; cleanup: string;
    };
    expect(record.phase).toBe("cleanup-required");
    expect(record.cleanup).toContain("temporary-database-identity-or-drop-uncertain");
    expect(record.temporaryDatabase).toMatchObject({ state: "owned", oid: 17234 });
    expect(existsSync(record.scratch)).toBe(true);
  });

  it("does not drop a possibly created database when createdb fails before ownership can be recorded", () => {
    addVaultSnapshot();
    const result = run(base(), { env: {
      LARES_ENGINE_IMAGE: `registry.example/keeper@sha256:${"a".repeat(64)}`,
      RESTORE_CREATEDB_PARTIAL_FAIL: "1",
    } });
    expect(result.code).toBe(78);
    expect(result.all).toContain("cannot create the private snapshot verification database");
    expect(result.all).toContain("temporary-database-creation-uncertain");
    expect(logLines().filter((line) => / dropdb /.test(line))).toEqual([]);
    const runsRoot = join(prefix, "var/lib/lares-maintenance/restore-runs");
    const [runName] = restoreRunNames(runsRoot);
    const record = JSON.parse(readFileSync(join(runsRoot, runName, "intent.json"), "utf8")) as {
      phase: string; temporaryDatabase: { state: string; oid: number | null };
    };
    expect(record.phase).toBe("cleanup-required");
    expect(record.temporaryDatabase).toMatchObject({ state: "creating", oid: null });
    expect(scratchLeft()).toHaveLength(1);
  });

  it("retains the recorded database receipt when its catalog identity changes before cleanup", () => {
    addVaultSnapshot();
    const result = run(base(), { env: {
      LARES_ENGINE_IMAGE: `registry.example/keeper@sha256:${"a".repeat(64)}`,
      RESTORE_TMP_PG_RESTORE_FAIL: "1",
      RESTORE_DB_OID_CHANGED: "1",
    } });
    expect(result.code).toBe(78);
    expect(result.all).toContain("snapshot database could not be verified before restoration");
    expect(result.all).toContain("cleanup is uncertain");
    expect(logLines().filter((line) => / dropdb /.test(line))).toEqual([]);
    const runsRoot = join(prefix, "var/lib/lares-maintenance/restore-runs");
    const [runName] = restoreRunNames(runsRoot);
    const record = JSON.parse(readFileSync(join(runsRoot, runName, "intent.json"), "utf8")) as {
      phase: string; temporaryDatabase: { state: string; oid: number }; scratch: string;
    };
    expect(record.phase).toBe("cleanup-required");
    expect(record.temporaryDatabase).toMatchObject({ state: "owned", oid: 17234 });
    expect(existsSync(record.scratch)).toBe(true);
  });

  it.each(["missing", "tampered"] as const)("refuses temp database deletion when its durable receipt is %s", (mutation) => {
    addVaultSnapshot();
    const result = run(base(), { env: {
      LARES_ENGINE_IMAGE: `registry.example/keeper@sha256:${"a".repeat(64)}`,
      RESTORE_INTENT_MUTATION: mutation,
    } });
    expect(result.code).toBe(78);
    expect(result.all).toContain("snapshot verification database cleanup is uncertain");
    expect(result.all).toContain("temporary-database-identity-or-drop-uncertain");
    expect(logLines().filter((line) => / dropdb /.test(line))).toEqual([]);
    const runsRoot = join(prefix, "var/lib/lares-maintenance/restore-runs");
    const [runName] = restoreRunNames(runsRoot);
    const record = JSON.parse(readFileSync(join(runsRoot, runName, "intent.json"), "utf8")) as {
      phase: string; temporaryDatabase: { state: string; oid: number }; scratch: string;
    };
    expect(record.phase).toBe("cleanup-required");
    expect(record.temporaryDatabase).toMatchObject({ state: "owned", oid: 17234 });
    expect(existsSync(record.scratch)).toBe(true);
    expect(existsSync(join(runsRoot, "restore-active.lock"))).toBe(true);
  });

  it("does the steps in order: stop, drop and restore, migrate, copy folders, start the keeper last", () => {
    const r = run(base(), { env: { COMPOSE_FILE: "/untrusted/override.yaml", RESTORE_SYNC_CONTAINER: "abc123def456" } });
    expect(r.code, r.all).toBe(0);

    const stopKeeper = idx(/compose --env-file \S+keeper\.env stop$/);
    const stopRest = idx(/compose -f \S+compose\.yaml stop console caddy lares-gateway/);
    const firstDrop = idx(/dropdb/);
    const lastRestore = lastIdx(/pg_restore .*--exit-on-error/);
    const migrate = idx(/^pnpm .*migrate/);
    const baseUp = idx(/compose -f \S+compose\.yaml up -d$/);
    const keeperUp = idx(/compose --env-file \S+keeper\.env up -d$/);
    expect(stopKeeper).toBeGreaterThan(-1);
    expect(stopRest).toBeGreaterThan(stopKeeper);
    expect(firstDrop).toBeGreaterThan(stopRest);
    expect(migrate).toBeGreaterThan(lastRestore);
    expect(baseUp, logLines().join("\n")).toBeGreaterThan(migrate);
    // The Notion sync is off after every restore: its container is looked for before any database is
    // replaced, and its switch and accepted preview are cleared after the migration, before anything starts.
    const findSync = idx(/^docker ps -a -q .*service=lares-notion-sync/);
    const clearSync = idx(/^docker .*psql .*DELETE FROM settings WHERE key IN \('sync\.notion\.enabled','sync\.notion\.preview_ack','sync\.notion\.preview'\)/);
    expect(findSync, logLines().join("\n")).toBeGreaterThan(stopRest);
    expect(findSync).toBeLessThan(firstDrop);
    const removeSync = idx(/^docker rm -f abc123def456$/);
    expect(removeSync, logLines().join("\n")).toBeGreaterThan(findSync);
    expect(removeSync).toBeLessThan(firstDrop);
    expect(clearSync, logLines().join("\n")).toBeGreaterThan(migrate);
    expect(clearSync).toBeLessThan(baseUp);
    expect(keeperUp).toBeGreaterThan(baseUp);
    expect(logLines().length - 1).toBe(keeperUp); // the keeper is the very last command
    expect(readFileSync(join(prefix, "etc/lares/keeper.env"), "utf8")).toContain(`COMPOSE_FILE="${join(prefix, "opt/lares/compose.lares-keeper.yaml")}"`);
    expect(logLines().filter((line) => /compose --env-file .*keeper\.env/.test(line)).every((line) => !line.includes("/untrusted/override.yaml"))).toBe(true);
    expect(r.all).toContain("Start agent (applies saved definition)");
    expect(r.all).toContain("Apply connection changes (restarts agent)");
    expect(r.all).toContain("configure-google-keeper.py --org");
  });

  it("restores the prepared Vault overlay and keeps it selected for the keeper recreate", () => {
    const areaId = randomUUID(), backingId = randomUUID(), planId = randomUUID();
    const inventory = {
      version: 1, planId, organisationId: "org.example.invalid", provisionerMemberId: "owner",
      backing: { id: backingId, kind: "git", root: "/srv" },
      areas: [{ areaId, kind: "private", owner: { kind: "member", id: "owner" }, relativePath: `vault/private/${areaId}`, origin: `/var/lib/lares-vault-git/${areaId}.git` }],
    };
    write("opt/lares/vault-recovery-engine-image", `registry.example/lares-keeper@sha256:${"b".repeat(64)}\n`, 0o640);
    writeArchive("srv/lares/installation/vault-storage.json", `${JSON.stringify(inventory)}\n`);
    const work = `srv/vault/private/${areaId}`;
    writeArchive(`${work}/.lares-vault-area.json`, `${JSON.stringify({ version: 1, areaId, backingStoreId: backingId, relativePath: `vault/private/${areaId}`, kind: "private", owner: { kind: "member", id: "owner" } })}\n`);
    mkdirSync(join(archive, work, ".git"), { recursive: true });
    mkdirSync(join(archive, "srv/vault/shared"), { recursive: true });
    mkdirSync(join(archive, `var/lib/lares-vault-git/${areaId}.git`), { recursive: true });

    const r = run(base(), { env: { LARES_ENGINE_IMAGE: `registry.example/keeper@sha256:${"a".repeat(64)}` } });
    expect(r.code, r.all).toBe(0);
    const env = readFileSync(join(prefix, "etc/lares/keeper.env"), "utf8");
    expect(env).toContain(`LARES_VAULT_WORKING_ROOT="${join(prefix, "srv/vault")}"`);
    expect(env).toContain(`LARES_VAULT_BARE_ROOT="${join(prefix, "var/lib/lares-vault-git")}"`);
    expect(env).toContain(`COMPOSE_FILE="${join(prefix, "opt/lares/compose.lares-keeper.yaml")}:${join(prefix, "opt/lares/compose.lares-keeper-vault.yaml")}"`);
    expect(readFileSync(join(prefix, "opt/lares/compose.lares-keeper-vault.yaml"), "utf8")).toBe(readFileSync(join(BOX, "compose.lares-keeper-vault.yaml"), "utf8"));
    expect(lastIdx(/compose --env-file .*keeper\.env up -d$/)).toBe(logLines().length - 1);
  }, 15_000);

  it("keeps the installer's personal Google and Microsoft mounts selected for the keeper recreate", () => {
    write("opt/lares/compose.lares-keeper-personal.yaml", "services:\n  lares-keeper:\n    volumes: []\n", 0o640);
    const r = run(base());
    expect(r.code, r.all).toBe(0);
    expect(readFileSync(join(prefix, "etc/lares/keeper.env"), "utf8")).toContain(
      `COMPOSE_FILE="${join(prefix, "opt/lares/compose.lares-keeper.yaml")}:${join(prefix, "opt/lares/compose.lares-keeper-personal.yaml")}"`);
  });

  it("restores every dump except postgres into a dropped-and-recreated database, and postgres.dump into postgres", () => {
    expect(run(base()).code).toBe(0);
    for (const db of ["lares_state", "litellm", workflowDatabase]) {
      const drop = idx(new RegExp(`dropdb -U lares_operator --if-exists --force ${db}`));
      expect(drop, db).toBeGreaterThan(-1);
    }
    expect(logLines().filter((l) => /pg_restore .*--create/.test(l))).toHaveLength(3);
    expect(idx(/pg_restore --exit-on-error -U lares_operator -d postgres/)).toBeGreaterThan(-1);
    expect(logLines().filter((l) => /pg_restore .*--no-owner|pg_restore .*--no-privileges/.test(l))).toEqual([]);
    expect(logLines().filter((l) => /createdb/.test(l))).toEqual([]);
  });

  it("migrates with the database password in the environment, never on the command line", () => {
    expect(run(base()).code).toBe(0);
    expect(logLines().join("\n")).not.toContain("not-a-real-db-password");
  });

  it("preserves external maintenance custody files byte-for-byte through restore", () => {
    const protectedFiles = [
      "var/lib/lares-maintenance/custody/preparation.json",
      "var/lib/lares-maintenance/admission/intent.json",
      "var/lib/lares-maintenance/postgres-auth/pg_hba.conf",
      "var/lib/lares-maintenance/custody/command.lock",
      "var/lib/lares-maintenance/admission/service-gate.lock",
    ];
    const before = protectedFiles.map((rel) => {
      const file = join(prefix, rel);
      return {
        rel,
        contents: readFileSync(file, "utf8"),
        mode: statSync(file, { bigint: true }).mode & 0o777n,
        inode: statSync(file, { bigint: true }).ino,
      };
    });
    // A snapshot must never replace host-owned external custody, even if it contains a
    // same-named path. The restore command only restores application data under srv/.
    for (const rel of protectedFiles) writeArchive(rel, "untrusted archived custody\n");
    expect(run(base()).code).toBe(0);
    expectEffectiveRestoreAuth();
    for (const sentinel of before) {
      const file = join(prefix, sentinel.rel);
      expect(readFileSync(file, "utf8"), sentinel.rel).toBe(sentinel.contents);
      expect(statSync(file, { bigint: true }).mode & 0o777n, sentinel.rel).toBe(sentinel.mode);
      expect(statSync(file, { bigint: true }).ino, sentinel.rel).toBe(sentinel.inode);
    }
  }, 20_000);

  it("removes the run record while retaining the prepared maintenance custody", () => {
    expect(run(base()).code).toBe(0);
    expect(existsSync(join(prefix, "var/lib/lares-maintenance"))).toBe(true);
    expect(readdirSync(join(prefix, "var/lib/lares-maintenance/restore-runs"))).toEqual([]);
  });

  it("copies the folders from the snapshot with their modes, and leaves nothing in the scratch root", () => {
    expect(run(base()).code).toBe(0);
    expect(readFileSync(join(prefix, "srv/lares/agents/alpha/agent.json"), "utf8")).toContain("alpha");
    expect(statSync(join(prefix, "srv/lares/agents/alpha/agent.json")).mode & 0o777).toBe(0o640);
    expect(existsSync(join(prefix, "srv/lares/retired/old/agent.json"))).toBe(true);
    expect(existsSync(join(prefix, "srv/taste/note.md"))).toBe(true);
    expect(existsSync(join(prefix, "srv/lares/installation/calendar.json"))).toBe(true);
    expect(scratchLeft()).toEqual([]);
  });

  it("restores into a private (0700) scratch folder", () => {
    const seen = join(dir, "seen.txt");
    // the stub lists the target while restoring; also check the mode of what mktemp made
    stub("restic", `
case " $* " in *" restore "*)
  target=""; prev=""; for a in "$@"; do [ "$prev" = "--target" ] && target="$a"; prev="$a"; done
  stat_out=$(ls -ld "$target" | cut -c1-10); echo "$stat_out" > "${seen}"
  cp -Rp "$ARCHIVE_ROOT/." "$target/" ;; esac
exit 0`);
    expect(run(base()).code).toBe(0);
    expect(readFileSync(seen, "utf8").trim()).toBe("drwx------");
  });

  it("looks \"latest\" up once among nightly snapshots only, restores exactly that one and names it by its id", () => {
    const r = run(latest());
    expect(r.code, r.all).toBe(0);
    expect(logLines().find((l) => l.startsWith("restic") && l.includes(" snapshots "))).toMatch(/ snapshots --json --tag nightly$/);
    expect(logLines().find((l) => l.startsWith("restic") && l.includes(" restore "))).toMatch(new RegExp(` restore ${NEWER_SNAPSHOT} --target `));
    expect(r.all).toContain(`the newest nightly snapshot is ${NEWER_SNAPSHOT.slice(0, 8)}; this run restores exactly that one.`);
    expect(r.all).toContain(`restored snapshot ${NEWER_SNAPSHOT.slice(0, 8)}:`);
    expect(r.all).not.toContain("snapshot latest");
  });

  it("refuses, changing nothing, when \"latest\" cannot be looked up", () => {
    const lookups: Record<string, string>[] = [
      { RESTIC_SNAPSHOTS_FAIL: "1" }, { RESTIC_SNAPSHOTS_JSON: "[]" }, { RESTIC_SNAPSHOTS_JSON: '[{"id":"not-hex","time":"2026-11-11T02:00:00Z"}]' },
    ];
    for (const env of lookups) {
      writeFileSync(log, "");
      const r = run(latest(), { env });
      expect(r.code, r.all).toBe(78);
      expect(r.all).toContain("restic could not list the nightly snapshots in the backup repository");
      expect(logLines().filter((l) => l.startsWith("restic") && l.includes(" restore "))).toEqual([]);
      expect(changes()).toEqual([]);
      expect(scratchLeft()).toEqual([]);
    }
  });

  it("does not print the gateway-key repair when every agent's key file came back", () => {
    const r = run(base());
    expect(r.all).toContain("Model gateway keys: nothing to do");
    expect(r.all).not.toContain("rotate-restored-gateway-key.py --agent");
  });

  it("tells the owner to re-register Telegram, and to re-run the installer for a restored deadline calendar", () => {
    writeArchive("srv/lares/installation/deadline-calendar.json", "{}\n");
    const r = run(base());
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain('press "Register Telegram webhook"');
    expect(r.all).toContain("Deadline calendar:");
    expect(r.all).toContain("install.sh --yes --release");
  });

  it("leaves the Telegram and calendar steps out when there is no Telegram token and no calendar", () => {
    rmSync(join(prefix, "srv/lares/secrets/alpha-telegram-token"));
    const r = run(base());
    expect(r.code, r.all).toBe(0);
    expect(r.all).not.toContain("Register Telegram webhook");
    expect(r.all).not.toContain("Deadline calendar:");
  });

  it("prints the exact repair commands for an agent whose key file is missing", () => {
    rmSync(join(prefix, "srv/lares/secrets/alpha-gateway-key"));
    const r = run(base());
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("rotate-restored-gateway-key.py --agent alpha --execute");
  });

  it("asks twice when interactive, and goes ahead on 'stopped' and 'y'", () => {
    const r = run(["--snapshot", "abc123"], { input: "stopped\ny\n" });
    expect(r.code, r.all).toBe(0);
    expect(idx(/dropdb/)).toBeGreaterThan(-1);
  });
});

describe("restore.sh: every refusal changes nothing", () => {
  const refused = (r: ReturnType<typeof run>, why: RegExp) => {
    expect(r.code, r.all).toBe(78);
    expect(r.all).toMatch(why);
    expect(r.all).toMatch(/nothing (was|on this server was) changed/i);
    expect(changes()).toEqual([]);
    expect(scratchLeft()).toEqual([]);
  };

  it("not a current-layout install", () => {
    rmSync(join(prefix, "opt/lares/compose.yaml"));
    refused(run(base()), /not a finished Lares installation/);
  });
  it("no backup.env", () => {
    rmSync(join(prefix, "etc/lares/backup.env"));
    refused(run(base()), /backup\.env is missing/);
  });
  it("restic is not installed", () => {
    rmSync(join(binDir, "restic"));
    refused(run(base()), /restic/);
  });
  it("this server already has an agent definition", () => {
    refused(run(base(), { env: { FRESH_COUNTS: "1 0 0" } }), /already has 1 agent definition/);
  });
  it("this server already holds conversations", () => {
    refused(run(base(), { env: { FRESH_COUNTS: "0 2 5" } }), /already holds conversations/);
  });
  it("the agents folder is not empty", () => {
    write("srv/lares/agents/stray/agent.json", "{}");
    refused(run(base()), /agents is not empty/);
  });
  it("an agent container is running", () => {
    write("srv/lares/compose.lares-agents.yaml", "services: {}\n");
    refused(run(base(), { env: { AGENTS_RUNNING: "0123456789ab" } }), /agent container is running/);
  });
  it("the database does not answer", () => {
    refused(run(base(), { env: { PG_ISREADY_RC: "1" } }), /database container is not answering/);
  });
  it("accepts the installed credential modes while keeping the operator file separate", () => {
    expect(statSync(join(prefix, "etc/lares/secrets/database-password")).mode & 0o777).toBe(0o440);
    expect(statSync(join(prefix, "etc/lares/secrets/financial-database-password")).mode & 0o777).toBe(0o440);
    expect(statSync(join(prefix, "etc/lares/secrets/outside-custody-database-password")).mode & 0o777).toBe(0o440);
    expect(statSync(join(prefix, "etc/lares/operator/database-password")).mode & 0o777).toBe(0o600);
    const r = run(["--snapshot", "abc123", "--dry-run"]);
    expect(r.code, r.all).toBe(0);
    expect(changes()).toEqual([]);
  });
  it("refuses an app password file with the wrong owner before destructive actions", () => {
    refused(run(base(), { env: { RESTORE_APP_UID: "1001" } }), /credential file is missing or unsafe/);
  });
  it("refuses a financial password file with the wrong group before destructive actions", () => {
    refused(run(base(), { env: { RESTORE_FINANCIAL_GID: "1000" } }), /credential file is missing or unsafe/);
  });
  it("refuses a missing outside-custody password before destructive actions", () => {
    rmSync(join(prefix, "etc/lares/secrets/outside-custody-database-password"));
    refused(run(base()), /engine role credential file is missing or unsafe/);
    expect(existsSync(join(prefix, "etc/lares/secrets/outside-custody-database-password"))).toBe(false);
  });
  it("refuses an online password file whose mode differs from the installed mode", () => {
    chmodSync(join(prefix, "etc/lares/secrets/database-password"), 0o600);
    refused(run(base()), /credential file is missing or unsafe/);
  });
  it("refuses an empty financial password file", () => {
    const file = join(prefix, "etc/lares/secrets/financial-database-password");
    chmodSync(file, 0o600);
    writeFileSync(file, "");
    chmodSync(file, 0o440);
    refused(run(base()), /credential file is missing or unsafe/);
  });
  it("refuses a symlinked online password file", () => {
    const file = join(prefix, "etc/lares/secrets/financial-database-password");
    const target = join(prefix, "etc/lares/secrets/other-password");
    writeFileSync(target, "not-a-financial-password\n", { mode: 0o440 });
    expect(existsSync(target)).toBe(true);
    rmSync(file);
    symlinkSync(target, file);
    refused(run(base()), /credential file is missing or unsafe/);
  });
  it("still requires the operator password file to be root-only mode 0600", () => {
    chmodSync(join(prefix, "etc/lares/operator/database-password"), 0o440);
    refused(run(base()), /offline operator credential is missing or unsafe/);
  });
  it("--yes without --old-server-stopped", () => {
    refused(run(["--snapshot", "abc123", "--yes"]), /OLD server is switched off/);
  });
  it("the owner does not confirm the old server is stopped", () => {
    refused(run(["--snapshot", "abc123"], { input: "no\n" }), /not confirmed/);
  });
  it("the owner does not confirm the restore at the last question", () => {
    refused(run(["--snapshot", "abc123"], { input: "stopped\nn\n" }), /not confirmed/);
  });
  it("the snapshot has no lares_state.dump", () => {
    rmSync(join(archive, "var/backups/pg/lares_state.dump"));
    refused(run(base()), /no lares_state\.dump/);
  });
  it("a dump has an unsafe name, before any database command", () => {
    writeArchive("var/backups/pg/Evil-Name;x.dump", "x\n");
    const r = run(base());
    refused(r, /unsafe name/);
    expect(logLines().filter((l) => /(dropdb|createdb|pg_restore)/.test(l) && !/-f -/.test(l))).toEqual([]);
  });
  it("the snapshot's migration record is newer than this checkout", () => {
    ledger("001_baseline.sql", "99999_from_the_future.sql");
    refused(run(base()), /newer release/);
  });
  it("accepts a snapshot at exactly this checkout's newest migration", () => {
    ledger("001_baseline.sql", NEWEST_SQL);
    expect(run(base()).code).toBe(0);
  });
  it("the migration record cannot be read", () => {
    writeFileSync(ledgerFile, "nothing useful\n");
    refused(run(base()), /migration record/);
  });
  it("not enough free disk in the scratch root", () => {
    refused(run(base(), { env: { DF_AVAIL_KB: "1024", DRILL_MIN_FREE_MB: "5120" } }), /only 1MB is free/);
  });
  it("the restored domain differs from the one this server was installed with", () => {
    write("etc/lares/installation.env", "LARES_DOMAIN=other.example\n");
    refused(run(base()), /different address is not supported/);
  });
  it("the snapshot holds agents but the token folder is empty here", () => {
    rmSync(join(prefix, "srv/lares/secrets"), { recursive: true });
    mkdirSync(join(prefix, "srv/lares/secrets"));
    refused(run(base()), /token folder\) is empty/);
  });
  it("restic cannot restore the snapshot", () => {
    refused(run(base(), { env: { RESTIC_FAIL: "1" } }), /restic could not restore/);
  });
});

describe("restore.sh: arguments and failures", () => {
  it("needs --snapshot", () => {
    const r = run(["--yes"]);
    expect(r.code).toBe(64);
    expect(logLines()).toEqual([]);
  });
  it("refuses a snapshot id that is not letters and digits", () => {
    const r = run(["--snapshot", "x; rm -rf /", "--yes"]);
    expect(r.code).toBe(64);
    expect(logLines()).toEqual([]);
  });
  it("--help exits 64 and prints usage", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(64);
    expect(r.all).toContain("--snapshot");
  });
  it("refuses when not root", () => {
    const r = run(base(), { env: { FAKE_UID: "1000" } });
    expect(r.code).toBe(77);
    expect(changes()).toEqual([]);
    expect(logLines().filter((l) => !l.startsWith("id "))).toEqual([]);
  });

  it("--dry-run reads the snapshot but stops nothing, drops nothing and removes its scratch folder", () => {
    const r = run(["--snapshot", "abc123", "--dry-run"]);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("dry run");
    expect(changes()).toEqual([]);
    expect(scratchLeft()).toEqual([]);
    expect(existsSync(join(prefix, "srv/lares/agents/alpha"))).toBe(false);
  });

  it("a failed restore step stops there, says what changed, starts nothing, and still removes the scratch folder", () => {
    const r = run(base(), { env: { PG_RESTORE_FAIL_DB: "litellm" } });
    expect(r.code).toBe(75);
    expect(r.all).toContain("only part done");
    expect(r.all).toContain("database litellm dropped");
    expect(idx(/pnpm/)).toBe(-1);
    expect(idx(/ up -d$/)).toBe(-1);
    expect(existsSync(join(prefix, "srv/lares/agents/alpha"))).toBe(false);
    expect(scratchLeft()).toEqual([]);
  });

  it("a failed migration leaves the keeper stopped and the scratch folder removed", () => {
    stub("pnpm", "exit 3");
    const r = run(base());
    expect(r.code).toBe(75);
    expect(r.all).toContain("migration did not finish");
    expect(idx(/ up -d$/)).toBe(-1);
    expect(scratchLeft()).toEqual([]);
  });
});

// IMAGE MODE. On a box whose engine came from an image there is no pnpm: the migration runner
// runs in a throwaway container of that image, with the database password as a file.
describe("restore.sh: a box whose engine is an image", () => {
  const ENGINE = `registry.example/lares-keeper@sha256:${"d".repeat(64)}`;

  beforeEach(() => {
    rmSync(join(binDir, "pnpm"));
  });

  it("does not need pnpm, and migrates in the engine image after the last restore and before the stack starts", () => {
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE } });
    expect(r.code, r.all).toBe(0);
    const operator = join(prefix, "etc", "lares", "operator", "database-password");
    const migrate = idx(/^docker create .*node --import tsx\/esm \/app\/services\/box\/migrate\.ts --schema-owner$/);
    expect(migrate).toBeGreaterThan(lastIdx(/pg_restore .*--exit-on-error/));
    expect(migrate).toBeLessThan(idx(/compose -f \S+compose\.yaml up -d$/));
    const line = logLines()[migrate]!;
    expect(line).toContain(ENGINE);
    expect(line).toContain("--network host --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --user 0:0");
    expect(line).toContain("--env DATABASE_PASSWORD_FILE=/etc/lares/operator/database-password");
    expect(line).toContain(`--mount type=bind,src=${operator},dst=/etc/lares/operator/database-password,readonly`);
    expect(line).toContain("/run/lares-maintenance/admission");
    expect(line).not.toContain("--entrypoint");
    expect(line).not.toContain("docker run");
    expect(line).not.toContain("PGPASSWORD");
    expect(line).not.toContain("docker.sock");
    expect(logLines().join("\n")).not.toContain("not-a-real-db-password");
    expect(idx(/pnpm/)).toBe(-1);
    expect(readdirSync(join(prefix, "var/lib/lares-maintenance/restore-runs"))).toEqual([]);
  });

  it("uses the separate Vault recovery pin, UID 10001, and fixed read-only Vault inputs", () => {
    addVaultSnapshot();
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE } });
    expect(r.code, r.all).toBe(0);
    const vaultFiles = logLines().find((line) => line.startsWith("docker create ") && line.includes("vault-storage.ts verify-files"));
    const vaultSnapshot = logLines().find((line) => line.startsWith("docker create ") && line.includes("vault-storage.ts verify-snapshot"));
    expect(vaultFiles).toBeDefined();
    expect(vaultSnapshot).toBeDefined();
    for (const vault of [vaultFiles!, vaultSnapshot!]) {
      expect(vault).toContain(`registry.example/lares-keeper@sha256:${"b".repeat(64)}`);
      expect(vault).toContain("--user 10001:10001");
      expect(vault).toContain("--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges");
      expect(vault).toMatch(/--mount type=bind,src=.*\/srv\/lares\/installation\/vault-storage\.json,dst=.*\/srv\/lares\/installation\/vault-storage\.json,readonly/);
      expect(vault).toMatch(/--mount type=bind,src=.*\/var\/lib\/lares-vault-git\/.*\.git,dst=.*\/var\/lib\/lares-vault-git\/.*\.git,readonly/);
      expect(vault).not.toContain("--entrypoint");
    }
    expect(readdirSync(join(prefix, "var/lib/lares-maintenance/restore-runs"))).toEqual([]);
  }, 15_000);

  it("routes image-mode financial freeze through the fixed Keeper client with exact custody mounts", () => {
    write("etc/lares/keeper.json", keeperConfig({ budgetFinancial: financialBinding(), budgetNative: { directory: "/var/lib/lares/budget-native" } }));
    mkdirSync(join(prefix, "var/lib/lares/budget-financial"), { recursive: true });
    mkdirSync(join(prefix, "var/lib/lares/budget-native"), { recursive: true });
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE } });
    expect(r.code, r.all).toBe(0);
    const freeze = logLines().find((line) => line.startsWith("docker create ") && line.includes("budget-financial.ts freeze --host /etc/lares/keeper.json"));
    expect(freeze).toBeDefined();
    expect(freeze).toContain(ENGINE);
    expect(freeze).toContain("--user 0:0");
    expect(freeze).toContain(`${join(prefix, "etc/lares/keeper.json")},dst=/etc/lares/keeper.json,readonly`);
    expect(freeze).toContain(`${join(prefix, "run/lares-host")},dst=/run/lares-host,readonly`);
    expect(freeze).toContain(`${join(prefix, "var/lib/lares/budget-financial")},dst=/var/lib/lares/budget-financial`);
    expect(freeze).toContain(`${join(prefix, "var/lib/lares/budget-native")},dst=/var/lib/lares/budget-native`);
    expect(freeze).not.toContain(`${join(prefix, "var/lib/lares")},dst=/var/lib/lares`);
    expect(freeze).not.toContain("docker compose --env-file");
    expect(freeze).not.toContain("tsx/esm /app/services/keeper/node_modules/.bin/tsx");
  }, 15_000);

  it("retains child intent and the active claim when a created client's immutable ID is unavailable", () => {
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE, RESTORE_CLIENT_CIDFILE_MISSING: "1" } });
    expect(r.code).toBe(75);
    expect(r.all).toContain("immutable container id was not recorded");
    const runsRoot = join(prefix, "var/lib/lares-maintenance/restore-runs");
    const [runName] = restoreRunNames(runsRoot);
    const runDirectory = join(runsRoot, runName);
    const children = readdirSync(runDirectory).filter((name) => name.startsWith("restore-client-") && name.endsWith(".intent"));
    expect(children).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(runDirectory, children[0]!), "utf8"))).toMatchObject({
      operation: "keeper:migrate", containerId: null, state: "creating",
    });
    expect(existsSync(join(runsRoot, "restore-active.lock"))).toBe(true);
    expect(logLines().some((line) => line.startsWith("docker rm "))).toBe(false);
  });

  it.each(["newline", "nonhex"] as const)("retains child intent when Docker's cidfile contains malformed %s data", (format) => {
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE, RESTORE_CLIENT_CIDFILE_FORMAT: format } });
    expect(r.code).toBe(75);
    expect(r.all).toContain("immutable container id was not recorded");
    const runsRoot = join(prefix, "var/lib/lares-maintenance/restore-runs");
    const [runName] = restoreRunNames(runsRoot);
    const runDirectory = join(runsRoot, runName);
    const children = readdirSync(runDirectory).filter((name) => name.startsWith("restore-client-") && name.endsWith(".intent"));
    expect(children).toHaveLength(1);
    expect(existsSync(join(runsRoot, "restore-active.lock"))).toBe(true);
    expect(logLines().some((line) => line.startsWith("docker rm "))).toBe(false);
  });

  it("refuses, changing nothing, when the named engine image is not a digest", () => {
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: "registry.example/lares-keeper:latest" } });
    expect(r.code).toBe(78);
    expect(r.all).toContain("engine image is not known");
    expect(changes()).toEqual([]);
  });

  it("refuses, changing nothing, when the engine image is absent and cannot be fetched", () => {
    stub("docker", `
case " $* " in
  *" image inspect "*|*" pull "*) exit 1 ;;
esac
exit 0`);
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE } });
    expect(r.code).toBe(78);
    expect(r.all).toContain("could not download the engine image");
    expect(changes()).toEqual([]);
  });

  it("refuses a Vault target without its separate recovery pin before restic or service changes", () => {
    addTargetVault();
    rmSync(join(prefix, "opt/lares/vault-recovery-engine-image"));
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE } });
    expect(r.code).toBe(78);
    expect(r.all).toContain("separate Vault recovery image pin is missing or unsafe");
    expect(logLines().some((line) => line.startsWith("restic "))).toBe(false);
    expect(changes()).toEqual([]);
  });

  it("enforces the fixed client attempt bound and cleans an identified timed-out client", () => {
    const r = run(base(), { env: {
      LARES_ENGINE_IMAGE: ENGINE,
      RESTORE_TEST_TIMEOUT_SCALE: "0.001",
      RESTORE_CLIENT_START_DELAY: "3",
    } });
    expect(r.code).toBe(75);
    expect(r.all).toContain("migration did not finish");
    expect(logLines().some((line) => /timeout --kill-after=5 1800 docker start --attach/.test(line))).toBe(true);
    expect(logLines().some((line) => line.startsWith("docker rm "))).toBe(true);
    expect(readdirSync(join(prefix, "var/lib/lares-maintenance/restore-runs"))).toEqual([]);
  });

  it("a failed migration in the image leaves the keeper stopped", () => {
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE, RESTORE_CLIENT_FAIL_OPERATION: "migrate" } });
    expect(r.code).toBe(75);
    expect(r.all).toContain("migration did not finish");
    expect(idx(/ up -d$/)).toBe(-1);
    expect(logLines().some((line) => line.startsWith("docker rm "))).toBe(true);
  });
});

it('refuses a missing prepared financial custody before stopping services or replacing any database',()=>{
  write('etc/lares/keeper.json',keeperConfig({budgetFinancial:financialBinding()}));
  const result=run(base());expect(result.code).toBe(78);expect(result.all).toContain('financial custody');expect(changes()).toEqual([]);
});
it('refuses configured native custody that is missing before stopping services or replacing any database',()=>{
  write('etc/lares/keeper.json',keeperConfig({budgetFinancial:financialBinding(),budgetNative:{directory:'/var/lib/lares/budget-native'}}));
  mkdirSync(join(prefix,'var/lib/lares/budget-financial'),{recursive:true});
  const result=run(base());expect(result.code).toBe(78);expect(result.all).toContain('native custody');expect(changes()).toEqual([]);
});
it('accepts native custody with the reviewed policy that budget setup writes, and refuses when that file is missing',()=>{
  const policy={directory:'/var/lib/lares/budget-native',reviewedPolicyFile:'/etc/lares/native-policy.json'};
  write('etc/lares/keeper.json',keeperConfig({budgetFinancial:financialBinding(),budgetNative:policy}));
  mkdirSync(join(prefix,'var/lib/lares/budget-financial'),{recursive:true});mkdirSync(join(prefix,'var/lib/lares/budget-native'),{recursive:true});
  const missing=run([...base(),'--dry-run']);expect(missing.code).toBe(78);expect(missing.all).toContain('native custody');expect(changes()).toEqual([]);
  write('etc/lares/native-policy.json','{}');
  const present=run([...base(),'--dry-run']);expect(present.all).not.toContain('native custody is missing');expect(present.all).toContain('prepared native custody is recorded');
});
it('refuses a native policy anywhere but its fixed place',()=>{
  write('etc/lares/keeper.json',keeperConfig({budgetFinancial:financialBinding(),budgetNative:{directory:'/var/lib/lares/budget-native',reviewedPolicyFile:'/tmp/native-policy.json'}}));
  mkdirSync(join(prefix,'var/lib/lares/budget-financial'),{recursive:true});mkdirSync(join(prefix,'var/lib/lares/budget-native'),{recursive:true});
  const result=run([...base(),'--dry-run']);expect(result.code).toBe(78);expect(result.all).toContain('native custody');expect(changes()).toEqual([]);
});
it('refuses an unbound native custody directory before restoring',()=>{
  mkdirSync(join(prefix,'var/lib/lares/budget-native'),{recursive:true});
  const result=run(base());expect(result.code).toBe(78);expect(result.all).toContain('native custody');expect(changes()).toEqual([]);
});
it('freezes prepared custody before the keeper stop while PostgreSQL stays running',()=>{
  write('etc/lares/keeper.json',keeperConfig({budgetFinancial:financialBinding(),budgetNative:{directory:'/var/lib/lares/budget-native'}}));
  mkdirSync(join(prefix,'var/lib/lares/budget-financial'),{recursive:true});
  mkdirSync(join(prefix,'var/lib/lares/budget-native'),{recursive:true});
  const result=run(base());expect(result.code).toBe(0);
  expect(result.all).toContain('draining native custody');
  expect(idx(/budget-financial.ts freeze --host/)).toBeGreaterThanOrEqual(0);
  expect(idx(/budget-financial.ts freeze --host/)).toBeLessThan(idx(/compose.* stop/));
  expect(logLines().some(line=>/compose.* stop.*\bdb\b/.test(line))).toBe(false);
});
it('does not freeze prepared custody on dry-run',()=>{
  write('etc/lares/keeper.json',keeperConfig({budgetFinancial:financialBinding(),budgetNative:{directory:'/var/lib/lares/budget-native'}}));
  mkdirSync(join(prefix,'var/lib/lares/budget-financial'),{recursive:true});
  mkdirSync(join(prefix,'var/lib/lares/budget-native'),{recursive:true});
  const result=run([...base(),'--dry-run']);expect(result.code).toBe(0);expect(idx(/budget-financial.ts/)).toBe(-1);expect(changes()).toEqual([]);
});
it('refuses a failed live and fallback financial freeze before service stop or drop',()=>{
  write('etc/lares/keeper.json',keeperConfig({budgetFinancial:financialBinding()}));
  mkdirSync(join(prefix,'var/lib/lares/budget-financial'),{recursive:true});
  stub('docker',`case "$*" in *"config --format json"*) printf '{"services":{"db":{"image":"postgres:16"}}}\\n'; exit 0 ;; esac; case " $* " in *" budget-financial.ts "*|*" /app/services/keeper/bin/budget-financial.ts "*) exit 1 ;; *" psql "*) echo "0 0 0" ;; *" pg_restore -l "*) cat >/dev/null; cat "$WORKFLOW_TOC_FILE" ;; *" pg_restore "*" -f - "*) input=$(cat); case "$input" in "dump of lares_"[0-9a-f]*) cat "$WORKFLOW_DATA_FILE" ;; *) cat "$LEDGER_FILE" ;; esac ;; esac`);
  stub('pnpm','exit 1');
  const result=run(base());expect(result.code).toBe(78);expect(result.all).toContain('not durably acknowledged');
  expect(logLines().filter(line=>/compose.* stop|dropdb|createdb|pg_restore.* -d /.test(line))).toEqual([]);
});
it('refuses an unbound existing financial directory instead of treating it as a legacy installation',()=>{
  mkdirSync(join(prefix,'var/lib/lares/budget-financial'),{recursive:true});
  const result=run(base());expect(result.code).toBe(78);expect(result.all).toContain('financial custody');expect(changes()).toEqual([]);
});

it('reports prepared restored data as recovery-required without keeper or runtime readiness instructions',()=>{
  write('etc/lares/keeper.json',keeperConfig({budgetFinancial:financialBinding()}));
  mkdirSync(join(prefix,'var/lib/lares/budget-financial'),{recursive:true});
  const result=run(base());expect(result.code).toBe(0);expect(result.all).toContain('Financial recovery is required');expect(result.all).toContain('the keeper starts with spending closed');
  expect(result.all).not.toContain('Sign in to the console');expect(result.all).not.toContain('Apply each agent');expect(result.all).not.toContain('keeper started');expect(result.all).toContain('Keep agents stopped');
});

describe("restore.sh from the files an installed server has", () => {
  // The tree ops/unpack-engine.sh writes on a server: the box's ops/ and sql/, no lib/, no bin/.
  const ENGINE = `registry.example/lares-keeper@sha256:${"d".repeat(64)}`;
  // Each case unpacks the engine files and runs one whole restore: 60 s, as on a busy machine.
  let shipped: string;
  beforeEach(() => {
    rmSync(join(binDir, "pnpm"));
    const out = join(dir, "unpacked");
    const unpacked = spawnSync("bash", [join(BOX, "ops", "unpack-engine.sh"), "proof", ENGINE], {
      encoding: "utf8", env: { PATH: process.env.PATH ?? "", APP_ROOT: join(BOX, "..", ".."), OUT_ROOT: out },
    });
    if (unpacked.status !== 0) throw new Error(`unpack-engine.sh failed: ${unpacked.stderr}`);
    shipped = join(out, "proof", "services", "box", "ops", "restore.sh");
    expect(existsSync(join(out, "proof", "services", "box", "lib"))).toBe(false);
  }, 60_000);
  const catLine = `docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint cat ${ENGINE} /app/services/box/lib/workflow-database-privileges.ts`;

  it("reads the store step list out of the engine image and restores a store from this release", () => {
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE }, script: shipped });
    expect(r.code, r.all).toBe(0);
    expect(logLines().filter((line) => line === catLine)).toHaveLength(1);
    expect(r.all).not.toContain("own list of agent store schema steps could not be read");
  }, 60_000);

  it("reads an older store as older from there too, and upgrades it", () => {
    workflowLayout(WORKFLOW_SCHEMA_STEPS_BEFORE);
    write("opt/lares/current/release.json", JSON.stringify({ images: { creative: `registry.example/lares-creative@sha256:${"c".repeat(64)}` } }));
    write("etc/lares/secrets/workflow-provisioner-password", "not-a-real-provisioner-password\n", 0o600);
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE }, script: shipped });
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain(`restore: upgrading the agent store ${workflowDatabase}.`);
  }, 60_000);

  it("refuses, changing nothing, when the engine image cannot give the list, and says Docker's reason", () => {
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE, RESTORE_STEPS_LIST_FAIL: "1" }, script: shipped });
    expect(r.code, r.all).toBe(78);
    expect(r.all).toContain(`this release's own list of agent store schema steps could not be read out of the engine image ${ENGINE} (docker: Error response from daemon: manifest unknown (stub)). Nothing has been changed.`);
    expect(changes()).toEqual([]);
  }, 60_000);

  it("refuses, changing nothing, when Docker does not answer within its minute", () => {
    const started = Date.now();
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE, RESTORE_STEPS_LIST_HANG: "1", RESTORE_TEST_TIMEOUT_SCALE: "0.02" }, script: shipped });
    expect(r.code, r.all).toBe(78);
    expect(r.all).toContain("could not be read out of the engine image");
    expect(r.all).toContain("(Docker did not answer within 60 seconds). Nothing has been changed.");
    expect(logLines()).toContain(`timeout --kill-after=5 60 ${catLine}`);
    expect(changes()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(25_000);
  }, 60_000);

  it("refuses, changing nothing, when this server has no timeout command to bound the read", () => {
    rmSync(join(binDir, "timeout"));
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE }, script: shipped });
    expect(r.code, r.all).toBe(78);
    expect(r.all).toContain("this server has no timeout command to bound that read");
    expect(logLines().filter((line) => line === catLine)).toEqual([]);
    expect(changes()).toEqual([]);
  }, 60_000);
});

describe("restore.sh: a backup from an older release", () => {
  const ROLE_IMAGE = `registry.example/lares-creative@sha256:${"c".repeat(64)}`;
  const oldBackup = () => {
    workflowLayout(WORKFLOW_SCHEMA_STEPS_BEFORE);
    write("opt/lares/current/release.json", JSON.stringify({ images: { creative: ROLE_IMAGE } }));
    write("etc/lares/secrets/workflow-provisioner-password", "not-a-real-provisioner-password\n", 0o600);
  };
  const storeStep = (mode: string) => new RegExp(`^docker run .*lares\\.maintenance=workflow-store.* ${mode} ${workflowDatabase}$`);
  const runsLeft = () => readdirSync(join(prefix, "var/lib/lares-maintenance/restore-runs"));

  it("restores an older store, then checks, upgrades, checks again and applies its permissions before the main database is touched", () => {
    oldBackup();
    const r = run(base());
    expect(r.code, r.all).toBe(0);
    const restoreStore = idx(new RegExp(`dropdb .*${workflowDatabase}`));
    const firstCheck = idx(storeStep("check"));
    const upgrade = idx(storeStep("upgrade"));
    const secondCheck = idx(storeStep("check"), upgrade);
    const apply = idx(new RegExp(`^pnpm .*workflow-template\\.ts apply-database .*--database ${workflowDatabase} --provisioner-password-file \\S+/etc/lares/secrets/workflow-provisioner-password --runtime-password-file \\S+/etc/lares/secrets/workflow-database-password$`));
    const mainDrop = idx(/dropdb .*lares_state$/);
    const migrate = idx(/^pnpm .*migrate/);
    const verify = idx(new RegExp(`^pnpm .*workflow-template\\.ts verify-database .*--database ${workflowDatabase}`));
    expect([restoreStore, firstCheck, upgrade, secondCheck, apply].every((at) => at > -1), logLines().join("\n")).toBe(true);
    expect(logLines()[upgrade]).toContain(ROLE_IMAGE);
    expect(firstCheck).toBeGreaterThan(restoreStore);
    expect(upgrade).toBeGreaterThan(firstCheck);
    expect(secondCheck).toBeGreaterThan(upgrade);
    expect(apply).toBeGreaterThan(secondCheck);
    expect(mainDrop).toBeGreaterThan(apply);
    expect(migrate).toBeGreaterThan(mainDrop);
    expect(verify).toBeGreaterThan(migrate);
    expect(r.all).toContain(`restore: upgrading the agent store ${workflowDatabase}.`);
    // No password reaches a command line, and the run's record of upgraded stores is gone.
    expect(logLines().join("\n")).not.toContain("not-a-real-provisioner-password");
    expect(runsLeft()).toEqual([]);
    expect(scratchLeft()).toEqual([]);
  });

  it("says in a dry run which stores it would upgrade, and changes nothing", () => {
    oldBackup();
    const r = run([...base(), "--dry-run"]);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain(`upgrade these agent stores from the release before this one: ${workflowDatabase}`);
    expect(changes()).toEqual([]);
    expect(logLines().filter((line) => /^docker run .*workflow-store/.test(line))).toEqual([]);
  });

  it("restores a store from this release exactly as before: no store step and no permission step", () => {
    const r = run(base());
    expect(r.code, r.all).toBe(0);
    expect(logLines().filter((line) => /^docker run .*lares\.maintenance=workflow-store|apply-database/.test(line))).toEqual([]);
    expect(idx(/dropdb .*lares_state$/)).toBeGreaterThan(idx(new RegExp(`dropdb .*${workflowDatabase}`)));
  });

  const refusedBeforeAnything = (r: ReturnType<typeof run>, why: RegExp) => {
    expect(r.code, r.all).toBe(78);
    expect(r.all).toMatch(why);
    expect(r.all).toContain("Nothing has been changed.");
    expect(changes()).toEqual([]);
    expect(logLines().filter((line) => /workflow-store|apply-database/.test(line))).toEqual([]);
    expect(scratchLeft()).toEqual([]);
    expect(runsLeft()).toEqual([]);
  };
  it("refuses a store written by a newer release before anything is stopped or dropped", () => {
    workflowLayout(WORKFLOW_SCHEMA_STEPS.length, { extra: 1 });
    refusedBeforeAnything(run(base()), new RegExp(`agent store ${workflowDatabase} in this snapshot cannot be restored by this release: it was written by a newer release: it has 32 schema steps recorded, and this release knows 31\\. .*install that release or a newer one`));
  });
  it("refuses a store with a step list it does not know", () => {
    workflowLayout(25);
    refusedBeforeAnything(run(base()), /it has 25 schema steps recorded, and they are neither the 20 an older release leaves nor the 31 this release leaves/);
  });
  it("refuses a store with no record of its steps", () => {
    workflowLayout(0, { noRecord: true });
    refusedBeforeAnything(run(base()), /it holds no record of the agent framework's schema steps/);
  });
  it("refuses a store whose record says older but already has this release's tables", () => {
    workflowLayout(WORKFLOW_SCHEMA_STEPS_BEFORE, { newTables: true });
    refusedBeforeAnything(run(base()), /its record says it was written by an older release, but it already has tables this release adds/);
  });
  it("refuses a store whose job queue is at an unknown version", () => {
    workflowLayout(WORKFLOW_SCHEMA_STEPS.length, { queue: 19 });
    refusedBeforeAnything(run(base()), /its job queue is at a version this release does not know \(19 steps recorded, 18 expected\)/);
  });
  it("refuses an older store when the installed release names no role image to upgrade it with", () => {
    oldBackup();
    write("opt/lares/current/release.json", JSON.stringify({ images: {} }));
    refusedBeforeAnything(run(base()), /names no creative role image by digest/);
  });
  it("refuses an older store when the provisioner credential is missing", () => {
    oldBackup();
    rmSync(join(prefix, "etc/lares/secrets/workflow-provisioner-password"));
    refusedBeforeAnything(run(base()), /workflow provisioner credential .* is missing or unsafe/);
  });

  it("an upgrade that fails stops before the main database is replaced, and the same restore then succeeds", () => {
    oldBackup();
    const failed = run(base(), { env: { STORE_UPGRADE_FAIL: "1" } });
    expect(failed.code, failed.all).toBe(75);
    expect(failed.all).toContain(`the agent store ${workflowDatabase}: the upgrade failed (stub). This restore stopped while upgrading the agent stores`);
    expect(failed.all).toContain("so this server still counts as a fresh install");
    expect(failed.all).toContain("Fix the cause and run the same restore command again");
    expect(logLines().filter((line) => /dropdb .*lares_state$|dropdb .*litellm$|^pnpm .*migrate| up -d$/.test(line))).toEqual([]);
    expect(logLines().filter((line) => /apply-database/.test(line))).toEqual([]);
    expect(readdirSync(join(prefix, "srv/lares/agents"))).toEqual([]);
    expect(runsLeft()).toEqual([]);
    expect(scratchLeft()).toEqual([]);

    writeFileSync(log, "");
    const again = run(base());
    expect(again.code, again.all).toBe(0);
    expect(idx(storeStep("upgrade"))).toBeGreaterThan(idx(new RegExp(`dropdb .*${workflowDatabase}`)));
    expect(idx(/compose --env-file \S+keeper\.env up -d$/)).toBeGreaterThan(-1);
  });

  it("names the snapshot \"latest\" stood for, and says to run again with it, when an upgrade fails", () => {
    oldBackup();
    const short = NEWER_SNAPSHOT.slice(0, 8);
    const failed = run(latest(), { env: { STORE_UPGRADE_FAIL: "1" } });
    expect(failed.code, failed.all).toBe(75);
    expect(failed.all).toContain(`This restore stopped while upgrading the agent stores from snapshot ${short}, before`);
    expect(failed.all).toContain(`Fix the cause and run the same restore command again, with --snapshot ${short} in place of latest, so that it reads this same snapshot even if a newer one has been written since: it restores every agent store`);
    expect(failed.all).not.toContain("snapshot latest");
    // The run then really does read the same snapshot by its id.
    writeFileSync(log, "");
    const again = run(["--snapshot", short, "--yes", "--old-server-stopped"]);
    expect(again.code, again.all).toBe(0);
    expect(logLines().find((l) => l.startsWith("restic") && l.includes(" restore "))).toMatch(new RegExp(` restore ${short} --target `));
  });

  it("a store whose backup file cannot be restored names the snapshot \"latest\" stood for", () => {
    const short = NEWER_SNAPSHOT.slice(0, 8);
    const failed = run(latest(), { env: { PG_RESTORE_FAIL_DB: workflowDatabase } });
    expect(failed.code, failed.all).toBe(75);
    expect(failed.all).toContain(`This restore stopped while restoring the agent stores from snapshot ${short}. Nothing outside the agent stores was changed`);
    expect(failed.all).toContain(`Run the same restore command again, with --snapshot ${short} in place of latest, so that it reads this same snapshot even if a newer one has been written since. If the backup file`);
  });

  it("when its cleanup is uncertain after a failed upgrade step, says the next run will be refused and what to check and remove first", () => {
    oldBackup();
    // A fresh install has target Vault stores, and restore holds their locks through the store loop.
    const vaultLocks = addTargetVault();
    rmSync(join(binDir, "pnpm"));
    const ENGINE = `registry.example/lares-keeper@sha256:${"d".repeat(64)}`;
    const failed = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE, RESTORE_CLIENT_CIDFILE_MISSING_FOR: "keeper:workflow-apply-database" } });
    expect(failed.code, failed.all).toBe(75);
    expect(failed.all).toContain("its permissions could not be applied and verified");
    expect(failed.all).toContain("Fix the cause and run the same restore command again");
    const runsRoot = join(prefix, "var/lib/lares-maintenance/restore-runs");
    const [runName] = restoreRunNames(runsRoot);
    const runDirectory = join(runsRoot, runName!);
    const [scratch] = scratchLeft();
    expect(failed.all).toContain('restore: the message above says to run the same restore again, but for now that run would be refused ("could not create a private restore work record")');
    expect(failed.all).toContain("docker ps --all --filter name=lares-restore- --filter name=lares-workflow-store- must list nothing; remove anything it lists with docker rm --force <name>");
    expect(failed.all).toContain(`remove the private scratch folder, which holds decrypted backup files: rm -rf ${join(scratchParent, scratch!)}`);
    expect(failed.all).toContain(`remove this run's record and its claim: rm -rf ${runDirectory} ${runsRoot}/restore-active.lock`);
    expect(vaultLocks.length).toBeGreaterThan(0);
    for (const lock of vaultLocks) {
      const real = lock;
      const mark = readFileSync(real, "utf8");
      expect(mark).toMatch(/^[a-f0-9]{32}$/);
      expect(failed.all).toContain(`once the docker check lists nothing, remove the Vault lock this run left: rm -f ${real} (it holds this run's mark ${mark};`);
    }
    // The advice is right on both counts: refused as it says, then fine once everything it names
    // is gone (left in place, the Vault locks would refuse it as "target Vault repositories are busy").
    const refused = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE } });
    expect(refused.code).toBe(78);
    expect(refused.all).toContain("could not create a private restore work record");
    rmSync(join(scratchParent, scratch!), { recursive: true, force: true });
    rmSync(runDirectory, { recursive: true, force: true });
    rmSync(join(runsRoot, "restore-active.lock"));
    for (const lock of vaultLocks) rmSync(lock);
    // The stub's store was upgraded by the first run; the next run restores it from the backup again.
    rmSync(join(workflowStoreDir, workflowDatabase), { force: true });
    const again = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE } });
    expect(again.code, again.all).toBe(0);
    // Three whole restore runs, one with a Vault: past 15 s on a busy machine.
  }, 60_000);

  it("says nothing about a refused next run when cleanup is uncertain but no message advised one", () => {
    const ENGINE = `registry.example/lares-keeper@sha256:${"d".repeat(64)}`;
    rmSync(join(binDir, "pnpm"));
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE, RESTORE_CLIENT_CIDFILE_MISSING: "1" } });
    expect(r.code).toBe(75);
    expect(r.all).toContain("cleanup is uncertain");
    expect(r.all).not.toContain("the message above says to run the same restore again");
  });

  it("a store whose backup file cannot be restored says the server is still fresh, and the same restore then succeeds", () => {
    const failed = run(base(), { env: { PG_RESTORE_FAIL_DB: workflowDatabase } });
    expect(failed.code, failed.all).toBe(75);
    expect(failed.all).toContain(`pg_restore could not create database ${workflowDatabase} with its archived ownership and grants. This restore stopped while restoring the agent stores from snapshot abc123. Nothing outside the agent stores was changed, so this server still counts as a fresh install.`);
    expect(failed.all).toContain("Run the same restore command again. If the backup file of an agent store is damaged it will stop here again: then list the snapshots with restic snapshots and restore an earlier one.");
    expect(failed.all).not.toContain("rebuild a clean server");
    expect(logLines().filter((line) => /dropdb .*lares_state$|dropdb .*litellm$|^pnpm .*migrate| up -d$/.test(line))).toEqual([]);
    writeFileSync(log, "");
    expect(run(base()).code).toBe(0);
  });

  it("with prepared financial custody, a re-run after a failed upgrade freezes the ledger again through the host command and finishes", () => {
    oldBackup();
    write("etc/lares/keeper.json", keeperConfig({ budgetFinancial: financialBinding() }));
    mkdirSync(join(prefix, "var/lib/lares/budget-financial"), { recursive: true });
    const freezes = () => logLines().filter((line) => /budget-financial\.ts freeze --host/.test(line));
    const failed = run(base(), { env: { STORE_UPGRADE_FAIL: "1" } });
    expect(failed.code, failed.all).toBe(75);
    expect(failed.all).toContain("This restore stopped while upgrading the agent stores");
    expect(freezes()).toHaveLength(1);
    expect(freezes()[0]).toMatch(/^docker compose .*exec -T lares-keeper /);
    // The keeper is stopped now, so the second run's freeze goes to the host command.
    writeFileSync(log, "");
    const again = run(base(), { env: { FREEZE_LIVE_FAIL: "1" } });
    expect(again.code, again.all).toBe(0);
    expect(freezes().map((line) => line.split(" ")[0])).toEqual(["docker", "pnpm"]);
    expect(again.all).toContain("Financial recovery is required. Protected custody remains permanently frozen");
    expect(idx(storeStep("upgrade"))).toBeGreaterThan(idx(/^pnpm .*budget-financial\.ts freeze --host/));
  });

  it("a refused freeze on a re-run does not claim the earlier run changed nothing", () => {
    write("etc/lares/keeper.json", keeperConfig({ budgetFinancial: financialBinding() }));
    mkdirSync(join(prefix, "var/lib/lares/budget-financial"), { recursive: true });
    stub("pnpm", "exit 1");
    const r = run(base(), { env: { FREEZE_LIVE_FAIL: "1" } });
    expect(r.code, r.all).toBe(78);
    expect(r.all).toContain("financial freeze was not durably acknowledged; this run stopped no service and replaced no database (an earlier run of this same restore may already have stopped services and restored agent stores)");
  });

  it("refuses, changing nothing, while a store step from an earlier attempt is still running, and goes ahead once it has ended", () => {
    oldBackup();
    write("etc/lares/keeper.json", keeperConfig({ budgetFinancial: financialBinding() }));
    mkdirSync(join(prefix, "var/lib/lares/budget-financial"), { recursive: true });
    const leftover = "lares-workflow-store-0123456789abcdef";
    const refused = run(base(), { env: { RESTORE_LEFTOVER_STORE_STEP: leftover } });
    expect(refused.code, refused.all).toBe(78);
    expect(refused.all).toContain(`an agent store step from an earlier attempt is still running (${leftover}).`);
    expect(refused.all).toContain("Wait until it ends (docker ps --filter label=lares.maintenance=workflow-store lists it until then), or stop it with docker rm --force <name>, then run the same restore again.");
    expect(refused.all).toContain("This run has changed nothing (an earlier run of this same restore may already have stopped services and restored agent stores).");
    expect(refused.all).not.toContain("Nothing has been changed.");
    // Not even the financial freeze: nothing this run would do has started.
    expect(changes()).toEqual([]);
    expect(logLines().filter((line) => /budget-financial\.ts|workflow-store.* (check|upgrade) /.test(line))).toEqual([]);
    expect(runsLeft()).toEqual([]);
    expect(scratchLeft()).toEqual([]);

    writeFileSync(log, "");
    const again = run(base());
    expect(again.code, again.all).toBe(0);
    expect(idx(storeStep("upgrade"))).toBeGreaterThan(-1);
  });

  it("refuses, changing nothing, when Docker cannot say whether a store step is still running", () => {
    oldBackup();
    const r = run(base(), { env: { RESTORE_LEFTOVER_PS_RC: "1" } });
    expect(r.code, r.all).toBe(78);
    expect(r.all).toContain("I could not ask Docker whether an agent store step from an earlier attempt is still running. This run has changed nothing");
    expect(changes()).toEqual([]);
  });

  it("a store whose check after restoring is not the older layout stops the same re-runnable way", () => {
    oldBackup();
    writeFileSync(join(workflowStoreDir, workflowDatabase), "current\n");
    const r = run(base());
    expect(r.code, r.all).toBe(75);
    expect(r.all).toContain("its own check says 'current'");
    expect(logLines().filter((line) => /dropdb .*lares_state$/.test(line))).toEqual([]);
  });

  it("a permission step that fails stops the same re-runnable way", () => {
    oldBackup();
    stub("pnpm", 'case "$*" in *apply-database*) echo "Workflow database contains an unknown row policy" >&2; exit 1 ;; esac; exit 0');
    const r = run(base());
    expect(r.code, r.all).toBe(75);
    expect(r.all).toContain(`the agent store ${workflowDatabase}: its permissions could not be applied and verified (Workflow database contains an unknown row policy)`);
    expect(logLines().filter((line) => /dropdb .*lares_state$/.test(line))).toEqual([]);
    expect(runsLeft()).toEqual([]);
  });
});
