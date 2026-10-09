import type { Pool } from 'pg';
import { join } from 'node:path';
import { z } from 'zod';
import type { KeeperConfig } from './config.js';
import { INTEGRATION_SECRET_FILES } from './runtime-bindings.js';
import type { CredentialConsumer, CredentialGrant } from './credential-state.js';

/** Root-owned retained inventory plus actual resource/definition records, not catalogue rows.
 * Missing data fails closed. Runtime activation must recheck Docker ownership in its own slice.
 */
export type CredentialConsumerConfig = Pick<KeeperConfig, 'secretsDir' | 'credentials'> & {
  lifecycle?: Pick<NonNullable<KeeperConfig['lifecycle']>, 'bindings' | 'defaultBindings'> & { egress?: Pick<NonNullable<KeeperConfig['lifecycle']>['egress'], 'legacyConsumers'> };
};
export async function credentialConsumers(pool: Pool, config: CredentialConsumerConfig, grants: CredentialGrant[] = []): Promise<CredentialConsumer[]> {
  // A grant is only honoured for the chief of staff role; anything else is listed, never silent.
  const granted = new Set(grants.filter(g => (g.purposes as string[]).includes('clipping')).map(g => g.agent));
  if (!config.credentials?.inventoryComplete || !config.lifecycle) throw new Error('Credential inventory unavailable');
  const result: CredentialConsumer[] = config.credentials.retainedConsumers.map(c => ({ ...c, incarnation: null }));
  const activePath = join(config.secretsDir, INTEGRATION_SECRET_FILES.NOTION_TOKEN_FILE);
  const { rows } = await pool.query(`SELECT COALESCE(d.name,r.name) AS name,d.definition,d.status,r.ownership_token,r.runtime_control_token,r.state,r.applied_definition,r.pending
    FROM agent_definitions d FULL JOIN agent_resources r ON r.name=d.name`);
  const bindingSources = [
    ...Object.values(config.lifecycle.bindings ?? {}), ...Object.values(config.lifecycle.defaultBindings ?? {}),
  ];
  for (const legacy of config.lifecycle.egress?.legacyConsumers ?? []) {
    if (legacy.hosts.includes('api.notion.com') && !result.some(c => c.name === legacy.name))
      result.push({ name: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/).parse(legacy.name), category: 'unmanaged-service', incarnation: null });
  }
  // An alternate mount/key can retain token access after removing the named binding.
  if (bindingSources.some(b => b && (b.mounts.some(m => m.source === activePath || activePath.startsWith(m.source.replace(/\/$/, '') + '/')) ||
      Object.entries(b.secrets).some(([key, path]) => key !== 'NOTION_TOKEN_FILE' && path === activePath))))
    result.push({ name: 'alternate-mount', category: 'external-binding', incarnation: null });
  // A configured external shared binding is a refusal even when no current agent selects it.
  if (bindingSources.some(b => b?.secrets.NOTION_TOKEN_FILE && b.secrets.NOTION_TOKEN_FILE !== activePath))
    result.push({ name: 'configured-binding', category: 'external-binding', incarnation: null });
  for (const row of rows) {
    const name = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/).parse(row.name);
    if (row.state === 'retired' && row.status === 'retired') continue;
    const role = z.enum(['chief-of-staff', 'travel', 'creative']).parse(row.definition?.role);
    const appliedRole = row.applied_definition ? z.enum(['chief-of-staff', 'travel', 'creative']).parse(row.applied_definition.role) : null;
    const incarnation = z.uuid().nullable().parse(row.ownership_token ?? null);
    // Unknown applied state may still carry an older token mount, even when the desired
    // definition selects a role without Notion. Never turn that uncertainty into absence.
    if (!appliedRole || row.pending !== false || !incarnation || row.runtime_control_token !== incarnation || row.state !== 'ready' || row.status !== 'valid') {
      result.push({name, category:'runtime-not-ready', incarnation});
      continue;
    }
    const bindings = [role, ...(appliedRole ? [appliedRole] : [])].map(role =>
      config.lifecycle!.bindings?.[name] ?? config.lifecycle!.defaultBindings?.[role]);
    // A grant is honoured for the chief of staff only; any other named agent is listed, never silent.
    if (granted.has(name) && (role !== 'chief-of-staff' || appliedRole !== 'chief-of-staff')) {
      result.push({name, category:'runtime-not-ready', incarnation});
      continue;
    }
    const tokenBindings = bindings.filter(b => b?.secrets.NOTION_TOKEN_FILE);
    if (!tokenBindings.length) {
      if (!granted.has(name)) continue;
      // Granted: the managed active file is added to the agent's own binding, which must already exist
      // (nothing is invented). Same ready rules as a configured binding.
      result.push({ name, category: bindings.every(Boolean) ? 'owned-agent' : 'runtime-not-ready', incarnation });
      continue;
    }
    const category = tokenBindings.some(b => b!.secrets.NOTION_TOKEN_FILE !== activePath) ? 'external-binding'
      : appliedRole !== role ? 'runtime-not-ready'
      : 'owned-agent';
    result.push({ name, category, incarnation });
  }
  // Unregistered named bindings must not be missed simply because the join found no agent.
  for (const name of granted) if (!rows.some(row => row.name === name)) result.push({ name, category: 'runtime-not-ready', incarnation: null });
  for (const [name, binding] of Object.entries(config.lifecycle.bindings ?? {})) {
    if (binding.secrets.NOTION_TOKEN_FILE && !rows.some(row => row.name === name))
      result.push({ name, category: 'runtime-not-ready', incarnation: null });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.category.localeCompare(b.category));
}
