/**
 * ORB-133 Task 2 — enrichment, and the seam where the old runtime's second readability client
 * was replaced by eve-saga's own.
 *
 * The two properties under test are the ones a port loses silently: the 300-character floor
 * (without it, short pages start enriching) and never-throw (without it, one unreachable URL
 * turns a filable note into a reported error).
 */
import { describe, it, expect } from "vitest";

import { makeEnrich, MIN_ARTICLE_CHARS } from "../lib/digest/enrich.js";
import { digestReadability } from "../lib/digest/readability.js";

const noAttachments = async () => Buffer.alloc(0);
const article = (n = MIN_ARTICLE_CHARS + 50) => "x".repeat(n);

describe("makeEnrich dispatch", () => {
  it("replaces a bare-URL body with the fetched article text", async () => {
    const enrich = makeEnrich({
      readability: async () => ({ title: "Real Title", text: article() }),
      readFile: noAttachments,
    });
    const out = await enrich({ path: "_inbox/clip.md", body: "https://example.com/post" });
    expect(out.enriched).toBe(true);
    expect(out.body).toContain("x".repeat(100));
    // The provenance comment is how a filed note still points at where it came from.
    expect(out.body).toContain("<!-- source: https://example.com/post -->");
  });

  it("prefers the URL in frontmatter over one found in the body", async () => {
    const seen: string[] = [];
    const enrich = makeEnrich({
      readability: async (url) => { seen.push(url); return { title: "t", text: article() }; },
      readFile: noAttachments,
    });
    await enrich({
      path: "_inbox/clip.md",
      body: "---\nurl: https://frontmatter.test/a\n---\n\nhttps://body.test/b\nsome label",
    });
    expect(seen).toEqual(["https://frontmatter.test/a"]);
  });

  it("leaves plain prose alone and never calls the worker", async () => {
    let called = false;
    const enrich = makeEnrich({
      readability: async () => { called = true; return { title: "t", text: article() }; },
      readFile: noAttachments,
    });
    const body = "This is a real note with actual prose in it, not a bare link.";
    const out = await enrich({ path: "_inbox/note.md", body });
    expect(out.enriched).toBe(false);
    expect(out.body).toBe(body);
    expect(called).toBe(false);
  });

  it("an unconfigured worker leaves the item untouched rather than failing it", async () => {
    const enrich = makeEnrich({ readability: null, readFile: noAttachments });
    const out = await enrich({ path: "_inbox/clip.md", body: "https://example.com/post" });
    expect(out.enriched).toBe(false);
    expect(out.body).toBe("https://example.com/post");
  });

  it("a null result (worker found nothing usable) falls back to the original body", async () => {
    const enrich = makeEnrich({ readability: async () => null, readFile: noAttachments });
    const out = await enrich({ path: "_inbox/clip.md", body: "https://example.com/post" });
    expect(out.enriched).toBe(false);
    expect(out.body).toBe("https://example.com/post");
  });
});

describe("digestReadability — the seam onto eve-saga's own client", () => {
  it("returns the article when it clears the length floor", async () => {
    const client = digestReadability(async () => ({ title: "T", text: article() }));
    const out = await client("https://example.com/a");
    expect(out).not.toBeNull();
    expect(out!.title).toBe("T");
  });

  // Without this the digest would start enriching stubs and paywall interstitials that the old
  // service deliberately left alone — a silent behaviour change, not a visible failure.
  it("REJECTS an article below the 300-character floor", async () => {
    const client = digestReadability(async () => ({ title: "T", text: "too short" }));
    expect(await client("https://example.com/a")).toBeNull();
  });

  it("accepts exactly at the floor", async () => {
    const client = digestReadability(async () => ({ title: "T", text: "y".repeat(MIN_ARTICLE_CHARS) }));
    expect(await client("https://example.com/a")).not.toBeNull();
  });

  // readUrl THROWS; enrichItem calls the client with no try/catch. Degrading here is what keeps
  // one unreachable URL from turning a filable note into a reported error.
  it("NEVER throws — a worker error becomes null", async () => {
    const client = digestReadability(async () => { throw new Error("readability worker down"); });
    await expect(client("https://example.com/a")).resolves.toBeNull();
  });

  it("never throws on a blocked-egress hang surfacing as an error either", async () => {
    const client = digestReadability(async () => { throw new Error("fetch failed"); });
    await expect(client("https://example.com/a")).resolves.toBeNull();
  });

  it("substitutes a title when the worker returns none", async () => {
    const client = digestReadability(async () => ({ title: "", text: article() }));
    expect((await client("https://example.com/a"))!.title).toBe("Untitled");
  });
});

describe("the two composed — a throwing worker still yields a filable item", () => {
  it("an item whose URL cannot be fetched is enriched=false, not an exception", async () => {
    const enrich = makeEnrich({
      readability: digestReadability(async () => { throw new Error("down"); }),
      readFile: noAttachments,
    });
    const out = await enrich({ path: "_inbox/clip.md", body: "https://example.com/post" });
    expect(out.enriched).toBe(false);
    expect(out.body).toBe("https://example.com/post");
  });
});
