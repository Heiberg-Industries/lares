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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "update.sh");

const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
const CONSOLE_OLD = `registry.example/lares-console@sha256:${OLD}`;
const CONSOLE_NEW = `registry.example/lares-console@sha256:${NEW}`;
const ROLE_OLD = `registry.example/lares-chief-of-staff@sha256:${OLD}`;
const ROLE_NEW = `registry.example/lares-chief-of-staff@sha256:${NEW}`;

let dir: string;
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
function composeYaml() {
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
    "      - /var/lib/lares/postgres:/var/lib/postgresql/data",
    "      - type: bind",
    "        source: /var/lib/lares-maintenance/postgres-auth",
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

function stub(name: string, body: string, where = binDir) {
  const path = join(where, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "update-script-"));
  binDir = join(dir, "bin");
  opsDir = join(dir, "ops");
  composeDir = join(dir, "compose");
  mkdirSync(binDir);
  mkdirSync(opsDir);
  mkdirSync(composeDir);
  composeFile = join(composeDir, "compose.yaml");
  writeFileSync(composeFile, composeYaml());
  release = join(dir, "release.json");
  writeFileSync(release, goodRelease());
  log = join(dir, "calls.log");
  operatorPasswordFile = join(dir, "operator-password");
  writeFileSync(operatorPasswordFile, "test-only-operator-password\n", { mode: 0o600 });

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
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync("/bin/bash", [SCRIPT, ...args], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        STUB_LOG: log,
        LARES_OPS_DIR: opsDir,
        DB_COMPOSE_DIR: composeDir,
        UPDATE_COMPOSE_FILES: "compose.yaml",
        LARES_UPDATE_RECORDER: join(binDir, "record"),
        LARES_OPERATOR_PASSWORD_FILE: operatorPasswordFile,
        LARES_MAINTENANCE_TESTING: "1",
        ...env,
      },
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
  expect(mount).toMatchObject({ type: "bind", source: "/var/lib/lares-maintenance/postgres-auth", target: "/run/lares-auth", read_only: true, bind: { create_host_path: false } });
  if (process.env.CI === "true") {
    const effective = JSON.parse(execFileSync("docker", ["compose", "-f", composeFile, "config", "--format", "json"], { encoding: "utf8" })) as {
      services: { db?: { command?: string[]; volumes?: Array<{ type?: string; source?: string; target?: string; read_only?: boolean; bind?: { create_host_path?: boolean } }> } };
    };
    expect(effective.services.db?.command).toEqual(["postgres", "-c", "hba_file=/run/lares-auth/pg_hba.conf"]);
    const effectiveAuthMount = effective.services.db?.volumes?.find((volume) => volume.source === "/var/lib/lares-maintenance/postgres-auth" && volume.target === "/run/lares-auth");
    expect(effectiveAuthMount).toMatchObject({ type: "bind", source: "/var/lib/lares-maintenance/postgres-auth", target: "/run/lares-auth", read_only: true });
    const bind = effectiveAuthMount?.bind;
    expect(bind !== undefined && bind !== null && typeof bind === "object" && !Array.isArray(bind) &&
      (!("create_host_path" in bind) || bind.create_host_path === false)).toBe(true);
  }
}

describe("updating this installation", () => {
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
    prefix = join(dir, "root");
    mkdirSync(prefix);
    writeFileSync(release, releaseWithKeeper(KEEPER_NEW));
    // Wrap the shared docker stub: `docker run` is answered here, the rest passes through.
    mkdirSync(join(binDir, "real"));
    const base = join(binDir, "real", "docker");
    writeFileSync(base, readFileSync(join(binDir, "docker"), "utf8"));
    chmodSync(base, 0o755);
    stub(
      "docker",
      [
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
    run(args, { LARES_BOX_DIR: boxDir, LARES_PREFIX: prefix, LARES_UPDATE_RECORDER: "", ...env });
  const engineRuns = () => calls().split("\n").filter((l) => l.startsWith("docker run "));

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
      expect(line).toContain("--network host --user 0:0 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges");
      expect(line).not.toContain("docker.sock");
    }
    expect(calls()).not.toMatch(/^pnpm /m);
  });

  it("applies the migrations after the backup and the record, and before the switch", () => {
    imageRun(["--release", release, "--yes"]);
    const migrate = at(/docker run .*migrate\.ts/);
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
    expect(migration).toContain(`-v ${operatorPasswordFile}:${operatorPasswordFile}:ro`);
    expect(migration).toContain(`-e DATABASE_PASSWORD_FILE=${operatorPasswordFile}`);
    expect(migration).not.toContain("PGPASSWORD");
    for (const line of dbRuns.filter((line) => !/migrate\.ts/.test(line))) {
      expect(line).toContain(`-e DATABASE_PASSWORD_FILE=${secrets}/database-password`);
      expect(line).toContain(`-v ${secrets}/database-password:${secrets}/database-password:ro`);
      expect(line).not.toContain(operatorPasswordFile);
      expect(line).not.toContain("PGPASSWORD");
    }
    // The release file is mounted read-only, at the same path inside.
    const releaseRun = engineRuns().find((l) => /update-record\.ts release/.test(l))!;
    expect(releaseRun).toContain(`-v ${release}:${release}:ro`);
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
    expect(at(new RegExp(`docker pull ${KEEPER_NEW}`))).toBeLessThan(at(/docker run /));

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
