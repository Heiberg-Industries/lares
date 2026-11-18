// The door half of exact approval, over every door in the door table, against real Postgres: reserve before the card,
// attach the card, take the answer only from the claimed owner, and refuse an approval that cannot be acted on.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApprovalRefusal, type ExactApprovalAdapter } from '../src/approval-execution.js';
import { payloadFingerprint, APPROVAL_TTL_MS } from '../src/approval-ledger.js';
import {
  DoorApprovalFailure, approveDoorExactResponse, attachDoorExactApproval, isDoorReservationCall, requireDoorApprovedExecution,
  requireDoorApprovedRecheck, reserveDoorExactApproval, reserveDoorExactApprovalOrDeny, type DoorExactDeps,
} from '../src/door-exact-approval.js';
import { DOORS, claimEnvNames } from '../src/door-kinds.js';
import {
  DOOR_NOTE_APPROVAL_EXPIRED, DOOR_NOTE_CARD_SHORTENED, DOOR_NOTE_CARD_UNCONFIRMED, DOOR_NOTE_SAVE_FAILED, DOOR_NOTE_SAVE_NOT_POSSIBLE,
  DOOR_NOTE_TITLE_TAKEN, DOOR_NOTE_TOOL_UNAVAILABLE, DOOR_NOTE_UNREACHABLE, DOOR_VAULT_SENTENCES,
} from '../src/door-vault-sentences.js';
import { exactCardForRequest } from '../src/exact-approval-request.js';
import { makeApprovalRecord } from '../src/approval-record-hook.js';
import { askForCall } from '../src/approval-ledger.js';
import { closePool } from '../src/db.js';
import { eveSession } from './helpers/eve-session.js';
import { VaultBrokerError } from '../src/vault-broker-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const SQL = join(here, '..', '..', '..', 'services', 'box', 'sql');
const INCARNATION = '11111111-1111-4111-8111-111111111111';
const REVISION = '5c1ac4e0-0000-4000-8000-000000000001';
const SENDER = 'U0CLAIMED';
const MEMBER = 'member-owner';
const TOOL = 'agent-kit__vault_write';
const INPUT = { area: 'private', title: 'Oslo trip', body: 'Flights on Friday' };
const HASH = 'a'.repeat(64);

const PRIVATE: Record<string, Record<string, unknown>> = {
  slack: { channel_id: 'D0DIRECT', author_type: 'user' },
  telegram: { chat_type: 'private' },
};
const ROOM: Record<string, Record<string, unknown>> = {
  slack: { channel_id: 'C0ROOM', author_type: 'user' },
  telegram: { chat_type: 'group' },
};
const authenticatorOf = (door: string) => Object.entries(DOORS).find(([, row]) => row.door === door)![0];
const person = (door: string, user = SENDER, where: Record<string, Record<string, unknown>> = PRIVATE) =>
  ({ authenticator: authenticatorOf(door), principalType: 'user', attributes: { user_id: user, ...where[door]! } });
const kinds = [...new Set(Object.values(DOORS).map((row) => row.door))];

let container: StartedPostgreSqlContainer;
let db: Pool;
beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  db.on('error', () => undefined);
  db.on('connect', (client) => client.on('error', () => undefined));
  // Every box migration in order, the way the image proof applies them.
  for (const file of readdirSync(SQL).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort()) await db.query(readFileSync(join(SQL, file), 'utf8'));
  process.env['DATABASE_URL'] = container.getConnectionUri();
  await db.query(`INSERT INTO orgs(id,display_name) VALUES('fixture-org','Fixture');
    INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('member-owner','A','fixture-org','owner','active'),('member-someone-else','B','fixture-org','member','active')`);
}, 120_000);
afterAll(async () => { await closePool(); delete process.env['DATABASE_URL']; await db.end(); await container.stop(); });
beforeEach(async () => {
  await db.query('TRUNCATE approval_asks CASCADE');
  vi.stubEnv('LARES_AGENT_NAME', 'helper'); vi.stubEnv('LARES_AGENT_INCARNATION', INCARNATION);
  for (const door of kinds) { vi.stubEnv(claimEnvNames(door).principal, SENDER); vi.stubEnv(claimEnvNames(door).revision, REVISION); }
});
afterEach(() => { vi.unstubAllEnvs(); });

const PASS = { memberId: MEMBER, route: { door: 'slack', principal: SENDER, claimRevision: REVISION }, point: { sessionId: 'session_1', turnId: 'turn_0', sequence: 0, incarnation: INCARNATION },
  capability: 'c'.repeat(43) };
const adapter: ExactApprovalAdapter = {
  toolNames: [TOOL],
  async readTarget(_db, _input, memberId) { return { kind: 'vault-note', id: '_inbox/oslo-trip.md', ownerMemberId: memberId, fingerprint: HASH, approvedOrigin: 'agent' }; },
  async readPolicyHash() { return HASH; },
};
const deps = (over: Partial<DoorExactDeps> = {}): DoorExactDeps =>
  ({ adapter, pass: async () => PASS, isOwner: (_authenticator, userId) => userId === SENDER, db, ...over });
const request = (door: string, over: { current?: unknown; initiator?: unknown; input?: unknown; callId?: string } = {}) => {
  const me = person(door);
  return { callId: over.callId ?? 'call-1', toolInput: over.input ?? INPUT,
    session: { id: 'session_1', turn: { id: 'turn_0', sequence: 0 }, auth: { current: 'current' in over ? over.current : me, initiator: 'initiator' in over ? over.initiator : me } } };
};
const answer = (door: string, over: { decision?: 'approve' | 'deny'; principal?: unknown; requestId?: string; initiator?: unknown } = {}) => ({
  request: { interactionId: over.requestId ?? 'request-1', callId: 'call-1', toolName: TOOL, toolInput: INPUT },
  response: { decision: over.decision ?? 'approve', principal: 'principal' in over ? over.principal : person(door) },
  session: { id: 'session_1', initiator: over.initiator ?? person(door), turn: { id: 'turn_0' } },
});
const execCtx = (door: string, responder: unknown = person(door), over: { current?: unknown; initiator?: unknown; callId?: string } = {}) =>
  ({ ...request(door, over), approval: { responder } });
const row = async () => (await db.query("SELECT * FROM approval_asks WHERE call_id='call-1'")).rows[0];
const reserved = async (door: string) => { await reserveDoorExactApproval(request(door), TOOL, deps()); await attachDoorExactApproval({ requestId: 'request-1', callId: 'call-1', tool: TOOL, input: INPUT }, db); };
const approved = async (door: string, shown: boolean | null = true) => {
  await reserved(door);
  await db.query('UPDATE approval_asks SET door=$1, shown_whole=$2 WHERE call_id=$3', [door, shown, 'call-1']);
  expect(await approveDoorExactResponse(answer(door), deps())).toEqual({ status: 'allowed' });
};
const failure = async (run: () => Promise<unknown>): Promise<string> => {
  try { await run(); } catch (error) { return (error as Error).message; }
  return 'DID NOT THROW';
};

it('has a stand-in fixture for every door in the table, so a new door cannot skip these checks', () => {
  expect(kinds.sort()).toEqual(Object.keys(PRIVATE).sort());
  expect(kinds.sort()).toEqual(Object.keys(ROOM).sort());
});

for (const door of kinds) {
  describe(`${door}: reserving before the card`, () => {
    it('writes a door reservation for the member Keeper named, with no card id yet, and a retry finds the same one', async () => {
      await reserveDoorExactApproval(request(door), TOOL, deps());
      const first = await row();
      expect(first.request_id).toBeNull();
      expect(first.acting_member_id).toBe(MEMBER);
      expect(first.original_authority).toMatchObject({ version: 2, kind: 'door', door: { door, principal: SENDER, claimRevision: REVISION },
        original: { origin: 'human', actingMemberId: MEMBER, spokenByMemberId: MEMBER, sessionId: 'session_1', placeId: `door:${door}:helper:${INCARNATION}:session_1` } });
      await reserveDoorExactApproval(request(door), TOOL, deps({ now: new Date(Date.now() + 60_000) }));
      expect((await row()).original_authority).toEqual(first.original_authority);
      expect(await isDoorReservationCall('call-1', { db })).toBe(true);
      expect(await isDoorReservationCall('call-unknown', { db })).toBe(false);
    });

    it('is not an exact card for the console route, which refuses a door row', async () => {
      await reserved(door);
      await expect(exactCardForRequest(db, { requestId: 'request-1', agent: 'helper', incarnation: INCARNATION, sessionId: 'session_1', memberId: MEMBER,
        admissionNonce: 'a'.repeat(43) })).rejects.toThrow();
    });

    it('refuses a changed call under the same call id', async () => {
      await reserveDoorExactApproval(request(door), TOOL, deps());
      expect(await failure(() => reserveDoorExactApproval(request(door, { input: { ...INPUT, body: 'Other' } }), TOOL, deps()))).toBe(DOOR_NOTE_SAVE_NOT_POSSIBLE);
    });

    it('refuses before any card, in one closed sentence, when there is no route, no pass or no way to read the note', async () => {
      const stranger = person(door, 'U0STRANGER');
      expect(await failure(() => reserveDoorExactApproval(request(door, { current: stranger }), TOOL, deps()))).toBe(DOOR_NOTE_SAVE_NOT_POSSIBLE);
      expect(await failure(() => reserveDoorExactApproval(request(door, { current: person(door, SENDER, ROOM), initiator: person(door, SENDER, ROOM) }), TOOL, deps()))).toBe(DOOR_NOTE_SAVE_NOT_POSSIBLE);
      expect(await failure(() => reserveDoorExactApproval(request(door, { current: null, initiator: null }), TOOL, deps()))).toBe(DOOR_NOTE_SAVE_NOT_POSSIBLE);
      const refused = new Error('open', { cause: new VaultBrokerError('Vault reader unavailable (the keeper refused: grant)', 'refused', 'grant') });
      expect(await failure(() => reserveDoorExactApproval(request(door), TOOL, deps({ pass: async () => { throw refused; } })))).toBe(DOOR_NOTE_SAVE_NOT_POSSIBLE);
      const down = new Error('open', { cause: new VaultBrokerError('Vault reader unavailable (the connection to the keeper failed)', 'connection') });
      expect(await failure(() => reserveDoorExactApproval(request(door), TOOL, deps({ pass: async () => { throw down; } })))).toBe(DOOR_NOTE_UNREACHABLE);
      const busy = new VaultBrokerError('Vault reader unavailable (the keeper refused: capacity)', 'refused', 'capacity');
      expect(await failure(() => reserveDoorExactApproval(request(door), TOOL, deps({ adapter: { ...adapter, readTarget: async () => { throw busy; } } })))).toBe(DOOR_NOTE_UNREACHABLE);
      expect(await failure(() => reserveDoorExactApproval(request(door), TOOL, deps({ adapter: { ...adapter, readTarget: async () => { throw new Error('/srv/secret/path: EACCES'); } } })))).toBe(DOOR_NOTE_UNREACHABLE);
      expect(await failure(() => reserveDoorExactApproval(request(door), TOOL, deps({ adapter: { ...adapter, readPolicyHash: async () => { throw new Error('no grant'); } } })))).toBe(DOOR_NOTE_SAVE_NOT_POSSIBLE);
      expect((await db.query('SELECT count(*)::int AS n FROM approval_asks')).rows[0].n).toBe(0);
    });

    it('says a title that is taken, in the words web chat uses, and reserves nothing', async () => {
      const taken = deps({ adapter: { ...adapter, readTarget: async () => { throw new ApprovalRefusal(DOOR_NOTE_TITLE_TAKEN); } } });
      expect(await reserveDoorExactApprovalOrDeny(request(door), TOOL, taken)).toEqual({ type: 'denied', reason: DOOR_NOTE_TITLE_TAKEN });
      expect((await db.query('SELECT count(*)::int AS n FROM approval_asks')).rows[0].n).toBe(0);
      expect(await reserveDoorExactApprovalOrDeny(request(door), TOOL, deps())).toBeNull();
    });
  });

  describe(`${door}: attaching the card`, () => {
    it('gives the reservation its card id once, and says no for a call that has no reservation', async () => {
      await reserveDoorExactApproval(request(door), TOOL, deps());
      expect(await attachDoorExactApproval({ requestId: 'request-1', callId: 'call-1', tool: TOOL, input: INPUT }, db)).toBe(true);
      expect((await row()).request_id).toBe('request-1');
      expect(await attachDoorExactApproval({ requestId: 'request-1', callId: 'call-1', tool: TOOL, input: INPUT }, db)).toBe(true);
      await expect(attachDoorExactApproval({ requestId: 'request-2', callId: 'call-1', tool: TOOL, input: INPUT }, db)).rejects.toThrow();
      await expect(attachDoorExactApproval({ requestId: 'request-1', callId: 'call-1', tool: TOOL, input: { ...INPUT, body: 'x' } }, db)).rejects.toThrow();
      expect(await attachDoorExactApproval({ requestId: 'request-9', callId: 'call-none', tool: TOOL, input: INPUT }, db)).toBe(false);
    });
  });

  describe(`${door}: the answer`, () => {
    const other = kinds.find((kind) => kind !== door);
    beforeEach(async () => { await reserved(door); });

    it('takes an Approve only from the claimed owner on this door, and writes who, how and when', async () => {
      expect(await approveDoorExactResponse(answer(door), deps())).toEqual({ status: 'allowed' });
      const r = await row();
      expect(r).toMatchObject({ outcome: 'approved', answered_via: door, resolved_by_member_id: MEMBER });
      expect(r.answered_at).not.toBeNull();
      // The same answer again is the same answer.
      expect(await approveDoorExactResponse(answer(door), deps())).toEqual({ status: 'allowed' });
    });

    it('refuses a tap by another person, a person who is not the owner, and a card id that is not this one, and records nothing', async () => {
      expect(await approveDoorExactResponse(answer(door, { principal: person(door, 'U0STRANGER') }), deps())).toMatchObject({ status: 'rejected' });
      expect(await approveDoorExactResponse(answer(door), deps({ isOwner: () => false }))).toMatchObject({ status: 'rejected' });
      expect(await approveDoorExactResponse(answer(door, { requestId: 'request-other' }), deps())).toMatchObject({ status: 'rejected' });
      expect(await approveDoorExactResponse(answer(door, { principal: undefined }), deps())).toMatchObject({ status: 'rejected' });
      expect(await approveDoorExactResponse(answer(door, { principal: { authenticator: 'lares-console', attributes: { user_id: SENDER } } }), deps())).toMatchObject({ status: 'rejected' });
      expect(await approveDoorExactResponse(answer(door, { decision: 'maybe' as never }), deps())).toMatchObject({ status: 'rejected' });
      expect(await approveDoorExactResponse(answer(door, { principal: person(door, 'U0STRANGER'), decision: 'deny' }), deps())).toMatchObject({ status: 'rejected' });
      expect((await row()).outcome).toBeNull();
    });

    if (other) {
      it('refuses the owner tapping on another door', async () => {
        expect(await approveDoorExactResponse(answer(door, { principal: person(other) }), deps())).toMatchObject({ status: 'rejected' });
        expect((await row()).outcome).toBeNull();
      });
    }

    it('refuses once the claim has changed or the reservation has run out', async () => {
      vi.stubEnv(claimEnvNames(door).revision, '6d1c0000-0000-4000-8000-000000000002');
      expect(await approveDoorExactResponse(answer(door), deps())).toMatchObject({ status: 'rejected' });
      vi.stubEnv(claimEnvNames(door).revision, REVISION);
      expect(await approveDoorExactResponse(answer(door), deps({ now: new Date(Date.now() + APPROVAL_TTL_MS + 1000) }))).toMatchObject({ status: 'rejected' });
      expect((await row()).outcome).toBeNull();
    });

    it('lets the owner deny and writes nothing (the settle step records the Deny)', async () => {
      expect(await approveDoorExactResponse(answer(door, { decision: 'deny' }), deps())).toEqual({ status: 'allowed' });
      expect((await row()).outcome).toBeNull();
    });

    it('does not turn a settled card into an approval', async () => {
      await db.query("UPDATE approval_asks SET outcome='cancelled', answered_at=now() WHERE call_id='call-1'");
      expect(await approveDoorExactResponse(answer(door), deps())).toMatchObject({ status: 'rejected' });
      expect((await row()).outcome).toBe('cancelled');
    });
  });

  describe(`${door}: after the person approved`, () => {
    it('hands over what Keeper needs, for the exact call, once approved, unexpired, unused and shown in full', async () => {
      await approved(door);
      await requireDoorApprovedRecheck(request(door), TOOL, INPUT, deps());
      const done = await requireDoorApprovedExecution(execCtx(door), TOOL, INPUT, deps());
      expect(done).toMatchObject({ toolName: TOOL, callId: 'call-1', door: { door, principal: SENDER, claimRevision: REVISION }, sessionId: 'session_1',
        payloadHash: payloadFingerprint(TOOL, INPUT), authority: { origin: 'approval-resume', actingMemberId: MEMBER, resolvedByMemberId: MEMBER, requestId: 'request-1', spokenByMemberId: MEMBER } });
      expect(done.target).toMatchObject({ kind: 'vault-note', ownerMemberId: MEMBER });
    });

    it('also works when eve resumes the call with no current identity (the conversation\'s starter is the person)', async () => {
      await approved(door);
      await requireDoorApprovedRecheck(request(door, { current: null }), TOOL, INPUT, deps());
      expect(await requireDoorApprovedExecution(execCtx(door, person(door), { current: null }), TOOL, INPUT, deps())).toMatchObject({ callId: 'call-1' });
    });

    it('refuses a card that was cut, or whose record cannot say it was whole, with the true sentence for each', async () => {
      await approved(door, false);
      expect(await failure(() => requireDoorApprovedRecheck(request(door), TOOL, INPUT, deps()))).toBe(DOOR_NOTE_CARD_SHORTENED);
      expect(await failure(() => requireDoorApprovedExecution(execCtx(door), TOOL, INPUT, deps()))).toBe(DOOR_NOTE_CARD_SHORTENED);
      await db.query("UPDATE approval_asks SET shown_whole=NULL, card_address=NULL WHERE call_id='call-1'");
      expect(await failure(() => requireDoorApprovedExecution(execCtx(door), TOOL, INPUT, deps()))).toBe(DOOR_NOTE_CARD_UNCONFIRMED);
      expect(DOOR_NOTE_CARD_UNCONFIRMED).not.toMatch(/short|cut/);
    });

    it('refuses a replay and an expired approval with the expiry sentence', async () => {
      await approved(door);
      expect(await failure(() => requireDoorApprovedExecution(execCtx(door), TOOL, INPUT, deps({ now: new Date(Date.now() + APPROVAL_TTL_MS + 1000) })))).toBe(DOOR_NOTE_APPROVAL_EXPIRED);
      await db.query("UPDATE approval_asks SET used_at=now(), use_count=1 WHERE call_id='call-1'");
      expect(await failure(() => requireDoorApprovedExecution(execCtx(door), TOOL, INPUT, deps()))).toBe(DOOR_NOTE_APPROVAL_EXPIRED);
    });

    it('refuses when the policy has changed since the card, without naming why', async () => {
      await approved(door);
      expect(await failure(() => requireDoorApprovedExecution(execCtx(door), TOOL, INPUT, deps({ adapter: { ...adapter, readPolicyHash: async () => 'b'.repeat(64) } })))).toBe(DOOR_NOTE_SAVE_FAILED);
    });

    it('refuses, neutrally, anything that is not the approved exact call by the claimed owner', async () => {
      const other = kinds.find((kind) => kind !== door);
      await approved(door);
      const neutral = async (run: () => Promise<unknown>) => expect(await failure(run)).toBe(DOOR_NOTE_TOOL_UNAVAILABLE);
      await neutral(() => requireDoorApprovedExecution(execCtx(door), TOOL, { ...INPUT, body: 'Changed' }, deps()));
      await neutral(() => requireDoorApprovedExecution(execCtx(door, person(door, 'U0STRANGER')), TOOL, INPUT, deps()));
      if (other) await neutral(() => requireDoorApprovedExecution(execCtx(door, person(other)), TOOL, INPUT, deps()));
      await neutral(() => requireDoorApprovedExecution(execCtx(door), TOOL, INPUT, deps({ isOwner: () => false })));
      await neutral(() => requireDoorApprovedExecution(execCtx(door, person(door), { current: person(door, 'U0STRANGER') }), TOOL, INPUT, deps()));
      await neutral(() => requireDoorApprovedExecution(execCtx(door, person(door), { current: person(door, SENDER, ROOM), initiator: person(door, SENDER, ROOM) }), TOOL, INPUT, deps()));
      await neutral(() => requireDoorApprovedExecution({ ...execCtx(door), session: { ...execCtx(door).session, id: 'session_2' } }, TOOL, INPUT, deps()));
      await neutral(() => requireDoorApprovedExecution(execCtx(door, person(door), { callId: 'call-none' }), TOOL, INPUT, deps()));
      vi.stubEnv(claimEnvNames(door).revision, '6d1c0000-0000-4000-8000-000000000002');
      await neutral(() => requireDoorApprovedExecution(execCtx(door), TOOL, INPUT, deps()));
    });

    it('refuses a card that was never approved, or approved by someone else, neutrally (nothing claims an approval)', async () => {
      await reserved(door);
      await db.query('UPDATE approval_asks SET shown_whole=true WHERE call_id=$1', ['call-1']);
      expect(await failure(() => requireDoorApprovedExecution(execCtx(door), TOOL, INPUT, deps()))).toBe(DOOR_NOTE_TOOL_UNAVAILABLE);
      expect(await failure(() => requireDoorApprovedRecheck(request(door), TOOL, INPUT, deps()))).toBe(DOOR_NOTE_TOOL_UNAVAILABLE);
      await db.query("UPDATE approval_asks SET outcome='approved', answered_at=now(), answered_via=$1, resolved_by_member_id='member-someone-else' WHERE call_id='call-1'", [door]);
      expect(await failure(() => requireDoorApprovedExecution(execCtx(door), TOOL, INPUT, deps()))).toBe(DOOR_NOTE_TOOL_UNAVAILABLE);
    });
  });
}

describe('every sentence a person can read from this path is on the closed list', () => {
  it('lists each, and none repeats Keeper or database text', () => {
    for (const sentence of [DOOR_NOTE_UNREACHABLE, DOOR_NOTE_SAVE_NOT_POSSIBLE, DOOR_NOTE_TITLE_TAKEN, DOOR_NOTE_SAVE_FAILED, DOOR_NOTE_APPROVAL_EXPIRED,
      DOOR_NOTE_CARD_SHORTENED, DOOR_NOTE_CARD_UNCONFIRMED, DOOR_NOTE_TOOL_UNAVAILABLE]) expect(DOOR_VAULT_SENTENCES.has(sentence)).toBe(true);
    // After an approved card every refusal starts "You approved" and says nothing was saved or changed.
    for (const sentence of [DOOR_NOTE_SAVE_FAILED, DOOR_NOTE_APPROVAL_EXPIRED, DOOR_NOTE_CARD_SHORTENED, DOOR_NOTE_CARD_UNCONFIRMED]) {
      expect(sentence.startsWith('You approved')).toBe(true);
      expect(sentence).toMatch(/not saved|nothing was saved|Nothing was changed/);
    }
    for (const sentence of [DOOR_NOTE_UNREACHABLE, DOOR_NOTE_SAVE_NOT_POSSIBLE]) expect(sentence).toMatch(/did not ask you to approve anything/);
    expect(new DoorApprovalFailure(DOOR_NOTE_SAVE_FAILED).message).toBe(DOOR_NOTE_SAVE_FAILED);
  });
});

for (const door of kinds) {
  describe(`${door}: the record hook`, () => {
    const hookCtx = (s: ReturnType<typeof eveSession>) => ({ agent: { name: 'helper' }, session: { id: 'session_1', auth: { initiator: person(door), current: person(door) } }, view: s.view });

    it('gives the reservation its card id, the door and the person it was put to, and leaves the Approve to the answer check', async () => {
      await reserveDoorExactApproval(request(door), TOOL, deps());
      const hook = makeApprovalRecord(), s = eveSession();
      s.call('call-1', TOOL, INPUT);
      await hook['interaction.opened'](s.open('request-1', 'call-1'), hookCtx(s));
      expect(await row()).toMatchObject({ request_id: 'request-1', door, put_to: SENDER, outcome: null });
      expect(await approveDoorExactResponse(answer(door), deps())).toEqual({ status: 'allowed' });
      // The settle step does not turn an Approve into anything else.
      await hook['interaction.settled'](s.settle('request-1', 'accepted', 'approve'), hookCtx(s));
      expect(await row()).toMatchObject({ outcome: 'approved', answered_via: door });
    });

    it('records a Deny as cancelled and a card nobody answered as ignored, on the reservation', async () => {
      await reserveDoorExactApproval(request(door), TOOL, deps());
      const hook = makeApprovalRecord(), s = eveSession();
      s.call('call-1', TOOL, INPUT);
      await hook['interaction.opened'](s.open('request-1', 'call-1'), hookCtx(s));
      await hook['interaction.settled'](s.settle('request-1', 'declined', 'deny'), hookCtx(s));
      expect((await row()).outcome).toBe('cancelled');
      await db.query('TRUNCATE approval_asks CASCADE');
      await reserveDoorExactApproval(request(door), TOOL, deps());
      await hook['interaction.opened'](s.open('request-1', 'call-1'), hookCtx(s));
      await hook['interaction.settled'](s.settle('request-1', 'abandoned'), hookCtx(s));
      expect((await row()).outcome).toBe('ignored');
    });

    it('still records any other card the way it always did, with no reservation involved', async () => {
      const hook = makeApprovalRecord(), s = eveSession();
      s.call('call-other', 'gmail_send', { to: ['a@x.example'] });
      await hook['interaction.opened'](s.open('request-other', 'call-other'), hookCtx(s));
      const recorded = await askForCall(db, 'call-other');
      expect(recorded).toMatchObject({ requestId: 'request-other', tool: 'gmail_send', outcome: null });
      expect(recorded?.originalAuthority).toBeNull();
      await hook['interaction.settled'](s.settle('request-other', 'accepted', 'approve'), hookCtx(s));
      expect((await askForCall(db, 'call-other'))?.outcome).toBe('approved');
    });

    it('fails loudly when a card for a reserved call does not match it, rather than leave a card nobody can approve', async () => {
      await reserveDoorExactApproval(request(door), TOOL, deps());
      const hook = makeApprovalRecord(), s = eveSession();
      s.call('call-1', TOOL, { ...INPUT, body: 'A different note' });
      await expect(hook['interaction.opened'](s.open('request-1', 'call-1'), hookCtx(s))).rejects.toThrow();
    });
  });
}
