import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';

const GATE = 1279349317;
const KEY = 12;
const REFUSED = 'keeper: definition namespace unavailable';
let tail: Promise<unknown> = Promise.resolve();
type NamespaceOwner = { pool: Pool; client: PoolClient; active: boolean };
const scope = new AsyncLocalStorage<NamespaceOwner>();

export function requireDefinitionNamespace(): PoolClient {
  const current = scope.getStore();
  if (!current?.active) throw new Error(REFUSED);
  return current.client;
}

/** Serialize all definition and route-policy work before borrowing the advisory-lock client. */
export async function withDefinitionNamespace<T>(pool: Pool, work: (client: PoolClient) => Promise<T>, options: { deadlineAtMs?: number } = {}): Promise<T> {
  const current = scope.getStore();
  if (current) {
    if (!current.active || current.pool !== pool) throw new Error(REFUSED);
    if (options.deadlineAtMs !== undefined && (!Number.isFinite(options.deadlineAtMs) || options.deadlineAtMs <= Date.now())) throw new Error(REFUSED);
    if (!current.active || options.deadlineAtMs !== undefined && options.deadlineAtMs <= Date.now()) throw new Error(REFUSED);
    return work(current.client);
  }
  if (options.deadlineAtMs !== undefined && (!Number.isFinite(options.deadlineAtMs) || options.deadlineAtMs <= Date.now())) throw new Error(REFUSED);
  const next = tail.then(async () => {
    if (options.deadlineAtMs !== undefined && options.deadlineAtMs <= Date.now()) throw new Error(REFUSED);
    const pending = pool.connect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let acquired = false;
    let client: PoolClient;
    try {
      client = options.deadlineAtMs === undefined ? await pending : await Promise.race([
        pending.then(value => { acquired = true; return value; }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(REFUSED)), Math.max(0, options.deadlineAtMs! - Date.now())); }),
      ]);
      acquired = true;
    } catch (error) {
      if (!acquired) void pending.then(value => value.release(true), () => {});
      throw error;
    } finally { if (timer) clearTimeout(timer); }
    if (options.deadlineAtMs !== undefined && options.deadlineAtMs <= Date.now()) { client.release(true); throw new Error(REFUSED); }
    let locked = false;
    let destroy = false;
    const owner: NamespaceOwner = { pool, client, active: false };
    try {
      if (options.deadlineAtMs === undefined) {
        try {
          await client.query('SELECT pg_advisory_lock($1,$2)', [GATE, KEY]);
          locked = true;
        } catch (error) {
          // The server may have acquired the lock even when its acknowledgement was lost.
          destroy = true;
          throw error;
        }
      } else {
        while (options.deadlineAtMs > Date.now()) {
          const remaining = Math.max(1, Math.min(500, options.deadlineAtMs - Date.now()));
          let result: { rows: { acquired: boolean }[] };
          try {
            const queryWithTimeout = client.query.bind(client) as unknown as (config: { text: string; values: number[]; query_timeout: number }) => Promise<{ rows: { acquired: boolean }[] }>;
            result = await queryWithTimeout({ text: 'SELECT pg_try_advisory_lock($1,$2) AS acquired', values: [GATE, KEY], query_timeout: remaining });
          } catch (error) {
            // A timeout or lost response after acquisition leaves lock ownership unknown.
            destroy = true;
            throw error;
          }
          if (result.rows[0]?.acquired === true) { locked = true; break; }
          await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(1, options.deadlineAtMs! - Date.now()))));
        }
        if (!locked || options.deadlineAtMs <= Date.now()) throw new Error(REFUSED);
      }
      owner.active = true;
      return await scope.run(owner, () => work(client));
    } finally {
      // AsyncLocalStorage descendants may keep this object after the callback returns. Revoke
      // its authority before unlocking or returning the client to the pool.
      owner.active = false;
      if (locked) {
        try {
          const timeout = options.deadlineAtMs === undefined ? undefined : Math.max(1, Math.min(250, options.deadlineAtMs - Date.now()));
          const result = timeout === undefined
            ? await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock($1,$2) AS unlocked', [GATE, KEY])
            : await (client.query.bind(client) as unknown as (config: { text: string; values: number[]; query_timeout: number }) => Promise<{ rows: { unlocked: boolean }[] }>)(
              { text: 'SELECT pg_advisory_unlock($1,$2) AS unlocked', values: [GATE, KEY], query_timeout: timeout });
          if (result.rows[0]?.unlocked !== true) destroy = true;
        } catch { destroy = true; }
      }
      client.release(destroy);
    }
  });
  tail = next.catch(() => {});
  return next;
}
