import {afterEach, describe, expect, it, vi} from 'vitest';
import {boardApproval, clearBoardCache, setBoardDeps, type BoardDeps} from '../src/board-approval.js';

const database = vi.hoisted(() => ({query: vi.fn()}));
vi.mock('../src/db.js', () => ({getPool: () => database}));

const incarnation = '11111111-1111-4111-8111-111111111111';
function managed(name: string) {
  vi.stubEnv('LARES_AGENT_NAME', name);
  vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
  vi.stubEnv('LARES_SLACK_PRINCIPAL', 'U_OWNER');
  vi.stubEnv('LARES_SLACK_CLAIM_REVISION', 'revision-one');
  database.query.mockImplementation(async (sql: string) => ({rows: sql.includes('agent_door_connections')
    ? [{kind: 'slack', principal: 'U_OWNER', revision: 'revision-one', applied_revision: 'revision-one'}]
    : [{}]}));
}
function template(name: string) {
  return {name, model: 'installation-brain', persona: 'agent/instructions.md',
    grants: [{capability: 'vault', scope: 'write-with-confirm', areas: ['shared']}], autonomy: {vault: 'gated'}};
}
afterEach(() => {vi.unstubAllEnvs(); vi.clearAllMocks(); clearBoardCache(); setBoardDeps(null);});

describe('neutral runtime permissions use the managed instance identity', () => {
  it.each(['chief-of-staff', 'travel', 'creative'])('honors the instance denial and audit identity for %s', async role => {
    managed('office-assistant');
    const read = vi.fn(async (agent: string) => agent === 'office-assistant' ? 'never' as const : 'autonomous' as const);
    const record = vi.fn(async () => {});
    setBoardDeps({explicitLevel: read, record, now: Date.now});
    expect(await boardApproval(template(role), 'vault_write')({callId: 'owned-call'})).toEqual({
      type: 'denied', reason: 'vault is switched off for office-assistant on the permissions board',
    });
    // W5C — the bare `vault_write` is the SHARED area, and the area is the ratchet action.
    expect(read).toHaveBeenCalledWith('office-assistant', 'vault', 'shared');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({agent: 'office-assistant', decision: 'denied', callId: 'owned-call'}));
  });

  it('does not share a cached board level between two instances of the same neutral image', async () => {
    managed('office-one');
    const explicitLevel: BoardDeps['explicitLevel'] = async agent => agent === 'office-one' ? 'never' : 'gated';
    setBoardDeps({explicitLevel, record: async () => {}, now: () => 0});
    const approval = boardApproval(template('chief-of-staff'), 'vault_write');
    expect(await approval()).toMatchObject({type: 'denied'});
    managed('office-two');
    expect(await approval()).toBe('user-approval');
  });

  it('records unknown-tool refusals under the managed instance too', async () => {
    managed('office-assistant');
    const record = vi.fn(async () => {});
    setBoardDeps({explicitLevel: async () => null, record, now: Date.now});
    expect(await boardApproval(template('chief-of-staff'), 'missing-tool')()).toBe('user-approval');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({agent: 'office-assistant', decision: 'failed-closed'}));
  });

  it('refuses invalid managed identity without falling back to the template board', async () => {
    managed('INVALID NAME');
    const read = vi.fn(async () => 'autonomous' as const);
    setBoardDeps({explicitLevel: read, record: async () => {}, now: Date.now});
    expect(await boardApproval(template('chief-of-staff'), 'vault_write')()).toMatchObject({type: 'denied'});
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses unavailable managed authority before consulting permissions', async () => {
    managed('office-assistant');
    database.query.mockResolvedValue({rows: []});
    const read = vi.fn(async () => 'autonomous' as const);
    setBoardDeps({explicitLevel: read, record: async () => {}, now: Date.now});
    expect(await boardApproval(template('chief-of-staff'), 'vault_write')()).toMatchObject({type: 'denied'});
    expect(read).not.toHaveBeenCalled();
  });
});
