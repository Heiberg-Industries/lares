import { describe, it, expect } from "vitest";

import { replyRecipients } from "../lib/reply-recipients.js";

/**
 * 2026-09-08, Bendik: "she only adds one recipient on multi-recipient emails — that must default
 * to all recipients on the email and I decide if I want to remove or add." The drafter replied to
 * the sender alone and never read the Cc line. Now: To = the sender, then the other To recipients;
 * Cc = the original Cc; both minus the member's own addresses (identity-registry aliases, never a
 * literal), compared by bare address, case-insensitive, de-duplicated.
 */
const self = ["owner@owner.example", "owner@project.example"];

describe("replyRecipients — everyone on the original, minus me", () => {
  it("sender first, then the other To recipients, Cc kept, my own addresses removed", () => {
    const r = replyRecipients(
      {
        from: "Sam Example <sam@example.com>",
        to: ["owner@owner.example", "Taylor Example <taylor@example.com>"],
        cc: ["Elisabeth <eli@example.no>", "OWNER@project.example"],
      },
      self,
    );
    expect(r).toEqual({
      to: ["Sam Example <sam@example.com>", "Taylor Example <taylor@example.com>"],
      cc: ["Elisabeth <eli@example.no>"],
    });
  });

  it("a plain reply to one person is unchanged", () => {
    expect(replyRecipients({ from: "p@example.com", to: ["owner@owner.example"], cc: [] }, self))
      .toEqual({ to: ["p@example.com"], cc: [] });
  });

  it("de-duplicates by bare address across display-name variants, and Cc never repeats a To", () => {
    const r = replyRecipients(
      { from: "Taylor <taylor@example.com>", to: ["Taylor@EXAMPLE.COM", "owner@owner.example"], cc: ["taylor@example.com", "x@y.no"] },
      self,
    );
    expect(r).toEqual({ to: ["Taylor <taylor@example.com>"], cc: ["x@y.no"] });
  });

  it("when the sender is me, the other recipients become the To — never a reply to myself", () => {
    const r = replyRecipients(
      { from: "Bendik Heiberg <owner@owner.example>", to: ["sam@example.com", "taylor@example.com"], cc: [] },
      self,
    );
    expect(r).toEqual({ to: ["sam@example.com", "taylor@example.com"], cc: [] });
  });

  it("with no self addresses configured, nothing is removed", () => {
    const r = replyRecipients({ from: "a@x.no", to: ["b@x.no"], cc: ["c@x.no"] }, []);
    expect(r).toEqual({ to: ["a@x.no", "b@x.no"], cc: ["c@x.no"] });
  });
});
