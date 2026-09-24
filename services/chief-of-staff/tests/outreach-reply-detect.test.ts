import { describe, it, expect } from "vitest";
import { detectReply } from "../lib/outreach-reply-detect.js";

const SENT_AT = new Date("2026-08-10T10:00:00Z");
const ACCOUNT = "owner@project.example";

describe("detectReply", () => {
  it("returns null when no messages qualify", () => {
    expect(detectReply([], ACCOUNT, SENT_AT)).toBeNull();
  });

  it("ignores the sender's own messages", () => {
    const msgs = [{ from: "Bendik <owner@project.example>", sentAt: "2026-08-11T10:00:00Z", isCalendarNotice: false }];
    expect(detectReply(msgs, ACCOUNT, SENT_AT)).toBeNull();
  });

  it("ignores messages before the outreach was sent", () => {
    const msgs = [{ from: "Prospect <p@example.com>", sentAt: "2026-08-09T10:00:00Z", isCalendarNotice: false }];
    expect(detectReply(msgs, ACCOUNT, SENT_AT)).toBeNull();
  });

  it("ignores calendar notices (Google-generated RSVPs from the real attendee address)", () => {
    const msgs = [{ from: "Prospect <p@example.com>", sentAt: "2026-08-11T10:00:00Z", isCalendarNotice: true }];
    expect(detectReply(msgs, ACCOUNT, SENT_AT)).toBeNull();
  });

  it("finds a genuine reply after the send", () => {
    const reply = { from: "Prospect <p@example.com>", sentAt: "2026-08-11T10:00:00Z", isCalendarNotice: false };
    expect(detectReply([reply], ACCOUNT, SENT_AT)).toEqual(reply);
  });

  it("returns the EARLIEST qualifying reply when there are several", () => {
    const later = { from: "Prospect <p@example.com>", sentAt: "2026-08-12T10:00:00Z", isCalendarNotice: false };
    const earlier = { from: "Prospect <p@example.com>", sentAt: "2026-08-11T10:00:00Z", isCalendarNotice: false };
    expect(detectReply([later, earlier], ACCOUNT, SENT_AT)).toEqual(earlier);
  });

  it("account comparison is case-insensitive", () => {
    const msgs = [{ from: "Bendik <OWNER@PROJECT.EXAMPLE>", sentAt: "2026-08-11T10:00:00Z", isCalendarNotice: false }];
    expect(detectReply(msgs, ACCOUNT, SENT_AT)).toBeNull();
  });
});
