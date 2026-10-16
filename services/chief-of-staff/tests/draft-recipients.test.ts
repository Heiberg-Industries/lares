import { describe, it, expect } from "vitest";

import { applyRecipientChanges, currentRecipients, rewriteRecipientHeaders } from "../lib/draft-recipients.js";

/**
 * 2026-09-08: "add Mats to the reply to Henrik" — the chief of staff changes who an EXISTING Gmail draft goes
 * to. The draft's raw RFC 822 message is rewritten in place: only the To/Cc header lines above the
 * first blank line change, so the body, the HTML part and the appended signature survive byte for
 * byte. Folded headers (continuation lines starting with whitespace) are unfolded first.
 */
const raw = [
  "From: owner@owner.example",
  "To: Henrik <henrik@example.com>,",
  " Mats <mats@example.com>",
  "Cc: una@example.com",
  "Subject: Re: Weekly Sync",
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
      to: ["Henrik <henrik@example.com>", "Mats <mats@example.com>"],
      cc: ["una@example.com"],
    });
  });
  it("a draft with no Cc has an empty Cc list", () => {
    expect(currentRecipients("From: a@b\r\nTo: c@d\r\nSubject: s\r\n\r\nbody").cc).toEqual([]);
  });
});

describe("rewriteRecipientHeaders — only the header block changes", () => {
  it("replaces To and Cc, leaves every other header and the whole body untouched", () => {
    const out = rewriteRecipientHeaders(raw, { to: ["Henrik <henrik@example.com>"], cc: ["mats@example.com", "una@example.com"] });
    const [headers, ...body] = out.split("\r\n\r\n");
    expect(headers).toBe(
      [
        "From: owner@owner.example",
        "To: Henrik <henrik@example.com>",
        "Cc: mats@example.com, una@example.com",
        "Subject: Re: Weekly Sync",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
      ].join("\r\n"),
    );
    expect(body.join("\r\n\r\n")).toBe(raw.split("\r\n\r\n").slice(1).join("\r\n\r\n"));
  });

  it("adds a Cc header when the draft had none, and drops it when nobody is copied", () => {
    const noCc = "From: a@b\r\nTo: c@d\r\nSubject: s\r\n\r\nbody";
    expect(rewriteRecipientHeaders(noCc, { to: ["c@d"], cc: ["e@f"] }).split("\r\n\r\n")[0]).toBe("From: a@b\r\nTo: c@d\r\nCc: e@f\r\nSubject: s");
    expect(rewriteRecipientHeaders(raw, { to: ["henrik@example.com"], cc: [] })).not.toMatch(/^Cc:/m);
  });
});

describe("applyRecipientChanges — add and remove by bare address", () => {
  const current = { to: ["Henrik <henrik@example.com>"], cc: ["una@example.com"] };

  it("adds to To unless the address is already present anywhere", () => {
    expect(applyRecipientChanges(current, { add: ["Mats <mats@example.com>", "UNA@example.com"] }))
      .toEqual({ to: ["Henrik <henrik@example.com>", "Mats <mats@example.com>"], cc: ["una@example.com"] });
  });

  it("removes across To and Cc, matching the bare address case-insensitively", () => {
    expect(applyRecipientChanges({ to: ["a@x.no", "Mats <mats@example.com>"], cc: ["una@example.com"] }, { remove: ["MATS@example.com", "una@example.com"] }))
      .toEqual({ to: ["a@x.no"], cc: [] });
  });

  it("refuses to leave the draft with nobody in To", () => {
    expect(() => applyRecipientChanges(current, { remove: ["henrik@example.com"] })).toThrow(/nobody left in To/);
  });
});
