import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

/**
 * ORB-175 — the three places a heartbeat key lives must agree, or the monitor reads a healthy
 * schedule as dead (ORB-179's own warning in digest-store.ts: "the two must agree"). This file
 * pins (1) each schedule's exported HEARTBEAT_KEY to its filename, (2) the tick stamp to the
 * slot-based schedules, (3) at least one pass stamp per schedule. Task 3 adds (4) the
 * input-freshness.sh table and (5) the migration's seed list to the same set.
 *
 * Static on purpose: importing a schedule module boots its live wiring; reading the source does
 * not, and a key is a string literal precisely so this can be checked without a process.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SCHEDULES_DIR = join(here, "..", "agent", "schedules");

export const SLOT_SCHEDULES = [
  "morning-brief", "evening-brief", "digest", "dream", "conversation-prune", "voice-learn",
  "weekly-summary", "crm-routing", "telegram-handover",
];

/**
 * WHICH SWITCH A SCHEDULE READS decides whether the freshness alarm may watch it, and the rule is
 * MECHANICAL — read off the gate line, never off a list of names kept here:
 *
 *   `if (!scheduleEnabled(loaded.definition, …)) return;`           silence means ON  -> "default-on"
 *   `if (!scheduleExplicitlyEnabled(loaded.definition, …)) return;` silence means OFF -> "opt-in"
 *
 * An opt-in schedule returns at a closed gate before it stamps anything, and its gate is closed
 * on every installation that has not asked for it. `input-freshness.sh` cannot yet tell "off on
 * purpose" from "stopped", so a table line for one would be red for ever, by default.
 */
export function scheduleSwitch(src: string): "default-on" | "opt-in" | "none" | "both" {
  const defaultOn = /if \(!scheduleEnabled\(loaded\.definition, "[^"]+"\)\) return;/.test(src);
  const optIn = /if \(!scheduleExplicitlyEnabled\(loaded\.definition, "[^"]+"\)\) return;/.test(src);
  if (defaultOn && optIn) return "both";
  return defaultOn ? "default-on" : optIn ? "opt-in" : "none";
}

export function scheduleSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(SCHEDULES_DIR).filter((f) => f.endsWith(".ts")).sort()) {
    out.set(basename(f, ".ts"), readFileSync(join(SCHEDULES_DIR, f), "utf8"));
  }
  return out;
}

describe("schedule heartbeat keys are pinned to the schedule files (ORB-175)", () => {
  const sources = scheduleSources();

  it("there are exactly the 18 schedules the inventory names", () => {
    expect([...sources.keys()]).toEqual([
      "conversation-prune", "crm-routing", "deadlines", "digest", "dream", "email-triage",
      "evening-brief", "market-refresh", "meeting-followup", "morning-brief",
      "outreach-reply-watch", "owner-clock", "proposals-watch", "reminders", "reping",
      "telegram-handover", "voice-learn", "weekly-summary",
    ]);
  });

  it("every schedule exports HEARTBEAT_KEY = \"saga/<its own basename>\"", () => {
    for (const [name, src] of sources) {
      const m = src.match(/export const HEARTBEAT_KEY = "([^"]+)";/);
      expect(m?.[1], `${name}.ts must export HEARTBEAT_KEY`).toBe(`saga/${name}`);
    }
  });

  it("exactly the slot-based schedules stamp a tick, right after their gate", () => {
    for (const [name, src] of sources) {
      const ticks = src.match(/recordScheduleTick\(getPool\(\), HEARTBEAT_KEY\)/g) ?? [];
      if (SLOT_SCHEDULES.includes(name)) {
        expect(ticks, `${name}.ts must stamp its tick exactly once`).toHaveLength(1);
        // The stamp follows the gate check within a few lines — a tick stamped after the slot
        // check would only fire once a day and defeat the 2 h loop threshold.
        //
        // ORB-278 step 2: a schedule's OWN box-switch line (`scheduleGate`/`digestGate`/
        // `dreamGate`, unchanged) may now be preceded by the definition read (`scheduleEnabled`)
        // — or, for the fourteen plain schedules, replaced by it outright, since
        // `scheduleEnabled` already ANDs in `EVE_SCHEDULES_LIVE`. Either way the FIRST gate line
        // found is what "must precede the tick within 160 chars" is checked against.
        //
        // ADR-0020: `conversation-prune` reads the definition through `scheduleExplicitlyEnabled`
        // instead (silence means OFF for a schedule that deletes) — the same line in the same
        // place, so it is recognised here as the gate it is.
        const gate = src.search(
          /if \(!(scheduleGate|digestGate|dreamGate)\(\)\) return;|if \(!schedule(Enabled|ExplicitlyEnabled)\(loaded\.definition, "[^"]+"\)\) return;/,
        );
        const tick = src.indexOf("recordScheduleTick(getPool(), HEARTBEAT_KEY)");
        expect(gate, `${name}.ts gate`).toBeGreaterThan(-1);
        expect(tick - gate, `${name}.ts tick must come after the gate`).toBeGreaterThan(0);
        expect(tick - gate, `${name}.ts tick must directly follow the gate`).toBeLessThan(160);
      } else {
        expect(ticks, `${name}.ts is a polling schedule — its pass IS its tick`).toHaveLength(0);
      }
    }
  });

  it("every schedule stamps at least one pass with its own key", () => {
    for (const [name, src] of sources) {
      const passes = src.match(/recordSchedulePass\([^,]+, HEARTBEAT_KEY\)/g) ?? [];
      expect(passes.length, `${name}.ts must call recordSchedulePass`).toBeGreaterThanOrEqual(1);
    }
  });

  it("nothing still writes the retired ORB-179 row name", () => {
    for (const [name, src] of sources) expect(src, name).not.toMatch(/saga-digest/);
    const store = readFileSync(join(here, "..", "lib", "digest-store.ts"), "utf8");
    expect(store).not.toMatch(/recordDigestHeartbeat|DIGEST_HEARTBEAT_AGENT/);
  });
});

const OPS_SCRIPT = join(here, "..", "..", "box", "ops", "input-freshness.sh");
/**
 * Every migration that seeds a heartbeat row. 031 seeded the ORB-175 inventory; a schedule added
 * later ships its seed in its OWN migration (035 = ORB-193's `saga/owner-clock`), because 031 is
 * already applied on the box and editing an applied file seeds nothing. The union is what must
 * match the code — which migration carries a row is an ordering detail, that every row is carried
 * by one of them is not.
 */
const SEED_MIGRATIONS = [
  "031_schedule_heartbeat.sql", "035_proactivity.sql", "036_deadlines.sql",
  "070_conversation_prune_heartbeat.sql", "082_telegram_handover_heartbeat.sql",
];

/**
 * The agreed inventory (spec, decided 2026-09-04). Hours.
 *
 * ORB-180 Task 2: `saga/deadlines` and `saga/market-refresh` are seeded by sql/036 here, but
 * their schedule files don't exist yet (Tasks 5 and 7 add them) — so
 * "the migrations seed exactly the pass rows and the tick rows the code writes" below is
 * KNOWN-RED between Task 2 and Task 7. Do not "fix" it by editing the seeds or this table.
 */
const AGREED_THRESHOLDS: Record<string, number> = {
  // `conversation-prune` is NOT here: it is opt-in (`scheduleSwitch` above), so it has no table
  // line. The number agreed for it — for the day the script can report it as SKIP where it is
  // off — is the nightly 30 `dream` has, for the same reason: it fires once a night on the
  // owner's clock (04:00, an hour after the dream cycle), so 24 h + slack.
  "saga/morning-brief": 26, "saga/evening-brief": 26, "saga/digest": 20, "saga/dream": 30,
  // The nightly hand-over fires once a night on the owner's clock (00:00), so 24 h + slack —
  // the same number the nightly dream carries, for the same reason.
  "saga/telegram-handover": 30,
  "saga/voice-learn": 192, "saga/weekly-summary": 192, "saga/crm-routing": 20,
  "saga/email-triage": 2, "saga/meeting-followup": 2, "saga/outreach-reply-watch": 2,
  "saga/proposals-watch": 2, "saga/reminders": 2, "saga/reping": 2, "saga/owner-clock": 2,
  "saga/deadlines": 2, "saga/market-refresh": 26,
};

/**
 * LAR-44 — `SCHEDULE_PASSES`/`SCHEDULE_TICKS` are now ONE shared block carrying both Saga's rows
 * and Marcel's (`services/travel/tests/schedule-heartbeat-conformance.test.ts` owns the latter),
 * so this filters to the `saga/` lines rather than assuming every line is one — a `marcel/` line
 * here is that file's to validate, not a malformed line of this one's.
 */
function bashTable(): { passes: Record<string, number>; ticks: string[] } {
  const src = readFileSync(OPS_SCRIPT, "utf8");
  const block = src.match(/SCHEDULE_PASSES="\n([\s\S]*?)\n"/)?.[1];
  expect(block, "SCHEDULE_PASSES block in input-freshness.sh").toBeDefined();
  const passes: Record<string, number> = {};
  for (const line of block!.split("\n").filter((l) => l.startsWith("saga/"))) {
    const m = line.match(/^(saga\/[a-z-]+):(\d+):.+$/);
    expect(m, `malformed SCHEDULE_PASSES line: ${line}`).not.toBeNull();
    passes[m![1]!] = Number(m![2]);
  }
  const allTicks = src.match(/SCHEDULE_TICKS="([^"]+)"/)?.[1]?.trim().split(/\s+/) ?? [];
  const ticks = allTicks.filter((t) => t.startsWith("saga/"));
  return { passes, ticks };
}

function bashTickHours(): number | undefined {
  const src = readFileSync(OPS_SCRIPT, "utf8");
  const m = src.match(/SCHEDULE_TICK_HOURS=(\d+)/);
  return m ? Number(m[1]) : undefined;
}

function seededKeys(): string[] {
  return SEED_MIGRATIONS.flatMap((name) => {
    const src = readFileSync(join(here, "..", "..", "box", "sql", name), "utf8");
    return [...src.matchAll(/\('(saga\/[a-z-]+(?:\/tick)?)'\)/g)].map((m) => m[1]!);
  });
}

const OPT_IN_ABSENT =
  "opt-in schedules are not in the freshness table until the script can report a schedule that is off on purpose as SKIP";

describe("the bash table and the migration seeds match the schedule code (ORB-175)", () => {
  const sources = scheduleSources();
  const codeKeys = [...sources.keys()].map((n) => `saga/${n}`).sort();
  const switchOf = (name: string): string => scheduleSwitch(sources.get(name)!);
  const watched = [...sources.keys()].filter((n) => switchOf(n) === "default-on");
  const optIn = [...sources.keys()].filter((n) => switchOf(n) === "opt-in");
  const { passes, ticks } = bashTable();

  it("every schedule reads exactly one of the two definition switches", () => {
    for (const name of sources.keys()) {
      expect(
        ["default-on", "opt-in"],
        `${name}.ts must gate on exactly one of scheduleEnabled( / scheduleExplicitlyEnabled( — found: ${switchOf(name)}`,
      ).toContain(switchOf(name));
    }
  });

  it("input-freshness.sh checks exactly the schedules gated by scheduleEnabled(, at the agreed thresholds", () => {
    expect(Object.keys(passes).sort()).toEqual(watched.map((n) => `saga/${n}`).sort());
    expect(passes).toEqual(AGREED_THRESHOLDS);
  });

  it("input-freshness.sh's tick list is exactly the slot-based schedules gated by scheduleEnabled(", () => {
    expect([...ticks].sort()).toEqual(
      SLOT_SCHEDULES.filter((n) => watched.includes(n)).map((n) => `saga/${n}`).sort(),
    );
  });

  it("a schedule gated by scheduleExplicitlyEnabled( has NO table line and NO tick entry", () => {
    for (const name of optIn) {
      expect(Object.keys(passes), `saga/${name} has a SCHEDULE_PASSES line — ${OPT_IN_ABSENT}`)
        .not.toContain(`saga/${name}`);
      expect(ticks, `saga/${name} is in SCHEDULE_TICKS — ${OPT_IN_ABSENT}`).not.toContain(`saga/${name}`);
    }
  });

  it("input-freshness.sh's tick threshold is 2h, the agreed value", () => {
    expect(bashTickHours()).toBe(2);
  });

  it("the migrations seed exactly the pass rows and the tick rows the code writes", () => {
    const seeded = seededKeys().sort();
    const expected = [...codeKeys, ...SLOT_SCHEDULES.map((n) => `saga/${n}/tick`)].sort();
    expect(seeded).toEqual(expected);
  });
});
