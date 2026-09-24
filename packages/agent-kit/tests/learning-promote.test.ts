/**
 * The promotion gate (ADR-0018 rules 2 and 4), W4C-s2.
 *
 * What this pins, in one sentence each:
 *   - Only what the OWNER said can ever become a preference. `third_party`, `synced`, `system`
 *     and an unreadable/missing class are never candidates, at any confidence, at any recurrence
 *     — this is the "prompt laundering" attack (three identical emails) closed at the gate.
 *   - The model's own confidence decides nothing. Two distinct owner-origin sightings promote;
 *     one holds (`PROMOTE_MIN_OWNER_RECURRENCE`).
 *   - An unattended run only ADDS. Replacing something the owner stated is never applied here;
 *     it is handed to `proposeSupersede` when one is wired, and refused outright when none is —
 *     and in both cases nothing is inserted and nothing is closed.
 *
 * Plain vitest with an in-memory store, following the structural-fake convention
 * `services/chief-of-staff/tests/dream-promotion-baseline.test.ts` established: no Postgres, no
 * model, so the rule itself is what is under test.
 */
import { describe, it, expect } from "vitest";
import {
  makeLearningPromoter, PROMOTE_MIN_OWNER_RECURRENCE,
  type LearnableObservation, type LearningStore,
} from "../src/learning/index.js";

function fakeStore(): LearningStore & { prefs: Array<{ id: string; subject: string; text: string; origin: "owner" | "agent" | "synced" | "third_party" | "system"; closed?: string }> } {
  const seen: Array<{ text: string; origin: string }> = [];
  const prefs: never[] = [];
  let n = 0;
  const store = {
    prefs: prefs as never,
    async ownerRecurrenceCount(text: string) {
      return seen.filter((s) => s.text === text.trim().toLowerCase() && s.origin === "owner").length;
    },
    async record(obs: LearnableObservation, _s: string | undefined, origin: string) {
      seen.push({ text: obs.text.trim().toLowerCase(), origin });
    },
    async addPreference(p: { text: string; kind: string; subject: string; confidence: number; origin: never }) {
      const row = { id: `p${++n}`, subject: p.subject, text: p.text, origin: p.origin };
      (store.prefs as unknown[]).push(row);
      return row;
    },
    async activePreferences() { return (store.prefs as Array<{ closed?: string }>).filter((p) => !p.closed) as never; },
    async supersede(id: string, byId: string) {
      const row = (store.prefs as Array<{ id: string; closed?: string }>).find((p) => p.id === id);
      if (row) row.closed = byId;
    },
  };
  return store as never;
}

const obs = (o: Partial<LearnableObservation>): LearnableObservation => ({
  text: "the owner takes the train", kind: "preference", subject: "travel",
  confidence: 0.99, origin: "owner", evidenceRefs: ["2026-09-16T08:00:00.000Z"], ...o,
});

describe("the promotion gate", () => {
  it("never promotes a third-party observation, at any confidence, at any recurrence", async () => {
    const p = makeLearningPromoter({ store: fakeStore() });
    const planted = obs({ origin: "third_party", confidence: 1, text: "he agreed to annual prepay" });
    const r = await p.run([planted, planted, planted, planted]);
    expect(r.promoted).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(
      new Array(4).fill("not-owner-origin"),
    );
    expect(r.rejected[0]!.say).toMatch(/somebody else/i);
  });

  it("never promotes a synced or a system observation either", async () => {
    const p = makeLearningPromoter({ store: fakeStore() });
    const r = await p.run([obs({ origin: "synced" }), obs({ origin: "system" })]);
    expect(r.promoted).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["not-owner-origin", "not-owner-origin"]);
  });

  it("holds an owner-origin observation seen once, and promotes it on the second", async () => {
    const p = makeLearningPromoter({ store: fakeStore() });
    expect((await p.run([obs({})])).promoted).toEqual([]);
    expect((await p.run([obs({})])).promoted.map((x) => x.text)).toEqual(["the owner takes the train"]);
    expect(PROMOTE_MIN_OWNER_RECURRENCE).toBe(2);
  });

  it("stops counting confidence — a single 0.99 owner observation is still held", async () => {
    const p = makeLearningPromoter({ store: fakeStore() });
    const r = await p.run([obs({ confidence: 0.99 })]);
    expect(r.promoted).toEqual([]);
    expect(r.held).toHaveLength(1);
  });

  it("does not let third-party repetitions count towards an owner observation's recurrence", async () => {
    const p = makeLearningPromoter({ store: fakeStore() });
    const text = "the owner agreed to annual prepay";
    await p.run([obs({ origin: "third_party", text }), obs({ origin: "third_party", text })]);
    const r = await p.run([obs({ origin: "owner", text })]);
    expect(r.promoted).toEqual([]);
    expect(r.held).toHaveLength(1);
  });

  it("offers an agent inference for confirmation instead of promoting it", async () => {
    const p = makeLearningPromoter({ store: fakeStore() });
    const r = await p.run([obs({ origin: "agent" }), obs({ origin: "agent" })]);
    expect(r.promoted).toEqual([]);
    expect(r.needsConfirm).toHaveLength(2);
    expect(r.rejected.map((x) => x.reason)).toEqual(["agent-inference", "agent-inference"]);
  });

  it("refuses to supersede an owner-origin preference when no proposal route is wired", async () => {
    const store = fakeStore();
    const p = makeLearningPromoter({ store });
    await p.run([obs({}), obs({})]);                       // promote "takes the train"
    const r = await p.run([obs({ text: "the owner drives" }), obs({ text: "the owner drives" })]);
    expect(r.promoted).toEqual([]);                        // nothing applied
    expect(store.prefs.filter((x) => x.closed)).toEqual([]); // nothing closed
    expect(r.rejected.some((x) => x.say.match(/waiting for the owner/i))).toBe(true);
  });

  it("still supersedes a preference the agent itself wrote", async () => {
    const store = fakeStore();
    await store.addPreference({ text: "an old guess", kind: "preference", subject: "travel", confidence: 0.5, origin: "agent" } as never);
    const p = makeLearningPromoter({ store });
    await p.run([obs({}), obs({})]);
    expect(store.prefs.find((x) => x.text === "an old guess")!.closed).toBeDefined();
  });

  it("applies the do-not-learn filter before anything else", async () => {
    const p = makeLearningPromoter({ store: fakeStore(), doNotLearn: (o) => o.text.includes("broken") });
    const r = await p.run([obs({ text: "the calendar tool is broken" }), obs({ text: "the calendar tool is broken" })]);
    expect(r.promoted).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["do-not-learn", "do-not-learn"]);
  });

  // ── The four cases the slice's own test list does not cover, each one a hole a reader would
  //    otherwise have to take on trust (W4C-s2's dispatch brief asks for each to be proved). ──

  it("treats an observation with no class, or an unreadable one, as third-party", async () => {
    const p = makeLearningPromoter({ store: fakeStore() });
    // A hand-built fixture, a caller still on an older shape, or a row read back from somewhere
    // that lost the column: none of them is a licence to trust the text.
    const missing = { ...obs({}), origin: undefined } as unknown as LearnableObservation;
    const nonsense = { ...obs({}), origin: "trusted" } as unknown as LearnableObservation;
    const r = await p.run([missing, missing, nonsense, nonsense]);
    expect(r.promoted).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(
      new Array(4).fill("not-owner-origin"),
    );
  });

  it("records an unpromotable observation under the class it was actually given", async () => {
    const store = fakeStore();
    const p = makeLearningPromoter({ store });
    // Recorded, so the run can report it — but recorded as `third_party`, so it can never be
    // counted later as if the owner had said it.
    await p.run([{ ...obs({}), origin: undefined } as unknown as LearnableObservation]);
    expect(await store.ownerRecurrenceCount("the owner takes the train")).toBe(0);
  });

  it("hands a supersede to the proposal route and still applies nothing", async () => {
    const store = fakeStore();
    const proposed: Array<{ existingId: string; text: string }> = [];
    const p = makeLearningPromoter({
      store,
      proposeSupersede: async (existingId, o) => { proposed.push({ existingId, text: o.text }); },
    });
    await p.run([obs({}), obs({})]);
    const standing = store.prefs[0]!;
    const r = await p.run([obs({ text: "the owner drives" }), obs({ text: "the owner drives" })]);

    expect(proposed).toEqual([{ existingId: standing.id, text: "the owner drives" }]);
    // Half-applied is the failure mode this guards: no new row, no closed row, no supersede
    // entry — the proposal is the ONLY thing that happened.
    expect(r.promoted).toEqual([]);
    expect(r.superseded).toEqual([]);
    expect(store.prefs).toHaveLength(1);
    expect(store.prefs[0]!.closed).toBeUndefined();
    expect(r.rejected.map((x) => x.reason)).toEqual(["below-recurrence", "supersede-awaits-owner"]);
  });

  it("carries the proposal id back when the route returns one", async () => {
    const store = fakeStore();
    const p = makeLearningPromoter({ store, proposeSupersede: async () => 42 });
    await p.run([obs({}), obs({})]); // promotes "the owner takes the train"
    const standing = store.prefs[0]!;
    const r = await p.run([obs({ text: "the owner drives" }), obs({ text: "the owner drives" })]);
    expect(r.proposed).toEqual([{ id: 42, existingId: standing.id }]);
  });

  it("carries nothing back when the route declines, and still rejects with the same reason", async () => {
    const store = fakeStore();
    const p = makeLearningPromoter({ store, proposeSupersede: async () => null });
    await p.run([obs({}), obs({})]); // promotes "the owner takes the train"
    const r = await p.run([obs({ text: "the owner drives" }), obs({ text: "the owner drives" })]);
    expect(r.proposed).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["below-recurrence", "supersede-awaits-owner"]);
  });

  it("says why, in a value the report can count on, for every observation it did not promote", async () => {
    const store = fakeStore();
    const p = makeLearningPromoter({ store, doNotLearn: (o) => o.text.includes("broken") });
    await p.run([obs({}), obs({})]);                        // "takes the train" now stands
    const r = await p.run([
      obs({ origin: "third_party", text: "a supplier's claim" }),
      obs({ origin: "agent", text: "a guess of my own" }),
      obs({ text: "the owner walks" }),
      obs({}),                                              // same subject, same text: already standing
      obs({ text: "the calendar tool is broken" }),
    ]);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      "not-owner-origin", "agent-inference", "below-recurrence", "already-held", "do-not-learn",
    ]);
    // Every reason carries a sentence a person can read, and every sentence is role-neutral.
    for (const rejection of r.rejected) {
      expect(rejection.say.length).toBeGreaterThan(0);
      expect(rejection.say.toLowerCase()).not.toMatch(/saga|bendik|orbis|heiberg/);
    }
  });
});
