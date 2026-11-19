// release-record.test.ts — the release file and the notes written from a publishing run, run the
// way the workflow runs them (plain `node`, as their own processes) on a small throwaway tree.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { UNWRITTEN_MARKER, countFindings, shortName } from "../lib/release-record.js";
import { parseReleaseManifest } from "../lib/release-manifest.js";
import { PUBLISHED_IMAGES } from "../lib/release-plan.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RECORD = join(REPO, "services", "box", "bin", "write-release-record.ts");
const PLAN = join(REPO, "services", "box", "bin", "plan-release.ts");
const digest = (c: string): string => `sha256:${c.repeat(64)}`;

const scratch = mkdtempSync(join(tmpdir(), "release-record-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const fresh = (): string => { const dir = join(scratch, `case-${(counter += 1)}`); mkdirSync(dir, { recursive: true }); return dir; };

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" }).trim();
}

/** A throwaway repository with two commits, the migrations the writer reads, and a previous release file. */
function tree(): { root: string; old: string; head: string; previous: string } {
  const root = fresh();
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, "services/box/sql"), { recursive: true });
  mkdirSync(join(root, "services/chief-of-staff/sql"), { recursive: true });
  mkdirSync(join(root, "releases"), { recursive: true });
  mkdirSync(join(root, "docs/releases"), { recursive: true });
  writeFileSync(join(root, "services/box/sql/001_baseline.sql"), "-- a\n");
  writeFileSync(join(root, "services/box/sql/002_next.sql"), "-- b\n");
  writeFileSync(join(root, "services/chief-of-staff/sql/001-x.sql"), "-- c\n");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "first change");
  const old = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "a.txt"), "two\n");
  git(root, "commit", "-q", "-am", "Email drafts now wait for Approve (#408)");
  const head = git(root, "rev-parse", "HEAD");
  const images: Record<string, string> = { db: `docker.io/example/db@${digest("1")}`, "lares-gateway": `ghcr.io/example/gw@${digest("2")}`, caddy: `docker.io/example/caddy@${digest("3")}` };
  const sources: Record<string, string> = {};
  for (const { key } of PUBLISHED_IMAGES) { images[key] = `ghcr.io/heiberg-industries/${key}@${digest("4")}`; sources[key] = old; }
  const previous = join(root, "releases", "2026-11-19-rc.15.test.6.json");
  writeFileSync(previous, JSON.stringify({ release: "2026-11-19-rc.15.test.6", images, sources, migrations: { box: "001_baseline.sql", chiefOfStaff: "001-x.sql" }, breaking: [] }));
  return { root, old, head, previous };
}

const planFor = (head: string, builds: string[]): string => {
  const file = join(fresh(), "plan.json");
  writeFileSync(file, JSON.stringify({ previous: "2026-11-19-rc.15.test.6", head, rows: PUBLISHED_IMAGES.map((image) => ({ key: image.key, id: image.id, action: builds.includes(image.key) ? "build" : "carry", base: null, reason: builds.includes(image.key) ? "its inputs changed" : "no changed file is an input of this image" })) }));
  return file;
};

function digestsDir(head: string, keys: string[], commit = head): string {
  const dir = fresh();
  for (const key of keys) writeFileSync(join(dir, `${key}.json`), JSON.stringify({ key, reference: `ghcr.io/heiberg-industries/${key}@${digest("9")}`, sourceCommit: commit }));
  return dir;
}

function run(args: string[]): { status: number | null; out: string; err: string } {
  const result = spawnSync(process.execPath, [RECORD, ...args], { encoding: "utf8" });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe("names and scans", () => {
  it("shortens a release name and refuses a malformed one", () => {
    expect(shortName("2026-11-20-rc.15.test.7")).toBe("rc.15.test.7");
    expect(shortName("2026-11-20-rc.16")).toBe("rc.16");
    expect(() => shortName("rc.15.test.7")).toThrow(/not a release name/);
    expect(() => shortName("2026-11-20-rc.15.test.7/../x")).toThrow();
  });

  it("counts critical and high findings in a Trivy report", () => {
    const report = JSON.stringify({ Results: [{ Vulnerabilities: [{ Severity: "HIGH" }, { Severity: "CRITICAL" }, { Severity: "LOW" }] }, { Vulnerabilities: null }, {}] });
    expect(countFindings(report)).toEqual({ critical: 1, high: 1 });
  });
});

describe("writing the record", () => {
  const args = (t: ReturnType<typeof tree>, plan: string, digests: string, extra: string[] = []): string[] => [
    "--release", "2026-11-20-rc.15.test.7", "--head", t.head, "--previous", t.previous, "--plan", plan, "--digests", digests, "--root", t.root, "--run-url", "https://example.invalid/run/1", ...extra,
  ];

  it("writes a release file the installer accepts, with honest sources, and notes with the human part marked", () => {
    const t = tree();
    const result = run(args(t, planFor(t.head, ["console", "lares-keeper"]), digestsDir(t.head, ["console", "lares-keeper"])));
    expect(result.status, result.err).toBe(0);
    const file = readFileSync(join(t.root, "releases/2026-11-20-rc.15.test.7.json"), "utf8");
    const manifest = parseReleaseManifest(file);
    expect(manifest.images.console).toBe(`ghcr.io/heiberg-industries/console@${digest("9")}`);
    expect(manifest.images.creative).toBe(`ghcr.io/heiberg-industries/creative@${digest("4")}`);
    expect(manifest.images.db).toBe(`docker.io/example/db@${digest("1")}`);
    expect(manifest.sources!.console).toBe(t.head);
    expect(manifest.sources!.creative).toBe(t.old);
    expect(manifest.sources!.db).toBeUndefined();
    expect(manifest.migrations).toEqual({ box: "002_next.sql", chiefOfStaff: "001-x.sql" });
    expect(manifest.breaking.join(" ")).toContain(UNWRITTEN_MARKER);
    const notes = readFileSync(join(t.root, "docs/releases/rc.15.test.7-notes.md"), "utf8");
    expect(notes).toContain(UNWRITTEN_MARKER);
    expect(notes).toContain(`| console | built in this run | \`${t.head}\` |`);
    expect(notes).toContain(`| creative runtime | carried over | \`${t.old}\` |`);
    expect(notes).toContain("- Email drafts now wait for Approve (#408)");
    expect(notes).toContain("https://example.invalid/run/1");
    expect(notes).toContain("| console | not reported by this run | not reported by this run |");
  });

  it("changes nothing and says so in a dry run, even with no digests", () => {
    const t = tree();
    const result = run(args(t, planFor(t.head, ["console"]), join(fresh(), "none"), ["--dry-run"]));
    expect(result.status, result.err).toBe(0);
    expect(result.out).toMatch(/nothing was written/);
    expect(readdirSync(join(t.root, "releases"))).toEqual(["2026-11-19-rc.15.test.6.json"]);
    expect(existsSync(join(t.root, "docs/releases/rc.15.test.7-notes.md"))).toBe(false);
  });

  it("refuses, writing nothing, when a built image has no digest, or one from another commit, or a record exists", () => {
    const t = tree();
    const plan = planFor(t.head, ["console", "lares-keeper"]);
    const missing = run(args(t, plan, digestsDir(t.head, ["console"])));
    expect(missing.status).toBe(1);
    expect(missing.err).toMatch(/lares-keeper.*no digest/);
    const wrong = run(args(t, plan, digestsDir(t.head, ["console", "lares-keeper"], t.old)));
    expect(wrong.status).toBe(1);
    expect(wrong.err).toMatch(/not from /);
    expect(readdirSync(join(t.root, "releases"))).toEqual(["2026-11-19-rc.15.test.6.json"]);
    expect(run(args(t, plan, digestsDir(t.head, ["console", "lares-keeper"]))).status).toBe(0);
    const again = run(args(t, plan, digestsDir(t.head, ["console", "lares-keeper"])));
    expect(again.status).toBe(1);
    expect(again.err).toMatch(/already exists/);
  });

  it("refuses a plan made for another commit and a malformed release name", () => {
    const t = tree();
    const other = run(args(t, planFor("e".repeat(40), ["console"]), digestsDir(t.head, ["console"])));
    expect(other.status).toBe(1);
    expect(other.err).toMatch(/plan was made for/);
    const bad = run(["--release", "rc.15.test.7", ...args(t, planFor(t.head, ["console"]), digestsDir(t.head, ["console"])).slice(2)]);
    expect(bad.status).not.toBe(0);
  });
});

describe("planning from a record with no sources", () => {
  it("builds every image, and writes a complete set of outputs", () => {
    const t = tree();
    const bare = JSON.parse(readFileSync(t.previous, "utf8"));
    delete bare.sources;
    const previous = join(fresh(), "previous.json");
    writeFileSync(previous, JSON.stringify(bare));
    const out = join(fresh(), "plan");
    const result = spawnSync(process.execPath, [PLAN, "--previous", previous, "--head", t.head, "--out", out, "--repo", t.root], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const outputs = readFileSync(join(out, "outputs"), "utf8");
    expect(outputs).toContain("keeperRuntime=true\nconsole=true\nsyncJobs=true\n");
    expect(JSON.parse(outputs.split("\n")[0]!.replace("selection=", ""))).toEqual({ all: false, chiefRuntime: true, creativeRuntime: true, keeper: true, firewallHelper: true, egressProxy: true, anyKeeperFamily: true });
    expect(readFileSync(join(out, "summary.md"), "utf8")).toMatch(/records no source commit/);
    expect(JSON.parse(readFileSync(join(out, "plan.json"), "utf8")).rows).toHaveLength(7);
  });

  it("refuses a command line without the needed values, printing nothing", () => {
    const result = spawnSync(process.execPath, [PLAN, "--head", "x"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
  });
});
