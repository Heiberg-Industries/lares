import { describe, it, expect } from "vitest";
import { makeNotionReader } from "../lib/adapters/notion-source.js";
import type { SourceRef } from "../lib/sources.js";

const ref: SourceRef = {
  prefix: "notion",
  locator: "2f5cc987-b457-8094-a784-cbcc9b67493f",
  declared: "notion:2f5cc987-b457-8094-a784-cbcc9b67493f",
};

describe("makeNotionReader", () => {
  it("reads a page as markdown", async () => {
    const r = await makeNotionReader({ getPageMarkdown: async () => "# SOMA\n\nThe playbook.\n" }).read(ref);
    expect(r).toMatchObject({ outcome: "found", content: "# SOMA\n\nThe playbook.\n" });
  });

  it("treats a 404-shaped error as MISSING — the page was deleted or un-shared", async () => {
    const r = await makeNotionReader({
      getPageMarkdown: async () => { throw Object.assign(new Error("Not found"), { status: 404 }); },
    }).read(ref);
    expect(r.outcome).toBe("missing");
  });

  it("treats every other error as FAILED", async () => {
    const r = await makeNotionReader({
      getPageMarkdown: async () => { throw Object.assign(new Error("rate limited"), { status: 429 }); },
    }).read(ref);
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/429/);
  });

  it("treats a network error as FAILED and points at egress", async () => {
    const r = await makeNotionReader({
      getPageMarkdown: async () => { throw new TypeError("fetch failed"); },
    }).read(ref);
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/egress/i);
  });

  it("never returns empty markdown as found", async () => {
    const r = await makeNotionReader({ getPageMarkdown: async () => "" }).read(ref);
    expect(r.outcome).toBe("failed");
  });

  it("blames rate limiting, not egress, when notion-sync's client exhausts its retries on 429s", async () => {
    const r = await makeNotionReader({
      getPageMarkdown: async () => { throw new Error("rate limited after 5 attempts"); },
    }).read(ref);
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/rate limit/i);
    expect(r.reason).not.toMatch(/egress/i);
  });
});
