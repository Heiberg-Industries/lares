import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dreamGate, osloSlot, makeDreamBrain } from "../agent/schedules/dream.js";
import { listNotes, StoreUnhealthyError, NotePathEscapesStoreError } from "@lares/agent-kit/notes-store";
import { selectForConfirmation, DREAM_CONFIRM_MAX_PER_RUN } from "../lib/dream/surface.js";
import type { Observation } from "../lib/dream/reflect.js";

const saved = { ...process.env };
beforeEach(() => { process.env = { ...saved }; });
afterEach(() => { process.env = { ...saved }; });

describe("dreamGate — fails closed", () => {
  it("off when its own gate is unset", () => {
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    delete process.env["EVE_DREAM_LIVE"];
    expect(dreamGate()).toBe(false);
  });

  it('off for anything but exactly "1"', () => {
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    for (const v of ["0", "true", "", " 1"]) {
      process.env["EVE_DREAM_LIVE"] = v;
      expect(dreamGate()).toBe(false);
    }
  });

  it("on only when both gates are 1", () => {
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["EVE_DREAM_LIVE"] = "1";
    expect(dreamGate()).toBe(true);
  });
});

/**
 * LAR-17-s4 — PIN, asserted against the source: `dreamHour`/`DREAM_HOUR` are gone (the hour is a
 * setting now, `packages/agent-kit/src/schedule-settings.ts`'s `dream` key, default 3), and the
 * live tick asks `scheduleHours` before computing the slot.
 */
describe("dream.ts reads its hour from the setting (LAR-17-s4)", () => {
  it("carries no dreamHour/DREAM_HOUR, and asks scheduleHours before osloSlot", async () => {
    const src = await (await import("node:fs/promises")).readFile(
      new URL("../agent/schedules/dream.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("dreamHour");
    expect(src).not.toContain("DREAM_HOUR");
    expect(src.indexOf('scheduleHours("dream")')).toBeGreaterThan(-1);
    expect(src.indexOf('scheduleHours("dream")')).toBeLessThan(src.lastIndexOf("osloSlot("));
  });
});

describe("osloSlot — exact-minute gate on the owner's wall clock", () => {
  // ORB-193 — the timezone is now an ARGUMENT (the owner clock, resolved per tick). Passing
  // Europe/Oslo reproduces exactly what these asserted before.
  const OSLO = "Europe/Oslo";

  it("matches 03:00 Oslo (01:00 UTC in August)", () => {
    expect(osloSlot(new Date("2026-08-19T01:00:00Z"), OSLO, 3)).toBe("2026-08-19T3");
  });

  it("null one minute either side", () => {
    expect(osloSlot(new Date("2026-08-19T00:59:00Z"), OSLO, 3)).toBeNull();
    expect(osloSlot(new Date("2026-08-19T01:01:00Z"), OSLO, 3)).toBeNull();
  });

  it("null at the right minute of the wrong hour", () => {
    expect(osloSlot(new Date("2026-08-19T02:00:00Z"), OSLO, 3)).toBeNull();
  });

  it("follows the OWNER's clock, not Oslo's — the same instant is 03:00 in a different zone", () => {
    // 2026-08-19T18:00:00Z is 03:00 the next morning in Tokyo (UTC+9) and 20:00 in Oslo.
    expect(osloSlot(new Date("2026-08-19T18:00:00Z"), "Asia/Tokyo", 3)).toBe("2026-08-20T3");
    expect(osloSlot(new Date("2026-08-19T18:00:00Z"), OSLO, 3)).toBeNull();
  });
});

describe("makeDreamBrain — read must NOT re-walk the vault per call (ORB-134 finding 3)", () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a note directly even when the store would fail listNotes's health check", async () => {
    // No .md files anywhere under the store — `readNote()` (and therefore the OLD `brain.read`
    // that routed through it) would throw StoreUnhealthyError before reading anything, because
    // it runs a full listNotes() walk as a health check before every single read. The fixed
    // `read` resolves the path and reads it directly, so it must succeed here regardless.
    dir = mkdtempSync(join(tmpdir(), "eve-dream-brain-"));
    mkdirSync(join(dir, "_meta/conversations/2026-08-19"), { recursive: true });
    const notePath = "_meta/conversations/2026-08-19/log.txt"; // deliberately not .md
    writeFileSync(join(dir, notePath), "hello from the log");

    // Confirm the premise: the store really is unhealthy by listNotes's own health check.
    expect(() => listNotes(dir)).toThrow(StoreUnhealthyError);

    const brain = makeDreamBrain(dir);
    await expect(brain.read(notePath)).resolves.toBe("hello from the log");
  });

  it("still refuses a path that escapes the store", async () => {
    dir = mkdtempSync(join(tmpdir(), "eve-dream-brain-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "x");

    const brain = makeDreamBrain(dir);
    await expect(brain.read("../../etc/passwd")).rejects.toThrow(NotePathEscapesStoreError);
  });

  it("hands the cycle's commit message through to git, so the vault log names the dream", async () => {
    dir = mkdtempSync(join(tmpdir(), "eve-dream-brain-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "fixture");
    // commitNote pushes after it commits (ORB-51), so the fixture needs somewhere to push to.
    execFileSync("git", ["init", "-q", "--bare", join(dir, ".origin.git")]);
    git("remote", "add", "origin", join(dir, ".origin.git"));

    await makeDreamBrain(dir).commitNote({
      path: "_meta/dream/2026-09-19.md",
      frontmatter: { at: "2026-09-19T03:00:00Z" },
      body: "## Dream cycle run",
      message: "learning: 2026-09-19 (1 added, 0 superseded, 2 not learned)",
    });

    expect(git("log", "-1", "--format=%s").trim()).toBe(
      "learning: 2026-09-19 (1 added, 0 superseded, 2 not learned)",
    );
  });

  it("brain.list still runs the vault health check exactly where the cycle expects it", async () => {
    dir = mkdtempSync(join(tmpdir(), "eve-dream-brain-"));
    mkdirSync(dir, { recursive: true }); // empty — no markdown anywhere

    const brain = makeDreamBrain(dir);
    await expect(brain.list()).rejects.toThrow(StoreUnhealthyError);
  });
});

/** A minimal, neutral `Observation` fixture — `"fixture-owner"` per CLAUDE.md's rule for any
 *  test that needs an owner id, though none of these tests read it. */
function fixtureObservation(i: number): Observation {
  return {
    text: `fixture observation ${i}`,
    kind: "preference",
    subject: `fixture-subject-${i}`,
    confidence: 0.5,
    evidenceRefs: [],
    origin: "agent",
  };
}

describe("selectForConfirmation — caps a run's needsConfirm list to one notice's worth (W4C-s2b)", () => {
  it("0 items", () => {
    expect(selectForConfirmation([])).toEqual({ shown: [], heldBack: 0 });
  });

  it("1 item, default max — nothing held back", () => {
    const items = [fixtureObservation(1)];
    expect(selectForConfirmation(items)).toEqual({ shown: items, heldBack: 0 });
  });

  it("3 items, default max — exactly fills the cap, nothing held back", () => {
    const items = [fixtureObservation(1), fixtureObservation(2), fixtureObservation(3)];
    expect(DREAM_CONFIRM_MAX_PER_RUN).toBe(3);
    expect(selectForConfirmation(items)).toEqual({ shown: items, heldBack: 0 });
  });

  it("10 items, default max — keeps the first 3 in order, holds back 7", () => {
    const items = Array.from({ length: 10 }, (_, i) => fixtureObservation(i));
    const { shown, heldBack } = selectForConfirmation(items);
    expect(shown).toEqual(items.slice(0, 3));
    expect(heldBack).toBe(7);
  });

  it("honours a custom max", () => {
    const items = Array.from({ length: 10 }, (_, i) => fixtureObservation(i));
    const { shown, heldBack } = selectForConfirmation(items, { max: 5 });
    expect(shown).toEqual(items.slice(0, 5));
    expect(heldBack).toBe(5);
  });
});

/**
 * W5X-s4 — `sendConfirmationNotice` and its tests are GONE from this file. A run's
 * `needsConfirm` items are no longer announced by this schedule at all: each becomes a
 * `memory_proposals` row (`fileConfirmations`), and `tests/dream-confirmation-notice.test.ts`
 * owns that behaviour, including the proof that nothing here sends anything.
 * `selectForConfirmation` above stays exactly what it was — the cap is now how many proposals
 * one run may FILE rather than how many one message may list.
 */
