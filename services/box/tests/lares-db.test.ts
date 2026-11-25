// `lares db`, driven with a `docker` stub: the psql the person types into must run in a container with
// no operator secret mounted, the temporary password is set before and cleared after, and one session at a time.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OPS = new URL("../ops/", import.meta.url).pathname;
let dir: string;
let prefix: string;
let log: string;

function stub(name: string, body: string): void {
  const file = join(dir, "bin", name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lares-db-"));
  prefix = join(dir, "prefix");
  log = join(dir, "log");
  writeFileSync(log, "");
  mkdirSync(join(dir, "bin"));
  const ops = join(prefix, "opt/lares/releases/r1/services/box/ops");
  mkdirSync(ops, { recursive: true });
  copyFileSync(join(OPS, "lares"), join(ops, "lares"));
  copyFileSync(join(OPS, "engine-run.sh"), join(ops, "engine-run.sh"));
  writeFileSync(join(prefix, "opt/lares/releases/r1/release.json"), "{}");
  mkdirSync(join(prefix, "opt/lares"), { recursive: true });
  spawnSync("ln", ["-s", "releases/r1", join(prefix, "opt/lares/current")]);
  mkdirSync(join(prefix, "etc/lares/operator"), { recursive: true });
  writeFileSync(join(prefix, "etc/lares/operator/database-password"), "operator-secret\n");
  writeFileSync(join(prefix, "opt/lares/compose.yaml"), "services: {}\n");
  // flock is a Linux program; this stand-in takes the same advisory lock through Python on fd 9.
  stub("flock", `exec python3 -c 'import fcntl,sys; fcntl.flock(9, fcntl.LOCK_EX|fcntl.LOCK_NB)' 2>/dev/null`);
  stub("id", "echo 0");
  stub("stat", "echo 0:600");
  stub("date", 'case "$*" in *-d*) echo "2030-01-01 00:00:00+00";; *) exec /bin/date "$@";; esac');
  // docker: `compose config` names the image; the role lookup answers 1; everything is logged with its stdin.
  stub("docker", `
echo "docker $*" >> "${log}"
case "$1" in
  compose) echo '{"services":{"db":{"image":"db-image"}}}'; exit 0 ;;
  run)
    stdin=$(cat)
    [ -z "$stdin" ] || echo "stdin: $stdin" >> "${log}"
    case "$*" in *"pg_roles"*) echo 1;; esac
    exit 0 ;;
esac
exit 0`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lares = (args: string[]) => spawnSync("/bin/bash", [join(prefix, "opt/lares/current/services/box/ops/lares"), ...args], {
  encoding: "utf8", env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, HOME: dir, LARES_PREFIX: prefix },
});
const runs = () => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("docker run "));

describe("lares db", () => {
  it("runs psql for the person in a container with no operator secret, between setting and clearing the password", () => {
    const r = lares(["db", "-c", "SELECT 1"]);
    expect(r.status, r.stderr).toBe(0);
    const all = runs();
    const diag = all.filter((l) => l.includes("PGUSER=lares_diagnostic"));
    expect(diag).toHaveLength(1);
    expect(diag[0]).not.toContain("database-operator");
    expect(diag[0]).not.toContain("operator");
    expect(diag[0]).not.toMatch(/-v [^ ]*:/);
    expect(diag[0]).toContain("--entrypoint psql");
    expect(diag[0]).toContain("-c SELECT 1");
    // The operator container only ever runs fixed statements around it: look up, set, clear.
    const operators = all.filter((l) => l.includes("PGUSER=lares_operator"));
    expect(operators.length).toBe(3);
    for (const op of operators) expect(op).toContain("database-operator");
    const order = all.map((l) => (l.includes("lares_diagnostic") && l.includes("PGUSER=lares_diagnostic") ? "diag" : "operator"));
    expect(order).toEqual(["operator", "operator", "diag", "operator"]);
    const stdin = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("stdin: "));
    expect(stdin[0]).toMatch(/ALTER ROLE lares_diagnostic PASSWORD '[0-9a-f]{48}' VALID UNTIL '2030-01-01 00:00:00\+00'/);
    // The temporary password never appears in any container's arguments.
    const password = /PASSWORD '([0-9a-f]{48})'/.exec(stdin[0]!)![1]!;
    expect(readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("docker ")).join("\n")).not.toContain(password);
  });

  it("refuses a second session while one holds the lock, and needs no clean-up once it has ended", () => {
    mkdirSync(join(prefix, "run"), { recursive: true });
    const holder = spawn("python3", ["-c", `import fcntl,time,sys
f=open(sys.argv[1],'w'); fcntl.flock(f, fcntl.LOCK_EX); print('held', flush=True); time.sleep(30)`, join(prefix, "run/lares-db.lock")], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const ready = spawnSync("python3", ["-c", "import time; time.sleep(1)"]);
      expect(ready.status).toBe(0);
      const refused = lares(["db", "-c", "SELECT 1"]);
      expect(refused.status).toBe(78);
      expect(refused.stderr).toContain("another lares db session is open");
      expect(runs()).toEqual([]);
    } finally { holder.kill(); }
    spawnSync("python3", ["-c", "import time; time.sleep(0.5)"]);
    expect(lares(["db", "-c", "SELECT 1"]).status).toBe(0);
    expect(runs().length).toBe(4);
  });
});
