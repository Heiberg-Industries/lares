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
    images: { console: CONSOLE_NEW, "chief-of-staff": ROLE_NEW },
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
  //  - `... psql ... -tAc ...`  -> the backup_status row the test staged
  //  - `... pull`               -> succeeds unless STUB_PULL_FAIL
  //  - `... up -d`              -> succeeds unless STUB_UP_FAIL
  //  - `... ps --services ...`  -> the services the test says are running
  stub(
    "docker",
    [
      logLine,
      'args="$*"',
      'case "$args" in',
      '  *psql*-tAc*)',
      '    [ -z "${STUB_STATUS_FAIL:-}" ] || exit 1',
      '    printf "%s\\n" "${STUB_BACKUP_STATUS-t|3600}"',
      "    ;;",
      '  *" pull"*|*" pull "*)',
      '    [ -z "${STUB_PULL_FAIL:-}" ] || { echo "docker: manifest unknown" >&2; exit 1; }',
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
      'echo "snapshot 9f8e7d6c saved"',
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
  stub("timeout", 'if [[ "$1" == --kill-after=* ]]; then shift; elif [ "$1" = --kill-after ]; then shift 2; fi; shift; exec "$@"');
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

describe("updating this installation", () => {
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
      images: { console: CONSOLE_NEW, "chief-of-staff": ROLE_NEW, "lares-keeper": KEEPER_NEW },
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
        if (/psql/.test(line)) return "read backup status";
        if (PULL.test(line)) return "docker compose pull";
        if (UP.test(line)) return "docker compose up -d";
        if (/ps --services/.test(line)) return "docker compose ps";
        if (MIGRATE.test(line)) return "migrate";
        return line.split(" ")[0]!;
      });
    expect(sequence).toEqual([
      "read backup status",
      "backup.sh",
      "record previous-release",
      "record begin",
      "docker compose pull",
      "migrate",
      "docker compose up -d",
      "docker compose ps",
      "record finish",
    ]);
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
  });

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
describe("updating a box whose engine is an image", () => {
  const KEEPER_OLD = `registry.example/lares-keeper@sha256:${"d".repeat(64)}`;
  const KEEPER_NEW = `registry.example/lares-keeper@sha256:${"e".repeat(64)}`;
  const BOX = join(here, "..");
  let boxDir: string;
  let prefix: string;

  function releaseWithKeeper(keeper?: string) {
    return JSON.stringify({
      release: "2026-10-01",
      images: { console: CONSOLE_NEW, "chief-of-staff": ROLE_NEW, ...(keeper ? { "lares-keeper": keeper } : {}) },
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
    // Nothing of the box's own may go through pnpm in image mode.
    stub("pnpm", 'printf "pnpm %s\\n" "$*" >> "$STUB_LOG"; exit 0');
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
      "bin/update-record.ts", // previous-release
      "bin/update-record.ts", // begin
      "migrate.ts",
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
    const dbRuns = engineRuns().filter((l) => !/update-record\.ts release/.test(l));
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

  it("a box without an engine-image file still updates on the host, with pnpm, exactly as before", () => {
    const r = run(["--release", release, "--yes"]);
    expect(r.code).toBe(0);
    expect(calls()).toMatch(MIGRATE);
    expect(engineRuns()).toEqual([]);
  });
});
