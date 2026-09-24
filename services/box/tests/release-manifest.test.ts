import { describe, it, expect } from "vitest";
import { parseReleaseManifest, imageFor, ReleaseManifestInvalid, DIGEST_REFERENCE } from "../lib/release-manifest.js";

const digest = "sha256:" + "a".repeat(64);
const good = JSON.stringify({
  release: "2026-10-01",
  images: { console: `ghcr.io/example/lares-console@${digest}`, "chief-of-staff": `ghcr.io/example/lares-chief-of-staff@${digest}` },
  migrations: { box: "087_update_history.sql" },
  breaking: [],
});

describe("a release manifest", () => {
  it("reads a well-formed release", () => {
    const m = parseReleaseManifest(good);
    expect(m.release).toBe("2026-10-01");
    expect(imageFor(m, "console")).toBe(`ghcr.io/example/lares-console@${digest}`);
  });

  it("refuses an image named by a tag, naming the service", () => {
    const tagged = good.replace(`@${digest}`, ":latest");
    expect(() => parseReleaseManifest(tagged)).toThrow(ReleaseManifestInvalid);
    try { parseReleaseManifest(tagged); } catch (e) { expect((e as Error).message).toMatch(/console/); }
  });

  it("refuses a digest that is the wrong length, so a truncated paste cannot install", () => {
    expect(() => parseReleaseManifest(good.replace("a".repeat(64), "a".repeat(63)))).toThrow(ReleaseManifestInvalid);
  });

  it("refuses a release with no images at all", () => {
    expect(() => parseReleaseManifest(JSON.stringify({ release: "x", images: {}, migrations: { box: "y" }, breaking: [] })))
      .toThrow(ReleaseManifestInvalid);
  });

  it("refuses text that is not JSON, with a sentence and not a parser error", () => {
    try { parseReleaseManifest("not json"); expect.unreachable(); }
    catch (e) { expect((e as Error).message).not.toMatch(/JSON\.parse|Unexpected token/); }
  });

  it("asks for a named service rather than guessing", () => {
    expect(() => imageFor(parseReleaseManifest(good), "travel")).toThrow(ReleaseManifestInvalid);
  });

  it("agrees with the rule the keeper already enforces", () => {
    expect(DIGEST_REFERENCE.source).toContain("sha256");
    expect(DIGEST_REFERENCE.test(`ghcr.io/example/x@${digest}`)).toBe(true);
    expect(DIGEST_REFERENCE.test("ghcr.io/example/x:latest")).toBe(false);
  });
});
