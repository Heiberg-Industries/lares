import { beforeEach, describe, expect, it, vi } from 'vitest';
const query = vi.hoisted(() => vi.fn());
vi.mock('../lib/db', () => ({ pool: { query } }));
import { modelAliases, startingPoints, takesEffect, editedOutsideTheConsole } from '../lib/builder';

describe('builder read model', () => {
  beforeEach(() => query.mockReset());
  it('loads the three engine starting points and their schedules', () => {
    expect(startingPoints().map(s => s.id).sort()).toEqual(['chief-of-staff', 'creative', 'travel']);
    expect(startingPoints().find(s => s.id === 'chief-of-staff')!.schedules).toContain('morning-brief');
  });
  it('offers only configured purpose aliases', () => {
    expect(modelAliases('heiberg').map(a => a.alias)).toEqual(['heiberg-brain','heiberg-writer','heiberg-utility','heiberg-gate','heiberg-embed']);
    expect(modelAliases('lares', 'lares-brain').map(a => a.alias)).toEqual(['lares-brain']);
    expect(() => modelAliases('lares', 'other-brain')).toThrow(/does not match/);
    expect(() => modelAliases('')).toThrow(/prefix/);
    expect(() => modelAliases('installation')).toThrow(/prefix/);
  });
  it('shows the required timing copy', () => {
    expect(takesEffect('autonomy')).toBe('Takes effect at its next action.');
    expect(takesEffect('schedules')).toBe('Takes effect the next time it runs.');
    for (const field of ['duties','voice','model','grants','skills','language']) expect(takesEffect(field)).toBe('Takes effect at its next conversation. On a direct-message door a conversation lasts the day, so that usually means tomorrow — or start a fresh one now.');
  });
  it('does not flag a fingerprint matching successful keeper evidence', async () => {
    query.mockResolvedValue({rows: []});
    expect(await editedOutsideTheConsole('example')).toBeNull();
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("k.outcome = 'ok'");
    expect(sql).toContain('d.hash');
    expect(sql).toContain('k.detail');
    expect(sql).toContain('COALESCE(k.completed_at, k.at)');
    expect(sql).not.toContain("interval '2 minutes'");
    expect(params).toEqual(['example']);
  });
  it('shows an unmatched fingerprint without blocking it', async () => {
    query.mockResolvedValue({rows: [{valid_at:'2026-09-16T08:00:00Z'}]});
    expect(await editedOutsideTheConsole('example')).toEqual({at:'2026-09-16T08:00:00.000Z'});
  });
});
