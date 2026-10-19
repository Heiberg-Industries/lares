import { credentialActor } from './credentials';
import { keeper } from './keeper-client';
import type { Capacity } from './builder';

/** One keeper read per page render. Null means it could not be read (no session, keeper down). */
export async function getAgentLimitView(): Promise<Capacity | null> {
  const actor = await credentialActor();
  if (!actor) return null;
  try { return await keeper<Capacity>('definition.capacity', {}, actor); }
  catch { return null; }
}
