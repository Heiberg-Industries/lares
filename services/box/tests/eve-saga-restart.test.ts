// LAR-86 — eve-saga-restart.sh must not mistake "the database could not be reached" for "no
// turns were wedged". The script restarts the agent container and then asks Postgres which
// graphile-worker jobs are still locked by the worker that just died; it used to throw psql's
// stderr away and read a failed query as an empty answer, i.e. "nothing to reclaim", exit 0.
//
// These tests run the real script under /bin/bash with a fake `docker`, `curl` and `sleep` on
// PATH, in the stub style of backup-verify.test.ts. Nothing real is touched: no container is
// restarted, no database is queried, and the three-second settle is a no-op.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "eve-saga-restart.sh");

let dir: string;
let binDir: string;
let deadFile: string;
let argsLog: string;

/** Stage what the "which workers hold locks older than the restart" query prints. */
function stageDead(workers: string[]): void {
  writeFileSync(deadFile, workers.map((w) => `'${w}'`).join(",") + "\n");
}

function run(env: Record<string, string> = {}) {
  const r = spawnSync("/bin/bash", [SCRIPT], {
    encoding: "utf8",
    env: { PATH: `${binDir}:${process.env["PATH"] ?? ""}`, HOME: dir, TMPDIR: dir, ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Every docker call's argv, one per line. */
const dockerCalls = () => (existsSync(argsLog) ? readFileSync(argsLog, "utf8") : "");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eve-saga-restart-"));
  binDir = join(dir, "bin");
  mkdirSync(binDir);
  deadFile = join(dir, "dead.txt");
  argsLog = join(dir, "docker-args.log");

  // Stub docker: `restart` succeeds, `inspect` prints a start time, `exec … psql` answers from
  // the staged file — or, with STUB_PSQL_FAIL set, fails the way an unreachable server does.
  const docker = join(binDir, "docker");
  writeFileSync(
    docker,
    `#!/usr/bin/env bash\n` +
      `printf '%s\\n' "$*" >> "${argsLog}"\n` +
      `case "$1" in\n` +
      `  restart) exit 0 ;;\n` +
      `  inspect) echo "2026-10-08T09:00:00.000000000Z" ;;\n` +
      `  exec)\n` +
      `    if [ -n "\${STUB_PSQL_FAIL:-}" ]; then echo 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: Connection refused' >&2; exit 1; fi\n` +
      `    query=""; for a in "$@"; do query="$a"; done\n` +
      `    case "$query" in\n` +
      `      *string_agg*) cat "${deadFile}" ;;\n` +
      `      *force_unlock_workers*) exit 0 ;;\n` +
      `      *"count(*)"*) echo 0 ;;\n` +
      `      *) echo "stub docker: unexpected query: $query" >&2; exit 1 ;;\n` +
      `    esac ;;\n` +
      `  *) echo "stub docker: unexpected call: $*" >&2; exit 1 ;;\n` +
      `esac\n`,
  );
  chmodSync(docker, 0o755);
  // The health poll answers at once; the settle after it costs no time.
  writeFileSync(join(binDir, "curl"), `#!/usr/bin/env bash\nexit 0\n`);
  chmodSync(join(binDir, "curl"), 0o755);
  writeFileSync(join(binDir, "sleep"), `#!/usr/bin/env bash\nexit 0\n`);
  chmodSync(join(binDir, "sleep"), 0o755);
  stageDead([]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("eve-saga-restart.sh", () => {
  it("with no stale locks, reports nothing to reclaim and exits 0", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toContain("no turns were wedged");
    expect(dockerCalls()).not.toContain("force_unlock_workers");
  });

  it("with a dead worker, reclaims its jobs and reports how many locks remain", () => {
    stageDead(["worker-1"]);
    const r = run();
    expect(r.status).toBe(0);
    expect(dockerCalls()).toContain("force_unlock_workers");
    expect(r.out).toContain("stale locks remaining: 0");
  });

  it("when the database cannot be reached, says so with the database and the role, reclaims nothing and exits non-zero", () => {
    const r = run({ STUB_PSQL_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("could not reach database lares_state as role lares");
    expect(r.out).toContain("Connection refused");
    expect(r.out).not.toContain("no turns were wedged");
    expect(dockerCalls()).not.toContain("force_unlock_workers");
  });
});
