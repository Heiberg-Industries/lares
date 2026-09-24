import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * ORB-193 final review — `remind_set`'s confirmation speaks the OWNER's clock.
 *
 * The turn's own clock block already does (`agent/instructions/clock.ts` passes `ownerTz()`), so a
 * `dueAtLocal` hard-coded to Europe/Oslo meant Saga told him "Tuesday 21:00 (Europe/Oslo)" about a
 * reminder his own phone would ring at 15:00 in New York — the same instant on two clocks inside one
 * exchange, which is the ORB-124/128/204 class this whole clock exists to close.
 *
 * The RECURRENCE deliberately stays on the home clock: `lib/recurrence.ts` computes every later
 * firing in Oslo wall-clock time and the tool's own description says so. Asserted here so the
 * asymmetry reads as a decision rather than as a miss.
 *
 * Its own file, not `remind-set-clock.test.ts`: that file's third case proves the 90-second grace by
 * reaching a real DB error, and mocking the store away here would silently defeat it.
 */
const createReminder = vi.fn(async () => ({ id: "r-1" }));
const ownerTz = vi.fn(async () => "America/New_York");

vi.mock("../lib/reminders-store.js", () => ({ createReminder }));
vi.mock("../lib/owner-clock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/owner-clock.js")>()),
  ownerTz,
}));
vi.mock("@lares/agent-kit/db", () => ({ getPool: () => ({ query: async () => ({ rows: [] }) }) }));

const BENDIK = "U_EXAMPLE_OWNER";
const slackAuth = { authenticator: "slack-webhook", attributes: { user_id: BENDIK } };

function ctx(auth: unknown) {
  return { session: { id: "wrun_test", auth: { current: auth, initiator: auth } } } as never;
}

beforeEach(() => {
  process.env["SLACK_ALLOWED_USER_IDS"] = BENDIK;
  createReminder.mockClear();
  ownerTz.mockClear();
});

afterEach(() => {
  delete process.env["SLACK_ALLOWED_USER_IDS"];
});

/** 2026-09-01 08:00 UTC = 10:00 Oslo = 04:00 New York. */
const DUE = "2026-09-01T08:00:00Z";

describe("remind_set: dueAtLocal is on the owner's clock", () => {
  it("renders the stored instant in the owner's zone, naming it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
    const { default: remindSet } = await import("../catalogue/remind_set.js");

    const result = await remindSet.execute({ message: "Ring tannlegen", dueAt: DUE, door: "slack" }, ctx(slackAuth));

    expect(ownerTz).toHaveBeenCalled();
    expect(result.dueAtLocal).toBe("Tuesday 2026-09-01 04:00 (America/New_York)");
    // The machine-readable field is untouched: the instant is the same, only its rendering moved.
    expect(result.dueAt).toBe(new Date(DUE).toISOString());
    vi.useRealTimers();
  });

  it("falls back to the home clock when the owner clock resolves to it", async () => {
    ownerTz.mockResolvedValueOnce("Europe/Oslo");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
    const { default: remindSet } = await import("../catalogue/remind_set.js");

    const result = await remindSet.execute({ message: "Ring tannlegen", dueAt: DUE, door: "slack" }, ctx(slackAuth));

    expect(result.dueAtLocal).toBe("Tuesday 2026-09-01 10:00 (Europe/Oslo)");
    vi.useRealTimers();
  });

  it("the RECURRENCE is still stated in Oslo wall-clock time — deliberately, and it is stored verbatim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
    const { default: remindSet } = await import("../catalogue/remind_set.js");

    const result = await remindSet.execute(
      { message: "Ring tannlegen", dueAt: DUE, recurrence: "daily:07:00", door: "slack" },
      ctx(slackAuth),
    );

    expect(result.recurrence).toBe("daily:07:00");
    expect(createReminder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ recurrence: "daily:07:00" }));
    expect(remindSet.description).toContain("Europe/Oslo");
    vi.useRealTimers();
  });
});
