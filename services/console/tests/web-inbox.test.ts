import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), verify: vi.fn() }));
vi.mock("../lib/db", () => ({ pool: { query: mocks.query } }));
vi.mock("../lib/auth", () => ({ verify: mocks.verify }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => ({ value: "c" }) })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getInboxMessage, markInboxRead, readInbox, replySeed, unreadCount } from "../lib/web-inbox";
import { GET } from "../app/api/inbox/route";
import { markRead } from "../app/actions/inbox";
import { fallbackNotes } from "../lib/delivery-notes";

const row = (id: number, read = false) => ({
  id: String(id), agent: "chief", kind: "morning-brief", title: "Morning brief", body: "Line one\nLine two",
  context: null, created_at: new Date("2026-10-17T06:00:00Z"), read_at: read ? new Date("2026-10-17T07:00:00Z") : null,
});

beforeEach(() => {
  mocks.query.mockReset();
  mocks.verify.mockReset();
  mocks.verify.mockResolvedValue("owner@owner.example");
});

describe("reading the inbox", () => {
  it("returns this owner's unread messages for one agent, newest first, with the earlier few", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [row(2), row(1)] }).mockResolvedValueOnce({ rows: [row(0, true)] });
    const { unread, earlier } = await readInbox("chief", { earlier: 5 });
    expect(unread.map((m) => m.id)).toEqual([2, 1]);
    expect(earlier[0]).toMatchObject({ id: 0, read: true });
    expect(mocks.query.mock.calls[0]![1]).toEqual(["owner-1", "chief"]);
    expect(String(mocks.query.mock.calls[0]![0])).toMatch(/read_at IS NULL/);
  });

  it("answers 'nothing' when the table is not there yet (migration not applied)", async () => {
    mocks.query.mockRejectedValue(Object.assign(new Error("no table"), { code: "42P01" }));
    expect(await readInbox("chief")).toEqual({ unread: [], earlier: [] });
    expect(await unreadCount()).toBe(0);
    expect(await getInboxMessage("chief", 3)).toBeNull();
  });

  it("refuses a message id that is not a positive whole number without asking the database", async () => {
    expect(await getInboxMessage("chief", 0)).toBeNull();
    expect(await getInboxMessage("chief", Number("abc"))).toBeNull();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("marks only this owner's and this agent's rows", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await markInboxRead("chief", 4);
    expect(mocks.query.mock.calls[0]![1]).toEqual(["owner-1", "chief", 4]);
    await markInboxRead("chief");
    expect(mocks.query.mock.calls[1]![1]).toEqual(["owner-1", "chief"]);
  });
});

describe("what Reply starts a chat with", () => {
  it("quotes the message when it is just something to read", () => {
    expect(replySeed({ title: "Morning brief", body: "Line one\nLine two", context: null })).toBe(
      'About your message "Morning brief":\n\n> Line one\n> Line two\n\n',
    );
  });
  it("uses the instruction when the message asks the agent to act", () => {
    expect(replySeed({ title: "Proposal", body: "Read me", context: "[scheduled check] Call the tool" })).toBe("[scheduled check] Call the tool");
  });
});

describe("GET /api/inbox", () => {
  const get = (qs = "") => GET(new Request(`http://console.test/api/inbox${qs}`));

  it("needs a signed-in owner", async () => {
    mocks.verify.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
  });

  it("without an agent: the unread count across agents (the navigation dot)", async () => {
    mocks.query.mockResolvedValue({ rows: [{ n: 3 }] });
    expect(await (await get()).json()).toEqual({ unread: 3 });
  });

  it("with an agent: its unread messages", async () => {
    mocks.query.mockResolvedValue({ rows: [row(5)] });
    const body = await (await get("?agent=chief")).json();
    expect(body.unread).toBe(1);
    expect(body.messages[0]).toMatchObject({ id: 5, title: "Morning brief", read: false });
  });

  it("refuses an agent name that is not one", async () => {
    expect((await get("?agent=../x")).status).toBe(400);
  });
});

describe("markRead", () => {
  it("needs a session, and refuses a bad agent or id without a write", async () => {
    mocks.verify.mockResolvedValue(null);
    await expect(markRead({ agent: "chief" })).rejects.toThrow("unauthenticated");
    mocks.verify.mockResolvedValue("owner@owner.example");
    expect(await markRead({ agent: "Not A Name" })).toEqual({ ok: false });
    expect(await markRead({ agent: "chief", id: 1.5 })).toEqual({ ok: false });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("the fallback sentence on the grid", () => {
  it("is the note on a kind's LATEST sent message, and gone once the latest one went where asked", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        { item_key: "morning-brief/2026-10-17T08", fallback_note: "Morning brief went to web chat: Telegram is not connected" },
        { item_key: "morning-brief/2026-10-16T08", fallback_note: "Morning brief went to web chat: Telegram is not connected" },
        { item_key: "deadline/d1#1", fallback_note: null },
        { item_key: "reminder/r1", fallback_note: "Reminder went to web chat: Telegram could not be reached" },
        { item_key: "deadline/d1#0", fallback_note: "an older note" },
      ],
    });
    expect(await fallbackNotes("chief")).toEqual({
      "morning-brief": "Morning brief went to web chat: Telegram is not connected",
      reminders: "Reminder went to web chat: Telegram could not be reached",
    });
  });

  it("is empty when the ledger has no such column yet", async () => {
    mocks.query.mockRejectedValue(Object.assign(new Error("no column"), { code: "42703" }));
    expect(await fallbackNotes("chief")).toEqual({});
  });
});
