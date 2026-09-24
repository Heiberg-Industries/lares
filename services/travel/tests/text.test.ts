// Ported from services/marcel/tests/text.test.ts (review fix, finding 10). Old Marcel's
// lib/text.ts held toPlain/toTelegramHtml/mentionsBot/stripMention; eve-marcel has NO single
// lib/text.ts holding all four — toTelegramHtml/toPlain live inside
// agent/schedules/trip-lifecycle.ts (the flight-status card's only delivery path, deterministic
// content, ported there originally by the final review's own finding 10 fix).
//
// mentionsBot/stripMention previously had NO port anywhere in eve-marcel (group dispatch went
// entirely through the Gatekeeper's model decision, never @mention detection). The whole-branch
// review (Fix Wave B, Finding 2) found that WAS a real regression, not a deliberate
// simplification: a tagged/replied-to message could still be silenced by quiet hours or the
// speak-rate cap, exactly the failure mode old Marcel's tag-bypasses-the-gate branch prevented.
// They now live in lib/text-mention.ts, used by agent/channels/telegram.ts's group dispatch to
// detect a tagged message ahead of the gatekeeper — ported here against that file.
import { describe, it, expect } from "vitest";
import { toPlain, toTelegramHtml } from "../agent/schedules/trip-lifecycle.js";
import { mentionsBot, stripMention } from "../lib/text-mention.js";

describe("toPlain", () => {
  it("strips bold/italic/headers/links to readable text", () => {
    expect(toPlain("**Hei!** Se [kartet](https://maps.example) her.")).toBe("Hei! Se kartet (https://maps.example) her.");
    expect(toPlain("# Plan\n- punkt")).toBe("Plan\n- punkt");
  });
});

describe("mentions", () => {
  it("detects @mention case-insensitively", () => {
    expect(mentionsBot("hei @MarcelBot, hvor er stranden?", "marcelbot")).toBe(true);
    expect(mentionsBot("marcel er kul", "marcelbot")).toBe(false);
  });
  it("strips the mention for the model", () => {
    expect(stripMention("@marcelbot hvor er stranden?", "marcelbot")).toBe("hvor er stranden?");
  });
});

describe("toTelegramHtml", () => {
  it("escapes HTML then converts markdown links, bold, italics, code, headings", () => {
    expect(toTelegramHtml("**Chez Fonfon** — [kart](https://maps.google.com/?q=a&b=c)"))
      .toBe('<b>Chez Fonfon</b> — <a href="https://maps.google.com/?q=a&amp;b=c">kart</a>');
    expect(toTelegramHtml("vind < 5 m/s & sol")).toBe("vind &lt; 5 m/s &amp; sol");
    expect(toTelegramHtml("# Dagens plan")).toBe("<b>Dagens plan</b>");
    expect(toTelegramHtml("se *dette* og `koden`")).toBe("se <i>dette</i> og <code>koden</code>");
  });
  it("leaves word-internal underscores alone (file_name stays)", () => {
    expect(toTelegramHtml("flight_state.json")).toBe("flight_state.json");
  });
  it("bold inside a link label survives as nested tags", () => {
    expect(toTelegramHtml("[**Venezia** 4,3★](https://g.co/x)"))
      .toBe('<a href="https://g.co/x"><b>Venezia</b> 4,3★</a>');
  });
  it("code spans render verbatim — emphasis inside backticks never becomes tags", () => {
    expect(toTelegramHtml("`**WIP**`")).toBe("<code>**WIP**</code>");
    expect(toTelegramHtml("kode `se *a* her` og **fet**")).toBe("kode <code>se *a* her</code> og <b>fet</b>");
  });
});
