/**
 * PRIVATE NOTES FROM A CHAT DOOR: the route, the pass and the identity (ADR-0026's split, applied
 * to the Vault). The agent vouches for the platform event (eve checked its signature); Keeper
 * vouches for the person: it takes the member from its own configuration and rechecks the claim,
 * the use grant, the definition and the area on every read.
 *
 * DOOR-NEUTRAL. Nothing here names a door. Which authenticators are doors, and what their verified
 * sender is, is the door table (`door-kinds.ts`); whether a chat is private is `chatKindOf`
 * (`shared-room.ts`). A door with no row in either is refused (fail closed).
 *
 * The route exists only when BOTH the conversation's starter and the current speaker are in a
 * private chat (a group chat or channel never qualifies) and both are the person who claimed the
 * door. This is stricter than the model-authority route, which admits a room the claimed person
 * started. Every failure on this path throws one sentence from `door-vault-sentences.ts`.
 */
import { managedIdentity } from './door-authority.js';
import { claimedSender } from './door-model-authority.js';
import { chatKindOf, startedIn } from './shared-room.js';
import { vaultBrokerRequest } from './vault-broker-client.js';
import { DOOR_NOTE_READ_FAILED } from './door-vault-sentences.js';

export type DoorVaultRoute = Readonly<{ door: string; principal: string; claimRevision: string }>;
export type DoorVaultPoint = Readonly<{ sessionId: string; turnId: string; sequence: number; incarnation: string }>;
export type DoorVaultOperation = 'list' | 'read' | 'search';

type Ctx = { session?: { id?: unknown; turn?: { id?: unknown; sequence?: unknown }; initiator?: unknown; auth?: { current?: unknown; initiator?: unknown } | null } };
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TURN_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const MEMBER_ID = /^[^\s,;\x00-\x1f\x7f]{1,256}$/;

/** Whether this conversation is on a door of a runtime Keeper manages, whoever is speaking (so also a
 *  room, or a person who is not the claimed one). On such a door the agent's own files hold no private notes.
 *  FAILS CLOSED: anything that is not web chat or a schedule counts as a door, including an authenticator
 *  the door table does not know. */
export function onManagedDoor(ctx: unknown): boolean {
  try { return !!managedIdentity(process.env) && chatKindOf((ctx as Ctx | undefined)?.session?.auth?.current as never) !== 'not-a-door'; } catch { return true; }
}

/**
 * The door pass route for this context, or nothing. Synchronous; asks nobody. Nothing on a runtime
 * that Keeper does not manage, nothing for web chat, a schedule, an unknown door, a speaker who is
 * not the claimed person, or any conversation that did not start in, and is not now in, a private chat.
 */
export function doorVaultRoute(ctx: unknown): DoorVaultRoute | undefined {
  try {
    if (!managedIdentity(process.env)) return undefined;
    const session = (ctx as Ctx | undefined)?.session;
    const current = session?.auth?.current, initiator = session?.auth?.initiator ?? session?.initiator;
    if (chatKindOf(current as never) !== 'private-chat' || chatKindOf(initiator as never) !== 'private-chat' || startedIn(ctx) !== 'private-chat') return undefined;
    const speaker = claimedSender(current), first = claimedSender(initiator);
    if (speaker.door !== first.door || speaker.principal !== first.principal) return undefined;
    return Object.freeze({ door: speaker.door, principal: speaker.principal, claimRevision: speaker.revision });
  } catch { return undefined; }
}

/** The exact point a tool call or hook sits at, from the session; nothing when it cannot be placed. */
export function doorVaultPoint(ctx: unknown): DoorVaultPoint | undefined {
  try {
    const session = (ctx as Ctx | undefined)?.session, identity = managedIdentity(process.env);
    const sessionId = session?.id, turnId = session?.turn?.id, sequence = session?.turn?.sequence;
    if (!identity || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || typeof turnId !== 'string' || !TURN_ID.test(turnId) ||
        typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) return undefined;
    return Object.freeze({ sessionId, turnId, sequence, incarnation: identity.incarnation });
  } catch { return undefined; }
}

/** Asks Keeper for this turn's pass. The agent names the door, the claim and the turn, never a member. */
export async function openDoorVaultTurn(route: DoorVaultRoute, point: DoorVaultPoint,
  definition: { definition: unknown; dutiesMd: string; voiceMd: string; hash: string }): Promise<{ capability: string; expiresAt: number; memberId: string }> {
  const answer = await vaultBrokerRequest<{ turnCapability?: unknown; expiresAt?: unknown; memberId?: unknown }>('door.turn.open', {
    door: route.door, principal: route.principal, claimRevision: route.claimRevision, chat: 'private',
    sessionId: point.sessionId, turnId: point.turnId, sequence: point.sequence, definition,
  });
  const now = Date.now();
  if (typeof answer.turnCapability !== 'string' || !CAPABILITY.test(answer.turnCapability) || typeof answer.expiresAt !== 'number' ||
      !Number.isSafeInteger(answer.expiresAt) || answer.expiresAt <= now || typeof answer.memberId !== 'string' || !MEMBER_ID.test(answer.memberId)) throw new Error(DOOR_NOTE_READ_FAILED);
  // The member is Keeper's own finding (its configured owner, checked against the claim). A saved note's card is
  // reserved for that member, and Keeper names him again when it writes.
  return { capability: answer.turnCapability, expiresAt: answer.expiresAt, memberId: answer.memberId };
}

export async function closeDoorVaultTurn(point: { turnId: string; sequence: number }, capability: string): Promise<void> {
  await vaultBrokerRequest('door.turn.close', { turnCapability: capability, turnId: point.turnId, sequence: point.sequence }).catch(() => undefined);
}

/** One list, read or search through the pass. Any failure, whatever Keeper or the transport said, is the one read sentence. */
export async function doorVaultRead(route: DoorVaultRoute, point: DoorVaultPoint, capability: string, operation: DoorVaultOperation,
  args: { area?: unknown; path?: unknown; offset?: unknown; folder?: unknown; cursor?: unknown; q?: unknown }): Promise<unknown> {
  try {
    if (args.area !== 'private' && args.area !== 'shared') throw new Error('area');
    if ((operation === 'read' && typeof args.path !== 'string') || (operation === 'search' && typeof args.q !== 'string')) throw new Error('input');
    const identity = { turnCapability: capability, turnId: point.turnId, sequence: point.sequence, sessionId: point.sessionId,
      door: route.door, principal: route.principal, claimRevision: route.claimRevision, area: args.area, operation };
    if (operation === 'search') return await vaultBrokerRequest('vault.read', { ...identity, q: args.q });
    if (operation === 'list') return await vaultBrokerRequest('vault.read', { ...identity,
      ...(typeof args.folder === 'string' ? { folder: args.folder } : {}), ...(Number.isSafeInteger(args.cursor) ? { cursor: args.cursor } : {}) });
    return await vaultBrokerRequest('vault.read', { ...identity, path: args.path, ...(Number.isSafeInteger(args.offset) ? { offset: args.offset } : {}) });
  } catch { throw new Error(DOOR_NOTE_READ_FAILED); }
}

/**
 * This context, seen as the door sees it when eve resumes a turn with no current identity. eve hands an
 * answered card's call to the requester's context, and a Telegram tap resumes with `auth: null`; the person
 * who opened the conversation is still real and verified (the same fallback `approverFrom` makes). Only a
 * missing current identity is replaced, and only by the conversation's initiator: a current identity that is
 * present is never touched. Everything that asks "is this a door, and whose?" uses this view for a call that
 * is already approved.
 */
export function doorSeen(ctx: unknown): unknown {
  const session = (ctx as Ctx | undefined)?.session;
  const auth = session?.auth;
  if (!session || (auth?.current !== undefined && auth.current !== null)) return ctx;
  const initiator = auth?.initiator ?? session.initiator;
  if (initiator === undefined || initiator === null) return ctx;
  return { ...(ctx as object), session: { ...session, auth: { ...(auth ?? {}), current: initiator, initiator } } };
}
