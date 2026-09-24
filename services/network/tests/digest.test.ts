import { describe, it, expect, beforeEach } from "vitest";
import { isoWeekOf, composeDigest, fetchPipelineCompanies, renderDigest, runDigest } from "../lib/digest.js";
import { openDb, type Db } from "../lib/db.js";
import { upsertContact } from "../lib/resolve.js";
import type { SlackMessage } from "../lib/slack.js";

const NOW = new Date("2026-06-11T09:30:00Z");

/** Pulse rows are inserted directly — these tests pin band/dormant flags; scoring has its own suite. */
function seedDb(): Db {
  const db = openDb(":memory:");
  // Warm + active contact at DNB (warm-path candidate, not dormant)
  const kari = upsertContact(db, { displayName: "Kari Nordmann", company: "DNB", title: "Head of Data", source: "test", identities: [{ kind: "email", value: "kari@dnb.no" }] });
  // Once-warm contact gone quiet (reactivation queue)
  const peter = upsertContact(db, { displayName: "Peter Karlsson", company: "Curamando", title: "Consultant", source: "test", identities: [{ kind: "phone", value: "+4798212345" }] });
  const insPulse = db.prepare("INSERT INTO pulse (contact_id, score, band, dormant_warm, last_interaction_at, components) VALUES (?, ?, ?, ?, ?, '{}')");
  insPulse.run(kari, 80, "STRONG", 0, new Date(NOW.getTime() - 3 * 86_400_000).toISOString());
  insPulse.run(peter, 55, "GOOD", 1, "2025-11-02T10:00:00Z");
  const insSig = db.prepare("INSERT INTO signals (contact_id, kind, at, evidence) VALUES (?, ?, ?, ?)");
  // A fresh job-change signal and an old one outside the 14-day default window
  insSig.run(kari, "job_change", new Date(NOW.getTime() - 2 * 86_400_000).toISOString(), JSON.stringify({ from: "Telenor", to: "DNB" }));
  insSig.run(kari, "job_change", new Date(NOW.getTime() - 60 * 86_400_000).toISOString(), JSON.stringify({ from: "Old", to: "Telenor" }));
  // cadence_break must be excluded from the signals section
  insSig.run(peter, "cadence_break", new Date(NOW.getTime() - 1 * 86_400_000).toISOString(), JSON.stringify({ band: "GOOD" }));
  return db;
}

describe("composeDigest", () => {
  let db: Db;
  beforeEach(() => { db = seedDb(); });

  it("collects reactivation queue, fresh signals (no cadence_break), warm paths", () => {
    const d = composeDigest(db, { now: NOW, pipeline: [{ name: "DNB", stage: "PROPOSAL" }, { name: "Telia", stage: "MEETING" }] });
    expect(d.isoWeek).toBe("2026-W24");
    expect(d.reactivate.map((r) => r.displayName)).toContain("Peter Karlsson");
    expect(d.signals).toHaveLength(1); // 14-day default window drops the old one; cadence_break excluded
    expect(d.signals[0]).toMatchObject({ displayName: "Kari Nordmann", kind: "job_change" });
    const dnb = d.warmPaths.find((w) => w.company === "DNB")!;
    expect(dnb.contacts.map((c) => c.displayName)).toContain("Kari Nordmann");
    expect(d.warmPaths.find((w) => w.company === "Telia")!.contacts).toHaveLength(0);
  });

  it("uses the previous digest's posted_at as the signal window start", () => {
    db.prepare("INSERT INTO digest_runs (iso_week, posted_at, summary) VALUES ('2026-W23', ?, '{}')")
      .run(new Date(NOW.getTime() - 1 * 86_400_000).toISOString());
    const d = composeDigest(db, { now: NOW, pipeline: [] });
    expect(d.signals).toHaveLength(0); // job_change at NOW-2d predates the W23 post at NOW-1d
  });
});

describe("fetchPipelineCompanies", () => {
  it("keeps open stages, resolves company names, dedups, falls back to the opportunity name", async () => {
    const twenty = {
      listOpportunities: async () => [
        { id: "o1", name: "DNB pilot", stage: "PROPOSAL", companyId: "c1" },
        { id: "o2", name: "DNB expansion", stage: "MEETING", companyId: "c1" },
        { id: "o3", name: "Telia intro", stage: "NEW", companyId: null },
        { id: "o4", name: "Done deal", stage: "CUSTOMER", companyId: "c2" },
        { id: "o5", name: "Lost deal", stage: "LOST", companyId: "c3" },
      ],
      getCompanyName: async (id: string) => (id === "c1" ? "DNB" : null),
    };
    expect(await fetchPipelineCompanies(twenty)).toEqual([
      { name: "DNB", stage: "PROPOSAL" },
      { name: "Telia intro", stage: "NEW" },
    ]);
  });
});

describe("renderDigest", () => {
  it("renders all three sections in Slack mrkdwn", () => {
    const text = renderDigest({
      isoWeek: "2026-W24",
      reactivate: [{ displayName: "Peter Karlsson", company: "Curamando", lastInteractionAt: "2025-11-02T10:00:00Z" }],
      signals: [{ displayName: "Kari Nordmann", kind: "job_change", at: "2026-06-09T08:00:00Z", evidence: '{"from":"Telenor","to":"DNB"}' }],
      warmPaths: [
        { company: "DNB", stage: "PROPOSAL", contacts: [{ displayName: "Kari Nordmann", band: "STRONG" }] },
        { company: "Telia", stage: "MEETING", contacts: [] },
      ],
    });
    expect(text).toContain("*Network digest — 2026-W24*");
    expect(text).toContain("Peter Karlsson (Curamando) — last contact 2025-11-02");
    expect(text).toContain("Job change: Kari Nordmann — Telenor → DNB (2026-06-09)");
    expect(text).toContain("*DNB* (Proposal): Kari Nordmann (STRONG)");
    expect(text).toContain("*Telia* (Meeting): no warm path yet");
  });

  it("renders a short all-quiet message when every section is empty", () => {
    const text = renderDigest({ isoWeek: "2026-W24", reactivate: [], signals: [], warmPaths: [] });
    expect(text).toContain("Nothing needs attention this week.");
  });

  it("omits empty sections when others have content", () => {
    const text = renderDigest({
      isoWeek: "2026-W24",
      reactivate: [{ displayName: "Peter Karlsson", company: null, lastInteractionAt: null }],
      signals: [],
      warmPaths: [],
    });
    expect(text).not.toContain("*Fresh signals*");
    expect(text).not.toContain("*Warm paths");
    expect(text).toContain("Peter Karlsson — last contact unknown");
  });
});

describe("isoWeekOf", () => {
  it("computes ISO week with year boundary handling", () => {
    expect(isoWeekOf(new Date("2026-06-11T09:30:00Z"))).toBe("2026-W24");
    expect(isoWeekOf(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01"); // Jan 1 2026 is a Thursday
    expect(isoWeekOf(new Date("2025-12-29T00:00:00Z"))).toBe("2026-W01"); // Monday belonging to next ISO year
    expect(isoWeekOf(new Date("2026-01-04T00:00:00Z"))).toBe("2026-W01"); // Sunday closes week 1
    expect(isoWeekOf(new Date("2026-01-05T00:00:00Z"))).toBe("2026-W02");
  });
});

describe("runDigest", () => {
  let db: Db;
  let posted: SlackMessage[];
  const post = async (msg: SlackMessage) => { posted.push(msg); };

  beforeEach(() => { db = seedDb(); posted = []; });

  it("posts once per ISO week and records the run", async () => {
    const first = await runDigest(db, { channel: "#heiberg-ops", now: NOW, dryRun: false, twenty: null, post });
    expect(first.status).toBe("posted");
    expect(first.isoWeek).toBe("2026-W24");
    expect(posted).toHaveLength(1);
    expect(posted[0].channel).toBe("#heiberg-ops");
    expect(posted[0].text).toContain("2026-W24");

    const second = await runDigest(db, { channel: "#heiberg-ops", now: NOW, dryRun: false, twenty: null, post });
    expect(second.status).toBe("already-posted");
    expect(posted).toHaveLength(1);

    const run = db.prepare("SELECT iso_week, posted_at, summary FROM digest_runs WHERE iso_week = '2026-W24'").get() as any;
    expect(JSON.parse(run.summary)).toMatchObject({ reactivate: 1, signals: 1, warmPaths: 0 });
    expect(run.posted_at).toBe(NOW.toISOString()); // lexicographic-compare convention with signals.at
  });

  it("dry-run composes but neither posts nor records", async () => {
    const r = await runDigest(db, { channel: "#heiberg-ops", now: NOW, dryRun: true, twenty: null, post });
    expect(r.status).toBe("dry-run");
    expect(r.text).toContain("Peter Karlsson");
    expect(posted).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM digest_runs").get()).toEqual({ n: 0 });
  });

  it("does not record the week when posting throws (retry next launchd run)", async () => {
    const failing = async () => { throw new Error("slack down"); };
    await expect(runDigest(db, { channel: "#x", now: NOW, dryRun: false, twenty: null, post: failing })).rejects.toThrow("slack down");
    expect(db.prepare("SELECT COUNT(*) AS n FROM digest_runs").get()).toEqual({ n: 0 });
  });

  it("includes warm paths from Twenty when a client is provided", async () => {
    const twenty = {
      listOpportunities: async () => [{ id: "o1", name: "DNB pilot", stage: "PROPOSAL", companyId: null }],
      getCompanyName: async () => null,
    };
    const r = await runDigest(db, { channel: "#x", now: NOW, dryRun: true, twenty, post });
    expect(r.text).toContain("*DNB pilot* (Proposal)");
  });

  it("posts the local sections with a visible warning when Twenty is unreachable", async () => {
    const twenty = {
      listOpportunities: async () => { throw new Error("ECONNREFUSED"); },
      getCompanyName: async () => null,
    };
    const r = await runDigest(db, { channel: "#x", now: NOW, dryRun: false, twenty, post });
    expect(r.status).toBe("posted");
    expect(posted).toHaveLength(1);
    expect(posted[0].text).toContain("Peter Karlsson"); // local sections survive
    expect(posted[0].text).toContain("Twenty was unreachable");
    expect(db.prepare("SELECT COUNT(*) AS n FROM digest_runs").get()).toEqual({ n: 1 });
  });
});
