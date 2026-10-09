import { KeeperRefusedError, KeeperOutcomeUncertainError, type ActionContext } from './actions.js';
import { newCredentialRevision, type CredentialFiles } from './credential-files.js';
import { credentialRecordSchema, type CredentialConsumer, type CredentialGrant, type CredentialRecord } from './credential-state.js';
import type { CredentialJournal } from './credential-store.js';

export interface CredentialRuntime {
  locked<T>(work: () => Promise<T>): Promise<T>;
  /** Recomputed definitions, grants, bindings, ownership and actual Docker mounts. */
  snapshot(record: CredentialRecord, recovery?: boolean): Promise<{ revision: string; consumers: CredentialConsumer[] }>;
  quiesce(name: string, incarnation: string): Promise<void>;
  reconcile(name: string, revision: string | null): Promise<void>;
  verify(name: string, incarnation: string, revision: string | null): Promise<void>;
  /** True when installation configuration alone mounts the key into this agent (a revoke keeps it). */
  installationBound?(name: string): boolean;
}
export interface CredentialGrantRequest { agent: string; purpose: 'clipping' }
export interface CredentialActivationInput {
  expectedActiveRevision: string | null;
  inventoryRevision: string;
}
/** Slot lock is held by Credentials; the existing namespace lock encloses all runtime work.
 * Recovery always restores the previous revision, except after journaled final cleanup begins.
 * No retry of provider calls, no agent grants/definitions/door claims are written here.
 */
export class CredentialActivation {
  constructor(private files: CredentialFiles, private runtime: CredentialRuntime) {}
  snapshot(r: CredentialRecord) { return this.runtime.snapshot(r); }
  async change(journal: CredentialJournal, old: CredentialRecord, input: CredentialActivationInput,
    kind: 'apply' | 'disconnect' | 'grant' | 'revoke', ctx: ActionContext, result: (r: CredentialRecord) => unknown,
    grant?: CredentialGrantRequest): Promise<CredentialRecord> {
    if (!ctx.finalizeAudit) throw new KeeperRefusedError('Use an audited credential action');
    const isGrant = kind === 'grant' || kind === 'revoke';
    if (isGrant !== !!grant) throw new KeeperRefusedError('Use an audited credential action');
    return this.runtime.locked(async () => {
      if (old.activationIntent || old.activeRevision !== input.expectedActiveRevision)
        throw new KeeperRefusedError('Credential revision changed; refresh status');
      let snapshot = await this.runtime.snapshot(old);
      let grantsAfter: CredentialGrant[] | undefined;
      if (grant) {
        const plan = await this.planGrant(old, grant, kind === 'grant', snapshot);
        snapshot = plan.snapshot; grantsAfter = plan.grantsAfter;
      }
      if (snapshot.revision !== input.inventoryRevision || kind === 'apply' && JSON.stringify(snapshot.consumers) !== JSON.stringify(old.consumers))
        throw new KeeperRefusedError('Affected consumers changed; refresh and confirm the complete list');
      if (grant) { /* custody and grant state checked above */ }
      else if (kind === 'apply') {
        if (old.phase !== 'pending-apply' || !old.candidateRevision || old.test?.revision !== old.candidateRevision || old.test.outcome !== 'passed' ||
          !old.testedCustody || JSON.stringify(old.testedCustody) !== JSON.stringify(this.files.candidateCustody(old.candidateRevision)))
          throw new KeeperRefusedError('Test the unchanged pending key successfully before Apply');
      } else if (!old.activeRevision || !['applied', 'pending-test', 'pending-apply', 'test-failed'].includes(old.phase)) {
        throw new KeeperRefusedError('No active credential to disconnect');
      }
      let r = old;
      try {
        const target = isGrant ? old.activeRevision : kind === 'apply' ? old.candidateRevision : null;
        const change = grant ? { agent: grant.agent, purpose: grant.purpose, to: kind === 'grant' } : undefined;
        // A grant change restarts only the named agent; every other consumer is unchanged and untouched.
        const consumers = grant ? snapshot.consumers.filter(c => c.name === grant.agent) : snapshot.consumers;
        const intent = { previousRevision: old.activeRevision, targetRevision: target,
          inventoryRevision: snapshot.revision, prepared: false, finishing: false,
          ...(change ? { grantChange: change, grantsBefore: old.grants ?? [], grantsAfter } : {}) };
        r = await journal.save(r, { ...r, phase: kind === 'disconnect' ? 'disconnecting' : 'applying',
          rollbackRevision: old.activeRevision, operation: { id: newCredentialRevision(), kind }, consumers,
          activationIntent: intent,
          activation: consumers.map(c => ({ name: c.name, revision: this.revisionFor(intent, c, false), state: 'pending' as const })), rollback: [] });
        if (old.activeRevision) this.files.preserveActive(old.activeRevision);
        r = await journal.save(r, { ...r, activationIntent: { ...r.activationIntent!, prepared: true } });
        await this.quiesce(r);
        if (kind === 'apply') this.files.publishCandidate(r.candidateRevision!);
        // Disconnect leaves active bytes retained until EVERY runtime has removed the binding.
        r = await journal.save(r, { ...r, effectiveRevision: r.activationIntent!.targetRevision,
          ...(r.activationIntent!.grantChange ? { effectiveGrants: r.activationIntent!.grantsAfter } : {}) });
        r = await this.reconcile(journal, r, false);
        await ctx.finalizeAudit!(result(this.completed(r, false)));
        r = await journal.save(r, { ...r, activationIntent: { ...r.activationIntent!, finishing: true } });
        return await this.finish(journal, r, false);
      } catch {
        // Read the durable boundary, not a local guess about a failed database response.
        try {
          r = credentialRecordSchema.parse(await journal.read());
          if (r.activationIntent && !r.activationIntent.finishing) await this.rollback(journal, r);
        } catch { /* Retain intent and protected rollback for explicit host recovery. */ }
        throw new KeeperOutcomeUncertainError();
      }
    });
  }
  /** The checks a grant or revoke runs before any journal write, and the inventory the owner confirms: the one
   * AFTER a grant (the agent that will restart is in it) and the current one for a revoke, which is why the
   * console confirms a revoke with the current status's inventoryRevision. Shared with the read-only preview so
   * the two cannot drift. The agent does not hold the mount yet, so the post-grant snapshot is loose. */
  private async planGrant(old: CredentialRecord, grant: CredentialGrantRequest, to: boolean, current: Awaited<ReturnType<CredentialRuntime['snapshot']>>) {
    if (old.phase !== 'applied' || !old.activeRevision || old.candidateRevision || old.rollbackRevision)
      throw new KeeperRefusedError('Apply a tested key before switching this on or off');
    const before = old.grants ?? [];
    const present = before.some(g => g.agent === grant.agent && g.purposes.includes(grant.purpose));
    if (to ? present : !present)
      throw new KeeperRefusedError(to ? 'This agent already has the key for this purpose' : 'This agent does not have the key for this purpose');
    const grantsAfter: CredentialGrant[] = to
      ? [...before.filter(g => g.agent !== grant.agent), { agent: grant.agent, purposes: [grant.purpose] }].sort((x, y) => x.agent.localeCompare(y.agent))
      : before.filter(g => g.agent !== grant.agent);
    const snapshot = to ? await this.runtime.snapshot({ ...old, grants: grantsAfter }, true) : current;
    if (!snapshot.consumers.some(c => c.name === grant.agent && c.category === 'owned-agent'))
      throw new KeeperRefusedError('Only a ready chief-of-staff agent can be given this key');
    return { grantsAfter, snapshot };
  }
  /** Read-only: the inventory a grant would produce. Writes no journal row and restarts nothing. */
  async previewGrant(old: CredentialRecord, grant: CredentialGrantRequest) {
    return this.runtime.locked(async () => {
      if (old.activationIntent) throw new KeeperRefusedError('Credential revision changed; refresh status');
      const { snapshot } = await this.planGrant(old, grant, true, await this.runtime.snapshot(old));
      return { agent: grant.agent, purpose: grant.purpose, inventoryRevision: snapshot.revision, consumers: snapshot.consumers };
    });
  }
  /** Revoke a grant whose agent no longer exists. No runtime holds the key, so nothing is quiesced or
   * reconciled: only the journal changes, audited before it is saved. */
  async dropStaleGrant(journal: CredentialJournal, old: CredentialRecord, input: CredentialActivationInput,
    grant: CredentialGrantRequest, ctx: ActionContext, result: (r: CredentialRecord) => unknown): Promise<CredentialRecord> {
    if (!ctx.finalizeAudit) throw new KeeperRefusedError('Use an audited credential action');
    return this.runtime.locked(async () => {
      if (old.activationIntent || old.activeRevision !== input.expectedActiveRevision)
        throw new KeeperRefusedError('Credential revision changed; refresh status');
      if (old.phase !== 'applied' || !old.activeRevision || old.candidateRevision || old.rollbackRevision)
        throw new KeeperRefusedError('Apply a tested key before switching this on or off');
      if (!(old.grants ?? []).some(g => g.agent === grant.agent && g.purposes.includes(grant.purpose)))
        throw new KeeperRefusedError('This agent does not have the key for this purpose');
      if ((await this.runtime.snapshot(old)).revision !== input.inventoryRevision)
        throw new KeeperRefusedError('Affected consumers changed; refresh and confirm the complete list');
      try {
        const next = credentialRecordSchema.parse({ ...old, operation: { id: newCredentialRevision(), kind: 'revoke' },
          grants: (old.grants ?? []).filter(g => g.agent !== grant.agent) });
        await ctx.finalizeAudit!(result(next));
        return await journal.save(old, next);
      } catch { throw new KeeperOutcomeUncertainError(); }
    });
  }
  /** The mount revision this consumer must hold at the end of the step. In a grant change only the named
   * agent's mount moves; an installation binding keeps it mounted whatever the switch says. */
  private revisionFor(intent: NonNullable<CredentialRecord['activationIntent']>, c: CredentialConsumer, rollback: boolean): string | null {
    const target = rollback ? intent.previousRevision : intent.targetRevision;
    const change = intent.grantChange;
    if (!change || c.name !== change.agent) return target;
    return change.to !== rollback || this.runtime.installationBound?.(c.name) ? target : null;
  }
  private async quiesce(r: CredentialRecord) {
    for (const c of r.consumers) {
      if (c.category !== 'owned-agent' || !c.incarnation) throw new KeeperRefusedError('Owned credential consumers required');
      await this.runtime.quiesce(c.name, c.incarnation);
    }
  }
  private async reconcile(journal: CredentialJournal, initial: CredentialRecord, rollback: boolean) {
    let r = initial;
    const field = rollback ? 'rollback' : 'activation';
    const revisionOf = (c: CredentialConsumer) => this.revisionFor(r.activationIntent!, c, rollback);
    for (const c of r.consumers) {
      const revision = revisionOf(c);
      try {
        await this.runtime.reconcile(c.name, revision);
        await this.runtime.verify(c.name, c.incarnation!, revision);
        r = await journal.save(r, { ...r, [field]: r[field].map(p => p.name === c.name ? { ...p, state: 'complete' } : p) });
      } catch {
        await journal.save(r, { ...r, phase: 'recovery-required', [field]: r[field].map(p => p.name === c.name ? { ...p, state: 'failed' } : p) });
        throw new KeeperOutcomeUncertainError();
      }
    }
    // Verify ALL again: completing the last consumer alone proves no fleet-wide agreement.
    for (const c of r.consumers) await this.runtime.verify(c.name, c.incarnation!, revisionOf(c));
    if ((await this.runtime.snapshot(r, true)).revision !== r.activationIntent!.inventoryRevision)
      throw new KeeperOutcomeUncertainError();
    return r;
  }
  private completed(r: CredentialRecord, rollback: boolean): CredentialRecord {
    const revision = rollback ? r.activationIntent!.previousRevision : r.activationIntent!.targetRevision;
    const i = r.activationIntent!;
    return credentialRecordSchema.parse({ ...r, phase: revision ? 'applied' : 'disconnected', activeRevision: revision,
      effectiveRevision: revision, candidateRevision: null, rollbackRevision: null,
      test: (rollback && !i.grantChange) || !revision ? null : r.test,
      ...(i.grantChange ? { grants: rollback ? i.grantsBefore : i.grantsAfter } : {}), effectiveGrants: undefined,
      testedCustody: undefined, activationIntent: null });
  }
  private async finish(journal: CredentialJournal, r: CredentialRecord, rollback: boolean) {
    // finishing intent survives repeated crashes and permits idempotent cleanup.
    const revision = rollback ? r.activationIntent!.previousRevision : r.activationIntent!.targetRevision;
    if ((await this.runtime.snapshot(r, true)).revision !== r.activationIntent!.inventoryRevision)
      throw new KeeperRefusedError('Host inspection required for changed consumers before cleanup');
    for (const c of r.consumers) await this.runtime.verify(c.name, c.incarnation!, this.revisionFor(r.activationIntent!, c, rollback));
    if (!revision) this.files.removeActive();
    if (r.candidateRevision) this.files.removeCandidate(r.candidateRevision);
    if (r.rollbackRevision) this.files.removeRollback(r.rollbackRevision);
    this.files.clearPublication();
    return journal.save(r, this.completed(r, rollback));
  }
  private async rollback(journal: CredentialJournal, initial: CredentialRecord) {
    let r = initial;
    const intent = r.activationIntent!;
    const snapshot = await this.runtime.snapshot(r, true);
    if (snapshot.revision !== intent.inventoryRevision) throw new KeeperRefusedError('Host inspection required for changed consumers');
    r = await journal.save(r, { ...r, phase: 'rolling-back', rollback: r.consumers.map(c => ({ name: c.name, revision: this.revisionFor(intent, c, true), state: 'pending' as const })) });
    await this.quiesce(r);
    if (intent.prepared) {
      if (intent.previousRevision) this.files.restoreActive(intent.previousRevision);
      else this.files.removeActive();
    } else {
      // Publication cannot occur before the durable prepared boundary. Preserve active bytes.
      if (intent.previousRevision) this.files.readActive();
    }
    r = await journal.save(r, { ...r, effectiveRevision: intent.previousRevision,
      ...(intent.grantChange ? { effectiveGrants: intent.grantsBefore } : {}) });
    r = await this.reconcile(journal, r, true);
    r = await journal.save(r, { ...r, activationIntent: { ...intent, finishing: true } });
    return this.finish(journal, r, true);
  }
  async recover(journal: CredentialJournal, old: CredentialRecord): Promise<CredentialRecord> {
    if (!old.activationIntent) throw new KeeperRefusedError('Host inspection required for unknown activation intent');
    return this.runtime.locked(async () => {
      try {
        if (this.files.unexpectedFiles(old.candidateRevision, old.rollbackRevision, true))
          throw new KeeperRefusedError('Host inspection required for unjournaled credential files');
        if (old.activationIntent!.finishing) return await this.finish(journal, old, old.phase === 'rolling-back');
        return await this.rollback(journal, old);
      } catch { throw new KeeperOutcomeUncertainError(); }
    });
  }
}
