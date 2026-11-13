import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelPurposeAckFields, modelPurposeMac, type ModelPurposeRuntimeEnvelope } from '../src/model-purpose-protocol.js';

// The runtime-control key file is checked for root ownership and mode 0440; the fake file system
// answers those checks the way the client test does (`model-purpose-client.test.ts`).
const fixture = vi.hoisted(() => ({ keyText: '2'.repeat(64) }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: vi.fn(() => ({ uid: 0, mode: 0o40755, isSymbolicLink: () => false, isDirectory: () => true })),
    openSync: vi.fn(() => 42),
    closeSync: vi.fn(),
    fstatSync: vi.fn(() => ({ uid: 0, gid: 10_001, mode: 0o100440, size: fixture.keyText.length, nlink: 1, isFile: () => true })),
    readSync: vi.fn((_fd: number, buffer: Buffer, offset: number, length: number) => {
      const bytes = Buffer.from(fixture.keyText);
      const count = Math.min(length, bytes.length);
      bytes.copy(buffer, offset, 0, count);
      return count;
    }),
  };
});

import { captureModelInvocation } from '../src/model-invocation.js';
import {
  claimDoorModelAuthority, closeDoorModelTurn, doorModelAuthority, modelAuthorityRoute, prepareDoorModelInvocation,
} from '../src/door-model-authority.js';
import { approvalReplySentence, DOOR_MODEL_REFUSED, DOOR_MODEL_REFUSED_SENTENCE } from '../src/approval-reply-sentence.js';
import { respondToSessionFailed, respondToTurnFailed } from '../src/gateway-budget.js';

const root = mkdtempSync(join(tmpdir(), 'lares-door-model-authority-'));
const socketPath = join(root, 'keeper.sock');
const key = Buffer.from(fixture.keyText, 'hex');
const sockets = new Set<Socket>();
let server: Server;

type Frame = { op: string; input: Record<string, unknown> };
const frames: Frame[] = [];
const ops = (op: string) => frames.filter(f => f.op === op);
let doorMode = 'valid';
let closeMode = 'valid';
let releaseHeld: (() => void) | undefined;
let heldArrived: (() => void) | undefined;

const CAPABILITY = 'D'.repeat(43);
const STEP_CLAIM = 'K'.repeat(43);
const INCARNATION = '123e4567-e89b-42d3-a456-426614174000';
const SLACK_REVISION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TELEGRAM_REVISION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function signed(envelope: ModelPurposeRuntimeEnvelope, result: Record<string, unknown>): string {
  const fields = modelPurposeAckFields(envelope, result);
  return JSON.stringify({ ok: true, ...result,
    responseMac: modelPurposeMac(key, fields).toString('base64url'),
    responseRequestDigest: fields.requestDigest,
    responseOutcomeDigest: fields.outcomeDigest,
    responsePayloadDigest: fields.payloadDigest,
  }) + '\n';
}

function doorAnswer(socket: Socket, envelope: ModelPurposeRuntimeEnvelope): void {
  const now = Date.now();
  switch (doorMode) {
    case 'refuse': socket.end('{"ok":false}\n'); return;
    case 'stall': return;
    case 'close': socket.destroy(); return;
    case 'bad-capability': socket.end(signed(envelope, { capability: 'short', expiresAt: now + 60_000 })); return;
    case 'past': socket.end(signed(envelope, { capability: CAPABILITY, expiresAt: now - 1 })); return;
    case 'far': socket.end(signed(envelope, { capability: CAPABILITY, expiresAt: now + 10 * 60_000 })); return;
    case 'extra-key': socket.end(signed(envelope, { capability: CAPABILITY, expiresAt: now + 60_000, memberId: 'm' })); return;
    case 'hold': {
      releaseHeld = () => { if (!socket.destroyed) socket.end(signed(envelope, { capability: CAPABILITY, expiresAt: Date.now() + 60_000 })); };
      heldArrived?.();
      return;
    }
    default: socket.end(signed(envelope, { capability: CAPABILITY, expiresAt: now + 60_000 }));
  }
}

beforeAll(async () => {
  server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let bytes = '';
    socket.on('data', chunk => {
      bytes += chunk.toString('utf8');
      if (!bytes.includes('\n')) return;
      const envelope = JSON.parse(bytes.slice(0, bytes.indexOf('\n'))) as ModelPurposeRuntimeEnvelope & Frame;
      frames.push({ op: envelope.op, input: envelope.input });
      if (envelope.op === 'door.open') return doorAnswer(socket, envelope);
      if (envelope.op === 'step.claim') { socket.end(signed(envelope, { claim: STEP_CLAIM, expiresAt: Date.now() + 20_000 })); return; }
      if (envelope.op === 'turn.close') { socket.end(closeMode === 'refuse' ? '{"ok":false}\n' : signed(envelope, {})); return; }
      socket.end('{"ok":false}\n');
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
});

const MANAGED_ENV = {
  LARES_AGENT_NAME: 'example-agent',
  LARES_AGENT_INCARNATION: INCARNATION,
  LARES_RUNTIME_CONTROL_SECRET_FILE: join(root, 'runtime-control'),
  LARES_MODEL_PURPOSE_RUNTIME_SOCKET: socketPath,
  LARES_SLACK_PRINCIPAL: 'U0EXAMPLE',
  LARES_SLACK_CLAIM_REVISION: SLACK_REVISION,
  LARES_TELEGRAM_PRINCIPAL: '700000001',
  LARES_TELEGRAM_CLAIM_REVISION: TELEGRAM_REVISION,
};

beforeEach(() => {
  for (const [name, value] of Object.entries(MANAGED_ENV)) vi.stubEnv(name, value);
  frames.length = 0;
  doorMode = 'valid';
  closeMode = 'valid';
  releaseHeld = undefined;
  heldArrived = undefined;
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

// eve's own identities, in the shapes eve 1.0.0-rc.10 builds them (`buildSlackAuthContext`,
// `defaultTelegramAuth`, `SCHEDULE_APP_AUTH`). Neutral values only.
const slack = (user: unknown = 'U0EXAMPLE', over: { principalType?: string; author_type?: string } = {}) => ({
  authenticator: 'slack-webhook', issuer: 'slack:T0EXAMPLE', principalId: `slack:T0EXAMPLE:${String(user)}`,
  principalType: over.principalType ?? 'user',
  attributes: { author_type: over.author_type ?? 'user', channel_id: 'D0EXAMPLE', user_id: user },
});
/** A mention of the agent in a Slack room: eve's identity has a room channel id and no verified
 * kind of chat, so the claimed person is a door turn there too. */
const slackRoom = (user = 'U0EXAMPLE') => ({
  ...slack(user), attributes: { author_type: 'user', channel_id: 'C0EXAMPLE', thread_ts: '1700000000.000100', user_id: user },
});
const telegram = (user: unknown = '700000001', chatType = 'private') => ({
  authenticator: 'telegram-webhook', issuer: 'telegram', principalId: `telegram:${String(user)}`, principalType: 'user',
  attributes: { chat_id: String(user), chat_type: chatType, message_id: '1', user_id: user },
});
const schedule = () => ({ attributes: {}, authenticator: 'app', principalId: 'eve:app', principalType: 'runtime' });
const webChat = () => ({ authenticator: 'lares-console', issuer: 'lares', principalId: 'member:example', principalType: 'user', attributes: {} });
const unknownDoor = () => ({ authenticator: 'example-webhook', issuer: 'example', principalId: 'example:1', principalType: 'user', attributes: { user_id: 'U0EXAMPLE' } });

let sessions = 0;
const session = (current: unknown, initiator: unknown = current) =>
  ({ id: `door-session-${++sessions}`, auth: { current, initiator } }) as never;
const step = (turn = 0, stepIndex = 0) => ({ type: 'step.started' as const, data: { turnId: `turn_${turn}`, sequence: turn, stepIndex } });
const settled = (turn = 0) => ({ type: 'turn.settled', data: { turnId: `turn_${turn}`, sequence: turn } });
const paused = (turn = 0) => ({ type: 'turn.paused', data: { turnId: `turn_${turn}`, sequence: turn } });

/** What the model resolver does: reserve the point, capture the invocation, ask for authority. */
async function selectModel(s: never, event = step(), alias = 'example-brain') {
  prepareDoorModelInvocation(event, s);
  return claimDoorModelAuthority(captureModelInvocation(event, s, alias));
}

describe('which authority a model call needs', () => {
  it.each([
    ['slack current and initiator, the same claimed user', () => session(slack(), slack()), 'door'],
    ['telegram private chat, the claimed user', () => session(telegram(), telegram()), 'door'],
    ['the claimed slack user replying in a thread a schedule started', () => session(slack(), schedule()), 'door'],
    ['a schedule that started its own conversation', () => session(schedule(), schedule()), 'owner-job'],
    ['a schedule continuing a conversation the claimed telegram user started', () => session(schedule(), telegram()), 'owner-job'],
    ['a web chat session', () => session(webChat(), webChat()), 'none'],
  ] as const)('%s', (_label, build, route) => {
    expect(modelAuthorityRoute(build())).toBe(route);
  });

  it.each([
    ['slack', () => session(slack(), slack())],
    ['telegram', () => session(telegram(), telegram())],
    ['slack after a schedule', () => session(slack(), schedule())],
    ['schedule', () => session(schedule(), schedule())],
    ['schedule after telegram', () => session(schedule(), telegram())],
    ['web chat', () => session(webChat(), webChat())],
    ['an unclaimed slack user', () => session(slack('U0OTHER'), slack('U0OTHER'))],
  ])('is "none" and sends nothing on a runtime that is not managed: %s', async (_label, build) => {
    vi.stubEnv('LARES_MODEL_PURPOSE_RUNTIME_SOCKET', '');
    const s = build();
    expect(modelAuthorityRoute(s)).toBe('none');
    await expect(selectModel(s)).resolves.toBe('none');
    expect(frames).toEqual([]);
  });

  it('a web chat call is left to web chat and sends no frame', async () => {
    await expect(selectModel(session(webChat(), webChat()))).resolves.toBe('none');
    expect(frames).toEqual([]);
  });

  it('a schedule-started call is an owner job and asks nothing here', async () => {
    await expect(selectModel(session(schedule(), schedule()))).resolves.toBe('owner-job');
    expect(frames).toEqual([]);
  });
});

describe('per door: Telegram only in a private chat, Slack wherever the claimed person speaks', () => {
  it('the claimed person mentioning the agent in a Slack room is a door turn, and pays', async () => {
    const s = session(slackRoom(), slackRoom());
    expect(modelAuthorityRoute(s)).toBe('door');
    await expect(selectModel(s)).resolves.toBe('door');
    expect(ops('door.open')[0]!.input).toMatchObject({ door: 'slack', principal: 'U0EXAMPLE' });
  });

  it('another person writing in that Slack room thread is refused and causes no spending', async () => {
    const s = session(slackRoom('U0OTHER'), slackRoom());
    expect(() => modelAuthorityRoute(s)).toThrow(new Error(DOOR_MODEL_REFUSED));
    await expect(selectModel(s)).rejects.toThrow(new Error(DOOR_MODEL_REFUSED));
    expect(frames).toEqual([]);
  });

  it('the claimed person in a Telegram group chat is refused', () => {
    expect(() => modelAuthorityRoute(session(telegram('700000001', 'group'), telegram('700000001', 'group')))).toThrow(new Error(DOOR_MODEL_REFUSED));
    expect(frames).toEqual([]);
  });
});

describe('a door turn that fails a check is refused, never passed on', () => {
  it.each([
    ['another slack user', () => session(slack('U0OTHER'), slack('U0OTHER'))],
    ['another telegram user', () => session(telegram('700000002'), telegram('700000002'))],
    ['a missing slack claim revision', () => { vi.stubEnv('LARES_SLACK_CLAIM_REVISION', ''); return session(slack(), slack()); }],
    ['a malformed telegram claim revision', () => { vi.stubEnv('LARES_TELEGRAM_CLAIM_REVISION', 'not-a-revision'); return session(telegram(), telegram()); }],
    ['no claimed slack user at all', () => { vi.stubEnv('LARES_SLACK_PRINCIPAL', ''); return session(slack(''), slack('')); }],
    ['a slack bot author', () => session(slack('U0EXAMPLE', { author_type: 'bot' }), slack())],
    ['a slack service principal', () => session(slack('U0EXAMPLE', { principalType: 'service' }), slack())],
    ['a telegram group chat', () => session(telegram('700000001', 'group'), telegram())],
    ['a user id that is not a string', () => session(telegram(700000001), telegram(700000001))],
    ['an empty user id', () => session(slack(''), slack(''))],
    ['slack now, telegram first', () => session(slack(), telegram())],
    ['slack now, another slack user first', () => session(slack(), slack('U0OTHER'))],
    ['slack now, web chat first', () => session(slack(), webChat())],
    ['slack now, nobody first', () => session(slack(), null)],
    ['a schedule now, web chat first', () => session(schedule(), webChat())],
    ['a schedule now, an unknown door first', () => session(schedule(), unknownDoor())],
    ['a schedule now, another slack user first', () => session(schedule(), slack('U0OTHER'))],
    ['an incomplete managed identity', () => { vi.stubEnv('LARES_AGENT_INCARNATION', 'not-an-incarnation'); return session(slack(), slack()); }],
    ['no managed identity', () => { vi.stubEnv('LARES_AGENT_NAME', ''); vi.stubEnv('LARES_AGENT_INCARNATION', ''); return session(slack(), slack()); }],
  ])('%s', async (_label, build) => {
    const s = build();
    expect(() => modelAuthorityRoute(s)).toThrow(new Error(DOOR_MODEL_REFUSED));
    expect(() => prepareDoorModelInvocation(step(), s)).toThrow(new Error(DOOR_MODEL_REFUSED));
    await expect(claimDoorModelAuthority(captureModelInvocation(step(), s, 'example-brain'))).rejects.toThrow(new Error(DOOR_MODEL_REFUSED));
    expect(ops('door.open')).toEqual([]);
    expect(frames).toEqual([]);
  });
});

describe('the door.open exchange with Keeper', () => {
  it('sends exactly the six contract keys, then claims the step with the capability it got', async () => {
    const s = session(slack(), slack()) as { id: string };
    await expect(selectModel(s as never, step(3, 41))).resolves.toBe('door');
    expect(frames.map(f => f.op)).toEqual(['door.open', 'step.claim']);
    expect(frames[0]!.input).toEqual({
      door: 'slack', principal: 'U0EXAMPLE', claimRevision: SLACK_REVISION,
      sessionId: s.id, turnId: 'turn_3', sequence: 3,
    });
    expect(Object.keys(frames[0]!.input).sort()).toEqual(['claimRevision', 'door', 'principal', 'sequence', 'sessionId', 'turnId']);
    const wire = JSON.stringify(frames[0]!.input);
    for (const absent of ['slack-webhook', 'T0EXAMPLE', 'member', 'email', 'example-brain', 'auth']) expect(wire).not.toContain(absent);
    expect(frames[1]!.input).toEqual({ turnCapability: CAPABILITY, purposeAlias: 'example-brain', event: step(3, 41) });
  });

  it('a telegram turn names its door and its claimed user', async () => {
    await expect(selectModel(session(telegram(), telegram()))).resolves.toBe('door');
    expect(frames[0]!.input).toMatchObject({ door: 'telegram', principal: '700000001', claimRevision: TELEGRAM_REVISION });
  });

  it.each(['bad-capability', 'past', 'far', 'extra-key'])('refuses a malformed answer: %s', async mode => {
    doorMode = mode;
    await expect(selectModel(session(slack(), slack()))).rejects.toThrow(new Error(DOOR_MODEL_REFUSED));
    expect(ops('step.claim')).toEqual([]);
  });

  it.each(['refuse', 'close'])('turns a Keeper %s into the door refusal', async mode => {
    doorMode = mode;
    await expect(selectModel(session(slack(), slack()))).rejects.toThrow(new Error(DOOR_MODEL_REFUSED));
    expect(ops('step.claim')).toEqual([]);
  });

  it('turns a Keeper timeout into the door refusal', async () => {
    doorMode = 'stall';
    await expect(selectModel(session(slack(), slack()))).rejects.toThrow(new Error(DOOR_MODEL_REFUSED));
    expect(ops('step.claim')).toEqual([]);
  }, 5_000);

  it('two model calls in one turn open the door once and claim two steps with the same capability', async () => {
    const s = session(slack(), slack());
    await expect(selectModel(s, step(0, 1))).resolves.toBe('door');
    await expect(selectModel(s, step(0, 9))).resolves.toBe('door');
    expect(ops('door.open')).toHaveLength(1);
    expect(ops('step.claim').map(f => f.input.turnCapability)).toEqual([CAPABILITY, CAPABILITY]);
  });

  it('two concurrent calls for the same point share one door.open', async () => {
    const s = session(telegram(), telegram());
    prepareDoorModelInvocation(step(0, 1), s);
    prepareDoorModelInvocation(step(0, 2), s);
    await expect(Promise.all([
      claimDoorModelAuthority(captureModelInvocation(step(0, 1), s, 'example-brain')),
      claimDoorModelAuthority(captureModelInvocation(step(0, 2), s, 'example-brain')),
    ])).resolves.toEqual(['door', 'door']);
    expect(ops('door.open')).toHaveLength(1);
    expect(ops('step.claim')).toHaveLength(2);
  });

  it('a turn that settles while door.open is in flight closes the late capability and refuses the call', async () => {
    doorMode = 'hold';
    const arrived = new Promise<void>(resolve => { heldArrived = resolve; });
    const s = session(slack(), slack());
    const call = selectModel(s, step(2, 5));
    await arrived;
    await closeDoorModelTurn(settled(2), s);
    releaseHeld!();
    await expect(call).rejects.toThrow(new Error(DOOR_MODEL_REFUSED));
    expect(ops('turn.close').map(f => f.input)).toEqual([{ turnCapability: CAPABILITY, turnId: 'turn_2', sequence: 2 }]);
    expect(ops('step.claim')).toEqual([]);
  });

  it('a paused turn closes its capability and its continuation opens the door again', async () => {
    const s = session(slack(), schedule());
    await selectModel(s, step(1, 3));
    await closeDoorModelTurn(paused(1), s);
    expect(ops('turn.close').map(f => f.input)).toEqual([{ turnCapability: CAPABILITY, turnId: 'turn_1', sequence: 1 }]);
    await expect(selectModel(s, step(1, 8))).resolves.toBe('door');
    expect(ops('door.open')).toHaveLength(2);
  });

  it('a settled turn closes its capability and no later call for that point is let through', async () => {
    const s = session(slack(), slack());
    await selectModel(s, step(4, 1));
    await closeDoorModelTurn(settled(4), s);
    expect(ops('turn.close')).toHaveLength(1);
    const before = frames.length;
    expect(() => prepareDoorModelInvocation(step(4, 7), s)).toThrow(new Error(DOOR_MODEL_REFUSED));
    await expect(claimDoorModelAuthority(captureModelInvocation(step(4, 7), s, 'example-brain'))).rejects.toThrow(new Error(DOOR_MODEL_REFUSED));
    expect(frames.length).toBe(before);
  });

  it('closing never throws, even when turn.close fails or the event is unreadable', async () => {
    const s = session(slack(), slack());
    await selectModel(s, step(0, 1));
    closeMode = 'refuse';
    await expect(closeDoorModelTurn(settled(0), s)).resolves.toBeUndefined();
    expect(ops('turn.close')).toHaveLength(1);
    await expect(closeDoorModelTurn({ data: { turnId: 7 } }, s)).resolves.toBeUndefined();
    await expect(closeDoorModelTurn(undefined, undefined)).resolves.toBeUndefined();
    vi.stubEnv('LARES_AGENT_INCARNATION', 'not-an-incarnation');
    await expect(closeDoorModelTurn(settled(0), s)).resolves.toBeUndefined();
  });

  it('bundles prepare and claim for the model resolver', () => {
    expect(doorModelAuthority.prepare).toBe(prepareDoorModelInvocation);
    expect(doorModelAuthority.claim).toBe(claimDoorModelAuthority);
  });
});

describe('the one sentence a person sees', () => {
  const sentence = 'I could not get permission to answer this message here. Please try again later, or write to me in web chat.';

  it('maps the door refusal, as thrown and as eve wraps it, to its sentence', () => {
    expect(DOOR_MODEL_REFUSED).toBe('A door turn has no model permission');
    expect(DOOR_MODEL_REFUSED_SENTENCE).toBe(sentence);
    expect(approvalReplySentence(DOOR_MODEL_REFUSED)).toBe(sentence);
    expect(approvalReplySentence(`DefinitionFailedError: ${DOOR_MODEL_REFUSED}`)).toBe(sentence);
  });

  it.each(['slack', 'telegram'] as const)('the %s answer to a failed turn and a failed session is that sentence', dialect => {
    const failed = { outcome: 'failed', error: { code: 'REACTION_FAILED', message: `DefinitionFailedError: ${DOOR_MODEL_REFUSED}` } };
    const options = { refusalText: 'FIXED SENTENCE', dialect };
    expect(respondToTurnFailed(failed, options)).toEqual({ kind: 'approval-reply-refused', text: sentence });
    expect(respondToSessionFailed(failed, options)).toEqual({ kind: 'approval-reply-refused', text: sentence });
  });
});
