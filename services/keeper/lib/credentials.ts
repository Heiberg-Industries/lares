import { credentialSlotInput, credentialRevisionInput, credentialActivationInput, credentialGrantInput, credentialTokenInput as token } from '@lares/agent-kit/credential-lifecycle';
import { KeeperRefusedError, KeeperOutcomeUncertainError, registerAction, type ActionContext } from './actions.js';
import { CREDENTIAL_SLOT, credentialRecordSchema, credentialStatusSchema, interruptedCredential, inventoryGrants, type CredentialConfig, type CredentialConsumer, type CredentialGrant, type CredentialRecord, type CredentialStatus } from './credential-state.js';
import type { CredentialJournal, CredentialStore } from './credential-store.js';
import { CredentialFiles, newCredentialRevision } from './credential-files.js';
import type { NotionCredentialTester } from './notion-credential.js';
import type { CredentialActivation, CredentialActivationInput, CredentialGrantRequest } from './credential-activation.js';

/** Explicit tests share the foundation's lock and custody. Status and discard never test.
 * Only explicit Apply/disconnect enter the owned runtime activation boundary.
 */
export class Credentials {
  constructor(private config: CredentialConfig | undefined, private store: CredentialStore,
    private files: CredentialFiles, private consumers: (grants: CredentialGrant[]) => Promise<CredentialConsumer[]>,
    private tester?: NotionCredentialTester, private activation?: CredentialActivation) {}
  private authorize(ctx: ActionContext): void {
    if (ctx.host) return;
    if (!this.config?.administrator) throw new KeeperRefusedError('Configure one credential administrator on the host');
    if (ctx.actor !== this.config.administrator) throw new KeeperRefusedError('Credential administrator required');
  }
  private dto(r: CredentialRecord | null, state: CredentialStatus['state'], guidance: CredentialStatus['guidance'], consumers = r?.consumers ?? []): CredentialStatus {
    return credentialStatusSchema.parse({ slot: CREDENTIAL_SLOT, state, guidance, revision: r?.version ?? null,
      activeRevision: r?.activeRevision ?? null, candidateRevision: r?.candidateRevision ?? null,
      phase: r?.phase ?? null, test: r?.test ?? null, consumers, activation: r?.activation ?? [], rollback: r?.rollback ?? [], grants: r?.grants ?? [] });
  }
  private async inspect(r: CredentialRecord): Promise<CredentialStatus> {
    if (!this.config?.administrator) return this.dto(r, 'host-administration-required', 'configure-administrator');
    if (!this.config.prepared) return this.dto(r, 'host-administration-required', 'prepare-managed-slot');
    try { this.files.verifyRoot(); }
    catch { return this.dto(r, 'host-administration-required', 'prepare-writable-storage'); }
    try {
      const active = this.files.activeExists();
      if (interruptedCredential(r)) return this.dto(r, 'recovery-required', 'inspect-journal');
      if (active !== !!r.activeRevision) return this.dto(r, 'host-administration-required', 'prepare-managed-slot');
      if (interruptedCredential(r) || this.files.unexpectedFiles(r.candidateRevision, r.rollbackRevision) ||
          r.candidateRevision && !this.files.candidateExists(r.candidateRevision) ||
          r.rollbackRevision && !this.files.rollbackExists(r.rollbackRevision))
        return this.dto(r, 'recovery-required', 'inspect-journal');
    } catch { return this.dto(r, 'recovery-required', 'inspect-journal'); }
    if (!this.config.inventoryComplete) return this.dto(r, 'host-administration-required', 'review-consumers', this.config.retainedConsumers.map(c => ({ ...c, incarnation: null })));
    let consumers: CredentialConsumer[];
    try { consumers = await this.consumers(inventoryGrants(r)); }
    catch { return this.dto(r, 'unavailable', 'status-unavailable'); }
    if (!this.config.inventoryComplete || consumers.some(c => c.category !== 'owned-agent'))
      return this.dto(r, 'host-administration-required', 'review-consumers', consumers);
    const status = this.dto(r, r.phase as CredentialStatus['state'], null, consumers);
    if (this.activation) {
      try {
        const snapshot = await this.activation.snapshot(r);
        status.consumers = snapshot.consumers;
        status.inventoryRevision = snapshot.revision;
      }
      catch { return this.dto(r, 'host-administration-required', 'review-consumers', consumers); }
    }
    return status;
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
  private testReady(ctx: ActionContext): void {
    if (!ctx.finalizeAudit) throw new KeeperRefusedError('Use an audited credential action');
    if (!this.tester?.ready()) throw new KeeperRefusedError('Prepare the credential test egress proxy on the host');
  }
  private async testLocked(journal: CredentialJournal, intent: CredentialRecord, ctx: ActionContext): Promise<CredentialStatus> {
    const revision = intent.candidateRevision ?? intent.activeRevision!;
    const read = () => intent.candidateRevision ? this.files.readCandidate(revision) : this.files.readActive();
    const value = read();
    const custody = intent.candidateRevision ? this.files.candidateCustody(revision) : undefined;
    const evidence = await this.tester!.test({ kind: 'api_key', integration: 'notion',
      secretFile: intent.candidateRevision ? `.notion-${revision}.candidate` : this.files.activePath }, () => value);
    // Root file/configuration changes or consumers changing during the provider read invalidate
    // the result. Leave durable testing intent; never certify different bytes/inventory.
    if (read() !== value || custody && JSON.stringify(custody) !== JSON.stringify(this.files.candidateCustody(revision)) || this.files.unexpectedFiles(intent.candidateRevision, intent.rollbackRevision))
      throw new KeeperOutcomeUncertainError();
    const consumers = await this.consumers(inventoryGrants(intent));
    const inventory = (items: CredentialConsumer[]) => JSON.stringify([...items].sort((a, b) => a.name.localeCompare(b.name) || a.category.localeCompare(b.category)));
    if (!this.config?.inventoryComplete || consumers.some(c => c.category !== 'owned-agent') || inventory(consumers) !== inventory(intent.consumers))
      throw new KeeperOutcomeUncertainError();
    const next: CredentialRecord = credentialRecordSchema.parse({ ...intent, version: intent.version + 1,
      phase: intent.candidateRevision ? evidence.outcome === 'passed' ? 'pending-apply' : 'test-failed' : 'applied',
      test: { revision, ...evidence, at: new Date().toISOString() }, testedCustody: custody,
    });
    const result = this.dto(next, next.phase as CredentialStatus['state'], null);
    // Complete the provider-test audit BEFORE publishing tested evidence. A failed audit or
    // journal save leaves testing/recovery-required with no reusable passed result.
    await ctx.finalizeAudit!(result);
    const saved = await journal.save(intent, next);
    return this.dto(saved, saved.phase as CredentialStatus['state'], null);
  }
  async testSave(value: string, expectedRevision: number, ctx: ActionContext): Promise<CredentialStatus> {
    this.authorize(ctx);
    if (!token.safeParse(value).success) throw new KeeperRefusedError('Invalid credential input');
    this.testReady(ctx);
    return this.store.locked(async journal => {
      const old = await this.current(journal, expectedRevision);
      const consumers = await this.prepared(old);
      if (old.candidateRevision || old.rollbackRevision) throw new KeeperRefusedError('Discard or recover the existing credential change first');
      return this.journaled(async () => {
        const revision = newCredentialRevision();
        const staged = await journal.save(old, { ...old, candidateRevision: revision, test: null, phase: 'staging',
          operation: { id: newCredentialRevision(), kind: 'stage' }, consumers, activation: [], rollback: [] });
        this.files.stage(revision, value);
        const intent = await journal.save(staged, { ...staged, phase: 'testing', operation: { id: newCredentialRevision(), kind: 'test' } });
        return this.testLocked(journal, intent, ctx);
      });
    });
  }
  async testExisting(target: 'current' | 'pending', expectedRevision: number, ctx: ActionContext): Promise<CredentialStatus> {
    this.authorize(ctx);
    this.testReady(ctx);
    return this.store.locked(async journal => {
      const old = await this.current(journal, expectedRevision);
      const consumers = await this.prepared(old);
      if (target === 'current' && (!old.activeRevision || old.candidateRevision || old.rollbackRevision))
        throw new KeeperRefusedError('Test current requires an active key and no pending change; discard the pending change first');
      if (target === 'pending' && (!old.candidateRevision || old.rollbackRevision || !['pending-test', 'test-failed', 'pending-apply'].includes(old.phase)))
        throw new KeeperRefusedError('No pending credential replacement');
      return this.journaled(async () => {
        const intent = await journal.save(old, { ...old, phase: 'testing', test: null, consumers,
          operation: { id: newCredentialRevision(), kind: 'test' } });
        return this.testLocked(journal, intent, ctx);
      });
    });
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
  async change(kind: 'apply' | 'disconnect' | 'grant' | 'revoke', expectedRevision: number, input: CredentialActivationInput, ctx: ActionContext,
    grant?: CredentialGrantRequest): Promise<CredentialStatus> {
    this.authorize(ctx);
    if (!this.activation) throw new KeeperRefusedError('Prepare owned credential runtime activation on the host');
    return this.store.locked(async journal => {
      const old = await this.current(journal, expectedRevision);
      await this.prepared(old);
      const saved = await this.activation!.change(journal, old, input, kind, ctx, r => this.dto(r, r.phase as CredentialStatus['state'], null), grant);
      return this.dto(saved, saved.phase as CredentialStatus['state'], null);
    });
  }
  /** Owner switch: give or take away the managed key for one purpose. Same guards as Apply. */
  grant(expectedRevision: number, input: CredentialActivationInput & CredentialGrantRequest, ctx: ActionContext): Promise<CredentialStatus> {
    return this.change('grant', expectedRevision, input, ctx, { agent: input.agent, purpose: input.purpose });
  }
  revoke(expectedRevision: number, input: CredentialActivationInput & CredentialGrantRequest, ctx: ActionContext): Promise<CredentialStatus> {
    return this.change('revoke', expectedRevision, input, ctx, { agent: input.agent, purpose: input.purpose });
  }
  /** Host-only recovery. Never retries a provider call. */
  async recover(expectedRevision: number, ctx: ActionContext): Promise<CredentialStatus> {
    if (!ctx.host) throw new KeeperRefusedError('Reachable only from the host command');
    return this.store.locked(async journal => {
      const old = credentialRecordSchema.parse(await journal.read());
      if (old.version !== expectedRevision) throw new KeeperRefusedError('Credential revision changed; refresh status');
      if (old.activationIntent && this.activation) {
        const saved = await this.activation.recover(journal, old);
        return this.dto(saved, saved.phase as CredentialStatus['state'], null);
      }
      if (!['staging', 'testing', 'discarding'].includes(old.phase) || !(old.candidateRevision || old.phase === 'testing' && old.activeRevision) || old.rollbackRevision)
        throw new KeeperRefusedError('Host inspection required; activation recovery is not available in this release');
      if (this.files.unexpectedFiles(old.candidateRevision, null, true))
        throw new KeeperRefusedError('Host inspection required for unjournaled credential files');
      // Reuse durable intent if interrupted again; never overwrite the operation with a phase
      // that would prevent recognizing a second crash at the same cleanup boundary.
      return this.journaled(async () => {
        if (old.candidateRevision) this.files.removeCandidate(old.candidateRevision);
        const saved = await journal.save(old, { ...old, candidateRevision: null, test: null, phase: old.activeRevision ? 'applied' : 'not-configured', operation: { id: newCredentialRevision(), kind: 'recover' } });
        return this.dto(saved, saved.phase as CredentialStatus['state'], null);
      });
    });
  }
}
export function registerCredentialActions(credentials: Credentials): void {
  const successDetail = (result: unknown): string => {
    const status = credentialStatusSchema.parse(result);
    return JSON.stringify({ slot: status.slot, revision: status.test?.revision, outcome: status.test?.outcome });
  };
  registerAction({ name: 'credential.status', input: credentialSlotInput, run: (_, ctx) => credentials.status(ctx) });
  registerAction({ name: 'credential.test_save', input: credentialRevisionInput.extend({ token }).strict(), secretFields: ['token'],
    run: (input, ctx) => credentials.testSave(input.token, input.expectedRevision, ctx), successDetail });
  registerAction({ name: 'credential.test_current', input: credentialRevisionInput,
    run: (input, ctx) => credentials.testExisting('current', input.expectedRevision, ctx), successDetail });
  registerAction({ name: 'credential.test_pending', input: credentialRevisionInput,
    run: (input, ctx) => credentials.testExisting('pending', input.expectedRevision, ctx), successDetail });
  registerAction({ name: 'credential.discard', input: credentialRevisionInput, run: (input, ctx) => credentials.discard(input.expectedRevision, ctx) });
  const activationInput = credentialActivationInput;
  for (const kind of ['apply', 'disconnect'] as const)
    registerAction({ name: `credential.${kind}`, input: activationInput,
      run: (input, ctx) => credentials.change(kind, input.expectedRevision, input, ctx) });
  registerAction({ name: 'credential.grant', input: credentialGrantInput, run: (input, ctx) => credentials.grant(input.expectedRevision, input, ctx) });
  registerAction({ name: 'credential.revoke', input: credentialGrantInput, run: (input, ctx) => credentials.revoke(input.expectedRevision, input, ctx) });
  registerAction({ name: 'credential.recover', input: credentialRevisionInput, hostOnly: true, run: (input, ctx) => credentials.recover(input.expectedRevision, ctx) });
}
