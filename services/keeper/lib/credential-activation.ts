import { KeeperRefusedError, KeeperOutcomeUncertainError, type ActionContext } from './actions.js';
import { newCredentialRevision, type CredentialFiles } from './credential-files.js';
import { credentialRecordSchema, type CredentialConsumer, type CredentialRecord } from './credential-state.js';
import type { CredentialJournal } from './credential-store.js';

export interface CredentialRuntime {
  locked<T>(work: () => Promise<T>): Promise<T>;
  /** Recomputed definitions, grants, bindings, ownership and actual Docker mounts. */
  snapshot(record: CredentialRecord, recovery?: boolean): Promise<{ revision: string; consumers: CredentialConsumer[] }>;
  quiesce(name: string, incarnation: string): Promise<void>;
  reconcile(name: string, revision: string | null): Promise<void>;
  verify(name: string, incarnation: string, revision: string | null): Promise<void>;
}
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
    kind: 'apply' | 'disconnect', ctx: ActionContext, result: (r: CredentialRecord) => unknown): Promise<CredentialRecord> {
    if (!ctx.finalizeAudit) throw new KeeperRefusedError('Use an audited credential action');
    return this.runtime.locked(async () => {
      if (old.activationIntent || old.activeRevision !== input.expectedActiveRevision)
        throw new KeeperRefusedError('Credential revision changed; refresh status');
      const snapshot = await this.runtime.snapshot(old);
      if (snapshot.revision !== input.inventoryRevision || kind === 'apply' && JSON.stringify(snapshot.consumers) !== JSON.stringify(old.consumers))
        throw new KeeperRefusedError('Affected consumers changed; refresh and confirm the complete list');
      if (kind === 'apply') {
        if (old.phase !== 'pending-apply' || !old.candidateRevision || old.test?.revision !== old.candidateRevision || old.test.outcome !== 'passed' ||
          !old.testedCustody || JSON.stringify(old.testedCustody) !== JSON.stringify(this.files.candidateCustody(old.candidateRevision)))
          throw new KeeperRefusedError('Test the unchanged pending key successfully before Apply');
      } else if (!old.activeRevision || !['applied', 'pending-test', 'pending-apply', 'test-failed'].includes(old.phase)) {
        throw new KeeperRefusedError('No active credential to disconnect');
      }
      let r = old;
      try {
        r = await journal.save(r, { ...r, phase: kind === 'apply' ? 'applying' : 'disconnecting',
          rollbackRevision: old.activeRevision, operation: { id: newCredentialRevision(), kind }, consumers: snapshot.consumers,
          activationIntent: { previousRevision: old.activeRevision, targetRevision: kind === 'apply' ? old.candidateRevision : null,
            inventoryRevision: snapshot.revision, prepared: false, finishing: false },
          activation: snapshot.consumers.map(c => ({ name: c.name, revision: kind === 'apply' ? old.candidateRevision : null, state: 'pending' })), rollback: [] });
        if (old.activeRevision) this.files.preserveActive(old.activeRevision);
        r = await journal.save(r, { ...r, activationIntent: { ...r.activationIntent!, prepared: true } });
        await this.quiesce(r);
        if (kind === 'apply') this.files.publishCandidate(r.candidateRevision!);
        // Disconnect leaves active bytes retained until EVERY runtime has removed the binding.
        r = await journal.save(r, { ...r, effectiveRevision: r.activationIntent!.targetRevision });
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
  private async quiesce(r: CredentialRecord) {
    for (const c of r.consumers) {
      if (c.category !== 'owned-agent' || !c.incarnation) throw new KeeperRefusedError('Owned credential consumers required');
      await this.runtime.quiesce(c.name, c.incarnation);
    }
  }
  private async reconcile(journal: CredentialJournal, initial: CredentialRecord, rollback: boolean) {
    let r = initial;
    const revision = rollback ? r.activationIntent!.previousRevision : r.activationIntent!.targetRevision;
    const field = rollback ? 'rollback' : 'activation';
    for (const c of r.consumers) {
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
    for (const c of r.consumers) await this.runtime.verify(c.name, c.incarnation!, revision);
    if ((await this.runtime.snapshot(r, true)).revision !== r.activationIntent!.inventoryRevision)
      throw new KeeperOutcomeUncertainError();
    return r;
  }
  private completed(r: CredentialRecord, rollback: boolean): CredentialRecord {
    const revision = rollback ? r.activationIntent!.previousRevision : r.activationIntent!.targetRevision;
    return credentialRecordSchema.parse({ ...r, phase: revision ? 'applied' : 'disconnected', activeRevision: revision,
      effectiveRevision: revision, candidateRevision: null, rollbackRevision: null, test: rollback || !revision ? null : r.test,
      testedCustody: undefined, activationIntent: null });
  }
  private async finish(journal: CredentialJournal, r: CredentialRecord, rollback: boolean) {
    // finishing intent survives repeated crashes and permits idempotent cleanup.
    const revision = rollback ? r.activationIntent!.previousRevision : r.activationIntent!.targetRevision;
    if ((await this.runtime.snapshot(r, true)).revision !== r.activationIntent!.inventoryRevision)
      throw new KeeperRefusedError('Host inspection required for changed consumers before cleanup');
    for (const c of r.consumers) await this.runtime.verify(c.name, c.incarnation!, revision);
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
    r = await journal.save(r, { ...r, phase: 'rolling-back', rollback: r.consumers.map(c => ({ name: c.name, revision: intent.previousRevision, state: 'pending' })) });
    await this.quiesce(r);
    if (intent.prepared) {
      if (intent.previousRevision) this.files.restoreActive(intent.previousRevision);
      else this.files.removeActive();
    } else {
      // Publication cannot occur before the durable prepared boundary. Preserve active bytes.
      if (intent.previousRevision) this.files.readActive();
    }
    r = await journal.save(r, { ...r, effectiveRevision: intent.previousRevision });
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
