import { payloadFingerprint } from '@lares/agent-kit/approval-ledger';
import type { ExactApprovalAdapter } from '@lares/agent-kit/approval-execution';
import type { AuthorityDatabase } from '@lares/agent-kit/console-turn-authority';
import { canWriteVaultArea } from '@lares/agent-kit/manifest';
import { parseDefinition } from '@lares/agent-kit/definition';
import { tracksHome } from './tracks.js';
import { stampFor, turnKeyFrom } from '@lares/agent-kit/origin-taint';

const TRACK_TOOLS = ['track_add_item','track_move_item','track_create','track_set_steps'] as const;
function trackPathFor(input: unknown): string {
  const i = input as Record<string, unknown>;
  if (typeof i.trackId === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(i.trackId)) {
    if (typeof i.trackId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(i.trackId)) throw new Error('Exact Tracks target is unavailable');
    return `tracks/${i.trackId}/track.md`;
  }
  throw new Error('Exact Tracks target is unavailable');
}

/** Exact-call adapter for local Tracks changes; target bytes are rechecked by Keeper at write. */
export const tracksApprovalAdapter: ExactApprovalAdapter = {
  toolNames: TRACK_TOOLS,
  async readPolicyHash(db: AuthorityDatabase, agent: string, incarnation: string) {
    const { rows } = await db.query(`SELECT r.applied_definition,a.hash FROM agent_resources r JOIN agent_definitions a ON a.name=r.name
      WHERE r.name=$1 AND r.ownership_token=$2::uuid AND r.runtime_control_token=r.ownership_token AND r.state='ready'
      AND NOT r.pending AND a.status='valid' AND r.applied_definition IS NOT NULL FOR SHARE OF r,a`, [agent, incarnation]);
    if (rows.length !== 1) throw new Error('Exact Tracks policy is unavailable');
    const definition = parseDefinition(rows[0].applied_definition);
    if (!canWriteVaultArea(definition, 'shared')) throw new Error('Exact Tracks policy is unavailable');
    return payloadFingerprint('tracks-write-policy-v1', { definition, hash: rows[0].hash });
  },
  async readTarget(db, input, memberId, tool, ctx, reservedTarget) {
    if (!tool || !TRACK_TOOLS.includes(tool as typeof TRACK_TOOLS[number])) throw new Error('Exact Tracks target is unavailable');
    const home = reservedTarget ? undefined : tracksHome(ctx as never);
    const path = tool === 'track_move_item'
      ? (reservedTarget?.id ?? await home?.findItemPath(String((input as {itemId?:unknown}).itemId)))
      : trackPathFor(input);
    if (typeof path !== 'string' || (tool === 'track_move_item' && !/^tracks\/[a-z0-9][a-z0-9-]{0,62}\/items\/[a-z0-9][a-z0-9-]{0,62}\.md$/.test(path)))
      throw new Error('Exact Tracks target is unavailable');
    if (reservedTarget) {
      if (reservedTarget.id !== path || reservedTarget.ownerMemberId !== memberId) throw new Error('Exact Tracks target changed');
      return reservedTarget;
    }
    const file = await home!.readTarget(path);
    const fingerprint = payloadFingerprint('tracks-vault-target-v1', file?.content ?? null);
    const turnKey = turnKeyFrom(ctx);
    const originalTurnOrigin = (turnKey ? stampFor('agent', turnKey) : 'third_party') as 'agent'|'synced'|'third_party';
    return { kind: tool === 'track_create' ? 'track-create' : tool === 'track_move_item' ? 'track-item' : 'track', id: path,
      ownerMemberId: memberId, fingerprint, approvedOrigin: originalTurnOrigin };
  },
};
