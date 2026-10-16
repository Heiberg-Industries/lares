import { describe, it, expect } from "vitest";
import { denylistPatterns } from "./helpers/denylist.js";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

/**
 * — the three places a heartbeat key lives must agree, or the monitor reads a healthy
 * schedule as dead (the ticket's own warning in digest-store.ts: "the two must agree"). This file
 * pins (1) each schedule's exported HEARTBEAT_KEY to its filename, (2) the tick stamp to the
 * slot-based schedules, (3) at least one pass stamp per schedule, and (4) the migration seed
 * list to the same set.
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
 * on every installation that has not asked for it, so a freshness check for one would be red for
 * ever, by default.
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

describe("schedule heartbeat keys are pinned to the schedule files", () => {
  const sources = scheduleSources();

  it("there are exactly the 18 schedules the inventory names", () => {
    expect([...sources.keys()]).toEqual([
      "clipping-requests", "conversation-prune", "crm-routing", "deadlines", "digest", "dream", "email-triage",
      "evening-brief", "meeting-followup", "morning-brief",
      "outreach-reply-watch", "owner-clock", "proposals-watch", "reminders", "reping",
      "telegram-handover", "voice-learn", "weekly-summary",
    ]);
  });

  it("every schedule exports HEARTBEAT_KEY = \"chief-of-staff/<its own basename>\"", () => {
    for (const [name, src] of sources) {
      const m = src.match(/export const HEARTBEAT_KEY = "([^"]+)";/);
      expect(m?.[1], `${name}.ts must export HEARTBEAT_KEY`).toBe(`chief-of-staff/${name}`);
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
        // step 2: a schedule's OWN box-switch line (`scheduleGate`/`digestGate`/
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

  it("nothing still writes the retired row name", () => {
    for (const [name, src] of sources) for (const re of denylistPatterns()) expect(re.test(src), name).toBe(false);
    const store = readFileSync(join(here, "..", "lib", "digest-store.ts"), "utf8");
    expect(store).not.toMatch(/recordDigestHeartbeat|DIGEST_HEARTBEAT_AGENT/);
  });
});

/**
 * The heartbeat rows the box schema seeds. The baseline carries one pass row per schedule and a
 * tick row for each slot schedule; a schedule added later ships its seed in its own numbered
 * migration and adds that file here. The union is what must match the code: which file carries a
 * row is an ordering detail, that every row is carried by one of them is not.
 */
const SEED_MIGRATIONS = ["001_baseline.sql"];

function seededKeys(): string[] {
  return SEED_MIGRATIONS.flatMap((name) => {
    const src = readFileSync(join(here, "..", "..", "box", "sql", name), "utf8");
    return [...src.matchAll(/\('(chief-of-staff\/[a-z-]+(?:\/tick)?)'\)/g)].map((m) => m[1]!);
  });
}

describe("the schema seeds match the schedule code", () => {
  const sources = scheduleSources();
  const codeKeys = [...sources.keys()].map((n) => `chief-of-staff/${n}`).sort();
  const switchOf = (name: string): string => scheduleSwitch(sources.get(name)!);

  it("every schedule reads exactly one of the two definition switches", () => {
    for (const name of sources.keys()) {
      expect(
        ["default-on", "opt-in"],
        `${name}.ts must gate on exactly one of scheduleEnabled( / scheduleExplicitlyEnabled( — found: ${switchOf(name)}`,
      ).toContain(switchOf(name));
    }
  });

  it("the schema seeds exactly the pass rows and the tick rows the code writes", () => {
    const seeded = seededKeys().sort();
    const expected = [...codeKeys, ...SLOT_SCHEDULES.map((n) => `chief-of-staff/${n}/tick`)].sort();
    expect(seeded).toEqual(expected);
  });
});
