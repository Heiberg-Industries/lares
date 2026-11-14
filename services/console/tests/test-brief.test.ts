import { describe, it, expect, vi, beforeEach } from "vitest";
import { TEST_BRIEF_WORKFLOW_TYPE } from "@lares/agent-kit/delivery";

/**
 * "Send a test brief now", the console's half: who may press it, every refusal sentence, the one
 * guarded insert, and the status line the page shows. The insert's SQL also runs against the real
 * schema, together with the agent's claim, in services/chief-of-staff/tests/test-brief-store.test.ts.
 */

const mocks = vi.hoisted(() => ({
  verify: vi.fn(async (): Promise<string | null> => "owner@owner.example"),
  keeper: vi.fn(),
  ownerOnly: true,
  insertRow: { id: "r1", busy: false, recent: 0 } as { id: string | null; busy: boolean; recent: number },
  dnd: false,
  latest: null as Record<string, unknown> | null,
  statements: [] as string[],
}));

const client = {
  query: vi.fn(async (sql: string, _values?: unknown[]) => {
    mocks.statements.push(sql);
    if (/INSERT INTO workflow_jobs/.test(sql)) return { rows: [mocks.insertRow] };
    return { rows: [] };
  }),
  release: vi.fn(),
};
vi.mock("../lib/db", () => ({
  pool: {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string) => {
      mocks.statements.push(sql);
      if (/FROM agent_access a/.test(sql)) return { rows: mocks.ownerOnly ? [{ "?column?": 1 }] : [] };
      if (/FROM proactivity_settings/.test(sql)) return { rows: mocks.dnd ? [{ agent: "*", door: "*", dnd: true }] : [] };
      if (/FROM workflow_jobs/.test(sql)) return { rows: mocks.latest ? [mocks.latest] : [] };
      return { rows: [] };
    }),
  },
}));
vi.mock("../lib/auth", () => ({ verify: mocks.verify }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => ({ value: "c" }) })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/keeper-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/keeper-client")>()),
  keeper: mocks.keeper,
}));

import { sendTestBrief, testBriefStatus } from "../app/actions/delivery";
import {
  ASKED, NOT_PICKED_UP, OUTCOME_UNKNOWN, TEST_BRIEF_REFUSALS, testBriefRefusal, testBriefView, type TestBriefFacts,
} from "../lib/test-brief";

const CONNECTED = { kind: "telegram", enabled: true, configured: true, claimed: true, pending: false, applied: true };
function keeperAnswers(o: { definition?: Record<string, unknown>; runtime?: Record<string, unknown>; doors?: unknown[] } = {}) {
  mocks.keeper.mockImplementation(async (action: string) => {
    if (action === "definition.get") {
      return {
        definition: JSON.stringify({ name: "chief", role: "chief-of-staff", schedules: {}, ...o.definition }),
        runtime: { pending: false, running: true, ...o.runtime },
      };
    }
    if (action === "door.status") return o.doors ?? [CONNECTED, { kind: "slack", enabled: false, claimed: false, pending: false, applied: false }];
    throw new Error(`unexpected ${action}`);
  });
}

beforeEach(() => {
  mocks.verify.mockClear();
  mocks.verify.mockImplementation(async () => "owner@owner.example");
  mocks.keeper.mockReset();
  mocks.ownerOnly = true;
  mocks.insertRow = { id: "r1", busy: false, recent: 0 };
  mocks.dnd = false;
  mocks.latest = null;
  mocks.statements.length = 0;
  client.query.mockClear();
  keeperAnswers();
});

const inserted = () => mocks.statements.some((s) => /INSERT INTO workflow_jobs/.test(s));

describe("who may press it", () => {
  it("anyone but the console owner is refused before anything is read or written", async () => {
    mocks.verify.mockImplementation(async () => null);
    await expect(sendTestBrief({ name: "chief", door: "telegram" })).rejects.toThrow("unauthenticated");
    await expect(testBriefStatus("chief")).rejects.toThrow("unauthenticated");
    expect(mocks.keeper).not.toHaveBeenCalled();
    expect(mocks.statements).toEqual([]);
  });

  it("web chat, or an unknown door, is never asked for", async () => {
    for (const door of ["web", "email", ""]) {
      expect(await sendTestBrief({ name: "chief", door })).toEqual({ ok: false, message: TEST_BRIEF_REFUSALS.unavailable });
    }
    expect(inserted()).toBe(false);
  });
});

describe("each refusal is a plain sentence, and nothing is written", () => {
  const cases: Array<[string, Parameters<typeof keeperAnswers>[0], string, (() => void)?]> = [
    ["not a chief of staff", { definition: { role: "creative" } }, TEST_BRIEF_REFUSALS.notChief],
    ["not running", { runtime: { running: false } }, TEST_BRIEF_REFUSALS.notRunning],
    ["changes waiting for Apply", { runtime: { pending: true } }, TEST_BRIEF_REFUSALS.notRunning],
    ["door not claimed", { doors: [{ ...CONNECTED, claimed: false }] }, "Telegram is not connected to this agent yet."],
    ["door not applied", { doors: [{ ...CONNECTED, pending: true, pending_reason: "Apply" }] }, "Telegram is not connected to this agent yet."],
    ["door missing", { doors: [] }, "Telegram is not connected to this agent yet."],
    ["shared with someone else", {}, TEST_BRIEF_REFUSALS.shared, () => { mocks.ownerOnly = false; }],
    ["morning brief off", { definition: { schedules: { "morning-brief": { on: false } } } }, TEST_BRIEF_REFUSALS.briefOff],
  ];
  for (const [label, answers, sentence, setup] of cases) {
    it(label, async () => {
      keeperAnswers(answers);
      setup?.();
      expect(await sendTestBrief({ name: "chief", door: "telegram" })).toEqual({ ok: false, message: sentence });
      expect(inserted()).toBe(false);
    });
  }

  it("the shared check reads the one owner-only condition, without a lock", async () => {
    await sendTestBrief({ name: "chief", door: "telegram" });
    const read = mocks.statements.find((s) => /FROM agent_access a/.test(s))!;
    const { ownerOnlyAgentStatement } = await import("@lares/agent-kit/owner-only-agent");
    expect(read).toBe(ownerOnlyAgentStatement("none"));
  });

  it("the keeper being unreachable is a sentence too", async () => {
    mocks.keeper.mockRejectedValue(new Error("down"));
    expect(await sendTestBrief({ name: "chief", door: "telegram" })).toEqual({ ok: false, message: TEST_BRIEF_REFUSALS.unavailable });
  });

  it("refusals come in the order the owner can fix them", () => {
    const all: TestBriefFacts = { role: "creative", running: false, pending: true, morningBriefOn: false, doorConnected: false, ownerOnly: false };
    expect(testBriefRefusal("slack", all)).toBe(TEST_BRIEF_REFUSALS.notChief);
    expect(testBriefRefusal("slack", { ...all, role: "chief-of-staff" })).toBe(TEST_BRIEF_REFUSALS.notRunning);
    expect(testBriefRefusal("slack", { ...all, role: "chief-of-staff", running: true, pending: false })).toBe("Slack is not connected to this agent yet.");
  });
});

describe("the one guarded insert", () => {
  it("asks: one request row for this agent, from the owner, naming the door", async () => {
    expect(await sendTestBrief({ name: "chief", door: "telegram" })).toEqual({ ok: true, message: ASKED });
    const insert = client.query.mock.calls.find((c) => /INSERT INTO workflow_jobs/.test(c[0] as string))!;
    expect(insert[1]).toEqual(["chief", "owner-1", TEST_BRIEF_WORKFLOW_TYPE, JSON.stringify({ kind: "morning-brief", door: "telegram" }), 10, 10]);
    expect((insert[0] as string)).toMatch(/NOT seen\.busy AND seen\.recent < \$6/);
    const order = client.query.mock.calls.map((c) => String(c[0]).split(/\s/)[0]);
    expect(order).toEqual(["BEGIN", "SELECT", "WITH", "COMMIT"]); // the per-agent lock, then the one insert
  });

  it("a test already on its way", async () => {
    mocks.insertRow = { id: null, busy: true, recent: 1 };
    expect(await sendTestBrief({ name: "chief", door: "telegram" })).toEqual({ ok: false, message: TEST_BRIEF_REFUSALS.busy });
  });

  it("ten in a day", async () => {
    mocks.insertRow = { id: null, busy: false, recent: 10 };
    expect(await sendTestBrief({ name: "chief", door: "telegram" })).toEqual({ ok: false, message: TEST_BRIEF_REFUSALS.tooMany });
  });
});

describe("what the page shows", () => {
  const now = new Date("2026-09-16T08:42:30Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  const row = (o: Record<string, unknown>) => ({ status: "pending", door: "telegram", result: null, createdAt: ago(1), updatedAt: ago(1), ...o }) as Parameters<typeof testBriefView>[0];

  it("asked, then picked up, then sent at the owner's time", () => {
    expect(testBriefView(row({}), now, "Europe/Berlin")).toEqual({ door: "telegram", waiting: true, text: ASKED });
    expect(testBriefView(row({ status: "running" }), now, "Europe/Berlin")).toEqual({ door: "telegram", waiting: true, text: ASKED });
    expect(testBriefView(row({ status: "done", result: { outcome: "sent", sentAt: "2026-09-16T08:42:05Z" } }), now, "Europe/Berlin"))
      .toEqual({ door: "telegram", waiting: false, text: "Sent to Telegram at 10:42." });
  });

  it("not picked up after five minutes; outcome unknown after ten minutes claimed", () => {
    expect(testBriefView(row({ createdAt: ago(6) }), now, "UTC")?.text).toBe(NOT_PICKED_UP);
    expect(testBriefView(row({ createdAt: ago(11) }), now, "UTC")).toMatchObject({ waiting: false, text: NOT_PICKED_UP });
    expect(testBriefView(row({ status: "running", updatedAt: ago(11) }), now, "UTC")).toEqual({ door: "telegram", waiting: false, text: OUTCOME_UNKNOWN });
  });

  it("each outcome the agent writes has its sentence", () => {
    const failed = (outcome: string) => testBriefView(row({ status: "failed", result: { outcome } }), now, "UTC")?.text;
    expect(failed("door-not-connected")).toBe("Not sent: Telegram is not connected to this agent yet.");
    expect(failed("too-slow")).toBe("Not sent: the brief took too long to write, so nothing was sent. Try again.");
    expect(failed("send-failed")).toBe("Not sent: Telegram did not accept it. Check the door above and try again.");
    expect(failed("pass-failed")).toBe("Not sent: something went wrong before it was sent. The agent's log says more.");
    expect(failed("send-unknown")).toBe(OUTCOME_UNKNOWN);
  });

  it("nothing asked yet shows nothing; do-not-disturb is reported", async () => {
    expect(await testBriefStatus("chief")).toEqual({ view: null, dnd: false });
    mocks.dnd = true;
    mocks.latest = { status: "pending", state: { door: "slack" }, result: null, created_at: new Date(), updated_at: new Date() };
    expect(await testBriefStatus("chief")).toEqual({ view: { door: "slack", waiting: true, text: ASKED }, dnd: true });
  });
});
