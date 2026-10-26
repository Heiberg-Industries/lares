import { VaultTracksHome, type TrackFileWriter } from '@lares/agent-kit/tracks';
import { consoleAdmission } from '@lares/agent-kit/console-turn-authority';
import { managedIdentity } from '@lares/agent-kit/door-authority';
import { vaultBrokerRequest } from '@lares/agent-kit/vault-broker-client';
import { vaultTurnCapability } from '../agent/lib/vault-turn.js';
import type { ApprovedExecution } from '@lares/agent-kit/approval-execution';
import { taintTurn, turnKeyFrom } from '@lares/agent-kit/origin-taint';

type TrackContext = { session?: { id?: string; turn?: { id?: string; sequence?: number }; auth?: { current?: unknown; initiator?: unknown } | null } };

/** Mark a turn from Vault's persisted provenance, never from model-supplied fields. */
export function markTrackOrigin(ctx: TrackContext, content: string): void {
  const key = turnKeyFrom(ctx);
  if (!key) return;
  const found = /^lares_origin:\s*(owner|agent|synced|system|third_party)\s*$/m.exec(content)?.[1];
  const origin = found === 'synced' || found === 'third_party' ? found : undefined;
  if (origin) taintTurn(key, origin);
}

/** The home is bound to this exact private-console turn. Keeper still rechecks every grant. */
export function tracksHome(ctx: TrackContext): VaultTracksHome {
  const session = ctx.session, own = managedIdentity(process.env);
  const admission = consoleAdmission(session?.auth?.current) ?? consoleAdmission(session?.auth?.initiator);
  const turnId = session?.turn?.id, sequence = session?.turn?.sequence;
  if (!own || !session?.id || typeof turnId !== 'string' || !Number.isSafeInteger(sequence) || admission?.purpose === undefined || admission.purpose !== 'human')
    throw new Error('Track access is available only in an authenticated private conversation');
  const turn = vaultTurnCapability({ sessionId: session.id, turnId, sequence: sequence as number, incarnation: own.incarnation });
  if (!turn || turn.expiresAt <= Date.now() || turn.turnId !== turnId || turn.sequence !== sequence)
    throw new Error('Track access is unavailable for this turn');
  const identity = { turnCapability: turn.capability, turnId, sequence, sessionId: session.id, memberId: admission.memberId, admissionNonce: admission.admissionNonce };
  const files: TrackFileWriter = {
    async list() {
      const result = await vaultBrokerRequest<{ notes: string[] }>('vault.read', { ...identity, operation: 'list', area: 'shared' });
      return result.notes.filter(path => path.startsWith('tracks/'));
    },
    async read(path) {
      if (!path.startsWith('tracks/')) throw new Error('Track access refused');
      const paths = await vaultBrokerRequest<{ notes: string[] }>('vault.read', { ...identity, operation: 'list', area: 'shared' });
      if (!paths.notes.includes(path)) return undefined;
      const result = await vaultBrokerRequest<{ content: string; contentRevision: string }>('vault.read', { ...identity, operation: 'read', area: 'shared', path });
      markTrackOrigin(ctx, result.content);
      return { path, content: result.content, contentRevision: result.contentRevision };
    },
    async write(input) {
      if (!input.path.startsWith('tracks/')) throw new Error('Track access refused');
      const result = await vaultBrokerRequest<{ origin?: string }>('tracks.write', { ...identity, ...input });
      const key = turnKeyFrom(ctx);
      if (key && (result.origin === 'synced' || result.origin === 'third_party')) taintTurn(key, result.origin);
    },
  };
  return new VaultTracksHome(files);
}

/** A single exact approved action. Keeper rechecks the persisted approval and current edit grant. */
export async function mutateApprovedTrack(ctx: TrackContext, approved: ApprovedExecution,
  operation: 'track_add_item'|'track_move_item'|'track_create'|'track_set_steps', input: unknown): Promise<unknown> {
  const session = ctx.session, admission = consoleAdmission(session?.auth?.current), own = managedIdentity(process.env);
  if (!own || !session?.id || !admission || admission.purpose !== 'resolver' ||
      approved.authority.origin !== 'approval-resume' || approved.authority.sessionId !== session.id ||
      approved.authority.actingMemberId !== admission.memberId || approved.authority.resolvedByMemberId !== admission.memberId ||
      approved.toolName !== operation)
    throw new Error('Track changes require the exact private Console approval');
  const approval = { requestId: approved.authority.requestId, callId: approved.callId, toolName: approved.toolName,
    payloadHash: approved.payloadHash, input, target: approved.target, authority: approved.authority };
  const result = await vaultBrokerRequest<{ result: unknown; origin?: string }>('tracks.write', { sessionId: session.id, memberId: admission.memberId,
    admissionNonce: admission.admissionNonce, approval, operation, input });
  const key = turnKeyFrom(ctx);
  if (key && (result.origin === 'synced' || result.origin === 'third_party')) taintTurn(key, result.origin);
  return result.result;
}
