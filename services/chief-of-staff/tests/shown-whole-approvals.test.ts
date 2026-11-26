// THE OWNER'S RULE D-6, for every gated tool on every door: an approval answered on a chat door does not run unless the card's
// record says the request was shown in full there. A cut card, a card whose record cannot say, a card with no record row and an
// unreadable record all fail with the same one sentence and nothing runs. The console's Waiting page shows the whole request,
// so an answer given there still runs; a call that raised no card is not affected.
// The record is a stand-in here (`rows`); the real table is covered with a database in packages/agent-kit/tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const record = vi.hoisted(() => ({ rows: new Map<string, { shown_whole: boolean | null }>(), fail: false, reads: 0 }));
vi.mock("@lares/agent-kit/db", async (original) => ({
  ...(await original<typeof import("@lares/agent-kit/db")>()),
  getPool: () => ({ query: async (sql: string, values: unknown[]) => {
    if (!sql.startsWith("SELECT shown_whole")) throw new Error(`unexpected read: ${sql}`);
    record.reads++;
    if (record.fail) throw new Error("database unavailable");
    const row = record.rows.get(values[0] as string);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  } }),
}));
vi.mock("@lares/agent-kit/approval-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lares/agent-kit/approval-ledger")>()),
  approvalLedger: () => ({ ask: async () => null, settle: async () => undefined, markUsed: async () => ({ useCount: 1 }) }),
}));

import { APPROVAL_NOT_SHOWN_WHOLE_SENTENCE } from "@lares/agent-kit/approval-reply-sentence";
import { DOORS, claimEnvNames } from "@lares/agent-kit/door-kinds";
import { assertApproval, guardCatalogueExecution } from "../lib/approvals.js";

const INCARNATION = "11111111-1111-4111-8111-111111111111";
const OWNER = "U0OWNER";
// A note, a mail send and a calendar change: three gated tools with three different bodies.
const TOOLS: Array<[string, unknown]> = [
  ["echo_note", { note: "hello" }],
  ["gmail_send", { to: ["a@example.invalid"], subject: "Hi", body: "Hello" }],
  ["calendar_create_event", { title: "Lunch", start: "2026-12-01T12:00:00Z", end: "2026-12-01T13:00:00Z" }],
];
const PRIVATE: Record<string, Record<string, unknown>> = { slack: { channel_id: "D0DIRECT", author_type: "user" }, telegram: { chat_type: "private" } };
const kinds = [...new Set(Object.values(DOORS).map((row) => row.door))];
const person = (door: string) => ({ authenticator: Object.entries(DOORS).find(([, row]) => row.door === door)![0], principalType: "user", attributes: { user_id: OWNER, ...PRIVATE[door]! } });
const answered = (door: string, responder: unknown = person(door)) => ({ callId: "call-1", session: { id: "s1", auth: { current: person(door), initiator: person(door) } }, approval: { responder } });

beforeEach(() => {
  record.rows.clear(); record.fail = false; record.reads = 0;
  vi.stubEnv("LARES_AGENT_NAME", "helper"); vi.stubEnv("LARES_AGENT_INCARNATION", INCARNATION);
  for (const door of kinds) { vi.stubEnv(claimEnvNames(door).principal, OWNER); vi.stubEnv(claimEnvNames(door).revision, "5c1ac4e0-0000-4000-8000-000000000001"); }
});
afterEach(() => { vi.unstubAllEnvs(); });

it("has a stand-in identity for every door in the table, so a new door cannot skip this rule", () => {
  expect(kinds.sort()).toEqual(Object.keys(PRIVATE).sort());
});

for (const door of kinds) {
  for (const [tool, input] of TOOLS) {
    describe(`${door} · ${tool}`, () => {
      const run = (ctx: unknown) => guardCatalogueExecution(ctx, tool, input);

      it("runs when the card's record says the request was shown in full", async () => {
        record.rows.set("call-1", { shown_whole: true });
        await expect(run(answered(door))).resolves.toBeUndefined();
        await expect(assertApproval(answered(door) as never, tool, input)).resolves.toBeUndefined();
      });

      it("does not run when the card was cut, when the record cannot say, when there is no record row, or when the record cannot be read", async () => {
        for (const setup of [() => record.rows.set("call-1", { shown_whole: false }), () => record.rows.set("call-1", { shown_whole: null }),
          () => undefined, () => { record.fail = true; }]) {
          record.rows.clear(); record.fail = false; setup();
          await expect(run(answered(door))).rejects.toThrow(APPROVAL_NOT_SHOWN_WHOLE_SENTENCE);
          await expect(assertApproval(answered(door) as never, tool, input)).rejects.toThrow(APPROVAL_NOT_SHOWN_WHOLE_SENTENCE);
        }
      });

      it("still runs for an answer given in the console, which shows the request whole, and for a call that raised no card", async () => {
        const consoleAnswer = { authenticator: "lares-console", principalId: "member-owner", principalType: "user", attributes: { user_id: "member-owner" } };
        await expect(run(answered(door, consoleAnswer))).resolves.toBeUndefined();
        const { approval: _none, ...noCard } = answered(door);
        const before = record.reads;
        await expect(run(noCard)).resolves.toBeUndefined();
        expect(record.reads).toBe(before);
      });
    });
  }
}

it("says one true sentence: it names what was not done and where the request can be read whole", () => {
  expect(APPROVAL_NOT_SHOWN_WHOLE_SENTENCE).toMatch(/nothing was done/);
  expect(APPROVAL_NOT_SHOWN_WHOLE_SENTENCE).toMatch(/Reviews page in the console/);
  expect(APPROVAL_NOT_SHOWN_WHOLE_SENTENCE).not.toMatch(/short|cut/i);
});
