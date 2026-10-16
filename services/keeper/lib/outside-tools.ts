// The console's view of an agent's outside tools (ADR-0019): whether each one's key file is in
// place, and the owner's acceptance of new tool descriptions after a locked check.
//
// Key presence is read the way the definition check reads it (definitions.ts, `secretExists`): a
// regular, non-empty file that is not a link. The file is never opened, so nothing about the key —
// not its length, not a prefix — can reach the console.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';
import { loadDefinition, OUTSIDE_TOOL_NAME_RE } from '@lares/agent-kit/definition';
import { outsideSecretName } from '@lares/agent-kit/outside-tools';
import { KeeperRefusedError, registerAction } from './actions.js';
import { plainDirectory } from './definition-files.js';

const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

export interface OutsideToolKey {
  tool: string;
  needsKey: boolean;
  /** Only for a tool that needs a key. null: the keeper could not tell (never "missing" by guess). */
  keyPresent?: boolean | null;
}

/** true / false from the file's type and size only; null when the folder itself cannot be read. */
export function keyFilePresent(path: string): boolean | null {
  try {
    const s = lstatSync(path);
    return s.isFile() && !s.isSymbolicLink() && s.size > 0;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? false : null;
  }
}

export function registerOutsideToolActions(o: { pool: Pool; agentsDir: string; secretsDir: string }): void {
  registerAction({
    name: 'outside.status',
    input: z.strictObject({ name: z.string().regex(NAME_RE) }),
    run: async ({ name }): Promise<{ tools: OutsideToolKey[] }> => {
      const dir = join(o.agentsDir, name);
      try { plainDirectory(dir); } catch { throw new KeeperRefusedError('No saved definition for this agent'); }
      const { definition } = await loadDefinition({ serviceDir: 'unused', env: { LARES_DEFINITION_DIR: dir } });
      return {
        tools: (definition.outsideTools ?? []).map(t => t.token
          ? { tool: t.name, needsKey: true, keyPresent: keyFilePresent(join(o.secretsDir, outsideSecretName(name, t.name))) }
          : { tool: t.name, needsKey: false }),
      };
    },
  });

  // Accepts exactly the descriptions the owner was shown: the caller passes the fingerprint it
  // displayed, and the row must still hold that one as what the agent last saw. The pin moves to it
  // and the kept copy is cleared; the agent's next check then matches and closes the repair.
  registerAction({
    name: 'outside.accept_fingerprint',
    input: z.strictObject({ name: z.string().regex(NAME_RE), tool: z.string().regex(OUTSIDE_TOOL_NAME_RE), expectedHash: z.string().regex(HASH_RE) }),
    successDetail: (r: { tool: string; pinHash: string }) => JSON.stringify({ tool: r.tool, pinHash: r.pinHash }),
    run: async ({ name, tool, expectedHash }) => {
      const client = await o.pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<{ seen_hash: string | null }>(
          'SELECT seen_hash FROM outside_tool_pins WHERE agent = $1 AND tool = $2 FOR UPDATE', [name, tool]);
        const row = rows[0];
        if (!row) throw new KeeperRefusedError('This outside tool has no recorded descriptions yet');
        if (row.seen_hash === null) throw new KeeperRefusedError('This outside tool is not locked; there is nothing to accept');
        if (row.seen_hash !== expectedHash)
          throw new KeeperRefusedError('The tool descriptions changed again since this page was loaded. Reload and review them before accepting');
        await client.query(
          `UPDATE outside_tool_pins SET pin_hash = seen_hash, pin_tools = seen_tools, seen_hash = NULL, seen_tools = NULL, seen_at = NULL, pinned_at = now()
           WHERE agent = $1 AND tool = $2`, [name, tool]);
        await client.query('COMMIT');
        return { name, tool, pinHash: expectedHash };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  });
}
