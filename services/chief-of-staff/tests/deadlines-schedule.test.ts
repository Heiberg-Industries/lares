import { describe, it, expect, vi } from "vitest";

import {
  HEARTBEAT_KEY,
  deadlinePrompt,
  makeDeadlineLadderTick,
  rungText,
  type DeadlineLadderDeps,
} from "../agent/schedules/deadlines.js";
import type { DeadlineRow } from "../lib/deadlines-store.js";
import type { InitiationOutcome } from "../lib/initiation.js";
import type { LadderStep } from "@lares/agent-kit/deadlines";

/**
 * ORB-180 Task 5 — the ladder, offline. No pool, no Telegram, no gate: the tick factory takes
 * store, gate and send as deps, so every branch below is exercised with fakes.
 *
 * The clock matters in every case, so it is always explicit: Oslo is UTC+2 in June, and
 * `ladderStep` (kit) keys on the owner-clock day and hour.
 */
const TZ = "Europe/Oslo";
/** 2026-06-17 15:00 Oslo — rung 1's moment for a deadline due 2026-06-18. */
const T_MINUS_ONE_1500 = new Date("2026-06-17T13:00:00Z");
/** 2026-06-18 09:00 Oslo — rung 2's moment for the same deadline. */
const DUE_DAY_0900 = new Date("2026-06-18T07:00:00Z");
/** 2026-06-19 09:00 Oslo — the day after, rung 3's moment. */
const OVERDUE_0900 = new Date("2026-06-19T07:00:00Z");

function deadline(over: Partial<DeadlineRow> = {}): DeadlineRow {
  return {
    id: "d1",
    owner: "bendik",
    entity: "Heiberg Industries AS",
    title: "Aksjonærregisteroppgaven",
    source: "statutory",
    dueDate: "2026-06-18",
    recurrence: "yearly",
    consequence: "Tvangsmulkt fra Skatteetaten løper per dag",
    evidenceRule: "owner confirms",
    status: "open",
    statusReason: null,
    resolvedAt: null,
    rung: 0,
    rungMovedAt: null,
    ruleKey: "aksjonaerregister",
    createdBy: "seed",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    vendor: null,
    amount: null,
    currency: null,
    ...over,
  };
}

const SENT: InitiationOutcome = { verdict: "send", sent: true, alreadySeen: false, handled: true };
const HELD: InitiationOutcome = { verdict: "defer", reason: "dnd-final-stop", sent: false, alreadySeen: false, handled: false };
const ALREADY_SEEN: InitiationOutcome = { verdict: "suppress", reason: "already-seen", sent: false, alreadySeen: true, handled: true };
const DOOR_CEILING: InitiationOutcome = { verdict: "defer", reason: "door-ceiling", sent: false, alreadySeen: false, handled: false };

interface Harness {
  deps: DeadlineLadderDeps;
  asked: Array<Record<string, unknown>>;
  sent: string[];
  advanced: Array<{ id: string; rung: number; now: Date }>;
}

function harness(opts: {
  rows?: DeadlineRow[];
  enabled?: boolean | (() => Promise<boolean>);
  answer?: InitiationOutcome | ((call: number) => InitiationOutcome);
  now?: Date;
  send?: (text: string) => Promise<void>;
  lang?: DeadlineLadderDeps["lang"];
} = {}): Harness {
  const asked: Array<Record<string, unknown>> = [];
  const sent: string[] = [];
  const advanced: Array<{ id: string; rung: number; now: Date }> = [];
  const answer = opts.answer ?? SENT;

  const deps: DeadlineLadderDeps = {
    store: {
      open: async () => opts.rows ?? [deadline()],
      advanceRung: async (id, rung, now) => { advanced.push({ id, rung, now }); },
      ladderEnabled:
        typeof opts.enabled === "function" ? opts.enabled : async () => opts.enabled ?? true,
    },
    gate: async (init, send) => {
      asked.push(init as unknown as Record<string, unknown>);
      const outcome = typeof answer === "function" ? answer(asked.length) : answer;
      if (outcome.sent) await send();
      return outcome;
    },
    send: opts.send ?? (async (text) => { sent.push(text); }),
    clock: () => opts.now ?? T_MINUS_ONE_1500,
    tz: async () => TZ,
    // LAR-68 — every existing case here predates the language setting and expects today's
    // Norwegian wording, so the harness defaults to "nb" rather than making every call site say
    // so; a case that cares about another language passes `lang` explicitly.
    lang: opts.lang ?? "nb",
  };
  return { deps, asked, sent, advanced };
}

describe("HEARTBEAT_KEY", () => {
  it("is the row sql/036 seeds and input-freshness.sh reads", () => {
    expect(HEARTBEAT_KEY).toBe("saga/deadlines");
  });
});

describe("the ladder switch is fail-CLOSED", () => {
  it("OFF: nothing is asked, nothing is sent, and the tick reports `skipped: \"off\"`", async () => {
    const h = harness({ enabled: false });
    expect(await makeDeadlineLadderTick(h.deps).tick()).toEqual({ stepped: 0, held: 0, skipped: "off" });
    expect(h.asked).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.advanced).toEqual([]);
  });

  it("a THROWING switch reads as OFF — a switch we could not read is not a licence to escalate", async () => {
    const h = harness({ enabled: async () => { throw new Error("no such table: deadline_settings"); } });
    expect(await makeDeadlineLadderTick(h.deps).tick()).toEqual({ stepped: 0, held: 0, skipped: "off" });
    expect(h.asked).toEqual([]);
    expect(h.sent).toEqual([]);
  });
});

describe("a due rung goes through the gate and only then moves the row", () => {
  it("rung 1 at T-1 15:00: one escalation, keyed by rung, finalStop false, advanced after `handled`", async () => {
    const h = harness();
    const result = await makeDeadlineLadderTick(h.deps).tick();

    expect(h.asked).toEqual([
      {
        cls: "escalation",
        itemKey: "deadline/d1#1",
        finalStop: false,
        now: T_MINUS_ONE_1500,
        tz: TZ,
      },
    ]);
    expect(h.sent).toEqual([
      "Frist i morgen: Aksjonærregisteroppgaven (Heiberg Industries AS) — Tvangsmulkt fra " +
        "Skatteetaten løper per dag. Si «ferdig» eller «avvis» når den er håndtert.",
    ]);
    expect(h.advanced).toEqual([{ id: "d1", rung: 1, now: T_MINUS_ONE_1500 }]);
    expect(result).toEqual({ stepped: 1, held: 0, skipped: null });
  });

  it("a HOLD leaves the row exactly where it was — the rung is not advanced", async () => {
    const h = harness({ answer: HELD });
    const result = await makeDeadlineLadderTick(h.deps).tick();

    expect(h.asked).toHaveLength(1);
    expect(h.sent).toEqual([]);
    expect(h.advanced).toEqual([]);
    expect(result).toEqual({ stepped: 0, held: 1, skipped: null });
  });

  it("ALREADY SEEN advances the rung without sending again — the bookkeeping that failed, finished", async () => {
    const h = harness({ answer: ALREADY_SEEN });
    const result = await makeDeadlineLadderTick(h.deps).tick();

    expect(h.sent).toEqual([]);
    expect(h.advanced).toEqual([{ id: "d1", rung: 1, now: T_MINUS_ONE_1500 }]);
    expect(result).toEqual({ stepped: 1, held: 0, skipped: null });
  });

  it("rung 3 is the only one that carries finalStop, and it says it is stopping", async () => {
    const h = harness({ rows: [deadline({ rung: 2 })], now: OVERDUE_0900 });
    await makeDeadlineLadderTick(h.deps).tick();

    expect(h.asked).toEqual([
      { cls: "escalation", itemKey: "deadline/d1#3", finalStop: true, now: OVERDUE_0900, tz: TZ },
    ]);
    expect(h.sent[0]).toContain("stopper nå");
    expect(h.advanced).toEqual([{ id: "d1", rung: 3, now: OVERDUE_0900 }]);
  });

  it("rung 2 on the day carries finalStop false", async () => {
    const h = harness({ rows: [deadline({ rung: 1 })], now: DUE_DAY_0900 });
    await makeDeadlineLadderTick(h.deps).tick();

    expect(h.asked).toEqual([
      { cls: "escalation", itemKey: "deadline/d1#2", finalStop: false, now: DUE_DAY_0900, tz: TZ },
    ]);
    expect(h.sent).toEqual([
      "SISTE FRIST i dag: Aksjonærregisteroppgaven (Heiberg Industries AS) — Tvangsmulkt fra " +
        "Skatteetaten løper per dag.",
    ]);
  });

  it("a row with no rung due today is never asked about", async () => {
    // Due in ten days: no rung, and so no ledger row and no message.
    const h = harness({ rows: [deadline({ dueDate: "2026-06-27" })] });
    const result = await makeDeadlineLadderTick(h.deps).tick();

    expect(h.asked).toEqual([]);
    expect(result).toEqual({ stepped: 0, held: 0, skipped: null });
  });
});

describe("one spent door stops the batch; one broken send does not", () => {
  it("a door-ceiling deferral on the first row means the other two are never asked", async () => {
    const rows = [deadline({ id: "d1" }), deadline({ id: "d2" }), deadline({ id: "d3" })];
    const h = harness({ rows, answer: DOOR_CEILING });
    const result = await makeDeadlineLadderTick(h.deps).tick();

    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({ itemKey: "deadline/d1#1" });
    expect(h.sent).toEqual([]);
    expect(h.advanced).toEqual([]);
    // All three stay eligible for tomorrow, and the tick says so rather than reporting one hold.
    expect(result).toEqual({ stepped: 0, held: 3, skipped: null });
  });

  it("a thrown send skips that row and the next one still gets its rung", async () => {
    const rows = [deadline({ id: "d1" }), deadline({ id: "d2" })];
    let calls = 0;
    const h = harness({
      rows,
      send: async (text) => {
        calls += 1;
        if (calls === 1) throw new Error("telegram is unreachable");
        h.sent.push(text);
      },
    });
    const result = await makeDeadlineLadderTick(h.deps).tick();

    expect(h.asked).toHaveLength(2);
    // d1 is untouched — it stays eligible for the next tick; d2 went out and moved.
    expect(h.advanced).toEqual([{ id: "d2", rung: 1, now: T_MINUS_ONE_1500 }]);
    expect(result).toEqual({ stepped: 1, held: 0, skipped: null });
  });

  it("a failed advanceRung is logged, never thrown — the message did reach him", async () => {
    const h = harness();
    h.deps.store.advanceRung = async () => { throw new Error("pool is gone"); };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await makeDeadlineLadderTick(h.deps).tick()).toEqual({ stepped: 1, held: 0, skipped: null });
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});

describe("rungText", () => {
  const step = (rung: 1 | 2 | 3): LadderStep => ({ rung, finalStop: rung === 3 });

  it("rung 1 names tomorrow, the entity, the consequence and what closes the row", () => {
    expect(rungText(deadline(), step(1), 1, "nb")).toBe(
      "Frist i morgen: Aksjonærregisteroppgaven (Heiberg Industries AS) — Tvangsmulkt fra " +
        "Skatteetaten løper per dag. Si «ferdig» eller «avvis» når den er håndtert.",
    );
  });

  it("rung 1 without a consequence drops the clause rather than printing an empty dash", () => {
    expect(rungText(deadline({ consequence: null }), step(1), 1, "nb")).toBe(
      "Frist i morgen: Aksjonærregisteroppgaven (Heiberg Industries AS). " +
        "Si «ferdig» eller «avvis» når den er håndtert.",
    );
  });

  it("rung 2 is the last-call line", () => {
    expect(rungText(deadline({ rung: 1 }), step(2), 0, "nb")).toBe(
      "SISTE FRIST i dag: Aksjonærregisteroppgaven (Heiberg Industries AS) — Tvangsmulkt fra " +
        "Skatteetaten løper per dag.",
    );
    expect(rungText(deadline({ rung: 1, consequence: null }), step(2), 0, "nb")).toBe(
      "SISTE FRIST i dag: Aksjonærregisteroppgaven (Heiberg Industries AS).",
    );
  });

  it("rung 3 counts the rungs actually sent, then says it is stopping", () => {
    expect(rungText(deadline({ rung: 2 }), step(3), -1, "nb")).toBe(
      "Jeg har tatt opp «Aksjonærregisteroppgaven» 3 ganger og stopper nå. " +
        "Si fra om du vil ha den tilbake.",
    );
  });

  // ── The stop at rung 0 (review fix, ORB-180) ─────────────────────────────────────────────
  //
  // `ladderStep` never catches a rung up, so a deadline whose date passed while the LADDER WAS
  // OFF reaches the final stop having been raised zero times. The count line then read "jeg har
  // tatt opp … 1 ganger" — a claim he can check and find false, in a plural that is wrong twice
  // over. The stop must say what actually happened instead.
  it("rung 3 from rung 0 says the date went by unannounced — no count, no false claim", () => {
    expect(rungText(deadline({ rung: 0 }), step(3), -4, "nb")).toBe(
      "«Aksjonærregisteroppgaven» (Heiberg Industries AS) forfalt 4 dager siden uten at jeg " +
        "fikk sagt fra. Jeg stopper her — si fra om du vil ha den tilbake.",
    );
  });

  it("one day late is singular — «1 dag siden», never «1 dager siden»", () => {
    expect(rungText(deadline({ rung: 0 }), step(3), -1, "nb")).toContain("forfalt 1 dag siden");
  });

  it("the rung-0 stop never claims a count, in either wording", () => {
    const text = rungText(deadline({ rung: 0 }), step(3), -2, "nb");
    expect(text).not.toMatch(/ganger|gang og/u);
    expect(text).not.toContain("tatt opp");
  });

  it("a row that SLEPT through rung 2 says 2, not 3 — the ladder never catches a rung up", () => {
    expect(rungText(deadline({ rung: 1 }), step(3), -1, "nb")).toContain("2 ganger");
  });

  // LAR-68 — the same rungs, in English, proving the language actually switches the wording.
  it("rung 1 in English", () => {
    expect(rungText(deadline(), step(1), 1, "en")).toBe(
      "Due tomorrow: Aksjonærregisteroppgaven (Heiberg Industries AS) — Tvangsmulkt fra " +
        "Skatteetaten løper per dag. Say \"done\" or \"dismiss\" once it's handled.",
    );
  });

  it("rung 2 in English", () => {
    expect(rungText(deadline({ rung: 1 }), step(2), 0, "en")).toBe(
      "FINAL DEADLINE today: Aksjonærregisteroppgaven (Heiberg Industries AS) — Tvangsmulkt fra " +
        "Skatteetaten løper per dag.",
    );
  });

  it("rung 3 from rung 0 in English", () => {
    expect(rungText(deadline({ rung: 0 }), step(3), -4, "en")).toBe(
      "\"Aksjonærregisteroppgaven\" (Heiberg Industries AS) was due 4 days ago and I never got the " +
        "chance to flag it. Stopping here — let me know if you want it back.",
    );
  });

  it("rung 3 counting the raises, in English", () => {
    expect(rungText(deadline({ rung: 2 }), step(3), -1, "en")).toBe(
      "I've raised \"Aksjonærregisteroppgaven\" 3 times and I'm stopping now. " +
        "Let me know if you want it back.",
    );
  });
});

describe("deadlinePrompt", () => {
  it("frames the turn as scheduled and tells the model to relay, not compose", () => {
    const prompt = deadlinePrompt("Frist i morgen: X (Y).");
    expect(prompt).toContain("[scheduled turn — a deadline reminder. This is not a message from a person.]");
    expect(prompt).toContain("verbatim");
    expect(prompt.endsWith("Frist i morgen: X (Y).")).toBe(true);
  });
});
