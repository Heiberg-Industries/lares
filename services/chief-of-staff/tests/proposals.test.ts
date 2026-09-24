import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { getPool, closePool } from "@lares/agent-kit/db";
import {
  insertProposal,
  getOpenProposals,
  resolveProposal,
  getUnannouncedProposals,
  markProposalAnnounced,
  approveConsequence,
  rejectConsequence,
  insertAtlasProposal,
  getOpenAtlasProposals,
  resolveAtlasProposal,
  getUnannouncedAtlasProposals,
  markAtlasProposalAnnounced,
  getUnannouncedMemoryProposals,
  markMemoryProposalAnnounced,
  atlasApproveConsequence,
  atlasRejectConsequence,
} from "../lib/proposals-store.js";
import { UnauthorizedApproverError } from "../lib/approvals.js";
import { scheduleGate } from "@lares/agent-kit/schedule-gate";

import notionProposals from "../catalogue/notion_proposals.js";
import notionResolveProposal from "../catalogue/notion_resolve_proposal.js";
import atlasProposals from "../catalogue/atlas_proposals.js";
import atlasResolveProposal from "../catalogue/atlas_resolve_proposal.js";
import {
  makeProposalsWatchTick,
  freshState,
  buildNotionProposalsPrompt,
  buildAtlasProposalsPrompt,
  type ProposalsWatchStore,
  type ProposalsWatchDoor,
} from "../agent/schedules/proposals-watch.js";
import type { ProposalRow, AtlasUnannouncedRow } from "../lib/proposals-store.js";
import { PROPOSALS_SCHEMA } from "./helpers/proposals-schema.js";

/**
 * Task 11 — Notion + Atlas proposal tools and watch schedule.
 *
 * Layers, per the brief's Step 1:
 *   1. lib/proposals-store.ts against a REAL Postgres (testcontainer, ORB-45 pattern) — the
 *      tables already exist on the box's shared lares_state database (services/box/sql
 *      015-019), replicated here for the disposable test instance.
 *   2. The `announced_at IS NULL` guard — the multi-tick defect class ("the Notion sync
 *      work") — proven by running the announce-and-stamp cycle TWICE against the same DB
 *      state, at both the store level and through the schedule's own tick().
 *   3. The four tools: list tools read-only; resolve tools refuse an unapproved/wrong-channel
 *      approver BEFORE any DB write, and write the right decision for a valid approver. Input
 *      is the plan's literal `{id, decision}` — no path field — so a stale/wrong id is caught
 *      only by resolveProposal/resolveAtlasProposal's own atomicity (throws on a non-open id).
 *   4. agent/schedules/proposals-watch.ts's makeProposalsWatchTick, offline via fake
 *      store/door: one batched send per lane, stamp-only-after-send, single-flight guard,
 *      one lane's failure not blocking the other.
 */

const BENDIK = "U_EXAMPLE_OWNER";
const SOMEONE_ELSE = "U0BADBADBAD";

function slackAuth(userId: string) {
  return {
    attributes: { user_id: userId, channel_id: "D123", thread_ts: "1.0" },
    authenticator: "slack-webhook",
    principalId: `slack:T1:${userId}`,
    principalType: "user",
  };
}

function ctx(auth: unknown) {
  return { session: { id: "wrun_test", auth: { current: auth, initiator: auth } } } as never;
}

const READ_CTX = {} as never;

// ─── Schema (mirrors services/box/sql/015-019) ──────────────────────────────────────
// Moved to tests/helpers/proposals-schema.ts (ORB-175 Task 4) so
// tests/schedule-heartbeat-wiring.test.ts can share the same mirror rather than a second copy.

describe("proposals (Task 11)", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const pool = getPool({ DATABASE_URL: container.getConnectionUri() } as NodeJS.ProcessEnv);
    await pool.query(PROPOSALS_SCHEMA);
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
  });

  afterEach(async () => {
    const pool = getPool();
    await pool.query("DELETE FROM notion_sync_proposals");
    await pool.query("DELETE FROM notion_sync_docs");
    await pool.query("DELETE FROM atlas_proposals");
    await pool.query("DELETE FROM atlas_notes");
  });

  // ── 1. lib/proposals-store.ts — Notion side ───────────────────────────────────────────

  describe("notion proposal store", () => {
    async function seedDoc(vaultPath: string, direction: "two_way" | "md_to_notion" | "notion_to_md") {
      await getPool().query(
        `INSERT INTO notion_sync_docs (vault_path, notion_page_id, target, direction)
         VALUES ($1, $2, 'docs', $3)`,
        [vaultPath, `page-${vaultPath}`, direction],
      );
    }

    it("insertProposal + getOpenProposals round-trips, joining notionOwned from notion_sync_docs", async () => {
      await seedDoc("_desk/x.md", "notion_to_md");
      const id = await insertProposal(getPool(), {
        vaultPath: "_desk/x.md",
        notionPageId: "page-1",
        proposedBody: "new body",
        baseMdHash: "h1",
        notionHash: "h2",
        diffPreview: "- old\n+ new",
      });

      const open = await getOpenProposals(getPool());
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({
        id, vaultPath: "_desk/x.md", kind: "update", state: "pending", notionOwned: true,
      });
    });

    it("a CREATE proposal has no docs row and reads notionOwned: false via the LEFT JOIN", async () => {
      const id = await insertProposal(getPool(), {
        vaultPath: "_desk/new.md",
        notionPageId: "page-new",
        proposedBody: "brand new file",
        baseMdHash: "h1",
        notionHash: "h2",
        kind: "create",
      });
      const open = await getOpenProposals(getPool());
      expect(open.find((p) => p.id === id)).toMatchObject({ kind: "create", notionOwned: false });
    });

    it("getOpenProposals excludes applied/superseded rows (only pending/approved are open)", async () => {
      await seedDoc("_desk/a.md", "two_way");
      const id = await insertProposal(getPool(), {
        vaultPath: "_desk/a.md", notionPageId: "p-a", proposedBody: "b", baseMdHash: "h", notionHash: "h",
      });
      await getPool().query(`UPDATE notion_sync_proposals SET state = 'applied' WHERE id = $1`, [id]);
      expect(await getOpenProposals(getPool())).toEqual([]);
    });

    it("resolveProposal moves pending -> approved/rejected, and 'approved' is STILL open", async () => {
      await seedDoc("_desk/b.md", "two_way");
      const id = await insertProposal(getPool(), {
        vaultPath: "_desk/b.md", notionPageId: "p-b", proposedBody: "b", baseMdHash: "h", notionHash: "h",
      });
      const approved = await resolveProposal(getPool(), id, "approve");
      expect(approved.state).toBe("approved");
      expect(await getOpenProposals(getPool())).toHaveLength(1); // approved is still "open"
    });

    it("resolveProposal throws for an id that is not currently open (already resolved or unknown)", async () => {
      await seedDoc("_desk/c.md", "two_way");
      const id = await insertProposal(getPool(), {
        vaultPath: "_desk/c.md", notionPageId: "p-c", proposedBody: "b", baseMdHash: "h", notionHash: "h",
      });
      await resolveProposal(getPool(), id, "reject");
      await expect(resolveProposal(getPool(), id, "approve")).rejects.toThrow(/no open proposal/);
      await expect(resolveProposal(getPool(), 999_999, "approve")).rejects.toThrow(/no open proposal/);
    });

    it("approveConsequence/rejectConsequence vary by kind and notionOwned, exactly as the ported source states", async () => {
      const create = { kind: "create" as const, notionOwned: false };
      const notionOwned = { kind: "update" as const, notionOwned: true };
      const mirror = { kind: "update" as const, notionOwned: false };
      expect(approveConsequence(create)).toMatch(/created in the vault/);
      expect(rejectConsequence(create)).toMatch(/not created, and nothing in Notion changes/);
      expect(rejectConsequence(notionOwned)).toMatch(/left as it is.*Notion owns/s);
      expect(rejectConsequence(mirror)).toMatch(/reverted back to it/);
    });

    // ── THE multi-tick defect class ("the Notion sync work"): announcing twice must
    // produce exactly ONE announcement, guarded by announced_at IS NULL (first stamp wins).
    it("getUnannouncedProposals + markProposalAnnounced: running the cycle TWICE produces exactly one announcement", async () => {
      await seedDoc("_desk/e.md", "two_way");
      const id = await insertProposal(getPool(), {
        vaultPath: "_desk/e.md", notionPageId: "p-e", proposedBody: "b", baseMdHash: "h", notionHash: "h",
      });

      // Tick 1: sees it, announces it, stamps it.
      const firstTick = await getUnannouncedProposals(getPool());
      expect(firstTick.map((p) => p.id)).toEqual([id]);
      await markProposalAnnounced(getPool(), id);

      // Tick 2, same DB state: must find ZERO newly-unannounced proposals.
      const secondTick = await getUnannouncedProposals(getPool());
      expect(secondTick).toEqual([]);

      // A retried stamp (e.g. a caller re-invoking markProposalAnnounced) does not move the
      // clock either — first stamp wins.
      const { rows: before } = await getPool().query("SELECT announced_at FROM notion_sync_proposals WHERE id = $1", [id]);
      await markProposalAnnounced(getPool(), id);
      const { rows: after } = await getPool().query("SELECT announced_at FROM notion_sync_proposals WHERE id = $1", [id]);
      expect(after[0].announced_at).toEqual(before[0].announced_at);
    });

    it("getUnannouncedProposals never returns an 'approved' proposal — it is decided, not awaiting a human", async () => {
      await seedDoc("_desk/f.md", "two_way");
      const id = await insertProposal(getPool(), {
        vaultPath: "_desk/f.md", notionPageId: "p-f", proposedBody: "b", baseMdHash: "h", notionHash: "h",
      });
      await resolveProposal(getPool(), id, "approve");
      expect(await getUnannouncedProposals(getPool())).toEqual([]);
    });
  });

  // ── 1b. lib/proposals-store.ts — Atlas side ────────────────────────────────────────────

  describe("atlas proposal store", () => {
    async function seedNote(notePath: string, brand: string | null) {
      await getPool().query(`INSERT INTO atlas_notes (note_path, brand) VALUES ($1, $2)`, [notePath, brand]);
    }

    it("insertAtlasProposal + getOpenAtlasProposals round-trips", async () => {
      const id = await insertAtlasProposal(getPool(), {
        notePath: "_projects/soma.md", proposedNote: "# SOMA\n...", baseBodyHash: "h1", sourcesHash: "h2",
        diffPreview: "- old\n+ new",
      });
      const open = await getOpenAtlasProposals(getPool());
      expect(open).toEqual([expect.objectContaining({ id, notePath: "_projects/soma.md", state: "pending" })]);
    });

    it("resolveAtlasProposal moves pending -> approved/rejected; throws for a non-open id", async () => {
      const id = await insertAtlasProposal(getPool(), {
        notePath: "_projects/a.md", proposedNote: "n", baseBodyHash: "h", sourcesHash: "h",
      });
      const rejected = await resolveAtlasProposal(getPool(), id, "reject");
      expect(rejected.state).toBe("rejected");
      await expect(resolveAtlasProposal(getPool(), id, "approve")).rejects.toThrow(/no open atlas proposal/);
      await expect(resolveAtlasProposal(getPool(), 999_999, "approve")).rejects.toThrow(/no open atlas proposal/);
    });

    it("atlasApproveConsequence/atlasRejectConsequence are the one fixed pair of sentences", () => {
      expect(atlasApproveConsequence()).toMatch(/re-derived note is written into the Atlas/);
      expect(atlasRejectConsequence()).toMatch(/left exactly as it is/);
    });

    it("getUnannouncedAtlasProposals joins the note's brand, and the multi-tick cycle announces exactly once", async () => {
      await seedNote("_projects/murmur.md", "murmur");
      const id = await insertAtlasProposal(getPool(), {
        notePath: "_projects/murmur.md", proposedNote: "n", baseBodyHash: "h", sourcesHash: "h",
      });

      const firstTick = await getUnannouncedAtlasProposals(getPool());
      expect(firstTick).toEqual([expect.objectContaining({ id, notePath: "_projects/murmur.md", brand: "murmur" })]);
      await markAtlasProposalAnnounced(getPool(), id);

      const secondTick = await getUnannouncedAtlasProposals(getPool());
      expect(secondTick).toEqual([]);
    });

    it("getUnannouncedAtlasProposals reads brand: null when the note has none", async () => {
      const id = await insertAtlasProposal(getPool(), {
        notePath: "_projects/no-brand.md", proposedNote: "n", baseBodyHash: "h", sourcesHash: "h",
      });
      const rows = await getUnannouncedAtlasProposals(getPool());
      expect(rows.find((r) => r.id === id)?.brand).toBeNull();
    });
  });

  // ── 2. Tools ────────────────────────────────────────────────────────────────────────────

  describe("notion_proposals (list, ungated)", () => {
    it("lists open proposals with per-row consequence sentences", async () => {
      await getPool().query(
        `INSERT INTO notion_sync_docs (vault_path, notion_page_id, target, direction)
         VALUES ('_desk/g.md', 'p-g', 'docs', 'notion_to_md')`,
      );
      const id = await insertProposal(getPool(), {
        vaultPath: "_desk/g.md", notionPageId: "p-g", proposedBody: "b", baseMdHash: "h", notionHash: "h",
        diffPreview: "- a\n+ b",
      });

      const result = await notionProposals.execute({}, READ_CTX);
      expect(result.proposals).toEqual([
        expect.objectContaining({
          id, vaultPath: "_desk/g.md", kind: "update", notionOwned: true, state: "pending",
          diffPreview: "- a\n+ b",
        }),
      ]);
      expect(result.proposals[0]!.rejectConsequence).toMatch(/Notion owns/);
    });

    it("returns an empty list when nothing is open", async () => {
      expect(await notionProposals.execute({}, READ_CTX)).toEqual({ proposals: [] });
    });
  });

  describe("notion_resolve_proposal (gated)", () => {
    beforeEach(() => { process.env["SLACK_ALLOWED_USER_IDS"] = BENDIK; });
    afterEach(() => { delete process.env["SLACK_ALLOWED_USER_IDS"]; });

    it("declares approval: always()", () => {
      expect(notionResolveProposal.approval).toBeTypeOf("function");
    });

    it("refuses a present-but-unidentified approver context, before any DB write", async () => {
      const id = await insertProposal(getPool(), {
        vaultPath: "_desk/h.md", notionPageId: "p-h", proposedBody: "b", baseMdHash: "h", notionHash: "h",
      });
      await expect(
        notionResolveProposal.execute({ id, decision: "approve" }, ctx({})),
      ).rejects.toThrow(UnauthorizedApproverError);
      const row = (await getOpenProposals(getPool())).find((p) => p.id === id)!;
      expect(row.state).toBe("pending"); // untouched
    });

    it("refuses a wrong/cross-channel approver, before any DB write", async () => {
      const id = await insertProposal(getPool(), {
        vaultPath: "_desk/i.md", notionPageId: "p-i", proposedBody: "b", baseMdHash: "h", notionHash: "h",
      });
      await expect(
        notionResolveProposal.execute(
          { id, decision: "approve" }, ctx(slackAuth(SOMEONE_ELSE)),
        ),
      ).rejects.toThrow(UnauthorizedApproverError);
      const row = (await getOpenProposals(getPool())).find((p) => p.id === id)!;
      expect(row.state).toBe("pending");
    });

    it("on a valid approver, approves and returns the consequence", async () => {
      const id = await insertProposal(getPool(), {
        vaultPath: "_desk/k.md", notionPageId: "p-k", proposedBody: "b", baseMdHash: "h", notionHash: "h",
      });
      const result = await notionResolveProposal.execute(
        { id, decision: "approve" }, ctx(slackAuth(BENDIK)),
      );
      expect(result).toEqual({
        id, vaultPath: "_desk/k.md", decision: "approve",
        consequence: expect.stringMatching(/written into the vault file/),
      });
      const row = (await getOpenProposals(getPool())).find((p) => p.id === id)!;
      expect(row.state).toBe("approved");
    });

    it("on a valid approver, rejects and returns the reject consequence", async () => {
      const id = await insertProposal(getPool(), {
        vaultPath: "_desk/l.md", notionPageId: "p-l", proposedBody: "b", baseMdHash: "h", notionHash: "h",
      });
      const result = await notionResolveProposal.execute(
        { id, decision: "reject" }, ctx(slackAuth(BENDIK)),
      );
      expect(result.decision).toBe("reject");
      expect(result.consequence).toMatch(/reverted back to it/); // no docs row -> notionOwned false -> revert
    });

    it("throws for an unknown/already-resolved id, even for a valid approver", async () => {
      await expect(
        notionResolveProposal.execute({ id: 999_999, decision: "approve" }, ctx(slackAuth(BENDIK))),
      ).rejects.toThrow(/no open proposal/);
    });
  });

  describe("atlas_proposals (list, ungated)", () => {
    it("lists open atlas proposals with the fixed consequence sentences", async () => {
      const id = await insertAtlasProposal(getPool(), {
        notePath: "_projects/orakel.md", proposedNote: "n", baseBodyHash: "h", sourcesHash: "h",
        diffPreview: "- a\n+ b",
      });
      const result = await atlasProposals.execute({}, READ_CTX);
      expect(result.proposals).toEqual([
        expect.objectContaining({ id, notePath: "_projects/orakel.md", state: "pending", diffPreview: "- a\n+ b" }),
      ]);
      expect(result.proposals[0]!.approveConsequence).toMatch(/re-derived note is written/);
    });
  });

  describe("atlas_resolve_proposal (gated)", () => {
    beforeEach(() => { process.env["SLACK_ALLOWED_USER_IDS"] = BENDIK; });
    afterEach(() => { delete process.env["SLACK_ALLOWED_USER_IDS"]; });

    it("declares approval: always()", () => {
      expect(atlasResolveProposal.approval).toBeTypeOf("function");
    });

    it("refuses a present-but-unidentified approver context, before any DB write", async () => {
      const id = await insertAtlasProposal(getPool(), {
        notePath: "_projects/m.md", proposedNote: "n", baseBodyHash: "h", sourcesHash: "h",
      });
      await expect(
        atlasResolveProposal.execute({ id, decision: "approve" }, ctx({})),
      ).rejects.toThrow(UnauthorizedApproverError);
      const row = (await getOpenAtlasProposals(getPool())).find((p) => p.id === id)!;
      expect(row.state).toBe("pending");
    });

    it("refuses a wrong approver, before any DB write", async () => {
      const id = await insertAtlasProposal(getPool(), {
        notePath: "_projects/n.md", proposedNote: "n", baseBodyHash: "h", sourcesHash: "h",
      });
      await expect(
        atlasResolveProposal.execute(
          { id, decision: "reject" }, ctx(slackAuth(SOMEONE_ELSE)),
        ),
      ).rejects.toThrow(UnauthorizedApproverError);
      const row = (await getOpenAtlasProposals(getPool())).find((p) => p.id === id)!;
      expect(row.state).toBe("pending");
    });

    it("on a valid approver, approves", async () => {
      const id = await insertAtlasProposal(getPool(), {
        notePath: "_projects/p.md", proposedNote: "n", baseBodyHash: "h", sourcesHash: "h",
      });
      const result = await atlasResolveProposal.execute(
        { id, decision: "approve" }, ctx(slackAuth(BENDIK)),
      );
      expect(result).toEqual({
        id, notePath: "_projects/p.md", decision: "approve",
        consequence: expect.stringMatching(/written into the Atlas/),
      });
      const row = (await getOpenAtlasProposals(getPool())).find((p) => p.id === id)!;
      expect(row.state).toBe("approved");
    });

    it("throws for an unknown/already-resolved id, even for a valid approver", async () => {
      await expect(
        atlasResolveProposal.execute({ id: 999_999, decision: "approve" }, ctx(slackAuth(BENDIK))),
      ).rejects.toThrow(/no open atlas proposal/);
    });
  });

  // ── 3. agent/schedules/proposals-watch.ts — the tick, through the REAL store ───────────

  describe("makeProposalsWatchTick, wired to the real store", () => {
    function realStore(): ProposalsWatchStore {
      const pool = getPool();
      return {
        notionUnannounced: () => getUnannouncedProposals(pool),
        notionMarkAnnounced: (id) => markProposalAnnounced(pool, id),
        atlasUnannounced: () => getUnannouncedAtlasProposals(pool),
        atlasMarkAnnounced: (id) => markAtlasProposalAnnounced(pool, id),
        // The memory lane against a database with no `memory_proposals` table — which is the
        // real shape of a box that has not applied services/box/sql/072_memory_proposals.sql.
        // The lane treats that as "nothing waiting", not a failed tick; see its own catch.
        memoryUnannounced: () => getUnannouncedMemoryProposals(pool),
        memoryMarkAnnounced: (id) => markMemoryProposalAnnounced(pool, id),
      };
    }

    function fakeDoor() {
      const sent: string[] = [];
      const door: ProposalsWatchDoor = { async announce(a) { sent.push(a.text); } };
      return { door, sent };
    }

    it("running tick() TWICE against the same DB state produces exactly one send + one stamp per lane", async () => {
      await getPool().query(
        `INSERT INTO notion_sync_docs (vault_path, notion_page_id, target, direction)
         VALUES ('_desk/q.md', 'p-q', 'docs', 'two_way')`,
      );
      await insertProposal(getPool(), {
        vaultPath: "_desk/q.md", notionPageId: "p-q", proposedBody: "b", baseMdHash: "h", notionHash: "h",
      });
      await insertAtlasProposal(getPool(), {
        notePath: "_projects/q.md", proposedNote: "n", baseBodyHash: "h", sourcesHash: "h",
      });

      const { door, sent } = fakeDoor();
      const tick = makeProposalsWatchTick({ store: realStore(), door }, freshState());

      await expect(tick.tick()).resolves.toBe(true); // both lanes completed
      expect(sent).toHaveLength(2); // one announcement per proposal: 1 notion + 1 atlas

      await expect(tick.tick()).resolves.toBe(true); // both lanes completed again, just with nothing new
      expect(sent).toHaveLength(2); // second tick: nothing newly-unannounced, no new sends
    });
  });

  describe("makeProposalsWatchTick, fully offline (fake store/door)", () => {
    function row(overrides: Partial<ProposalRow> = {}): ProposalRow {
      return {
        id: 1, vaultPath: "_desk/x.md", notionPageId: "p-x", proposedBody: "b", baseMdHash: "h",
        notionHash: "h", diffPreview: "- a\n+ b", kind: "update", notionOwned: false,
        state: "pending", createdAt: new Date("2026-08-14T09:00:00Z"), ...overrides,
      };
    }
    function atlasRow(overrides: Partial<AtlasUnannouncedRow> = {}): AtlasUnannouncedRow {
      return {
        id: 1, notePath: "_projects/x.md", proposedNote: "n", baseBodyHash: "h", sourcesHash: "h",
        diffPreview: "- a\n+ b", state: "pending", createdAt: new Date("2026-08-14T09:00:00Z"),
        brand: "murmur", ...overrides,
      };
    }

    function fakeStore(notion: ProposalRow[], atlas: AtlasUnannouncedRow[]) {
      const notionStamped: number[] = [];
      const atlasStamped: number[] = [];
      let notionCalls = 0;
      let atlasCalls = 0;
      const store: ProposalsWatchStore = {
        async notionUnannounced() { notionCalls += 1; return notion; },
        async notionMarkAnnounced(id) { notionStamped.push(id); },
        async atlasUnannounced() { atlasCalls += 1; return atlas; },
        async atlasMarkAnnounced(id) { atlasStamped.push(id); },
        // The memory lane (W4C-s5) — always empty here; `tests/memory-proposal-apply.test.ts`
        // owns it. Present rather than omitted so this fake stays a real ProposalsWatchStore:
        // a lane whose store method is missing throws into its own catch and reports the whole
        // tick as failed, which is how this was found.
        async memoryUnannounced() { return []; },
        async memoryMarkAnnounced() { /* nothing to stamp */ },
      };
      return { store, notionStamped, atlasStamped, calls: () => ({ notionCalls, atlasCalls }) };
    }

    function fakeDoor(opts: { throwOn?: "notion" | "atlas" } = {}) {
      const sent: string[] = [];
      const markups: unknown[] = [];
      const door: ProposalsWatchDoor = {
        async announce(a) {
          if (opts.throwOn === "notion" && a.text.startsWith("Notion proposal")) throw new Error("send failed");
          if (opts.throwOn === "atlas" && a.text.startsWith("Atlas proposal")) throw new Error("send failed");
          sent.push(a.text);
          markups.push(a.replyMarkup);
        },
      };
      return { door, sent, markups };
    }

    it("announces each pending proposal as ITS OWN message with its own buttons (one-tap restoration)", async () => {
      const { store } = fakeStore([row({ id: 1 }), row({ id: 2 }), row({ id: 3 })], []);
      const { door, sent, markups } = fakeDoor();
      await expect(makeProposalsWatchTick({ store, door }, freshState()).tick()).resolves.toBe(true);
      expect(sent).toHaveLength(3);
      expect(sent[0]).toContain("#1");
      expect(sent[2]).toContain("#3");
      // Each message carries its OWN approve/reject callback pair — the old np:a:/np:r: convention.
      expect(JSON.stringify(markups[0])).toContain('"np:a:1"');
      expect(JSON.stringify(markups[0])).toContain('"np:r:1"');
      expect(JSON.stringify(markups[2])).toContain('"np:a:3"');
    });

    it("stamps announced_at only AFTER a successful send", async () => {
      const { store, notionStamped } = fakeStore([row({ id: 7 })], []);
      const { door } = fakeDoor();
      await expect(makeProposalsWatchTick({ store, door }, freshState()).tick()).resolves.toBe(true);
      expect(notionStamped).toEqual([7]);
    });

    // A send failure is caught INSIDE the per-proposal loop, not by the lane's outer catch — it
    // still counts as a completed pass (ORB-175 fix round 1: only an OUTER-catch failure, not a
    // per-item one, may withhold the heartbeat stamp).
    it("a send that throws leaves the proposal unstamped for the next tick, and the lane still completes", async () => {
      const { store, notionStamped } = fakeStore([row({ id: 8 })], []);
      const { door } = fakeDoor({ throwOn: "notion" });
      await expect(makeProposalsWatchTick({ store, door }, freshState()).tick()).resolves.toBe(true);
      expect(notionStamped).toEqual([]);
    });

    it("one lane's per-item send failure does not block the other lane's announcement or stamp, and the pass still completes", async () => {
      const { store, atlasStamped } = fakeStore([row({ id: 9 })], [atlasRow({ id: 10 })]);
      const { door } = fakeDoor({ throwOn: "notion" }); // notion send fails; atlas must still succeed
      await expect(makeProposalsWatchTick({ store, door }, freshState()).tick()).resolves.toBe(true);
      expect(atlasStamped).toEqual([10]);
    });

    it("a lane with nothing unannounced sends nothing for that lane, and still resolves true", async () => {
      const { store } = fakeStore([], []);
      const { door, sent } = fakeDoor();
      await expect(makeProposalsWatchTick({ store, door }, freshState()).tick()).resolves.toBe(true);
      expect(sent).toEqual([]);
    });

    it("single-flight guard: a lane already marked running is skipped for this tick, and the combined pass resolves false", async () => {
      const { store, calls } = fakeStore([row({ id: 11 })], [atlasRow({ id: 12 })]);
      const { door, sent } = fakeDoor();
      const state = freshState();
      state.notionRunning = true; // simulate a previous notion turn still in flight
      // The notion lane's own overlap guard makes ITS pass incomplete this call — even though
      // the atlas lane genuinely completes, the combined tick must not stamp the heartbeat on
      // a half-run pass (ORB-175 fix round 1: true only when BOTH lanes complete).
      await expect(makeProposalsWatchTick({ store, door }, state).tick()).resolves.toBe(false);
      expect(calls().notionCalls).toBe(0); // never even polled
      expect(sent.filter((s) => s.startsWith("Atlas proposal"))).toHaveLength(1); // atlas unaffected
    });

    // ORB-175 fix round 1 (controller ruling) — a lane's OUTER catch swallowing a genuine
    // failure (here, store.notionUnannounced() itself throwing) is a FAILED lane pass: the
    // combined tick must resolve false so the caller does not stamp the heartbeat, even though
    // the atlas lane completes normally.
    it("a lane's store failure (outer catch) makes the combined tick resolve false, even when the other lane completes", async () => {
      const atlasStamped: number[] = [];
      const store: ProposalsWatchStore = {
        notionUnannounced: async () => { throw new Error("Postgres is down"); },
        notionMarkAnnounced: async () => {},
        atlasUnannounced: async () => [atlasRow({ id: 13 })],
        atlasMarkAnnounced: async (id) => { atlasStamped.push(id); },
      };
      const { door } = fakeDoor();
      await expect(makeProposalsWatchTick({ store, door }, freshState()).tick()).resolves.toBe(false);
      expect(atlasStamped).toEqual([13]); // the atlas lane is unaffected by the notion lane's failure
    });

    it("the conversational prompt builders (kept for the gated-tool path) still say YOU PRESENT, HE DECIDES", () => {
      const notionPrompt = buildNotionProposalsPrompt([row({ id: 1 })]);
      expect(notionPrompt).toContain("YOU PRESENT, HE DECIDES");
      expect(notionPrompt).toContain("notion_resolve_proposal");
      expect(notionPrompt).not.toContain("np:a:"); // the retired Telegram button data

      const atlasPrompt = buildAtlasProposalsPrompt([atlasRow({ id: 1 })]);
      expect(atlasPrompt).toContain("YOU PRESENT, HE DECIDES");
      expect(atlasPrompt).toContain("atlas_resolve_proposal");
    });
  });

  // ── 4. The schedule's own gate ─────────────────────────────────────────────────────────

  describe("agent/schedules/proposals-watch.ts default export", () => {
    const ENV_KEYS = ["EVE_SCHEDULES_LIVE", "DATABASE_URL", "TELEGRAM_PRINCIPAL_ID"];
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
      saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
      for (const k of ENV_KEYS) delete process.env[k];
    });

    afterEach(() => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it("carries the documented ~1 minute cron cadence", async () => {
      const mod = await import("../agent/schedules/proposals-watch.js");
      expect(mod.default.cron).toBe("* * * * *");
    });

    it("is a complete no-op when the gate is off", async () => {
      const mod = await import("../agent/schedules/proposals-watch.js");
      await expect(
        mod.default.run!({ to: (() => {}) as never, waitUntil: () => {}, appAuth: {} as never }),
      ).resolves.toBeUndefined();
    });

    it("is a no-op when the gate is on but no TELEGRAM_PRINCIPAL_ID is configured", async () => {
      process.env["EVE_SCHEDULES_LIVE"] = "1";
      const mod = await import("../agent/schedules/proposals-watch.js");
      await expect(
        mod.default.run!({ to: (() => {}) as never, waitUntil: () => {}, appAuth: {} as never }),
      ).resolves.toBeUndefined();
    });
  });
});
