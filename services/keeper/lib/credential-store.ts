import type { Pool, PoolClient } from 'pg';
import { KeeperRefusedError } from './actions.js';
import { CREDENTIAL_SLOT, credentialRecordSchema, initialCredentialRecord, type CredentialRecord } from './credential-state.js';

export interface CredentialJournal {
  read(): Promise<CredentialRecord>;
  /** Separately committed intent; version is checked even while the slot lock is held. */
  save(previous: CredentialRecord, next: CredentialRecord): Promise<CredentialRecord>;
}
export interface CredentialStore {
  read(): Promise<CredentialRecord>;
  locked<T>(work: (journal: CredentialJournal) => Promise<T>): Promise<T>;
}
function journal(client: Pick<PoolClient, 'query'>): CredentialJournal {
  return {
    async read() {
      const { rows } = await client.query('SELECT record FROM keeper_credentials WHERE slot=$1', [CREDENTIAL_SLOT]);
      return rows.length ? credentialRecordSchema.parse(rows[0].record) : initialCredentialRecord();
    },
    async save(previous, next) {
      const record = credentialRecordSchema.parse({ ...next, version: previous.version + 1 });
      const result = previous.version === 0
        ? await client.query('INSERT INTO keeper_credentials(slot,version,record) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [CREDENTIAL_SLOT, record.version, record])
        : await client.query('UPDATE keeper_credentials SET version=$2,record=$3 WHERE slot=$1 AND version=$4', [CREDENTIAL_SLOT, record.version, record, previous.version]);
      if (result.rowCount !== 1) throw new KeeperRefusedError('Credential revision changed; refresh status');
      return record;
    },
  };
}
/** A session lock, NOT a long transaction: intent must survive process death before file work.
 * A contending request is refused, never queued for a surprising later execution.
 */
export class PgCredentialStore implements CredentialStore {
  constructor(private pool: Pool) {}
  read(): Promise<CredentialRecord> { return journal(this.pool).read(); }
  async locked<T>(work: (journal: CredentialJournal) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let acquired = false, broken = false;
    try {
      acquired = (await client.query("SELECT pg_try_advisory_lock(hashtextextended('lares-credential:' || $1,0)) AS acquired", [CREDENTIAL_SLOT])).rows[0]?.acquired === true;
      if (!acquired) throw new KeeperRefusedError('Credential operation in progress; inspect status');
      return await work(journal(client));
    } finally {
      if (acquired) {
        try { await client.query("SELECT pg_advisory_unlock(hashtextextended('lares-credential:' || $1,0))", [CREDENTIAL_SLOT]); }
        catch { broken = true; }
      }
      client.release(broken);
    }
  }
}
