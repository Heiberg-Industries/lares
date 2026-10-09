/**
 * LAR-113 child (a) — the neutral clip record: URL normaliser, link choice (URL column, then a
 * single link in the title via the digest's own detector) and the inbox note. Pure code, no model.
 */
import { describe, it, expect } from "vitest";

import {
  normaliseUrl, clipInboxPath, pickLink, renderClipNote, mapPageToClip, type ClipSource,
} from "../lib/clipping/record.js";
import { parseFrontmatter } from "../lib/digest/extract.js";

const source: ClipSource = {
  id: "src-1", kind: "notion", dataSourceId: "ds-1",
  urlPropertyId: "u1", notePropertyId: "n1", tagsPropertyId: "t1", savedPropertyId: null,
  owner: "organisation", visibility: "shared",
};

const PAGE_ID = "0a1b2c3d-0000-4000-8000-00000000abcd";

const page = (props: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  object: "page", id: PAGE_ID,
  created_time: "2026-10-01T08:00:00.000Z", last_edited_time: "2026-10-02T09:30:00.000Z",
  in_trash: false,
  properties: {
    Name: { id: "title", type: "title", title: [{ plain_text: "A good read" }] },
    Link: { id: "u1", type: "url", url: "https://Example.com/post/?utm_source=x&id=7#top" },
    Note: { id: "n1", type: "rich_text", rich_text: [{ plain_text: "for the board" }] },
    Tags: { id: "t1", type: "multi_select", multi_select: [{ name: "ai" }, { name: "ops" }] },
    ...props,
  },
  ...extra,
});

describe("normaliseUrl", () => {
  const cases: [string, string | null][] = [
    ["HTTPS://Example.COM/Path", "https://example.com/Path"],
    ["https://example.com/a/", "https://example.com/a"],
    ["https://example.com/", "https://example.com"],
    ["https://example.com/a#frag", "https://example.com/a"],
    ["https://example.com/a?utm_source=x&utm_medium=y&id=3", "https://example.com/a?id=3"],
    ["https://example.com/a?fbclid=1&gclid=2", "https://example.com/a"],
    ["https://example.com/a?id=3&utm_campaign=z", "https://example.com/a?id=3"],
    ["https://example.com:443/a", "https://example.com/a"],
    ["http://example.com:80/a", "http://example.com/a"],
    ["  https://example.com/a  ", "https://example.com/a"],
    ["https://www.example.com/a", "https://www.example.com/a"],
    ["ftp://example.com/a", null],
    ["mailto:a@b.c", null],
    ["not a url", null],
    ["", null],
  ];
  it.each(cases)("%s -> %s", (input, want) => {
    expect(normaliseUrl(input)).toBe(want);
  });

  it("is idempotent", () => {
    for (const [input] of cases) {
      const once = normaliseUrl(input);
      if (once) expect(normaliseUrl(once)).toBe(once);
    }
  });
});

describe("clipInboxPath", () => {
  it("derives the path from the source id and the page id, nothing else", () => {
    expect(clipInboxPath("src-1", PAGE_ID)).toBe("_inbox/clip-src-1-0a1b2c3d000040008000" + "00000000abcd.md");
  });
  it("refuses ids that could escape the folder", () => {
    expect(() => clipInboxPath("../x", "p")).toThrow();
    expect(() => clipInboxPath("s", "a/b")).toThrow();
  });
});

describe("pickLink", () => {
  it("prefers the mapped URL column", () => {
    expect(pickLink("https://a.com/x", "https://b.com/y")).toBe("https://a.com/x");
  });
  it("falls back to a title that is a single link", () => {
    expect(pickLink(null, "https://b.com/y")).toBe("https://b.com/y");
    expect(pickLink("", "read this https://b.com/y")).toBe("https://b.com/y");
  });
  it("does not take a link out of a sentence", () => {
    expect(pickLink(null, "what do you think of https://b.com/y ?")).toBeNull();
    expect(pickLink(null, "two https://a.com and https://b.com")).toBeNull();
  });
  it("returns null when neither holds a web link", () => {
    expect(pickLink(null, "just words")).toBeNull();
    expect(pickLink("mailto:a@b.c", "just words")).toBeNull();
  });
});

describe("mapPageToClip", () => {
  it("maps a full page by property id", () => {
    const r = mapPageToClip(page({}) as never, source);
    expect(r.kind).toBe("clip");
    if (r.kind !== "clip") return;
    expect(r.clip).toMatchObject({
      sourceId: "src-1", sourceKind: "notion", sourceContainer: "ds-1",
      sourceItemId: PAGE_ID,
      sourceRevision: "2026-10-02T09:30:00.000Z",
      url: "https://Example.com/post/?utm_source=x&id=7#top",
      urlKey: "https://example.com/post?id=7",
      title: "A good read", note: "for the board", tags: ["ai", "ops"],
      capturedAt: "2026-10-01T08:00:00.000Z",
      owner: "organisation", visibility: "shared",
    });
  });

  it("finds columns by id, so a renamed column still maps", () => {
    const p = page({ Link: undefined, "Where to read": { id: "u1", type: "url", url: "https://a.com/x" } });
    const r = mapPageToClip(p as never, source);
    expect(r.kind === "clip" && r.clip.url).toBe("https://a.com/x");
  });

  it("owner and visibility come from the source, never from the page", () => {
    const p = page({ Owner: { id: "zz", type: "rich_text", rich_text: [{ plain_text: "private" }] } },
      { owner: "someone", visibility: "private" });
    const r = mapPageToClip(p as never, source);
    expect(r.kind === "clip" && [r.clip.owner, r.clip.visibility]).toEqual(["organisation", "shared"]);
  });

  it("title falls back to the URL", () => {
    const r = mapPageToClip(page({ Name: { id: "title", type: "title", title: [] } }) as never, source);
    expect(r.kind === "clip" && r.clip.title).toBe("https://Example.com/post/?utm_source=x&id=7#top");
  });

  it("an empty URL cell with a single-link title still imports", () => {
    const p = page({
      Link: { id: "u1", type: "url", url: null },
      Name: { id: "title", type: "title", title: [{ plain_text: "https://c.com/z" }] },
    });
    const r = mapPageToClip(p as never, source);
    expect(r.kind === "clip" && r.clip.url).toBe("https://c.com/z");
  });

  it("an empty URL cell and a plain title is skipped as no link", () => {
    const p = page({ Link: { id: "u1", type: "url", url: null } });
    expect(mapPageToClip(p as never, source)).toMatchObject({ kind: "skip", reason: "no-link" });
  });

  it("a trashed page is reported as trashed", () => {
    expect(mapPageToClip(page({}, { in_trash: true }) as never, source)).toMatchObject({ kind: "trashed" });
  });

  it("uses a mapped date column for capturedAt when set", () => {
    const s = { ...source, savedPropertyId: "d1" };
    const p = page({ Saved: { id: "d1", type: "date", date: { start: "2026-09-30" } } });
    const r = mapPageToClip(p as never, s);
    expect(r.kind === "clip" && r.clip.capturedAt).toBe("2026-09-30");
  });

  it("a mapped column that is gone is ignored, not an error", () => {
    const p = page({ Note: undefined, Tags: undefined });
    const r = mapPageToClip(p as never, source);
    expect(r.kind === "clip" && [r.clip.note, r.clip.tags]).toEqual([null, []]);
  });
});

describe("renderClipNote", () => {
  it("writes the frontmatter the digest reads, metadata only", () => {
    const r = mapPageToClip(page({}) as never, source);
    if (r.kind !== "clip") throw new Error("expected clip");
    const body = renderClipNote(r.clip);
    const fm = parseFrontmatter(body);
    expect(fm).toMatchObject({
      url: "https://Example.com/post/?utm_source=x&id=7#top",
      title: "A good read", source: "notion",
      saved: "2026-10-01T08:00:00.000Z", notion_page: PAGE_ID,
      source_revision: "2026-10-02T09:30:00.000Z", owner: "organisation", visibility: "shared",
      lares_origin: "synced", tags: "ai, ops",
    });
    expect(body.endsWith("for the board\n")).toBe(true);
  });

  it("cannot be bent by a title with newlines or a frontmatter fence", () => {
    const r = mapPageToClip(page({
      Name: { id: "title", type: "title", title: [{ plain_text: "x\n---\nowner: attacker\nurl: https://evil.test" }] },
    }) as never, source);
    if (r.kind !== "clip") throw new Error("expected clip");
    const fm = parseFrontmatter(renderClipNote(r.clip));
    expect(fm["owner"]).toBe("organisation");
    expect(fm["url"]).toBe("https://Example.com/post/?utm_source=x&id=7#top");
  });
});
