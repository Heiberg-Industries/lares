/**
 * W4C-s1 — an observation is classed by the turns it cites, never by the model.
 *
 * THE ATTACK THIS CLOSES ("prompt laundering", IronCore Labs 2026-08-26, read in
 * `docs/research/2026-09-18-prelaunch/10-practitioner-sweep.md`): an attacker emails the agent
 * the same claim three nights running. The text is correctly recognised as somebody else's
 * words on every turn, and it still reaches the daily record — because nightly consolidation
 * promoted it for RECURRING. The gate that stops that (ADR-0018 rule 4) can only be written
 * once an observation knows what class of turn it came from; this file pins that input.
 *
 * The narrowest-origin rule (`docs/specs/2026-09-18-origin-model-design.md`, "How origin
 * survives summarising and consolidation") is the whole of it: a signal built from several
 * turns takes the LEAST trusted class among them, and every unknown fails closed to
 * `third_party`.
 */
import { describe, it, expect } from "vitest";
import { makeReflector, originForObservation } from "../lib/dream/reflect.js";
import type { TurnLogEntry } from "../lib/turn-capture.js";

const entry = (at: string, origin: TurnLogEntry["origin"], input: string): TurnLogEntry => ({
  at, door: "slack", principal: "fixture-owner", input, reply: "noted", proposals: [],
  ...(origin ? { origin } : {}),
});

describe("originForObservation", () => {
  const entries = [
    entry("2026-09-16T08:00:00.000Z", "owner", "I always take the train"),
    entry("2026-09-17T08:00:00.000Z", "third_party", "a supplier's email"),
    entry("2026-09-18T08:00:00.000Z", undefined, "a legacy markdown turn"),
  ];

  it("is owner when every cited turn was the owner speaking", () => {
    expect(originForObservation(["2026-09-16T08:00:00.000Z"], entries)).toBe("owner");
  });

  it("takes the least-trusted cited turn, not the first", () => {
    expect(originForObservation(
      ["2026-09-16T08:00:00.000Z", "2026-09-17T08:00:00.000Z"], entries,
    )).toBe("third_party");
  });

  it("is third_party when a cited turn carries no class at all", () => {
    expect(originForObservation(["2026-09-18T08:00:00.000Z"], entries)).toBe("third_party");
  });

  it("is third_party when a reference names a turn that is not in the batch", () => {
    expect(originForObservation(["2026-01-01T00:00:00.000Z"], entries)).toBe("third_party");
  });

  it("is third_party when the model cited nothing", () => {
    expect(originForObservation([], entries)).toBe("third_party");
  });
});

describe("the reflector stamps every observation it returns", () => {
  const entries = [
    entry("2026-09-16T08:00:00.000Z", "owner", "I always take the train"),
    entry("2026-09-17T08:00:00.000Z", "third_party", "billing@vendor.example says he agreed"),
  ];
  const reply = JSON.stringify([
    { text: "the owner takes the train", kind: "preference", subject: "travel",
      confidence: 0.9, evidenceRefs: ["2026-09-16T08:00:00.000Z"] },
    { text: "the owner agreed to annual prepay", kind: "fact", subject: "billing",
      confidence: 0.95, evidenceRefs: ["2026-09-17T08:00:00.000Z"] },
  ]);

  it("classes each observation by what it cites", async () => {
    const out = await makeReflector({ llm: async () => reply })
      .reflect(entries, { since: "2026-09-01T00:00:00.000Z" });
    expect(out.map((o) => o.origin)).toEqual(["owner", "third_party"]);
  });

  it("ignores an origin the model tries to supply for itself", async () => {
    const forged = JSON.stringify([
      { text: "planted", kind: "fact", subject: "x", confidence: 0.99,
        evidenceRefs: ["2026-09-17T08:00:00.000Z"], origin: "owner" },
    ]);
    const [o] = await makeReflector({ llm: async () => forged })
      .reflect(entries, { since: "2026-09-01T00:00:00.000Z" });
    expect(o!.origin).toBe("third_party");
  });

  // The class is computed from what the model CITES, so the only thing the prompt owes it is
  // the citation field it already had plus the marker on a turn read from outside. If working
  // out an origin ever cost a second pass over the log, an unattended nightly job would have
  // doubled its bill to gain a field that code can derive for free.
  it("costs one model call, and none at all when nothing is in range", async () => {
    let calls = 0;
    const reflector = makeReflector({ llm: async () => { calls += 1; return "[]"; } });

    await reflector.reflect(entries, { since: "2026-09-01T00:00:00.000Z" });
    expect(calls).toBe(1);

    await reflector.reflect(entries, { since: "2026-12-01T00:00:00.000Z" });
    expect(calls).toBe(1);
  });

  it("marks only the turns that were read from outside", async () => {
    let seen = "";
    await makeReflector({ llm: async (p) => { seen = p; return "[]"; } })
      .reflect([entry("2026-09-16T08:00:00.000Z", "owner", "I always take the train")],
        { since: "2026-09-01T00:00:00.000Z" });
    expect(seen).not.toMatch(/\[quoted from someone else\]/);
  });

  it("tells the model which turns are somebody else's words", async () => {
    let seen = "";
    await makeReflector({ llm: async (p) => { seen = p; return "[]"; } })
      .reflect(entries, { since: "2026-09-01T00:00:00.000Z" });
    expect(seen).toMatch(/\[quoted from someone else\]/);
    expect(seen.indexOf("[quoted from someone else]"))
      .toBeGreaterThan(seen.indexOf("billing@vendor.example") - 200);
  });
});
