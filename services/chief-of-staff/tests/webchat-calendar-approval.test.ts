/** Web chat: the agent's owner changes the chosen mailbox's calendar only through an exact Approve card.
 *  Real Postgres, the real approval path (card, answer, execution), a recording stand-in for Google. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getPool, closePool } from "@lares/agent-kit/db";
import { PgGrantStore } from "@lares/agent-kit/grant-store";
import { bindConsoleSession } from "@lares/agent-kit/console-turn-authority";
import { attachExactApproval } from "@lares/agent-kit/approval-execution";
import { googlePersonalConsentScopes } from "@lares/agent-kit/personal-consent";
import calendarCreateEvent from "../catalogue/calendar_create_event.js";
import calendarUpdateEvent from "../catalogue/calendar_update_event.js";
import calendarDeleteEvent from "../catalogue/calendar_delete_event.js";
import { catalogueApprovalRequest, catalogueApprovalResponse } from "../lib/approvals.js";
import { calendarApprovalAdapter } from "../lib/calendar-approval.js";
import { wrapCalendarApi } from "../lib/google.js";
import { forgetChosenMailbox, useChosenMailbox } from "./helpers/chosen-mailbox.js";
import { quiet } from "./helpers/quiet-pool.js";

const inc = "11111111-1111-4111-8111-111111111111";
const MAILBOX = "owner@example.invalid";
const env = { LARES_AGENT_NAME: "helper", LARES_AGENT_INCARNATION: inc };
const auth = (purpose = "human", member = "member-a", nonce = "a".repeat(43), option = "approve") => ({
  authenticator: "lares-console", principalId: member, principalType: "user",
  attributes: { user_id: member, lares_member_id: member, lares_admission_nonce: nonce, lares_purpose: purpose,
    ...(purpose === "resolver" ? { lares_resume_request_id: "request-1", lares_resume_option: option } : {}) },
});
const context = (tool: string, raw: unknown, purpose = "human", member = "member-a") => ({
  callId: "call-1", toolName: tool, toolInput: raw, abortSignal: new AbortController().signal,
  session: { id: "wrun_exact", turn: { id: purpose === "human" ? "turn-original" : "turn-resolver", sequence: purpose === "human" ? 0 : 1 },
    auth: { current: auth(purpose, member), initiator: auth("human", member) } },
});
const answerCard = (tool: string, raw: unknown, decision: "approve" | "deny" = "approve", principal: unknown = auth("resolver", "member-a", "a".repeat(43), decision)) => ({
  request: { interactionId: "request-1", callId: "call-1", toolName: tool, toolInput: raw }, response: { decision, principal },
  session: { id: "wrun_exact", initiator: auth(), turn: { id: "t", sequence: 1 } },
});
const def = { name: "helper", model: "fixture-brain", persona: "voice.md", role: "chief-of-staff", channels: [],
  grants: [{ capability: "calendar", scope: "write-with-confirm" }, { capability: "gmail", scope: "read" }],
  autonomy: { calendar: "gated" }, skills: [] };

/** Records every call Google would receive. */
function recordingCalendar() {
  const calls: Array<{ method: string; params: any }> = [];
  const api = { events: {
    list: async (params: unknown) => { calls.push({ method: "list", params }); return { data: { items: [] } }; },
    insert: async (params: unknown) => { calls.push({ method: "insert", params }); return { data: { id: "e1", summary: "Sync", start: { dateTime: "2026-01-01T10:00:00Z" }, end: { dateTime: "2026-01-01T10:30:00Z" } } }; },
    patch: async (params: unknown) => { calls.push({ method: "patch", params }); return { data: { id: "e1", summary: "Sync", start: { dateTime: "2026-01-01T10:00:00Z" }, end: { dateTime: "2026-01-01T10:30:00Z" } } }; },
    delete: async (params: unknown) => { calls.push({ method: "delete", params }); return { data: {} }; },
  } };
  return { api: api as unknown as Parameters<typeof wrapCalendarApi>[0], calls };
}

const CREATE = { summary: "Sync", start: "2026-01-01T10:00:00Z", end: "2026-01-01T10:30:00Z", attendees: ["guest@example.invalid"] };
const UPDATE = { eventId: "e1", start: "2026-01-02T10:00:00Z", end: "2026-01-02T10:30:00Z" };
const DELETE = { eventId: "e1", reason: "Cancelled by the organiser" };
const CASES = [
  { tool: "calendar_create_event", run: calendarCreateEvent, input: CREATE, method: "insert" },
  { tool: "calendar_update_event", run: calendarUpdateEvent, input: UPDATE, method: "patch" },
  { tool: "calendar_delete_event", run: calendarDeleteEvent, input: DELETE, method: "delete" },
] as const;

let container: StartedPostgreSqlContainer;
let calls: ReturnType<typeof recordingCalendar>["calls"];
const sqlDir = new URL("../../box/sql/", import.meta.url);
const rows = async () => (await getPool().query("SELECT * FROM approval_asks")).rows;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  vi.stubEnv("DATABASE_URL", container.getConnectionUri());
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const db = quiet(getPool());
  for (const f of readdirSync(sqlDir).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort()) await db.query(readFileSync(new URL(f, sqlDir), "utf8"));
  await db.query("INSERT INTO orgs(id,display_name) VALUES('fixture-org','Fixture'); INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('member-a','A','fixture-org','owner','active'),('member-b','B','fixture-org','owner','active')");
  await db.query("INSERT INTO agent_definitions(name,definition,hash,status) VALUES('helper',$1,'fixture-hash','valid')", [def]);
  await db.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending,applied_definition) VALUES('helper','172.30.0.99','fixture','owned',$1,$1,'ready',false,$2)", [inc, def]);
  await db.query("INSERT INTO org_member_policy(user_id,allowed_capabilities) VALUES('member-a',NULL),('member-b',NULL)");
}, 120_000);
afterAll(async () => { await closePool(); await container?.stop(); vi.unstubAllEnvs(); });

beforeEach(async () => {
  const db = getPool();
  await db.query("DELETE FROM approval_asks; DELETE FROM console_session_bindings; DELETE FROM agent_account_bindings; DELETE FROM connected_accounts; DELETE FROM oauth_tokens; DELETE FROM ratchet; DELETE FROM agent_access");
  await db.query("UPDATE agent_definitions SET status='valid' WHERE name='helper'");
  await db.query("UPDATE agent_resources SET pending=false,state='ready',ownership_token=$1,runtime_control_token=$1,applied_definition=$2 WHERE name='helper'", [inc, def]);
  await new PgGrantStore(db).adoptAgent("member-a", { agentName: "helper", expectedDefinitionHash: "fixture-hash" }, { designatedOwnerMemberId: "member-a" });
  // The owner's connected Google account, chosen as the agent's mailbox.
  const scopes = [...googlePersonalConsentScopes("read+mail-draft")];
  await db.query(`INSERT INTO connected_accounts (id,owner_member_id,connector_id,provider_issuer,provider_subject,provider_label,status,generation)
    VALUES ('acct-a','member-a','google','https://accounts.google.com','sub-a',$1,'ok',0)`, [MAILBOX]);
  await db.query(`INSERT INTO connected_resource_bindings (id,owner_member_id,connected_account_id,resource_kind,external_id,provider_label)
    VALUES ('res-a','member-a','acct-a','mailbox','sub-a',$1)`, [MAILBOX]);
  const token = await db.query(`INSERT INTO oauth_tokens (principal,provider,org_id,email_address,refresh_token_enc,scopes)
    VALUES ('member-a','google','fixture-org',$1,'fixture-encrypted',$2) RETURNING id`, [MAILBOX, scopes]);
  await db.query(`INSERT INTO connected_account_credentials (account_id,owner_member_id,connector_id,account_generation,oauth_token_id)
    VALUES ('acct-a','member-a','google',0,$1)`, [token.rows[0].id]);
  await db.query(`INSERT INTO agent_account_bindings (agent,purpose,owner_member_id,connected_account_id,resource_binding_id,account_generation,revision)
    VALUES ('helper','mailbox','member-a','acct-a','res-a',0,gen_random_uuid())`);
  await bindConsoleSession({ agent: "helper", incarnation: inc, sessionId: "wrun_exact", memberId: "member-a", admissionNonce: "a".repeat(43) });
  const stub = recordingCalendar();
  calls = stub.calls;
  useChosenMailbox({ mailbox: MAILBOX, calendarApi: stub.api as never });
});
afterEach(() => forgetChosenMailbox());

/** The card: the request callback, then the framework's attach of the request id. */
async function raise(tool: string, input: unknown, member = "member-a") {
  const result = await catalogueApprovalRequest(tool, context(tool, input, "human", member), () => "allow");
  if (result === "user-approval") await attachExactApproval({ requestId: "request-1", callId: "call-1", tool, input });
  return result;
}
const running = (tool: string, input: unknown) => context(tool, input, "resolver");

describe.each(CASES)("$tool in web chat", ({ tool, run, input, method }) => {
  it("shows the card first and writes nothing to Google until Approve", async () => {
    expect(await raise(tool, input)).toBe("user-approval");
    const [ask] = await rows();
    expect(ask.original_authority.target).toMatchObject({ kind: "calendar-event", ownerMemberId: "member-a" });
    expect(calls).toEqual([]);
    await expect(catalogueApprovalResponse(tool, answerCard(tool, input))).resolves.toEqual({ status: "allowed" });
    expect(calls).toEqual([]);
  });

  it("writes exactly once, on the chosen mailbox's calendar, with the exact input, after Approve", async () => {
    await raise(tool, input);
    await catalogueApprovalResponse(tool, answerCard(tool, input));
    await (run as any).execute(input, running(tool, input));
    expect(calls.map((c) => c.method)).toEqual([method]);
    expect(calls[0]!.params.calendarId).toBe("primary");
    if (method === "insert") expect(calls[0]!.params.requestBody).toMatchObject({ summary: "Sync", attendees: [{ email: "guest@example.invalid" }] });
    else expect(calls[0]!.params.eventId).toBe("e1");
  });

  it("writes once even when the same approved call is run again", async () => {
    await raise(tool, input);
    await catalogueApprovalResponse(tool, answerCard(tool, input));
    await (run as any).execute(input, running(tool, input));
    await expect((run as any).execute(input, running(tool, input))).rejects.toThrow(/already used|unavailable/);
    expect(calls).toHaveLength(1);
  });

  it("refuses a member who is not the owner: no card, no reservation, no Google call", async () => {
    await bindConsoleSession({ agent: "helper", incarnation: inc, sessionId: "wrun_exact", memberId: "member-b", admissionNonce: "a".repeat(43) }).catch(() => undefined);
    await expect(raise(tool, input, "member-b")).rejects.toThrow("Conversation authority");
    expect(await rows()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("refuses at Approve when ownership moved after the card; Google is untouched", async () => {
    await raise(tool, input);
    // Ownership is immutable in place: the agent is handed over by removing its access row and adopting it again.
    await getPool().query("DELETE FROM agent_access WHERE agent_name='helper'");
    await new PgGrantStore(getPool()).adoptAgent("member-b", { agentName: "helper", expectedDefinitionHash: "fixture-hash" }, { designatedOwnerMemberId: "member-b" });
    // The adapter itself, asked about the old owner and then the new one (no mailbox of theirs is chosen).
    await expect(calendarApprovalAdapter.readTarget(getPool(), input, "member-a", tool)).rejects.toThrow();
    await expect(calendarApprovalAdapter.readTarget(getPool(), input, "member-b", tool)).rejects.toThrow();
    await expect(catalogueApprovalResponse(tool, answerCard(tool, input))).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("refuses at Approve when the owner chose another mailbox after the card; Google is untouched", async () => {
    await raise(tool, input);
    await getPool().query("UPDATE agent_account_bindings SET revision=gen_random_uuid() WHERE agent='helper'");
    await expect(catalogueApprovalResponse(tool, answerCard(tool, input))).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("refuses at the write when ownership or the mailbox choice changed after Approve", async () => {
    await raise(tool, input);
    await catalogueApprovalResponse(tool, answerCard(tool, input));
    await getPool().query("UPDATE agent_account_bindings SET revision=gen_random_uuid() WHERE agent='helper'");
    await expect((run as any).execute(input, running(tool, input))).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("refuses at the card when it names another address", async () => {
    const other = { ...input, account: "someone-else@example.invalid" };
    const result = await raise(tool, other);
    expect(result).toMatchObject({ type: "denied" });
    expect(await rows()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("accepts the chosen mailbox's own address", async () => {
    expect(await raise(tool, { ...input, account: MAILBOX })).toBe("user-approval");
  });

  it("refuses at the card when no mailbox is chosen", async () => {
    await getPool().query("DELETE FROM agent_account_bindings");
    expect(await raise(tool, input)).toMatchObject({ type: "denied" });
    expect(await rows()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a Deny from anyone but the owner is refused like an Approve, and the card stays pending", async () => {
    await raise(tool, input);
    const refused = [
      answerCard(tool, input, "deny", auth("resolver", "member-b", "a".repeat(43), "deny")),
      answerCard(tool, input, "deny", auth("resolver", "member-a", "b".repeat(43), "deny")),
      answerCard(tool, input, "deny", { authenticator: "slack-webhook", principalId: "U1", principalType: "user", attributes: { user_id: "U1" } }),
      answerCard(tool, input, "deny", null),
    ];
    for (const card of refused) await expect(catalogueApprovalResponse(tool, card)).rejects.toThrow();
    expect((await rows())[0].outcome).toBeNull();
    // The owner's own Deny is allowed, writes no approval, and the write never happens.
    await expect(catalogueApprovalResponse(tool, answerCard(tool, input, "deny"))).resolves.toEqual({ status: "allowed" });
    expect((await rows())[0].outcome).toBeNull();
    await expect((run as any).execute(input, running(tool, input))).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("refuses a changed call at Approve", async () => {
    await raise(tool, input);
    const changed = tool === "calendar_delete_event" ? { ...input, eventId: "e2" } : { ...input, eventId: "e2", summary: "Other" };
    await expect(catalogueApprovalResponse(tool, answerCard(tool, changed))).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("the calendar policy", () => {
  it("raises no card when the calendar grant is gone", async () => {
    await getPool().query("UPDATE agent_resources SET applied_definition=$1 WHERE name='helper'", [{ ...def, grants: [{ capability: "gmail", scope: "read" }] }]);
    expect(await raise("calendar_create_event", CREATE)).toMatchObject({ type: "denied" });
    expect(await rows()).toEqual([]);
  });
  it("refuses at Approve when the board turned calendar off after the card", async () => {
    await raise("calendar_create_event", CREATE);
    await getPool().query("INSERT INTO ratchet(agent,capability,level,updated_by) VALUES('helper','calendar','never','fixture')");
    await expect(catalogueApprovalResponse("calendar_create_event", answerCard("calendar_create_event", CREATE))).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
