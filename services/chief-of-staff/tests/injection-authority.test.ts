/** The injection test suite, part three: authority.
 *
 * Part one (packages/compose-contract/tests/injection-forge.test.ts) checks the corpus and the
 * block contract; part two (./injection-corpus.test.ts) shows every prompt builder quarantines
 * outside text. Neither can show that a decision ignores what the text CLAIMS. This file does,
 * for the seven authority families in the corpus (AUTHORITY_FAMILIES):
 *
 *   1. claimed-approval     outside or quoted text claims the user approved something
 *   2. replayed-request     another member's request replayed as the current actor's
 *   3. private-laundering   private mail or DM content laundered through a shared agent, skill or history
 *   4. audience-widening    an attempt to widen a conversation's audience
 *   5. revoked-replay       a delayed action after the permission was revoked
 *   6. account-swap         a changed account behind a stable connection
 *   7. procedure-execution  a procedure edit treated as permission to execute it
 *
 * Each case puts the family's English and Norwegian attack text, and its benign look-alikes,
 * where an attacker controls text (a tool argument, a label a provider returns, a tool
 * description an outside server writes) and shows the decision is the same for all of them:
 * it follows what the server knows (the authenticated human, the resource, the exact action and
 * its version, the current grant), never the words.
 *
 * Real storage (every services/box/sql migration on pgvector PostgreSQL) and the real
 * authorisation code: exact approvals, the grant store, the Vault area store, the account
 * store, the permissions board, the outside approval adapter and the outside pin check. The
 * only stand-ins are the provider side of an account verifier and an outside server's
 * tools/list answer — the two things that are, by definition, outside the engine.
 *
 * What the engine cannot decide yet is an it.todo or an it.skip with its reason; nothing here
 * is reported as covered unless a test exercises it. No model, no network, no credentials.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { getPool, closePool } from '@lares/agent-kit/db';
import { PgGrantStore } from '@lares/agent-kit/grant-store';
import { PgVaultStore } from '@lares/agent-kit/vault-area-store';
import { PgAccountStore, AccountAccessError, type TrustedAccountAdapter } from '@lares/agent-kit/account-store';
import {
  bindConsoleSession, requireConsoleTurnAuthority, retireConsoleSession, consoleRouteAdmission,
  CONSOLE_MEMBER_ID_HEADER, CONSOLE_ADMISSION_HEADER, CONSOLE_PURPOSE_HEADER,
} from '@lares/agent-kit/console-turn-authority';
import {
  reserveExactApproval, attachExactApproval, approveExactResponse, requireApprovedExecution, requireBoundExactApproval,
} from '@lares/agent-kit/approval-execution';
import { APPROVAL_TTL_MS } from '@lares/agent-kit/approval-ledger';
import { decideApproval, type BoardDeps } from '@lares/agent-kit/board-approval';
import { KitRatchet } from '@lares/agent-kit/ratchet';
import { audienceWidens, audienceWithinReaders, type Audience } from '@lares/agent-kit/authority-contract';
import { taintTurn, stampFor, clearTurn, resetTaintForTests } from '@lares/agent-kit/origin-taint';
import { outsideApprovalAdapter } from '@lares/agent-kit/outside-approval';
import { assertSkillsWithinGrants } from '@lares/agent-kit/skill-grants';
import { checkEntryPin, pgPinStore, type ListedTool } from '../../../packages/agent-kit/src/outside-pins.js';
import { deadlineApprovalAdapter, dismissExactDeadline } from '../lib/deadlines-store.js';
import { followupApproval, FOLLOWUP_CAPABILITY } from '../catalogue/meeting_followup_send.js';
import { recordSent, lastRecipientsFingerprint } from '../lib/meeting-followup-store.js';
import {
  loadInjectionCorpus, AUTHORITY_FAMILIES, type AuthorityFamily, type InjectionCase,
} from '../../../packages/compose-contract/tests/injection-corpus.js';

// ── the corpus ──────────────────────────────────────────────────────────────────────────────
const corpus = loadInjectionCorpus();
const attacks = (f: AuthorityFamily): InjectionCase[] => corpus.filter((c) => c.family === f);
const lookalikes = (f: AuthorityFamily): InjectionCase[] => corpus.filter((c) => c.lookalikeOf === f);
/** Every text of one case: the attacks and the benign look-alikes. The decision must not differ. */
const texts = (f: AuthorityFamily): InjectionCase[] => [...attacks(f), ...lookalikes(f)];

// ── fixture installation: neutral placeholders only ────────────────────────────────────────
type MemberId = 'member-a' | 'member-b';
const INC = '11111111-1111-4111-8111-111111111111';
const OUTSIDE_INC = '33333333-3333-4333-8333-333333333333';
const NONCE: Record<MemberId, string> = { 'member-a': 'a'.repeat(43), 'member-b': 'b'.repeat(43) };
const SESSION: Record<MemberId, string> = { 'member-a': 'wrun_a', 'member-b': 'wrun_b' };
const env = { LARES_AGENT_NAME: 'helper', LARES_AGENT_INCARNATION: INC, AGENT_OWNER_USER_ID: 'member-a' };
const DEADLINE_A = '11111111-2222-4333-8444-555555555555';
const DEADLINE_A2 = '11111111-2222-4333-8444-666666666666';
const DEADLINE_B = '11111111-2222-4333-8444-777777777777';
const def = { name: 'helper', model: 'fixture-brain', persona: 'voice.md', role: 'chief-of-staff', channels: [],
  grants: [{ capability: 'deadline', scope: 'write-with-confirm' }], autonomy: { deadline: 'gated' }, skills: [] };
const outsideDef = (url = 'https://mail.example.com/mcp') => ({
  name: 'outside-helper', model: 'fixture-brain', persona: 'voice.md', role: 'chief-of-staff', channels: [],
  grants: [{ capability: 'outside', scope: 'read' }], autonomy: { outside: 'gated' }, skills: [],
  outsideTools: [{ name: 'mail', url, description: 'Mail tools', token: true, tools: { allow: ['search'], read: ['search'] }, trusted: false }],
});
const OPTS = { adapter: deadlineApprovalAdapter };
const AREA_AUTHORITY = { designatedOwnerMemberId: 'member-a' };

const auth = (purpose: 'human' | 'resolver', member: MemberId, option: 'approve' | 'deny' = 'approve') => ({
  authenticator: 'lares-console', principalId: member, principalType: 'user',
  attributes: { user_id: member, lares_member_id: member, lares_admission_nonce: NONCE[member], lares_purpose: purpose,
    ...(purpose === 'resolver' ? { lares_resume_request_id: 'request-1', lares_resume_option: option } : {}) },
});
/** A tool-call context as eve hands it to the catalogue: who is speaking (current) and who opened
 *  the session (initiator) come from the authenticated console admission, never from content. */
function ctx(o: { raw: unknown; member?: MemberId; purpose?: 'human' | 'resolver'; session?: string; callId?: string }) {
  const member = o.member ?? 'member-a', purpose = o.purpose ?? 'human';
  // eve 1.0: an approved call runs as the person who ASKED, in the original turn; the person who answered
  // is only `approval.responder`. `purpose: 'resolver'` is that approved run.
  return {
    callId: o.callId ?? 'call-1', toolName: 'deadline_dismiss', toolInput: o.raw,
    abortSignal: new AbortController().signal,
    session: {
      id: o.session ?? SESSION[member],
      turn: { id: 'turn-original', sequence: 0 },
      auth: { current: auth('human', member), initiator: auth('human', member) },
    },
    ...(purpose === 'resolver' ? { approval: { responder: auth('resolver', member) } } : {}),
  };
}
const response = (raw: unknown, o: { responder?: MemberId; initiator?: MemberId; purpose?: 'human' | 'resolver'; session?: string; decision?: 'approve' | 'deny' } = {}) => ({
  request: { interactionId: 'request-1', callId: 'call-1', toolName: 'deadline_dismiss', toolInput: raw },
  response: { decision: o.decision ?? 'approve', principal: auth(o.purpose ?? 'resolver', o.responder ?? 'member-a', o.decision ?? 'approve') },
  session: { id: o.session ?? SESSION[o.initiator ?? 'member-a'], initiator: auth('human', o.initiator ?? 'member-a'), turn: { id: 'turn-resolver', sequence: 1 } },
});
const dismiss = (text: string, id = DEADLINE_A) => ({ id, reason: text });

/** The card is raised: reservation (before the card) and request id (when eve emits it). */
async function reserved(raw: unknown, member: MemberId = 'member-a') {
  await reserveExactApproval(ctx({ raw, member }), 'deadline_dismiss', OPTS);
  await attachExactApproval({ requestId: 'request-1', callId: 'call-1', tool: 'deadline_dismiss', input: raw });
}
/** ...and the member who raised it answers it on the card. */
async function approved(raw: unknown, member: MemberId = 'member-a') {
  await reserved(raw, member);
  await approveExactResponse(response(raw, { responder: member, initiator: member }), OPTS);
}
const execute = (raw: { id: string; reason: string }, member: MemberId = 'member-a') =>
  dismissExactDeadline(getPool(), ctx({ raw, member, purpose: 'resolver' }) as never, raw);
async function statusOf(id: string): Promise<string> {
  return (await getPool().query('SELECT status FROM deadlines WHERE id=$1', [id])).rows[0].status;
}
const bind = (member: MemberId, session = SESSION[member]) =>
  bindConsoleSession({ agent: 'helper', incarnation: INC, sessionId: session, memberId: member, admissionNonce: NONCE[member] });
/** Changes who the owner shares the agent with, then rebinds the owner's own session: a sharing
 *  change advances the agent's access revision, which (correctly) retires every older binding. */
async function share(grants: { principal: { kind: 'member'; id: MemberId }; permission: 'use' | 'edit'; expiresAt: null }[]) {
  const store = new PgGrantStore(getPool());
  const current = await store.agentAccess('member-a', 'helper');
  await store.updateAgentAccess('member-a', { agentName: 'helper', expectedRevision: current!.accessRevision, grants });
  await getPool().query('DELETE FROM console_session_bindings');
  await bind('member-a');
}
const use = (id: MemberId) => ({ principal: { kind: 'member' as const, id }, permission: 'use' as const, expiresAt: null });
const edit = (id: MemberId) => ({ principal: { kind: 'member' as const, id }, permission: 'edit' as const, expiresAt: null });

let container: StartedPostgreSqlContainer;
const sqlDir = new URL('../../box/sql/', import.meta.url);

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  vi.stubEnv('DATABASE_URL', container.getConnectionUri());
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const db = getPool(); db.on('error', () => undefined); db.on('connect', (c) => c.on('error', () => undefined));
  for (const f of readdirSync(sqlDir).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort()) await db.query(readFileSync(new URL(f, sqlDir), 'utf8'));
  await db.query("INSERT INTO orgs(id,display_name) VALUES('fixture-org','Fixture')");
  await db.query("INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('member-a','A','fixture-org','owner','active'),('member-b','B','fixture-org','owner','active')");
  await db.query("INSERT INTO org_member_policy(user_id,allowed_capabilities) VALUES('member-a',NULL)");
  await db.query("INSERT INTO agent_definitions(name,definition,hash,status) VALUES('helper',$1,'fixture-hash','valid')", [def]);
  await db.query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending,applied_definition)
    VALUES('helper','172.30.0.99','fixture','owned',$1,$1,'ready',false,$2)`, [INC, def]);
  await db.query("INSERT INTO agent_definitions(name,definition,hash,status) VALUES('outside-helper',$1,'outside-hash','valid')", [outsideDef()]);
  await db.query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending,applied_definition)
    VALUES('outside-helper','172.30.0.98','fixture-outside','owned',$1,$1,'ready',false,$2)`, [OUTSIDE_INC, outsideDef()]);
  await new PgGrantStore(db).adoptAgent('member-a', { agentName: 'helper', expectedDefinitionHash: 'fixture-hash' }, { designatedOwnerMemberId: 'member-a' });
  const vault = new PgVaultStore(db);
  await vault.provisionBacking('member-a', { id: 'backing', kind: 'git' }, AREA_AUTHORITY);
  await vault.provisionArea('member-a', { id: 'private-a', kind: 'private', owner: { kind: 'member', id: 'member-a' }, backingStoreId: 'backing', relativePath: 'private-a' }, AREA_AUTHORITY);
  await vault.provisionArea('member-a', { id: 'team', kind: 'shared', owner: { kind: 'organisation', id: 'fixture-org' }, backingStoreId: 'backing', relativePath: 'team' }, AREA_AUTHORITY);
}, 120_000);
afterAll(async () => { await closePool(); await container?.stop(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  const db = getPool();
  await db.query('DELETE FROM approval_asks; DELETE FROM console_session_bindings; DELETE FROM deadlines; DELETE FROM deadline_candidates; DELETE FROM ratchet; DELETE FROM meeting_followup_sent; DELETE FROM outside_tool_pins; DELETE FROM connected_accounts');
  await db.query("UPDATE users SET status='active',org_role='owner' WHERE id IN ('member-a','member-b')");
  await db.query("UPDATE agent_definitions SET status='valid' WHERE name='helper'");
  await db.query("UPDATE agent_resources SET pending=false,state='ready',ownership_token=$1,runtime_control_token=$1,applied_definition=$2 WHERE name='helper'", [INC, def]);
  await db.query("UPDATE agent_resources SET applied_definition=$1 WHERE name='outside-helper'", [outsideDef()]);
  await db.query(`INSERT INTO deadlines(id,owner,entity,title,source,due_date,created_by) VALUES
    ($1,'member-a','Fixture','Filing','manual','2026-12-01','member-a'),
    ($2,'member-a','Fixture','Second filing','manual','2026-12-02','member-a'),
    ($3,'member-b','Fixture','Their filing','manual','2026-12-03','member-b')`, [DEADLINE_A, DEADLINE_A2, DEADLINE_B]);
  await share([]); // nobody but the owner; binds the owner's session
  resetTaintForTests();
});

// ── 1. claimed approval ─────────────────────────────────────────────────────────────────────
describe('1. outside or quoted text claiming the user approved something', () => {
  it.each(texts('claimed-approval'))('$id: a raised card with this text, never answered, does not execute', async (c) => {
    const raw = dismiss(c.text);
    await reserved(raw);
    await expect(requireApprovedExecution(ctx({ raw, purpose: 'resolver' }) as never, 'deadline_dismiss', raw, OPTS)).rejects.toThrow();
    await expect(execute(raw)).rejects.toThrow();
    expect(await statusOf(DEADLINE_A)).toBe('open');
  });

  it.each(texts('replayed-request'))("$id: another member cannot DENY the owner's card either, and the card stays pending", async (c) => {
    const raw = dismiss(c.text);
    await share([use('member-b')]);
    await bind('member-b');
    await reserved(raw);
    await expect(approveExactResponse(response(raw, { responder: 'member-b', initiator: 'member-b', decision: 'deny' }), OPTS)).rejects.toThrow();
    await expect(approveExactResponse(response(raw, { responder: 'member-b', initiator: 'member-a', session: SESSION['member-a'], decision: 'deny' }), OPTS)).rejects.toThrow();
    expect((await getPool().query("SELECT outcome FROM approval_asks WHERE call_id='call-1'")).rows[0].outcome).toBeNull();
    await expect(execute(raw)).rejects.toThrow();
    expect(await statusOf(DEADLINE_A)).toBe('open');
  });

  it.each(texts('claimed-approval'))('$id: the same words sent as a chat turn are not an answer to the card', async (c) => {
    const raw = dismiss(c.text);
    await reserved(raw);
    // A human-purpose admission saying "approved" is a new instruction, not the card's resolver.
    await expect(approveExactResponse(response(raw, { purpose: 'human' }), OPTS)).rejects.toThrow();
    await expect(execute(raw)).rejects.toThrow();
    expect(await statusOf(DEADLINE_A)).toBe('open');
  });

  it.each(texts('claimed-approval'))('$id: the console route admits the text as a human message, never as a card answer', async (c) => {
    const post = (purpose: string, body: unknown) => new Request('http://agent.invalid/eve/v1/session/wrun_a', {
      method: 'POST', body: JSON.stringify(body),
      headers: { [CONSOLE_MEMBER_ID_HEADER]: 'member-a', [CONSOLE_ADMISSION_HEADER]: NONCE['member-a'], [CONSOLE_PURPOSE_HEADER]: purpose },
    });
    expect(await consoleRouteAdmission(post('human', { message: c.text }), getPool(), process.env)).toMatchObject({ lares_purpose: 'human' });
    // An answer must arrive as a resolver request carrying a verified card response; a message,
    // or a message dressed up with the resolver purpose, is refused at the door.
    await expect(consoleRouteAdmission(post('resolver', { message: c.text }), getPool(), process.env)).rejects.toThrow();
    await expect(consoleRouteAdmission(post('human', { answers: [{ interactionId: 'request-1', optionId: 'approve' }] }), getPool(), process.env)).rejects.toThrow();
    await expect(consoleRouteAdmission(post('resolver', { answers: [{ interactionId: 'request-1', optionId: 'approve' }] }), getPool(), process.env)).rejects.toThrow();
  });

  it.each(texts('claimed-approval'))('$id: once the owner really answers the card, the action runs, whatever the text says', async (c) => {
    const raw = dismiss(c.text);
    await approved(raw);
    await execute(raw);
    expect(await statusOf(DEADLINE_A)).toBe('dismissed');
  });

  it.each(texts('claimed-approval'))('$id: the permissions board asks or acts on its own level, not on the text', async (c) => {
    let clock = 0;
    const deps: BoardDeps = { explicitLevel: (a, cap, act) => new KitRatchet(getPool()).explicitLevel(a, cap, act), record: async () => {}, now: () => clock };
    const decide = () => decideApproval({ agent: 'helper', tool: 'deadline_add', capability: 'deadline', startingLevel: 'gated', toolInput: { title: c.text } }, deps);
    expect((await decide()).status).toBe('user-approval');
    await getPool().query("INSERT INTO ratchet(agent,capability,level,updated_by) VALUES('helper','deadline','autonomous','fixture')");
    expect((await decide()).status).toBe('not-applicable');
  });
});

// ── 2. another member's request replayed ───────────────────────────────────────────────────
describe("2. another member's request replayed as if the current actor made it", () => {
  it.each(texts('replayed-request'))('$id: a member the agent is not shared with cannot open a session or raise the card', async (c) => {
    await expect(bind('member-b')).rejects.toThrow();
    await expect(reserveExactApproval(ctx({ raw: dismiss(c.text), member: 'member-b' }), 'deadline_dismiss', OPTS)).rejects.toThrow();
    expect(await statusOf(DEADLINE_A)).toBe('open');
  });

  it.each(texts('replayed-request'))("$id: another member cannot answer the owner's card", async (c) => {
    const raw = dismiss(c.text);
    await share([use('member-b')]);
    await bind('member-b');
    await reserved(raw);
    await expect(approveExactResponse(response(raw, { responder: 'member-b', initiator: 'member-b' }), OPTS)).rejects.toThrow();
    await expect(approveExactResponse(response(raw, { responder: 'member-b', initiator: 'member-a', session: SESSION['member-a'] }), OPTS)).rejects.toThrow();
    await expect(execute(raw)).rejects.toThrow();
    expect(await statusOf(DEADLINE_A)).toBe('open');
  });

  it.each(texts('replayed-request'))("$id: a shared member's own session cannot replay the owner's approved call or act on the owner's resource", async (c) => {
    const raw = dismiss(c.text);
    await share([use('member-b')]);
    await bind('member-b');
    await approved(raw);
    // the owner's approved call, presented from the other member's session
    await expect(requireBoundExactApproval({ agent: 'helper', incarnation: INC, sessionId: SESSION['member-b'], memberId: 'member-b', admissionNonce: NONCE['member-b'], callId: 'call-1' },
      'deadline_dismiss', raw, OPTS)).rejects.toThrow();
    await expect(execute(raw, 'member-b')).rejects.toThrow();
    // the same request, made afresh by the other member against the owner's deadline
    await getPool().query('DELETE FROM approval_asks');
    await expect(reserveExactApproval(ctx({ raw, member: 'member-b' }), 'deadline_dismiss', OPTS)).rejects.toThrow();
    expect(await statusOf(DEADLINE_A)).toBe('open');
  });

  it.each(texts('replayed-request'))('$id: the shared member can still act on their own resource with the same words', async (c) => {
    const raw = dismiss(c.text, DEADLINE_B);
    await share([use('member-b')]);
    await bind('member-b');
    await approved(raw, 'member-b');
    await execute(raw, 'member-b');
    expect(await statusOf(DEADLINE_B)).toBe('dismissed');
    expect(await statusOf(DEADLINE_A)).toBe('open');
  });
});

// ── 3. private content laundered ───────────────────────────────────────────────────────────
describe('3. private mail or DM content laundered through a shared agent, skill or history', () => {
  const area = (id: string) => ({ kind: 'vault-area', id });

  it("a member the agent is shared with cannot read the owner's private Vault area, even with a grant naming it", async () => {
    await share([use('member-b')]);
    const grants = new PgGrantStore(getPool());
    expect(await grants.can('member-a', area('private-a'), 'use')).toBe(true);
    expect(await grants.can('member-b', area('private-a'), 'use')).toBe(false);
    // a private area is its owner's alone: neither the store nor the database records a grant
    // naming anyone else on it, so there is no row a laundering request could point at
    const vault = new PgVaultStore(getPool());
    const revision = Number((await getPool().query("SELECT revision FROM vault_areas WHERE id='private-a'")).rows[0].revision);
    await expect(vault.configureAccess('member-a', { areaId: 'private-a', expectedRevision: revision, grants: [use('member-b')] }, AREA_AUTHORITY)).rejects.toThrow();
    await expect(getPool().query(`INSERT INTO resource_grants(id,resource_kind,resource_id,principal_member_id,permission,grantor_member_id,issued_access_revision)
      VALUES(gen_random_uuid(),'vault-area','private-a','member-b','use','member-a',$1)`, [revision])).rejects.toThrow('Vault grant unavailable');
    expect(await grants.can('member-b', area('private-a'), 'use')).toBe(false);
    // control: an organisation area the owner shares is readable, so the refusal above is the area's kind
    const team = Number((await getPool().query("SELECT revision FROM vault_areas WHERE id='team'")).rows[0].revision);
    await vault.configureAccess('member-a', { areaId: 'team', expectedRevision: team, grants: [use('member-b')] }, AREA_AUTHORITY);
    expect(await grants.can('member-b', area('team'), 'use')).toBe(true);
  });

  it("the owner's exact mailbox selection, replayed by another member, opens nothing", async () => {
    const adapter: TrustedAccountAdapter = {
      connectorId: 'example',
      verifyAccount: async () => ({ issuer: 'https://provider.example', subject: 'subject-a', label: 'Personal account' }),
      verifyResource: async () => ({ resourceKind: 'mailbox', externalId: 'mailbox-a', providerLabel: 'Inbox' }),
    };
    const store = new PgAccountStore(getPool());
    const account = await store.forTrustedAdapter(adapter).createPersonalAccount('member-a', 'evidence', undefined, ['resource-evidence']);
    const [mailbox] = await store.listResources('member-a', account.id, account.generation);
    const selection = { accountId: account.id, generation: account.generation, resourceBindingId: mailbox!.id };
    await share([use('member-b')]);
    await expect(store.resolvePersonalResource('member-a', selection, 'mailbox')).resolves.toMatchObject({ resource: { externalId: 'mailbox-a' } });
    await expect(store.resolvePersonalResource('member-b', selection, 'mailbox')).rejects.toThrow(AccountAccessError);
    const work = vi.fn();
    await expect(store.withPersonalResourceCredential('member-b', selection, 'mailbox', work)).rejects.toThrow(AccountAccessError);
    expect(work).not.toHaveBeenCalled();
  });

  it.each(texts('private-laundering'))("$id: after a turn reads mail, a memory write is stamped as somebody else's words, whatever it claims", (c) => {
    // The stamp is computed from what the turn READ; the text it would write is not an input.
    const turn = { sessionId: SESSION['member-a'], turnId: `turn-${c.id}` };
    expect(stampFor('owner', turn)).toBe('owner');
    taintTurn(turn, 'third_party'); // a mailbox read returned this text in this turn
    expect(stampFor('owner', turn)).toBe('third_party');
    expect(stampFor('agent', turn)).toBe('third_party');
    taintTurn(turn, 'synced'); // a later, more trusted read never raises it again
    expect(stampFor('owner', turn)).toBe('third_party');
    clearTurn(turn);
    expect(stampFor('owner', { sessionId: SESSION['member-b'], turnId: `turn-${c.id}` })).toBe('owner');
  });

  it('a skill cannot carry access its agent was not granted', () => {
    expect(() => assertSkillsWithinGrants({ grants: [{ capability: 'vault', scope: 'read', areas: ['shared'] }],
      skills: [{ name: 'commercial', requires: [{ capability: 'vault', scope: 'read', areas: ['private'] }] }] })).toThrow('never widen');
    expect(() => assertSkillsWithinGrants({ grants: [{ capability: 'vault', scope: 'read', areas: ['shared'] }],
      skills: [{ name: 'commercial', requires: [{ capability: 'vault', scope: 'read', areas: ['shared'] }] }] })).not.toThrow();
  });

  it.todo("not testable yet: a second member reading the shared agent's conversation history or agent memory — member-scoped history and complete audience filtering are not built (docs/member-authority.md)");
});

// ── 4. audience widening ────────────────────────────────────────────────────────────────────
describe("4. an attempt to widen a conversation's audience", () => {
  const audience: Audience = { placeId: `console:helper:${INC}:wrun_a`, revision: 1, participants: [{ kind: 'member', memberId: 'member-a' }] };
  const privateSource = { resource: { kind: 'vault-area', id: 'private-a' }, revision: 1, currentReaders: [{ kind: 'member', memberId: 'member-a' }] };

  it('adding a member, an outside address or another place is a widening; a widened audience cannot read a private source', () => {
    const plusMember: Audience = { ...audience, participants: [...audience.participants, { kind: 'member', memberId: 'member-b' }] };
    const plusOutside: Audience = { ...audience, participants: [...audience.participants, { kind: 'external', platform: 'mail', workspaceId: 'example.com', subject: 'partner@example.com' }] };
    expect(audienceWidens(audience, audience)).toBe(false);
    expect(audienceWidens(audience, plusMember)).toBe(true);
    expect(audienceWidens(audience, plusOutside)).toBe(true);
    expect(audienceWidens(audience, { ...audience, placeId: 'console:helper:elsewhere' })).toBe(true);
    expect(audienceWithinReaders(audience, privateSource)).toBe(true);
    expect(audienceWithinReaders(plusMember, privateSource)).toBe(false);
    expect(audienceWithinReaders(plusOutside, privateSource)).toBe(false);
  });

  it.each(texts('audience-widening'))("$id: the turn's audience is the session's bound member, whatever the turn says", async (c) => {
    const authority = await requireConsoleTurnAuthority(ctx({ raw: { message: c.text } }) as never);
    expect(authority.audience.participants).toEqual([{ kind: 'member', memberId: 'member-a' }]);
    expect(authority.actingMemberId).toBe('member-a');
  });

  it.each(texts('audience-widening'))("$id: another member cannot join the owner's session, even when the agent is shared with them", async (c) => {
    await share([use('member-b')]);
    await expect(bind('member-b', SESSION['member-a'])).rejects.toThrow();
    await expect(requireConsoleTurnAuthority(ctx({ raw: { message: c.text }, member: 'member-b', session: SESSION['member-a'] }) as never)).rejects.toThrow();
    // control: their own session works, and its audience is them alone
    await bind('member-b');
    const theirs = await requireConsoleTurnAuthority(ctx({ raw: { message: c.text }, member: 'member-b' }) as never);
    expect(theirs.audience.participants).toEqual([{ kind: 'member', memberId: 'member-b' }]);
  });

  it.each(texts('audience-widening'))('$id: an auto-sending follow-up series asks again when its recipients grow, not when the body asks for more', async (c) => {
    const decide = followupApproval({
      level: (seriesKey) => new KitRatchet(getPool()).level('helper', FOLLOWUP_CAPABILITY, seriesKey),
      lastFingerprint: (seriesKey) => lastRecipientsFingerprint(getPool(), seriesKey),
    });
    const usual = ['sam@example.com', 'taylor@example.com'];
    await getPool().query("INSERT INTO ratchet(agent,capability,action,level,updated_by) VALUES('helper',$1,'series-1','autonomous','fixture')", [FOLLOWUP_CAPABILITY]);
    await recordSent(getPool(), 'page-0', 'series-1', usual);
    const call = (to: string[]) => decide({ toolInput: { seriesKey: 'series-1', to, subject: 'Notes', bodyText: c.text } } as never);
    expect(await call(usual)).toBe('approved');
    expect(await call([...usual, 'partner@example.com'])).toBe('user-approval');
  });

  it.todo('not testable yet: shared multi-member conversations and channel audiences — every console session is a singleton audience today (docs/member-authority.md)');
});

// ── 5. delayed action after revocation ─────────────────────────────────────────────────────
describe('5. a delayed action after the permission was revoked', () => {
  const revocations: [string, () => Promise<unknown>][] = [
    ['the session was retired', () => retireConsoleSession({ agent: 'helper', incarnation: INC, sessionId: SESSION['member-a'], memberId: 'member-a', admissionNonce: NONCE['member-a'] })],
    ['the board was switched off', () => getPool().query("INSERT INTO ratchet(agent,capability,level,updated_by) VALUES('helper','deadline','never','fixture')")],
    ['the member was removed', () => getPool().query("UPDATE users SET status='removed' WHERE id='member-a'")],
  ];
  for (const [label, revoke] of revocations) {
    it.each(texts('revoked-replay'))(`$id: an approved call does not run after ${label}`, async (c) => {
      const raw = dismiss(c.text);
      await approved(raw);
      await revoke();
      await expect(execute(raw)).rejects.toThrow();
      expect(await statusOf(DEADLINE_A)).toBe('open');
    });
  }

  it.each(texts('revoked-replay'))('$id: an approved call does not run after its approval window', async (c) => {
    const raw = dismiss(c.text);
    await approved(raw);
    await expect(requireApprovedExecution(ctx({ raw, purpose: 'resolver' }) as never, 'deadline_dismiss', raw,
      { ...OPTS, now: new Date(Date.now() + APPROVAL_TTL_MS + 60_000) })).rejects.toThrow();
    expect(await statusOf(DEADLINE_A)).toBe('open');
  });

  it.each(texts('revoked-replay'))("$id: a shared member's open session stops when the owner stops sharing", async (c) => {
    await share([use('member-b')]);
    await bind('member-b');
    await expect(requireConsoleTurnAuthority(ctx({ raw: { message: c.text }, member: 'member-b' }) as never)).resolves.toBeTruthy();
    await share([]);
    await expect(requireConsoleTurnAuthority(ctx({ raw: { message: c.text }, member: 'member-b' }) as never)).rejects.toThrow();
    await expect(reserveExactApproval(ctx({ raw: dismiss(c.text, DEADLINE_B), member: 'member-b' }), 'deadline_dismiss', OPTS)).rejects.toThrow();
    expect(await statusOf(DEADLINE_B)).toBe('open');
  });

  // The native approval path (every tool without an exact adapter) asks the board again when an
  // answered card resumes, reading the board fresh each time.
  const nativeResume = async (afterMs: number) => {
    let clock = 0;
    const deps: BoardDeps = { explicitLevel: (a, cap, act) => new KitRatchet(getPool()).explicitLevel(a, cap, act), record: async () => {}, now: () => clock };
    const decide = () => decideApproval({ agent: 'helper', tool: 'deadline_add', capability: 'deadline', startingLevel: 'gated', toolInput: { title: attacks('revoked-replay')[0]!.text } }, deps);
    await getPool().query("INSERT INTO ratchet(agent,capability,level,updated_by) VALUES('helper','deadline','autonomous','fixture')");
    expect((await decide()).status).toBe('not-applicable');
    await getPool().query("UPDATE ratchet SET level='never' WHERE agent='helper' AND capability='deadline'");
    clock += afterMs;
    return decide();
  };

  it('the native path refuses a resumed call immediately after the board is switched off', async () => {
    expect((await nativeResume(1_000)).decision).toBe('denied');
  });

  it.todo('not testable yet: a queued personal action dispatched after its grant is revoked — no personal-action executor exists (personal-action-store.ts)');
});

// ── 6. changed account behind a stable connection ──────────────────────────────────────────
describe('6. a changed account behind a stable connection', () => {
  let subject = 'subject-a', label = 'Personal account';
  const adapter: TrustedAccountAdapter = {
    connectorId: 'example',
    verifyAccount: async () => ({ issuer: 'https://provider.example', subject, label }),
    verifyResource: async () => ({ resourceKind: 'mailbox', externalId: 'mailbox-a', providerLabel: 'Inbox' }),
  };
  const store = () => new PgAccountStore(getPool());
  async function connected() {
    subject = 'subject-a'; label = 'Personal account';
    const account = await store().forTrustedAdapter(adapter).createPersonalAccount('member-a', 'evidence', undefined, ['resource-evidence']);
    const [mailbox] = await store().listResources('member-a', account.id, account.generation);
    return { account, selection: { accountId: account.id, generation: account.generation, resourceBindingId: mailbox!.id } };
  }

  it.each(texts('account-swap'))('$id: a reconnect that comes back as another provider account is refused, whatever its label says', async (c) => {
    const { account, selection } = await connected();
    const ticket = await store().beginUpdate('member-a', account.id, account.generation);
    subject = 'subject-b'; label = c.text;
    await expect(store().forTrustedAdapter(adapter).renew('member-a', ticket, 'evidence')).rejects.toThrow(AccountAccessError);
    const after = await store().read('member-a', account.id);
    expect(after.providerAccount).toMatchObject({ subject: 'subject-a', label: 'Personal account' });
    expect(after.generation).toBe(account.generation);
    await expect(store().resolvePersonalResource('member-a', selection, 'mailbox')).resolves.toBeTruthy();
  });

  it.each(texts('account-swap'))('$id: a reconnect of the same account still retires every selection captured before it', async (c) => {
    const { account, selection } = await connected();
    const ticket = await store().beginUpdate('member-a', account.id, account.generation);
    label = c.text; // same issuer and subject; the label is display text, never proof
    const renewed = await store().forTrustedAdapter(adapter).renew('member-a', ticket, 'evidence');
    expect(renewed.generation).toBeGreaterThan(account.generation);
    await expect(store().resolvePersonalResource('member-a', selection, 'mailbox')).rejects.toThrow(AccountAccessError);
    await expect(store().resolvePersonalResource('member-a', { ...selection, generation: renewed.generation }, 'mailbox')).resolves.toBeTruthy();
  });

  it('a replacement account needs the reviewed-replacement step and never inherits the old selection', async () => {
    const { account, selection } = await connected();
    const ticket = await store().beginUpdate('member-a', account.id, account.generation);
    subject = 'subject-b';
    // refused before any provider work: the review flag is a typed server parameter, not text
    await expect((async () => store().forTrustedAdapter(adapter).replace('member-a', ticket, 'evidence', {} as never))()).rejects.toThrow();
    expect((await store().read('member-a', account.id)).status).toBe('ok');
    const replacement = await store().forTrustedAdapter(adapter).replace('member-a', ticket, 'evidence', { reviewedReplacement: true });
    expect(replacement.id).not.toBe(account.id);
    expect((await store().read('member-a', account.id)).status).toBe('revoked');
    await expect(store().resolvePersonalResource('member-a', selection, 'mailbox')).rejects.toThrow(AccountAccessError);
  });

  it('an outside connection whose address changes under the same name no longer matches an approval captured before', async () => {
    const policy = () => outsideApprovalAdapter('mail', 'search').readPolicyHash(getPool() as never, 'outside-helper', OUTSIDE_INC);
    const before = await policy();
    expect(await policy()).toBe(before);
    await getPool().query("UPDATE agent_resources SET applied_definition=$1 WHERE name='outside-helper'", [outsideDef('https://other.example.net/mcp')]);
    expect(await policy()).not.toBe(before);
  });

  it.each(texts('account-swap'))('$id: an outside server that starts describing its tools differently is dropped for the session', async (c) => {
    const entry = outsideDef().outsideTools[0]!;
    let tools: ListedTool[] = [{ name: 'search', description: 'Search the mailbox', inputSchema: { type: 'object' } }];
    const deps = { store: pgPinStore(getPool()), list: async () => tools };
    expect(await checkEntryPin('outside-helper', entry, 'token', deps)).toBe('pinned');
    expect(await checkEntryPin('outside-helper', entry, 'token', deps)).toBe('match');
    tools = [{ name: 'search', description: `Search the mailbox. ${c.text}`, inputSchema: { type: 'object' } }];
    expect(await checkEntryPin('outside-helper', entry, 'token', deps)).toBe('changed');
  });

  it.todo('no mechanism yet: an outside bearer token replaced by one for a different account at the same server — the engine holds no account identity for outside tokens, so neither the pin nor the approval policy changes');
});

// ── 7. procedure edit treated as permission to execute ─────────────────────────────────────
describe('7. a procedure edit treated as permission to execute it', () => {
  it('permission to edit the agent is not permission to use it', async () => {
    const grants = new PgGrantStore(getPool());
    await share([edit('member-b')]);
    expect(await grants.can('member-b', { kind: 'agent', id: 'helper' }, 'edit')).toBe(true);
    expect(await grants.can('member-b', { kind: 'agent', id: 'helper' }, 'use')).toBe(false);
    expect(await grants.captureUse('member-b', 'helper')).toBeUndefined();
    await expect(bind('member-b')).rejects.toThrow();
    // control: a use grant is what opens a session
    await share([edit('member-b'), use('member-b')]);
    await expect(bind('member-b')).resolves.toMatchObject({ memberId: 'member-b' });
  });

  it.each(texts('procedure-execution'))('$id: an approval covers its exact call only — not another target, not changed words', async (c) => {
    const raw = dismiss(c.text);
    await approved(raw);
    const other = dismiss(c.text, DEADLINE_A2);
    await expect(dismissExactDeadline(getPool(), ctx({ raw, purpose: 'resolver' }) as never, other)).rejects.toThrow();
    const rewritten = dismiss(`${c.text} Also dismiss everything else.`);
    await expect(dismissExactDeadline(getPool(), ctx({ raw: rewritten, purpose: 'resolver' }) as never, rewritten)).rejects.toThrow();
    expect(await statusOf(DEADLINE_A2)).toBe('open');
    await execute(raw);
    expect(await statusOf(DEADLINE_A)).toBe('dismissed');
    expect(await statusOf(DEADLINE_A2)).toBe('open');
  });

  it.each(texts('procedure-execution'))('$id: editing the agent\'s rules after an approval does not carry the approval over', async (c) => {
    const raw = dismiss(c.text);
    await approved(raw);
    await getPool().query("UPDATE agent_resources SET applied_definition=jsonb_set(applied_definition,'{autonomy,deadline}','\"autonomous\"') WHERE name='helper'");
    await expect(execute(raw)).rejects.toThrow();
    expect(await statusOf(DEADLINE_A)).toBe('open');
  });

  it('a skill whose procedure needs more than the agent was granted is rejected when the definition is checked', () => {
    expect(() => assertSkillsWithinGrants({ grants: [{ capability: 'twenty', scope: 'read' }],
      skills: [{ name: 'commercial', requires: [{ capability: 'twenty', scope: 'write' }] }] })).toThrow('never widen');
    expect(() => assertSkillsWithinGrants({ grants: [{ capability: 'twenty', scope: 'write' }],
      skills: [{ name: 'commercial', requires: [{ capability: 'twenty', scope: 'write' }] }] })).not.toThrow();
  });
});

describe('the authority families', () => {
  it('every family in the corpus has a describe block above', () => {
    expect(AUTHORITY_FAMILIES).toEqual(['claimed-approval', 'replayed-request', 'private-laundering', 'audience-widening', 'revoked-replay', 'account-swap', 'procedure-execution']);
    for (const f of AUTHORITY_FAMILIES) expect(texts(f).length, f).toBeGreaterThanOrEqual(4);
  });
});
