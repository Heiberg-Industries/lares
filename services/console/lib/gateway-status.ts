import { gatewayStatusSchema, type GatewayStatus } from '@lares/agent-kit/gateway-status';
import { credentialActor } from './credentials';
import { keeper, KeeperRefusedError, KeeperUnavailableError } from './keeper-client';
import { pool } from './db';

/** Every state is its own value: a keeper outage, a refusal and an unreadable result never look
 * like a gateway answer, and a failed definitions read (`usage: null`) never reads as "no agent
 * uses it". The console holds no gateway credential; the keeper does the reading. */
export type GatewayStatusView =
  | { kind: 'status'; status: GatewayStatus; usage: Record<string, string[]> | null }
  | { kind: 'keeper-unavailable' | 'refused' | 'invalid' | 'sign-in-required' };

async function usageByAlias(): Promise<Record<string, string[]> | null> {
  try {
    const { rows } = await pool.query<{ name: string; model: string | null }>(
      "SELECT name, definition->>'model' AS model FROM agent_definitions WHERE status <> 'retired' ORDER BY name");
    const usage: Record<string, string[]> = {};
    for (const r of rows) if (r.model) (usage[r.model] ??= []).push(r.name);
    return usage;
  } catch { return null; }
}

/** One keeper call per page render; no polling, no model call. */
export async function getGatewayStatusView(): Promise<GatewayStatusView> {
  const actor = await credentialActor();
  if (!actor) return { kind: 'sign-in-required' };
  let raw: unknown;
  try { raw = await keeper('gateway.status', {}, actor); }
  catch (error) {
    if (error instanceof KeeperUnavailableError) return { kind: 'keeper-unavailable' };
    if (error instanceof KeeperRefusedError) return { kind: 'refused' };
    return { kind: 'keeper-unavailable' };
  }
  const parsed = gatewayStatusSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid' };
  return { kind: 'status', status: parsed.data, usage: await usageByAlias() };
}
