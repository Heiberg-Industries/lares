/**
 * The pure half of filing a saved web link as an `article` note: which store it belongs in, what
 * it is called, what its frontmatter says, and which of the model's proposed excerpts survive.
 * No git, no model, no network here; the filer and the runner have their own tests.
 */
import { describe, it, expect } from "vitest";

import { checkConformance, OKF_ARTICLE_TYPES, OKF_CORE_TYPES } from "@lares/agent-kit/okf";
import { noteScope } from "@lares/agent-kit/notes-store";
import { renderClipNote, type ClipRecord } from "../lib/clipping/record.js";
import {
  articleBase,
  buildArticle,
  chooseArea,
  filterExcerpts,
  filedLinkMatches,
  normaliseTopics,
  originFor,
  parseInboxClip,
  suffixedBase,
} from "../lib/digest/article.js";
import type { ArticleClassification } from "../lib/digest/classifier.js";

const NOW = new Date("2026-10-09T10:00:00.000Z");

const clip: ClipRecord = {
  sourceId: "src1",
  sourceKind: "notion",
  sourceContainer: "ds1",
  sourceItemId: "0a1b2c3d-0000-4000-8000-000000000001",
  sourceRevision: "2026-10-01T10:00:00.000Z",
  url: "https://example.com/posts/pricing-pages?utm_source=x",
  urlKey: "https://example.com/posts/pricing-pages",
  title: "Pricing pages that convert",
  note: "Check the section on anchoring.",
  tags: ["Pricing", "Onboarding Flows"],
  capturedAt: "2026-10-01T09:30:00.000Z",
  owner: "organisation",
  visibility: "shared",
};

const FULL_TEXT =
  "Pricing pages work best when the middle plan is the obvious choice. " +
  "A visitor compares three plans in a few seconds and anchors on the first number they see. " +
  "Clear plan names matter more than clever copy.\n\nSecond paragraph about onboarding.";

const article = { url: clip.url, title: "How pricing pages convert", text: FULL_TEXT };

const classification: ArticleClassification = {
  summary: "Pricing pages convert when one plan is clearly the default.",
  topics: ["Pricing", "conversion", "Landing Pages"],
  excerpts: ["A visitor compares three plans in a few seconds and anchors on the first number they see."],
  links: [],
};

function fm(raw: string, key: string): string | undefined {
  return raw.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1];
}

function build(over: Partial<Parameters<typeof buildArticle>[0]> = {}) {
  const inboxBody = over.inboxBody ?? renderClipNote(clip);
  return buildArticle({
    inboxBody,
    article,
    classification,
    area: "shared",
    base: "how-pricing-pages-convert",
    now: NOW,
    today: "2026-10-09",
    ...over,
  });
}

describe("buildArticle from a Notion-shaped inbox note", () => {
  it("keeps the link, the clip's identity and provenance, and the reading state", () => {
    const out = build();
    expect(out.notePath).toBe("articles/how-pricing-pages-convert.md");
    expect(out.companionPath).toBe("articles/how-pricing-pages-convert.txt");
    const raw = out.noteRaw;
    expect(fm(raw, "type")).toBe("article");
    expect(fm(raw, "title")).toBe('"How pricing pages convert"');
    expect(raw).toContain('sources:\n  - resource: "https://example.com/posts/pricing-pages?utm_source=x"\n');
    expect(fm(raw, "reading")).toBe("to-read");
    expect(fm(raw, "gathered_by")).toBe("owner");
    expect(fm(raw, "captured")).toBe("2026-10-01");
    expect(raw).toContain('generated:\n  by: "process:digest"\n  at: "2026-10-09T10:00:00Z"\n');
    expect(fm(raw, "lares_origin")).toBe("third_party");
    expect(fm(raw, "owner")).toBe("organisation");
    expect(fm(raw, "scope")).toBe("org");
    expect(fm(raw, "notion_page")).toBe("0a1b2c3d-0000-4000-8000-000000000001");
    expect(fm(raw, "full_text")).toBe("how-pricing-pages-convert.txt");
    expect(fm(raw, "status")).toBeUndefined();
    expect(fm(raw, "visibility")).toBeUndefined();
  });

  it("puts the owner's clip note under ## Note and keeps the full text out of the note", () => {
    const out = build();
    expect(out.noteRaw).toContain("## Note\nCheck the section on anchoring.");
    expect(out.noteRaw).not.toContain("Second paragraph about onboarding");
    expect(out.noteRaw).toContain("[Full text](how-pricing-pages-convert.txt)");
    expect(out.companionText).toBe(FULL_TEXT);
  });

  it("orders the body: summary, excerpts (marked as suggested), note, related, full text", () => {
    const out = build({ classification: { ...classification, links: ["[[some-note]]"] }, area: "private" });
    const body = out.noteRaw.slice(out.noteRaw.indexOf("\n---\n", 4) + 5);
    const order = [
      "Pricing pages convert when one plan is clearly the default.",
      "## Proposed excerpts",
      "> A visitor compares three plans",
      "## Note",
      "## Related\n[[some-note]]",
      "## Full text",
    ].map((s) => body.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toMatch(/Suggested by Lares/i);
  });

  it("omits empty sections, and never links a shared note to a private note's name", () => {
    const bare = renderClipNote({ ...clip, note: null });
    const out = build({
      inboxBody: bare,
      classification: { summary: "", topics: [], excerpts: [], links: ["[[some-private-note]]"] },
    });
    expect(out.noteRaw).not.toContain("## Note");
    expect(out.noteRaw).not.toContain("## Proposed excerpts");
    expect(out.noteRaw).not.toContain("## Related");
    expect(out.noteRaw).not.toContain("some-private-note");
    expect(out.noteRaw).toContain("## Full text");
  });

  it("passes the OKF check with the article type, and is an unknown type without it", () => {
    const out = build();
    const files = [{ path: out.notePath, raw: out.noteRaw }];
    expect(checkConformance(files, { types: [...OKF_CORE_TYPES, ...OKF_ARTICLE_TYPES] })).toEqual([]);
    expect(checkConformance(files, { types: OKF_CORE_TYPES })).toHaveLength(1);
  });

  it("reads back as an org-scope note owned by the organisation", () => {
    const out = build();
    expect(noteScope(out.noteRaw, "atlas")).toEqual({ scope: "org", participants: [], owner: "organisation" });
  });

  it("keeps a title with quotes, colons and a newline on one safe line", () => {
    const out = build({ article: { ...article, title: 'Why "pricing": a\nstory' } });
    expect(fm(out.noteRaw, "title")).toBe('"Why \\"pricing\\": a story"');
    expect(out.noteRaw.split("\n---\n").length).toBe(2);
  });
});

describe("topics and summary as written", () => {
  it("quotes every topic, so yes, no, null and 2024 stay text", () => {
    const out = build({ classification: { ...classification, topics: ["yes", "no", "null", "2024"] }, inboxBody: renderClipNote({ ...clip, tags: [] }) });
    expect(fm(out.noteRaw, "topics")).toBe('["yes", "no", "null", "2024"]');
  });

  it("caps an over-long summary at 1,200 characters", () => {
    const out = build({ classification: { ...classification, summary: "word ".repeat(600) } });
    const body = out.noteRaw.slice(out.noteRaw.indexOf("\n---\n", 4) + 5).trim();
    const summary = body.split("\n\n")[0]!;
    expect(summary.length).toBeLessThanOrEqual(1200);
    expect(summary.length).toBeGreaterThan(1000);
  });
});

describe("areas, owners and scopes", () => {
  it("a shared Notion clip goes to the shared area", () => {
    expect(chooseArea(parseInboxClip(renderClipNote(clip)), "shared")).toBe("shared");
  });

  it("a Karakeep clip goes to the shared area as the organisation's, origin third_party (a model summary of a fetched page)", () => {
    const raw = "---\nurl: https://example.com/a\ntitle: A\nsource: karakeep\nsaved: 2026-09-01T00:00:00Z\nkarakeep_id: k1\n---\n\n";
    const parsed = parseInboxClip(raw);
    expect(chooseArea(parsed, "shared")).toBe("shared");
    const out = build({ inboxBody: raw });
    expect(fm(out.noteRaw, "owner")).toBe("organisation");
    expect(fm(out.noteRaw, "scope")).toBe("org");
    expect(fm(out.noteRaw, "gathered_by")).toBe("owner");
    expect(fm(out.noteRaw, "lares_origin")).toBe("third_party");
  });

  it("a private member clip stays private: scope private, owner is the member, gathered by the member", () => {
    const raw = renderClipNote({ ...clip, owner: "fixture-member", visibility: "private" });
    expect(chooseArea(parseInboxClip(raw), "shared")).toBe("private");
    const out = build({ inboxBody: raw, area: "private" });
    expect(fm(out.noteRaw, "scope")).toBe("private");
    expect(fm(out.noteRaw, "owner")).toBe("fixture-member");
    expect(fm(out.noteRaw, "gathered_by")).toBe("member:fixture-member");
    expect(noteScope(out.noteRaw, "brain")).toEqual({ scope: "private", participants: [], owner: "fixture-member" });
  });

  it("a member's shared clip is shared, owned by the member", () => {
    const raw = renderClipNote({ ...clip, owner: "fixture-member", visibility: "shared" });
    const out = build({ inboxBody: raw });
    expect(fm(out.noteRaw, "owner")).toBe("fixture-member");
    expect(fm(out.noteRaw, "scope")).toBe("org");
    expect(fm(out.noteRaw, "gathered_by")).toBe("member:fixture-member");
  });

  it("a private note whose clip belongs to the organisation writes no owner at all", () => {
    const out = build({ area: "private" });
    expect(fm(out.noteRaw, "scope")).toBe("private");
    expect(fm(out.noteRaw, "owner")).toBeUndefined();
  });

  it("a note an agent wrote in chat (vault_write's real frontmatter, source: agent) follows the article area setting", () => {
    // Exactly what the vault_write tool writes: title, type, source, lares_origin, created, tags.
    const raw = "---\ntitle: A\ntype: note\nsource: agent\nlares_origin: owner\ncreated:\ntags: []\n---\n\nhttps://example.com/a\n\nWorth reading.\n";
    expect(chooseArea(parseInboxClip(raw), "shared")).toBe("shared");
    expect(chooseArea(parseInboxClip(raw), "private")).toBe("private");
  });

  it("a note with no source at all has no provenance: private, whatever the setting", () => {
    const raw = "---\nurl: https://example.com/a\ntitle: A\n---\n\nJust a link.\n";
    expect(chooseArea(parseInboxClip(raw), "shared")).toBe("private");
    expect(chooseArea(parseInboxClip(raw), "private")).toBe("private");
    const out = build({ inboxBody: raw, area: "private" });
    expect(fm(out.noteRaw, "scope")).toBe("private");
    expect(fm(out.noteRaw, "lares_origin")).toBe("third_party");
  });

  it("a chat note that names a member owner, or says it is private, is not widened", () => {
    const owned = "---\nurl: https://example.com/a\nsource: agent\nowner: fixture-member\n---\n\n";
    expect(chooseArea(parseInboxClip(owned), "shared")).toBe("private");
    const priv = "---\nurl: https://example.com/a\nsource: agent\nvisibility: private\n---\n\n";
    expect(chooseArea(parseInboxClip(priv), "shared")).toBe("private");
  });

  it("a source we do not recognise is private, whatever the setting", () => {
    const raw = "---\nurl: https://example.com/a\nsource: somewhere-else\n---\n\n";
    expect(chooseArea(parseInboxClip(raw), "shared")).toBe("private");
    const odd = "---\nurl: https://example.com/a\nvisibility: friends\n---\n\n";
    expect(chooseArea(parseInboxClip(odd), "shared")).toBe("private");
  });

  it("the setting private sends every clip to the private area, shared sources included", () => {
    expect(chooseArea(parseInboxClip(renderClipNote(clip)), "private")).toBe("private");
    const karakeep = "---\nurl: https://example.com/a\nsource: karakeep\n---\n\n";
    expect(chooseArea(parseInboxClip(karakeep), "private")).toBe("private");
  });

  it("a clip whose source is private never goes shared, whatever the setting", () => {
    const raw = renderClipNote({ ...clip, owner: "fixture-member", visibility: "private" });
    expect(chooseArea(parseInboxClip(raw), "shared")).toBe("private");
    const orgPrivate = renderClipNote({ ...clip, owner: "organisation", visibility: "private" });
    expect(chooseArea(parseInboxClip(orgPrivate), "shared")).toBe("private");
  });

  it("an owner that is not a plain id is never trusted: the clip is filed privately without one", () => {
    const raw = "---\nurl: https://example.com/a\nsource: notion\nowner: someone else\nvisibility: shared\n---\n\n";
    expect(chooseArea(parseInboxClip(raw), "shared")).toBe("private");
  });
});

describe("the owner's note from a chat-saved clip", () => {
  const raw = "---\ntitle: A\ntype: note\nsource: agent\nlares_origin: owner\ncreated:\ntags: []\n---\n\nhttps://example.com/a?utm_source=x\n\nWorth reading before Friday.\n";

  it("drops the bare link line from the body when the fetched page's address is given, though the frontmatter has no url", () => {
    expect(parseInboxClip(raw, "https://example.com/a").note).toBe("Worth reading before Friday.");
  });

  it("matches the link after normalising, and only a line that is the link on its own", () => {
    const withText = raw.replace("Worth reading before Friday.", "See https://example.com/a for the details.");
    expect(parseInboxClip(withText, "https://example.com/a").note).toBe("See https://example.com/a for the details.");
  });

  it("keeps everything when no address is given (nothing to compare with)", () => {
    expect(parseInboxClip(raw).note).toContain("https://example.com/a?utm_source=x");
  });
});

describe("origin rules", () => {
  // An article note holds a model's summary and quotes from a fetched web page, so it is never
  // more trusted than third_party, whatever the clip said about itself. The clip's own provenance
  // stays visible in gathered_by, notion_page and sources.
  it("never lets a clip's own origin raise an article above third_party", () => {
    for (const origin of ["owner", "agent", "synced", "system"]) {
      expect(originFor(parseInboxClip(`---\nurl: https://example.com\nlares_origin: ${origin}\n---\n\n`)), origin).toBe("third_party");
    }
  });
  it("stamps third_party on Karakeep and Notion clips too", () => {
    expect(originFor(parseInboxClip("---\nurl: https://example.com\nsource: karakeep\n---\n\n"))).toBe("third_party");
    expect(originFor(parseInboxClip("---\nurl: https://example.com\nsource: notion\nlares_origin: synced\n---\n\n"))).toBe("third_party");
  });
  it("fails closed to third_party on anything else, including an invalid value", () => {
    expect(originFor(parseInboxClip("---\nurl: https://example.com\n---\n\n"))).toBe("third_party");
    expect(originFor(parseInboxClip("---\nurl: https://example.com\nlares_origin: hearsay\n---\n\n"))).toBe("third_party");
  });
});

describe("topics", () => {
  it("puts the clip's own tags first, then the model's, lowercased and de-duplicated", () => {
    expect(normaliseTopics(["Pricing", "Onboarding Flows"], ["pricing", "Conversion"])).toEqual([
      "pricing", "onboarding flows", "conversion",
    ]);
  });
  it("drops anything that is not a short plain phrase", () => {
    const topics = normaliseTopics(
      ["ok", "---", "a b c d", "x".repeat(31), "has, comma", "[bracket]", "", "  spaced   out  "],
      ["emoji 🚀", "fine-topic", "42"],
    );
    expect(topics).toEqual(["ok", "spaced out", "fine-topic", "42"]);
  });
  it("keeps letters beyond ASCII", () => {
    expect(normaliseTopics([], ["Prissetting", "ærlig økonomi"])).toEqual(["prissetting", "ærlig økonomi"]);
  });
  it("caps the list at eight", () => {
    const many = Array.from({ length: 12 }, (_, i) => `topic ${String.fromCharCode(97 + i)}`);
    expect(normaliseTopics(many, [])).toHaveLength(8);
  });
});

describe("excerpts are kept only when found verbatim in the full text", () => {
  const text =
    "He said “the middle plan wins” – and the room agreed on this point: pricing pages need one clear default plan.\n\n" +
    "Another line of the page, long enough to quote, about onboarding checklists that people actually finish.";

  it("keeps a real quote, tolerating whitespace, curly quotes and dashes", () => {
    const quote = 'He said "the middle plan wins" - and the room agreed on this point: pricing pages need one clear default plan.';
    expect(filterExcerpts([quote], text)).toEqual([quote]);
    expect(filterExcerpts(["Another line of the page, long enough to quote,\n  about onboarding checklists that people actually finish."], text)).toHaveLength(1);
  });
  it("drops an excerpt that is not in the text", () => {
    expect(filterExcerpts(["The model made this sentence up, and it is certainly long enough to count."], text)).toEqual([]);
  });
  it("drops excerpts under 40 or over 400 characters", () => {
    expect(filterExcerpts(["one clear default plan"], text)).toEqual([]);
    const long = "word ".repeat(100);
    expect(filterExcerpts([long], long + text)).toEqual([]);
  });
  it("de-duplicates and keeps at most three", () => {
    const sentences = Array.from({ length: 5 }, (_, i) => `Sentence number ${i} is long enough to be quoted back verbatim.`);
    const out = filterExcerpts([sentences[0]!, sentences[0]!, ...sentences.slice(1)], sentences.join(" "));
    expect(out).toEqual(sentences.slice(0, 3));
  });
});

describe("names", () => {
  it("slugs the readability title, trimmed to 60", () => {
    expect(articleBase({ readabilityTitle: "Hello, World! A Test", clipTitle: "x", url: "https://example.com/a" })).toBe("hello-world-a-test");
    const base = articleBase({ readabilityTitle: "word ".repeat(30), clipTitle: "x", url: "https://example.com/a" });
    expect(base.length).toBeLessThanOrEqual(60);
    expect(base.endsWith("-")).toBe(false);
  });
  it("falls back to the clip title for a missing or Untitled page title", () => {
    expect(articleBase({ readabilityTitle: "Untitled", clipTitle: "My clip title", url: "https://example.com/a" })).toBe("my-clip-title");
    expect(articleBase({ readabilityTitle: "", clipTitle: "My clip title", url: "https://example.com/a" })).toBe("my-clip-title");
  });
  it("falls back to the link's host and path when no title yields letters", () => {
    expect(articleBase({ readabilityTitle: "Untitled", clipTitle: "!!!", url: "https://Example.com/blog/post-1?x=1" })).toBe("example-com-blog-post-1");
  });
  it("transliterates common Nordic letters instead of dropping them", () => {
    expect(articleBase({ readabilityTitle: "Prisen på årets æbler og øl", clipTitle: "", url: "https://example.com" })).toBe("prisen-pa-arets-aebler-og-ol");
  });
  it("adds six hex characters of the link's hash for a different link with the same title", () => {
    const a = suffixedBase("same-title", "https://example.com/a");
    const b = suffixedBase("same-title", "https://example.com/b");
    expect(a).toMatch(/^same-title-[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
    expect(suffixedBase("same-title", "https://example.com/a")).toBe(a);
  });
  it("keeps a suffixed name within 67 characters", () => {
    expect(suffixedBase("x".repeat(60), "https://example.com/a").length).toBeLessThanOrEqual(67);
  });
});

describe("recognising a link that is already filed", () => {
  const existing = build().noteRaw;
  it("matches the same link written with tracking noise", () => {
    expect(filedLinkMatches(existing, "https://example.com/posts/pricing-pages")).toBe(true);
  });
  it("does not match a different link", () => {
    expect(filedLinkMatches(existing, "https://example.com/posts/other")).toBe(false);
  });
  it("does not match a note with no sources", () => {
    expect(filedLinkMatches("---\ntype: note\n---\n\nbody\n", "https://example.com/posts/pricing-pages")).toBe(false);
  });
});
