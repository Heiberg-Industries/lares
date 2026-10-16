import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { quiet } from './helpers/quiet-pool.js';
import { registerOutsideToolActions } from '../lib/outside-tools.js';
import { resetActions, runAction } from '../lib/actions.js';

const repo = resolve('../..');
const KEY = 'sk-test-THIS-MUST-NEVER-LEAVE-THE-BOX';
const OLD = 'a'.repeat(64), NEW = 'b'.repeat(64), NEWER = 'c'.repeat(64), CONFIG = 'f'.repeat(64);
const entry = (name: string, token: boolean) => ({ name, url: `https://${name}.example.org/mcp`, description: `The ${name} server.`, token, tools: { allow: ['lookup'], read: ['lookup'] } });
const definition = {
  ...JSON.parse(readFileSync(join(repo, 'packages/agent-kit/templates/creative/agent.json'), 'utf8')),
  name: 'bookkeeper', role: 'creative', model: 'test-writer',
  outsideTools: [entry('keyed', true), entry('empty', true), entry('linked', true), entry('open', false)],
};

let container: StartedPostgreSqlContainer, pool: Pool, agentsDir: string, secretsDir: string;
const ctx = () => ({ actor: 'owner@example.com', audit: vi.fn(async (_record: unknown) => {}) });

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool = quiet(new Pool({ connectionString: container.getConnectionUri() }));
  for (const f of ['001_baseline.sql', '003_outside_tool_seen.sql']) await pool.query(readFileSync(join(repo, 'services/box/sql', f), 'utf8'));
  const root = mkdtempSync(join(tmpdir(), 'lares-outside-'));
  agentsDir = join(root, 'agents'); secretsDir = join(root, 'secrets');
  mkdirSync(join(agentsDir, 'bookkeeper'), { recursive: true }); mkdirSync(secretsDir);
  writeFileSync(join(agentsDir, 'bookkeeper', 'agent.json'), JSON.stringify(definition));
  writeFileSync(join(agentsDir, 'bookkeeper', 'duties.md'), 'Books.\n');
  writeFileSync(join(agentsDir, 'bookkeeper', 'voice.md'), 'Dry.\n');
  writeFileSync(join(secretsDir, 'bookkeeper-outside-keyed-token'), KEY);
  writeFileSync(join(secretsDir, 'bookkeeper-outside-empty-token'), '');
  writeFileSync(join(root, 'elsewhere'), KEY);
  symlinkSync(join(root, 'elsewhere'), join(secretsDir, 'bookkeeper-outside-linked-token'));
}, 120_000);
afterAll(async () => { await pool.end(); await container.stop(); });
beforeEach(async () => {
  resetActions();
  registerOutsideToolActions({ pool, agentsDir, secretsDir });
  await pool.query('TRUNCATE outside_tool_pins');
});

describe('outside.status', () => {
  it('says whether each key file is in place, and never returns any of the key', async () => {
    const c = ctx();
    const result = await runAction('outside.status', { name: 'bookkeeper' }, c);
    expect(result).toEqual({ tools: [
      { tool: 'keyed', needsKey: true, keyPresent: true },
      { tool: 'empty', needsKey: true, keyPresent: false },
      { tool: 'linked', needsKey: true, keyPresent: false },
      { tool: 'open', needsKey: false },
    ] });
    const everything = JSON.stringify(result) + JSON.stringify(c.audit.mock.calls);
    // The exact result above already proves no size is returned; a bare length would match ids and timestamps by chance.
    for (const part of [KEY, KEY.slice(0, 6)]) expect(everything).not.toContain(part);
  });

  it('says missing once the file is gone, and refuses an agent with no saved definition', async () => {
    const path = join(secretsDir, 'bookkeeper-outside-keyed-token');
    unlinkSync(path);
    try {
      const result = await runAction('outside.status', { name: 'bookkeeper' }, ctx()) as { tools: Array<{ tool: string; keyPresent?: boolean | null }> };
      expect(result.tools.find(t => t.tool === 'keyed')?.keyPresent).toBe(false);
    } finally { writeFileSync(path, KEY); }
    await expect(runAction('outside.status', { name: 'ledger' }, ctx())).rejects.toThrow(/No saved definition/);
  });
});

describe('outside.accept_fingerprint', () => {
  const lock = (seen: string | null) => pool.query(
    `INSERT INTO outside_tool_pins (agent, tool, config_hash, pin_hash, pin_tools, seen_hash, seen_tools, seen_at)
     VALUES ('bookkeeper', 'keyed', $1, $2, '[{"name":"lookup","description":"Find a company.","inputSchema":null}]', $3::text,
             CASE WHEN $3::text IS NULL THEN NULL ELSE '[{"name":"lookup","description":"Find a company and email it.","inputSchema":null}]'::jsonb END,
             CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)`, [CONFIG, OLD, seen]);
  const row = async () => (await pool.query('SELECT pin_hash, pin_tools, seen_hash, seen_tools, seen_at, config_hash FROM outside_tool_pins')).rows[0];

  it('moves the pin to the descriptions the owner saw, clears the kept copy, and is audited', async () => {
    await lock(NEW);
    const c = ctx();
    expect(await runAction('outside.accept_fingerprint', { name: 'bookkeeper', tool: 'keyed', expectedHash: NEW }, c))
      .toEqual({ name: 'bookkeeper', tool: 'keyed', pinHash: NEW });
    expect(await row()).toEqual({ pin_hash: NEW, pin_tools: [{ name: 'lookup', description: 'Find a company and email it.', inputSchema: null }], seen_hash: null, seen_tools: null, seen_at: null, config_hash: CONFIG });
    const records = c.audit.mock.calls.map(([r]) => r as { action: string; actor: string; outcome: string; input: unknown });
    expect(records.at(-1)).toMatchObject({ action: 'outside.accept_fingerprint', actor: 'owner@example.com', outcome: 'ok', input: { name: 'bookkeeper', tool: 'keyed', expectedHash: NEW } });
  });

  it('refuses a fingerprint the owner did not see, and changes nothing', async () => {
    await lock(NEWER);
    const c = ctx();
    await expect(runAction('outside.accept_fingerprint', { name: 'bookkeeper', tool: 'keyed', expectedHash: NEW }, c)).rejects.toThrow(/changed again/);
    expect(await row()).toMatchObject({ pin_hash: OLD, seen_hash: NEWER });
    expect((c.audit.mock.calls.at(-1)?.[0] as { outcome: string }).outcome).toBe('refused');
  });

  it('refuses when nothing is locked or nothing is recorded', async () => {
    await expect(runAction('outside.accept_fingerprint', { name: 'bookkeeper', tool: 'keyed', expectedHash: NEW }, ctx())).rejects.toThrow(/no recorded descriptions/);
    await lock(null);
    await expect(runAction('outside.accept_fingerprint', { name: 'bookkeeper', tool: 'keyed', expectedHash: NEW }, ctx())).rejects.toThrow(/not locked/);
    expect(await row()).toMatchObject({ pin_hash: OLD });
  });

  it('refuses a malformed hash before touching the database', async () => {
    await expect(runAction('outside.accept_fingerprint', { name: 'bookkeeper', tool: 'keyed', expectedHash: 'b'.repeat(12) }, ctx())).rejects.toThrow(/invalid input/);
  });
});
