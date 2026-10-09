import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { hashOf, loadDefinition, manifestViewOf } from '@lares/agent-kit/definition';
import { assertDeclarationIntegrity } from '@lares/agent-kit/manifest';
import { KeeperRefusedError } from './actions.js';
import { credentialConsumers } from './credential-consumers.js';
import type { CredentialRuntime } from './credential-activation.js';
import { inventoryGrants, type CredentialRecord } from './credential-state.js';
import type { KeeperConfig } from './config.js';
import type { DockerBoundary } from './docker.js';
import type { AgentLifecycle } from './lifecycle.js';
import { z } from 'zod';

function canonical(value: unknown): string {
  const sorted = (v: any): any => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
  return JSON.stringify(sorted(value));
}
/** Uses the SAME namespace lock as definitions and door mutations. Try-lock refuses contention
 * before effects rather than queueing a later restart. Never acts on unowned Docker services.
 */
export class OwnedCredentialRuntime implements CredentialRuntime {
  constructor(private pool: Pool, private config: KeeperConfig, private lifecycle: AgentLifecycle, private docker: DockerBoundary) {}
  async locked<T>(work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let acquired = false, broken = false;
    try {
      acquired = (await client.query('SELECT pg_try_advisory_lock(1279349317,12) AS acquired')).rows[0]?.acquired === true;
      if (!acquired) throw new KeeperRefusedError('Agent changes in progress; refresh status before Apply');
      return await work();
    } finally {
      if (acquired) try { await client.query('SELECT pg_advisory_unlock(1279349317,12)'); } catch { broken = true; }
      client.release(broken);
    }
  }
  private async owned(name: string, incarnation: string, revision?: string | null, requireRunning = false) {
    const row = (await this.pool.query('SELECT * FROM agent_resources WHERE name=$1', [name])).rows[0];
    if (!row || row.ownership_token !== incarnation || row.runtime_control_token !== incarnation || row.state !== 'ready' || !this.docker.inspect)
      throw new KeeperRefusedError('Ready owned runtime required');
    const runtime = await this.docker.inspect(name);
    const role = z.enum(['chief-of-staff', 'travel', 'creative']).parse(row.applied_definition?.role);
    const address = String(row.address).split('/')[0];
    // Docker clears a stopped container's IP. Its immutable ownership labels/image still
    // identify it for quiescence and rollback; only running containers must hold the address.
    if (runtime.incarnation !== incarnation || runtime.running && !runtime.addresses.includes(address) || runtime.image !== this.config.lifecycle!.imageByRole[role] || requireRunning && !runtime.running)
      throw new KeeperRefusedError('Actual runtime ownership or readiness changed');
    if (requireRunning && (!this.docker.healthy || !await this.docker.healthy(address))) throw new KeeperRefusedError('Runtime health unavailable');
    if (revision !== undefined) {
      const mount = runtime.mounts.filter(m => m.destination === '/run/secrets/notion-token');
      if (revision ? runtime.notionRevision !== revision || mount.length !== 1 || mount[0]!.source !== join(this.config.secretsDir, 'notion-token')
        : mount.length !== 0 || runtime.notionRevision !== null && runtime.notionRevision !== 'disconnected')
        throw new KeeperRefusedError('Actual Notion runtime binding changed');
    }
    return runtime;
  }
  async snapshot(record: CredentialRecord, recovery = false) {
    const consumers = await credentialConsumers(this.pool, this.config, inventoryGrants(record));
    if (consumers.some(c => c.category !== 'owned-agent' || !c.incarnation)) throw new KeeperRefusedError('Review unsupported credential consumers on the host');
    if (!this.docker.credentialMounts) throw new KeeperRefusedError('Actual credential mount inventory unavailable');
    const mounts = await this.docker.credentialMounts(join(this.config.secretsDir, 'notion-token'));
    if (mounts.some(m => !m.owned || !consumers.some(c => c.name === m.name && c.incarnation === m.incarnation)))
      throw new KeeperRefusedError('Unmanaged credential consumers require host administration');
    const rows = (await this.pool.query(`SELECT d.name,d.definition,d.duties,d.voice,d.hash,d.status,r.address,r.workflow_database,r.ownership_token,r.runtime_control_token,r.applied_definition,r.state,r.pending
      FROM agent_definitions d FULL JOIN agent_resources r ON r.name=d.name ORDER BY d.name`)).rows;
    const doors = (await this.pool.query('SELECT agent,kind,incarnation,revision,applied_revision,applied_connection FROM agent_door_connections ORDER BY agent,kind')).rows;
    for (const c of consumers) {
      const row = rows.find(r => r.name === c.name);
      const dir = join(this.config.agentsDir, c.name);
      const loaded = await loadDefinition({ serviceDir: dir, env: { LARES_DEFINITION_DIR: dir } });
      assertDeclarationIntegrity(manifestViewOf(loaded.definition));
      if (!row || loaded.hash !== row.hash || row.hash !== hashOf({ definition: row.definition, dutiesMd: row.duties, voiceMd: row.voice }) ||
          canonical(row.definition) !== canonical(row.applied_definition) || doors.some(d => d.agent === c.name && d.revision !== d.applied_revision))
        throw new KeeperRefusedError('Saved definition, grants or applied connections changed');
      await this.owned(c.name, c.incarnation!, recovery ? undefined : record.activeRevision, !recovery);
    }
    await this.lifecycle.credentialPreflight(consumers.map(c => c.name));
    // Not a key fingerprint: only configuration/definition/ownership facts enter this digest.
    const revision = createHash('sha256').update(canonical({ consumers, rows, doors, lifecycle: this.config.lifecycle, inventory: this.config.credentials })).digest('hex');
    return { revision, consumers };
  }
  async quiesce(name: string, incarnation: string) {
    await this.owned(name, incarnation);
    await this.docker.stop(name);
    if ((await this.owned(name, incarnation)).running) throw new KeeperRefusedError('Credential consumer did not stop');
  }
  installationBound(name: string) { return this.lifecycle.installationBindsNotion(name); }
  reconcile(name: string, revision: string | null) { return this.lifecycle.reconcileCredential(name, revision); }
  async verify(name: string, incarnation: string, revision: string | null) { await this.owned(name, incarnation, revision, true); }
}
