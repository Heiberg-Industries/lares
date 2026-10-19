// unpack-engine.sh runs inside the keeper image and copies exactly the engine files the host's
// installer reads, in the repo's own layout, plus a file naming the engine image digest.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, readFileSync, readdirSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(REPO, "services/box/ops/unpack-engine.sh");
const DIGEST = `example.invalid/engine@sha256:${"a".repeat(64)}`;

let out: string;
beforeEach(() => { out = mkdtempSync(join(tmpdir(), "lares-unpack-")); });
afterEach(() => { rmSync(out, { recursive: true, force: true }); });

function run(args: string[], appRoot = REPO) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", APP_ROOT: appRoot, OUT_ROOT: out },
  });
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
}
const files = (root: string) => walk(root).map((p) => relative(root, p)).sort();
const filesIn = (dir: string) => readdirSync(join(REPO, dir), { withFileTypes: true })
  .filter((e) => e.isFile()).map((e) => `${dir}/${e.name}`);

describe("unpack-engine.sh", () => {
  it("copies exactly the host's files, with their modes, and records the digest", () => {
    const r = run(["rel-1", DIGEST]);
    expect(r.status, r.stderr).toBe(0);
    const root = join(out, "rel-1");
    const expected = [
      ...filesIn("services/box/ops"),
      ...filesIn("services/box/sql"),
      "services/box/compose.lares-keeper.yaml",
      "services/box/engine-image",
      "services/creative/sql/001-eve-workflow.sql",
    ].sort();
    expect(files(root)).toEqual(expected);
    expect(files(root)).toContain("services/box/ops/Caddyfile");
    expect(files(root)).toContain("services/box/ops/install.sh");
    expect(files(root)).toContain("services/box/sql/001_baseline.sql");
    expect(readFileSync(join(root, "services/box/engine-image"), "utf8")).toBe(`${DIGEST}\n`);
    for (const f of expected) {
      if (f === "services/box/engine-image") continue;
      expect(statSync(join(root, f)).mode & 0o777, f).toBe(statSync(join(REPO, f)).mode & 0o777);
    }
    expect(statSync(join(root, "services/box/ops/install.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(join(root, "services/box/engine-image")).mode & 0o777).toBe(0o644);
  });

  it("refuses when an expected file is missing, and leaves nothing behind", () => {
    const fake = mkdtempSync(join(tmpdir(), "lares-fakeapp-"));
    try {
      mkdirSync(join(fake, "services/box"), { recursive: true });
      cpSync(join(REPO, "services/box/ops"), join(fake, "services/box/ops"), { recursive: true });
      cpSync(join(REPO, "services/box/sql"), join(fake, "services/box/sql"), { recursive: true });
      cpSync(join(REPO, "services/box/compose.lares-keeper.yaml"), join(fake, "services/box/compose.lares-keeper.yaml"));
      // the creative workflow schema is deliberately absent
      const r = run(["rel-1", DIGEST], fake);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/001-eve-workflow\.sql/);
      expect(readdirSync(out)).toEqual([]);
    } finally { rmSync(fake, { recursive: true, force: true }); }
  });

  it("refuses a bad release name or digest and missing arguments", () => {
    expect(run([]).status).not.toBe(0);
    expect(run(["rel-1"]).status).not.toBe(0);
    expect(run(["../escape", DIGEST]).status).not.toBe(0);
    expect(run([".hidden", DIGEST]).status).not.toBe(0);
    expect(run(["rel-1", "not a digest"]).status).not.toBe(0);
    expect(readdirSync(out)).toEqual([]);
  });

  it("replaces an earlier unpack of the same release instead of mixing files", () => {
    expect(run(["rel-1", DIGEST]).status).toBe(0);
    writeFileSync(join(out, "rel-1", "stale"), "x");
    expect(run(["rel-1", DIGEST]).status).toBe(0);
    expect(existsSync(join(out, "rel-1", "stale"))).toBe(false);
  });
});
