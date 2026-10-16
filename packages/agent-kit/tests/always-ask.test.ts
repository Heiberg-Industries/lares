import { describe, expect, it } from "vitest";
import {
  capabilityOfTool, CONTACT_BY_CONSTRUCTION, mustAlwaysAsk, mustAlwaysAskExceptContact,
  RECIPIENT_CHECK_REASON, RECIPIENTS_OF, SELF_AUTONOMY_TOOLS, TOOL_CATEGORIES, toolsOfCapability,
} from "../src/always-ask.js";
import { CAPABILITY_DOCS } from "../src/persona/capability-docs.js";

// Every tool name CAPABILITY_DOCS knows, including variant-scoped lists, with extension prefixes kept.
function allDocTools(): Set<string> {
  const out = new Set<string>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x)) {
        if (k === "tools" && Array.isArray(v)) v.forEach((t) => typeof t === "string" ? out.add(t) : walk(t));
        else walk(v);
      }
    }
  };
  walk(CAPABILITY_DOCS);
  return out;
}

describe("always-ask table", () => {
  it("classifies every engine tool — a new tool without a line fails here", () => {
    expect(new Set(Object.keys(TOOL_CATEGORIES))).toEqual(allDocTools());
  });
  it("money, delete and publish always ask", () => {
    expect(mustAlwaysAsk("calendar_delete_event")).toEqual({ ask: true, reason: "deleting data always asks first" });
    expect(mustAlwaysAsk("agent-kit__vault_drop")).toEqual({ ask: true, reason: "deleting data always asks first" });
    expect(mustAlwaysAsk("vault_drop")).toEqual({ ask: true, reason: "deleting data always asks first" });
  });
  it("contact asks unless the recipients are established by construction", () => {
    expect(mustAlwaysAsk("gmail_send")).toEqual({ ask: true, reason: "first contact with someone always asks first" });
    expect(CONTACT_BY_CONSTRUCTION.has("meeting_followup_send")).toBe(true);
    expect(mustAlwaysAsk("meeting_followup_send")).toEqual({ ask: false });
  });
  it("an ordinary write is not always-ask, and an unknown tool fails closed", () => {
    expect(mustAlwaysAsk("vault_write")).toEqual({ ask: false });
    expect(mustAlwaysAsk("no_such_tool")).toEqual({ ask: true, reason: "unknown tool — asking first" });
  });
  it("every contact-by-construction tool is a contact tool", () => {
    for (const t of CONTACT_BY_CONSTRUCTION) expect(TOOL_CATEGORIES[t]).toContain("contact");
  });
  it("finds a tool's capability, extension prefix included", () => {
    expect(capabilityOfTool("gmail_send")).toBe("gmail");
    expect(capabilityOfTool("agent-kit__vault_write")).toBe("vault");
    // The bare name is a DIFFERENT tool since W5C-s4: the creative role's own shared-area write.
    // Since W5C-s5 both spellings answer `vault`, so this pair no longer discriminates the
    // capability — what still separates them is the AREA each is offered under, which
    // `areaOfTool` answers and `vault-tool-names.test.ts` pins. The `agent-kit__` fallback is
    // still exercised here, by a prefixed tool with no unprefixed twin:
    expect(capabilityOfTool("vault_write")).toBe("vault");
    expect(capabilityOfTool("vault_backlinks")).toBe("vault");
    expect(capabilityOfTool("no_such_tool")).toBeUndefined();
  });
  // Final review F11: the console's fallback when an agent registered no tool list.
  it("lists a capability's documented tools — exactly the tools capabilityOfTool maps to it", () => {
    expect(toolsOfCapability("gmail")).toContain("gmail_send");
    expect(toolsOfCapability("calendar")).toEqual(expect.arrayContaining(["calendar_delete_event", "calendar_create_event"]));
    for (const t of toolsOfCapability("gmail")) expect(capabilityOfTool(t)).toBe("gmail");
    expect(toolsOfCapability("no_such_capability")).toEqual([]);
  });
});

// Final review F4 (owner decision O1, 2026-09-15): an agent never raises its own autonomy without
// the owner's 👍 — switching a meeting series to auto-send always asks, whatever the board says.
describe("tools that change an agent's own autonomy", () => {
  it("meeting_followup_auto always asks, with its own reason", () => {
    expect(SELF_AUTONOMY_TOOLS.has("meeting_followup_auto")).toBe(true);
    expect(CONTACT_BY_CONSTRUCTION.has("meeting_followup_auto")).toBe(false);
    expect(mustAlwaysAsk("meeting_followup_auto")).toEqual({ ask: true, reason: "changing its own autonomy always asks first" });
    expect(mustAlwaysAskExceptContact("meeting_followup_auto")).toEqual({ ask: true, reason: "changing its own autonomy always asks first" });
  });
  it("meeting_followup_send stays board-decided (its recipients are established by construction)", () => {
    expect(mustAlwaysAsk("meeting_followup_send")).toEqual({ ask: false });
  });
});

// Final review F2: the console shows this for a history-checked contact tool, not the first-contact lock.
it("the history-checked reason the console shows", () => {
  expect(RECIPIENT_CHECK_REASON).toBe("asks for anyone you haven't written to");
});

describe("mustAlwaysAskExceptContact (fix round 1, I8)", () => {
  it("still locks money/delete/publish categories, same as mustAlwaysAsk", () => {
    expect(mustAlwaysAskExceptContact("calendar_delete_event")).toEqual({ ask: true, reason: "deleting data always asks first" });
    expect(mustAlwaysAskExceptContact("agent-kit__vault_drop")).toEqual({ ask: true, reason: "deleting data always asks first" });
  });
  it("does NOT lock a pure-contact tool — the caller decides that per recipient instead", () => {
    expect(mustAlwaysAskExceptContact("gmail_send")).toEqual({ ask: false });
    expect(mustAlwaysAskExceptContact("calendar_create_event")).toEqual({ ask: false });
  });
  it("an unknown tool still fails closed", () => {
    expect(mustAlwaysAskExceptContact("no_such_tool")).toEqual({ ask: true, reason: "unknown tool — asking first" });
  });
  it("every RECIPIENTS_OF tool is contact-only today — the invariant I8's skip-only-contact fix relies on", () => {
    for (const tool of Object.keys(RECIPIENTS_OF)) {
      expect(TOOL_CATEGORIES[tool]).toEqual(["contact"]);
    }
  });
});

describe("RECIPIENTS_OF", () => {
  describe("gmail_send", () => {
    it("normalises 'Name <addr>' to a lowercase bare address", () => {
      expect(RECIPIENTS_OF["gmail_send"]!({ to: ["Name <PERSON@EXAMPLE.COM>"] })).toEqual(["person@example.com"]);
    });
    it("accepts a bare address with no display name", () => {
      expect(RECIPIENTS_OF["gmail_send"]!({ to: ["person@example.com"] })).toEqual(["person@example.com"]);
    });
    it("returns null for a garbage entry", () => {
      expect(RECIPIENTS_OF["gmail_send"]!({ to: ["not-an-email"] })).toBeNull();
    });
    it("returns null when `to` is missing", () => {
      expect(RECIPIENTS_OF["gmail_send"]!({})).toBeNull();
    });
    it("returns null when `to` is not an array", () => {
      expect(RECIPIENTS_OF["gmail_send"]!({ to: "person@example.com" })).toBeNull();
    });
    it("returns null for non-object input (fix round 1, I3) — never treats an unreadable call as empty", () => {
      expect(RECIPIENTS_OF["gmail_send"]!(undefined)).toBeNull();
      expect(RECIPIENTS_OF["gmail_send"]!(null)).toBeNull();
      expect(RECIPIENTS_OF["gmail_send"]!("not an object")).toBeNull();
      expect(RECIPIENTS_OF["gmail_send"]!(["array", "not", "object"])).toBeNull();
    });
    it("dedupes recipients, case-insensitively", () => {
      expect(RECIPIENTS_OF["gmail_send"]!({ to: ["person@example.com", "PERSON@EXAMPLE.COM"] })).toEqual(["person@example.com"]);
    });

    // Fix round 1, C1: one `to` entry can no longer hide a second recipient or inject a header.
    describe("C1 — strict single-address parsing", () => {
      it("rejects a second display-named address hidden after the first", () => {
        expect(RECIPIENTS_OF["gmail_send"]!({ to: ["Alice <alice@example.com>, Bob <bob@evil.example>"] })).toBeNull();
      });
      it("rejects a bare address followed by a second display-named address", () => {
        expect(RECIPIENTS_OF["gmail_send"]!({ to: ["bob@evil.example, <alice@example.com>"] })).toBeNull();
      });
      it("rejects a CR/LF header-injection attempt", () => {
        expect(RECIPIENTS_OF["gmail_send"]!({ to: ["<alice@example.com>\r\nBcc: bob@evil.example"] })).toBeNull();
      });
      it("rejects CR/LF anywhere in an entry, even a plausible-looking bare address", () => {
        expect(RECIPIENTS_OF["gmail_send"]!({ to: ["alice@example.com\r\n"] })).toBeNull();
        expect(RECIPIENTS_OF["gmail_send"]!({ to: ["alice@example.com\n"] })).toBeNull();
      });
      it("rejects a display name containing an angle bracket, quote, or @ outside the address", () => {
        expect(RECIPIENTS_OF["gmail_send"]!({ to: ['"Alice" <alice@example.com>'] })).toBeNull();
        expect(RECIPIENTS_OF["gmail_send"]!({ to: ["alice@example.com <alice@example.com>"] })).toBeNull();
      });
      it("rejects trailing junk after the closing '>'", () => {
        expect(RECIPIENTS_OF["gmail_send"]!({ to: ["Alice <alice@example.com> trailing"] })).toBeNull();
      });
      it("still accepts an ordinary display name with no dangerous characters", () => {
        expect(RECIPIENTS_OF["gmail_send"]!({ to: ["Alice B. Example <alice@example.com>"] })).toEqual(["alice@example.com"]);
      });
    });

    // Fix round 2, item 2b: a clean `to` is not enough — a header-bound field of the call can
    // smuggle a header-injected Bcc once google.ts's buildMimeEnvelope assembles the raw
    // message (e.g. subject: "Hi\r\nBcc: stranger@evil.example"), reaching someone this check
    // never saw. This is a belt-and-suspenders check alongside google.ts's own guard: the
    // engine layer has no idea buildMimeEnvelope exists, so it refuses on the raw input alone.
    // Free-form CONTENT fields (bodyText, signatureText, signatureHtml) are exempt — a normal
    // multi-paragraph email legitimately contains newlines in its body, and rejecting every one
    // of those would defeat the whole point of a history-checked autonomous send.
    describe("item 2b — CR/LF in a header-bound field locks, not just in `to`", () => {
      it("rejects when subject carries a CR/LF header-injection attempt, even with a clean `to`", () => {
        expect(RECIPIENTS_OF["gmail_send"]!({
          to: ["alice@example.com"], subject: "Hi\r\nBcc: stranger@evil.example",
        })).toBeNull();
      });
      it("rejects when from, inReplyTo, references, threadId, or account carries CR/LF", () => {
        const base = { to: ["alice@example.com"], subject: "Hi", bodyText: "hello" };
        expect(RECIPIENTS_OF["gmail_send"]!({ ...base, from: "me@example.com\r\nBcc: x@evil.example" })).toBeNull();
        expect(RECIPIENTS_OF["gmail_send"]!({ ...base, inReplyTo: "<id>\r\nBcc: x@evil.example" })).toBeNull();
        expect(RECIPIENTS_OF["gmail_send"]!({ ...base, references: "<id>\r\nBcc: x@evil.example" })).toBeNull();
        expect(RECIPIENTS_OF["gmail_send"]!({ ...base, threadId: "abc\r\nBcc: x@evil.example" })).toBeNull();
        expect(RECIPIENTS_OF["gmail_send"]!({ ...base, account: "me@example.com\nBcc: x@evil.example" })).toBeNull();
      });
      it("does NOT reject CR/LF inside bodyText, signatureText, or signatureHtml — those are free-form content", () => {
        const base = { to: ["alice@example.com"], subject: "Hi" };
        expect(RECIPIENTS_OF["gmail_send"]!({ ...base, bodyText: "line1\r\nline2\nline3" })).toEqual(["alice@example.com"]);
        expect(RECIPIENTS_OF["gmail_send"]!({ ...base, bodyText: "hi", signatureText: "Best,\r\nOwner" })).toEqual(["alice@example.com"]);
        expect(RECIPIENTS_OF["gmail_send"]!({ ...base, bodyText: "hi", signatureHtml: "<p>Best,</p>\r\n<p>Owner</p>" })).toEqual(["alice@example.com"]);
      });
      it("still accepts a completely clean call", () => {
        expect(RECIPIENTS_OF["gmail_send"]!({
          to: ["alice@example.com"], subject: "Hi", bodyText: "hello\nmultiple\nlines is fine in the body",
          from: "me@example.com", account: "me@example.com",
        })).toEqual(["alice@example.com"]);
      });
    });
  });

  describe("calendar_create_event", () => {
    // D-C (controller ruling, fix round 1): notify does NOT decide "contacts nobody" — Google
    // guests still see the event on their own calendars regardless of notify.
    it("checks attendees regardless of notify:false (D-C)", () => {
      expect(RECIPIENTS_OF["calendar_create_event"]!({ attendees: ["person@example.com"], notify: false })).toEqual(["person@example.com"]);
    });
    it("checks attendees when notify is true or omitted, same as notify:false", () => {
      expect(RECIPIENTS_OF["calendar_create_event"]!({ attendees: ["person@example.com"], notify: true })).toEqual(["person@example.com"]);
      expect(RECIPIENTS_OF["calendar_create_event"]!({ attendees: ["person@example.com"] })).toEqual(["person@example.com"]);
    });
    it("only an empty/absent attendees list contacts nobody", () => {
      expect(RECIPIENTS_OF["calendar_create_event"]!({})).toEqual([]);
      expect(RECIPIENTS_OF["calendar_create_event"]!({ notify: false })).toEqual([]);
      expect(RECIPIENTS_OF["calendar_create_event"]!({ attendees: [] })).toEqual([]);
    });
    it("normalises attendees the same way as gmail_send", () => {
      expect(RECIPIENTS_OF["calendar_create_event"]!({ attendees: ["Name <PERSON@EXAMPLE.COM>"] })).toEqual(["person@example.com"]);
    });
    it("returns null for a garbage attendee", () => {
      expect(RECIPIENTS_OF["calendar_create_event"]!({ attendees: ["not-an-email"] })).toBeNull();
    });
    it("returns null for non-object input (fix round 1, I3) — never reads as 'no attendees'", () => {
      expect(RECIPIENTS_OF["calendar_create_event"]!(undefined)).toBeNull();
      expect(RECIPIENTS_OF["calendar_create_event"]!(null)).toBeNull();
    });
  });

  it("calendar_update_event has no entry — it always asks", () => {
    expect(RECIPIENTS_OF["calendar_update_event"]).toBeUndefined();
  });
});
