import { describe, expect, it } from "vitest";
import { parseDefinition } from "../src/definition.js";
import { scheduleEnabled, scheduleExplicitlyEnabled } from "../src/schedule-switch.js";

const LIVE = { EVE_SCHEDULES_LIVE: "1" } as NodeJS.ProcessEnv;
const def = (schedules: Record<string, { on: boolean }>) =>
  parseDefinition({
    name: "saga", display: "Saga", model: "heiberg-brain", persona: "agent/instructions.md",
    role: "chief-of-staff", grants: [], autonomy: {}, schedules,
  });

describe("scheduleEnabled", () => {
  it("is off on a dark box whatever the definition says", () => {
    expect(scheduleEnabled(def({ "morning-brief": { on: true } }), "morning-brief", {})).toBe(false);
    expect(scheduleEnabled(def({ "morning-brief": { on: true } }), "morning-brief", { EVE_SCHEDULES_LIVE: "0" })).toBe(false);
  });

  it("is on when the box is live and the definition says on", () => {
    expect(scheduleEnabled(def({ "morning-brief": { on: true } }), "morning-brief", LIVE)).toBe(true);
  });

  it("is off when the definition switches it off", () => {
    expect(scheduleEnabled(def({ "morning-brief": { on: false } }), "morning-brief", LIVE)).toBe(false);
  });

  it("a schedule the definition is SILENT about keeps running — today's behaviour, unchanged", () => {
    // Every schedule that ships in an image runs on a live box today. A definition that has
    // never been edited must not silently switch the whole fleet dark, so silence means ON.
    // The builder writes an explicit entry for every schedule, so silence only ever means
    // "this definition predates that schedule".
    expect(scheduleEnabled(def({}), "morning-brief", LIVE)).toBe(true);
  });
});

/**
 * The other half of the rule, for the one kind of schedule silence must never start: a job that
 * DELETES. The live installation's definitions were written before `conversation-prune` existed,
 * so under `scheduleEnabled` they would read as "on" the day that image is deployed and the prune
 * would begin removing conversation history at 04:00 with nobody having chosen it. The template's
 * `{ "on": false }` protects only definitions generated after it.
 */
describe("scheduleExplicitlyEnabled", () => {
  it("a definition that says nothing about it does NOT run it — the live-installation case", () => {
    expect(scheduleExplicitlyEnabled(def({}), "conversation-prune", LIVE)).toBe(false);
  });

  it("is off when the definition switches it off", () => {
    expect(scheduleExplicitlyEnabled(def({ "conversation-prune": { on: false } }), "conversation-prune", LIVE)).toBe(false);
  });

  it("is on only when the definition says so, in as many words", () => {
    expect(scheduleExplicitlyEnabled(def({ "conversation-prune": { on: true } }), "conversation-prune", LIVE)).toBe(true);
  });

  it("is off on a dark box whatever the definition says — the env still wins in the OFF direction", () => {
    expect(scheduleExplicitlyEnabled(def({ "conversation-prune": { on: true } }), "conversation-prune", {})).toBe(false);
    expect(scheduleExplicitlyEnabled(def({ "conversation-prune": { on: true } }), "conversation-prune", { EVE_SCHEDULES_LIVE: "0" })).toBe(false);
  });

  it("an entry for a DIFFERENT schedule is not an entry for this one", () => {
    expect(scheduleExplicitlyEnabled(def({ dream: { on: true } }), "conversation-prune", LIVE)).toBe(false);
  });
});
