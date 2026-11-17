/**
 * THE DOOR TABLE: the one place that knows a chat door by name. No imports on purpose.
 *
 * Keyed by the authenticator eve stamps once it has checked the platform's signature or secret.
 * Each row gives the door's kind and its verified sender (ADR-0025 rule 5, item 1): the platform's
 * own user id, exactly as the door claim stored it, never eve's `principalId`. Whether a chat is
 * private is the other per-door row, in `shared-room.ts` (`chatKindOf`). A new door adds a row in
 * each and nothing else; a door with no row here is refused everywhere (fail closed).
 */
export type DoorKind = string;
export type DoorAuth = { authenticator?: unknown; principalType?: unknown; attributes?: Record<string, unknown> | null };

export const DOORS: Readonly<Record<string, { readonly door: DoorKind; readonly sender: (a: DoorAuth) => unknown }>> = Object.freeze({
  'slack-webhook': { door: 'slack', sender: a => a.principalType === 'user' && a.attributes?.author_type === 'user' ? a.attributes.user_id : undefined },
  'telegram-webhook': { door: 'telegram', sender: a => a.principalType === 'user' && a.attributes?.chat_type === 'private' ? a.attributes.user_id : undefined },
});

/** Whether this kind names a door in the table. */
export function isKnownDoor(kind: unknown): kind is DoorKind {
  return typeof kind === 'string' && Object.values(DOORS).some(row => row.door === kind);
}
/** The table row for an identity's authenticator, or nothing. */
export function doorRowOf(auth: unknown) {
  const authenticator = (auth as DoorAuth | null | undefined)?.authenticator;
  return typeof authenticator === 'string' && Object.hasOwn(DOORS, authenticator) ? DOORS[authenticator] : undefined;
}
/** The environment variables a door's applied claim reads. */
export function claimEnvNames(door: DoorKind): { principal: string; revision: string } {
  const kind = door.toUpperCase();
  return { principal: `LARES_${kind}_PRINCIPAL`, revision: `LARES_${kind}_CLAIM_REVISION` };
}
