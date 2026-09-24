/**
 * Tests for the local same-name dedup planner (lib/dedup.ts).
 * Db is in-memory — never ~/.lares/network.db.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../lib/db.js";
import { upsertContact, linkToTwenty, findContactByIdentity } from "../lib/resolve.js";
import { planDedup, applyDedup } from "../lib/dedup.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("planDedup", () => {
  it("plans a merge for a complementary two-fragment cluster (phone + linkedin)", () => {
    const phoneSide = upsertContact(db, { displayName: "Kari Nordmann", source: "contacts", identities: [{ kind: "phone", value: "+4790000001" }] });
    const liSide = upsertContact(db, { displayName: "Kari Nordmann", source: "linkedin", identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/karinordmann" }] });

    const plan = planDedup(db);

    expect(plan.held).toEqual([]);
    expect(plan.merges).toHaveLength(1);
    // the phone side (richer, you have their number) survives
    expect(plan.merges[0]).toMatchObject({ survivorId: phoneSide, fromId: liSide });
  });

  it("holds a cluster where both fragments have different phone numbers", () => {
    upsertContact(db, { displayName: "Ola Hansen", source: "contacts", identities: [{ kind: "phone", value: "+4790000010" }] });
    upsertContact(db, { displayName: "Ola Hansen", source: "contacts2", identities: [{ kind: "phone", value: "+4790000011" }] });

    const plan = planDedup(db);

    expect(plan.merges).toEqual([]);
    expect(plan.held).toHaveLength(1);
    expect(plan.held[0]!.reason).toMatch(/phone/i);
  });

  it("holds a cluster where both fragments have different LinkedIn URLs", () => {
    upsertContact(db, { displayName: "Per Berg", source: "linkedin", identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/perberg1" }] });
    upsertContact(db, { displayName: "Per Berg", source: "linkedin2", identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/perberg2" }] });

    const plan = planDedup(db);

    expect(plan.merges).toEqual([]);
    expect(plan.held[0]!.reason).toMatch(/linkedin/i);
  });

  it("holds clusters with three or more fragments", () => {
    upsertContact(db, { displayName: "Mette Lie", source: "contacts", identities: [{ kind: "phone", value: "+4790000020" }] });
    upsertContact(db, { displayName: "Mette Lie", source: "linkedin", identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/mettelie" }] });
    upsertContact(db, { displayName: "Mette Lie", source: "instagram", identities: [{ kind: "instagram", value: "mettelie" }] });

    const plan = planDedup(db);

    expect(plan.merges).toEqual([]);
    expect(plan.held).toHaveLength(1);
    expect(plan.held[0]!.ids).toHaveLength(3);
    expect(plan.held[0]!.reason).toMatch(/3\+|three|fragments/i);
  });

  it("keeps the already-Twenty-linked fragment as the survivor", () => {
    const liSide = upsertContact(db, { displayName: "Nils Vik", source: "linkedin", identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/nilsvik" }] });
    const linkedSide = upsertContact(db, { displayName: "Nils Vik", source: "contacts", identities: [{ kind: "email", value: "nils@vik.no" }] });
    linkToTwenty(db, linkedSide, "tw-nils");

    const plan = planDedup(db);

    expect(plan.merges).toHaveLength(1);
    expect(plan.merges[0]).toMatchObject({ survivorId: linkedSide, fromId: liSide });
  });

  it("holds a cluster where the two fragments are linked to different Twenty people", () => {
    const a = upsertContact(db, { displayName: "Eva Sand", source: "contacts", identities: [{ kind: "email", value: "eva@a.no" }] });
    const b = upsertContact(db, { displayName: "Eva Sand", source: "linkedin", identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/evasand" }] });
    linkToTwenty(db, a, "tw-eva-1");
    linkToTwenty(db, b, "tw-eva-2");

    const plan = planDedup(db);

    expect(plan.merges).toEqual([]);
    expect(plan.held[0]!.reason).toMatch(/twenty/i);
  });

  it("ignores unique names entirely", () => {
    upsertContact(db, { displayName: "Solo Person", source: "contacts", identities: [{ kind: "phone", value: "+4790000099" }] });

    const plan = planDedup(db);

    expect(plan.merges).toEqual([]);
    expect(plan.held).toEqual([]);
  });
});

describe("applyDedup", () => {
  it("executes the planned merges and returns the count", () => {
    const phoneSide = upsertContact(db, { displayName: "Kari Nordmann", source: "contacts", identities: [{ kind: "phone", value: "+4790000001" }] });
    const liSide = upsertContact(db, { displayName: "Kari Nordmann", source: "linkedin", identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/karinordmann" }] });

    const plan = planDedup(db);
    const merged = applyDedup(db, plan);

    expect(merged).toBe(1);
    // both identities now live on the survivor
    expect(findContactByIdentity(db, "linkedin_url", "https://www.linkedin.com/in/karinordmann")).toBe(phoneSide);
    expect(findContactByIdentity(db, "phone", "+4790000001")).toBe(phoneSide);
    // the from-fragment is gone
    expect(db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE id = ?").get(liSide)).toEqual({ n: 0 });
  });
});
