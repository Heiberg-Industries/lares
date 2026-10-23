// rollback.sh is the command a person runs at two in the morning, after an update has already
// gone wrong. It must do exactly one thing and be unable to do a second, so these
// tests drive the whole ordering with stubs and assert the exact sequence of external calls —
// and, for the one property that matters most, run the real update.sh first:
//
//   read the recorded update -> say what it would put back and what it does NOT put back
//   -> copy the compose file aside -> write the previous digests -> docker compose pull
//   -> docker compose up -d -> health check -> record 'rolled-back'
//
// The stubs are the same shape as tests/update-script.test.ts's: every external command is a
// stub on PATH that appends its own argv to one shared log (STUB_LOG), in the style of
// tests/restore-drill.test.ts. The `record` stub is a small state machine over one file, so
// update.sh and rollback.sh can be run one after the other and the second run sees what the
// first one wrote — which is how "one step only" is proved rather than asserted.
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
const SCRIPT = join(here, "..", "ops", "rollback.sh");
const UPDATE_SCRIPT = join(here, "..", "ops", "update.sh");

/** The digests that were running BEFORE the last update — what a rollback puts back. */
const PREV = "b".repeat(64);
/** The digests running NOW, which the last update installed. */
const CUR = "c".repeat(64);
const CONSOLE = "registry.example/lares-console";
const ROLE = "registry.example/lares-chief-of-staff";

let dir: string;
let binDir: string;
let opsDir: string;
let composeDir: string;
let composeFile: string;
let state: string;
let log: string;
let operatorPasswordFile: string;

/** What the installation is running: two digest-pinned services and one that is not. */
function composeYaml(digest: string) {
  return [
    "services:",
    "  lares-console:",
    `    image: ${CONSOLE}@sha256:${digest}`,
    "    restart: unless-stopped",
    "  lares-chief-of-staff:",
    `    image: ${ROLE}@sha256:${digest}`,
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

/** One row of update_history, in the order the `record` stub stores its columns. */
function updateRow(outcome: string, images: Record<string, string> = {
  "lares-console": `${CONSOLE}@sha256:${PREV}`,
  "lares-chief-of-staff": `${ROLE}@sha256:${PREV}`,
}) {
  return ["41", outcome, "2026-10-01", "9f8e7d6c", JSON.stringify(images)].join("\t") + "\n";
}

function stub(name: string, body: string, where = binDir) {
  const path = join(where, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rollback-script-"));
  binDir = join(dir, "bin");
  opsDir = join(dir, "ops");
  composeDir = join(dir, "compose");
  mkdirSync(binDir);
  mkdirSync(opsDir);
  mkdirSync(composeDir);
  composeFile = join(composeDir, "compose.yaml");
  writeFileSync(composeFile, composeYaml(CUR));
  state = join(dir, "update-history.tsv");
  writeFileSync(state, updateRow("ok"));
  log = join(dir, "calls.log");
  operatorPasswordFile = join(dir, "operator-password");
  writeFileSync(operatorPasswordFile, "fixture-only-operator-password\n", { mode: 0o600 });

  const logLine = 'printf "%s %s\\n" "$(basename "$0")" "$*" >> "$STUB_LOG"';

  // docker: dispatches on shape the way the real CLI answers different subcommands. The psql
  // branch is only reached by update.sh (rollback.sh never speaks to the database directly).
  stub(
    "docker",
    [
      logLine,
      'args="$*"',
      'case "$args" in',
      '  *"config --format json"*) printf \'{"services":{"db":{"image":"postgres:16-alpine"}}}\\n\'; exit 0 ;;',
      "  *psql*-tAc*)",
      '    printf "%s\\n" "${STUB_BACKUP_STATUS-t|3600}"',
      "    ;;",
      '  *" pull"*|*" pull "*)',
      '    [ -z "${STUB_PULL_FAIL:-}" ] || { echo "docker: manifest unknown" >&2; exit 1; }',
      "    ;;",
      '  *"up -d"*)',
      '    [ -z "${STUB_UP_FAIL:-}" ] || { echo "docker: could not start" >&2; exit 1; }',
      "    ;;",
      "  *ps*--services*)",
      '    printf "%s\\n" ${STUB_RUNNING-lares-console lares-chief-of-staff}',
      "    ;;",
      "esac",
      "exit 0",
    ].join("\n"),
  );
  // update.sh's offline database step validates the operator credential's owner and mode.
  stub("stat", "echo 0:600");

  // pnpm: rollback.sh must never reach for it. Only update.sh does, for the migration runner.
  stub("pnpm", [logLine, "exit 0"].join("\n"));

  // backup.sh: only update.sh takes a backup; a rollback takes none.
  stub("backup.sh", [logLine, 'echo "snapshot 9f8e7d6c saved"', "exit 0"].join("\n"), opsDir);

  // The recorder seam, standing in for update-history.ts against a real database. It is a
  // state machine over one TSV file so that a rollback sees what the update before it wrote:
  //   id <TAB> outcome <TAB> to_release <TAB> snapshot_id <TAB> images(JSON)
  stub(
    "record",
    [
      logLine,
      'if [ -n "${TEST_LOG_ENV:-}" ]; then printf "record env PGUSER=%s DATABASE_PASSWORD_FILE=%s\\n" "${PGUSER-}" "${DATABASE_PASSWORD_FILE-}" >> "$STUB_LOG"; fi',
      'state="$STUB_STATE"',
      'case "$1" in',
      "  begin)",
      "    printf '41\\tstarted\\t%s\\t%s\\t%s\\n' \"$3\" \"$5\" \"$4\" >> \"$state\"",
      '    echo "41"',
      "    ;;",
      "  finish)",
      "    awk -F'\\t' -v OFS='\\t' -v id=\"$2\" -v outcome=\"$3\" '$1 == id { $2 = outcome } { print }' \"$state\" > \"$state.tmp\"",
      '    mv "$state.tmp" "$state"',
      "    ;;",
      "  previous-release)",
      '    printf "%s\\n" "${STUB_PREVIOUS_RELEASE-2026-09-01}"',
      "    ;;",
      "  previous-images)",
      '    [ -z "${STUB_RECORD_FAIL:-}" ] || { echo "relation \\"update_history\\" does not exist" >&2; exit 1; }',
      '    [ -s "$state" ] || exit 0',
      '    line=$(tail -1 "$state")',
      "    printf 'record\\t%s\\t%s\\t%s\\t%s\\n' \"$(printf '%s' \"$line\" | cut -f1)\" \"$(printf '%s' \"$line\" | cut -f2)\" \"$(printf '%s' \"$line\" | cut -f3)\" \"$(printf '%s' \"$line\" | cut -f4)\"",
      "    printf '%s' \"$line\" | cut -f5 | tr -d '{}\"' | tr ',' '\\n' | awk '{ i = index($0, \":\"); if (i > 0) print \"image\\t\" substr($0, 1, i - 1) \"\\t\" substr($0, i + 1) }'",
      "    ;;",
      "esac",
      "exit 0",
    ].join("\n"),
  );
  stub("node", 'case "$1:$2" in */bin/update-record.ts:release) exec "$TEST_REAL_NODE" "$@" ;; */bin/update-record.ts:*) shift; exec "$TEST_RECORD" "$@" ;; *) exec "$TEST_REAL_NODE" "$@" ;; esac');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runScript(script: string, args: string[], env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync("/bin/bash", [script, ...args], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        STUB_LOG: log,
        STUB_STATE: state,
        LARES_OPS_DIR: opsDir,
        DB_COMPOSE_DIR: composeDir,
        UPDATE_COMPOSE_FILES: "compose.yaml",
        LARES_UPDATE_RECORDER: join(binDir, "record"),
        LARES_OPERATOR_PASSWORD_FILE: operatorPasswordFile,
        TEST_RECORD: join(binDir, "record"),
        TEST_REAL_NODE: process.execPath,
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

const run = (args: string[], env: Record<string, string> = {}) => runScript(SCRIPT, args, env);
const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
/** Where a call matching `re` first appears in the log, or -1 — the ordering primitive. */
function at(re: RegExp): number {
  const m = re.exec(calls());
  return m ? m.index : -1;
}
const PULL = /docker compose .*\bpull\b/;
const UP = /docker compose .*up -d/;
const READ = /record previous-images/;
const FINISH = /record finish/;
const compose = () => readFileSync(composeFile, "utf8");
function expectNormalAuthCompose() {
  const db = (parse(compose()) as { services: Record<string, { command?: string | string[]; volumes?: Array<string | { type?: string; source?: string; target?: string; read_only?: boolean; bind?: { create_host_path?: boolean } }> }> }).services.db!;
  expect(Array.isArray(db.command) ? db.command.join(" ") : db.command).toContain("hba_file=/run/lares-auth/pg_hba.conf");
  const mount = db.volumes?.find((volume) => typeof volume !== "string" && volume.target === "/run/lares-auth");
  expect(mount).toMatchObject({ type: "bind", source: "/var/lib/lares-maintenance/postgres-auth", target: "/run/lares-auth", read_only: true, bind: { create_host_path: false } });
  if (process.env.CI === "true") {
    const effective = JSON.parse(execFileSync("docker", ["compose", "-f", composeFile, "config", "--format", "json"], { encoding: "utf8" })) as {
      services: { db?: { command?: string[]; volumes?: Array<{ source?: string; target?: string; read_only?: boolean; bind?: { create_host_path?: boolean } }> } };
    };
    expect(effective.services.db?.command).toEqual(["postgres", "-c", "hba_file=/run/lares-auth/pg_hba.conf"]);
    expect(effective.services.db?.volumes).toContainEqual(expect.objectContaining({ source: "/var/lib/lares-maintenance/postgres-auth", target: "/run/lares-auth", read_only: true, bind: { create_host_path: false } }));
  }
}

describe("putting the previous version back", () => {
  it("pins the host recorder to the application role and password file", () => {
    const r = run(["--dry-run"], {
      LARES_UPDATE_RECORDER: "",
      TEST_LOG_ENV: "1",
      PGUSER: "legacy_role",
      DATABASE_PASSWORD_FILE: "/legacy/password",
    });
    expect(r.code, r.stderr).toBe(0);
    expect(calls()).toContain("record env PGUSER=lares_app DATABASE_PASSWORD_FILE=/etc/lares/secrets/database-password");
    expect(calls()).not.toContain("record env PGUSER=legacy_role DATABASE_PASSWORD_FILE=/legacy/password");
  });

  it("shows what it would put back, and asks, before it does anything", () => {
    const r = run(["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/sha256:[a-f0-9]{64}/);
    expect(calls()).not.toMatch(UP);
    expect(calls()).not.toMatch(PULL);
    expect(compose()).toBe(composeYaml(CUR));
  });

  it("puts back exactly the digests that were running, and nothing else", () => {
    const r = run(["--yes"]);
    expect(r.code).toBe(0);
    expect(calls()).toMatch(PULL);
    // The digests are in the compose file the pull and the switch read, which is where the
    // real proof lives — the argv of `docker compose pull` never names an image.
    expect(compose()).toMatch(new RegExp(`@sha256:b{64}`));
    expect(compose()).not.toContain(CUR);
    expect(compose()).not.toMatch(/:latest|:main/);
    // Everything that was not in the record is left exactly as it was.
    expect(compose()).toContain("postgres:16-alpine");
    expect(compose()).toContain("restart: unless-stopped");
    expectNormalAuthCompose();
  });

  it("runs its steps in exactly one order, and records the rollback last", () => {
    run(["--yes"]);
    const sequence = calls()
      .trim()
      .split("\n")
      .map((line) => {
        if (/^record /.test(line)) return line.split(" ").slice(0, 2).join(" ");
        if (PULL.test(line)) return "docker compose pull";
        if (UP.test(line)) return "docker compose up -d";
        if (/ps --services/.test(line)) return "docker compose ps";
        return line.split(" ")[0]!;
      });
    expect(sequence).toEqual([
      "record previous-images",
      "docker compose pull",
      "docker compose up -d",
      "docker compose ps",
      "record finish",
    ]);
  });

  it("says plainly that it does not put the database back, every time", () => {
    const dry = run(["--dry-run"]);
    expect(dry.stdout).toMatch(/does not.*database|database is not/i);
    expect(dry.stdout).toMatch(/restore/i);
    expect(dry.stdout).toContain("docs/runbooks/export-and-teardown.md");
    // The backup taken before that update is named, so there is no hunting for it.
    expect(dry.stdout).toContain("9f8e7d6c");
    // And the same sentence on a real run, before it acts.
    const real = run(["--yes"]);
    expect(real.stdout).toMatch(/does not.*database|database is not/i);
    expect(real.stdout.indexOf("It does not put the database back")).toBeLessThan(
      real.stdout.indexOf("pulling"),
    );
  });

  it("refuses when nothing has ever been recorded, instead of guessing a digest", () => {
    writeFileSync(state, "");
    const r = run(["--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/no update .* recorded/i);
    expect(r.stderr).toMatch(/nothing written down to go back to/);
    expect(calls()).not.toMatch(/docker compose/);
    expect(compose()).toBe(composeYaml(CUR));
  });

  it("refuses when it cannot read the record at all, rather than acting blind", () => {
    const r = run(["--yes"], { STUB_RECORD_FAIL: "1" });
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/001_baseline\.sql/);
    expect(calls()).not.toMatch(/docker compose/);
  });

  it("never runs a migration, forwards or backwards", () => {
    run(["--yes"]);
    expect(calls()).not.toMatch(/migrate/);
    expect(calls()).not.toMatch(/^pnpm/m);
    expect(calls()).not.toMatch(/psql/);
  });

  it("records that a rollback happened", () => {
    run(["--yes"]);
    expect(calls()).toMatch(/record finish 41 rolled-back/);
    expect(readFileSync(state, "utf8")).toContain("rolled-back");
  });

  it("only ever goes back one step", () => {
    const r = run(["--dry-run"]);
    expect(r.stdout.match(/sha256:/g)!.length).toBeLessThanOrEqual(6);
    expect(r.stdout).not.toMatch(/--steps|--to-release/);
    // Not offered anywhere either: the usage text is the only list of what this command takes.
    expect(run(["--help"]).stderr).not.toMatch(/--steps|--to-release/);
  });

  // The property D3 is actually about: after a rollback, a second one refuses rather than
  // walking further back or flipping forward again. Proved by running the REAL update.sh
  // first, so the record a rollback reads is the record an update actually wrote.
  it("refuses a second rollback: update, rollback, rollback", () => {
    writeFileSync(state, "");
    writeFileSync(composeFile, composeYaml(PREV));
    const release = join(dir, "release.json");
    writeFileSync(
      release,
      JSON.stringify({
        release: "2026-10-01",
        images: { console: `${CONSOLE}@sha256:${CUR}`, "chief-of-staff": `${ROLE}@sha256:${CUR}` },
        migrations: { box: "001_baseline.sql" },
        breaking: [],
      }),
    );
    const update = runScript(UPDATE_SCRIPT, ["--release", release, "--yes"]);
    expect(update.code, update.stderr).toBe(0);
    expect(compose()).toContain(CUR);

    const first = run(["--yes"]);
    expect(first.code).toBe(0);
    expect(compose()).toContain(PREV);
    expect(compose()).not.toContain(CUR);

    rmSync(log, { force: true });
    const second = run(["--yes"]);
    expect(second.code).toBe(78);
    expect(second.stderr).toMatch(/already been put back one step/);
    // Nothing was called: no pull, no switch, no second record.
    expect(calls()).not.toMatch(/docker compose/);
    expect(calls()).not.toMatch(FINISH);
    // And it did not flip forward again either.
    expect(compose()).toContain(PREV);
  });

  it("refuses when the last update never finished, rather than racing it", () => {
    writeFileSync(state, updateRow("started"));
    const r = run(["--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/has not finished/);
    expect(calls()).not.toMatch(/docker compose/);
  });

  // update.sh names rollback.sh when it fails after the switch; that record says 'failed',
  // and this is the case the whole command exists for.
  it("puts back an update that failed after it switched", () => {
    writeFileSync(state, updateRow("failed"));
    const r = run(["--yes"]);
    expect(r.code).toBe(0);
    expect(compose()).toContain(PREV);
    expect(calls()).toMatch(/record finish 41 rolled-back/);
  });

  it("refuses a recorded image that is not a digest, rather than installing a tag", () => {
    writeFileSync(state, updateRow("ok", { "lares-console": `${CONSOLE}:before-the-update` }));
    const r = run(["--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/not an image pinned by digest/);
    expect(calls()).not.toMatch(/docker compose/);
    expect(compose()).toBe(composeYaml(CUR));
  });

  it("refuses when a recorded service is not in any compose file on this box", () => {
    writeFileSync(
      state,
      updateRow("ok", {
        "lares-console": `${CONSOLE}@sha256:${PREV}`,
        "lares-gone": `registry.example/lares-gone@sha256:${PREV}`,
      }),
    );
    const r = run(["--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/lares-gone/);
    expect(calls()).not.toMatch(/docker compose/);
    expect(compose()).toBe(composeYaml(CUR));
  });

  it("refuses when no compose file on this box can be found", () => {
    rmSync(composeFile);
    const r = run(["--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/UPDATE_COMPOSE_FILES/);
    expect(calls()).not.toMatch(/docker compose/);
  });

  it("puts the compose file back when the old digests cannot be pulled, and records nothing", () => {
    const r = run(["--yes"], { STUB_PULL_FAIL: "1" });
    expect(r.code).toBe(70);
    expect(r.stderr).toMatch(/could not be pulled/);
    expect(r.stderr).toMatch(/still running/);
    expect(compose()).toBe(composeYaml(CUR));
    expect(calls()).not.toMatch(UP);
    expect(calls()).not.toMatch(FINISH);
    expect(readFileSync(state, "utf8")).not.toContain("rolled-back");
  });

  it("leaves the compose file fully old when the switch itself fails, and records nothing", () => {
    const r = run(["--yes"], { STUB_UP_FAIL: "1" });
    expect(r.code).toBe(70);
    expect(r.stderr).toMatch(/could not be started/);
    expect(compose()).toBe(composeYaml(PREV));
    expectNormalAuthCompose();
    expect(calls()).not.toMatch(FINISH);
    expect(readFileSync(state, "utf8")).not.toContain("rolled-back");
  });

  it("stops when a service does not come up, and does not record a rollback it cannot vouch for", () => {
    const r = run(["--yes"], { STUB_RUNNING: "lares-console" });
    expect(r.code).toBe(70);
    expect(r.stderr).toMatch(/lares-chief-of-staff/);
    expect(calls()).not.toMatch(FINISH);
    expect(calls().match(new RegExp(UP.source, "g"))!.length).toBe(1);
  });

  it("asks before it acts when nobody passed --yes", () => {
    const r = run([]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/--yes/);
    expect(calls()).not.toMatch(/docker compose/);
    expect(at(READ)).toBeGreaterThan(-1);
    expect(compose()).toBe(composeYaml(CUR));
    expectNormalAuthCompose();
  });

  it("refuses an argument it does not know, rather than guessing what was meant", () => {
    expect(run(["--force"]).code).toBe(64);
    expect(run(["--to-release", "2026-09-01"]).code).toBe(64);
    expect(calls()).toBe("");
  });

  it("says the keeper will put its own image back, rather than pretending otherwise", () => {
    expect(run(["--dry-run"]).stdout).toMatch(/keeper/);
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

// IMAGE MODE. On a box whose engine came from an image the record is read and closed by a
// program run in a throwaway container of this box's own engine image (a rollback applies no
// migration, so there is no "target" release to switch to). No node, no pnpm, no secret in argv.
describe("rolling back a box whose engine is an image", () => {
  const ENGINE = `registry.example/lares-keeper@sha256:${"d".repeat(64)}`;
  let prefix: string;

  beforeEach(() => {
    prefix = join(dir, "root");
    mkdirSync(prefix);
    mkdirSync(join(binDir, "real"));
    const base = join(binDir, "real", "docker");
    writeFileSync(base, readFileSync(join(binDir, "docker"), "utf8"));
    chmodSync(base, 0o755);
    const prevImages = [
      `image\tlares-console\t${CONSOLE}@sha256:${PREV}`,
      `image\tlares-chief-of-staff\t${ROLE}@sha256:${PREV}`,
    ].join("\\n");
    stub(
      "docker",
      [
        'if [ "$1" = run ]; then',
        '  printf "docker %s\\n" "$*" >> "$STUB_LOG"',
        '  args=("$@"); at=-1',
        '  for ((i = 0; i < ${#args[@]}; i++)); do [ "${args[i]}" = --entrypoint ] && at=$i; done',
        '  rest=("${args[@]:at+4}")',
        '  case "${rest[0]}" in',
        `    previous-images) printf 'record\\t41\\tok\\t2026-10-01\\t9f8e7d6c\\n${prevImages}\\n' ;;`,
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
  });

  const imageRun = (args: string[], env: Record<string, string> = {}) =>
    run(args, { LARES_ENGINE_IMAGE: ENGINE, LARES_PREFIX: prefix, LARES_UPDATE_RECORDER: "", ...env });
  const engineRuns = () => calls().split("\n").filter((l) => l.startsWith("docker run "));

  it("reads and closes the record in the box's engine image, and puts the previous digests back", () => {
    const r = imageRun(["--yes"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const runs = engineRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatch(/update-record\.ts previous-images$/);
    expect(runs[1]).toMatch(/update-record\.ts finish 41 rolled-back /);
    for (const line of runs) {
      expect(line).toContain(ENGINE);
      expect(line).toContain("--network host --user 0:0 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges");
      expect(line).not.toContain("docker.sock");
    }
    expect(compose()).toMatch(new RegExp(`@sha256:b{64}`));
    expect(compose()).not.toContain(CUR);
  });

  it("hands the database password over as a file in a read-only mount, never as a value", () => {
    imageRun(["--yes"]);
    const secrets = join(prefix, "etc", "lares", "secrets");
    for (const line of engineRuns()) {
      expect(line).toContain(`-e DATABASE_PASSWORD_FILE=${secrets}/database-password`);
      expect(line).toContain(`-v ${secrets}/database-password:${secrets}/database-password:ro`);
      expect(line).toContain("-e PGUSER=lares_app");
      expect(line).not.toContain(`-v ${secrets}:${secrets}:ro`);
      expect(line).not.toContain("PGPASSWORD");
    }
  });

  it("applies no migration and calls no pnpm, in either direction", () => {
    imageRun(["--yes"]);
    expect(calls()).not.toMatch(/migrate/);
    expect(calls()).not.toMatch(/^pnpm/m);
  });

  it("refuses, changing nothing, when no engine image is known or it cannot be fetched", () => {
    const missing = imageRun(["--yes"], { LARES_ENGINE_IMAGE: "registry.example/lares-keeper:latest" });
    expect(missing.code).toBe(78);
    expect(missing.stderr).toMatch(/engine image is not known/);
    const refused = imageRun(["--yes"], { STUB_NO_ENGINE_IMAGE: "1", STUB_ENGINE_PULL_FAIL: "1" });
    expect(refused.code).toBe(78);
    expect(refused.stderr).toMatch(/could not download the engine image/);
    expect(calls()).not.toMatch(/docker compose/);
    expect(compose()).toBe(composeYaml(CUR));
  });

  it("a box without an engine image still rolls back on the host, exactly as before", () => {
    const r = run(["--yes"]);
    expect(r.code).toBe(0);
    expect(engineRuns()).toEqual([]);
  });
});
