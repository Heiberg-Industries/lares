import { payloadFingerprint } from '@lares/agent-kit/approval-ledger';
import type { ExactApprovalAdapter, ExactApprovalTarget } from '@lares/agent-kit/approval-execution';
import type { AuthorityDatabase } from '@lares/agent-kit/console-turn-authority';
import { autonomyOf, canWriteVaultArea, grantFor, scopeAtLeast } from '@lares/agent-kit/manifest';
import { parseDefinition } from '@lares/agent-kit/definition';
import { tracksHome } from './tracks.js';
import { TwentyTracksHome } from './twenty-tracks.js';
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
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const neutralWrite = tool === 'track_add_item' || tool === 'track_move_item';
    const suppliedHome = neutralWrite ? raw.home : undefined;
    if (neutralWrite && (typeof suppliedHome !== 'string' || !/^vault:[A-Za-z0-9_-]{1,128}$/.test(suppliedHome) ||
        typeof raw.trackId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(raw.trackId)))
      throw new Error('Exact Tracks home or track is unavailable');
    const home = tracksHome(ctx as never, typeof suppliedHome === 'string' ? suppliedHome : undefined);
    const path = tool === 'track_move_item'
      ? (reservedTarget?.id ?? await home?.findItemPath(String((input as {itemId?:unknown}).itemId)))
      : trackPathFor(input);
    if (neutralWrite && (tool === 'track_add_item'
      ? path !== `tracks/${String(raw.trackId)}/track.md`
      : path !== `tracks/${String(raw.trackId)}/items/${String(raw.itemId)}.md`))
      throw new Error('Exact Tracks target does not match the supplied track');
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

/** Exact private-Console authorization for the neutral tools' Twenty home. Vault retains its
 *  existing adapter and Keeper writer; this adapter only fingerprints current Twenty metadata. */
export const twentyTracksApprovalAdapter: ExactApprovalAdapter = {
  toolNames: ['track_add_item','track_move_item'],
  async readPolicyHash(db: AuthorityDatabase, agent: string, incarnation: string) {
    const { rows } = await db.query(`SELECT r.applied_definition,a.hash FROM agent_resources r JOIN agent_definitions a ON a.name=r.name
      WHERE r.name=$1 AND r.ownership_token=$2::uuid AND r.runtime_control_token=r.ownership_token AND r.state='ready'
      AND NOT r.pending AND a.status='valid' AND r.applied_definition IS NOT NULL FOR SHARE OF r,a`, [agent, incarnation]);
    if (rows.length !== 1) throw new Error('Exact Twenty track policy is unavailable');
    const definition = parseDefinition(rows[0].applied_definition), grant = grantFor(definition, 'twenty');
    if (!scopeAtLeast(grant?.scope ?? 'none', 'write-with-confirm') || autonomyOf(definition, 'twenty') === 'never')
      throw new Error('Exact Twenty track policy is unavailable');
    const { rows: board } = await db.query("SELECT level,updated_at::text AS updated_at FROM ratchet WHERE agent=$1 AND capability='twenty' AND action='' FOR SHARE", [agent]);
    const level = board[0]?.level ?? autonomyOf(definition, 'twenty');
    if (level === 'never' || !['gated','autonomous'].includes(level)) throw new Error('Exact Twenty track policy is unavailable');
    return payloadFingerprint('tracks-twenty-write-policy-v1', { definition, hash: rows[0].hash, board: board[0] ?? null, level });
  },
  async readTarget(_db, input, memberId, tool, ctx, reservedTarget) {
    if ((tool !== 'track_add_item' && tool !== 'track_move_item') || !input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Exact Twenty track target is unavailable');
    const raw = input as Record<string, unknown>;
    if (raw.home !== 'twenty' || typeof raw.trackId !== 'string' || raw.trackId.length < 1 || raw.trackId.length > 128)
      throw new Error('Exact Twenty track target is unavailable');
    const home = new TwentyTracksHome(), track = (await home.listTracks()).find((candidate) => candidate.id === raw.trackId);
    if (!track) throw new Error('Exact Twenty track target is unavailable');
    let id: string, targetData: unknown;
    if (tool === 'track_add_item') {
      const who = raw.who && typeof raw.who === 'object' && !Array.isArray(raw.who) ? raw.who as Record<string, unknown> : undefined;
      if (!who || (typeof who.personId !== 'string' && typeof who.organisationId !== 'string') ||
          typeof raw.step !== 'string' || !track.steps.includes(raw.step)) throw new Error('Exact Twenty track target is unavailable');
      id = `twenty:${raw.trackId}`;
      targetData = { track, who, step: raw.step };
    } else {
      if (typeof raw.itemId !== 'string' || typeof raw.step !== 'string' || !track.steps.includes(raw.step))
        throw new Error('Exact Twenty item target is unavailable');
      const item = (await home.listItems(track.id)).find((candidate) => candidate.id === raw.itemId);
      if (!item || item.trackId !== raw.trackId) throw new Error('Exact Twenty item target is unavailable');
      id = `twenty:${raw.trackId}:${raw.itemId}`;
      targetData = { track, item, step: raw.step };
    }
    if (reservedTarget && (reservedTarget.id !== id || reservedTarget.ownerMemberId !== memberId))
      throw new Error('Exact Twenty track target changed');
    const turnKey = turnKeyFrom(ctx), originalTurnOrigin = (turnKey ? stampFor('agent', turnKey) : 'third_party') as 'agent'|'synced'|'third_party';
    const target: ExactApprovalTarget = { kind: tool === 'track_move_item' ? 'track-item' : 'track', id, ownerMemberId: memberId,
      fingerprint: payloadFingerprint('tracks-twenty-target-v1', { tool, input, targetData }), approvedOrigin: originalTurnOrigin };
    if (reservedTarget && payloadFingerprint('authority', target) !== payloadFingerprint('authority', reservedTarget))
      throw new Error('Exact Twenty track target changed');
    return target;
  },
};
