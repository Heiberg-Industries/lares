import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { requireDefinitionNamespace, withDefinitionNamespace } from '../lib/definition-namespace.js';

function fixture() {
  const statements: string[] = [];
  const query = vi.fn(async (query: string | { text: string; query_timeout?: number; values?: unknown[] }) => {
      const sql = typeof query === 'string' ? query : query.text;
      statements.push(sql);
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      return { rows: [] };
    });
  const client = {
    query,
    release: vi.fn(),
  } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { client, pool, statements, query };
}

describe('shared definition namespace', () => {
  it('queues before checkout and reuses the current scope for nested work', async () => {
    const f = fixture();
    await withDefinitionNamespace(f.pool, async client => {
      expect(requireDefinitionNamespace()).toBe(client);
      await withDefinitionNamespace(f.pool, async nested => expect(nested).toBe(client));
    });
    expect(f.pool.connect).toHaveBeenCalledTimes(1);
    expect(f.statements).toEqual(['SELECT pg_advisory_lock($1,$2)', 'SELECT pg_advisory_unlock($1,$2) AS unlocked']);
    expect(f.client.release).toHaveBeenCalledWith(false);
    expect(() => requireDefinitionNamespace()).toThrow('keeper: definition namespace unavailable');
  });

  it('revokes escaped async-context descendants before releasing the advisory-lock client', async () => {
    const f = fixture();
    let escaped!: () => void;
    await withDefinitionNamespace(f.pool, async () => {
      escaped = () => { requireDefinitionNamespace(); };
      expect(requireDefinitionNamespace()).toBe(f.client);
    });
    expect(f.client.release).toHaveBeenCalledWith(false);
    expect(escaped).toThrow('keeper: definition namespace unavailable');
  });

  it('does not checkout when its queued deadline expires', async () => {
    const f = fixture();
    let release!: () => void;
    const held = withDefinitionNamespace(f.pool, async () => new Promise<void>(resolve => { release = resolve; }));
    const expired = withDefinitionNamespace(f.pool, async () => {}, { deadlineAtMs: Date.now() + 5 });
    await new Promise(resolve => setTimeout(resolve, 15));
    release();
    await held;
    await expect(expired).rejects.toThrow('keeper: definition namespace unavailable');
    expect(f.pool.connect).toHaveBeenCalledTimes(1);
  });

  it('destroys a client when lock acquisition acknowledgement is uncertain', async () => {
    const f = fixture();
    f.query.mockImplementation(async (query: string | { text: string; query_timeout?: number; values?: unknown[] }) => {
      const sql = typeof query === 'string' ? query : query.text;
      if (sql.includes('pg_try_advisory_lock')) throw new Error('query timed out after server acquisition');
      return { rows: [] };
    });
    await expect(withDefinitionNamespace(f.pool, async () => {}, { deadlineAtMs: Date.now() + 1000 })).rejects.toThrow();
    expect(f.client.release).toHaveBeenCalledWith(true);
    expect(f.query).not.toHaveBeenCalledWith(expect.stringContaining('pg_advisory_unlock'), expect.anything());
  });

  it('destroys a client when unlock acknowledgement is uncertain and rejects expired nested work', async () => {
    const f = fixture();
    await withDefinitionNamespace(f.pool, async client => {
      await expect(withDefinitionNamespace(f.pool, async () => {}, { deadlineAtMs: Date.now() - 1 })).rejects.toThrow('keeper: definition namespace unavailable');
      expect(requireDefinitionNamespace()).toBe(client);
    });
    expect(f.client.release).toHaveBeenCalledWith(false);

    const uncertain = fixture();
    uncertain.query.mockImplementation(async (query: string | { text: string; query_timeout?: number; values?: unknown[] }) => {
      const sql = typeof query === 'string' ? query : query.text;
      if (sql.includes('pg_advisory_unlock')) throw new Error('unlock acknowledgement missing');
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      return { rows: [] };
    });
    await expect(withDefinitionNamespace(uncertain.pool, async () => {}, { deadlineAtMs: Date.now() + 1000 })).resolves.toBeUndefined();
    expect(uncertain.client.release).toHaveBeenCalledWith(true);
    const unlockCall = uncertain.query.mock.calls.find(([query]) => typeof query !== 'string' && query.text.includes('pg_advisory_unlock'))?.[0];
    expect(typeof unlockCall === 'string' ? undefined : unlockCall?.query_timeout).toBeLessThanOrEqual(250);
  });
});
