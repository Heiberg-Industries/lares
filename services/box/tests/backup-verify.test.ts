// backup-verify.sh is the single liveness owner for the agent box's nightly backup
// (ORB-150). These tests drive it end-to-end with stubbed `restic`, `docker` and
// `curl` on PATH -- no real repository, database or healthchecks.io endpoint is ever
// touched. So the case that matters most here is "HC_URL is empty": on 2026-08-24 the
// deployed backup.env had exactly that, and backup.sh's `if [ -n "$HC_URL" ]` skipped
// the ping without a word for weeks. A verifier that can be silently unarmed is not a
// verifier, so that case must FAIL.
//
// LAR-54-s1: this file used to stub only `restic snapshots` and `curl`, but the script
// also calls `docker compose ... psql` (database coverage) and `restic ls` (dump
// listing). Two more bugs hid behind that gap and made almost every case here pass for
// the wrong reason:
//   - the staged snapshot JSON had no `short_id` field. The script's `SNAP_ID=$(...)`
//     line greps for `"short_id"` and, under `set -euo pipefail`, a grep that matches
//     nothing aborts the whole script right there -- before the age check, the path
//     check or anything else ever runs. Every non-empty `stageSnapshot()` call hit
//     this and crashed silently, which happens to also exit 1 with no ping, so most
//     "fails WITHOUT pinging" assertions passed by accident.
//   - those same assertions expected NO ping at all on failure. That was true before
//     ORB-154; since then `fail()` always pings `${HC_URL}/fail` with the reason (see
//     the script's own "WHY IT PINGS /fail RATHER THAN GOING SILENT" comment), which
//     is the intended, documented behaviour. The one case that reached `fail()`
//     without tripping the `short_id` crash first -- "the repository cannot be read"
//     -- proved it: it failed here with a real `/fail` ping recorded, not silence.
// Both are now fixed in this file (a real `short_id` in the fixture, and assertions
// that expect the `/fail` ping fail() actually sends), not in the script.
//
// LAR-54-s2: the script now records every verdict in Postgres (sql/049_backup_status.sql)
// via a `record_status` helper that upserts through `docker compose ... psql` on STDIN.
// The docker stub below logs the args and stdin of that call so these tests can assert
// what would have been upserted, without a real database (sql/049's own idempotency and
// column shape are proven separately, against a real Postgres, in
// tests/backup-status-sql.test.ts). This slice also fixed a second, smaller defect this
// file's "empty repository" case had already exposed: `SNAP_TIME`/`SNAP_ID` used a bare
// `grep -o` that aborted the script under `set -euo pipefail` on a truly empty
// repository, before the script's own graceful "no nightly snapshot" fail() call could
// run (and therefore before it could ping /fail or record anything). Fixed with the same
// `|| true` idiom the script already used for DUMP_SIZES.
//
// LAR-54-s2 review: the alert must never wait on the bookkeeping. The curl stub and the
// `record_status` branch of the docker stub both append one line to a shared sequence
// log ("ping" / "record"), so tests can assert the ping always lands first — including
// when `record_status` is bounded by the `timeout` stub added below (the server has a
// real `timeout`; this proves the bounded path, not just the unbounded fallback).
//
// LAR-54-s4: the script now also reads the 'drill' row (sql/049) after step 4, so a
// stale or failed restore drill fails the same alarm a stale nightly snapshot does.
// That read shares the docker stub's `lares_state` branch with `record_status`'s write
// (both connect to that database), so the stub distinguishes them by the presence of
// `-tAc` (the read passes its query as a plain argument; `record_status` sends SQL on
// stdin and never uses `-tAc`). `stageDrillRow()` defaults to a healthy row in
// `beforeEach` so every case above this comment keeps passing unchanged.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "backup-verify.sh");

let dir: string;
let binDir: string;
let envFile: string;
let pingLog: string;
let resticOut: string;
let dumpLsFile: string;
let dbNamesFile: string;
let srvRoot: string;
let srvSubdir: string;
let dockerArgsLog: string;
let dockerStdinLog: string;
let sequenceLog: string;
let drillRowFile: string;
let resticArgsLog: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "backup-verify-"));
  binDir = join(dir, "bin");
  mkdirSync(binDir);
  envFile = join(dir, "backup.env");
  pingLog = join(dir, "ping.log");
  resticOut = join(dir, "restic-out.json");
  dumpLsFile = join(dir, "restic-ls.json");
  dbNamesFile = join(dir, "db-names.txt");
  dockerArgsLog = join(dir, "docker-args.log");
  dockerStdinLog = join(dir, "docker-stdin.log");
  sequenceLog = join(dir, "sequence.log");
  drillRowFile = join(dir, "drill-row.txt");
  resticArgsLog = join(dir, "restic-args.log");

  // A test-controlled stand-in for /srv (via the BACKUP_SRV_ROOT seam), so path
  // coverage does not depend on whatever the real machine running this test happens
  // to have under /srv -- that would make the test's outcome depend on the box.
  srvRoot = join(dir, "srv");
  mkdirSync(srvRoot);
  srvSubdir = join(srvRoot, "brain");
  mkdirSync(srvSubdir);

  // Stub restic: branches on the subcommand, same as the real CLI does for
  // `snapshots` vs `ls`. Fails outright if told to.
  const restic = join(binDir, "restic");
  writeFileSync(
    restic,
    `#!/usr/bin/env bash\n` +
      // LAR-54-s6: log every call's argv (one call per "---"-separated block) so tests
      // can assert what restic was actually invoked with -- in particular, whether
      // RESTIC_REPOSITORY produced "-r <value>" with no rclone option at all.
      `{ printf '%s\\n' "$@"; printf -- '---\\n'; } >> "${resticArgsLog}"\n` +
      `if [ -n "\${STUB_RESTIC_FAIL:-}" ]; then echo "stub restic: repository unreachable" >&2; exit 1; fi\n` +
      `for a in "$@"; do if [ "$a" = "ls" ]; then cat "${dumpLsFile}"; exit 0; fi; done\n` +
      `cat "${resticOut}"\n`,
  );
  chmodSync(restic, 0o755);

  // Stub docker: three distinct callers.
  //  - The database-coverage check runs `docker compose ... psql -d postgres ...` to ask
  //    which databases exist. Answer with whatever the test staged.
  //  - `record_status` (LAR-54-s2) runs `docker compose ... psql -d lares_state ...` with
  //    the upsert SQL on stdin. Log its args (one per line, `---` separated per call) and
  //    its stdin, so tests can assert what would have been upserted without a real
  //    database. Fails outright if told to, to prove a failed record changes nothing else.
  //  - The LAR-54-s4 drill-row read also connects to `-d lares_state`, but passes its
  //    query as a plain `-tAc` argument and never touches stdin — that `-tAc` is what
  //    tells this branch apart from `record_status`'s write, which has no `-tAc` at all.
  const docker = join(binDir, "docker");
  writeFileSync(
    docker,
    `#!/usr/bin/env bash\n` +
      `has_lares_state=0; has_tac=0\n` +
      `for a in "$@"; do\n` +
      `  if [ "$a" = "lares_state" ]; then has_lares_state=1; fi\n` +
      `  if [ "$a" = "-tAc" ]; then has_tac=1; fi\n` +
      `done\n` +
      `if [ "$has_lares_state" = "1" ] && [ "$has_tac" = "1" ]; then\n` +
      `  if [ -n "\${STUB_DRILL_ROW_FAIL:-}" ]; then exit 1; fi\n` +
      `  cat "${drillRowFile}"\n` +
      `  exit 0\n` +
      `fi\n` +
      `if [ "$has_lares_state" = "1" ]; then\n` +
      `  { printf '%s\\n' "$@"; printf -- '---\\n'; } >> "${dockerArgsLog}"\n` +
      `  cat > "${dockerStdinLog}"\n` +
      `  echo "record" >> "${sequenceLog}"\n` +
      `  if [ -n "\${STUB_RECORD_STATUS_FAIL:-}" ]; then exit 1; fi\n` +
      `  exit 0\n` +
      `fi\n` +
      `for a in "$@"; do if [ "$a" = "psql" ]; then cat "${dbNamesFile}"; exit 0; fi; done\n` +
      `exit 0\n`,
  );
  chmodSync(docker, 0o755);

  // Stub timeout: the real `timeout` on the server bounds `record_status`'s docker
  // call; this stub just drops the duration and execs the rest, so tests exercise the
  // bounded branch of record_status (not the "no timeout on this Mac" fallback).
  const timeoutBin = join(binDir, "timeout");
  writeFileSync(timeoutBin, `#!/usr/bin/env bash\nshift\nexec "$@"\n`);
  chmodSync(timeoutBin, 0o755);

  // Stub curl: records that a ping happened (and with what URL/body), plus its place
  // in the shared sequence log used to prove "alert before bookkeeping".
  const curl = join(binDir, "curl");
  writeFileSync(curl, `#!/usr/bin/env bash\necho "$@" >> "${pingLog}"\necho "ping" >> "${sequenceLog}"\n`);
  chmodSync(curl, 0o755);

  writeFileSync(
    envFile,
    [
      "STORAGEBOX_HOST=example.invalid",
      "STORAGEBOX_USER=u000000",
      "STORAGEBOX_PORT=23",
      "STORAGEBOX_SSH_KEY=/dev/null",
      "RESTIC_REPO_PATH=box-backup",
      "RESTIC_PASSWORD_FILE=/dev/null",
      "HC_URL=https://hc-ping.com/test-uuid",
      "",
    ].join("\n"),
  );

  // Default coverage: one database with a plausible dump, plus globals.sql. Enough
  // for the "OK" path; individual tests override to exercise a failure.
  stageDatabases(["app"]);
  stageDumps([
    { name: "globals.sql", size: 5000 },
    { name: "app.dump", size: 32000 },
  ]);
  // LAR-54-s4: a healthy drill row by default, so every case above the drill block
  // keeps passing unchanged. Individual tests override this to exercise the new check.
  stageDrillRow({});
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Stage the JSON a `restic snapshots --json` call would return. */
function stageSnapshot(opts: { ageHours?: number; ageMinutes?: number; paths?: string[]; empty?: boolean }) {
  if (opts.empty) {
    writeFileSync(resticOut, "[]\n");
    return;
  }
  const ageMs = opts.ageMinutes !== undefined ? opts.ageMinutes * 60_000 : (opts.ageHours ?? 1) * 3600_000;
  const when = new Date(Date.now() - ageMs).toISOString();
  const paths = opts.paths ?? ["/opt/agent-box", srvSubdir, "/var/backups/pg"];
  writeFileSync(
    resticOut,
    JSON.stringify([{ time: when, id: "deadbeef", short_id: "deadbeef", tags: ["nightly"], paths }]) + "\n",
  );
}

/** Stage the database names a `docker compose ... psql` call would print, one per line. */
function stageDatabases(names: string[]) {
  writeFileSync(dbNamesFile, names.map((n) => `${n}\n`).join(""));
}

/** Stage the file listing a `restic ls --json <snap> /var/backups/pg` call would print. */
function stageDumps(files: { name: string; size: number }[]) {
  writeFileSync(
    dumpLsFile,
    files.map((f) => JSON.stringify({ name: f.name, type: "file", size: f.size })).join("\n") + "\n",
  );
}

/**
 * Stage the pipe-separated row (`ok|never_passed|age_days`) the LAR-54-s4 drill-row
 * read's `psql -tAc` call would print for `backup_status`'s 'drill' row. Defaults to a
 * healthy, recently-passed row so tests that do not care about the drill still pass.
 */
function stageDrillRow(opts: { ok?: boolean; neverPassed?: boolean; ageDays?: number }) {
  const ok = opts.ok ?? true;
  const neverPassed = opts.neverPassed ?? false;
  const ageDays = opts.ageDays ?? 5;
  writeFileSync(drillRowFile, `${ok ? "t" : "f"}|${neverPassed ? "t" : "f"}|${ageDays}\n`);
}

function run(env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync("bash", [SCRIPT], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        AGENT_BOX_BACKUP_ENV: envFile,
        BACKUP_SRV_ROOT: srvRoot,
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const pinged = () => (existsSync(pingLog) ? readFileSync(pingLog, "utf8") : "");
/** Every restic call's argv, one "---"-separated block per call. */
const resticArgs = () => (existsSync(resticArgsLog) ? readFileSync(resticArgsLog, "utf8") : "");
/** Every `docker ... psql -d lares_state` call's args, from `record_status`, `---`-separated. */
const recordedArgs = () => (existsSync(dockerArgsLog) ? readFileSync(dockerArgsLog, "utf8") : "");
/** The SQL sent on stdin to the most recent `record_status` upsert call. */
const recordedStdin = () => (existsSync(dockerStdinLog) ? readFileSync(dockerStdinLog, "utf8") : "");
/** "ping"/"record" lines in the order curl and the record_status docker call ran. */
const sequence = () => (existsSync(sequenceLog) ? readFileSync(sequenceLog, "utf8").trim().split("\n") : []);

describe("backup-verify.sh", () => {
  it("pings the heartbeat when a recent nightly snapshot is in the repository", () => {
    stageSnapshot({ ageHours: 2 });
    const r = run();
    expect(r.out).toContain("OK");
    expect(r.code).toBe(0);
    expect(pinged()).toContain("https://hc-ping.com/test-uuid");
    expect(pinged()).not.toContain("/fail");
    // LAR-54-s2: a passing run upserts ok=true, with last_pass_at set on the pass.
    expect(recordedArgs()).toContain("ok=true");
    expect(recordedStdin()).toContain("last_pass_at");
    // LAR-54-s2 review: the alert (the success ping) must never wait on the bookkeeping.
    expect(sequence()).toEqual(["ping", "record"]);
  });

  it("fails, and pings /fail with the reason, when the newest snapshot is older than the window", () => {
    // The 22–24 Aug failure shape: the unit ran and exited 1, so nothing new reached
    // the repository. Detection must not wait for a second missed night.
    stageSnapshot({ ageHours: 26 });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/stale|old/i);
    expect(pinged()).toContain("/fail");
    // LAR-54-s2: a stale run upserts ok=false with the failure sentence in detail.
    expect(recordedArgs()).toContain("ok=false");
    expect(recordedArgs()).toContain("stale");
    // LAR-54-s2 review: the /fail ping must never wait on the bookkeeping either.
    expect(sequence()).toEqual(["ping", "record"]);
  });

  it("fails on a snapshot just past the window, not an hour later", () => {
    // Age was computed by integer-dividing seconds by 3600, so anything under 25h read
    // as "24h" and passed a 24h window. Found on the box: BACKUP_MAX_AGE_HOURS=0 against
    // a 20-minute-old snapshot reported OK, which also made the runbook's "break it and
    // watch it fire" recipe silently useless. Compare in minutes.
    stageSnapshot({ ageMinutes: 24 * 60 + 30 });
    const r = run();
    expect(r.code).toBe(1);
    expect(pinged()).toContain("/fail");
  });

  it("a zero-hour window rejects any snapshot — the documented way to test the alert", () => {
    stageSnapshot({ ageMinutes: 20 });
    const r = run({ BACKUP_MAX_AGE_HOURS: "0" });
    expect(r.code).toBe(1);
    expect(pinged()).toContain("/fail");
  });

  it("fails, and pings /fail with the reason, when the repository holds no nightly snapshot at all", () => {
    // LAR-54-s2: this used to crash silently (see the file header) because the staged
    // "[]" has no "time"/"short_id" to grep, and that abort happened before the
    // script's own graceful "no nightly snapshot" fail() call. Fixed with `|| true` on
    // those extraction pipelines, so this now reaches fail() and behaves like any
    // other failure: a message, a /fail ping, and a recorded ok=false.
    stageSnapshot({ empty: true });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("no nightly snapshot");
    expect(pinged()).toContain("/fail");
    expect(recordedArgs()).toContain("ok=false");
  });

  it("fails, and pings /fail with the reason, when the repository cannot be read", () => {
    stageSnapshot({ ageHours: 1 });
    const r = run({ STUB_RESTIC_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(pinged()).toContain("/fail");
  });

  it("fails, and pings /fail with the reason, when a fresh snapshot is missing the database dumps directory", () => {
    // The 2026-07-01→14 incident: 31 green snapshots, none containing a dump.
    stageSnapshot({ ageHours: 1, paths: ["/opt/agent-box", srvSubdir] });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("/var/backups/pg");
    expect(pinged()).toContain("/fail");
  });

  it("fails, and pings /fail with the reason, when Postgres has a database with no dump in the snapshot", () => {
    // The 2026-08-17→24 incident: the dump loop took one database of three.
    stageSnapshot({ ageHours: 1 });
    stageDatabases(["app", "orphan_db"]);
    // dumps unchanged: only globals.sql + app.dump, so orphan_db has none.
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("orphan_db");
    expect(pinged()).toContain("/fail");
  });

  it("fails, and pings /fail with the reason, when a directory under the srv root is not in the snapshot", () => {
    // ORB-151: a store that is renamed or newly created and the path list does not
    // follow. Here the srv root has a directory the staged snapshot never mentions.
    mkdirSync(join(srvRoot, "uncovered"));
    stageSnapshot({ ageHours: 1 }); // paths defaults to [.../opt/agent-box, srvSubdir, /var/backups/pg]
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("uncovered");
    expect(pinged()).toContain("/fail");
  });

  it("REFUSES to run when HC_URL is empty — an unarmed verifier must be loud", () => {
    // This is ORB-150 itself: HC_URL was blank in production and backup.sh skipped
    // the ping silently. Here it is a hard failure, so a misconfigured deploy shows
    // up as a failed systemd unit instead of as nothing at all.
    writeFileSync(envFile, readFileSync(envFile, "utf8").replace(/^HC_URL=.*$/m, "HC_URL="));
    stageSnapshot({ ageHours: 1 });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("HC_URL");
    expect(pinged()).toBe("");
    // LAR-54-s2: recording the verdict is independent of the healthchecks.io ping —
    // this branch still records ok=false even though there is nothing to ping.
    expect(recordedArgs()).toContain("ok=false");
  });

  it("a failing record-status call leaves the exit code and the heartbeat ping unchanged", () => {
    // LAR-54-s2 acceptance: recording is bookkeeping, never the alarm. If the docker
    // call behind record_status fails, the run must still pass exactly as if nothing
    // had gone wrong there.
    stageSnapshot({ ageHours: 2 });
    const r = run({ STUB_RECORD_STATUS_FAIL: "1" });
    expect(r.out).toContain("OK");
    expect(r.code).toBe(0);
    expect(pinged()).toContain("https://hc-ping.com/test-uuid");
    // The call was attempted (and the stub deliberately failed it) before the script
    // carried on as if nothing had happened.
    expect(recordedArgs()).toContain("ok=true");
    // The ping already happened before record_status was even attempted.
    expect(sequence()).toEqual(["ping", "record"]);
  });

  it("fails when the last restore drill has not passed in more than DRILL_MAX_AGE_DAYS days", () => {
    stageSnapshot({ ageHours: 2 });
    stageDrillRow({ ok: true, neverPassed: false, ageDays: 46 });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/drill/i);
    expect(r.out).toContain("46d");
    expect(pinged()).toContain("/fail");
  });

  it("fails when the last restore drill's own verdict was ok=false", () => {
    stageSnapshot({ ageHours: 2 });
    stageDrillRow({ ok: false, neverPassed: false, ageDays: 5 });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/drill/i);
    expect(r.out).toMatch(/failed/i);
    expect(pinged()).toContain("/fail");
  });

  it("passes with a 'never rehearsed, due in Nd' note when a never-rehearsed row is inside the grace period", () => {
    stageSnapshot({ ageHours: 2 });
    stageDrillRow({ ok: true, neverPassed: true, ageDays: 10 });
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK");
    expect(r.out).toContain("never rehearsed, due in 35d");
    expect(pinged()).toContain("https://hc-ping.com/test-uuid");
    expect(pinged()).not.toContain("/fail");
  });

  it("fails when the drill row cannot be read at all, and names sql/049 as the likely cause", () => {
    stageSnapshot({ ageHours: 2 });
    const r = run({ STUB_DRILL_ROW_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/drill/i);
    expect(r.out).toContain("sql/049");
    expect(pinged()).toContain("/fail");
  });

  it("passes with a 'last restore drill Nd ago' note for a recent pass", () => {
    stageSnapshot({ ageHours: 2 });
    stageDrillRow({ ok: true, neverPassed: false, ageDays: 3 });
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK");
    expect(r.out).toContain("last restore drill 3d ago");
    expect(pinged()).toContain("https://hc-ping.com/test-uuid");
    expect(pinged()).not.toContain("/fail");
  });

  // LAR-54-s6: the backup target can be any restic repository, not only the Hetzner
  // Storage Box over rclone.
  it("keeps the rclone form and its target when RESTIC_REPOSITORY is not set", () => {
    stageSnapshot({ ageHours: 2 });
    const r = run();
    expect(r.code).toBe(0);
    const firstCall = resticArgs().split("---\n")[0];
    expect(firstCall).toContain("-o\n");
    expect(firstCall).toMatch(/rclone\.program=/);
    expect(firstCall).toContain("-r\nrclone:box-backup\n");
    expect(recordedArgs()).toContain("target=rclone:example.invalid:box-backup");
  });

  it("uses RESTIC_REPOSITORY directly, with no rclone option, and records a credential-stripped target", () => {
    stageSnapshot({ ageHours: 2 });
    const r = run({ RESTIC_REPOSITORY: "s3:https://key:secret@example.invalid/bucket" });
    expect(r.code).toBe(0);
    const firstCall = resticArgs().split("---\n")[0];
    expect(firstCall).toContain("-r\ns3:https://key:secret@example.invalid/bucket\n");
    expect(firstCall).not.toContain("-o");
    expect(firstCall).not.toMatch(/rclone\.program/);
    // The credential-bearing value is what reaches restic; only the STRIPPED form may
    // reach the database.
    expect(recordedArgs()).toContain("target=s3:https://example.invalid/bucket");
    expect(recordedArgs()).not.toContain("secret");
    expect(recordedArgs()).not.toContain("key:secret");
  });
});
