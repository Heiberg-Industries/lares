import { readFileSync } from 'node:fs';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { quietPool } from './helpers/quiet-pool.js';
import { PgCredentialStore } from '../lib/credential-store.js';
import { CREDENTIAL_SLOT, initialCredentialRecord } from '../lib/credential-state.js';
let container: StartedPostgreSqlContainer, pool: Pool, store: PgCredentialStore;
beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = quietPool(container.getConnectionUri()); store = new PgCredentialStore(pool);
  const migration = readFileSync(new URL('../../box/sql/090_keeper_credentials.sql', import.meta.url), 'utf8');
  await pool.query(migration); await pool.query(migration);
});
afterAll(async () => { await pool?.end(); await container?.stop(); });
it('creates a standalone idempotent journal, refuses other slots and preserves strict records', async () => {
  expect(await store.read()).toEqual(initialCredentialRecord());
  await expect(pool.query('INSERT INTO keeper_credentials VALUES($1,1,$2)', ['platform:master', { slot: 'platform:master', version: 1 }])).rejects.toThrow();
  await store.locked(async journal => {
    const r = await journal.read();
    expect(await journal.save(r, r)).toMatchObject({ version: 1 });
    await expect(journal.save(r, r)).rejects.toThrow('revision changed');
  });
  expect((await pool.query('SELECT record FROM keeper_credentials')).rows[0].record).toEqual(await store.read());
});
it('commits intent before callback finishes/fails, preserving it for a fresh store instance', async () => {
  await expect(store.locked(async journal => {
    const r = await journal.read();
    await journal.save(r, { ...r, phase: 'recovery-required' });
    expect(await new PgCredentialStore(pool).read()).toMatchObject({ phase: 'recovery-required', version: 2 });
    throw new Error('synthetic interruption');
  })).rejects.toThrow('interruption');
  expect(await new PgCredentialStore(pool).read()).toMatchObject({ phase: 'recovery-required', version: 2 });
});
it('refuses another process/store immediately while slot lock is held and releases on failure', async () => {
  await store.locked(async () => {
    await expect(new PgCredentialStore(pool).locked(async () => undefined)).rejects.toThrow('operation in progress');
  });
  await expect(store.locked(async () => { throw new Error('crash'); })).rejects.toThrow('crash');
  expect(await new PgCredentialStore(pool).locked(async () => 42)).toBe(42);
});
it('DB finalization rejection leaves the last durable intent, without rolling it back', async () => {
  await pool.query("ALTER TABLE keeper_credentials ADD CONSTRAINT synthetic_fail CHECK (version < 4)");
  try {
    await expect(store.locked(async journal => {
      const r = await journal.read(); const intent = await journal.save(r, r);
      await journal.save(intent, { ...intent, phase: 'not-configured' });
    })).rejects.toThrow();
    expect(await store.read()).toMatchObject({ version: 3, phase: 'recovery-required' });
  } finally { await pool.query('ALTER TABLE keeper_credentials DROP CONSTRAINT synthetic_fail'); }
});
it('reads corrupted metadata as failure rather than returning unknown keys to a browser', async () => {
  const saved = await store.read();
  await pool.query('UPDATE keeper_credentials SET record=record || $1::jsonb WHERE slot=$2', [{ unexpected: 'synthetic-value' }, CREDENTIAL_SLOT]);
  await expect(store.read()).rejects.toThrow();
  await pool.query('UPDATE keeper_credentials SET record=$1 WHERE slot=$2', [saved, CREDENTIAL_SLOT]);
  await store.locked(async j => { await expect(j.save(saved, { ...saved, token: 'synthetic-value' } as never)).rejects.toThrow(); });
});
it('keeps grants in the same jsonb record, and a record stored without them still reads', async () => {
  const stored = (await pool.query('SELECT record FROM keeper_credentials')).rows[0].record;
  expect(stored.grants).toBeUndefined();
  await store.locked(async journal => {
    const r = await journal.read();
    const saved = await journal.save(r, { ...r, grants: [{ agent: 'chief', purposes: ['clipping'] }] });
    expect((await new PgCredentialStore(pool).read()).grants).toEqual(saved.grants);
  });
});
