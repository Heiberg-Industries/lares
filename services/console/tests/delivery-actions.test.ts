import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  keeper: vi.fn(),
  inputs: vi.fn(),
  queries: [] as Array<{ sql: string; params: unknown[] }>,
}));

vi.mock("../lib/db", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      mocks.queries.push({ sql, params });
      if (/FROM initiations/i.test(sql)) return { rows: [{ door: "telegram:123" }, { door: "slack:U1" }] };
      return { rows: [] };
    }),
  },
}));
vi.mock("../lib/auth", () => ({ verify: vi.fn(async () => "owner@owner.example") }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => ({ value: "c" }) })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/keeper-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/keeper-client")>()),
  keeper: mocks.keeper,
}));
// The data the check reads (agents, their definitions, hours, quiet windows) is gathered by one
// function; the check's own logic stays real.
vi.mock("../lib/delivery-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/delivery-check")>()),
  loadConflictInputs: mocks.inputs,
}));

import { saveDelivery } from "../app/actions/delivery";
import { saveQuietHours, saveScheduleHours } from "../app/actions/proactivity";

const DOORS = [{ kind: "telegram", enabled: true, settings: {} }, { kind: "slack", enabled: true, settings: {} }];
const stored = (extra: Record<string, unknown> = {}) => ({
  definition: JSON.stringify({ name: "chief", role: "chief-of-staff", doors: DOORS, channels: ["telegram", "slack"], ...extra }),
  duties: "duties", voice: "voice",
});
const data = (over: Record<string, unknown> = {}) => ({
  facts: [{ agent: "chief", delivery: undefined, doors: DOORS.map((d) => ({ kind: d.kind, enabled: d.enabled })) }],
  hours: { "morning-brief": [8], "evening-brief": [20], digest: [9, 17], "track-routing": [9, 13, 17], "weekly-summary": [9] },
  rows: [],
  knownDoors: ["telegram:123", "slack:U1", "web:inbox"],
  ...over,
});
const writes = (re: RegExp) => mocks.queries.filter((q) => re.test(q.sql));

beforeEach(() => {
  mocks.queries.length = 0;
  mocks.keeper.mockReset();
  mocks.inputs.mockReset();
  mocks.inputs.mockResolvedValue(data());
  mocks.keeper.mockImplementation(async (action: string) => (action === "definition.get" ? stored() : { hash: "h" }));
});

describe("saveDelivery", () => {
  it("saves the map into the definition through the keeper, leaving everything else as it was", async () => {
    const delivery = { "morning-brief": ["slack", "web"], digest: ["web"] };
    expect(await saveDelivery({ name: "chief", delivery })).toEqual({ ok: true });
    const save = mocks.keeper.mock.calls.find((c) => c[0] === "definition.save")!;
    expect(save[1]).toMatchObject({ name: "chief", duties: "duties", voice: "voice" });
    expect((save[1] as { definition: Record<string, unknown> }).definition).toMatchObject({
      name: "chief", role: "chief-of-staff", channels: ["telegram", "slack"], delivery,
    });
    expect(save[2]).toBe("owner@owner.example");
  });

  it("refuses an unknown kind or door with a plain sentence, before the keeper is asked anything", async () => {
    const r = await saveDelivery({ name: "chief", delivery: { nonsense: ["web"], digest: ["sms"] } });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/"nonsense" is not a kind.*"sms", which is not a door/) });
    expect(mocks.keeper).not.toHaveBeenCalled();
  });

  it("refuses a brief hour inside the quiet window of the door it would now go to, and saves nothing", async () => {
    mocks.inputs.mockResolvedValue(data({ hours: { "morning-brief": [6], digest: [9, 17] } }));
    const r = await saveDelivery({ name: "chief", delivery: { "morning-brief": ["slack", "web"] } });
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("Morning brief is set for 06:00, but it goes to Slack") });
    expect(mocks.keeper.mock.calls.some((c) => c[0] === "definition.save")).toBe(false);
  });

  it("does not let an old clash on a kind the owner did not touch block an unrelated change", async () => {
    // the morning brief already clashes (06:00 to Telegram) and keeps going to Telegram; only the digest moves
    mocks.inputs.mockResolvedValue(data({ hours: { "morning-brief": [6], digest: [9, 17] } }));
    expect(await saveDelivery({ name: "chief", delivery: { digest: ["web"] } })).toEqual({ ok: true });
  });

  it("moving the brief to a door where the hour is allowed is fine", async () => {
    mocks.inputs.mockResolvedValue(data({
      hours: { "morning-brief": [6] },
      rows: [{ agent: "*", door: "web:inbox", quietStart: "22:00", quietEnd: "06:00" }],
    }));
    expect(await saveDelivery({ name: "chief", delivery: { "morning-brief": ["web"] } })).toEqual({ ok: true });
  });

  it("saves anyway when the check cannot read what it needs (it never blocks on its own blindness)", async () => {
    mocks.inputs.mockResolvedValue(null);
    expect(await saveDelivery({ name: "chief", delivery: { "morning-brief": ["web"] } })).toEqual({ ok: true });
  });

  it("passes the keeper's own refusal on, in its words", async () => {
    const { KeeperRefusedError } = await import("../lib/keeper-client");
    mocks.keeper.mockImplementation(async (action: string) => {
      if (action === "definition.get") return stored();
      throw new KeeperRefusedError("refused", [{ check: "delivery", message: "digest lists slack twice" }]);
    });
    expect(await saveDelivery({ name: "chief", delivery: { digest: ["slack"] } })).toEqual({ ok: false, message: "digest lists slack twice" });
  });
});

describe("a brief hour that would never be sent (saveScheduleHours)", () => {
  it("is refused with a plain sentence and nothing is written", async () => {
    const r = await saveScheduleHours({ schedule: "morning-brief", hours: [6] });
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/06:00.*Telegram.*21:00 to 07:00.*held back every day/) });
    expect(writes(/INSERT INTO schedule_settings/)).toHaveLength(0);
  });

  it("is saved when the hour is outside the quiet window", async () => {
    expect(await saveScheduleHours({ schedule: "morning-brief", hours: [8] })).toEqual({ ok: true });
    expect(writes(/INSERT INTO schedule_settings/)).toHaveLength(1);
  });

  it("only looks at the schedule being saved", async () => {
    // evening brief at 22:00 clashes, but the morning brief is what is being saved
    mocks.inputs.mockResolvedValue(data({ hours: { "morning-brief": [8], "evening-brief": [22] } }));
    expect(await saveScheduleHours({ schedule: "morning-brief", hours: [8] })).toEqual({ ok: true });
  });
});

describe("quiet hours that would swallow a brief (saveQuietHours)", () => {
  it("is refused when the new window covers the hour a brief goes out to that door", async () => {
    const r = await saveQuietHours({ door: "telegram:123", quietStart: "05:00", quietEnd: "13:00" });
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/Morning brief is set for 08:00.*05:00 to 13:00/) });
    expect(writes(/INSERT INTO proactivity_settings/)).toHaveLength(0);
  });

  it("is saved when the window leaves the brief hours alone", async () => {
    expect(await saveQuietHours({ door: "telegram:123", quietStart: "22:00", quietEnd: "06:00" })).toEqual({ ok: true });
    expect(writes(/INSERT INTO proactivity_settings/)).toHaveLength(1);
  });

  it("a window for another door is not checked against this door's briefs", async () => {
    // the morning brief (08:00) goes to Telegram; the Slack briefs are all in the afternoon
    mocks.inputs.mockResolvedValue(data({ hours: { "morning-brief": [8], digest: [14], "track-routing": [14], "weekly-summary": [14] } }));
    expect(await saveQuietHours({ door: "slack:U1", quietStart: "04:00", quietEnd: "12:00" })).toMatchObject({ ok: true });
  });

  it("the all-doors window is checked against every door", async () => {
    const r = await saveQuietHours({ door: "*", quietStart: "05:00", quietEnd: "13:00" });
    expect(r.ok).toBe(false);
  });
});
