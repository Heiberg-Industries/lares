import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

/**
 * LAR-44 — the Marcel sibling of services/chief-of-staff/tests/schedule-heartbeat-conformance
 * .test.ts (ORB-175's second step: eve-saga's own schedules already stamp; Marcel's four did
 * not). Same three facts pinned against each other — schedule code ⇔ input-freshness.sh's table
 * ⇔ the migration's seed list — scoped to Marcel's four schedules instead of Saga's sixteen. The
 * two agents share ONE box script and ONE `heartbeat` table, so this file owns Marcel's rows and
 * Saga's own conformance test (unchanged by this ticket) keeps owning its own — neither can
 * silently drift onto the other's key space without failing its own pinned inventory.
 *
 * Static on purpose, like its sibling: importing a schedule module boots its live wiring; reading
 * the source does not, and a key is a string literal precisely so this can be checked without a
 * process.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SCHEDULES_DIR = join(here, "..", "agent", "schedules");

/**
 * Only `dream` fires on a slot — once a day per trip, off a per-minute tick, the same shape as
 * Saga's own `dream` schedule (LAR-44's classification). `trip-lifecycle`, `proximity` and
 * `taste-promote` are polling: they run every minute with their own internal slot/no-op logic
 * and their pass IS their tick — no separate `/tick` row.
 */
export const SLOT_SCHEDULES = ["dream"];

export function scheduleSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(SCHEDULES_DIR).filter((f) => f.endsWith(".ts")).sort()) {
    out.set(basename(f, ".ts"), readFileSync(join(SCHEDULES_DIR, f), "utf8"));
  }
  return out;
}

describe("Marcel's schedule heartbeat keys are pinned to the schedule files (LAR-44)", () => {
  const sources = scheduleSources();

  it("there are exactly the 4 schedules the inventory names", () => {
    expect([...sources.keys()]).toEqual(["dream", "proximity", "taste-promote", "trip-lifecycle"]);
  });

  it("every schedule exports HEARTBEAT_KEY = \"marcel/<its own basename>\"", () => {
    for (const [name, src] of sources) {
      const m = src.match(/export const HEARTBEAT_KEY = "([^"]+)";/);
      expect(m?.[1], `${name}.ts must export HEARTBEAT_KEY`).toBe(`marcel/${name}`);
    }
  });

  it("exactly the slot-based schedule (dream) stamps a tick, right after its gate", () => {
    for (const [name, src] of sources) {
      const ticks = src.match(/recordScheduleTick\(getPool\(\), HEARTBEAT_KEY\)/g) ?? [];
      if (SLOT_SCHEDULES.includes(name)) {
        expect(ticks, `${name}.ts must stamp its tick exactly once`).toHaveLength(1);
        // The stamp follows the gate check within a few lines — a tick stamped after a "running"
        // guard would go dark exactly when a stuck tick most needs the loop-death alarm.
        const gate = src.search(/if \(!scheduleEnabled\(loaded\.definition, "[^"]+"\)\) return;/);
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
});

const OPS_SCRIPT = join(here, "..", "..", "box", "ops", "input-freshness.sh");
/** Marcel's four rows all arrive in one migration — no earlier one to split across. */
const SEED_MIGRATIONS = ["046_marcel_schedule_heartbeat.sql"];

/** The agreed inventory (LAR-44). Hours. `marcel/dream` reuses Saga's own `saga/dream` threshold
 *  (daily cadence, same slack); the three polling schedules get the shared 2h polling threshold
 *  every eve-saga polling schedule already uses. */
const AGREED_THRESHOLDS: Record<string, number> = {
  "marcel/trip-lifecycle": 2,
  "marcel/dream": 30,
  "marcel/proximity": 2,
  "marcel/taste-promote": 2,
};

function bashPasses(): Record<string, number> {
  const src = readFileSync(OPS_SCRIPT, "utf8");
  const block = src.match(/SCHEDULE_PASSES="\n([\s\S]*?)\n"/)?.[1];
  expect(block, "SCHEDULE_PASSES block in input-freshness.sh").toBeDefined();
  const passes: Record<string, number> = {};
  for (const line of block!.split("\n").filter((l) => l.startsWith("marcel/"))) {
    const m = line.match(/^(marcel\/[a-z-]+):(\d+):.+$/);
    expect(m, `malformed SCHEDULE_PASSES line: ${line}`).not.toBeNull();
    passes[m![1]!] = Number(m![2]);
  }
  return passes;
}

function bashTicks(): string[] {
  const src = readFileSync(OPS_SCRIPT, "utf8");
  const ticks = src.match(/SCHEDULE_TICKS="([^"]+)"/)?.[1]?.trim().split(/\s+/) ?? [];
  return ticks.filter((t) => t.startsWith("marcel/"));
}

function bashTickHours(): number | undefined {
  const src = readFileSync(OPS_SCRIPT, "utf8");
  const m = src.match(/SCHEDULE_TICK_HOURS=(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** A row this file's schedules stamp is invisible to the check unless the box script's own
 *  heartbeat query actually selects `marcel/%` rows too — this pins that it does, the same drift
 *  ORB-179 warned about in the other direction (a check reading a key nothing writes). */
function bashReadsMarcelRows(): boolean {
  const src = readFileSync(OPS_SCRIPT, "utf8");
  return /heartbeat where agent like 'saga\/%' or agent like 'marcel\/%'/.test(src);
}

function seededKeys(): string[] {
  return SEED_MIGRATIONS.flatMap((name) => {
    const src = readFileSync(join(here, "..", "..", "box", "sql", name), "utf8");
    return [...src.matchAll(/\('(marcel\/[a-z-]+(?:\/tick)?)'\)/g)].map((m) => m[1]!);
  });
}

describe("the bash table and the migration seeds match Marcel's schedule code (LAR-44)", () => {
  const codeKeys = [...scheduleSources().keys()].map((n) => `marcel/${n}`).sort();
  const passes = bashPasses();
  const ticks = bashTicks();

  it("input-freshness.sh checks exactly Marcel's schedules, at the agreed thresholds", () => {
    expect(Object.keys(passes).sort()).toEqual(codeKeys);
    expect(passes).toEqual(AGREED_THRESHOLDS);
  });

  it("input-freshness.sh's tick list names exactly Marcel's slot-based schedule", () => {
    expect(ticks.sort()).toEqual(SLOT_SCHEDULES.map((n) => `marcel/${n}`).sort());
  });

  it("input-freshness.sh's tick threshold is 2h, the shared value", () => {
    expect(bashTickHours()).toBe(2);
  });

  it("input-freshness.sh reads marcel/% heartbeat rows, not just saga/%", () => {
    expect(bashReadsMarcelRows()).toBe(true);
  });

  it("sql/046 seeds exactly the pass rows and the tick row the code writes", () => {
    const seeded = seededKeys().sort();
    const expected = [...codeKeys, ...SLOT_SCHEDULES.map((n) => `marcel/${n}/tick`)].sort();
    expect(seeded).toEqual(expected);
  });
});
