import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fchownSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';
import { KeeperRefusedError, registerAction } from './actions.js';

/** An agent's own model-provider key, for the gateway to pay with instead of the installation's.
 *  The key lives only as a root-only file named by a revision id (the same file custody the credential
 *  files use); the database holds the id, never the key. Nothing here is reachable from a container. */
export const PROVIDER_KEY_DIRECTORY = 'gateway-provider-keys';
/** A removed or replaced key file outlives its row by this long, so a call admitted a moment earlier still finds it. */
export const PROVIDER_KEY_GRACE_MS = 30_000;
const REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9-]{1,30}$/;

/** One line, 1 to 4096 bytes, printable ASCII with no whitespace: the installer's rule for the model key, kept to the
 *  characters an HTTP header can carry, so what is written here is exactly what the gateway reads back. */
export const providerKeyValue = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);

export class ProviderKeyFiles {
  readonly directory: string;
  constructor(secretsDir: string, private ownership = { uid: 0, gid: 0 }, private graceMs = PROVIDER_KEY_GRACE_MS) {
    this.directory = join(secretsDir, PROVIDER_KEY_DIRECTORY);
  }
  private path(revision: string, partial = false): string {
    if (!REVISION.test(revision)) throw new Error('Provider key revision invalid');
    return join(this.directory, partial ? `.candidate-${revision}` : revision);
  }
  /** Created root-only when absent. A link, another owner or looser modes are refused, never repaired. */
  private verifyDirectory(): void {
    try { mkdirSync(this.directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const st = lstatSync(this.directory);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== this.ownership.uid || (st.mode & 0o777) !== 0o700) throw new Error('Provider key storage unavailable');
  }
  private syncDirectory(): void {
    const fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  /** A root-only 0600 candidate first, then one rename to the 0400 file the gateway reads. Never overwrites. */
  publish(revision: string, key: string): void {
    this.verifyDirectory();
    const target = this.path(revision), temp = this.path(revision, true);
    try { lstatSync(target); throw new Error('Provider key file already exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      fchownSync(fd, this.ownership.uid, this.ownership.gid);
      fchmodSync(fd, 0o600);
      writeFileSync(fd, key + '\n');
      fsyncSync(fd);
      fchmodSync(fd, 0o400);
    } finally { closeSync(fd); }
    renameSync(temp, target);
    this.syncDirectory();
  }
  /** Removes one key file (or its unfinished candidate). Anything that is not a keeper-owned single-link file is left and refused. */
  remove(revision: string): void {
    this.verifyDirectory();
    for (const path of [this.path(revision), this.path(revision, true)]) {
      let st;
      try { st = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== this.ownership.uid) throw new Error('Provider key file unavailable');
      unlinkSync(path);
    }
    this.syncDirectory();
  }
  /** After the grace period; a failure leaves an inert file that the next sweep removes. */
  removeLater(revision: string): void {
    const timer = setTimeout(() => { try { this.remove(revision); } catch { /* inert; swept later */ } }, this.graceMs);
    timer.unref();
  }
  /** Removes files no row names any more, once they are older than the grace period. */
  sweep(keep: ReadonlySet<string>): void {
    this.verifyDirectory();
    for (const name of readdirSync(this.directory)) {
      const revision = name.startsWith('.candidate-') ? name.slice('.candidate-'.length) : name;
      if (!REVISION.test(revision) || (!name.startsWith('.') && keep.has(revision))) continue;
      try {
        if (Date.now() - lstatSync(join(this.directory, name)).mtimeMs >= this.graceMs) this.remove(revision);
      } catch { /* left for host inspection */ }
    }
  }
}

const nameInput = z.string().regex(NAME);

/** Host-only: the owner sets or removes an agent's key from the host command. */
export function registerProviderKeyActions(options: { pool: Pool; files: ProviderKeyFiles }): void {
  const { pool, files } = options;
  const keep = async () => new Set<string>((await pool.query('SELECT revision FROM agent_provider_keys')).rows.map(row => String(row.revision)));
  void keep().then(revisions => files.sweep(revisions)).catch(() => undefined);
  registerAction({
    name: 'provider-key.set', hostOnly: true, input: z.strictObject({ name: nameInput, key: providerKeyValue }), secretFields: ['key'],
    run: async ({ name, key }) => {
      const agent = (await pool.query('SELECT status FROM agent_definitions WHERE name=$1', [name])).rows[0];
      if (!agent || agent.status === 'retired') throw new KeeperRefusedError('There is no such agent.');
      const revision = randomUUID();
      files.publish(revision, key);
      const db = await pool.connect();
      let previous: string | undefined;
      try {
        await db.query('BEGIN');
        previous = (await db.query('SELECT revision FROM agent_provider_keys WHERE agent=$1 FOR UPDATE', [name])).rows[0]?.revision;
        await db.query(`INSERT INTO agent_provider_keys(agent,revision,state,set_by) VALUES($1,$2,'active','host')
          ON CONFLICT(agent) DO UPDATE SET revision=EXCLUDED.revision,state='active',set_at=clock_timestamp(),set_by='host',tested_at=NULL,test_outcome=NULL`, [name, revision]);
        await db.query('COMMIT');
      } catch {
        try { await db.query('ROLLBACK'); } catch { /* the connection is discarded below */ }
        try { files.remove(revision); } catch { /* an unreferenced file is inert; the sweep removes it */ }
        throw new KeeperRefusedError('The key could not be saved. Nothing was changed.');
      } finally { db.release(); }
      if (previous) files.removeLater(previous);
      return { name, revision, replaced: previous !== undefined };
    },
    successDetail: result => `provider key set (revision ${result.revision})`,
  });
  registerAction({
    name: 'provider-key.remove', hostOnly: true, input: z.strictObject({ name: nameInput }),
    run: async ({ name }) => {
      const db = await pool.connect();
      let revision: string | undefined;
      try {
        await db.query('BEGIN');
        revision = (await db.query('DELETE FROM agent_provider_keys WHERE agent=$1 RETURNING revision', [name])).rows[0]?.revision;
        await db.query('COMMIT');
      } catch {
        try { await db.query('ROLLBACK'); } catch { /* discarded below */ }
        throw new KeeperRefusedError('The key could not be removed. Nothing was changed.');
      } finally { db.release(); }
      if (revision) files.removeLater(revision);
      return { name, removed: revision !== undefined, revision: revision ?? null };
    },
    successDetail: result => result.removed ? `provider key removed (revision ${result.revision})` : 'no provider key was set',
  });
}
