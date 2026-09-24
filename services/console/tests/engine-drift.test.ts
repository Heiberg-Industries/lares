import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { DEFAULT_HOME_TZ, ENGINE } from "../lib/proactivity";
import { DEADLINE_SOURCES, MENTION_DAYS_MIRROR, STATUTORY_RULES_MIRROR, mintYearFromMirror, nextDueDate } from "../lib/deadlines";
import { MARKETS_ENGINE } from "../lib/markets";
import { BRIEF_LANGUAGES_MIRROR } from "../lib/brief-settings";
import { OWNER_FACING_SCHEDULES, SCHEDULE_HOUR_DEFAULTS, SINGLE_SLOT, validateHours } from "../lib/schedule-hours";
import { APPROVAL_LIFETIME_MS } from "../components/ChatTranscript";
// LAR-36 — the kit's own arithmetic, imported at TEST time only (see the describe block below for
// why this does not contradict the file's own "mirrored, not imported" rule).
import { mintYear, nextDue } from "@lares/agent-kit/deadlines";

/**
 * ORB-193 — the drift alarm against the kit's own engine numbers.
 *
 * `lib/proactivity.ts` MIRRORS `packages/agent-kit/src/proactivity.ts`'s `ENGINE` rather than
 * importing it: the console deliberately does not depend on `@lares/agent-kit` (the same rule
 * `app/actions/meeting-series.ts` states for agent-runtime). ADR-0014 rule 12 names that as a known
 * two-place truth. This test is the price of it — the day someone lowers the fleet's escalation
 * ceiling to 2 in the kit, THIS is what says the console still refuses 3.
 *
 * The kit's source is read as TEXT, exactly as `services/chief-of-staff/tests/travel-store.test.ts` reads
 * Marcel's `trip-store.ts` for the same reason: an import would make the two agree by construction
 * and the alarm would be a tautology. A separate package, a separate build, a text read.
 *
 * A parse failure FAILS rather than skips. An alarm that goes quiet when it can no longer find what
 * it is watching is the ORB-179 shape — the thing looked healthy for ten days.
 */
const KIT = path.join(import.meta.dirname, "..", "..", "..", "packages", "agent-kit", "src");

function kitSource(file: string): string {
  const p = path.join(KIT, file);
  const src = fs.readFileSync(p, "utf8");
  expect(src.length, `${p} is empty`).toBeGreaterThan(0);
  return src;
}

/** The `ENGINE = { … }` literal in the kit, as `{ field: value }` with the quotes stripped. */
function kitEngine(): Record<string, string> {
  const body = /export const ENGINE = \{([\s\S]*?)\n\} as const;/u.exec(kitSource("proactivity.ts"))?.[1];
  expect(body, "`export const ENGINE = { … } as const;` not found in the kit's proactivity.ts").toBeDefined();
  const out: Record<string, string> = {};
  for (const line of body!.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?),?\s*$/u.exec(line);
    if (!m) continue;
    out[m[1]!] = m[2]!.replace(/^["']|["'],?$/gu, "").replace(/,$/u, "");
  }
  expect(Object.keys(out).length, "no fields parsed out of the kit's ENGINE").toBeGreaterThan(0);
  return out;
}

describe("the console's ENGINE mirror has not drifted from the kit", () => {
  const kit = kitEngine();

  it("declares exactly the fields the kit declares — no more, no fewer", () => {
    // A field ADDED to the kit is drift too: a new engine limit the console knows nothing about is a
    // knob with no surface, which is the one thing the Lares working agreement forbids.
    expect(Object.keys(kit).sort()).toEqual(Object.keys(ENGINE).sort());
  });

  it("mirrors the two quiet-hours defaults and the 8-hour floor", () => {
    expect(kit["quietStart"]).toBe(ENGINE.quietStart);
    expect(kit["quietEnd"]).toBe(ENGINE.quietEnd);
    expect(Number(kit["quietMinHours"])).toBe(ENGINE.quietMinHours);
    // Pinned literally as well, because the ADR and the runbook both quote these numbers in prose —
    // a coordinated change has three places to visit, and this names them.
    expect([ENGINE.quietStart, ENGINE.quietEnd, ENGINE.quietMinHours]).toEqual(["21:00", "07:00", 8]);
  });

  it("mirrors the three ceilings", () => {
    expect(Number(kit["eventPerDoorPerDay"])).toBe(ENGINE.eventPerDoorPerDay);
    expect(Number(kit["escalationPerDoorPerDay"])).toBe(ENGINE.escalationPerDoorPerDay);
    expect(Number(kit["perOwnerPerDay"])).toBe(ENGINE.perOwnerPerDay);
    expect([ENGINE.eventPerDoorPerDay, ENGINE.escalationPerDoorPerDay, ENGINE.perOwnerPerDay])
      .toEqual([20, 3, 30]);
  });

  it("mirrors DEFAULT_HOME_TZ, which the kit declares in owner-clock.ts", () => {
    // The clock's floor, not a proactivity number — and a different kit file, which is exactly why it
    // could drift on its own. The console falls back to it whenever OWNER_HOME_TZ is unset.
    const declared = /export const DEFAULT_HOME_TZ = "([^"]+)"/u.exec(kitSource("owner-clock.ts"))?.[1];
    expect(declared, "no `export const DEFAULT_HOME_TZ = ...` found in the kit's owner-clock.ts").toBeDefined();
    expect(declared).toBe(DEFAULT_HOME_TZ);
    expect(DEFAULT_HOME_TZ).toBe("Europe/Oslo");
  });
});

// ---------------------------------------------------------------------------------------------
// ORB-180 — the console's deadlines mirror against the kit's STATUTORY_RULES["NO-AS"] and
// MENTION_DAYS (packages/agent-kit/src/deadlines.ts), read as text for the same reason as above.
// ---------------------------------------------------------------------------------------------

interface KitRule {
  key: string; title: string; month: number; day: number; yearOffset: number;
  recurrence: string; consequence: string;
}

function kitStatutoryRules(): KitRule[] {
  const src = kitSource("deadlines.ts");
  const arrBody = /const NO_AS: readonly StatutoryRule\[\] = \[([\s\S]*?)\n\];/u.exec(src)?.[1];
  expect(arrBody, "`const NO_AS: readonly StatutoryRule[] = [ … ];` not found in the kit's deadlines.ts").toBeDefined();
  const blocks = arrBody!.match(/\{[\s\S]*?\},/gu) ?? [];
  expect(blocks.length, "no rule objects parsed out of the kit's NO_AS").toBeGreaterThan(0);
  return blocks.map((b) => {
    const field = (name: string): string | undefined => new RegExp(`${name}:\\s*"([^"]*)"`, "u").exec(b)?.[1];
    const num = (name: string): number | undefined => {
      const m = new RegExp(`${name}:\\s*(\\d+)`, "u").exec(b);
      return m ? Number(m[1]) : undefined;
    };
    const key = field("key");
    expect(key, `a rule block with no "key" field: ${b}`).toBeDefined();
    return {
      key: key!,
      title: field("title")!,
      month: num("month")!,
      day: num("day")!,
      yearOffset: num("yearOffset")!,
      recurrence: field("recurrence")!,
      consequence: field("consequence")!,
    };
  });
}

function kitMentionDays(): number[] {
  const declared = /export const MENTION_DAYS: readonly number\[\] = \[([^\]]+)\];/u.exec(kitSource("deadlines.ts"))?.[1];
  expect(declared, "`export const MENTION_DAYS: readonly number[] = [ … ];` not found in the kit's deadlines.ts").toBeDefined();
  return declared!.split(",").map((s) => Number(s.trim()));
}

/** The `export type DeadlineSource = "a" | "b" | …;` union, read as TEXT — LAR-22-s4. */
function kitDeadlineSources(): string[] {
  const declared = /export type DeadlineSource = ([^;]+);/u.exec(kitSource("deadlines.ts"))?.[1];
  expect(declared, "`export type DeadlineSource = … ;` not found in the kit's deadlines.ts").toBeDefined();
  return declared!.split("|").map((s) => s.trim().replace(/^"|"$/gu, ""));
}

describe("the console's deadlines mirror has not drifted from the kit", () => {
  const kitRules = kitStatutoryRules();

  it("declares exactly the same rule keys — no more, no fewer", () => {
    expect(STATUTORY_RULES_MIRROR.map((r) => r.key).sort()).toEqual(kitRules.map((r) => r.key).sort());
  });

  it("mirrors every rule's title, month, day, yearOffset, recurrence and consequence", () => {
    const byKey = <T extends { key: string }>(arr: readonly T[]): Record<string, T> =>
      Object.fromEntries(arr.map((r) => [r.key, r]));
    const kit = byKey(kitRules);
    const mirror = byKey(STATUTORY_RULES_MIRROR);
    for (const key of Object.keys(kit)) {
      expect(mirror[key], `${key} is missing from STATUTORY_RULES_MIRROR`).toBeDefined();
      const k = kit[key]!;
      const m = mirror[key]!;
      // `title` renders verbatim on the mint form and in the brief — a drift here is an owner
      // confirming a date against a filing NAME the kit no longer uses, so it belongs in the same
      // comparison as the date fields, not left out because it happens to be a string.
      expect({ title: m.title, month: m.month, day: m.day, yearOffset: m.yearOffset, recurrence: m.recurrence, consequence: m.consequence })
        .toEqual({ title: k.title, month: k.month, day: k.day, yearOffset: k.yearOffset, recurrence: k.recurrence, consequence: k.consequence });
    }
  });

  it("mirrors MENTION_DAYS", () => {
    expect(MENTION_DAYS_MIRROR).toEqual(kitMentionDays());
    expect(MENTION_DAYS_MIRROR).toEqual([30, 16, 8, 4, 2, 1, 0]);
  });
});

// ---------------------------------------------------------------------------------------------
// LAR-22-s4 — the console's DEADLINE_SOURCES against the kit's `DeadlineSource` union
// (packages/agent-kit/src/deadlines.ts), read as text for the same reason as every mirror above:
// the console does not import the kit, so the day the kit's union widens (or narrows) without a
// matching edit here, this is what says so instead of the two silently drifting.
// ---------------------------------------------------------------------------------------------

describe("the console's DEADLINE_SOURCES has not drifted from the kit's DeadlineSource union", () => {
  it("declares exactly the same sources — no more, no fewer", () => {
    expect([...DEADLINE_SOURCES].sort()).toEqual(kitDeadlineSources().sort());
  });

  it("includes 'renewal' on both sides (LAR-22)", () => {
    expect(DEADLINE_SOURCES).toContain("renewal");
    expect(kitDeadlineSources()).toContain("renewal");
  });
});

// ---------------------------------------------------------------------------------------------
// LAR-36 — the arithmetic itself, not just the rule table above. `STATUTORY_RULES_MIRROR` being a
// byte-for-byte copy of the kit's `NO_AS` says nothing about whether `mintYearFromMirror` computes
// a `dueDate` the same way the kit's `mintYear` does, or whether `nextDueDate`'s month-end clamp
// rounds the same direction as the kit's `nextDue` — the kit's `yearOffset` handling or clamp
// direction could change and every test above would stay green. This is what would catch it.
//
// The kit's `mintYear`/`nextDue` are imported here directly rather than read as text, because this
// describe block is not comparing two independent DECLARATIONS (where an import would make the
// comparison a tautology) — it is running the kit's actual arithmetic against the console's and
// checking the two AGREE, which needs the real function, not a re-parsed copy of its source. The
// import happens only inside this test file: the console's runtime code (`lib/deadlines.ts`,
// `DeadlineControls.tsx`) still never imports `@lares/agent-kit` for deadlines, so the bundle rule
// this file's own header states is untouched.
// ---------------------------------------------------------------------------------------------

describe("the console's date arithmetic has not drifted from the kit's", () => {
  // 2025-2028 per the ticket: an ordinary year on both sides, plus 2028, the leap year in range,
  // which is what makes the February clamp below meaningful rather than accidental.
  const YEARS = [2025, 2026, 2027, 2028] as const;

  it("mintYearFromMirror mints the same dueDate as the kit's mintYear, every rule, every year", () => {
    for (const fiscalYear of YEARS) {
      // includePast on both sides: this test is about the DATE each rule computes, not about which
      // rows a mid-year mint would keep — that boundary already has its own coverage in
      // deadlines.test.ts and must not hide a date disagreement behind a "skipped anyway" row.
      const kitByKey = Object.fromEntries(
        mintYear("NO-AS", fiscalYear, { includePast: true }).minted.map((r) => [r.ruleKey, r.dueDate]),
      );
      const consoleByKey = Object.fromEntries(
        mintYearFromMirror(fiscalYear, [], { includePast: true }).minted.map((r) => [r.ruleKey, r.dueDate]),
      );
      expect(consoleByKey, `fiscal year ${fiscalYear}`).toEqual(kitByKey);
    }
  });

  it("nextDueDate clamps a month-end date the same direction as the kit's nextDue", () => {
    // Jan 31 + 1 month: an ordinary year's February has 28 days, a leap year's has 29 — both sides
    // must clamp DOWN to the month's real length rather than rolling into March, in both cases.
    expect(nextDueDate("2026-01-31", "monthly")).toBe(nextDue("2026-01-31", "monthly"));
    expect(nextDueDate("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(nextDueDate("2028-01-31", "monthly")).toBe(nextDue("2028-01-31", "monthly"));
    expect(nextDueDate("2028-01-31", "monthly")).toBe("2028-02-29");

    // Aug 31, bimonthly (mva-t3's own recurrence): +2 months lands on 31 October, a month that
    // itself has 31 days — the case where a wrong clamp would still pass by accident.
    expect(nextDueDate("2026-08-31", "bimonthly")).toBe(nextDue("2026-08-31", "bimonthly"));
    expect(nextDueDate("2026-08-31", "bimonthly")).toBe("2026-10-31");
  });
});

// ---------------------------------------------------------------------------------------------
// W8B-s5 — the console's APPROVAL_LIFETIME_MS against the kit's own APPROVAL_TTL_MS
// (packages/agent-kit/src/approval-ledger.ts), read as text for the same reason as every mirror
// above, and for one more: that module opens a pg Pool, so it cannot be imported into a browser
// bundle at all. If the agent's lifetime is shortened and the console's is not, web chat shows a
// live button on a card the agent will refuse — the exact "I clicked and nothing happened" the
// mirror exists to prevent.
// ---------------------------------------------------------------------------------------------

describe("the console's approval lifetime has not drifted from the kit's", () => {
  it("mirrors APPROVAL_TTL_MS exactly, and both are 24 hours", () => {
    const src = kitSource("approval-ledger.ts");
    // The literal is a product of whole numbers (`24 * 60 * 60 * 1000`). Multiplied out by hand
    // rather than evaluated: a test that ran a string out of a source file would be a worse thing
    // than the drift it guards against, and a shape this parser does not understand FAILS rather
    // than silently agreeing.
    const m = /export const APPROVAL_TTL_MS = ([0-9*\s]+);/u.exec(src);
    expect(m, "`export const APPROVAL_TTL_MS = <whole numbers multiplied>;` not found in the kit's approval-ledger.ts").toBeDefined();
    const kitMs = m![1]!.split("*").map((part) => Number(part.trim())).reduce((a, b) => a * b, 1);
    expect(Number.isFinite(kitMs), `APPROVAL_TTL_MS did not parse to a number: ${m![1]}`).toBe(true);
    expect(APPROVAL_LIFETIME_MS).toBe(kitMs);
    expect(APPROVAL_LIFETIME_MS).toBe(24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------------------------
// ORB-214 — the console's MARKETS_ENGINE against services/chief-of-staff/lib/markets-settings-store.ts,
// a different package entirely (not agent-kit) and read as text for the same reason.
// ---------------------------------------------------------------------------------------------

const EVE_SAGA_LIB = path.join(import.meta.dirname, "..", "..", "chief-of-staff", "lib");

describe("the console's MARKETS_ENGINE mirror has not drifted from eve-saga's markets settings store", () => {
  it("mirrors watchlistMax and watchlistDefault", () => {
    const p = path.join(EVE_SAGA_LIB, "markets-settings-store.ts");
    const src = fs.readFileSync(p, "utf8");
    expect(src.length, `${p} is empty`).toBeGreaterThan(0);
    const m = /export const MARKETS_ENGINE = \{\s*watchlistMax:\s*(\d+),\s*watchlistDefault:\s*(\d+)\s*\}\s*as const;/u.exec(src);
    expect(m, "`export const MARKETS_ENGINE = { watchlistMax: …, watchlistDefault: … } as const;` not found").toBeDefined();
    expect(MARKETS_ENGINE).toEqual({ watchlistMax: Number(m![1]), watchlistDefault: Number(m![2]) });
    expect(MARKETS_ENGINE).toEqual({ watchlistMax: 150, watchlistDefault: 100 });
  });
});

// ---------------------------------------------------------------------------------------------
// LAR-16-s3 — the console's BRIEF_LANGUAGES_MIRROR against eve-saga's own supported-language list
// (`services/chief-of-staff/lib/brief-settings.ts`'s `BRIEF_LANGUAGES`), read as text for the same
// reason as the markets engine above: a separate package, a separate build, no import. The owner's
// amendment of 2026-09-18 made this list grow past "nb"/"en" and said it will grow again, which is
// exactly the kind of two-place truth this file exists to guard.
// ---------------------------------------------------------------------------------------------

describe("the console's BRIEF_LANGUAGES_MIRROR has not drifted from eve-saga's brief-settings", () => {
  it("offers exactly the codes the agent side supports — no more, no fewer", () => {
    const p = path.join(EVE_SAGA_LIB, "brief-settings.ts");
    const src = fs.readFileSync(p, "utf8");
    expect(src.length, `${p} is empty`).toBeGreaterThan(0);
    const m = /export const BRIEF_LANGUAGES = \[([^\]]+)\] as const;/u.exec(src);
    expect(m, "`export const BRIEF_LANGUAGES = [ … ] as const;` not found in eve-saga's brief-settings.ts").toBeDefined();
    const kitCodes = m![1]!.split(",").map((s) => s.trim().replace(/^"|"$/gu, "")).filter((s) => s.length > 0);
    expect(kitCodes.length, "no codes parsed out of the kit's BRIEF_LANGUAGES").toBeGreaterThan(0);
    expect(BRIEF_LANGUAGES_MIRROR.map((l) => l.code)).toEqual(kitCodes);
    expect(kitCodes).toEqual(["en", "nb", "sv", "da", "fi"]);
  });
});

// ---------------------------------------------------------------------------------------------
// LAR-17-s5 — the console's `lib/schedule-hours.ts` mirror against the kit's own
// `packages/agent-kit/src/schedule-settings.ts` (`SCHEDULE_HOUR_DEFAULTS`, `SINGLE_SLOT`,
// `validateHours`), read as text for the same reason as every mirror above: the console does not
// import the kit, so this is what says so instead of the two silently drifting.
// ---------------------------------------------------------------------------------------------

/** The `SCHEDULE_HOUR_DEFAULTS = Object.freeze({ … });` literal in the kit, as `{ key: [hours] }`. */
function kitScheduleDefaults(): Record<string, number[]> {
  const src = kitSource("schedule-settings.ts");
  const body = /export const SCHEDULE_HOUR_DEFAULTS[\s\S]*?Object\.freeze\(\{([\s\S]*?)\n\}\);/u.exec(src)?.[1];
  expect(body, "`export const SCHEDULE_HOUR_DEFAULTS = Object.freeze({ … });` not found in the kit's schedule-settings.ts").toBeDefined();
  const out: Record<string, number[]> = {};
  for (const line of body!.split("\n")) {
    const m = /^\s*"?([a-z0-9-]+)"?:\s*\[([^\]]*)\],?\s*$/u.exec(line);
    if (!m) continue;
    out[m[1]!] = m[2]!.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
  }
  expect(Object.keys(out).length, "no schedules parsed out of the kit's SCHEDULE_HOUR_DEFAULTS").toBeGreaterThan(0);
  return out;
}

/** The two schedule names the kit's `SINGLE_SLOT` filters OUT, read from its own `.filter(...)`
 *  clause rather than hard-coded here — a THIRD multi-slot schedule showing up in the kit is drift
 *  this test must still catch, not something it silently agrees with by construction. */
function kitMultiSlotNames(): string[] {
  const src = kitSource("schedule-settings.ts");
  const m = /\.filter\(\(s\) => s !== "([a-z0-9-]+)" && s !== "([a-z0-9-]+)"\)/u.exec(src);
  expect(m, "the kit's `SINGLE_SLOT` filter clause was not found — has its shape changed?").toBeDefined();
  return [m![1]!, m![2]!];
}

describe("the console's schedule-hours mirror has not drifted from the kit's schedule-settings", () => {
  const kitDefaults = kitScheduleDefaults();
  const kitMultiSlot = kitMultiSlotNames();

  it("declares exactly the same schedules, with the same default hours — no more, no fewer", () => {
    expect(Object.keys(SCHEDULE_HOUR_DEFAULTS).sort()).toEqual(Object.keys(kitDefaults).sort());
    for (const key of Object.keys(kitDefaults)) {
      expect(SCHEDULE_HOUR_DEFAULTS[key], `${key} is missing from the console's mirror`).toEqual(kitDefaults[key]);
    }
    expect(kitDefaults).toEqual({
      "morning-brief": [8], "evening-brief": [20], digest: [9, 17], "crm-routing": [9, 13, 17],
      "weekly-summary": [9], "voice-learn": [4], dream: [3],
    });
  });

  it("mirrors SINGLE_SLOT — every schedule except the kit's own multi-slot two", () => {
    expect(kitMultiSlot.sort()).toEqual(["crm-routing", "digest"]);
    const expected = new Set(Object.keys(kitDefaults).filter((s) => !kitMultiSlot.includes(s)));
    expect(SINGLE_SLOT).toEqual(expected);
  });

  it("OWNER_FACING_SCHEDULES offers exactly the five owner-facing schedules the plan names", () => {
    // dream and voice-learn are internal night jobs (LAR-17-s5's plan, decision 3) — known to the
    // mirror above but never offered a control here.
    expect(OWNER_FACING_SCHEDULES.map((s) => s.schedule).sort()).toEqual(
      ["crm-routing", "digest", "evening-brief", "morning-brief", "weekly-summary"],
    );
    for (const { schedule } of OWNER_FACING_SCHEDULES) {
      expect(kitDefaults, `${schedule} is offered but unknown to the kit`).toHaveProperty(schedule);
    }
  });

  it("validateHours agrees with the kit on every rule, for every schedule the kit knows", () => {
    for (const schedule of Object.keys(kitDefaults)) {
      expect(validateHours(schedule, kitDefaults[schedule]!)).toEqual({ ok: true });
    }
    expect(validateHours("morning-brief", [8, 9])).toEqual({ ok: false, message: "morning-brief takes exactly one hour." });
    expect(validateHours("morning-brief", [24])).toEqual({ ok: false, message: "24 is not a whole hour between 0 and 23." });
    expect(validateHours("morning-brief", [8.5])).toEqual({ ok: false, message: "8.5 is not a whole hour between 0 and 23." });
    expect(validateHours("digest", [9, 9])).toEqual({ ok: false, message: "Hours must not repeat." });
    expect(validateHours("digest", [17, 9])).toEqual({ ok: false, message: "Hours must be sorted, lowest to highest." });
    expect(validateHours("digest", [1, 2, 3, 4, 5, 6, 7])).toEqual({ ok: false, message: "At most 6 hours a day are allowed." });
    expect(validateHours("sleep-schedule", [9])).toEqual({ ok: false, message: '"sleep-schedule" is not a known schedule.' });
  });
});
