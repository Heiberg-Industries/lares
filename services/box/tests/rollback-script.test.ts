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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, chownSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "rollback.sh");
const UPDATE_SCRIPT = join(here, "..", "ops", "update.sh");

/** The digests that were running BEFORE the last update — what a rollback puts back. */
const PREV = "b".repeat(64);
/** The digests running NOW, which the last update installed. */
const CUR = "c".repeat(64);
const CONSOLE = "registry.example/lares-console";
const ROLE = "registry.example/lares-chief-of-staff";
const KEEPER = "registry.example/lares-keeper";
const KEEPER_PREV = `${KEEPER}@sha256:${"d".repeat(64)}`;
const KEEPER_CUR = `${KEEPER}@sha256:${"e".repeat(64)}`;

let dir: string;
let prefix: string;
let binDir: string;
let opsDir: string;
let composeDir: string;
let composeFile: string;
let state: string;
let log: string;
let operatorPasswordFile: string;

/** What the installation is running: two digest-pinned services and one that is not. */
function composeYaml(digest: string, targetPrefix = prefix) {
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

/** Disposable fixture composition derived from the committed Keeper service template. */
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
  writeFileSync(composeFile, composeYaml(CUR, prefix));
  state = join(dir, "update-history.tsv");
  writeFileSync(state, updateRow("ok"));
  log = join(dir, "calls.log");
  operatorPasswordFile = join(prefix, "etc", "lares", "operator", "database-password");
  writeFileSync(operatorPasswordFile, "fixture-only-operator-password\n", { mode: 0o600 });
  chownSync(operatorPasswordFile, process.getuid!(), process.getgid!());
  chmodSync(operatorPasswordFile, 0o600);

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
  // The macOS test host may not ship coreutils timeout; production installs run on Linux.
  // This pass-through keeps isolated Docker stubs fast without changing production behavior.
  stub("timeout", 'if [[ "$1" == --kill-after=* ]]; then shift; elif [ "$1" = --kill-after ]; then shift 2; fi; shift; exec "$@"');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runScript(script: string, args: string[], env: Record<string, string> = {}) {
  try {
    const childEnv: Record<string, string> = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      STUB_LOG: log,
      STUB_STATE: state,
      LARES_OPS_DIR: opsDir,
      LARES_PREFIX: prefix,
      DB_COMPOSE_DIR: composeDir,
      UPDATE_COMPOSE_FILES: "compose.yaml",
      LARES_UPDATE_RECORDER: join(binDir, "record"),
      LARES_OPERATOR_PASSWORD_FILE: operatorPasswordFile,
      TEST_RECORD: join(binDir, "record"),
      TEST_REAL_NODE: process.execPath,
      LARES_MAINTENANCE_TESTING: "1",
      ...env,
    };
    if (env.UNSET_DB_COMPOSE_DIR === "1") delete childEnv.DB_COMPOSE_DIR;
    delete childEnv.UNSET_DB_COMPOSE_DIR;
    const stdout = execFileSync("/bin/bash", [script, ...args], {
      env: childEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}

const run = (args: string[], env: Record<string, string> = {}) => runScript(SCRIPT, args, env);
const runUpdate = (args: string[], env: Record<string, string> = {}) => runScript(UPDATE_SCRIPT, args, env);
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

describe("putting the previous version back", () => {
  it("refuses a Compose path outside the same installation before rollback work", () => {
    const refused = run(["--dry-run"], { UPDATE_COMPOSE_FILES: "../other/compose.yaml" });
    expect(refused.code).toBe(78);
    expect(calls()).toBe("");
  });

  it("keeps the committed Keeper guard fields through a failed update and the real rollback script", () => {
    const keeperCompose = join(composeDir, "keeper.yaml");
    const keeperEnv = join(composeDir, "keeper.env");
    const identityEnv = "LARES_MAINTENANCE_INSTALLATION_ID=fixture-installation-id\nLARES_MAINTENANCE_EPOCH=7\n";
    writeFileSync(keeperCompose, keeperComposeYaml(KEEPER_PREV, keeperEnv));
    writeFileSync(keeperEnv, identityEnv);
    const release = join(dir, "release.json");
    writeFileSync(release, JSON.stringify({
      release: "2026-10-01",
      images: { console: `${CONSOLE}@sha256:${CUR}`, "chief-of-staff": `${ROLE}@sha256:${CUR}`, "lares-keeper": KEEPER_CUR },
      migrations: { box: "001_baseline.sql" }, breaking: [],
    }));
    const filesEnv = { UPDATE_COMPOSE_FILES: "compose.yaml keeper.yaml", STUB_RUNNING: "lares-console lares-chief-of-staff lares-keeper" };
    const updated = runUpdate(["--release", release, "--yes"], { ...filesEnv, STUB_UP_FAIL: "1" });
    expect(updated.code, updated.stderr).toBe(70);
    expect(readFileSync(keeperCompose, "utf8")).toContain(KEEPER_CUR);
    const rolledBack = run(["--yes"], filesEnv);
    expect(rolledBack.code, rolledBack.stderr).toBe(0);
    const output = parse(readFileSync(keeperCompose, "utf8")) as {
      services: { "lares-keeper": { image?: string; entrypoint?: string[]; volumes?: Array<string | { source?: string; target?: string; read_only?: boolean; bind?: { create_host_path?: boolean } }> } };
    };
    const service = output.services["lares-keeper"];
    expect(service.image).toBe(KEEPER_PREV);
    expect(service.entrypoint).toEqual(["/usr/local/lib/lares/maintenance-admission-v1", "/run/lares-maintenance/admission", "fixture-installation-id", "7", "--"]);
    expect(service.volumes).toContainEqual(expect.objectContaining({ source: "/tmp/keeper-admission-fixture", target: "/run/lares-maintenance/admission", read_only: true, bind: { create_host_path: false } }));
    expect(readFileSync(keeperEnv, "utf8")).toBe(identityEnv);
  });

  it("pins the host recorder to the application role and password file", () => {
    const r = run(["--dry-run"], {
      LARES_UPDATE_RECORDER: "",
      TEST_LOG_ENV: "1",
      PGUSER: "legacy_role",
      DATABASE_PASSWORD_FILE: "/legacy/password",
    });
    expect(r.code, r.stderr).toBe(0);
    expect(calls()).toContain(`record env PGUSER=lares_app DATABASE_PASSWORD_FILE=${prefix}/etc/lares/secrets/database-password`);
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
    expect(r.stderr).toMatch(/requested Compose.*do not match/);
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

  it("requires an explicit Compose directory for an explicit non-root prefix before effects", () => {
    const r = run(["--dry-run"], { UNSET_DB_COMPOSE_DIR: "1" });
    expect(r.code).toBe(78);
    expect(calls()).toBe("");
  });

  it("decides whether the prefix needs an explicit Compose directory from its path", () => {
    expect(readFileSync(SCRIPT, "utf8")).toContain('elif [ "$ADMISSION_PREFIX" != / ]; then COMPOSE_DIR=""');
    expect(readFileSync(UPDATE_SCRIPT, "utf8")).toContain('elif [ "$ADMISSION_PREFIX" != / ]; then COMPOSE_DIR=""');
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
    prefix = dirname(dirname(composeDir));
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
        'if [ "$1" = create ]; then',
        '  printf "docker %s\n" "$*" >> "$STUB_LOG"',
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
        '  [ "${STUB_CREATE_PARTIAL:-}" = 1 ] || printf "%s\n" "$cid_id" > "$cidfile"; : > "$STUB_LOG.output"',
        '  if [ "$script_at" -ge 0 ] && [ "${args[script_at+1]:-}" = previous-images ]; then',
        '    printf "record\t41\tok\t2026-10-01\t9f8e7d6c\nimage\tlares-console\tregistry.example/lares-console@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nimage\tlares-chief-of-staff\tregistry.example/lares-chief-of-staff@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n" > "$STUB_LOG.output"',
        '  fi',
        '  printf "%s\n%s\n%s\n%s\n" "$id" "$owner" "$operation" "$name" > "$STUB_LOG.identity"; echo 0 > "$STUB_LOG.status"; [ "${STUB_CREATE_PARTIAL:-}" != 1 ] || exit 124; exit 0',
        'fi',
        'if [ "$1" = start ] && [ "$2" = --attach ]; then printf "docker %s\n" "$*" >> "$STUB_LOG"; cat "$STUB_LOG.output"; exit 0; fi',
        'if [ "$1" = wait ]; then printf "docker %s\n" "$*" >> "$STUB_LOG"; cat "$STUB_LOG.status"; exit 0; fi',
        'if [ "$1" = inspect ] && [ "$2" != image ]; then',
        '  printf "docker %s\n" "$*" >> "$STUB_LOG"',
        '  if [[ "$*" == *Config.Entrypoint* ]]; then echo \'["/usr/local/lib/lares/maintenance-admission-v1"]\'; exit 0; fi',
        '  [ -f "$STUB_LOG.identity" ] || exit 1',
        '  read -r id < <(sed -n "1p" "$STUB_LOG.identity"); read -r owner < <(sed -n "2p" "$STUB_LOG.identity"); read -r operation < <(sed -n "3p" "$STUB_LOG.identity"); read -r name < <(sed -n "4p" "$STUB_LOG.identity"); read -r status < "$STUB_LOG.status"',
        '  if [ "${STUB_REPLACE_CLIENT_NAME:-}" = 1 ] && [ "${@: -1}" = "$name" ]; then printf "deadbeefdeadbeefdeadbeefdeadbeef|false|attacker|rollback\n"; exit 0; fi',
        '  case "$*" in *State.ExitCode*) printf "%s|false|%s|%s|%s\n" "$id" "$status" "$owner" "$operation" ;; *State.Running*) printf "%s|false|%s|%s|/%s\n" "$id" "$owner" "$operation" "$name" ;; *) printf "%s|/%s|%s|%s\n" "$id" "$name" "$owner" "$operation" ;; esac',
        '  exit 0',
        'fi',
        'if [ "$1" = stop ]; then printf "docker %s\n" "$*" >> "$STUB_LOG"; exit 0; fi',
        'if [ "$1" = rm ]; then printf "docker %s\n" "$*" >> "$STUB_LOG"; rm -f "$STUB_LOG.identity"; exit 0; fi',
        'if [ "$1" = ps ]; then printf "docker %s\n" "$*" >> "$STUB_LOG"; case "$*" in *"name="*) [ "${STUB_REPLACE_CLIENT_NAME:-}" != 1 ] || echo replacement-id ;; esac; exit 0; fi',
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
        '  if [ "${3:-}" = --format ]; then echo \'["/usr/local/lib/lares/maintenance-admission-v1"]\'; exit 0; fi',
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
  const engineRuns = () => calls().split("\n").filter((l) => l.startsWith("docker create "));

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
      expect(line).toContain("--network host --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges");
      expect(line).toContain("--label com.lares.maintenance.operation=rollback");
      expect(line).toContain("node --import tsx/esm");
      expect(line).not.toContain("--entrypoint");
      expect(line).not.toContain("docker.sock");
      expect(line).toContain(`src=${prefix}/var/lib/lares-maintenance/admission,dst=/run/lares-maintenance/admission,readonly`);
      expect(line).toContain(` ${ENGINE} /run/lares-maintenance/admission `);
    }
    const clientId = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(calls()).toContain(`docker start --attach ${clientId}`);
    expect(calls()).toContain(`docker wait ${clientId}`);
    expect(calls()).toContain(`docker rm ${clientId}`);
    expect(compose()).toMatch(new RegExp(`@sha256:b{64}`));
    expect(compose()).not.toContain(CUR);
  });

  it("hands the database password over as a file in a read-only mount, never as a value", () => {
    imageRun(["--yes"]);
    const secrets = join(prefix, "etc", "lares", "secrets");
    for (const line of engineRuns()) {
      expect(line).toContain(`--env DATABASE_PASSWORD_FILE=${secrets}/database-password`);
      expect(line).toContain(`src=${secrets}/database-password,dst=${secrets}/database-password,readonly`);
      expect(line).toContain("--env PGUSER=lares_app");
      expect(line).not.toContain(`src=${secrets},dst=${secrets}`);
      expect(line).not.toContain("PGPASSWORD");
    }
  });

  it("requires an explicit Compose directory for an explicit non-root prefix before effects", () => {
    const r = imageRun(["--dry-run"], { UNSET_DB_COMPOSE_DIR: "1" });
    expect(r.code).toBe(78);
    expect(calls()).toBe("");
  });

  it("applies no migration and calls no pnpm, in either direction", () => {
    imageRun(["--yes"]);
    expect(calls()).not.toMatch(/migrate/);
    expect(calls()).not.toMatch(/^pnpm/m);
  });

  it("cleans the pinned original by ID while leaving a replacement name untouched", () => {
    const r = imageRun(["--dry-run"], { STUB_REPLACE_CLIENT_NAME: "1" });
    expect(r.code).toBe(78);
    expect(calls()).toMatch(/docker rm 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/);
    expect(calls()).not.toMatch(/docker (?:stop|rm) replacement-id/);
  });

  it("rejects a short client ID and cleans only the verified full-ID owner", () => {
    const r = imageRun(["--dry-run"], { STUB_SHORT_CLIENT_ID: "1" });
    expect(r.code).toBe(78);
    expect(calls()).not.toMatch(/docker start --attach/);
    expect(calls()).toMatch(/docker rm 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/);
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
