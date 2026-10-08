import { z } from 'zod';
import { KeeperRefusedError, KeeperOutcomeUncertainError, registerAction, type ActionContext } from './actions.js';
import { CREDENTIAL_SLOT, credentialRecordSchema, credentialStatusSchema, interruptedCredential, type CredentialConfig, type CredentialConsumer, type CredentialRecord, type CredentialStatus } from './credential-state.js';
import type { CredentialJournal, CredentialStore } from './credential-store.js';
import { CredentialFiles, newCredentialRevision } from './credential-files.js';

export const credentialSlotInput = z.object({ slot: z.literal(CREDENTIAL_SLOT) }).strict();
export const credentialRevisionInput = credentialSlotInput.extend({ expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
const token = z.string().min(1).max(8192).refine(v => Buffer.byteLength(v, 'utf8') <= 8192 && !/[\s\x00-\x1f\x7f]/.test(v));

/** No provider or Docker dependency. Later test/apply code uses this same locked journal and
 * custody boundary; only status/discard and explicit host recovery are registered here.
 */
export class Credentials {
  constructor(private config: CredentialConfig | undefined, private store: CredentialStore,
    private files: CredentialFiles, private consumers: () => Promise<CredentialConsumer[]>) {}
  private authorize(ctx: ActionContext): void {
    if (ctx.host) return;
    if (!this.config?.administrator) throw new KeeperRefusedError('Configure one credential administrator on the host');
    if (ctx.actor !== this.config.administrator) throw new KeeperRefusedError('Credential administrator required');
  }
  private dto(r: CredentialRecord | null, state: CredentialStatus['state'], guidance: CredentialStatus['guidance'], consumers = r?.consumers ?? []): CredentialStatus {
    return credentialStatusSchema.parse({ slot: CREDENTIAL_SLOT, state, guidance, revision: r?.version ?? null,
      activeRevision: r?.activeRevision ?? null, candidateRevision: r?.candidateRevision ?? null,
      phase: r?.phase ?? null, test: r?.test ?? null, consumers, activation: r?.activation ?? [], rollback: r?.rollback ?? [] });
  }
  private async inspect(r: CredentialRecord): Promise<CredentialStatus> {
    if (!this.config?.administrator) return this.dto(r, 'host-administration-required', 'configure-administrator');
    if (!this.config.prepared) return this.dto(r, 'host-administration-required', 'prepare-managed-slot');
    try { this.files.verifyRoot(); }
    catch { return this.dto(r, 'host-administration-required', 'prepare-writable-storage'); }
    try {
      const active = this.files.activeExists();
      if (active !== !!r.activeRevision) return this.dto(r, 'host-administration-required', 'prepare-managed-slot');
      if (interruptedCredential(r) || this.files.unexpectedFiles(r.candidateRevision, r.rollbackRevision) ||
          r.candidateRevision && !this.files.candidateExists(r.candidateRevision) ||
          r.rollbackRevision && !this.files.rollbackExists(r.rollbackRevision))
        return this.dto(r, 'recovery-required', 'inspect-journal');
    } catch { return this.dto(r, 'recovery-required', 'inspect-journal'); }
    if (!this.config.inventoryComplete) return this.dto(r, 'host-administration-required', 'review-consumers', this.config.retainedConsumers.map(c => ({ ...c, incarnation: null })));
    let consumers: CredentialConsumer[];
    try { consumers = await this.consumers(); }
    catch { return this.dto(r, 'unavailable', 'status-unavailable'); }
    if (!this.config.inventoryComplete || consumers.some(c => c.category !== 'owned-agent'))
      return this.dto(r, 'host-administration-required', 'review-consumers', consumers);
    return this.dto(r, r.phase as CredentialStatus['state'], null, consumers);
  }
  async status(ctx: ActionContext): Promise<CredentialStatus> {
    this.authorize(ctx);
    try { return await this.inspect(credentialRecordSchema.parse(await this.store.read())); }
    catch { return this.dto(null, 'unavailable', 'status-unavailable'); }
  }
  private async current(journal: CredentialJournal, expected: number): Promise<CredentialRecord> {
    const r = credentialRecordSchema.parse(await journal.read());
    if (r.version !== expected) throw new KeeperRefusedError('Credential revision changed; refresh status');
    if (interruptedCredential(r)) throw new KeeperRefusedError('Credential recovery required; inspect status');
    return r;
  }
  private async prepared(r: CredentialRecord): Promise<CredentialConsumer[]> {
    const status = await this.inspect(r);
    if (status.guidance) throw new KeeperRefusedError({
      'configure-administrator': 'Configure one credential administrator on the host',
      'prepare-managed-slot': 'Prepare the managed Notion slot on the host; external files are not adopted',
      'prepare-writable-storage': 'Prepare writable keeper-only credential storage on the host',
      'review-consumers': 'Review unsupported credential consumers on the host',
      'inspect-journal': 'Credential recovery required; inspect status',
      'status-unavailable': 'Credential status unavailable',
    }[status.guidance]);
    return status.consumers;
  }
  private async journaled<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch { throw new KeeperOutcomeUncertainError(); }
  }
  /** Internal to the later audited test/save action. Never activates an untested candidate. */
  async stage(value: string, expectedRevision: number, ctx: ActionContext): Promise<CredentialStatus> {
    this.authorize(ctx);
    if (!token.safeParse(value).success) throw new KeeperRefusedError('Invalid credential input');
    return this.store.locked(async journal => {
      const old = await this.current(journal, expectedRevision);
      const consumers = await this.prepared(old);
      if (old.candidateRevision || old.rollbackRevision) throw new KeeperRefusedError('Discard or recover the existing credential change first');
      const revision = newCredentialRevision();
      return this.journaled(async () => {
        const intent = await journal.save(old, { ...old, candidateRevision: revision, test: null, phase: 'staging',
          operation: { id: newCredentialRevision(), kind: 'stage' }, consumers, activation: [], rollback: [] });
        // On any failure leave intent/partial files inspectable. Old active custody is untouched.
        this.files.stage(revision, value);
        const saved = await journal.save(intent, { ...intent, phase: 'pending-test' });
        return this.dto(saved, 'pending-test', null);
      });
    });
  }
  async discard(expectedRevision: number, ctx: ActionContext): Promise<CredentialStatus> {
    this.authorize(ctx);
    return this.store.locked(async journal => {
      const old = await this.current(journal, expectedRevision);
      // Discard needs safe custody, not a controllable runtime inventory: it grants no access.
      this.files.verifyRoot();
      if (this.files.unexpectedFiles(old.candidateRevision, old.rollbackRevision) || old.rollbackRevision)
        throw new KeeperRefusedError('Credential recovery required; inspect status');
      if (!old.candidateRevision || !['pending-test', 'test-failed', 'pending-apply'].includes(old.phase))
        throw new KeeperRefusedError('No pending credential replacement');
      return this.journaled(async () => {
        const intent = await journal.save(old, { ...old, phase: 'discarding', operation: { id: newCredentialRevision(), kind: 'discard' } });
        this.files.removeCandidate(old.candidateRevision!);
        const saved = await journal.save(intent, { ...intent, candidateRevision: null, test: null, phase: old.activeRevision ? 'applied' : 'not-configured' });
        return this.dto(saved, saved.phase as CredentialStatus['state'], null);
      });
    });
  }
  /** Host-only, explicit cleanup of stage/discard intent. Never attempts activation rollback. */
  async recover(expectedRevision: number, ctx: ActionContext): Promise<CredentialStatus> {
    if (!ctx.host) throw new KeeperRefusedError('Reachable only from the host command');
    return this.store.locked(async journal => {
      const old = credentialRecordSchema.parse(await journal.read());
      if (old.version !== expectedRevision) throw new KeeperRefusedError('Credential revision changed; refresh status');
      if (!['staging', 'discarding'].includes(old.phase) || !old.candidateRevision || old.rollbackRevision)
        throw new KeeperRefusedError('Host inspection required; activation recovery is not available in this release');
      if (this.files.unexpectedFiles(old.candidateRevision, null, true))
        throw new KeeperRefusedError('Host inspection required for unjournaled credential files');
      // Reuse durable intent if interrupted again; never overwrite the operation with a phase
      // that would prevent recognizing a second crash at the same cleanup boundary.
      return this.journaled(async () => {
        this.files.removeCandidate(old.candidateRevision!);
        const saved = await journal.save(old, { ...old, candidateRevision: null, test: null, phase: old.activeRevision ? 'applied' : 'not-configured', operation: { id: newCredentialRevision(), kind: 'recover' } });
        return this.dto(saved, saved.phase as CredentialStatus['state'], null);
      });
    });
  }
}
export function registerCredentialActions(credentials: Credentials): void {
  registerAction({ name: 'credential.status', input: credentialSlotInput, run: (_, ctx) => credentials.status(ctx) });
  registerAction({ name: 'credential.discard', input: credentialRevisionInput, run: (input, ctx) => credentials.discard(input.expectedRevision, ctx) });
  registerAction({ name: 'credential.recover', input: credentialRevisionInput, hostOnly: true, run: (input, ctx) => credentials.recover(input.expectedRevision, ctx) });
}
