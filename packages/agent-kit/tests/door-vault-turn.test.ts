import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOORS, claimEnvNames, isKnownDoor } from '../src/door-kinds.js';
import { doorVaultPoint, doorVaultRead, doorVaultRoute, onManagedDoor, openDoorVaultTurn } from '../src/door-vault-turn.js';
import { DOOR_VAULT_SENTENCES, DOOR_NOTE_READ_FAILED } from '../src/door-vault-sentences.js';
import { doorVaultReadOffered, managedDoorToolHidden, privateOnlyTool } from '../src/private-console-surface.js';
import { PRIVATE_CHAT_AUTHENTICATORS } from '../src/shared-room.js';
import { isValidDoorClaim } from '../src/door-claim.js';

const broker = vi.hoisted(() => ({ calls: [] as Array<{ op: string; input: Record<string, unknown> }>, answer: undefined as undefined | ((op: string) => unknown) }));
vi.mock('../src/vault-broker-client.js', () => ({
  vaultBrokerRequest: async (op: string, input: Record<string, unknown>) => {
    broker.calls.push({ op, input });
    const answer = broker.answer?.(op);
    if (answer instanceof Error) throw answer;
    return answer ?? { ok: true };
  },
}));

const INCARNATION = '11111111-1111-4111-8111-111111111111';
const REVISION = '5c1ac4e0-0000-4000-8000-000000000001';
const SENDER = 'U0CLAIMED';

// How each door's verified sender looks in a private chat and in a shared room. A new door adds a row to the
// door table, so this test fails until it adds its two identities here too (that is the point).
const IDENTITIES: Record<string, { privateChat: Record<string, unknown>; room: Record<string, unknown> }> = {
  slack: {
    privateChat: { channel_id: 'D0DIRECT', author_type: 'user' },
    room: { channel_id: 'C0ROOM', author_type: 'user' },
  },
  telegram: {
    privateChat: { chat_type: 'private' },
    room: { chat_type: 'group' },
  },
};
const authenticatorOf = (door: string) => Object.entries(DOORS).find(([, row]) => row.door === door)![0];
const identity = (door: string, where: 'privateChat' | 'room', user = SENDER) =>
  ({ authenticator: authenticatorOf(door), principalType: 'user', attributes: { user_id: user, ...IDENTITIES[door]![where] } });
const ctxOf = (current: unknown, initiator: unknown = current, turn: { id?: string; sequence?: number } = { id: 'turn_0', sequence: 0 }) =>
  ({ session: { id: 'session_1', turn, auth: { current, initiator } } });
const kinds = [...new Set(Object.values(DOORS).map(row => row.door))];

beforeEach(() => {
  broker.calls = []; broker.answer = undefined;
  vi.stubEnv('LARES_AGENT_NAME', 'helper'); vi.stubEnv('LARES_AGENT_INCARNATION', INCARNATION);
  for (const door of kinds) {
    const names = claimEnvNames(door);
    vi.stubEnv(names.principal, SENDER); vi.stubEnv(names.revision, REVISION);
  }
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('the door table', () => {
  it('has an identity fixture here for every door, so a new door cannot skip these checks', () => {
    expect(kinds.sort()).toEqual(Object.keys(IDENTITIES).sort());
    for (const door of kinds) expect(isKnownDoor(door)).toBe(true);
    expect(isKnownDoor('carrier-pigeon')).toBe(false);
    expect(isKnownDoor(undefined)).toBe(false);
  });
  it('validates a claim by the table, not by a name', () => {
    for (const door of kinds) expect(isValidDoorClaim({ door, principal: SENDER, claimRevision: REVISION })).toBe(true);
    expect(isValidDoorClaim({ door: 'carrier-pigeon', principal: SENDER, claimRevision: REVISION })).toBe(false);
    expect(isValidDoorClaim({ door: kinds[0], principal: 'bad principal', claimRevision: REVISION })).toBe(false);
    expect(isValidDoorClaim({ door: kinds[0], principal: SENDER, claimRevision: 'not-a-revision' })).toBe(false);
  });
});

describe('the route, over every door in the table', () => {
  for (const door of kinds) {
    describe(door, () => {
      it('is open for the claimed person in a private chat that they started', () => {
        const me = identity(door, 'privateChat');
        expect(doorVaultRoute(ctxOf(me))).toEqual({ door, principal: SENDER, claimRevision: REVISION });
        expect(onManagedDoor(ctxOf(me))).toBe(true);
        expect(managedDoorToolHidden(ctxOf(me), 'agent-kit__vault_backlinks')).toBe(true);
        expect(doorVaultReadOffered(ctxOf(me), 'chief-of-staff', 'agent-kit__vault_list')).toBe(true);
        expect(doorVaultReadOffered(ctxOf(me), 'creative', 'agent-kit__vault_list')).toBe(false);
      });
      it('is closed in a shared room, started there or now', () => {
        const me = identity(door, 'privateChat'), room = identity(door, 'room');
        expect(doorVaultRoute(ctxOf(room))).toBeUndefined();
        expect(doorVaultRoute(ctxOf(me, room))).toBeUndefined();
        expect(doorVaultRoute(ctxOf(room, me))).toBeUndefined();
        expect(onManagedDoor(ctxOf(room))).toBe(true);
      });
      it('is closed for anyone but the claimed person, and when the conversation began with someone else or a schedule', () => {
        const me = identity(door, 'privateChat'), other = identity(door, 'privateChat', 'U0STRANGER');
        expect(doorVaultRoute(ctxOf(other))).toBeUndefined();
        expect(doorVaultRoute(ctxOf(me, other))).toBeUndefined();
        expect(doorVaultRoute(ctxOf(me, { authenticator: 'app', principalType: 'runtime', attributes: {} }))).toBeUndefined();
        expect(doorVaultRoute(ctxOf(me, null))).toBeUndefined();
      });
      it('is closed when the runtime is not one Keeper manages, or its claim is not applied', () => {
        const me = identity(door, 'privateChat');
        vi.stubEnv('LARES_AGENT_NAME', ''); vi.stubEnv('LARES_AGENT_INCARNATION', '');
        expect(doorVaultRoute(ctxOf(me))).toBeUndefined();
        expect(onManagedDoor(ctxOf(me))).toBe(false);
        expect(managedDoorToolHidden(ctxOf(me), 'agent-kit__vault_backlinks')).toBe(false);
        vi.stubEnv('LARES_AGENT_NAME', 'helper'); vi.stubEnv('LARES_AGENT_INCARNATION', INCARNATION);
        vi.stubEnv(claimEnvNames(door).revision, '');
        expect(doorVaultRoute(ctxOf(me))).toBeUndefined();
      });
      it('asks Keeper for a pass that names the door and the claim and never a member', async () => {
        const route = doorVaultRoute(ctxOf(identity(door, 'privateChat')))!, point = doorVaultPoint(ctxOf(identity(door, 'privateChat')))!;
        broker.answer = () => ({ turnCapability: 'c'.repeat(43), expiresAt: Date.now() + 60_000 });
        const opened = await openDoorVaultTurn(route, point, { definition: {}, dutiesMd: '', voiceMd: '', hash: 'h' });
        expect(opened.capability).toBe('c'.repeat(43));
        expect(broker.calls[0]!.op).toBe('door.turn.open');
        expect(Object.keys(broker.calls[0]!.input).sort()).toEqual(['chat', 'claimRevision', 'definition', 'door', 'principal', 'sequence', 'sessionId', 'turnId']);
        expect(broker.calls[0]!.input).toMatchObject({ door, principal: SENDER, claimRevision: REVISION, chat: 'private', sessionId: 'session_1', turnId: 'turn_0', sequence: 0 });
        await doorVaultRead(route, point, opened.capability, 'list', { area: 'private', folder: 'people', cursor: 3 });
        expect(broker.calls[1]).toEqual({ op: 'vault.read', input: { turnCapability: opened.capability, turnId: 'turn_0', sequence: 0, sessionId: 'session_1', door, principal: SENDER,
          claimRevision: REVISION, area: 'private', operation: 'list', folder: 'people', cursor: 3 } });
      });
    });
  }
  it('is closed for a door that is not in the table', () => {
    const stranger = { authenticator: 'carrier-pigeon-webhook', principalType: 'user', attributes: { user_id: SENDER, chat_type: 'private', channel_id: 'D0DIRECT', author_type: 'user' } };
    expect(doorVaultRoute(ctxOf(stranger))).toBeUndefined();
    // No note route, but still a door: the agent's own files hold no private notes there, so its refusals apply.
    expect(onManagedDoor(ctxOf(stranger))).toBe(true);
    expect(onManagedDoor(ctxOf({ authenticator: 'local-dev', attributes: {} }))).toBe(true);
    // Web chat and a schedule are not doors.
    expect(onManagedDoor(ctxOf({ authenticator: 'lares-console', attributes: {} }))).toBe(false);
    expect(onManagedDoor(ctxOf({ authenticator: 'app', principalType: 'runtime', attributes: {} }))).toBe(false);
  });
  it('lists the same doors in the door table and in the private-chat table', () => {
    expect([...PRIVATE_CHAT_AUTHENTICATORS].sort()).toEqual(Object.keys(DOORS).sort());
  });
  it('is closed without a placed turn', () => {
    expect(doorVaultPoint(ctxOf(identity(kinds[0]!, 'privateChat'), undefined, {}))).toBeUndefined();
    expect(doorVaultPoint(ctxOf(identity(kinds[0]!, 'privateChat'), undefined, { id: 'turn_0', sequence: -1 }))).toBeUndefined();
  });
});

describe('the closed list of sentences', () => {
  const route = () => doorVaultRoute(ctxOf(identity(kinds[0]!, 'privateChat')))!;
  const point = () => doorVaultPoint(ctxOf(identity(kinds[0]!, 'privateChat')))!;
  it('is the only text a failed door read or a bad pass can produce, whatever Keeper or the transport said', async () => {
    const said = ['the Vault root is not configured: VAULT_PATH is unset', 'Vault reader unavailable (the keeper refused: grant)', 'secret path /srv/lares/x'];
    for (const text of said) {
      broker.answer = () => new Error(text);
      for (const operation of ['list', 'read', 'search'] as const) {
        const error = await doorVaultRead(route(), point(), 'c'.repeat(43), operation, { area: 'private', path: 'a.md', q: 'x' }).then(() => undefined, e => e as Error);
        expect(error?.message).toBe(DOOR_NOTE_READ_FAILED);
        expect(DOOR_VAULT_SENTENCES.has(error!.message)).toBe(true);
      }
      const opening = await openDoorVaultTurn(route(), point(), { definition: {}, dutiesMd: '', voiceMd: '', hash: 'h' }).then(() => undefined, e => e as Error);
      // The pass request itself passes Keeper's text on only inside the agent; the caller turns any failure into the read sentence.
      expect(opening).toBeInstanceOf(Error);
    }
    broker.answer = () => ({ turnCapability: 'short', expiresAt: 1 });
    const bad = await openDoorVaultTurn(route(), point(), { definition: {}, dutiesMd: '', voiceMd: '', hash: 'h' }).then(() => undefined, e => e as Error);
    expect(bad?.message).toBe(DOOR_NOTE_READ_FAILED);
    for (const args of [{ area: 'taste' }, { area: 'private' }] as const) {
      broker.calls = [];
      const refused = await doorVaultRead(route(), point(), 'c'.repeat(43), 'read', args).then(() => undefined, e => e as Error);
      expect(refused?.message).toBe(DOOR_NOTE_READ_FAILED);
      expect(broker.calls).toEqual([]);
    }
  });
  it('holds plain, true sentences that say what was not done', () => {
    expect(DOOR_VAULT_SENTENCES.size).toBe(4);
    for (const sentence of DOOR_VAULT_SENTENCES) {
      expect(sentence).not.toMatch(/keeper|vault_path|database|error|exception|\//i);
      expect(sentence).toMatch(/\.$/);
    }
    for (const sentence of [...DOOR_VAULT_SENTENCES].filter(s => /save/i.test(s))) expect(sentence).toMatch(/Nothing was saved/);
  });
});

describe('the private-only list', () => {
  it('still keeps list and read off a door that is not the claimed person in a private chat', () => {
    expect(privateOnlyTool('agent-kit__vault_list')).toBe(true);
    const room = identity(kinds[0]!, 'room');
    expect(doorVaultReadOffered(ctxOf(room), 'chief-of-staff', 'agent-kit__vault_list')).toBe(false);
    expect(doorVaultReadOffered(ctxOf(identity(kinds[0]!, 'privateChat')), 'chief-of-staff', 'agent-kit__vault_search')).toBe(false);
  });
});
