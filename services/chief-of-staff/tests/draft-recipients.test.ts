import { describe, it, expect } from "vitest";

import { applyRecipientChanges, currentRecipients, rewriteRecipientHeaders } from "../lib/draft-recipients.js";

/**
 * 2026-09-08: "add Kjetil to the reply to Stefan" — Saga changes who an EXISTING Gmail draft goes
 * to. The draft's raw RFC 822 message is rewritten in place: only the To/Cc header lines above the
 * first blank line change, so the body, the HTML part and the appended signature survive byte for
 * byte. Folded headers (continuation lines starting with whitespace) are unfolded first.
 */
const raw = [
  "From: owner@owner.example",
  "To: Stefan <stefan@example.com>,",
  " Kjetil <kjetil@example.com>",
  "Cc: eli@example.no",
  "Subject: Re: Folkepuls",
  "MIME-Version: 1.0",
  'Content-Type: text/plain; charset="UTF-8"',
  "",
  "Hei alle,",
  "",
  "To: this line is body text and must not be touched.",
  "",
].join("\r\n");

describe("currentRecipients — reads To/Cc off a raw draft, unfolding continuation lines", () => {
  it("returns the unfolded lists", () => {
    expect(currentRecipients(raw)).toEqual({
      to: ["Stefan <stefan@example.com>", "Kjetil <kjetil@example.com>"],
      cc: ["eli@example.no"],
    });
  });
  it("a draft with no Cc has an empty Cc list", () => {
    expect(currentRecipients("From: a@b\r\nTo: c@d\r\nSubject: s\r\n\r\nbody").cc).toEqual([]);
  });
});

describe("rewriteRecipientHeaders — only the header block changes", () => {
  it("replaces To and Cc, leaves every other header and the whole body untouched", () => {
    const out = rewriteRecipientHeaders(raw, { to: ["Stefan <stefan@example.com>"], cc: ["kjetil@example.com", "eli@example.no"] });
    const [headers, ...body] = out.split("\r\n\r\n");
    expect(headers).toBe(
      [
        "From: owner@owner.example",
        "To: Stefan <stefan@example.com>",
        "Cc: kjetil@example.com, eli@example.no",
        "Subject: Re: Folkepuls",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
      ].join("\r\n"),
    );
    expect(body.join("\r\n\r\n")).toBe(raw.split("\r\n\r\n").slice(1).join("\r\n\r\n"));
  });

  it("adds a Cc header when the draft had none, and drops it when nobody is copied", () => {
    const noCc = "From: a@b\r\nTo: c@d\r\nSubject: s\r\n\r\nbody";
    expect(rewriteRecipientHeaders(noCc, { to: ["c@d"], cc: ["e@f"] }).split("\r\n\r\n")[0]).toBe("From: a@b\r\nTo: c@d\r\nCc: e@f\r\nSubject: s");
    expect(rewriteRecipientHeaders(raw, { to: ["stefan@example.com"], cc: [] })).not.toMatch(/^Cc:/m);
  });
});

describe("applyRecipientChanges — add and remove by bare address", () => {
  const current = { to: ["Stefan <stefan@example.com>"], cc: ["eli@example.no"] };

  it("adds to To unless the address is already present anywhere", () => {
    expect(applyRecipientChanges(current, { add: ["Kjetil <kjetil@example.com>", "ELI@example.no"] }))
      .toEqual({ to: ["Stefan <stefan@example.com>", "Kjetil <kjetil@example.com>"], cc: ["eli@example.no"] });
  });

  it("removes across To and Cc, matching the bare address case-insensitively", () => {
    expect(applyRecipientChanges({ to: ["a@x.no", "Kjetil <kjetil@example.com>"], cc: ["eli@example.no"] }, { remove: ["KJETIL@example.com", "eli@example.no"] }))
      .toEqual({ to: ["a@x.no"], cc: [] });
  });

  it("refuses to leave the draft with nobody in To", () => {
    expect(() => applyRecipientChanges(current, { remove: ["stefan@example.com"] })).toThrow(/nobody left in To/);
  });
});
