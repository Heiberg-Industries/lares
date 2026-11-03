// A new private note from a private Console conversation (the note write's Console half).
//
// The native tool writes the runtime's own store. In a Console conversation the member's private
// area is in Keeper custody, so the card is reserved here against the note's current bytes and
// Keeper writes the file, rechecking the card, the grant and those bytes, and using the card once.
import { payloadFingerprint } from '@lares/agent-kit/approval-ledger';
import type { ApprovedExecution, ExactApprovalAdapter } from '@lares/agent-kit/approval-execution';
import type { AuthorityDatabase } from '@lares/agent-kit/console-turn-authority';
import { consoleAdmission } from '@lares/agent-kit/console-turn-authority';
import { parseDefinition } from '@lares/agent-kit/definition';
import { managedIdentity } from '@lares/agent-kit/door-authority';
import { canWriteVaultArea } from '@lares/agent-kit/manifest';
import { stampFor, turnKeyFrom } from '@lares/agent-kit/origin-taint';
import { vaultBrokerRequest } from '@lares/agent-kit/vault-broker-client';
import { parseVaultNoteInput, vaultNotePath, vaultNoteTargetFingerprint, VAULT_NOTE_WRITE_POLICY,
  VAULT_NOTE_WRITE_TOOL } from '@lares/agent-kit/vault-note-write';
import { vaultTurnCapability } from '../agent/lib/vault-turn.js';

type NoteContext = { session?: { id?: string; turn?: { id?: string; sequence?: number }; auth?: { current?: unknown; initiator?: unknown } | null } };

/** The note's current content, read through Keeper with this human turn's capability. */
async function currentPrivateNote(ctx: NoteContext, path: string): Promise<string | null> {
  const session = ctx.session, own = managedIdentity(process.env), admission = consoleAdmission(session?.auth?.current);
  const turnId = session?.turn?.id, sequence = session?.turn?.sequence;
  if (!own || !session?.id || typeof turnId !== 'string' || !Number.isSafeInteger(sequence) || admission?.purpose !== 'human')
    throw new Error('Vault notes are available only in an authenticated private conversation');
  const turn = vaultTurnCapability({ sessionId: session.id, turnId, sequence: sequence as number, incarnation: own.incarnation });
  if (!turn || turn.expiresAt <= Date.now() || turn.turnId !== turnId || turn.sequence !== sequence)
    throw new Error('Vault notes are unavailable for this turn');
  const identity = { turnCapability: turn.capability, turnId, sequence, sessionId: session.id, memberId: admission.memberId,
    admissionNonce: admission.admissionNonce, area: 'private' };
  // A missing note and a refused read look the same from a read, so ask the listing first.
  const listed = await vaultBrokerRequest<{ notes: string[] }>('vault.read', { ...identity, operation: 'list' });
  if (!listed.notes.includes(path)) return null;
  return (await vaultBrokerRequest<{ content: string }>('vault.read', { ...identity, operation: 'read', path })).content;
}

/** Exact-call adapter for the note write. Keeper recomputes both fingerprints when it writes. */
export const vaultNoteApprovalAdapter: ExactApprovalAdapter = {
  toolNames: [VAULT_NOTE_WRITE_TOOL],
  async readPolicyHash(db: AuthorityDatabase, agent: string, incarnation: string) {
    const { rows } = await db.query(`SELECT r.applied_definition,a.hash FROM agent_resources r JOIN agent_definitions a ON a.name=r.name
      WHERE r.name=$1 AND r.ownership_token=$2::uuid AND r.runtime_control_token=r.ownership_token AND r.state='ready'
      AND NOT r.pending AND a.status='valid' AND r.applied_definition IS NOT NULL FOR SHARE OF r,a`, [agent, incarnation]);
    if (rows.length !== 1) throw new Error('Exact Vault note policy is unavailable');
    const definition = parseDefinition(rows[0].applied_definition);
    if (!canWriteVaultArea(definition, 'private')) throw new Error('Exact Vault note policy is unavailable');
    return payloadFingerprint(VAULT_NOTE_WRITE_POLICY, { definition, hash: rows[0].hash });
  },
  async readTarget(_db, input, memberId, tool, ctx, reservedTarget) {
    if (tool !== VAULT_NOTE_WRITE_TOOL) throw new Error('Exact Vault note target is unavailable');
    const path = vaultNotePath(parseVaultNoteInput(input).title);
    // An approval answer carries no human turn and gains no read: it checks the reserved target only.
    if (reservedTarget) {
      if (reservedTarget.kind !== 'vault-note' || reservedTarget.id !== path || reservedTarget.ownerMemberId !== memberId)
        throw new Error('Exact Vault note target changed');
      return reservedTarget;
    }
    const content = await currentPrivateNote(ctx as NoteContext, path);
    const turnKey = turnKeyFrom(ctx);
    const approvedOrigin = (turnKey ? stampFor('agent', turnKey) : 'third_party') as 'agent'|'synced'|'third_party';
    return { kind: 'vault-note', id: path, ownerMemberId: memberId, fingerprint: vaultNoteTargetFingerprint(content), approvedOrigin };
  },
};

/** The one approved write. Keeper rechecks the persisted card, the private edit grant and the note. */
export async function writeApprovedConsoleNote(ctx: NoteContext, approved: ApprovedExecution, input: unknown): Promise<unknown> {
  const session = ctx.session, admission = consoleAdmission(session?.auth?.current);
  if (!session?.id || !admission || admission.purpose !== 'resolver' || approved.toolName !== VAULT_NOTE_WRITE_TOOL ||
      approved.authority.origin !== 'approval-resume' || approved.authority.sessionId !== session.id ||
      approved.authority.actingMemberId !== admission.memberId || approved.authority.resolvedByMemberId !== admission.memberId)
    throw new Error('A Vault note needs the exact private Console approval');
  const approval = { requestId: approved.authority.requestId, callId: approved.callId, toolName: approved.toolName,
    payloadHash: approved.payloadHash, input, target: approved.target, authority: approved.authority };
  return await vaultBrokerRequest('vault.write', { sessionId: session.id, memberId: admission.memberId,
    admissionNonce: admission.admissionNonce, approval, input });
}
