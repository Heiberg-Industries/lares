/**
 * `classifyArticle`: the one model call made per saved web link. It proposes; code in
 * `lib/digest/article.ts` decides what survives. These tests pin what is asked, how a reply is
 * read, and that a reply nobody can read still files the article (with nothing proposed).
 */
import { describe, it, expect } from "vitest";

import { BODY_CHARS_FOR_CLASSIFY } from "../lib/digest/types.js";
import { classifyArticle } from "../lib/digest/classifier.js";

const item = {
  title: "How pricing pages convert",
  url: "https://example.com/posts/pricing-pages",
  ownerNote: "Check the section on anchoring.",
  text: "ARTICLE-START " + "x".repeat(BODY_CHARS_FOR_CLASSIFY + 500) + " ARTICLE-END",
};
const ctx = { noteNames: ["pricing-notes", "Onboarding"] };

describe("classifyArticle", () => {
  it("reads a well-formed reply and caps topics at six and excerpts at three", async () => {
    const reply = JSON.stringify({
      summary: "One plan should be the obvious default.",
      topics: ["a", "b", "c", "d", "e", "f", "g", "h"],
      excerpts: ["e1", "e2", "e3", "e4"],
      links: ["pricing-notes", "not-a-note"],
    });
    const out = await classifyArticle(item, ctx, async () => reply);
    expect(out.summary).toBe("One plan should be the obvious default.");
    expect(out.topics).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(out.excerpts).toEqual(["e1", "e2", "e3"]);
    expect(out.links).toEqual(["[[pricing-notes]]"]);
    expect(out.unreadable).toBeFalsy();
  });

  it("tolerates a code fence and surrounding prose", async () => {
    const out = await classifyArticle(item, ctx, async () => 'Here you go:\n```json\n{"summary":"S","topics":[],"excerpts":[],"links":[]}\n```');
    expect(out.summary).toBe("S");
  });

  it("is always an article that files, whatever the model says", async () => {
    const out = await classifyArticle(item, ctx, async () => '{"type":"transcript","route":"ask","summary":"S"}');
    expect(out.type).toBe("article");
    expect(out.route).toBe("file");
  });

  it("an unreadable reply still files, with nothing proposed, and says so", async () => {
    const out = await classifyArticle(item, ctx, async () => "I cannot do that.");
    expect(out).toMatchObject({ type: "article", route: "file", summary: "", topics: [], excerpts: [], links: [], unreadable: true });
  });

  it("ignores fields of the wrong shape instead of throwing", async () => {
    const out = await classifyArticle(item, ctx, async () => '{"summary":42,"topics":"pricing","excerpts":[1,"ok"],"links":null}');
    expect(out.topics).toEqual([]);
    expect(out.links).toEqual([]);
    expect(out.excerpts).toEqual(["ok"]);
  });

  it("asks with the owner's note and only the start of the page, labelled as someone else's text", async () => {
    let prompt = "";
    await classifyArticle(item, ctx, async (p) => { prompt = p; return "{}"; });
    expect(prompt).toContain("Check the section on anchoring.");
    expect(prompt).toContain(item.title);
    expect(prompt).toContain(item.url);
    expect(prompt).toContain("ARTICLE-START");
    expect(prompt).not.toContain("ARTICLE-END");
    expect(prompt).toContain("pricing-notes");
    expect(prompt).toMatch(/written by someone else/i);
  });

  it("carries no installation names or personas in the prompt", async () => {
    let prompt = "";
    await classifyArticle(item, ctx, async (p) => { prompt = p; return "{}"; });
    expect(prompt).not.toMatch(/Bendik|Brain|Saga|zero7|murmur|orakel|Heiberg/i);
  });
});
