import { describe, it, expect } from "vitest";
import { isBulkMail, makeGmailClient, type GmailMessagesClient } from "../lib/google.js";

const h = (...pairs: Array<[string, string]>) => pairs.map(([name, value]) => ({ name, value }));

describe("isBulkMail", () => {
  it.each(["List-Unsubscribe", "List-Id", "List-Post"])("%s present marks the mail as bulk", (name) => {
    expect(isBulkMail(h(["From", "a@example.com"], [name, "<mailto:x@example.com>"]))).toBe(true);
  });

  it("header names are case-insensitive", () => {
    expect(isBulkMail(h(["list-unsubscribe", "<https://example.com/u>"]))).toBe(true);
    expect(isBulkMail(h(["LIST-ID", "<news.example.com>"]))).toBe(true);
  });

  it.each(["bulk", "list", "junk", "Bulk", " LIST "])("Precedence: %s is bulk", (value) => {
    expect(isBulkMail(h(["precedence", value]))).toBe(true);
  });

  it("Precedence: first-class is not bulk", () => {
    expect(isBulkMail(h(["Precedence", "first-class"]))).toBe(false);
  });

  it("a plain human mail is not bulk", () => {
    expect(isBulkMail(h(["From", "Anna <anna@example.com>"], ["Subject", "Lunch?"], ["To", "me@example.com"]))).toBe(false);
  });

  it("no headers at all is not bulk", () => {
    expect(isBulkMail(undefined)).toBe(false);
    expect(isBulkMail([])).toBe(false);
  });
});

describe("GmailClient.read sets isBulk", () => {
  const clientFor = (headers: Array<{ name: string; value: string }>) =>
    makeGmailClient({ get: async () => ({ id: "m1", threadId: "t1", payload: { headers } }) } as unknown as GmailMessagesClient);

  it("true for a list mail, false for a human mail", async () => {
    expect((await clientFor(h(["From", "a@example.com"], ["List-Id", "<l.example.com>"])).read("m1"))?.isBulk).toBe(true);
    expect((await clientFor(h(["From", "a@example.com"])).read("m1"))?.isBulk).toBe(false);
  });
});
