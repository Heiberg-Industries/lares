import { describe, expect, it } from "vitest";
import {
  DELIVERY_KINDS, configuredDoors, defaultDelivery, deliveryFindings, routeFor,
} from "../src/delivery.js";
import { hashOf, parseDefinition } from "../src/definition.js";
import { validateDefinition } from "../src/definition-validate.js";

const only = (...doors: string[]) => (d: string) => doors.includes(d);

describe("routeFor", () => {
  it("an agent with no map tries today's door first, then web chat with a note", () => {
    expect(routeFor("morning-brief", undefined, only("telegram")).door).toBe("telegram");
    expect(routeFor("email-triage", undefined, only("slack")).door).toBe("slack");
    expect(routeFor("morning-brief", undefined, only("telegram")).fallbackNote).toBeNull();
    const r = routeFor("morning-brief", undefined, only("slack"), "Morning brief");
    expect(r.door).toBe("web");
    expect(r.fallbackNote).toBe("Morning brief went to web chat: Telegram is not connected");
  });

  it("every kind has today's door when nothing is mapped", () => {
    for (const [kind, door] of Object.entries(DELIVERY_KINDS)) {
      expect(configuredDoors(kind as keyof typeof DELIVERY_KINDS, undefined)).toEqual([door]);
    }
  });

  it("takes the first connected door in the owner's order", () => {
    const delivery = { "morning-brief": ["slack", "telegram"] };
    expect(routeFor("morning-brief", delivery, only("slack", "telegram")).door).toBe("slack");
    const r = routeFor("morning-brief", delivery, only("telegram"));
    expect(r.door).toBe("telegram");
    expect(r.fallbackNote).toBe("morning-brief went to Telegram: Slack is not connected");
  });

  it("falls through to web chat, always, and says why", () => {
    const r = routeFor("morning-brief", { "morning-brief": ["telegram"] }, only(), "Morning brief");
    expect(r.door).toBe("web");
    expect(r.fallbackNote).toBe("Morning brief went to web chat: Telegram is not connected");
  });

  it("a first-choice send carries no fallback note", () => {
    expect(routeFor("digest", { digest: ["web"] }, only()).fallbackNote).toBeNull();
    expect(routeFor("digest", { digest: ["slack", "web"] }, only("slack")).fallbackNote).toBeNull();
  });

  it("a kind missing from a present map still means today's door", () => {
    expect(routeFor("digest", { "morning-brief": ["web"] }, only("slack")).door).toBe("slack");
  });
});

describe("defaultDelivery", () => {
  it("first connected chat door, then web chat; web alone when none", () => {
    expect(defaultDelivery(["slack", "telegram"])["morning-brief"]).toEqual(["slack", "web"]);
    expect(defaultDelivery([])["digest"]).toEqual(["web"]);
    expect(Object.keys(defaultDelivery(["telegram"])).sort()).toEqual(Object.keys(DELIVERY_KINDS).sort());
  });
});

describe("delivery in a definition", () => {
  const raw = {
    name: "chief", display: "Chief", model: "lares-utility", persona: "agent/instructions.md", role: "chief-of-staff",
  };
  const base = (delivery?: Record<string, string[]>) => parseDefinition({ ...raw, ...(delivery ? { delivery } : {}) });
  const check = (delivery: Record<string, string[]>) =>
    validateDefinition({ definition: base(delivery), roleMd: "", deployedTools: [] }).filter((f) => f.check === "delivery");

  it("adding the optional field changes no existing hash", () => {
    const loaded = { dutiesMd: "", voiceMd: "" };
    expect("delivery" in base()).toBe(false);
    expect(hashOf({ definition: base(), ...loaded })).toBe(hashOf({ definition: parseDefinition(raw), ...loaded }));
  });

  it("accepts a valid map", () => {
    expect(check({ "morning-brief": ["telegram", "web"], reminders: ["web"] })).toEqual([]);
  });

  it("refuses an unknown kind, an unknown door, an empty list and a repeat", () => {
    expect(check({ nonsense: ["web"] })[0]?.message).toMatch(/not a kind/);
    expect(check({ digest: ["sms"] })[0]?.message).toMatch(/not a door/);
    expect(check({ digest: [] })[0]?.message).toMatch(/at least one/);
    expect(check({ digest: ["slack", "slack"] })[0]?.message).toMatch(/twice/);
  });

  it("deliveryFindings accepts an absent map", () => {
    expect(deliveryFindings(undefined)).toEqual([]);
  });
});
