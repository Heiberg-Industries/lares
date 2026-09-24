// restore-drill.sh is the monthly REHEARSED restore (LAR-54-s3, ORB-187 design doc
// "Restore, rehearsed"): restore the newest nightly snapshot's dumps and a couple of
// directories into a scratch location, load each dump into a throwaway database,
// compare its table count against the live database, and record the verdict in the
// 'drill' row of backup_status (sql/049_backup_status.sql, upserted the same
// stdin-SQL way backup-verify.sh's record_status does for 'verify').
//
// This script CREATEs and DROPs databases on the box that runs production Postgres,
// so the tests below drive it end-to-end with fake `restic`, `docker` and `df` on
// PATH (Python, matching the style of tests/backup-lares.test.ts) and assert the
// safety properties as directly as the mechanism, not just the observable pass/fail:
//   - the scratch directory (from `mktemp -d`, isolated here via DRILL_SCRATCH_ROOT
//     rather than the real /var/tmp) is gone after the run, pass or fail;
//   - every database the docker stub sees in a CREATE DATABASE / DROP DATABASE call
//     starts with drill_ — never anything else, and every created one is dropped;
//   - a failing record-status call never changes the drill's own exit code;
//   - too little free space on the scratch root (per a stubbed `df -Pk`) fails
//     before anything is restored or created, regardless of this dev machine's own
//     real disk.
//
// No real restic, docker, Postgres or network is ever touched.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "restore-drill.sh");

let dir: string;
let binDir: string;
let envFile: string;
let archiveRoot: string;
let scratchParent: string;
let snapJsonFile: string;
let tableCountsFile: string;
let createLog: string;
let dropLog: string;
let pgRestoreLog: string;
let dockerArgsLog: string;
let dockerStdinLog: string;
let resticArgsLog: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "restore-drill-"));
  binDir = join(dir, "bin");
  mkdirSync(binDir);
  envFile = join(dir, "backup.env");
  archiveRoot = join(dir, "archive");
  mkdirSync(archiveRoot);
  // A test-controlled stand-in for DRILL_SCRATCH_ROOT (the real default is
  // /var/tmp), so "the scratch dir is gone after the run" can be checked by listing
  // this directory's children instead of guessing the mktemp-generated name in
  // advance.
  scratchParent = join(dir, "scratch-parent");
  mkdirSync(scratchParent);
  snapJsonFile = join(dir, "snapshot.json");
  tableCountsFile = join(dir, "table-counts.json");
  createLog = join(dir, "create.log");
  dropLog = join(dir, "drop.log");
  pgRestoreLog = join(dir, "pg-restore.log");
  dockerArgsLog = join(dir, "docker-args.log");
  dockerStdinLog = join(dir, "docker-stdin.log");
  resticArgsLog = join(dir, "restic-args.log");

  writeFileSync(
    snapJsonFile,
    JSON.stringify([
      { time: new Date().toISOString(), id: "deadbeef", short_id: "deadbeef", tags: ["nightly"], paths: ["/var/backups/pg"] },
    ]) + "\n",
  );

  // Stub restic: `snapshots` prints the staged snapshot; `restore` copies whatever the
  // test staged under ARCHIVE_ROOT for each --include path into --target, the way the
  // real restic restore is documented to recreate each included path under the target
  // (an assumption only a live run against the real box can confirm — see the
  // script's own "ASSUMPTION" comments).
  const restic = join(binDir, "restic");
  writeFileSync(
    restic,
    `#!/usr/bin/env python3
import sys, os, shutil
argv = sys.argv[1:]
# LAR-54-s6: log every call's argv (one call per "---"-separated block) so tests can
# assert what restic was actually invoked with -- in particular, whether
# RESTIC_REPOSITORY produced "-r <value>" with no rclone option at all.
args_log = os.environ.get('RESTIC_ARGS_LOG')
if args_log:
    with open(args_log, 'a') as f:
        f.write('\\n'.join(argv) + '\\n---\\n')
if os.environ.get('STUB_RESTIC_FAIL'):
    sys.stderr.write('stub restic: repository unreachable\\n')
    sys.exit(1)
if 'snapshots' in argv:
    sys.stdout.write(open(os.environ['SNAP_JSON_FILE']).read())
    sys.exit(0)
if 'restore' in argv:
    target = argv[argv.index('--target') + 1]
    includes = [argv[i + 1] for i, a in enumerate(argv) if a == '--include']
    archive_root = os.environ.get('ARCHIVE_ROOT', '')
    for inc in includes:
        src = archive_root.rstrip('/') + inc
        if os.path.isdir(src):
            dst = target.rstrip('/') + inc
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if os.path.exists(dst):
                shutil.rmtree(dst)
            shutil.copytree(src, dst)
    sys.exit(0)
sys.exit(0)
`,
  );
  chmodSync(restic, 0o755);

  // Stub docker: dispatches on shape, the same way the real CLI would answer
  // different subcommands, and logs enough for the tests to assert what the script
  // sent without a real database:
  //   - `pg_restore` (the dump on stdin) -> logs target db + byte count.
  //   - `psql ... -d lares_state` (record_status) -> logs args + stdin.
  //   - `psql ... -c "CREATE|DROP DATABASE ..."` -> logs the exact database name.
  //   - `psql ... -tAc ...` (table_count) -> answers from the staged counts file,
  //     keyed by the ORIGINAL db name for a live query and by the same name recovered
  //     from a drill_<db>_<epoch> name for a scratch-database query.
  const docker = join(binDir, "docker");
  writeFileSync(
    docker,
    `#!/usr/bin/env python3
import sys, os, re, json
argv = sys.argv[1:]

def arg_after(flag):
    if flag in argv:
        i = argv.index(flag)
        if i + 1 < len(argv):
            return argv[i + 1]
    return None

if 'pg_restore' in argv:
    data = sys.stdin.buffer.read()
    log = os.environ.get('PG_RESTORE_LOG')
    if log:
        with open(log, 'a') as f:
            f.write('%s %d\\n' % (arg_after('-d'), len(data)))
    if os.environ.get('STUB_PG_RESTORE_FAIL'):
        sys.exit(1)
    sys.exit(0)

dbname = arg_after('-d')

if dbname == 'lares_state':
    stdin_data = sys.stdin.read()
    args_log = os.environ.get('DOCKER_ARGS_LOG')
    stdin_log = os.environ.get('DOCKER_STDIN_LOG')
    if args_log:
        with open(args_log, 'a') as f:
            f.write(' '.join(argv) + '\\n---\\n')
    if stdin_log:
        with open(stdin_log, 'w') as f:
            f.write(stdin_data)
    if os.environ.get('STUB_RECORD_STATUS_FAIL'):
        sys.exit(1)
    sys.exit(0)

if '-c' in argv:
    sql = arg_after('-c') or ''
    if 'CREATE DATABASE' in sql:
        m = re.search(r'CREATE DATABASE "([^"]+)"', sql)
        log = os.environ.get('CREATE_LOG')
        if log and m:
            with open(log, 'a') as f:
                f.write(m.group(1) + '\\n')
        sys.exit(0)
    if 'DROP DATABASE' in sql:
        m = re.search(r'DROP DATABASE IF EXISTS "([^"]+)"', sql)
        log = os.environ.get('DROP_LOG')
        if log and m:
            with open(log, 'a') as f:
                f.write(m.group(1) + '\\n')
        sys.exit(0)
    sys.exit(0)

if '-tAc' in argv:
    counts = {}
    counts_file = os.environ.get('TABLE_COUNTS_FILE')
    if counts_file and os.path.exists(counts_file):
        counts = json.load(open(counts_file))
    m = re.match(r'^drill_(.+)_([0-9]+)$', dbname or '')
    if m:
        value = counts.get(m.group(1), {}).get('drill', 0)
    else:
        value = counts.get(dbname or '', {}).get('live', 0)
    print(value)
    sys.exit(0)

sys.exit(0)
`,
  );
  chmodSync(docker, 0o755);

  // Stub df: the script's free-space check reads `df -Pk <root>` and takes column 4
  // (Available, in 1024-byte blocks) of the second line — the same fixed shape on
  // Linux and macOS. Answers from STUB_DF_AVAIL_KB, defaulting to plenty, so tests
  // never depend on how much space this dev machine's own disk actually has free.
  const df = join(binDir, "df");
  writeFileSync(
    df,
    `#!/usr/bin/env bash
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "stubfs 999999999 1 \${STUB_DF_AVAIL_KB:-20000000} 1% /"
`,
  );
  chmodSync(df, 0o755);

  writeFileSync(
    envFile,
    [
      "STORAGEBOX_HOST=example.invalid",
      "STORAGEBOX_USER=u000000",
      "STORAGEBOX_PORT=23",
      "STORAGEBOX_SSH_KEY=/dev/null",
      "RESTIC_REPO_PATH=box-backup",
      "RESTIC_PASSWORD_FILE=/dev/null",
      "",
    ].join("\n"),
  );

  // Default fixture: a normal-looking archive (globals.sql + one dump, both restore
  // directories present and non-empty) and matching live/drill table counts, so most
  // tests only need to override the one thing they are exercising.
  stageArchive({ dumps: { app: "x".repeat(2048) } });
  stageCounts({ app: { live: 12, drill: 12 } });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Populate ARCHIVE_ROOT the way a restored snapshot would look on disk. */
function stageArchive(opts: { dumps: Record<string, string>; withSrvLares?: boolean; withAgentBox?: boolean }) {
  rmSync(archiveRoot, { recursive: true, force: true });
  mkdirSync(archiveRoot, { recursive: true });
  const pg = join(archiveRoot, "var/backups/pg");
  mkdirSync(pg, { recursive: true });
  writeFileSync(join(pg, "globals.sql"), "-- fixture roles\n");
  for (const [db, contents] of Object.entries(opts.dumps)) {
    writeFileSync(join(pg, `${db}.dump`), contents);
  }
  if (opts.withSrvLares !== false) {
    mkdirSync(join(archiveRoot, "srv/lares/agents/example"), { recursive: true });
    writeFileSync(join(archiveRoot, "srv/lares/agents/example/agent.json"), '{"name":"example"}');
  }
  if (opts.withAgentBox !== false) {
    mkdirSync(join(archiveRoot, "opt/agent-box"), { recursive: true });
    writeFileSync(join(archiveRoot, "opt/agent-box/compose.yaml"), "services: {}\n");
  }
}

function stageCounts(counts: Record<string, { live: number; drill: number }>) {
  writeFileSync(tableCountsFile, JSON.stringify(counts));
}

function run(env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync("bash", [SCRIPT], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        AGENT_BOX_BACKUP_ENV: envFile,
        DRILL_SCRATCH_ROOT: scratchParent,
        ARCHIVE_ROOT: archiveRoot,
        SNAP_JSON_FILE: snapJsonFile,
        TABLE_COUNTS_FILE: tableCountsFile,
        CREATE_LOG: createLog,
        DROP_LOG: dropLog,
        PG_RESTORE_LOG: pgRestoreLog,
        DOCKER_ARGS_LOG: dockerArgsLog,
        DOCKER_STDIN_LOG: dockerStdinLog,
        RESTIC_ARGS_LOG: resticArgsLog,
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

const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
const recordedArgs = () => (existsSync(dockerArgsLog) ? readFileSync(dockerArgsLog, "utf8") : "");
const recordedStdin = () => (existsSync(dockerStdinLog) ? readFileSync(dockerStdinLog, "utf8") : "");
/** Every restic call's argv, one "---"-separated block per call. */
const resticArgs = () => (existsSync(resticArgsLog) ? readFileSync(resticArgsLog, "utf8") : "");
/** Every entry left directly under the fake scratch root after the run — should be none. */
const scratchLeftovers = () => readdirSync(scratchParent);

describe("restore-drill.sh", () => {
  it("a pass restores, loads every dump, and records ok=true with last_pass_at", () => {
    const r = run();
    expect(r.out).toContain("OK");
    expect(r.code).toBe(0);

    expect(recordedArgs()).toContain("ok=true");
    expect(recordedStdin()).toContain("last_pass_at");

    // The one dump staged was actually loaded through pg_restore.
    expect(lines(pgRestoreLog).length).toBe(1);

    // Every CREATE DATABASE / DROP DATABASE the docker stub saw targeted a drill_
    // name, and the one created was also dropped again (scratch databases gone).
    const created = lines(createLog);
    const dropped = lines(dropLog);
    expect(created.length).toBe(1);
    expect(dropped).toEqual(created);
    for (const name of [...created, ...dropped]) {
      expect(name).toMatch(/^drill_[a-z0-9_]+$/);
    }

    // The scratch directory (mktemp -d under DRILL_SCRATCH_ROOT) is gone too.
    expect(scratchLeftovers()).toEqual([]);
  });

  it("too little free space on the scratch root fails before anything is restored or created", () => {
    // 1MB free, well under the default 5120MB floor. This must be caught before
    // mktemp even runs — nothing is restored and no database is ever created.
    const r = run({ STUB_DF_AVAIL_KB: "1024" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/free/i);
    expect(recordedArgs()).toContain("ok=false");

    expect(lines(createLog)).toEqual([]);
    expect(lines(pgRestoreLog)).toEqual([]);
    // No scratch directory was ever created under the (still-empty) scratch root.
    expect(scratchLeftovers()).toEqual([]);
  });

  it("an empty restore fails and records why", () => {
    // No archive content at all: restic's stub finds nothing under ARCHIVE_ROOT for
    // any --include path, so the restore "succeeds" and produces nothing — the
    // drill's own version of a green run that archived no dump.
    rmSync(archiveRoot, { recursive: true, force: true });
    mkdirSync(archiveRoot);

    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("globals.sql");
    expect(recordedArgs()).toContain("ok=false");
    expect(recordedStdin() + recordedArgs()).toMatch(/globals\.sql/);

    // No database was ever created for an empty restore, and the scratch dir is
    // still cleaned up.
    expect(lines(createLog)).toEqual([]);
    expect(scratchLeftovers()).toEqual([]);
  });

  it("a dump whose restored table count is below tolerance fails", () => {
    // Live has 12 tables; the restored copy claims only 5 (~42%), well under the
    // default 90% tolerance.
    stageCounts({ app: { live: 12, drill: 5 } });

    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/tolerance/);
    expect(r.out).toContain("app");
    expect(recordedArgs()).toContain("ok=false");

    // The database WAS created and restored into (that is how its table count was
    // even readable), and it is still dropped on the way out.
    const created = lines(createLog);
    expect(created.length).toBe(1);
    expect(lines(dropLog)).toEqual(created);
    expect(scratchLeftovers()).toEqual([]);
  });

  it("a failing record-status call leaves the drill's own exit code unchanged", () => {
    const r = run({ STUB_RECORD_STATUS_FAIL: "1" });
    expect(r.out).toContain("OK");
    expect(r.code).toBe(0);
    // The call was attempted (and the stub deliberately failed it) before the script
    // carried on as if nothing had happened — same rule as backup-verify.sh's
    // record_status.
    expect(recordedArgs()).toContain("ok=true");

    // Cleanup is unaffected by the recording failure: the scratch database created
    // for the drill is still dropped and the scratch directory still removed.
    expect(lines(dropLog)).toEqual(lines(createLog));
    expect(scratchLeftovers()).toEqual([]);
  });

  // LAR-54-s6: the backup target can be any restic repository, not only the Hetzner
  // Storage Box over rclone.
  it("keeps the rclone form and its target when RESTIC_REPOSITORY is not set", () => {
    const r = run();
    expect(r.code).toBe(0);
    const firstCall = resticArgs().split("---\n")[0];
    expect(firstCall).toContain("-o\n");
    expect(firstCall).toMatch(/rclone\.program=/);
    expect(firstCall).toContain("-r\nrclone:box-backup");
    expect(recordedArgs()).toContain("target=rclone:example.invalid:box-backup");
  });

  it("uses RESTIC_REPOSITORY directly, with no rclone option, and records a credential-stripped target", () => {
    const r = run({ RESTIC_REPOSITORY: "sftp:drilluser:drillpw@example.invalid:/path" });
    expect(r.code).toBe(0);
    const firstCall = resticArgs().split("---\n")[0];
    expect(firstCall).toContain("-r\nsftp:drilluser:drillpw@example.invalid:/path");
    expect(firstCall).not.toContain("-o");
    expect(firstCall).not.toMatch(/rclone\.program/);
    // The credential-bearing value is what reaches restic; only the STRIPPED form may
    // reach the database.
    expect(recordedArgs()).toContain("target=sftp:example.invalid:/path");
    expect(recordedArgs()).not.toContain("drillpw");
    expect(recordedArgs()).not.toContain("drilluser");
  });
});
