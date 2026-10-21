import { describe, it, expect } from "vitest";

import { replyRecipients, ownerRecipientPosition, otherToNames, bareAddress } from "../lib/reply-recipients.js";

// Visible owners reply to everyone; hidden owners stay private to the sender.
const self = ["owner@owner.example", "owner@project.example"];

describe("replyRecipients — everyone on the original, minus me", () => {
  it("sender first, then the other To recipients, Cc kept, my own addresses removed", () => {
    const r = replyRecipients(
      {
        from: "Sam Example <sam@example.com>",
        to: ["owner@owner.example", "Taylor Example <taylor@example.com>"],
        cc: ["Una <una@example.com>", "OWNER@project.example"],
      },
      self,
    );
    expect(r).toEqual({
      to: ["Sam Example <sam@example.com>", "Taylor Example <taylor@example.com>"],
      cc: ["Una <una@example.com>"],
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

  it("does not turn an owner-sent copy into a reply to other people", () => {
    const r = replyRecipients(
      { from: "Test Owner <owner@owner.example>", to: ["sam@example.com", "taylor@example.com"], cc: [] },
      self,
    );
    expect(r).toEqual({ to: [], cc: [] });
  });

  it("with no self addresses configured, keeps the reply private", () => {
    const r = replyRecipients({ from: "a@x.no", to: ["b@x.no"], cc: ["c@x.no"] }, []);
    expect(r).toEqual({ to: ["a@x.no"], cc: [] });
  });
});


describe("owner recipient safety", () => {
  it("uses every alias, ignores case, and prefers To over Cc", () => {
    expect(ownerRecipientPosition({ to: ["Owner <OWNER@PROJECT.EXAMPLE>"], cc: [self[0]!] }, self)).toBe("to");
    expect(ownerRecipientPosition({ to: ["Taylor <t@example.com>"], cc: [self[1]!] }, self)).toBe("cc");
  });
  it("does not mistake empty or malformed aliases and headers for owner presence", () => {
    expect(ownerRecipientPosition({ to: ["", "broken"], cc: [] }, ["", "broken"])).toBe("bcc_or_list");
    expect(bareAddress("a@example.com\r\nCc: x@example.com")).toBe("");
    expect(bareAddress("a@example.com, b@example.com")).toBe("");
  });
  it("never exposes other To/Cc for an absent or Bcc owner, regardless of Reply-To", () => {
    const original = { from: "Sender <s@example.com>", to: ["other@example.com"], cc: ["copy@example.com"], bcc: [self[0]!], replyTo: "list@example.com" };
    expect(replyRecipients(original, self)).toEqual({ to: ["Sender <s@example.com>"], cc: [] });
    expect(replyRecipients({ ...original, from: "invalid" }, self)).toEqual({ to: [], cc: [] });
  });
  it("returns only other To display names", () => {
    expect(otherToNames({ to: [self[0]!, "Taylor <t@example.com>", "bare@example.com", "broken"] }, self)).toEqual(["Taylor"]);
  });
});


describe("single mailbox parsing", () => {
  const malformed = [
    "extra@example.com, Sender <sender@example.com>",
    "extra@example.com Sender <sender@example.com>",
    "extra@example.com, Owner <owner@owner.example>",
    "extra@example.com Owner <owner@owner.example>",
    "Sender <sender@example.com>\u0000",
  ];
  it.each(malformed)("rejects a malformed From without producing any recipient: %s", (from) => {
    expect(bareAddress(from)).toBe("");
    expect(replyRecipients({ from, to: ["other@example.com"], cc: [] }, self)).toEqual({ to: [], cc: [] });
  });
  it.each(malformed)("does not accept a malformed To/Cc entry as owner presence: %s", (entry) => {
    expect(ownerRecipientPosition({ to: [entry], cc: [] }, self)).toBe("bcc_or_list");
    expect(ownerRecipientPosition({ to: [], cc: [entry] }, self)).toBe("bcc_or_list");
    expect(ownerRecipientPosition({ to: [self[0]!], cc: [] }, [entry])).toBe("bcc_or_list");
  });
  it("preserves a legitimate quoted display comma while emitting one canonical mailbox", () => {
    const original = { from: '\"Example, Sender\" <SENDER@EXAMPLE.COM>', to: ['\"Example, Owner\" <OWNER@OWNER.EXAMPLE>'], cc: [] };
    expect(ownerRecipientPosition(original, self)).toBe("to");
    expect(replyRecipients(original, self)).toEqual({ to: ['\"Example, Sender\" <sender@example.com>'], cc: [] });
    expect(replyRecipients({ ...original, to: [] }, self)).toEqual({ to: ['\"Example, Sender\" <sender@example.com>'], cc: [] });
  });
});
