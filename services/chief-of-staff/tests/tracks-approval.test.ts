import { describe, expect, it, vi } from 'vitest';
import { TwentyTracksHome } from '../lib/twenty-tracks.js';
import { twentyTracksApprovalAdapter } from '../lib/tracks-approval.js';
import { runApprovedTwentyTrackOnce } from '../lib/approvals.js';

const context = { session: { turn: { id: 'turn-1', sequence: 1 } } } as never;
const track = { id: 'sales', name: 'Sales', purpose: 'Qualified work', steps: ['Open', 'Qualified', 'Won'], closingSteps: ['Won'] };

describe('exact Twenty Tracks approval binding', () => {
  it('rejects a Vault home and refuses a step removed from current metadata', async () => {
    vi.spyOn(TwentyTracksHome.prototype, 'listTracks').mockResolvedValue([track]);
    await expect(twentyTracksApprovalAdapter.readTarget({} as never, {
      home: 'vault:shared-area', trackId: 'sales', who: { personId: 'person-1' }, step: 'Open', note: 'n', sourceSignal: 's',
    }, 'member-1', 'track_add_item', context)).rejects.toThrow('Exact Twenty track target is unavailable');
    await expect(twentyTracksApprovalAdapter.readTarget({} as never, {
      home: 'twenty', trackId: 'sales', who: { personId: 'person-1' }, step: 'Stale', note: 'n', sourceSignal: 's',
    }, 'member-1', 'track_add_item', context)).rejects.toThrow('Exact Twenty track target is unavailable');
  });

  it('binds exact input and current metadata so changed payload or stale track data cannot reuse approval', async () => {
    const listTracks = vi.spyOn(TwentyTracksHome.prototype, 'listTracks').mockResolvedValue([track]);
    const input = { home: 'twenty', trackId: 'sales', who: { personId: 'person-1' }, step: 'Open', note: 'n', sourceSignal: 's' };
    const original = await twentyTracksApprovalAdapter.readTarget({} as never, input, 'member-1', 'track_add_item', context);
    const changedPayload = await twentyTracksApprovalAdapter.readTarget({} as never, { ...input, step: 'Qualified' }, 'member-1', 'track_add_item', context);
    expect(changedPayload.fingerprint).not.toBe(original.fingerprint);
    listTracks.mockResolvedValue([{ ...track, purpose: 'Different current purpose' }]);
    const changedMetadata = await twentyTracksApprovalAdapter.readTarget({} as never, input, 'member-1', 'track_add_item', context);
    expect(changedMetadata.fingerprint).not.toBe(original.fingerprint);
    await expect(twentyTracksApprovalAdapter.readTarget({} as never, input, 'member-1', 'track_add_item', context, original))
      .rejects.toThrow('Exact Twenty track target changed');
  });

  it('binds an existing item to its exact home, track and current item metadata', async () => {
    vi.spyOn(TwentyTracksHome.prototype, 'listTracks').mockResolvedValue([track]);
    vi.spyOn(TwentyTracksHome.prototype, 'listItems').mockResolvedValue([{
      id: 'item-1', trackId: 'sales', who: { personId: 'person-1' }, step: 'Open', since: '2026-10-26', note: 'background', sourceSignal: 's',
    }]);
    const input = { home: 'twenty', trackId: 'sales', itemId: 'item-1', step: 'Qualified', note: 'n', sourceSignal: 's' };
    const target = await twentyTracksApprovalAdapter.readTarget({} as never, input, 'member-1', 'track_move_item', context);
    expect(target.id).toBe('twenty:sales:item-1');
    await expect(twentyTracksApprovalAdapter.readTarget({} as never, { ...input, trackId: 'other' }, 'member-1', 'track_move_item', context, target))
      .rejects.toThrow('Exact Twenty track target is unavailable');
  });

  it('accepts current provider track IDs with uppercase and underscore characters', async () => {
    const current = { ...track, id: 'Legacy_Sales_2024' };
    vi.spyOn(TwentyTracksHome.prototype, 'listTracks').mockResolvedValue([current]);
    const input = { home: 'twenty', trackId: current.id, who: { personId: 'person-1' }, step: 'Open', note: 'n', sourceSignal: 's' };
    const target = await twentyTracksApprovalAdapter.readTarget({} as never, input, 'member-1', 'track_add_item', context);
    expect(target.id).toBe('twenty:Legacy_Sales_2024');
  });

  it('claims an exact Twenty approval once before calling the provider, even under replay races', async () => {
    let used = false, writes = 0;
    const db = { async query(sql: string, values: unknown[]) {
      expect(sql).toContain("used_at IS NULL");
      expect(values).toEqual(['request-1', 'call-1', 'track_add_item', 'hash-1', 'member-1', 'session-1', 'chief-of-staff']);
      if (used) return { rows: [] };
      used = true;
      return { rows: [{ request_id: 'request-1' }] };
    } } as never;
    const approved = { callId: 'call-1', toolName: 'track_add_item', payloadHash: 'hash-1',
      authority: { origin: 'approval-resume', requestId: 'request-1', actingMemberId: 'member-1', sessionId: 'session-1', agentId: 'chief-of-staff' } } as never;
    const run = () => runApprovedTwentyTrackOnce(approved, async () => { writes += 1; return 'sent'; }, db);
    const results = await Promise.allSettled([run(), run()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(writes).toBe(1);
    await expect(run()).rejects.toThrow('already used');
    expect(writes).toBe(1);
  });

  it('refuses a sequential reuse of a previously claimed approval before another provider call', async () => {
    let used = false, writes = 0;
    const db = { async query() { if (used) return { rows: [] }; used = true; return { rows: [{ request_id: 'request-1' }] }; } } as never;
    const approved = { callId: 'call-1', toolName: 'track_move_item', payloadHash: 'hash-1',
      authority: { origin: 'approval-resume', requestId: 'request-1', actingMemberId: 'member-1', sessionId: 'session-1', agentId: 'chief-of-staff' } } as never;
    const run = () => runApprovedTwentyTrackOnce(approved, async () => { writes += 1; return 'sent'; }, db);
    await expect(run()).resolves.toBe('sent');
    await expect(run()).rejects.toThrow('already used');
    expect(writes).toBe(1);
  });
});
