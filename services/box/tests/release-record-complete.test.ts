// release-record-complete.test.ts — a release record written by the publish workflow carries a
// marker where a person must still write what changed and what breaks. While the marker is in a
// release file or in release notes, the checks stay red, so an unfinished record cannot merge.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseReleaseManifest } from "../lib/release-manifest.js";
import { UNWRITTEN_MARKER } from "../lib/release-record.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const releases = readdirSync(join(REPO, "releases")).filter((name) => name.endsWith(".json")).sort();
const notes = readdirSync(join(REPO, "docs", "releases")).filter((name) => name.endsWith("-notes.md")).sort();

describe("release records are finished", () => {
  it("looks at the records it should, so an empty folder cannot pass", () => {
    expect(releases.length).toBeGreaterThan(10);
    expect(notes.length).toBeGreaterThan(10);
  });

  it.each(releases)("%s is a release the installer accepts and has no part left unwritten", (name) => {
    const text = readFileSync(join(REPO, "releases", name), "utf8");
    expect(() => parseReleaseManifest(text)).not.toThrow();
    expect(text, `${name} still holds the marker: write what breaks, or delete that line`).not.toContain(UNWRITTEN_MARKER);
  });

  it.each(notes)("%s has no part left unwritten", (name) => {
    expect(readFileSync(join(REPO, "docs", "releases", name), "utf8"), `${name} still holds the marker: write what changed`).not.toContain(UNWRITTEN_MARKER);
  });
});
