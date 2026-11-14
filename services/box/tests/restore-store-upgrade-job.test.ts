// The one restore job that gives an upgraded agent store its permissions (engine-run.sh,
// engine_restore_keeper_client workflow-apply-database). restore.sh uses it only for a store it
// has just restored from an older release's backup and upgraded. These tests hold it to the same
// fixed form as the other restore jobs: no caller-chosen program, mode, host or credential, and
// only a store named in this restore run's own private record.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const OPS = join(dirname(fileURLToPath(import.meta.url)), "..", "ops");
const STORE = `lares_${"a".repeat(32)}`;
const OTHER = `lares_${"b".repeat(32)}`;

let dir: string, prefix: string, work: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "restore-store-job-")));
  prefix = join(dir, "root");
  work = join(dir, "run");
  mkdirSync(join(prefix, "etc/lares/secrets"), { recursive: true });
  mkdirSync(work, { mode: 0o700 });
  writeFileSync(join(prefix, "etc/lares/secrets/workflow-provisioner-password"), "not-a-real-provisioner-password\n", { mode: 0o600 });
  writeFileSync(join(prefix, "etc/lares/secrets/workflow-database-password"), "not-a-real-workflow-password\n", { mode: 0o600 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const listStores = (...names: string[]) => writeFileSync(join(work, "workflow-upgrade-stores"), names.map((name) => `${name}\n`).join(""), { mode: 0o600 });

/** Calls the job with the real engine-run.sh; the container step itself is replaced by a printer. */
function job(args: string[], env: Record<string, string> = {}, realRun = false) {
  const script = `
HERE=${JSON.stringify(OPS)}
. "$HERE/engine-run.sh"
P() { printf '%s%s' "\${PREFIX%/}" "$1"; }
${realRun ? "" : `_engine_restore_client_run() { printf '%s\\n' "$@"; }`}
engine_restore_keeper_client "$@"`;
  const result = spawnSync("/bin/bash", ["-c", script, "job", ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH, PREFIX: prefix, RESTORE_WORK: work,
      WORKFLOW_PASSWORD_FILE: join(prefix, "etc/lares/secrets/workflow-database-password"), ...env,
    },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe("the restore job that applies an upgraded store's permissions", () => {
  it("runs only the fixed apply-database program, on this host, with the two fixed credential files read-only", () => {
    listStores(STORE);
    const r = job(["workflow-apply-database", STORE, "5432"]);
    expect(r.code, r.err).toBe(0);
    const passed = r.out.trim().split("\n");
    expect(passed.slice(0, 4)).toEqual(["keeper", "workflow-apply-database", "", "0:0"]);
    expect(passed.slice(passed.indexOf("--"))).toEqual(["--", "node", "--import", "tsx/esm", "/app/services/box/bin/workflow-template.ts", "apply-database",
      "--host", "127.0.0.1", "--port", "5432", "--database", STORE,
      "--provisioner-password-file", "/etc/lares/secrets/workflow-provisioner-password",
      "--runtime-password-file", "/etc/lares/secrets/workflow-database-password"]);
    const mounts = passed.filter((_, at) => passed[at - 1] === "--mount");
    expect(mounts).toEqual([
      `type=bind,src=${join(prefix, "etc/lares/secrets/workflow-provisioner-password")},dst=/etc/lares/secrets/workflow-provisioner-password,readonly`,
      `type=bind,src=${join(prefix, "etc/lares/secrets/workflow-database-password")},dst=/etc/lares/secrets/workflow-database-password,readonly`,
    ]);
    expect(r.out).not.toContain("not-a-real");
  });

  it("refuses a store this restore run did not record, and refuses when there is no record at all", () => {
    expect(job(["workflow-apply-database", STORE, "5432"]).code).toBe(78);
    listStores(OTHER);
    const r = job(["workflow-apply-database", STORE, "5432"]);
    expect(r.code).toBe(78);
    expect(r.err).toContain("this agent store was not restored for upgrade by this restore run");
    expect(r.out).toBe("");
  });

  it("refuses a record that is not this run's private file", () => {
    listStores(STORE);
    chmodSync(join(work, "workflow-upgrade-stores"), 0o644);
    expect(job(["workflow-apply-database", STORE, "5432"]).code).toBe(78);
    rmSync(join(work, "workflow-upgrade-stores"));
    writeFileSync(join(dir, "elsewhere"), `${STORE}\n`, { mode: 0o600 });
    symlinkSync(join(dir, "elsewhere"), join(work, "workflow-upgrade-stores"));
    expect(job(["workflow-apply-database", STORE, "5432"]).code).toBe(78);
    rmSync(join(work, "workflow-upgrade-stores"));
    listStores(STORE);
    expect(job(["workflow-apply-database", STORE, "5432"], { RESTORE_WORK: join(dir, "missing") }).code).toBe(78);
  });

  it("refuses any other database name, port, argument count or runtime credential place", () => {
    listStores(STORE, "lares_state", "empty_workflow");
    for (const args of [["lares_state", "5432"], ["empty_workflow", "5432"], [STORE, "0"], [STORE, "70000"], [STORE, "5432", "extra"], [STORE]]) {
      const r = job(["workflow-apply-database", ...args]);
      expect(r.code, args.join(" ")).toBe(78);
      expect(r.out).toBe("");
    }
    writeFileSync(join(dir, "outside-password"), "x\n", { mode: 0o600 });
    expect(job(["workflow-apply-database", STORE, "5432"], { WORKFLOW_PASSWORD_FILE: join(dir, "outside-password") }).code).toBe(78);
    expect(job(["workflow-apply-database", STORE, "5432"], { WORKFLOW_PASSWORD_FILE: join(prefix, "etc/lares/secrets/workflow-provisioner-password") }).code).toBe(78);
    rmSync(join(prefix, "etc/lares/secrets/workflow-provisioner-password"));
    expect(job(["workflow-apply-database", STORE, "5432"]).code).toBe(78);
  });

  it("the guarded container step accepts only the exact argument form", () => {
    const run = (argv: string[]) => {
      const script = `HERE=${JSON.stringify(OPS)}; . "$HERE/engine-run.sh"; _engine_restore_client_run keeper workflow-apply-database registry.example/keeper@sha256:${"d".repeat(64)} 0:0 -- "$@"`;
      return spawnSync("/bin/bash", ["-c", script, "run", ...argv], { encoding: "utf8", env: { PATH: process.env.PATH } });
    };
    const good = ["node", "--import", "tsx/esm", "/app/services/box/bin/workflow-template.ts", "apply-database", "--host", "127.0.0.1", "--port", "5432",
      "--database", STORE, "--provisioner-password-file", "/etc/lares/secrets/workflow-provisioner-password",
      "--runtime-password-file", "/etc/lares/secrets/workflow-database-password"];
    // The exact form passes the argument check and stops only at the missing restore admission.
    expect(run(good).stderr).toContain("durable restore admission is unavailable");
    const swap = (at: number, value: string) => good.map((item, index) => (index === at ? value : item));
    for (const bad of [swap(4, "apply"), swap(4, "verify-database"), swap(6, "10.0.0.1"), swap(10, "lares_state"), swap(12, "/etc/lares/operator/database-password"),
      swap(14, "/tmp/password"), swap(3, "/app/services/box/bin/database-setup.ts"), [...good, "--extra"]]) {
      const r = run(bad);
      expect(r.status).toBe(78);
      expect(r.stderr).not.toContain("durable restore admission is unavailable");
    }
  });
});
