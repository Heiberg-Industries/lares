// update.sh is the command that changes which images this installation runs.
// It can lose data if it is wrong, so these tests drive the WHOLE ordering with stubs and
// assert the exact sequence of external calls, not merely the exit code:
//
//   release read -> backup status read -> backup.sh -> the record of what is running now
//   -> docker compose pull -> migrate -> docker compose up -d -> health check -> record closed
//
// Every external command the script reaches for is a stub on PATH that appends its own argv
// to one shared log file (STUB_LOG), in the style of tests/restore-drill.test.ts. The one
// thing that is NOT stubbed is the release-file read: that runs the real `node` against the
// real services/box/lib/release-manifest.ts, so "a release named by a tag is refused" is a
// test of the engine's own rule rather than of a stub that restates it.
//
// No real docker, Postgres, restic or network is ever touched, and no server exists.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, chownSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "update.sh");

const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
const CONSOLE_OLD = `registry.example/lares-console@sha256:${OLD}`;
const CONSOLE_NEW = `registry.example/lares-console@sha256:${NEW}`;
const ROLE_OLD = `registry.example/lares-chief-of-staff@sha256:${OLD}`;
const ROLE_NEW = `registry.example/lares-chief-of-staff@sha256:${NEW}`;
const CREATIVE_NEW = `registry.example/lares-creative@sha256:${"c".repeat(64)}`;
const STORE_A = `lares_${"a".repeat(32)}`;
const STORE_B = `lares_${"b".repeat(32)}`;
const KEEPER_OLD = `registry.example/lares-keeper@sha256:${"d".repeat(64)}`;
const KEEPER_NEW = `registry.example/lares-keeper@sha256:${"e".repeat(64)}`;

let dir: string;
let prefix: string;
let binDir: string;
let opsDir: string;
let composeDir: string;
let composeFile: string;
let release: string;
let log: string;
let operatorPasswordFile: string;

/** A release the fixture installation can actually apply: both images match a running service. */
function goodRelease(breaking: string[] = []) {
  return JSON.stringify({
    release: "2026-10-01",
    images: { console: CONSOLE_NEW, "chief-of-staff": ROLE_NEW, creative: CREATIVE_NEW },
    migrations: { box: "001_baseline.sql" },
    breaking,
  });
}

/** What the installation is running now: two digest-pinned services and one that is not. */
function composeYaml(targetPrefix = prefix) {
  return [
    "services:",
    "  lares-console:",
    `    image: ${CONSOLE_OLD}`,
    "    restart: unless-stopped",
    "  lares-chief-of-staff:",
    `    image: ${ROLE_OLD}`,
    "  db:",
    "    image: postgres:16-alpine",
    "    command: [postgres, -c, hba_file=/run/lares-auth/pg_hba.conf]",
    "    volumes:",
    `      - ${targetPrefix}/var/lib/lares/postgres:/var/lib/postgresql/data`,
    "      - type: bind",
    `        source: ${targetPrefix}/var/lib/lares-maintenance/postgres-auth`,
    "        target: /run/lares-auth",
    "        read_only: true",
    "        bind:",
    "          create_host_path: false",
    "networks:",
    "  lares:",
    "    external: true",
    "",
  ].join("\n");
}

/** Test fixture derived from the committed Keeper service template. The update script rewrites
 * only the image line; this checks that its real output retains the guarded launch fields. */
function keeperComposeYaml(image: string, envFile: string) {
  const template = readFileSync(join(here, "..", "compose.lares-keeper.yaml"), "utf8");
  const committed = parse(template) as {
    services: Record<string, Record<string, unknown>>;
  };
  const keeper = { ...committed.services["lares-keeper"]! };
  keeper.image = image;
  keeper.env_file = [envFile];
  keeper.entrypoint = ["/usr/local/lib/lares/maintenance-admission-v1", "/run/lares-maintenance/admission", "fixture-installation-id", "7", "--"];
  const volumes = keeper.volumes as Array<string | Record<string, unknown>>;
  keeper.volumes = volumes.map((volume) => typeof volume === "string" ? volume :
    volume.target === "/run/lares-maintenance/admission" ? {
      ...volume, source: "/tmp/keeper-admission-fixture", read_only: true,
      bind: { ...(volume.bind as Record<string, unknown>), create_host_path: false },
    } : volume);
  return stringify({ services: { "lares-keeper": keeper } });
}

function stub(name: string, body: string, where = binDir) {
  const path = join(where, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "update-script-"));
  prefix = join(dir, "prefix");
  mkdirSync(prefix, { mode: 0o755 });
  binDir = join(dir, "bin");
  opsDir = join(dir, "ops");
  composeDir = join(prefix, "opt", "lares");
  mkdirSync(binDir);
  mkdirSync(opsDir);
  mkdirSync(composeDir, { recursive: true });
  execFileSync("python3", [join(here, "..", "ops", "maintenance-custody.py"), "prepare-fresh", prefix,
    "172.30.0.0/24", "--confirm-fresh", "--test-owner"], {
    env: { ...process.env, LARES_MAINTENANCE_TESTING: "1" },
  });
  mkdirSync(join(prefix, "etc", "lares", "secrets"), { recursive: true });
  mkdirSync(join(prefix, "etc", "lares", "operator"), { recursive: true });
  const appPasswordFile = join(prefix, "etc", "lares", "secrets", "database-password");
  writeFileSync(appPasswordFile, "fixture-only-db-password\n", { mode: 0o440 });
  chownSync(appPasswordFile, process.getuid!(), process.getgid!());
  chmodSync(appPasswordFile, 0o440);
  // The logins the agent-store step uses: read inside a short-lived container, never by the script.
  for (const name of ["workflow-provisioner-password", "workflow-password"])
    writeFileSync(join(prefix, "etc", "lares", "secrets", name), "fixture-only-workflow-password\n", { mode: 0o600 });
  composeFile = join(composeDir, "compose.yaml");
  writeFileSync(composeFile, composeYaml(prefix));
  release = join(dir, "release.json");
  writeFileSync(release, goodRelease());
  log = join(dir, "calls.log");
  operatorPasswordFile = join(prefix, "etc", "lares", "operator", "database-password");
  writeFileSync(operatorPasswordFile, "test-only-operator-password\n", { mode: 0o600 });
  chownSync(operatorPasswordFile, process.getuid!(), process.getgid!());
  chmodSync(operatorPasswordFile, 0o600);

  // Every stub logs its own argv, one call per line, to the one shared log — the order of
  // those lines IS the property most of these tests are about.
  const logLine = 'printf "%s %s\\n" "$(basename "$0")" "$*" >> "$STUB_LOG"';

  stub("stat", "echo 0:600");

  // docker: dispatches on shape the way the real CLI answers different subcommands.
  //  - `compose ... config`     -> the database image operator_db_run reads
  //  - `compose ... exec ... db` -> refused, as pg_hba refuses the app's local socket on a server
  //  - `run ... psql ... -tAc`   -> the backup_status row the test staged, read as the operator
  //  - `... pull`               -> succeeds unless STUB_PULL_FAIL
  //  - `... up -d`              -> succeeds unless STUB_UP_FAIL
  //  - `... ps --services ...`  -> the services the test says are running
  stub(
    "docker",
    [
      logLine,
      'args="$*"',
      'case "$args" in',
      // The agent-store step in the role image: `check` answers per database (STUB_STORE_STATES is
      // "database=state ..."; anything not named is `current`), and a database that was migrated
      // answers `current` from then on, as a real one does.
      '  *"lares_workflow_provisioner@"*" sh check "*)',
      '    database="${args##* }"',
      '    case " ${STUB_CHECK_FAIL:-} " in *" $database "*) echo "workflow store: it was not left by the previous release: it has 19 schema steps recorded" >&2; exit 3 ;; esac',
      '    if [ -f "$STUB_LOG.migrated" ] && grep -qx "$database" "$STUB_LOG.migrated"; then echo current; exit 0; fi',
      '    state=current',
      '    for pair in ${STUB_STORE_STATES:-}; do [ "${pair%%=*}" != "$database" ] || state="${pair#*=}"; done',
      '    echo "$state"',
      "    ;;",
      '  *"lares_workflow_provisioner@"*" sh upgrade "*)',
      '    database="${args##* }"',
      '    case " ${STUB_STORE_MIGRATE_FAIL:-} " in *" $database "*) echo "workflow store: canceling statement due to lock timeout" >&2; exit 1 ;; esac',
      '    echo "$database" >> "$STUB_LOG.migrated"',
      "    ;;",
      '  *"keeper.env stop lares-keeper"*)',
      '    [ -z "${STUB_KEEPER_STOP_FAIL:-}" ] || { echo "docker: cannot stop container" >&2; exit 1; }',
      "    ;;",
      '  *"compose.lares-agents.yaml ps --services"*)',
      '    [ -z "${STUB_AGENTS_PS_FAIL:-}" ] || exit 1',
      '    [ -f "$STUB_LOG.agents-stopped" ] || printf "%s\\n" ${STUB_AGENTS_RUNNING-lares-example-agent lares-other-agent}',
      "    ;;",
      '  *"compose.lares-agents.yaml start"*)',
      '    [ -z "${STUB_AGENTS_START_FAIL:-}" ] || exit 1',
      '    rm -f "$STUB_LOG.agents-stopped"',
      "    ;;",
      '  *"compose.lares-agents.yaml stop"*)',
      '    [ -z "${STUB_AGENTS_STOP_FAIL:-}" ] || { echo "docker: cannot stop container" >&2; exit 1; }',
      '    : > "$STUB_LOG.agents-stopped"',
      "    ;;",
      '  *"config --format json"*)',
      '    printf \'{"services":{"db":{"image":"postgres:16"}}}\\n\'',
      "    ;;",
      '  *"exec -T db"*)',
      '    echo "psql: error: FATAL:  pg_hba.conf rejects connection for host \\"[local]\\"" >&2; exit 2',
      "    ;;",
      '  *"run --rm"*PGUSER=lares_operator*psql*-tAc*)',
      '    [ -z "${STUB_STATUS_FAIL:-}" ] || exit 1',
      '    printf "%s\\n" "${STUB_BACKUP_STATUS-t|3600}"',
      "    ;;",
      '  "pull "*)',
      '    [ -z "${STUB_ROLE_PULL_FAIL:-}" ] || { echo "docker: manifest unknown" >&2; exit 1; }',
      "    ;;",
      '  *" pull"*|*" pull "*)',
      '    [ -z "${STUB_PULL_FAIL:-}" ] || { echo "docker: manifest unknown" >&2; exit 1; }',
      "    ;;",
      // An agent's container, found by its compose labels. Every agent has one (its id is the
      // service name in hex) until `docker rm` removes it, unless STUB_NO_CONTAINER names it.
      '  *"ps --all --quiet --filter label=com.docker.compose.project="*)',
      '    [ -z "${STUB_CONTAINER_PS_FAIL:-}" ] || exit 1',
      '    service="${args##*com.docker.compose.service=}"',
      '    case " ${STUB_NO_CONTAINER:-} " in *" $service "*) exit 0 ;; esac',
      '    id=$(printf "%s" "$service" | od -An -tx1 | tr -d " \\n")',
      '    if [ -z "${STUB_RM_LEAVES:-}" ] && [ -f "$STUB_LOG.removed" ] && grep -qx "$id" "$STUB_LOG.removed"; then exit 0; fi',
      '    echo "$id"',
      "    ;;",
      '  "rm "*)',
      '    [ -z "${STUB_RM_FAIL:-}" ] || { echo "Error response from daemon: cannot remove container: container is running" >&2; exit 1; }',
      '    for id in ${args#rm }; do echo "$id" >> "$STUB_LOG.removed"; done',
      "    ;;",
      '  *"up -d"*)',
      '    [ -z "${STUB_UP_FAIL:-}" ] || { echo "docker: could not start" >&2; exit 1; }',
      "    ;;",
      '  *ps*--services*)',
      '    printf "%s\\n" ${STUB_RUNNING-lares-console lares-chief-of-staff}',
      "    ;;",
      "esac",
      "exit 0",
    ].join("\n"),
  );

  // pnpm: only ever called for the migration runner here.
  stub(
    "pnpm",
    [
      logLine,
      'case "$*" in',
      // update-plan: the template, then one line per agent store (STUB_STORES is "database:agent ...").
      "  *update-plan*)",
      '    [ -z "${STUB_PLAN_FAIL:-}" ] || { echo "workflow stores: $STUB_PLAN_FAIL" >&2; exit 1; }',
      '    case "$*" in *--require-quiet*) [ -z "${STUB_QUIET_FAIL:-}" ] || { echo "workflow stores: something is still connected to $STUB_QUIET_FAIL (1)" >&2; exit 1; } ;; esac',
      '    printf "template\\tempty_workflow\\n"',
      '    for pair in ${STUB_STORES:-}; do printf "store\\t%s\\t%s\\n" "${pair%%:*}" "${pair#*:}"; done',
      "    ;;",
      // Permissions: STUB_PERMISSIONS_STALE names databases (or `template`) whose check fails until
      // their permissions have been applied, as a store missing one grant does.
      '  *"workflow-template.ts apply"*)',
      '    for database in ${STUB_APPLY_FAIL:-}; do case "$*" in *"$database"*) echo "Workflow runtime table privileges are incomplete" >&2; exit 1 ;; esac; done',
      '    all="$*"; target=template; case "$all" in *"--database "*) target="${all#*--database }"; target="${target%% *}" ;; esac',
      '    echo "$target" >> "$STUB_LOG.applied"',
      "    ;;",
      '  *"workflow-template.ts verify-database"*|*--verify-workflow-template*)',
      '    for database in ${STUB_VERIFY_FAIL:-}; do case "$*" in *"$database"*) echo "Workflow schema step record is not at the pinned head (20 recorded, 30 expected)" >&2; exit 1 ;; esac; done',
      '    all="$*"; target=template; case "$all" in *"--database "*) target="${all#*--database }"; target="${target%% *}" ;; esac',
      '    case " ${STUB_PERMISSIONS_STALE:-} " in *" $target "*) grep -qx "$target" "$STUB_LOG.applied" 2>/dev/null || { echo "Workflow runtime function privileges are incomplete" >&2; exit 1; } ;; esac',
      "    ;;",
      "  *migrate*)",
      '    [ -z "${STUB_MIGRATE_FAIL:-}" ] || { echo "migrations: 052 is out of order" >&2; exit 1; }',
      "    ;;",
      "esac",
      "exit 0",
    ].join("\n"),
  );

  // backup.sh: the real one takes a restic snapshot; this one just says it did.
  stub(
    "backup.sh",
    [
      logLine,
      '[ -z "${STUB_BACKUP_FAIL:-}" ] || { echo "backup: postgres unreachable" >&2; exit 1; }',
      'echo "snapshot ${STUB_SNAPSHOT:-9f8e7d6c} saved"',
      "exit 0",
    ].join("\n"),
    opsDir,
  );

  // The recorder: the seam that stands in for beginUpdate/finishUpdate against a real
  // database. `begin` prints the new row's id; a non-zero exit is exactly what the real
  // recorder does when the table is missing or the database is unreachable.
  stub(
    "record",
    [
      logLine,
      'case "$1" in',
      "  begin)",
      '    [ -z "${STUB_BEGIN_FAIL:-}" ] || { echo "relation \\"update_history\\" does not exist" >&2; exit 1; }',
      '    echo "41"',
      "    ;;",
      "  previous-release)",
      '    printf "%s\\n" "${STUB_PREVIOUS_RELEASE-2026-09-01}"',
      "    ;;",
      "esac",
      "exit 0",
    ].join("\n"),
  );
  // The macOS test host may not ship coreutils timeout; production installs run on Linux.
  // This pass-through keeps isolated Docker stubs fast without changing production behavior.
  // timeout: runs the command, except that STUB_TIMEOUT_EXPIRES makes an agent-store upgrade run out of time.
  stub("timeout", [
    'if [[ "$1" == --kill-after=* ]]; then shift; elif [ "$1" = --kill-after ]; then shift 2; fi',
    'printf "%s\\n" "$1" >> "$STUB_LOG.limits"; shift',
    // Ran out of time: the command was started (so it is logged) and never answered.
    'case "$*" in *" sh upgrade "*) [ -z "${STUB_TIMEOUT_EXPIRES:-}" ] || { printf "%s\\n" "$*" >> "$STUB_LOG"; exit 124; } ;; esac',
    'exec "$@"',
  ].join("\n"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}) {
  try {
    const childEnv: Record<string, string> = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      STUB_LOG: log,
      LARES_OPS_DIR: opsDir,
      LARES_PREFIX: prefix,
      DB_COMPOSE_DIR: composeDir,
      UPDATE_COMPOSE_FILES: "compose.yaml",
      LARES_UPDATE_RECORDER: join(binDir, "record"),
      LARES_OPERATOR_PASSWORD_FILE: operatorPasswordFile,
      LARES_MAINTENANCE_TESTING: "1",
      ...env,
    };
    if (env.UNSET_DB_COMPOSE_DIR === "1") delete childEnv.DB_COMPOSE_DIR;
    delete childEnv.UNSET_DB_COMPOSE_DIR;
    const stdout = execFileSync("/bin/bash", [SCRIPT, ...args], {
      env: childEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}

const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
/** Where a call matching `re` first appears in the log, or -1 — the ordering primitive. */
function at(re: RegExp): number {
  const text = calls();
  const m = re.exec(text);
  return m ? m.index : -1;
}
const PULL = /docker compose .*\bpull\b/;
const UP = /docker compose .*up -d/;
const MIGRATE = /pnpm .*migrate/;
const BACKUP = /backup\.sh/;
const BEGIN = /record begin/;
const compose = () => readFileSync(composeFile, "utf8");
function expectNormalAuthCompose() {
  const db = (parse(compose()) as { services: Record<string, { command?: string | string[]; volumes?: Array<string | { type?: string; source?: string; target?: string; read_only?: boolean; bind?: { create_host_path?: boolean } }> }> }).services.db!;
  expect(Array.isArray(db.command) ? db.command.join(" ") : db.command).toContain("hba_file=/run/lares-auth/pg_hba.conf");
  const mount = db.volumes?.find((volume) => typeof volume !== "string" && volume.target === "/run/lares-auth");
  expect(mount).toMatchObject({ type: "bind", source: `${prefix}/var/lib/lares-maintenance/postgres-auth`, target: "/run/lares-auth", read_only: true, bind: { create_host_path: false } });
  if (process.env.CI === "true") {
    const effective = JSON.parse(execFileSync("docker", ["compose", "-f", composeFile, "config", "--format", "json"], { encoding: "utf8" })) as {
      services: { db?: { command?: string[]; volumes?: Array<{ type?: string; source?: string; target?: string; read_only?: boolean; bind?: { create_host_path?: boolean } }> } };
    };
    expect(effective.services.db?.command).toEqual(["postgres", "-c", "hba_file=/run/lares-auth/pg_hba.conf"]);
    const effectiveAuthMount = effective.services.db?.volumes?.find((volume) => volume.source === `${prefix}/var/lib/lares-maintenance/postgres-auth` && volume.target === "/run/lares-auth");
    expect(effectiveAuthMount).toMatchObject({ type: "bind", source: `${prefix}/var/lib/lares-maintenance/postgres-auth`, target: "/run/lares-auth", read_only: true });
    const bind = effectiveAuthMount?.bind;
    expect(bind !== undefined && bind !== null && typeof bind === "object" && !Array.isArray(bind) &&
      (!("create_host_path" in bind) || bind.create_host_path === false)).toBe(true);
  }
}

describe("updating this installation", { timeout: 30_000 }, () => {
  it("refuses a different Compose or database target before any update work", () => {
    const wrongCompose = run(["--release", release, "--dry-run"], { DB_COMPOSE_DIR: join(dir, "other-compose") });
    expect(wrongCompose.code).toBe(78);
    expect(calls()).toBe("");
    const wrongDatabase = run(["--release", release, "--dry-run"], { PGHOST: "192.0.2.10" });
    expect(wrongDatabase.code).toBe(78);
    expect(calls()).toBe("");
  });

  it("rewrites the real script's Keeper fixture image while preserving its guarded launch and identity", () => {
    const keeperCompose = join(composeDir, "keeper.yaml");
    const keeperEnv = join(composeDir, "keeper.env");
    const identityEnv = "LARES_MAINTENANCE_INSTALLATION_ID=fixture-installation-id\nLARES_MAINTENANCE_EPOCH=7\n";
    writeFileSync(keeperCompose, keeperComposeYaml(KEEPER_OLD, keeperEnv));
    writeFileSync(keeperEnv, identityEnv);
    writeFileSync(release, JSON.stringify({
      release: "2026-10-01",
      images: { console: CONSOLE_NEW, "chief-of-staff": ROLE_NEW, creative: CREATIVE_NEW, "lares-keeper": KEEPER_NEW },
      migrations: { box: "001_baseline.sql" }, breaking: [],
    }));

    const r = run(["--release", release, "--yes"], {
      UPDATE_COMPOSE_FILES: "compose.yaml keeper.yaml",
      STUB_RUNNING: "lares-console lares-chief-of-staff lares-keeper",
    });
    expect(r.code).toBe(0);
    const output = parse(readFileSync(keeperCompose, "utf8")) as {
      services: { "lares-keeper": { image?: string; entrypoint?: string[]; volumes?: Array<string | { source?: string; target?: string; read_only?: boolean; bind?: { create_host_path?: boolean } }> } };
    };
    const service = output.services["lares-keeper"];
    expect(service.image).toBe(KEEPER_NEW);
    expect(service.entrypoint).toEqual(["/usr/local/lib/lares/maintenance-admission-v1", "/run/lares-maintenance/admission", "fixture-installation-id", "7", "--"]);
    expect(service.volumes).toContainEqual(expect.objectContaining({ source: "/tmp/keeper-admission-fixture", target: "/run/lares-maintenance/admission", read_only: true, bind: { create_host_path: false } }));
    expect(readFileSync(keeperEnv, "utf8")).toBe(identityEnv);
  });

  it("takes a backup FIRST, and only then touches anything", () => {
    const r = run(["--release", release, "--yes"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(at(BACKUP)).toBeGreaterThan(-1);
    expect(at(BACKUP)).toBeLessThan(at(PULL));
    expect(at(BACKUP)).toBeLessThan(at(MIGRATE));
    expect(at(BACKUP)).toBeLessThan(at(UP));
  });

  it("runs its steps in exactly one order, and closes the record last", () => {
    run(["--release", release, "--yes"]);
    const sequence = calls()
      .trim()
      .split("\n")
      .map((line) => {
        if (/^record /.test(line)) return line.split(" ").slice(0, 2).join(" ");
        if (/config --format json/.test(line)) return "";
        if (/^docker image inspect /.test(line)) return "is the role image here";
        if (/update-plan/.test(line)) return "list the agent stores";
        if (/ sh check /.test(line)) return "check a store";
        if (/psql/.test(line)) return "read backup status";
        if (/--verify-workflow-template|workflow-template\.ts verify-database/.test(line)) return "check a store's permissions";
        if (PULL.test(line)) return "docker compose pull";
        if (/^docker pull /.test(line)) return "docker pull";
        if (UP.test(line)) return "docker compose up -d";
        if (/ps --services/.test(line)) return "docker compose ps";
        if (MIGRATE.test(line)) return "migrate";
        return line.split(" ")[0]!;
      })
      .filter(Boolean);
    expect(sequence).toEqual([
      // The look at the agent stores comes before everything, and changes nothing. Here every
      // store is already at this release, so nothing is stopped and nothing else is added.
      "is the role image here",
      "list the agent stores",
      "check a store",
      "read backup status",
      "backup.sh",
      "record previous-release",
      "record begin",
      "docker compose pull",
      "docker pull",
      "docker pull",
      "migrate",
      // No store needed upgrading, so each one's permissions are checked (here only the template's)
      // before the switch; they pass, so nothing is applied.
      "check a store's permissions",
      "docker compose up -d",
      "docker compose ps",
      "record finish",
    ]);
  });

  it("reads the backup check as the operator, never over the database's local socket", () => {
    const r = run(["--release", release, "--yes"]);
    expect(r.code).toBe(0);
    expect(calls()).not.toMatch(/exec -T db/);
    expect(calls()).toMatch(/^docker run --rm .*PGUSER=lares_operator .*psql .*-tAc .*backup_status/m);
    // The operator's password goes in as a mounted file, never as a value on the command line.
    expect(calls()).not.toContain("test-only-operator-password");
  });

  it("stops when the backup fails, and changes nothing at all", () => {
    const r = run(["--release", release, "--yes"], { STUB_BACKUP_FAIL: "1" });
    expect(r.code).toBe(75);
    expect(calls()).not.toMatch(PULL);
    expect(calls()).not.toMatch(MIGRATE);
    expect(calls()).not.toMatch(BEGIN);
    expect(r.stderr).toMatch(/backup/i);
    expect(compose()).toBe(composeYaml());
    expectNormalAuthCompose();
  }, 15_000);

  it("stops when the backup was never verified, unless told otherwise in so many words", () => {
    const unproven = { STUB_BACKUP_STATUS: "|" };
    const refused = run(["--release", release, "--yes"], unproven);
    expect(refused.code).toBe(78);
    expect(refused.stderr).toMatch(/never been verified/);
    expect(refused.stderr).toMatch(/--even-though-the-backup-is-unproven/);
    // Nothing that changes anything was reached: no backup, no record, no pull, no switch.
    expect(calls()).not.toMatch(BACKUP);
    expect(calls()).not.toMatch(BEGIN);
    expect(calls()).not.toMatch(PULL);
    expect(calls()).not.toMatch(UP);
    expect(compose()).toBe(composeYaml());

    rmSync(log, { force: true });
    const allowed = run(["--release", release, "--yes", "--even-though-the-backup-is-unproven"], unproven);
    expect(allowed.code).toBe(0);
    expect(calls()).toMatch(PULL);
  });

  it("stops when the last verification failed, and when it is too old", () => {
    const failed = run(["--release", release, "--yes"], { STUB_BACKUP_STATUS: "f|3600" });
    expect(failed.code).toBe(78);
    expect(failed.stderr).toMatch(/did not pass/);

    rmSync(log, { force: true });
    const stale = run(["--release", release, "--yes"], { STUB_BACKUP_STATUS: "t|360000" });
    expect(stale.code).toBe(78);
    expect(stale.stderr).toMatch(/100h ago/);
    expect(calls()).not.toMatch(BACKUP);
  });

  it("writes the override down in the record, so nobody has to remember it", () => {
    const r = run(["--release", release, "--yes", "--even-though-the-backup-is-unproven"], {
      STUB_BACKUP_STATUS: "|",
    });
    expect(r.code).toBe(0);
    const finish = /record finish .*/.exec(calls())![0];
    expect(finish).toContain("ok");
    expect(finish).toContain("--even-though-the-backup-is-unproven");
  });

  it("writes down what is running before it pulls anything", () => {
    run(["--release", release, "--yes"]);
    expect(at(BEGIN)).toBeGreaterThan(-1);
    expect(at(BEGIN)).toBeLessThan(at(PULL));
    // The digests it wrote down are the ones the compose file had, not the ones it is
    // about to install — that is the whole point of the record.
    const begin = /record begin .*/.exec(calls())![0];
    expect(begin).toContain(CONSOLE_OLD);
    expect(begin).toContain(ROLE_OLD);
    expect(begin).not.toContain(CONSOLE_NEW);
    // A service whose image is not a digest cannot be put back, so it is not claimed.
    expect(begin).not.toContain("postgres");
    expect(begin).toContain("2026-09-01"); // the release it is coming from
  });

  it("refuses a release whose images are not digests, before the backup", () => {
    writeFileSync(
      release,
      JSON.stringify({
        release: "x",
        images: { console: "registry.example/lares-console:newest" },
        migrations: { box: "y" },
        breaking: [],
      }),
    );
    const r = run(["--release", release, "--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/console/);
    expect(calls()).toBe("");
    expect(compose()).toBe(composeYaml());
  });

  it("refuses before pulling anything when it cannot write down what is running", () => {
    const r = run(["--release", release, "--yes"], { STUB_BEGIN_FAIL: "1" });
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/could not write down what is running/);
    expect(r.stderr).toMatch(/001_baseline\.sql/);
    expect(calls()).not.toMatch(PULL);
    expect(calls()).not.toMatch(UP);
    expect(compose()).toBe(composeYaml());
  });

  it("refuses when the compose file names no digest at all, rather than guessing", () => {
    writeFileSync(composeFile, "services:\n  db:\n    image: postgres:16-alpine\n");
    const r = run(["--release", release, "--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/could not write down what is running/);
    expect(calls()).not.toMatch(BACKUP);
    expect(calls()).not.toMatch(PULL);
  });

  it("applies migrations before the new images start, and stops on a refusal", () => {
    const r = run(["--release", release, "--yes"], { STUB_MIGRATE_FAIL: "1" });
    expect(r.code).toBe(70);
    expect(r.stderr).toMatch(/out of order/);
    expect(r.stderr).toMatch(/rollback/);
    // The switch never happened and the compose file is back as it was, so the images
    // that were running before are still the ones running.
    expect(calls()).not.toMatch(UP);
    expect(compose()).toBe(composeYaml());
    expect(calls()).toMatch(/record finish 41 failed/);
  });

  it("leaves the old images running when the pull fails", () => {
    const r = run(["--release", release, "--yes"], { STUB_PULL_FAIL: "1" });
    expect(r.code).toBe(70);
    expect(r.stderr).toMatch(/could not be pulled/);
    expect(calls()).not.toMatch(MIGRATE);
    expect(calls()).not.toMatch(UP);
    expect(compose()).toBe(composeYaml());
    expect(calls()).toMatch(/record finish 41 failed/);
  });

  it("downloads the agents' role images before the switch, so an agent restart never waits on a download", () => {
    const r = run(["--release", release, "--yes"]);
    expect(r.code).toBe(0);
    expect(calls()).toContain(`docker pull ${ROLE_NEW}`);
    expect(calls().indexOf(`docker pull ${ROLE_NEW}`)).toBeLessThan(at(UP));
  });

  it("leaves the old images running when a role image cannot be downloaded", () => {
    const r = run(["--release", release, "--yes"], { STUB_ROLE_PULL_FAIL: "1" });
    expect(r.code).toBe(70);
    expect(calls()).not.toMatch(UP);
    expect(calls()).not.toMatch(MIGRATE);
    expect(compose()).toBe(composeYaml());
    expect(calls()).toMatch(/record finish 41 failed/);
  });

  it("names the rollback command, with the release, whenever it fails after pulling", () => {
    const r = run(["--release", release, "--yes"], { STUB_UP_FAIL: "1" });
    expect(r.code).toBe(70);
    expect(r.stderr).toMatch(/rollback\.sh/);
    expect(calls()).toMatch(/record finish 41 failed/);
  });

  it("stops and says so when a service does not come up, and never switches back by itself", () => {
    const r = run(["--release", release, "--yes"], { STUB_RUNNING: "lares-console" });
    expect(r.code).toBe(70);
    expect(r.stderr).toMatch(/lares-chief-of-staff/);
    expect(r.stderr).toMatch(/will not put them back on its own/);
    expect(r.stderr).toMatch(/rollback\.sh/);
    expect(calls()).toMatch(/record finish 41 failed/);
    // It stopped. It did not pull or start anything a second time.
    expect(calls().match(new RegExp(UP.source, "g"))!.length).toBe(1);
  });

  it("puts the release's digests into the compose file, and leaves everything else alone", () => {
    expect(run(["--release", release, "--yes"]).code).toBe(0);
    expect(compose()).toContain(CONSOLE_NEW);
    expect(compose()).toContain(ROLE_NEW);
    expect(compose()).not.toContain(OLD);
    expect(compose()).toContain("postgres:16-alpine");
    expect(compose()).toContain("restart: unless-stopped");
    expectNormalAuthCompose();
  });

  it("says what it would do and does nothing, on a dry run", () => {
    const r = run(["--release", release, "--dry-run", "--yes"]);
    expect(r.code).toBe(0);
    expect(calls()).not.toMatch(PULL);
    expect(calls()).not.toMatch(BACKUP);
    expect(calls()).not.toMatch(BEGIN);
    expect(r.stdout).toContain(CONSOLE_NEW);
    expect(compose()).toBe(composeYaml());
    expectNormalAuthCompose();
  });

  it("reads the release's breaking changes out loud before it starts", () => {
    writeFileSync(release, goodRelease(["The vault capability is renamed."]));
    const r = run(["--release", release, "--yes"]);
    expect(r.stdout).toContain("The vault capability is renamed.");
    expect(r.stdout.indexOf("The vault capability is renamed.")).toBeLessThan(
      r.stdout.indexOf("2026-10-01 is in place"),
    );
  });

  it("refuses a release that names no image this installation runs", () => {
    writeFileSync(
      release,
      JSON.stringify({
        release: "2026-10-01",
        images: { something: `registry.example/something-else@sha256:${NEW}` },
        migrations: { box: "001_baseline.sql" },
        breaking: [],
      }),
    );
    const r = run(["--release", release, "--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/names no image/);
    expect(calls()).not.toMatch(BACKUP);
  });

  it("refuses an argument it does not know, rather than guessing what was meant", () => {
    expect(run(["--release", release, "--force"]).code).toBe(64);
    expect(run([]).code).toBe(64);
    expect(calls()).toBe("");
  });

  it("asks before it acts when nobody passed --yes", () => {
    const r = run(["--release", release]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/--yes/);
    expect(calls()).not.toMatch(BACKUP);
  });

  it("reaches nothing but the registry, and never by name", () => {
    const text = readFileSync(SCRIPT, "utf8");
    expect(text).not.toMatch(/\bcurl\b|\bwget\b|\bscp\b|\brsync\b/);
    expect(text).not.toContain(":latest");
    expect(text).not.toMatch(/ghcr\.io|docker\.io/);
  });

  it("is bash 3.2 clean", () => {
    expect(() => execFileSync("/bin/bash", ["-n", SCRIPT])).not.toThrow();
  });
});

// IMAGE MODE. On a box whose engine came from an image there is no node and no pnpm: the
// release file is read, the update recorded and the migrations applied by programs run in a
// throwaway container of the engine image. For an update that image must be the TARGET
// release's keeper image (the new release's own migrations are the ones that have to run),
// never the one the box was unpacked from. The docker stub below answers `docker run` by
// running the real release parser from this checkout and logging everything else.
describe("updating a box whose engine is an image", { timeout: 60_000 }, () => {
  const KEEPER_OLD = `registry.example/lares-keeper@sha256:${"d".repeat(64)}`;
  const KEEPER_NEW = `registry.example/lares-keeper@sha256:${"e".repeat(64)}`;
  const BOX = join(here, "..");
  let boxDir: string;
  let prefix: string;

  function releaseWithKeeper(keeper?: string) {
    return JSON.stringify({
      release: "2026-10-01",
      images: { console: CONSOLE_NEW, "chief-of-staff": ROLE_NEW, creative: CREATIVE_NEW, ...(keeper ? { "lares-keeper": keeper } : {}) },
      migrations: { box: "001_baseline.sql" },
      breaking: [],
    });
  }

  beforeEach(() => {
    // The box was unpacked from the OLD keeper image: its own engine-image file says so.
    boxDir = join(dir, "box");
    mkdirSync(boxDir);
    writeFileSync(join(boxDir, "engine-image"), `${KEEPER_OLD}\n`);
    prefix = dirname(dirname(composeDir));
    writeFileSync(release, releaseWithKeeper(KEEPER_NEW));
    // Wrap the shared docker stub: `docker run` is answered here, the rest passes through.
    mkdirSync(join(binDir, "real"));
    const base = join(binDir, "real", "docker");
    writeFileSync(base, readFileSync(join(binDir, "docker"), "utf8"));
    chmodSync(base, 0o755);
    stub(
      "docker",
      [
        'if [ "$1" = create ]; then',
        '  printf "docker %s\\n" "$*" >> "$STUB_LOG"',
        '  rm -f "$STUB_LOG.started"',
        '  args=("$@"); cidfile=""; owner=""; operation=""; name=""; script_at=-1',
        '  for ((i = 0; i < ${#args[@]}; i++)); do',
        '    case "${args[i]}" in',
        '      --cidfile) cidfile="${args[i+1]}" ;;',
        '      --name) name="${args[i+1]}" ;;',
        '      --label) case "${args[i+1]}" in com.lares.maintenance.owner=*) owner="${args[i+1]#*=}" ;; com.lares.maintenance.operation=*) operation="${args[i+1]#*=}" ;; esac ;;',
        '      /app/services/box/*.ts) script_at=$i ;;',
        '    esac',
        '  done',
        '  id=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef; cid_id="$id"; [ "${STUB_SHORT_CLIENT_ID:-}" != 1 ] || cid_id=deadbeef',
        '  [ "${STUB_CREATE_PARTIAL:-}" = 1 ] || printf "%s\\n" "$cid_id" > "$cidfile"; status=0; : > "$STUB_LOG.output"',
        '  if [ "$script_at" -ge 0 ]; then',
        '    script="${args[script_at]#/app/services/box/}"; op="${args[script_at+1]:-}"; arg="${args[script_at+2]:-}"',
        '    case "$script:$op" in',
        '      bin/update-record.ts:release) "$TEST_REAL_NODE" --import tsx/esm "${BOX}/bin/update-record.ts" release "$arg" > "$STUB_LOG.output" ;;',
        '      bin/update-record.ts:begin) echo 41 > "$STUB_LOG.output" ;;',
        '      bin/update-record.ts:previous-release) echo 2026-09-01 > "$STUB_LOG.output" ;;',
        '      bin/update-record.ts:previous-images) printf "record\\t41\\tok\\t2026-10-01\\t9f8e7d6c\\nimage\\tlares-console\\tregistry.example/lares-console@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\nimage\\tlares-chief-of-staff\\tregistry.example/lares-chief-of-staff@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n" > "$STUB_LOG.output" ;;',
        '      migrate.ts:*) if [ -n "${STUB_MIGRATE_FAIL:-}" ]; then echo "migrations: refused" > "$STUB_LOG.output"; status=1; fi ;;',
        '      bin/workflow-template.ts:update-plan) printf "template\\tempty_workflow\\n" > "$STUB_LOG.output"; for pair in ${STUB_STORES:-}; do printf "store\\t%s\\t%s\\n" "${pair%%:*}" "${pair#*:}" >> "$STUB_LOG.output"; done ;;',
        '    esac',
        '  fi',
        '  printf "%s\\n%s\\n%s\\n%s\\n" "$id" "$owner" "$operation" "$name" > "$STUB_LOG.identity"',
        '  printf "%s\\n" "$status" > "$STUB_LOG.status"; [ "${STUB_CREATE_PARTIAL:-}" != 1 ] || exit 124; exit 0',
        'fi',
        'if [ "$1" = start ] && [ "$2" = --attach ]; then printf "docker %s\\n" "$*" >> "$STUB_LOG"; [ "${STUB_RENAME_AFTER_START:-}" != 1 ] || : > "$STUB_LOG.started"; cat "$STUB_LOG.output"; exit 0; fi',
        'if [ "$1" = wait ]; then printf "docker %s\\n" "$*" >> "$STUB_LOG"; cat "$STUB_LOG.status"; exit 0; fi',
        'if [ "$1" = inspect ] && [ "$2" != image ]; then',
        '  printf "docker %s\\n" "$*" >> "$STUB_LOG"',
        '  if [[ "$*" == *Config.Entrypoint* ]]; then echo \'["/usr/local/lib/lares/maintenance-admission-v1"]\'; exit 0; fi',
        '  [ "${STUB_INSPECT_FAIL:-}" != 1 ] || exit 1',
        '  [ -f "$STUB_LOG.identity" ] || exit 1',
        '  read -r id < <(sed -n "1p" "$STUB_LOG.identity"); read -r owner < <(sed -n "2p" "$STUB_LOG.identity"); read -r operation < <(sed -n "3p" "$STUB_LOG.identity"); read -r name < <(sed -n "4p" "$STUB_LOG.identity"); read -r status < "$STUB_LOG.status"',
        '  [ "${STUB_PARTIAL_NAME_UNKNOWN:-}" != 1 ] || [ "${@: -1}" != "$name" ] || exit 1',
        '  if [ "${STUB_REPLACE_CLIENT_NAME:-}" = 1 ] && [ "${@: -1}" = "$name" ]; then printf "deadbeefdeadbeefdeadbeefdeadbeef|false|attacker|update\\n"; exit 0; fi',
        '  [ ! -f "$STUB_LOG.started" ] || name=renamed-client',
        '  case "$*" in *State.ExitCode*) printf "%s|false|%s|%s|%s\\n" "$id" "$status" "$owner" "$operation" ;; *State.Running*) printf "%s|false|%s|%s|/%s\\n" "$id" "$owner" "$operation" "$name" ;; *) printf "%s|/%s|%s|%s\\n" "$id" "$name" "$owner" "$operation" ;; esac',
        '  exit 0',
        'fi',
        'if [ "$1" = stop ]; then printf "docker %s\\n" "$*" >> "$STUB_LOG"; exit 0; fi',
        'if [ "$1" = rm ]; then printf "docker %s\\n" "$*" >> "$STUB_LOG"; rm -f "$STUB_LOG.identity"; exit 0; fi',
        'if [ "$1" = ps ]; then printf "docker %s\\n" "$*" >> "$STUB_LOG"; case "$*" in *"name="*) if [ "${STUB_PARTIAL_NAME_UNKNOWN:-}" != 1 ] && [ "${STUB_REPLACE_CLIENT_NAME:-}" = 1 ]; then echo replacement-id; fi ;; *"id="*) [ "${STUB_INSPECT_FAIL:-}" != 1 ] || echo 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef ;; esac; exit 0; fi',
        // The backup check is read by the shared stub, as the operator.
        `case "$*" in *psql*-tAc*) exec "${base}" "$@" ;; esac`,
        // So is the agent-store step: it runs in the role image, not through the guarded client.
        `case "$*" in *lares_workflow_provisioner@*) exec "${base}" "$@" ;; esac`,
        'if [ "$1" = run ]; then',
        '  printf "docker %s\\n" "$*" >> "$STUB_LOG"',
        '  args=("$@"); at=-1',
        '  for ((i = 0; i < ${#args[@]}; i++)); do [ "${args[i]}" = --entrypoint ] && at=$i; done',
        '  script="${args[at+3]#/app/services/box/}"; rest=("${args[@]:at+4}")',
        '  case "$script" in',
        "    bin/update-record.ts)",
        '      case "${rest[0]}" in',
        `        release) exec node "${BOX}/bin/update-record.ts" release "\${rest[1]}" ;;`,
        "        begin) echo 41 ;;",
        "        previous-release) echo 2026-09-01 ;;",
        "      esac ;;",
        '    migrate.ts) [ -z "${STUB_MIGRATE_FAIL:-}" ] || { echo "migrations: refused" >&2; exit 1; } ;;',
        "  esac",
        "  exit 0",
        "fi",
        'if [ "$1 $2" = "image inspect" ]; then',
        '  printf "docker %s\\n" "$*" >> "$STUB_LOG"',
        '  if [ "${3:-}" = --format ]; then echo \'["/usr/local/lib/lares/maintenance-admission-v1"]\'; exit 0; fi',
        '  [ -z "${STUB_NO_ENGINE_IMAGE:-}" ]; exit $?',
        "fi",
        'if [ "$1" = pull ]; then',
        '  printf "docker %s\\n" "$*" >> "$STUB_LOG"',
        '  [ -z "${STUB_ENGINE_PULL_FAIL:-}" ] || { echo "denied" >&2; exit 1; }',
        "  exit 0",
        "fi",
        `exec "${base}" "$@"`,
      ].join("\n"),
    );
    // Nothing of the box's own may go through pnpm in image mode. (The last test here runs on a
    // checkout, where the look at the agent stores does: it gets the template and no stores.)
    stub("pnpm", 'printf "pnpm %s\\n" "$*" >> "$STUB_LOG"; case "$*" in *update-plan*) printf "template\\tempty_workflow\\n" ;; esac; exit 0');
  });

  const imageRun = (args: string[], env: Record<string, string> = {}) =>
    run(args, { LARES_BOX_DIR: boxDir, LARES_PREFIX: prefix, LARES_UPDATE_RECORDER: "", TEST_REAL_NODE: process.execPath, BOX, ...env });
  const engineRuns = () => calls().split("\n").filter((l) => l.startsWith("docker create "));

  it("runs every program of the box in the TARGET release's digest, never the box's own", () => {
    const r = imageRun(["--release", release, "--yes"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const runs = engineRuns();
    const programs = runs.map((l) => [...l.matchAll(/\/app\/services\/box\/(\S+)/g)].pop()![1]!);
    expect(programs).toEqual([
      "bin/update-record.ts", // release
      "bin/workflow-template.ts", // update-plan: the look at the agent stores
      "bin/update-record.ts", // previous-release
      "bin/update-record.ts", // begin
      "migrate.ts",
      "bin/database-setup.ts", // --verify-workflow-template: no store needs upgrading, so the permissions are checked
      "bin/update-record.ts", // finish
    ]);
    for (const line of runs) {
      expect(line).toContain(KEEPER_NEW);
      expect(line).not.toContain(KEEPER_OLD);
      expect(line).toContain("--network host --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges");
      expect(line).toContain("--label com.lares.maintenance.operation=update");
      expect(line).toContain("node --import tsx/esm");
      expect(line).not.toContain("--entrypoint");
      expect(line).not.toContain("docker.sock");
      expect(line).toContain(`src=${prefix}/var/lib/lares-maintenance/admission,dst=/run/lares-maintenance/admission,readonly`);
      expect(line).toContain(` ${KEEPER_NEW} /run/lares-maintenance/admission `);
    }
    const clientId = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(calls()).toContain(`docker start --attach ${clientId}`);
    expect(calls()).toContain(`docker wait ${clientId}`);
    expect(calls()).toContain(`docker rm ${clientId}`);
    expect(calls()).not.toMatch(/^pnpm /m);
  });

  it("cleans up a partially created client only after matching its owner labels", () => {
    const r = imageRun(["--release", release, "--yes"], { STUB_CREATE_PARTIAL: "1" });
    expect(r.code).toBe(78);
    expect(calls()).toMatch(/docker inspect --format .*lares-update-client-/);
    expect(calls()).toMatch(/docker rm 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/);
    expect(calls()).not.toMatch(BACKUP);
  });

  it("retains the partial-create intent when its name cannot be verified", () => {
    const r = imageRun(["--release", release, "--yes"], {
      STUB_CREATE_PARTIAL: "1",
      STUB_PARTIAL_NAME_UNKNOWN: "1",
    });
    expect(r.code).toBe(78);
    expect(calls()).toMatch(/docker inspect --format .*lares-update-client-/);
    expect(calls()).toMatch(/docker ps -aq --filter name=\^\/lares-update-client-/);
    expect(calls()).not.toMatch(/docker (?:stop|rm) 0123456789abcdef/);
    const cidfile = calls().match(/--cidfile (\S+)/)?.[1];
    expect(cidfile).toBeDefined();
    expect(existsSync(dirname(cidfile!)), `${r.stderr}\n${calls()}`).toBe(true);
  });

  it("refuses to clean up a replacement that took the recorded container name", () => {
    const r = imageRun(["--release", release, "--yes"], { STUB_REPLACE_CLIENT_NAME: "1" });
    expect(r.code).toBe(78);
    expect(calls()).toMatch(/docker inspect --format .* 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/);
    expect(calls()).toMatch(/docker rm 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/);
    expect(calls()).not.toMatch(/docker (?:stop|rm) replacement-id/);
  });

  it("rejects a short client ID and cleans only the verified full-ID owner", () => {
    const r = imageRun(["--release", release, "--yes"], { STUB_SHORT_CLIENT_ID: "1" });
    expect(r.code).toBe(78);
    expect(calls()).not.toMatch(/docker start --attach/);
    expect(calls()).toMatch(/docker rm 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/);
  });

  it("removes the pinned client by ID after its name disappears", () => {
    const r = imageRun(["--release", release, "--yes"], { STUB_RENAME_AFTER_START: "1" });
    expect(r.code).toBe(0);
    expect(calls()).toMatch(/docker rm 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/);
  });

  it("retains tracking when inspection fails and immutable-ID absence is unproved", () => {
    const r = imageRun(["--release", release, "--yes"], { STUB_INSPECT_FAIL: "1" });
    expect(r.code).toBe(78);
    const cidfile = calls().match(/--cidfile (\S+)/)?.[1];
    expect(cidfile).toBeDefined();
    expect(existsSync(dirname(cidfile!)), `${r.stderr}\n${calls()}`).toBe(true);
  });

  it("applies the migrations after the backup and the record, and before the switch", () => {
    imageRun(["--release", release, "--yes"]);
    const migrate = at(/docker create .*migrate\.ts/);
    expect(migrate).toBeGreaterThan(at(BACKUP));
    expect(migrate).toBeGreaterThan(at(/update-record\.ts begin/));
    expect(migrate).toBeGreaterThan(at(PULL));
    expect(migrate).toBeLessThan(at(UP));
  });

  it("hands the database password over as a file in a read-only mount, never as a value", () => {
    imageRun(["--release", release, "--yes"]);
    const secrets = join(prefix, "etc", "lares", "secrets");
    // The look at the agent stores reads as the operator, from its own read-only file.
    const plan = engineRuns().find((l) => /workflow-template\.ts update-plan/.test(l))!;
    expect(plan).toContain(`src=${operatorPasswordFile},dst=${operatorPasswordFile},readonly`);
    expect(plan).toContain(`--operator-password-file ${operatorPasswordFile}`);
    expect(plan).not.toContain("PGPASSWORD");
    // So does the check of the template's permissions, with the agents' login file beside it.
    const permissions = engineRuns().find((l) => /database-setup\.ts --verify-workflow-template/.test(l))!;
    expect(permissions).toContain(`src=${operatorPasswordFile},dst=${operatorPasswordFile},readonly`);
    expect(permissions).toContain(`src=${secrets}/workflow-password,dst=${secrets}/workflow-password,readonly`);
    expect(permissions).not.toContain("PGPASSWORD");
    const dbRuns = engineRuns().filter((l) => !/update-record\.ts release|workflow-template\.ts|database-setup\.ts/.test(l));
    expect(dbRuns).toHaveLength(4);
    const migration = dbRuns.find((line) => /migrate\.ts/.test(line))!;
    expect(migration).toContain(`src=${operatorPasswordFile},dst=${operatorPasswordFile},readonly`);
    expect(migration).toContain(`--env DATABASE_PASSWORD_FILE=${operatorPasswordFile}`);
    expect(migration).not.toContain("PGPASSWORD");
    for (const line of dbRuns.filter((line) => !/migrate\.ts/.test(line))) {
      expect(line).toContain(`--env DATABASE_PASSWORD_FILE=${secrets}/database-password`);
      expect(line).toContain(`src=${secrets}/database-password,dst=${secrets}/database-password,readonly`);
      expect(line).not.toContain(operatorPasswordFile);
      expect(line).not.toContain("PGPASSWORD");
    }
    // The release file is mounted read-only, at the same path inside.
    const releaseRun = engineRuns().find((l) => /update-record\.ts release/.test(l))!;
    expect(releaseRun).toContain(`src=${release},dst=${release},readonly`);
  });

  it("uses LARES_ENGINE_IMAGE when it is set (the test override), still not the box's own file", () => {
    const named = `registry.example/lares-keeper@sha256:${"f".repeat(64)}`;
    imageRun(["--release", release, "--yes"], { LARES_ENGINE_IMAGE: named });
    expect(engineRuns().length).toBeGreaterThan(0);
    for (const line of engineRuns()) expect(line).toContain(named);
  });

  it("refuses, changing nothing, when the release names no engine image", () => {
    writeFileSync(release, releaseWithKeeper());
    const r = imageRun(["--release", release, "--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/names no engine image/);
    expect(calls()).not.toMatch(BACKUP);
    expect(engineRuns()).toEqual([]);
    expect(compose()).toBe(composeYaml());
  });

  it("requires an explicit Compose directory for an explicit non-root prefix before effects", () => {
    const r = imageRun(["--release", release, "--dry-run"], { UNSET_DB_COMPOSE_DIR: "1" });
    expect(r.code).toBe(78);
    expect(calls()).toBe("");
  });

  it("decides whether the prefix needs an explicit Compose directory from its path", () => {
    expect(readFileSync(SCRIPT, "utf8")).toContain('elif [ "$ADMISSION_PREFIX" != / ]; then COMPOSE_DIR=""');
  });

  it("refuses a keeper image named by a tag", () => {
    writeFileSync(release, releaseWithKeeper("registry.example/lares-keeper:latest"));
    const r = imageRun(["--release", release, "--yes"]);
    expect(r.code).toBe(78);
    expect(calls()).not.toMatch(BACKUP);
  });

  it("fetches the target engine image first when it is not on the box, and a failed fetch changes nothing", () => {
    const fetched = imageRun(["--release", release, "--yes"], { STUB_NO_ENGINE_IMAGE: "1" });
    expect(fetched.code).toBe(0);
    expect(at(new RegExp(`docker pull ${KEEPER_NEW}`))).toBeGreaterThan(-1);
    expect(at(new RegExp(`docker pull ${KEEPER_NEW}`))).toBeLessThan(at(/docker create /));

    rmSync(log);
    writeFileSync(composeFile, composeYaml());
    const refused = imageRun(["--release", release, "--yes"], { STUB_NO_ENGINE_IMAGE: "1", STUB_ENGINE_PULL_FAIL: "1" });
    expect(refused.code).toBe(78);
    expect(refused.stderr).toMatch(/could not download the engine image/);
    expect(calls()).not.toMatch(BACKUP);
    expect(compose()).toBe(composeYaml());
  });

  it("a refused migration puts the compose file back and never starts the new images", () => {
    const r = imageRun(["--release", release, "--yes"], { STUB_MIGRATE_FAIL: "1" });
    expect(r.code).toBe(70);
    expect(calls()).not.toMatch(UP);
    expect(compose()).toBe(composeYaml());
  });

  it("upgrades the agent stores through the same guarded client, with only the fixed programs and their credential files", () => {
    writeFileSync(join(prefix, "etc", "lares", "keeper.env"), 'COMPOSE_FILE="/opt/lares/compose.lares-keeper.yaml"\n');
    const r = imageRun(["--release", release, "--yes"], {
      STUB_STORES: `${STORE_A}:example-agent`, STUB_STORE_STATES: `empty_workflow=old ${STORE_A}=old`,
    });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const secrets = join(prefix, "etc", "lares", "secrets");
    const readOnly = (file: string) => `src=${file},dst=${file},readonly`;
    const storeRuns = engineRuns().filter((l) => /workflow-template\.ts|database-setup\.ts/.test(l));
    expect(storeRuns.map((l) => /\/app\/services\/box\/(\S+ \S+)/.exec(l)![1])).toEqual([
      "bin/workflow-template.ts update-plan", "bin/workflow-template.ts update-plan",
      "bin/workflow-template.ts apply", "bin/workflow-template.ts apply-database",
      "bin/database-setup.ts --verify-workflow-template", "bin/workflow-template.ts verify-database",
    ]);
    for (const line of storeRuns) {
      expect(line).toContain(KEEPER_NEW);
      expect(line).toContain("--label com.lares.maintenance.operation=update");
      expect(line).not.toContain("--entrypoint");
      expect(line).not.toContain("PGPASSWORD");
      expect(line).toContain("--env PGHOST=127.0.0.1 --env PGPORT=5432");
    }
    const apply = storeRuns.find((l) => /apply-database/.test(l))!;
    expect(apply).toContain(readOnly(`${secrets}/workflow-provisioner-password`));
    expect(apply).toContain(readOnly(`${secrets}/workflow-password`));
    expect(apply).not.toContain(operatorPasswordFile);
    expect(apply).toContain(`--database ${STORE_A}`);
    const verify = storeRuns.find((l) => /verify-database/.test(l))!;
    expect(verify).toContain(readOnly(`${secrets}/workflow-password`));
    expect(verify).not.toContain("workflow-provisioner-password");
    const template = storeRuns.find((l) => /--verify-workflow-template/.test(l))!;
    expect(template).toContain(readOnly(operatorPasswordFile));
    expect(calls()).not.toMatch(/^pnpm /m);
    // The step itself runs in the role image, never in the engine.
    expect(calls()).toMatch(new RegExp(`^docker run --rm -i .*${CREATIVE_NEW} .* sh upgrade ${STORE_A}$`, "m"));
  });

  it("the guarded client refuses any other program or mode for an update", () => {
    const refusal = (program: string) => {
      try {
        execFileSync("/bin/bash", ["-c", `HERE=${JSON.stringify(join(BOX, "ops"))}; . "$HERE/engine-run.sh"; ENGINE_IMAGE=unused; engine_normal_client update --ro /dev/null ${program}`],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: `${binDir}:${process.env.PATH}`, STUB_LOG: log } });
        return { code: 0, stderr: "" };
      } catch (e: any) { return { code: e.status as number, stderr: String(e.stderr) }; }
    };
    for (const program of [
      "bin/database-setup.ts", "bin/database-setup.ts --finalize-workflow-template", "bin/database-setup.ts --prepare-restored-engine",
      "bin/workflow-template.ts", "bin/workflow-template.ts verify", "bin/doctor.ts",
    ]) {
      const r = refusal(program);
      expect(r.code, program).toBe(78);
      expect(r.stderr, program).toMatch(/outside the fixed update/);
    }
    expect(refusal("bin/workflow-template.ts update-plan").stderr).not.toMatch(/outside the fixed update/);
    expect(calls()).not.toMatch(/docker create/);
  });

  it("a box without an engine-image file still updates on the host, with pnpm, exactly as before", () => {
    const r = run(["--release", release, "--yes"]);
    expect(r.code).toBe(0);
    expect(calls()).toMatch(MIGRATE);
    expect(engineRuns()).toEqual([]);
  });
});

// The agent stores. Each agent keeps its conversations in a database of its own; a release that
// moves to a newer agent framework must run that framework's own schema step on every one of
// them, with the agents stopped, and must never let an agent start on a half-upgraded store.
// These drive the real update.sh with stubs and assert the exact order of what it reaches for.
// What the programs behind the stubs do to a real database is tests/workflow-store-update.integration.test.ts.
describe("upgrading the agent stores during an update", { timeout: 60_000 }, () => {
  const STORES = `${STORE_A}:example-agent ${STORE_B}:other-agent`;
  const ALL_OLD = { STUB_STORES: STORES, STUB_STORE_STATES: `empty_workflow=old ${STORE_A}=old ${STORE_B}=old` };
  const noteFile = () => join(prefix, "var", "lib", "lares-maintenance", "update", "workflow-step.json");
  const note = () => JSON.parse(readFileSync(noteFile(), "utf8")) as { release: string; phase: string; agents: string[]; snapshotId: string; updateId: string };
  const writeNote = (value: object) => {
    mkdirSync(dirname(noteFile()), { recursive: true });
    writeFileSync(noteFile(), JSON.stringify({ version: 1, updateId: "", snapshotId: "", ...value }), { mode: 0o600 });
  };
  const short = (line: string) => line.includes(STORE_A) ? "A" : line.includes(STORE_B) ? "B" : "template";
  /** The calls that matter here, in order, in plain words. */
  const steps = () => calls().trim().split("\n").map((line) => {
    if (/update-plan/.test(line)) return /--require-quiet/.test(line) ? "look again, nothing else connected" : "look";
    if (/ sh check /.test(line)) return `check ${short(line)}`;
    if (/ sh upgrade /.test(line)) return `upgrade ${short(line)}`;
    if (/^docker rm [0-9a-f]+$/.test(line)) return `remove container ${Buffer.from(line.slice(10), "hex").toString()}`;
    if (/keeper\.env stop lares-keeper/.test(line)) return "stop keeper";
    if (/keeper\.env start lares-keeper/.test(line)) return "start keeper";
    if (/compose\.lares-agents\.yaml ps /.test(line)) return "list agents";
    if (/compose\.lares-agents\.yaml stop/.test(line)) return "stop agents";
    if (/compose\.lares-agents\.yaml start/.test(line)) return `start agents${line.slice(line.indexOf(" start") + 6)}`;
    if (/workflow-template\.ts apply/.test(line)) return `permissions ${short(line)}`;
    if (/--verify-workflow-template/.test(line)) return "verify template";
    if (/workflow-template\.ts verify-database/.test(line)) return `verify ${short(line)}`;
    if (BACKUP.test(line)) return "backup";
    if (/^record (begin|finish)/.test(line)) return line.split(" ").slice(0, 2).join(" ") + (/ finish \S+ failed/.test(line) ? " failed" : "");
    if (PULL.test(line)) return "pull";
    if (MIGRATE.test(line)) return "box migrations";
    if (UP.test(line)) return "switch";
    if (/ps --services/.test(line)) return "did they come up";
    return "";
  }).filter(Boolean);
  const LOOK = ["look", "check template", "check A", "check B"];
  const STOP = ["stop keeper", "list agents", "stop agents"];
  const UNTIL_STORES = ["backup", "record begin", "pull", "box migrations"];
  const LOOK_AGAIN = ["look again, nothing else connected", "check template", "check A", "check B"];
  const VERIFY = ["verify template", "verify A", "verify B"];
  const REMOVE = ["remove container lares-example-agent", "remove container lares-other-agent"];
  const START_AGAIN = ["start agents lares-example-agent lares-other-agent", "start keeper"];

  beforeEach(() => {
    writeFileSync(join(prefix, "etc", "lares", "keeper.env"), 'COMPOSE_FILE="/opt/lares/compose.lares-keeper.yaml"\n');
    writeFileSync(join(prefix, "etc", "lares", "keeper.json"), JSON.stringify({ project: "lares" }));
    mkdirSync(join(prefix, "srv", "lares"), { recursive: true });
    writeFileSync(join(prefix, "srv", "lares", "compose.lares-agents.yaml"), "services: {}\n");
  });

  it("stops the keeper and the agents, backs up, upgrades and verifies every store, and only then switches", () => {
    const r = run(["--release", release, "--yes"], ALL_OLD);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(steps()).toEqual([
      ...LOOK,
      ...STOP,
      ...UNTIL_STORES,
      ...LOOK_AGAIN,
      ...REMOVE,
      "upgrade template", "check template", "permissions template",
      "upgrade A", "check A", "permissions A",
      "upgrade B", "check B", "permissions B",
      ...VERIFY,
      "switch", "did they come up", "record finish",
    ]);
    // The previous release's containers are found by the agents' own compose labels, removed
    // without --force, and looked for again.
    expect(calls()).toContain("docker ps --all --quiet --filter label=com.docker.compose.project=lares --filter label=com.docker.compose.service=lares-example-agent");
    expect(calls()).not.toMatch(/^docker rm (-f|--force)/m);
    // The keeper is asked to stop by its own settings file; the agents are named by their own compose file.
    expect(calls()).toMatch(new RegExp(`^env -u COMPOSE_FILE docker compose --env-file ${prefix}/etc/lares/keeper\\.env stop lares-keeper$|^docker compose --env-file ${prefix}/etc/lares/keeper\\.env stop lares-keeper$`, "m"));
    expect(calls()).toContain(`docker compose --project-name lares --project-directory ${prefix}/srv/lares -f ${prefix}/srv/lares/compose.lares-agents.yaml stop`);
    // The role image runs the step, as the provisioner, with its password in a read-only file.
    const upgrade = calls().split("\n").find((line) => line.includes(` sh upgrade ${STORE_A}`))!;
    expect(upgrade).toContain(CREATIVE_NEW);
    expect(upgrade).toContain("--network host --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges -w /app/services/creative");
    expect(upgrade).toContain(`-v ${prefix}/etc/lares/secrets/workflow-provisioner-password:/run/secrets/workflow-provisioner:ro`);
    expect(upgrade).toContain(`WORKFLOW_POSTGRES_URL=postgres://lares_workflow_provisioner@127.0.0.1:5432/${STORE_A}`);
    expect(calls()).not.toContain("fixture-only-workflow-password");
    // Nothing started the keeper or an agent: that is `lares update`'s next step, from the note.
    expect(steps().join("\n")).not.toMatch(/start /);
    expect(note()).toEqual({ version: 1, release: "2026-10-01", updateId: "41", snapshotId: "9f8e7d6c", phase: "migrated", agents: ["example-agent", "other-agent"] });
    expect(r.stdout).toContain("your agents will be stopped during this update, and started again on the new release at the end");
    expect(r.stdout).toContain("3 of 3 agent stores");
    expect(r.stdout).toContain("update: your agents are stopped. They start again when this update finishes");
    expect(r.stdout).toContain("sudo lares agent refresh");
  });

  it("stops nothing when every store is already at this release, and only checks their permissions", () => {
    const r = run(["--release", release, "--yes"], { STUB_STORES: STORES });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    // Checked after the migrations and before the switch; every check passes, so nothing is applied.
    expect(steps()).toEqual([...LOOK, ...UNTIL_STORES, ...VERIFY, "switch", "did they come up", "record finish"]);
    expect(existsSync(noteFile())).toBe(false);
    expect(r.stdout).toContain("every agent store already has this release's workflow tables, so nothing is stopped for that");
    expect(r.stdout).toContain("update: checking the permissions of every agent store against this release's list.");
    expect(r.stdout).toContain("update: every agent store has this release's permissions.");
    expect(r.stdout).not.toContain("your agents are stopped");
  });

  it("repairs only the store whose permissions fail its check, with everything running, checks it again, then switches", () => {
    for (const [stale, name, label] of [
      [STORE_A, "A", "the store of agent example-agent"],
      ["template", "template", "the template new agents are made from"],
    ] as const) {
      writeFileSync(log, "");
      rmSync(`${log}.applied`, { force: true });
      writeFileSync(composeFile, composeYaml());
      const r = run(["--release", release, "--yes"], { STUB_STORES: STORES, STUB_PERMISSIONS_STALE: stale });
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      const repaired = VERIFY.flatMap((step) => step === `verify ${name}` ? [step, `permissions ${name}`, step] : [step]);
      expect(steps()).toEqual([...LOOK, ...UNTIL_STORES, ...repaired, "switch", "did they come up", "record finish"]);
      expect(steps().join("\n")).not.toMatch(/stop|start |remove container/);
      expect(existsSync(noteFile())).toBe(false);
      expect(r.stdout).toContain(`update: ${label} did not have exactly this release's permissions. They were applied, and it passes its check now.`);
      expect(r.stdout).not.toContain("every agent store has this release's permissions");
      expect(calls()).toMatch(stale === "template" ? /workflow-template\.ts apply --host/ : new RegExp(`workflow-template\\.ts apply-database .*--database ${STORE_A} `));
    }
  });

  it("stops before the switch when the repair fails: nothing stopped, the compose file back, the record failed", () => {
    for (const [env, applied, reason] of [
      [{ STUB_PERMISSIONS_STALE: STORE_B, STUB_APPLY_FAIL: STORE_B }, ["verify template", "verify A", "verify B", "permissions B"],
        "the store of agent other-agent: its permissions could not be brought up to this release's list (Workflow runtime table privileges are incomplete)"],
      [{ STUB_VERIFY_FAIL: STORE_A }, ["verify template", "verify A", "permissions A", "verify A"],
        "the store of agent example-agent: it still did not pass its check after this release's permissions were applied (Workflow schema step record is not at the pinned head (20 recorded, 30 expected))"],
    ] as const) {
      writeFileSync(log, "");
      rmSync(`${log}.applied`, { force: true });
      const r = run(["--release", release, "--yes"], { STUB_STORES: STORES, ...env });
      expect(r.code, r.stderr).toBe(70);
      expect(steps()).toEqual([...LOOK, ...UNTIL_STORES, ...applied, "record finish failed"]);
      expect(calls()).toContain(`record finish 41 failed ${reason}`);
      expect(r.stderr).toContain(`update: I stopped before starting the new images: ${reason}.`);
      expect(r.stderr).toContain("update: nothing was switched and nothing was stopped for this: the software you were running is still running.");
      expect(r.stderr).toContain("update: fix the cause and run the same update again.");
      expect(steps().join("\n")).not.toMatch(/stop|start |switch|remove container/);
      expect(compose()).toBe(composeYaml());
      expect(existsSync(noteFile())).toBe(false);
    }
  });

  it("when a later store fails after an earlier one was repaired, says which ones already changed and not to restart the keeper", () => {
    const r = run(["--release", release, "--yes"], { STUB_STORES: STORES, STUB_PERMISSIONS_STALE: `${STORE_A} ${STORE_B}`, STUB_APPLY_FAIL: STORE_B });
    expect(r.code, r.stderr).toBe(70);
    expect(steps()).toEqual([...LOOK, ...UNTIL_STORES, "verify template", "verify A", "permissions A", "verify A", "verify B", "permissions B", "record finish failed"]);
    expect(r.stderr).toContain("update: I stopped before starting the new images: the store of agent other-agent: its permissions could not be brought up to this release's list (Workflow runtime table privileges are incomplete).");
    expect(r.stderr).toContain("update: nothing was switched and nothing was stopped for this: the software you were running is still running.");
    expect(r.stderr).toContain("update: before that, this update already gave this release's permissions to: the store of agent example-agent. Your server keeps running as it is now, but the keeper you are running checks for its own release's permissions exactly, so it would refuse these the next time it starts.");
    expect(r.stderr).toContain("update: so do not restart the keeper or the server until this update has been run again and has finished.");
    expect(r.stderr).toContain("update: fix the cause and run the same update again.");
    expect(steps().join("\n")).not.toMatch(/stop|start |switch/);
    expect(compose()).toBe(composeYaml());
    // A failure with nothing repaired before it gives no such warning.
    writeFileSync(log, "");
    rmSync(`${log}.applied`, { force: true });
    const first = run(["--release", release, "--yes"], { STUB_STORES: STORES, STUB_PERMISSIONS_STALE: STORE_A, STUB_APPLY_FAIL: STORE_A });
    expect(first.code).toBe(70);
    expect(first.stderr).not.toContain("do not restart the keeper");
  });

  it("on a re-run after an earlier run upgraded every store, a failing repair says the agents are stopped, never that they run", () => {
    writeNote({ release: "2026-10-01", phase: "migrated", agents: ["example-agent", "other-agent"], snapshotId: "9f8e7d6c", updateId: "40" });
    const r = run(["--release", release, "--yes"], { STUB_STORES: STORES, STUB_VERIFY_FAIL: STORE_A });
    expect(r.code, r.stderr).toBe(70);
    expect(steps()).toEqual([...LOOK, ...UNTIL_STORES, "verify template", "verify A", "permissions A", "verify A", "record finish failed"]);
    expect(r.stderr).toContain("update: I stopped before starting the new images: the store of agent example-agent: it still did not pass its check after this release's permissions were applied");
    expect(r.stderr).toContain("update: your agent stores are already on the new format, and your agents are stopped. Fix the cause and run the same update again.");
    expect(r.stderr).toContain("sudo lares restore --snapshot 9f8e7d6c), not rollback.sh");
    expect(r.stderr).not.toContain("nothing was stopped");
    expect(r.stderr).not.toContain("still running");
    expect(r.stderr).not.toContain("do not restart the keeper");
    expect(steps().join("\n")).not.toMatch(/stop|start |switch/);
    expect(note()).toMatchObject({ phase: "migrated", agents: ["example-agent", "other-agent"] });
  });

  it("a dry run with every store at this release checks their permissions, says what it would repair, and applies nothing", () => {
    const r = run(["--release", release, "--dry-run"], { STUB_STORES: STORES, STUB_PERMISSIONS_STALE: STORE_B });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(steps()).toEqual([...LOOK, ...VERIFY]);
    expect(r.stdout).toContain("update: the store of agent other-agent did not pass its permissions check (Workflow runtime function privileges are incomplete). The update would apply this release's list to it, with your agents running, and check it again.");
    expect(r.stdout).not.toContain("every agent store has this release's permissions");
    expect(r.stdout).toContain("update: this was a dry run. Nothing has been changed.");
    expect(existsSync(`${log}.applied`)).toBe(false);
    expect(compose()).toBe(composeYaml());
  });

  it("a dry run shows what would happen to the stores and stops nothing", () => {
    const r = run(["--release", release, "--dry-run"], ALL_OLD);
    expect(r.code).toBe(0);
    expect(steps()).toEqual(LOOK);
    expect(r.stdout).toContain("your agents will be stopped during this update");
    expect(existsSync(noteFile())).toBe(false);
  });

  it("refuses before anything is stopped when one store is not as the previous release left it", () => {
    for (const [env, reason] of [
      [{ ...ALL_OLD, STUB_CHECK_FAIL: STORE_B }, /I will not update this server: the store of agent other-agent: it was not left by the previous release: it has 19 schema steps recorded\. Nothing has been changed\./],
      [{ ...ALL_OLD, STUB_STORE_STATES: `empty_workflow=old ${STORE_A}=old ${STORE_B}=perhaps` }, /the store of agent other-agent: its check came back unreadable, and an unreadable check counts as a failing one/],
      [{ ...ALL_OLD, STUB_STORE_STATES: `empty_workflow=old ${STORE_A}=empty` }, /the store of agent example-agent: it has no workflow tables at all/],
      [{ ...ALL_OLD, STUB_PLAN_FAIL: "the database is set to time zone Europe/Oslo, not UTC. This release only upgrades agent stores on UTC: the upgrade rewrites how every stored time is kept, and that is only proven on UTC. Stay on your current release for now, and do not change the database's time zone yourself: that would move the times already stored" }, /I will not update this server: the database is set to time zone Europe\/Oslo, not UTC\. .* do not change the database's time zone yourself: that would move the times already stored\. Nothing has been changed\./],
      [{ ...ALL_OLD, STUB_STORES: `${STORE_A}:Example ${STORE_B}:other-agent` }, /the list of agent stores came back unreadable/],
    ] as const) {
      writeFileSync(log, "");
      const r = run(["--release", release, "--yes"], env);
      expect(r.code, r.stderr).toBe(78);
      expect(r.stderr).toMatch(reason);
      expect(r.stderr).toContain("update: your agents are still running.");
      expect(steps().join("\n")).not.toMatch(/stop|start|backup|record|pull|migrations|upgrade|switch|permissions/);
      expect(existsSync(noteFile())).toBe(false);
      expect(compose()).toBe(composeYaml());
    }
  });

  it("refuses a release that names no creative role image, before anything", () => {
    writeFileSync(release, JSON.stringify({ release: "2026-10-01", images: { console: CONSOLE_NEW, "chief-of-staff": ROLE_NEW }, migrations: { box: "001_baseline.sql" }, breaking: [] }));
    const r = run(["--release", release, "--yes"], ALL_OLD);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/names no creative role image.*Nothing has been changed/);
    expect(steps()).toEqual([]);
  });

  // The installer makes this login file (from rc.13 on); a server installed earlier and never
  // installed again since has none. The refusal says how to get it.
  it("refuses before anything is stopped when the store login file is missing, and says how to get it", () => {
    const credential = join(prefix, "etc", "lares", "secrets", "workflow-provisioner-password");
    rmSync(credential);
    const r = run(["--release", release, "--yes"], ALL_OLD);
    expect(r.code, r.stderr).toBe(78);
    expect(r.stderr).toContain(`the provisioner credential (${credential}) is missing, empty or a link`);
    expect(r.stderr).toContain("running its installer once creates it: sudo bash /opt/lares/current/services/box/ops/install.sh --yes --release /opt/lares/current/release.json");
    expect(r.stderr).toContain("On an older release, update to rc.14 first. Then run this again. Nothing has been changed.");
    expect(steps().join("\n")).not.toMatch(/stop|start|backup|record|pull|migrations|upgrade|switch|permissions/);
    expect(existsSync(noteFile())).toBe(false);
  });

  it("starts the agents and the keeper again when the second look refuses, having changed no store", () => {
    const r = run(["--release", release, "--yes"], { ...ALL_OLD, STUB_QUIET_FAIL: STORE_A });
    expect(r.code).toBe(78);
    expect(steps()).toEqual([...LOOK, ...STOP, ...UNTIL_STORES, "look again, nothing else connected", "record finish failed", ...START_AGAIN]);
    expect(r.stderr).toContain(`something changed while I was stopping your agents: something is still connected to ${STORE_A} (1).`);
    expect(r.stderr).toContain("no agent store was changed by this run, and your agents are running again on the previous release");
    expect(existsSync(noteFile())).toBe(false);
    expect(compose()).toBe(composeYaml());
  });

  it("starts them again when the backup, the pull or the box migrations fail after the stop", () => {
    for (const [env, code, before] of [
      [{ STUB_BACKUP_FAIL: "1" }, 75, ["backup"]],
      [{ STUB_BEGIN_FAIL: "1" }, 78, ["backup", "record begin"]],
      [{ STUB_PULL_FAIL: "1" }, 70, ["backup", "record begin", "pull", "record finish failed"]],
      [{ STUB_MIGRATE_FAIL: "1" }, 70, ["backup", "record begin", "pull", "box migrations", "record finish failed"]],
    ] as const) {
      writeFileSync(log, "");
      rmSync(`${log}.agents-stopped`, { force: true });
      const r = run(["--release", release, "--yes"], { ...ALL_OLD, ...env });
      expect(r.code, r.stderr).toBe(code);
      expect(steps()).toEqual([...LOOK, ...STOP, ...before, ...START_AGAIN]);
      expect(r.stderr).toContain("your agents are running again on the previous release");
      expect(existsSync(noteFile())).toBe(false);
    }
  });

  it("stops, and starts the keeper again, when the keeper or the agents cannot be stopped", () => {
    const keeper = run(["--release", release, "--yes"], { ...ALL_OLD, STUB_KEEPER_STOP_FAIL: "1" });
    expect(keeper.code).toBe(70);
    expect(steps()).toEqual([...LOOK, "stop keeper", "start keeper"]);
    expect(keeper.stderr).toContain("I could not stop the keeper. No agent store was changed.");
    expect(existsSync(noteFile())).toBe(false);
    writeFileSync(log, "");
    const agents = run(["--release", release, "--yes"], { ...ALL_OLD, STUB_AGENTS_STOP_FAIL: "1" });
    expect(agents.code).toBe(70);
    expect(steps()).toEqual([...LOOK, ...STOP, ...START_AGAIN]);
    expect(agents.stderr).toContain("I could not stop your agents. No agent store was changed.");
    expect(existsSync(noteFile())).toBe(false);
  });

  it("leaves everything stopped when a store fails to upgrade, names the backup, and continues on the next run", () => {
    const first = run(["--release", release, "--yes"], { ...ALL_OLD, STUB_STORE_MIGRATE_FAIL: STORE_B });
    expect(first.code).toBe(70);
    expect(steps()).toEqual([
      ...LOOK, ...STOP, ...UNTIL_STORES, ...LOOK_AGAIN, ...REMOVE,
      "upgrade template", "check template", "permissions template",
      "upgrade A", "check A", "permissions A",
      "upgrade B", "record finish failed",
    ]);
    expect(first.stderr).toContain("the update stopped while upgrading the agent stores: the store of agent other-agent: canceling statement due to lock timeout.");
    expect(first.stderr).toContain("your agents are stopped and will stay stopped, because starting them on a half-upgraded store could lose conversations");
    expect(first.stderr).toContain("sudo lares restore --snapshot 9f8e7d6c");
    expect(first.stderr).toContain("do not use rollback.sh for this");
    expect(compose()).toBe(composeYaml());
    expect(note()).toMatchObject({ phase: "migrating", agents: ["example-agent", "other-agent"], snapshotId: "9f8e7d6c" });

    // A failure of anything else on the way back in must not start an agent on the half-upgraded stores.
    writeFileSync(log, "");
    const blocked = run(["--release", release, "--yes"], { ...ALL_OLD, STUB_BACKUP_FAIL: "1" });
    expect(blocked.code).toBe(75);
    expect(steps().join("\n")).not.toMatch(/start /);
    expect(blocked.stderr).toContain("your agents stay stopped");
    expect(note()).toMatchObject({ phase: "migrating", agents: ["example-agent", "other-agent"] });

    // The same update again: what is upgraded is skipped, the rest is upgraded, everything is checked.
    writeFileSync(log, "");
    const second = run(["--release", release, "--yes"], { ...ALL_OLD, STUB_SNAPSHOT: "aaaa1111" });
    expect(second.stderr).toBe("");
    expect(second.code).toBe(0);
    expect(steps()).toEqual([
      ...LOOK, ...STOP, ...UNTIL_STORES, ...LOOK_AGAIN,
      "permissions template", "permissions A",
      "upgrade B", "check B", "permissions B",
      ...VERIFY,
      "switch", "did they come up", "record finish",
    ]);
    expect(second.stdout).toContain("an earlier run of this update stopped your agents and did not finish");
    // The backup written down is the one from before any store was touched, and the agents stopped
    // by the first run are still the ones to start.
    expect(note()).toMatchObject({ phase: "migrated", agents: ["example-agent", "other-agent"], snapshotId: "9f8e7d6c" });
  });

  it("removes the old container of every agent with a store, also one that was not running, before the first store changes", () => {
    const r = run(["--release", release, "--yes"], { ...ALL_OLD, STUB_AGENTS_RUNNING: "lares-example-agent" });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const order = steps();
    expect(order.indexOf("remove container lares-other-agent")).toBeGreaterThan(-1);
    expect(order.indexOf("remove container lares-example-agent")).toBeGreaterThan(order.indexOf("look again, nothing else connected"));
    expect(order.indexOf("remove container lares-other-agent")).toBeLessThan(order.indexOf("upgrade template"));
    // Only the running one is started again at the end; the other stays stopped, as before.
    expect(note()).toMatchObject({ phase: "migrated", agents: ["example-agent"] });
  });

  it("upgrades no store while an old agent container cannot be removed or is still there, and starts nothing", () => {
    for (const [env, reason] of [
      [{ STUB_RM_FAIL: "1" }, /agent example-agent: its container of the previous release could not be removed \(Error response from daemon: cannot remove container: container is running\)/],
      [{ STUB_RM_LEAVES: "1" }, /agent example-agent: a container of the previous release is still there after removing it/],
      [{ STUB_CONTAINER_PS_FAIL: "1" }, /agent example-agent: I could not ask Docker for its container/],
    ] as const) {
      writeFileSync(log, "");
      for (const sidecar of ["migrated", "agents-stopped", "removed"]) rmSync(`${log}.${sidecar}`, { force: true });
      rmSync(noteFile(), { force: true });
      const r = run(["--release", release, "--yes"], { ...ALL_OLD, ...env });
      expect(r.code, r.stderr).toBe(70);
      expect(r.stderr).toMatch(reason);
      expect(r.stderr).toContain("your agents are stopped and will stay stopped");
      expect(steps().join("\n")).not.toMatch(/upgrade |permissions |start |switch/);
      expect(note().phase).toBe("migrating");
    }
    // Once the container can go, the same update carries on.
    writeFileSync(log, "");
    const again = run(["--release", release, "--yes"], ALL_OLD);
    expect(again.stderr).toBe("");
    expect(again.code).toBe(0);
    expect(note().phase).toBe("migrated");
  });

  it("stops an upgrade that runs out of time, says how to allow more, and takes a longer limit from the operator", () => {
    const first = run(["--release", release, "--yes"], { ...ALL_OLD, STUB_TIMEOUT_EXPIRES: "1" });
    expect(first.code).toBe(70);
    expect(readFileSync(`${log}.limits`, "utf8")).toContain("900\n");
    // The container is found by its own name and removed, so it cannot finish after the update gave up.
    const named = calls().match(/docker run --rm -i --name (lares-workflow-store-[a-f0-9]{16}) --label lares\.maintenance=workflow-store .* sh upgrade empty_workflow/);
    expect(named).not.toBeNull();
    expect(calls()).toContain(`docker rm --force ${named![1]}`);
    expect(first.stderr).toContain("the template new agents are made from: the step ran out of its 900 seconds and was stopped; the store was left as it was. To allow more time, run the same command again with LARES_WORKFLOW_UPGRADE_SECONDS");
    expect(steps().join("\n")).not.toMatch(/start |switch/);

    writeFileSync(log, "");
    rmSync(noteFile(), { force: true });
    const bad = run(["--release", release, "--yes"], { ...ALL_OLD, LARES_WORKFLOW_UPGRADE_SECONDS: "forever" });
    expect(bad.code).toBe(64);
    expect(bad.stderr).toContain("LARES_WORKFLOW_UPGRADE_SECONDS must be a number of seconds from 60 to 86400. Nothing has been changed.");
    expect(steps()).toEqual([]);

    writeFileSync(log, "");
    rmSync(`${log}.limits`, { force: true });
    const longer = run(["--release", release, "--yes"], { ...ALL_OLD, LARES_WORKFLOW_UPGRADE_SECONDS: "7200" });
    expect(longer.stderr).toBe("");
    expect(longer.code).toBe(0);
    // Upgrades get the operator's limit; the read-only checks keep their two minutes.
    const limits = readFileSync(`${log}.limits`, "utf8").trim().split("\n");
    expect(limits).toContain("7200");
    expect(limits).toContain("120");
    expect(limits).not.toContain("900");
  });

  it("leaves everything stopped when permissions or the final check fail, and never marks the stores verified", () => {
    for (const [env, reason] of [
      [{ STUB_APPLY_FAIL: STORE_A }, /the store of agent example-agent: its permissions could not be applied and verified \(Workflow runtime table privileges are incomplete\)/],
      [{ STUB_VERIFY_FAIL: STORE_B }, /the store of agent other-agent: it did not pass its final check \(Workflow schema step record is not at the pinned head/],
      [{ STUB_VERIFY_FAIL: "--verify-workflow-template" }, /the template new agents are made from: it did not pass its final check/],
    ] as const) {
      writeFileSync(log, "");
      for (const sidecar of ["migrated", "agents-stopped"]) rmSync(`${log}.${sidecar}`, { force: true });
      rmSync(noteFile(), { force: true });
      const r = run(["--release", release, "--yes"], { ...ALL_OLD, ...env });
      expect(r.code, r.stderr).toBe(70);
      expect(r.stderr).toMatch(reason);
      expect(r.stderr).toContain("your agents are stopped and will stay stopped");
      expect(steps().join("\n")).not.toMatch(/start |switch/);
      expect(note().phase).toBe("migrating");
    }
  });

  it("says the stores are already on the new format when the switch fails after them", () => {
    const r = run(["--release", release, "--yes"], { ...ALL_OLD, STUB_UP_FAIL: "1" });
    expect(r.code).toBe(70);
    expect(r.stderr).toContain("your agent stores are already on the new format, and your agents are stopped");
    expect(r.stderr).toContain("sudo lares restore --snapshot 9f8e7d6c), not rollback.sh");
    expect(steps().join("\n")).not.toMatch(/start /);
    expect(note().phase).toBe("migrated");
    // The same update again finds every store upgraded: nothing is stopped or migrated twice.
    writeFileSync(log, "");
    const again = run(["--release", release, "--yes"], ALL_OLD);
    expect(again.code).toBe(0);
    expect(steps()).toEqual([...LOOK, ...UNTIL_STORES, ...VERIFY, "switch", "did they come up", "record finish"]);
    expect(again.stdout).toContain("an earlier run of this update already upgraded and verified every agent store");
    expect(again.stdout).toContain("update: your agents are stopped. They start again when this update finishes");
    expect(note()).toMatchObject({ phase: "migrated", agents: ["example-agent", "other-agent"], snapshotId: "9f8e7d6c" });
  });

  it("refuses while an earlier update to another release is unfinished, and is not blocked by a finished one", () => {
    writeNote({ release: "2026-09-15", phase: "migrating", agents: ["example-agent"] });
    const unfinished = run(["--release", release, "--yes"], ALL_OLD);
    expect(unfinished.code).toBe(78);
    expect(unfinished.stderr).toContain("an earlier update to 2026-09-15 did not finish. Finish it first: run that same update again. Nothing has been changed.");
    expect(steps()).toEqual([]);

    writeFileSync(noteFile(), "not json");
    const unreadable = run(["--release", release, "--yes"], ALL_OLD);
    expect(unreadable.code).toBe(78);
    expect(unreadable.stderr).toContain("cannot be read, so I cannot tell how far that update got. Nothing has been changed.");
    expect(steps()).toEqual([]);

    // Finished, with one agent that did not start afterwards: the next update goes ahead and keeps the name.
    writeNote({ release: "2026-09-15", phase: "migrated", agents: ["late-agent"] });
    const next = run(["--release", release, "--yes"], ALL_OLD);
    expect(next.stderr).toBe("");
    expect(next.code).toBe(0);
    expect(note()).toMatchObject({ release: "2026-10-01", phase: "migrated", agents: ["example-agent", "late-agent", "other-agent"], snapshotId: "9f8e7d6c" });
  });
});
