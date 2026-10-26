import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

import { makePgSeenStore } from "../lib/karakeep.js";
import { ensureRouteTables, makeRouteStore } from "../lib/route-store.js";
import { quiet } from "./helpers/quiet-pool.js";
import { payloadFingerprint } from "@lares/agent-kit/approval-ledger";
import { applyRouteProposalDecline, claimRouteDeclineQuestion, listPendingRouteDeclineQuestions, markRouteDeclineQuestionSent, recordRouteApprovalLink, routeDeclineAnswerForReply, routeDeclineAnswerScope } from "../lib/route-decline.js";
import { listActiveFacts, rememberFact } from "../lib/standing-facts.js";
import { linkScheduledRouteRequests } from "../agent/hooks/approval-record.js";

const SHARED_SYNC_SCHEMA_SQL = readFileSync(new URL("../../box/sql/027_shared_sync_schema.sql", import.meta.url), "utf8");
const TRACK_ROUTING_MIGRATION_SQL = readFileSync(new URL("../../box/sql/032_track_routing.sql", import.meta.url), "utf8");
const TRACK_DECLINE_MIGRATION_SQL = readFileSync(new URL("../../box/sql/033_track_proposal_approval_links.sql", import.meta.url), "utf8");
const STANDING_FACTS_MIGRATION_SQL = readFileSync(new URL("../../box/sql/002_standing_facts.sql", import.meta.url), "utf8");
const EXISTING_CURSOR = "2026-08-21T09:00:00.000Z";

describe("offline shared sync and CRM schema", () => {
  let container: StartedPostgreSqlContainer;
  let schemaOwner: Pool;
  let app: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    schemaOwner = quiet(new Pool({ connectionString: container.getConnectionUri() }));
    await schemaOwner.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await schemaOwner.query(STANDING_FACTS_MIGRATION_SQL);
    await schemaOwner.query(SHARED_SYNC_SCHEMA_SQL);
    await schemaOwner.query(`CREATE TABLE schedule_settings(owner text NOT NULL,schedule text NOT NULL,hours integer[] NOT NULL,updated_by text,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,schedule));
      CREATE TABLE heartbeat(agent text PRIMARY KEY,updated_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO schedule_settings(owner,schedule,hours) VALUES('owner-1','crm-routing',ARRAY[9,13,17]);
      INSERT INTO heartbeat(agent) VALUES('chief-of-staff/crm-routing'),('chief-of-staff/crm-routing/tick');`);
    await schemaOwner.query("INSERT INTO karakeep_seen (id) VALUES ('existing-bookmark')");
    await schemaOwner.query("INSERT INTO route_cursor (id, cursor_at) VALUES (1, $1)", [EXISTING_CURSOR]);
    await schemaOwner.query(
      `INSERT INTO route_proposals (person_id, brand, proposed_stage, signal_ref, confidence, status)
       VALUES ('external-contact-42', 'ALPHA', 'PROPOSAL', 'msg:existing', 0.7, 'skipped')`,
    );

    // Reapplying the offline migration must preserve existing dedup, cursor, and CRM rows.
    await schemaOwner.query(SHARED_SYNC_SCHEMA_SQL);
    await schemaOwner.query(TRACK_ROUTING_MIGRATION_SQL);
    await schemaOwner.query(`CREATE TABLE users(id text PRIMARY KEY);
      CREATE TABLE approval_asks(request_id text UNIQUE,call_id text NOT NULL,agent text NOT NULL,tool text NOT NULL,payload_hash text NOT NULL,outcome text);`);
    await schemaOwner.query(TRACK_DECLINE_MIGRATION_SQL);
    await schemaOwner.query("INSERT INTO users(id) VALUES('member-1')");
    await schemaOwner.query(TRACK_ROUTING_MIGRATION_SQL);
    await schemaOwner.query(TRACK_DECLINE_MIGRATION_SQL);
    await schemaOwner.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await schemaOwner.query("CREATE ROLE shared_sync_app LOGIN PASSWORD 'fixture-only-password'");
    await schemaOwner.query("GRANT USAGE ON SCHEMA public TO shared_sync_app");
    await schemaOwner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
       public.karakeep_seen, public.route_cursor, public.route_proposals, public.approval_asks,
       public.route_proposal_approval_links TO shared_sync_app`,
    );

    const appUri = new URL(container.getConnectionUri());
    appUri.username = "shared_sync_app";
    appUri.password = "fixture-only-password";
    app = quiet(new Pool({ connectionString: appUri.toString() }));
  }, 120_000);

  afterAll(async () => {
    await app?.end();
    await schemaOwner?.end();
    await container?.stop();
  });

  it("preserves existing rows and supports readiness plus ordinary DML as a non-owner login", async () => {
    const { rows: login } = await app.query("SELECT current_user AS user");
    expect(login[0].user).toBe("shared_sync_app");

    await makePgSeenStore(app).ensure();
    await ensureRouteTables(app);

    const { rows: beforeWrites } = await schemaOwner.query(
      `SELECT s.id AS bookmark, s.at, c.cursor_at, p.status, p.signal_ref
         FROM karakeep_seen s
         CROSS JOIN route_cursor c
         CROSS JOIN route_proposals p
        WHERE s.id = 'existing-bookmark' AND p.signal_ref = 'msg:existing'`,
    );
    expect(beforeWrites).toHaveLength(1);
    expect(beforeWrites[0].bookmark).toBe("existing-bookmark");
    expect(beforeWrites[0].at).toBeInstanceOf(Date);
    expect((beforeWrites[0].cursor_at as Date).toISOString()).toBe(EXISTING_CURSOR);
    expect(beforeWrites[0].status).toBe("skipped");
    expect(beforeWrites[0].signal_ref).toBe("msg:existing");

    const seen = makePgSeenStore(app);
    expect(await seen.isSeen("existing-bookmark")).toBe(true);
    await seen.markSeen("new-bookmark");
    expect(await seen.isSeen("new-bookmark")).toBe(true);
    await seen.markSeen("new-bookmark");
    const { rows: duplicateSeen } = await app.query("SELECT count(*)::int AS n FROM karakeep_seen WHERE id = 'new-bookmark'");
    expect(duplicateSeen[0].n).toBe(1);
    await app.query("DELETE FROM karakeep_seen WHERE id = 'new-bookmark'");
    expect(await seen.isSeen("new-bookmark")).toBe(false);

    const route = makeRouteStore(app);
    expect(await route.getCursor()).toBe(EXISTING_CURSOR);
    await expect(app.query("INSERT INTO route_cursor (id, cursor_at) VALUES (2, now())"))
      .rejects.toThrow(/route_cursor_singleton|check constraint/i);
    await route.setCursor("2026-08-22T10:30:00.000Z");
    expect(await route.getCursor()).toBe("2026-08-22T10:30:00.000Z");
    expect(await route.alreadyProposed({ personId: "external-contact-42", signalRef: "msg:existing" })).toBe(true);
    expect(await route.proposedSince({ personId: "external-contact-42", home: "twenty", trackId: "ALPHA", sinceIso: "2026-08-20T00:00:00.000Z" })).toBe(true);

    const proposal = await route.recordProposal({
      personId: "external-contact-43",
      home: "twenty",
      trackId: "BETA",
      proposedStage: "MEETING",
      signalRef: "msg:new",
      confidence: 0.85,
    });
    expect(await route.alreadyProposed({ personId: "external-contact-43", signalRef: "msg:new" })).toBe(true);
    await route.markResolved(proposal.id, "skipped");
    const { rows: updated } = await app.query("SELECT status FROM route_proposals WHERE id = $1", [proposal.id]);
    expect(updated[0].status).toBe("skipped");
    await app.query("DELETE FROM route_proposals WHERE id = $1", [proposal.id]);
    const { rows: deleted } = await app.query("SELECT 1 FROM route_proposals WHERE id = $1", [proposal.id]);
    expect(deleted).toHaveLength(0);

    const { rows: preserved } = await schemaOwner.query(
      `SELECT s.id AS bookmark, c.cursor_at, p.status, p.signal_ref
         FROM karakeep_seen s
         CROSS JOIN route_cursor c
         CROSS JOIN route_proposals p
        WHERE s.id = 'existing-bookmark' AND p.signal_ref = 'msg:existing'`,
    );
    expect(preserved).toHaveLength(1);
    expect(preserved[0].bookmark).toBe("existing-bookmark");
    expect((preserved[0].cursor_at as Date).toISOString()).toBe("2026-08-22T10:30:00.000Z");
    expect(preserved[0].status).toBe("skipped");
    expect(preserved[0].signal_ref).toBe("msg:existing");

    const { rows: owners } = await schemaOwner.query(
      `SELECT c.relname, c.relowner::regrole::text AS owner
         FROM pg_class c
        WHERE c.oid IN (
          'public.karakeep_seen'::regclass,
          'public.route_cursor'::regclass,
          'public.route_proposals'::regclass
        )`,
    );
    expect(owners).toHaveLength(3);
    expect(owners.every((row) => row.owner !== "shared_sync_app")).toBe(true);

    await expect(app.query("CREATE TABLE public.shared_sync_app_ddl_probe (id integer)"))
      .rejects.toThrow(/permission denied/i);
    for (const table of ["karakeep_seen", "route_cursor", "route_proposals"]) {
      await expect(app.query(`ALTER TABLE public.${table} ADD COLUMN ddl_probe integer`))
        .rejects.toThrow(/must be owner/i);
      await expect(app.query(`TRUNCATE TABLE public.${table}`))
        .rejects.toThrow(/permission denied/i);
    }
  });

  it("links one exact declined approval to one route row under the same member and audience", async () => {
    const route = makeRouteStore(schemaOwner);
    const proposal = await route.reserveProposal({ personId: "contact-188", home: "twenty", trackId: "north",
      proposedStage: "intro", signalRef: "signal-188", confidence: 0.9 });
    const input = { home: "twenty", trackId: "north", who: { personId: "contact-188" },
      step: "intro", note: "new activity", sourceSignal: "signal-188" };
    const hash = payloadFingerprint("track_add_item", input);
    await schemaOwner.query(`INSERT INTO approval_asks(request_id,call_id,agent,tool,payload_hash)
      VALUES('request-188','call-188','chief-of-staff','track_add_item',$1)`, [hash]);
    const linked = await recordRouteApprovalLink(schemaOwner, { requestId: "request-188", sessionId: "private-session-188", turnSequence: 4, callId: "call-188",
      tool: "track_add_item", input, memberId: "member-1", door: "slack", address: "slack-user:owner-1", accessRevision: 7 });
    expect(linked).toBe(true);
    await schemaOwner.query("UPDATE approval_asks SET outcome='cancelled' WHERE request_id='request-188'");

    const client = await schemaOwner.connect();
    try {
      await client.query("BEGIN");
      expect(await applyRouteProposalDecline(client, "request-188", { memberId: "member-2", address: "slack-user:owner-1", accessRevision: 7 })).toBe(false);
      await client.query("COMMIT");
      expect((await schemaOwner.query("SELECT status FROM route_proposals WHERE id=$1", [proposal.id])).rows[0].status).toBe("proposed");
      await client.query("BEGIN");
      expect(await applyRouteProposalDecline(client, "request-188", { memberId: "member-1", address: "slack-user:owner-1", accessRevision: 7 })).toBe(true);
      await client.query("COMMIT");
      await client.query("BEGIN");
      expect(await applyRouteProposalDecline(client, "request-188", { memberId: "member-1", address: "slack-user:owner-1", accessRevision: 7 })).toBe(false);
      await client.query("COMMIT");
    } finally { client.release(); }
    expect((await schemaOwner.query("SELECT status FROM route_proposals WHERE id=$1", [proposal.id])).rows[0].status).toBe("vetoed");
    const afterDecline = new Date();
    expect(await route.proposedSince({ personId: "contact-188", home: "twenty", trackId: "north",
      sinceIso: new Date(afterDecline.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString() })).toBe(true);
    await schemaOwner.query("UPDATE route_proposals SET created_at=now()-interval '15 days' WHERE id=$1", [proposal.id]);
    expect(await route.proposedSince({ personId: "contact-188", home: "twenty", trackId: "north",
      sinceIso: new Date(afterDecline.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString() })).toBe(false);
    expect((await schemaOwner.query("SELECT count(*)::int AS n FROM route_proposal_approval_links WHERE request_id='request-188'")).rows[0].n).toBe(1);
    expect((await schemaOwner.query("SELECT question_pending,question_claimed_at,contact_person_id,door,home,track_id FROM route_proposal_approval_links WHERE request_id='request-188'")).rows[0])
      .toMatchObject({ question_pending: true, question_claimed_at: null, contact_person_id: "contact-188", door: "slack", home: "twenty", track_id: "north" });
    const pending = await listPendingRouteDeclineQuestions(schemaOwner);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ requestId: "request-188", personId: "contact-188", home: "twenty", trackId: "north" });
    expect(await claimRouteDeclineQuestion(schemaOwner, { ...pending[0]!, identity: { ...pending[0]!.identity, accessRevision: 8 } })).toBe(false);
    expect(await claimRouteDeclineQuestion(schemaOwner, pending[0]!)).toBe(true);
    expect(await claimRouteDeclineQuestion(schemaOwner, pending[0]!)).toBe(false);
    await markRouteDeclineQuestionSent(schemaOwner, "request-188", "slack:message-188");
    await schemaOwner.query(`INSERT INTO approval_asks(request_id,call_id,agent,tool,payload_hash)
      VALUES('request-next','call-next','chief-of-staff','track_add_item',$1)`, ["b".repeat(64)]);
    await schemaOwner.query(`INSERT INTO route_proposal_approval_links
      (request_id,session_id,request_turn_sequence,member_id,door,audience_address,audience_access_revision,tool_name,call_id,payload_hash,
       person_id,contact_person_id,home,track_id,proposed_stage,signal_ref,declined_at,question_pending)
      VALUES('request-next','private-session-188',6,'member-1','slack','slack-user:owner-1',7,'track_add_item','call-next',$1,
       'contact-next','contact-next','twenty','north','intro','signal-next',now(),true)`, ["b".repeat(64)]);
    expect(await listPendingRouteDeclineQuestions(schemaOwner)).toEqual([]);
    expect((await schemaOwner.query("SELECT count(*)::int AS n FROM standing_facts WHERE source_turn='owner-turn-188'")).rows[0].n).toBe(0);
    const current = pending[0]!.identity;
    const clientForAnswer = await schemaOwner.connect();
    try {
      await clientForAnswer.query("BEGIN");
      expect(await routeDeclineAnswerScope(clientForAnswer, "request-188", { ...current, memberId: "member-other" }, "slack:message-188")).toBeUndefined();
      const scope = await routeDeclineAnswerScope(clientForAnswer, "request-188", current, "slack:message-188");
      expect(scope).toEqual({ personId: "contact-188", home: "twenty", trackId: "north" });
      await clientForAnswer.query("COMMIT");
    } finally { clientForAnswer.release(); }
    await rememberFact(schemaOwner, { fact: "Never", category: "preference", sourceTurn: "owner-turn-188",
      userId: "owner-1", routeScope: { personId: "contact-188", home: "twenty", trackId: "north", choice: "never" } });
    const active = await listActiveFacts(schemaOwner, "owner-1");
    expect(active[0]).toMatchObject({ fact: "Never", routePersonId: "contact-188", routeHome: "twenty", routeTrackId: "north", routeChoice: "never" });
    await schemaOwner.query("UPDATE route_proposal_approval_links SET answered_at=now() WHERE request_id='request-188'");
    expect(await listPendingRouteDeclineQuestions(schemaOwner)).toHaveLength(1);
    const repeat = await schemaOwner.connect();
    try {
      await repeat.query("BEGIN");
      expect(await routeDeclineAnswerScope(repeat, "request-188", current, "slack:message-188")).toBeUndefined();
      await repeat.query("COMMIT");
    } finally { repeat.release(); }
    await schemaOwner.query("UPDATE standing_facts SET retired_at=now() WHERE source_turn='owner-turn-188'");
    expect(await listActiveFacts(schemaOwner, "owner-1")).toHaveLength(0);

    const next = (await listPendingRouteDeclineQuestions(schemaOwner))[0]!;
    expect(next.requestId).toBe("request-next");
    expect(await claimRouteDeclineQuestion(schemaOwner, next)).toBe(true);
    await markRouteDeclineQuestionSent(schemaOwner, next.requestId, "slack:old-question");
    await schemaOwner.query("UPDATE route_proposal_approval_links SET question_sent_at=now()-interval '15 days' WHERE request_id='request-next'");
    await schemaOwner.query(`INSERT INTO approval_asks(request_id,call_id,agent,tool,payload_hash)
      VALUES('request-after-silence','call-after-silence','chief-of-staff','track_add_item',$1)`, ["c".repeat(64)]);
    await schemaOwner.query(`INSERT INTO route_proposal_approval_links
      (request_id,session_id,request_turn_sequence,member_id,door,audience_address,audience_access_revision,tool_name,call_id,payload_hash,
       person_id,contact_person_id,home,track_id,proposed_stage,signal_ref,declined_at,question_pending)
      VALUES('request-after-silence','private-session-188',7,'member-1','slack','slack-user:owner-1',7,'track_add_item','call-after-silence',$1,
       'contact-after-silence','contact-after-silence','twenty','south','intro','signal-after-silence',now(),true)`, ["c".repeat(64)]);
    const afterSilence = await listPendingRouteDeclineQuestions(schemaOwner);
    expect(afterSilence.map((q) => q.requestId)).toEqual(["request-after-silence"]);
    expect(await claimRouteDeclineQuestion(schemaOwner, afterSilence[0]!)).toBe(true);
    await markRouteDeclineQuestionSent(schemaOwner, "request-after-silence", "slack:new-question");
    expect(await listPendingRouteDeclineQuestions(schemaOwner)).toEqual([]);
    expect(await routeDeclineAnswerForReply(schemaOwner, current, "slack", "slack:old-question")).toMatchObject({ kind: "stale" });
    expect(await routeDeclineAnswerForReply(schemaOwner, current, "slack", "slack:new-question")).toMatchObject({
      kind: "match", requestId: "request-after-silence",
    });
    expect(await routeDeclineAnswerForReply(schemaOwner, { ...current, memberId: "member-other" }, "slack", "slack:new-question")).toMatchObject({ kind: "none" });
  });

  it("serializes approval-link creation against failed-send cleanup", async () => {
    const route = makeRouteStore(schemaOwner);
    const proposal = await route.reserveProposal({ personId: "contact-race", home: "twenty", trackId: "north",
      proposedStage: "intro", signalRef: "signal-race", confidence: 0.9 });
    expect(await route.reserveProposal({ personId: "contact-race", home: "twenty", trackId: "north",
      proposedStage: "intro", signalRef: "signal-race", confidence: 0.9 })).toEqual(proposal);
    const input = { home: "twenty", trackId: "north", who: { personId: "contact-race" },
      step: "intro", note: "new activity", sourceSignal: "signal-race" };
    const hash = payloadFingerprint("track_add_item", input);
    await schemaOwner.query(`INSERT INTO approval_asks(request_id,call_id,agent,tool,payload_hash)
      VALUES('request-race','call-race','chief-of-staff','track_add_item',$1)`, [hash]);
    const [linked] = await Promise.all([
      recordRouteApprovalLink(schemaOwner, { requestId: "request-race", sessionId: "private-session-race", turnSequence: 4, callId: "call-race", tool: "track_add_item",
        input, memberId: "member-1", door: "slack", address: "slack-user:owner-1", accessRevision: 7 }),
      route.discardUnsentProposal(proposal.id),
    ]);
    const { rows } = await schemaOwner.query(`SELECT p.status,(SELECT count(*)::int FROM route_proposal_approval_links l
      WHERE l.request_id='request-race') AS links FROM route_proposals p WHERE p.id=$1`, [proposal.id]);
    if (linked) expect(rows[0]).toEqual({ status: "proposed", links: 1 });
    else expect(rows).toHaveLength(0);
  });

  it("links the exact approval after a native send has already promoted its row", async () => {
    const route = makeRouteStore(schemaOwner);
    const proposal = await route.reserveProposal({ personId: "contact-delivered", home: "twenty", trackId: "north",
      proposedStage: "intro", signalRef: "signal-delivered", confidence: 0.9 });
    await route.confirmProposalSent(proposal.id);
    const input = { home: "twenty", trackId: "north", who: { personId: "contact-delivered" },
      step: "intro", note: "new activity", sourceSignal: "signal-delivered" };
    const hash = payloadFingerprint("track_add_item", input);
    await schemaOwner.query(`INSERT INTO approval_asks(request_id,call_id,agent,tool,payload_hash)
      VALUES('request-delivered','call-delivered','chief-of-staff','track_add_item',$1)`, [hash]);
    await linkScheduledRouteRequests(schemaOwner, { data: { requests: [{ kind: "tool-approval", requestId: "request-delivered",
      action: { kind: "tool-call", callId: "call-delivered", toolName: "track_add_item", input } }] } }, {
      session: { id: "private-session-delivered", turn: { sequence: 5 }, auth: { current: { authenticator: "app", attributes: {
        lane: "track-routing", lares_continuity_member_id: "member-1", lares_continuity_address: "slack-user:owner-1",
        lares_continuity_revision: "7",
      } } } },
    } as never);
    const { rows: linkRows } = await schemaOwner.query(`SELECT session_id,request_turn_sequence FROM route_proposal_approval_links
      WHERE request_id='request-delivered'`);
    expect(linkRows).toEqual([{ session_id: "private-session-delivered", request_turn_sequence: 5 }]);
    const { rows } = await schemaOwner.query(`SELECT status FROM route_proposals WHERE id=$1`, [proposal.id]);
    expect(rows[0]?.status).toBe("proposed");
  });
});
