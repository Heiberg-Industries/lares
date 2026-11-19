// release-plan.test.ts — which images a test release builds and which it carries over, and the
// rule that a record is only ever assembled from a whole, honest set of digests.
import { describe, expect, it } from "vitest";
import { parseReleaseManifest, type ReleaseManifest } from "../lib/release-manifest.js";
import { PUBLISHED_IMAGES, assembleImages, groupBuilds, planRelease, selectionFor, type Ask, type PublishedDigest, type Verdict } from "../lib/release-plan.js";

const sha = (c: string): string => c.repeat(40);
const digest = (c: string): string => `sha256:${c.repeat(64)}`;
const HEAD = sha("f");
const OLD = sha("a");
const OLDER = sha("b");

function previous(sources?: Record<string, string>): ReleaseManifest {
  const images: Record<string, string> = {
    db: `docker.io/example/db@${digest("1")}`,
    "lares-gateway": `ghcr.io/example/gateway@${digest("2")}`,
    caddy: `docker.io/example/caddy@${digest("3")}`,
  };
  for (const { key } of PUBLISHED_IMAGES) images[key] = `ghcr.io/heiberg-industries/${key}@${digest("4")}`;
  return parseReleaseManifest(JSON.stringify({ release: "2026-11-19-rc.15.test.6", images, migrations: { box: "038.sql" }, breaking: [], ...(sources ? { sources } : {}) }));
}

const everyId = PUBLISHED_IMAGES.map((image) => image.id);
const answer = (rebuild: string[]): Ask => () => new Map<string, Verdict>(everyId.map((id) => [id, { rebuild: rebuild.includes(id), reason: rebuild.includes(id) ? `${id} changed` : "no changed file is an input of this image" }]));
const allSources = (commit: string): Record<string, string> => Object.fromEntries(PUBLISHED_IMAGES.map((image) => [image.key, commit]));

describe("planning a release", () => {
  it("builds the images the selector says changed and carries over the rest", () => {
    const rows = planRelease({ previous: previous(allSources(OLD)), head: HEAD, fallbackBase: "", ask: answer(["keeper", "console"]) });
    const action = Object.fromEntries(rows.map((row) => [row.key, row.action]));
    expect(action).toMatchObject({ "lares-keeper": "build", console: "build", creative: "carry", "sync-jobs": "carry", "lares-egress-proxy": "carry" });
    expect(rows.find((row) => row.key === "creative")!.base).toBe(OLD);
  });

  it("asks once per distinct source commit, and each image is judged against its own", () => {
    const asked: string[] = [];
    const sources = { ...allSources(OLD), creative: OLDER };
    const ask: Ask = (base) => {
      asked.push(base);
      return answer(base === OLDER ? ["creative-runtime"] : [])(base);
    };
    const rows = planRelease({ previous: previous(sources), head: HEAD, fallbackBase: "", ask });
    expect(asked.sort()).toEqual([OLD, OLDER].sort());
    expect(rows.filter((row) => row.action === "build").map((row) => row.key)).toEqual(["creative"]);
  });

  it("builds an image whose previous record gives no source, unless a base is given", () => {
    const none = planRelease({ previous: previous(), head: HEAD, fallbackBase: "", ask: answer([]) });
    expect(none.every((row) => row.action === "build")).toBe(true);
    expect(none[0]!.reason).toMatch(/records no source commit/);
    const given = planRelease({ previous: previous(), head: HEAD, fallbackBase: OLD, ask: answer([]) });
    expect(given.every((row) => row.action === "carry")).toBe(true);
  });

  it("builds everything when the selector fails, names an image wrongly, or the base is not a commit id", () => {
    const failing: Ask = () => { throw new Error("git could not run"); };
    expect(planRelease({ previous: previous(allSources(OLD)), head: HEAD, fallbackBase: "", ask: failing }).every((row) => row.action === "build")).toBe(true);
    const missing: Ask = () => new Map([["keeper", { rebuild: false, reason: "kept" }]]);
    const rows = planRelease({ previous: previous(allSources(OLD)), head: HEAD, fallbackBase: "", ask: missing });
    expect(rows.find((row) => row.key === "lares-keeper")!.action).toBe("carry");
    expect(rows.find((row) => row.key === "console")!.action).toBe("build");
    expect(planRelease({ previous: previous(), head: HEAD, fallbackBase: "abc", ask: answer([]) }).every((row) => row.action === "build")).toBe(true);
    expect(planRelease({ previous: previous(), head: "short", fallbackBase: OLD, ask: answer([]) }).every((row) => row.action === "build")).toBe(true);
  });

  it("builds an image whose previous digest came from this very commit", () => {
    const rows = planRelease({ previous: previous(allSources(HEAD)), head: HEAD, fallbackBase: "", ask: answer([]) });
    expect(rows.every((row) => row.action === "build")).toBe(true);
  });

  it("turns the plan into the flags of the keeper workflow, and says which workflow groups build", () => {
    const rows = planRelease({ previous: previous(allSources(OLD)), head: HEAD, fallbackBase: "", ask: answer(["firewall-helper", "sync-jobs"]) });
    expect(selectionFor(rows)).toEqual({ all: false, chiefRuntime: false, creativeRuntime: false, keeper: false, firewallHelper: true, egressProxy: false, anyKeeperFamily: true });
    expect(groupBuilds(rows, "keeper-runtime")).toBe(true);
    expect(groupBuilds(rows, "console")).toBe(false);
    expect(groupBuilds(rows, "sync-jobs")).toBe(true);
  });
});

describe("assembling the images of the record", () => {
  const rows = () => planRelease({ previous: previous(allSources(OLD)), head: HEAD, fallbackBase: "", ask: answer(["console"]) });
  const published = (key: string, commit = HEAD): PublishedDigest => ({ key, reference: `ghcr.io/heiberg-industries/${key}@${digest("9")}`, sourceCommit: commit });

  it("takes built images from the run, carried images from the previous record, and never relabels a carried one", () => {
    const { images, sources } = assembleImages(previous(allSources(OLD)), rows(), [published("console")], HEAD);
    expect(images.console).toBe(`ghcr.io/heiberg-industries/console@${digest("9")}`);
    expect(sources.console).toBe(HEAD);
    expect(images.creative).toBe(`ghcr.io/heiberg-industries/creative@${digest("4")}`);
    expect(sources.creative).toBe(OLD);
    expect(images.db).toBe(`docker.io/example/db@${digest("1")}`);
    expect(sources.db).toBeUndefined();
  });

  it("refuses a record when a built image has no digest, two, or one from another commit", () => {
    expect(() => assembleImages(previous(allSources(OLD)), rows(), [], HEAD)).toThrow(/console: .*no digest/);
    expect(() => assembleImages(previous(allSources(OLD)), rows(), [published("console"), published("console")], HEAD)).toThrow(/2 digests/);
    expect(() => assembleImages(previous(allSources(OLD)), rows(), [published("console", OLD)], HEAD)).toThrow(/not from /);
  });

  it("refuses a digest for an image the plan carried over", () => {
    expect(() => assembleImages(previous(allSources(OLD)), rows(), [published("console"), published("creative")], HEAD)).toThrow(/not to build/);
  });

  it("cannot carry over an image with no known source commit", () => {
    const rowsWithBase = planRelease({ previous: previous(), head: HEAD, fallbackBase: OLD, ask: answer([]) });
    // the base given by the caller stands in for the unknown source, and is recorded as the source
    const { sources } = assembleImages(previous(), rowsWithBase, [], HEAD);
    expect(sources.console).toBe(OLD);
  });
});
