import { describe, it, expect } from "vitest";

import { makeRouteEngine, PROPOSAL_COOLDOWN_DAYS } from "../lib/route-engine.js";
import type { RouteDecision } from "../lib/route-classify.js";

/**
 * Routing hygiene — three rules the engine lacked on 2026-09-07, each paid for that weekend:
 *
 *  - Kai (a colleague on project.example) was proposed as a prospect three mornings running, under two
 *    brands. Only Bendik's OWN addresses were excluded; the org's domains were not.
 *  - Every daily digest email is a new message id, so the per-(person, message) dedup let the
 *    same person re-surface every day; a card Bendik cancelled left no trace the engine reads.
 *  - Finago's existing ORAKEL opportunity sat at QUALIFIED and the engine offered CONTACTED,
 *    because it never compared the proposed stage with the current one.
 *
 * The engine is shared Lares code, so every rule here is driven by per-install DATA passed in
 * (org domains, the store's memory) or by the pipeline's own order — never a Heiberg literal.
 */

const NOW = new Date("2026-09-08T07:00:00Z");
const AT = "2026-09-08T06:30:00Z";

type Participant = { personId: string | null; messageId: string; handle: string; role: string; createdAt: string };
type Opp = { id: string; name: string; stage: string; brand: string };

function fakes(opts: {
  participants?: Participant[];
  decision?: RouteDecision;
  opps?: Opp[];
  proposedSince?: (args: { personId: string; brand: string; sinceIso: string }) => boolean;
}) {
  const classifyCalls: unknown[] = [];
  const proposedSinceCalls: Array<{ personId: string; brand: string; sinceIso: string }> = [];
  const twenty = {
    listRecentMessageParticipants: async () => opts.participants ?? [],
    listRecentCalendarParticipants: async () => [],
    getMessage: async () => ({ subject: "Re: Orakel", text: "hei — data for kommunene", receivedAt: AT }),
    getCalendarEvent: async () => ({ title: "", description: "", startsAt: AT }),
    listOpportunitiesForPerson: async () => opts.opps ?? [],
    getPersonName: async () => "Kai",
  };
  const classifier = {
    classify: async (input: unknown): Promise<RouteDecision> => {
      classifyCalls.push(input);
      return opts.decision ?? { brand: "ORAKEL", stage: "NEW", action: "create", confidence: 0.9, reasoning: "keyword overlap" };
    },
  };
  const store = {
    getCursor: async () => null,
    setCursor: async () => {},
    alreadyProposed: async () => false,
    proposedSince: async (args: { personId: string; brand: string; sinceIso: string }) => {
      proposedSinceCalls.push(args);
      return opts.proposedSince ? opts.proposedSince(args) : false;
    },
  };
  return { twenty, classifier, store, classifyCalls, proposedSinceCalls };
}

const external: Participant = { personId: "p-ext", messageId: "m1", handle: "jonas@finago.com", role: "from", createdAt: AT };
const colleague: Participant = { personId: "p-kai", messageId: "m2", handle: "Kai@project.example", role: "from", createdAt: AT };

describe("route engine — the org's own domains are never prospects", () => {
  it("baseline: an external sender with a clear signal yields one create proposal", async () => {
    const f = fakes({ participants: [external] });
    const engine = makeRouteEngine({ ...f, clock: () => NOW, internalDomains: ["project.example"] });
    const out = await engine.scan();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ personId: "p-ext", action: "create", stage: "NEW", brand: "ORAKEL" });
  });

  it("a participant on one of the org's domains is skipped before the classifier ever runs (case-insensitive)", async () => {
    const f = fakes({ participants: [colleague] });
    const engine = makeRouteEngine({ ...f, clock: () => NOW, internalDomains: ["project.example", "owner.example"] });
    expect(await engine.scan()).toEqual([]);
    expect(f.classifyCalls).toHaveLength(0);
  });

  it("with no org domains configured, behaviour is unchanged — nothing is silently excluded", async () => {
    const f = fakes({ participants: [colleague] });
    const engine = makeRouteEngine({ ...f, clock: () => NOW });
    expect(await engine.scan()).toHaveLength(1);
  });
});

describe("route engine — one proposal per person and brand per cool-down", () => {
  it("skips a person already proposed for this brand within the cool-down, and asks the store with the right window", async () => {
    const f = fakes({ participants: [external], proposedSince: () => true });
    const engine = makeRouteEngine({ ...f, clock: () => NOW, internalDomains: [] });
    expect(await engine.scan()).toEqual([]);
    expect(f.proposedSinceCalls).toHaveLength(1);
    const call = f.proposedSinceCalls[0]!;
    expect(call.personId).toBe("p-ext");
    expect(call.brand).toBe("ORAKEL");
    const expectedSince = new Date(NOW.getTime() - PROPOSAL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
    expect(call.sinceIso).toBe(expectedSince);
  });

  it("the cool-down is per brand — the same person may still be proposed for a different brand", async () => {
    const f = fakes({
      participants: [external],
      decision: { brand: "ZERO7", stage: "NEW", action: "create", confidence: 0.9, reasoning: "zero7 demo" },
      proposedSince: (a) => a.brand === "ORAKEL",
    });
    const engine = makeRouteEngine({ ...f, clock: () => NOW, internalDomains: [] });
    expect(await engine.scan()).toHaveLength(1);
  });

  it("the cool-down is fourteen days", () => {
    expect(PROPOSAL_COOLDOWN_DAYS).toBe(14);
  });
});

describe("route engine — a move is only ever forward in the pipeline", () => {
  const qualified: Opp = { id: "opp-1", name: "ORAKEL — Finago", stage: "QUALIFIED", brand: "ORAKEL" };

  it("never proposes a stage at or before the opportunity's current one", async () => {
    for (const stage of ["NEW", "CONTACTED", "MEETING", "QUALIFIED"] as const) {
      const f = fakes({
        participants: [external],
        opps: [qualified],
        decision: { brand: "ORAKEL", stage, action: "move", confidence: 0.9, reasoning: "reply on the thread" },
      });
      const engine = makeRouteEngine({ ...f, clock: () => NOW, internalDomains: [] });
      expect(await engine.scan(), stage).toEqual([]);
    }
  });

  it("still proposes a genuine forward move", async () => {
    const f = fakes({
      participants: [external],
      opps: [qualified],
      decision: { brand: "ORAKEL", stage: "PROPOSAL", action: "move", confidence: 0.9, reasoning: "they asked for terms" },
    });
    const engine = makeRouteEngine({ ...f, clock: () => NOW, internalDomains: [] });
    const out = await engine.scan();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ action: "move", opportunityId: "opp-1", stage: "PROPOSAL" });
  });
});
