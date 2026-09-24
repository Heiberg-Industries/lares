// ORB-112 — Marcel's replies arrived with literal ** in the NYC group. eve sends text with no
// parse_mode, so markdown renders as itself. These pin the converter and, above all, the
// invariant that makes chunking safe: no tag ever spans a newline.
import { describe, it, expect } from "vitest";

import { escapeTelegramHtml, mdToTelegramHtml, splitTelegramHtml } from "../src/telegram-markdown.js";

describe("mdToTelegramHtml", () => {
  it("turns **bold** into real bold — the reported symptom", () => {
    expect(mdToTelegramHtml("**Fly (SAS, business)** kl. 09:00")).toBe("<b>Fly (SAS, business)</b> kl. 09:00");
  });

  it("handles italics in both markers, and leaves snake_case alone", () => {
    expect(mdToTelegramHtml("*kanskje* og _sikkert_")).toBe("<i>kanskje</i> og <i>sikkert</i>");
    expect(mdToTelegramHtml("feltet chat_id er satt")).toBe("feltet chat_id er satt");
  });

  it("converts inline code, and does not read formatting inside it", () => {
    expect(mdToTelegramHtml("bruk `**ikke bold**` her")).toBe("bruk <code>**ikke bold**</code> her");
  });

  it("converts links, and never italicises an underscore in the URL", () => {
    expect(mdToTelegramHtml("[Katz's](https://maps.example/a_b_c)")).toBe(
      '<a href="https://maps.example/a_b_c">Katz\'s</a>',
    );
  });

  it("bolds headings and bullets a list — a leading * is a bullet, not emphasis", () => {
    expect(mdToTelegramHtml("## Dag 1\n- Louvre\n* Middag")).toBe("<b>Dag 1</b>\n• Louvre\n• Middag");
  });

  it("escapes &, < and > before emitting any tag, so a hotel name survives", () => {
    expect(mdToTelegramHtml("**Smith & Sons** <ikke en tag>")).toBe(
      "<b>Smith &amp; Sons</b> &lt;ikke en tag&gt;",
    );
  });

  it("drops fence markers rather than emitting a <pre> that would span lines", () => {
    expect(mdToTelegramHtml("```\nSK455\n```")).toBe("SK455");
  });

  it("leaves an unmatched marker as literal text rather than emitting a broken tag", () => {
    expect(mdToTelegramHtml("to ** stjerner")).toBe("to ** stjerner");
  });

  it("escapeTelegramHtml handles exactly the three Telegram documents", () => {
    expect(escapeTelegramHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d "e"');
  });
});

describe("the invariant chunking depends on", () => {
  it("never opens a tag on one line and closes it on another", () => {
    const html = mdToTelegramHtml("**a**\n## b\n- *c*\n`d`\n[e](https://f)");

    for (const line of html.split("\n")) {
      const opens = (line.match(/<(b|i|code|a)\b/g) ?? []).length;
      const closes = (line.match(/<\/(b|i|code|a)>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
});

describe("splitTelegramHtml", () => {
  it("returns a short message untouched, as one chunk", () => {
    expect(splitTelegramHtml("<b>kort</b>")).toEqual(["<b>kort</b>"]);
  });

  it("splits on newlines only, and every chunk is independently well-formed", () => {
    const html = mdToTelegramHtml(Array.from({ length: 200 }, (_, i) => `**linje ${i}** med litt tekst`).join("\n"));
    const chunks = splitTelegramHtml(html, 500);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(500);
      expect((c.match(/<b>/g) ?? []).length).toBe((c.match(/<\/b>/g) ?? []).length);
    }
    expect(chunks.join("\n")).toBe(html);
  });

  it("emits an over-long single line whole rather than cutting it mid-tag", () => {
    const long = `<b>${"x".repeat(600)}</b>`;
    expect(splitTelegramHtml(long, 100)).toEqual([long]);
  });
});
