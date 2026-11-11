import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDynamic } from './helpers/eve-dynamic.js';

const fake = vi.hoisted(() => ({
  query: vi.fn(), execute: vi.fn(), approval: vi.fn(), thisAgent: vi.fn(),
  granted: [] as string[], verify: vi.fn(async (_ctx: unknown) => false),
}));
vi.mock('../src/db.js', () => ({ getPool: () => fake }));
const tool = (gated: boolean) => ({ description: 'Fixture', inputSchema: { type: 'object' }, execute: fake.execute, ...(gated ? { approval: fake.approval } : {}) });
const entries = () => ({
  fixture: { capability: 'fixture', tool: tool(true) },
  gmail_send: { capability: 'mail', tool: tool(true) },
  gmail_search: { capability: 'mail', tool: tool(false) },
  tracks_list: { capability: 'tracks', tool: tool(false) },
  'agent-kit__vault_write': { capability: 'vault', tool: tool(true) },
  lares_read_public_doc: { capability: 'docs', tool: tool(true) },
});
vi.mock('../../../services/chief-of-staff/catalogue/index.js', () => ({ CATALOGUE: entries() }));
vi.mock('../../../services/creative/catalogue/index.js', () => ({ CATALOGUE: entries() }));
vi.mock('../../../services/chief-of-staff/lib/definition.js', () => ({ thisAgent: (...a: unknown[]) => fake.thisAgent(...a) }));
vi.mock('../../../services/creative/lib/definition.js', () => ({ thisAgent: (...a: unknown[]) => fake.thisAgent(...a) }));
vi.mock('../src/catalogue.js', () => ({ grantedToolNames: () => fake.granted }));
vi.mock('../src/private-console-surface.js', async (original) => ({ ...(await original<typeof import('../src/private-console-surface.js')>()), verifyPrivateConsoleSession: (ctx: unknown) => fake.verify(ctx) }));
const chief = (await import(new URL('../../../services/chief-of-staff/agent/tools/catalogue.ts', import.meta.url).href)).default;
const creative = (await import(new URL('../../../services/creative/agent/tools/catalogue.ts', import.meta.url).href)).default;
const { humanTurnRefusal } = await import(new URL('../../../services/chief-of-staff/lib/approvals.ts', import.meta.url).href);
const inc = '11111111-1111-4111-8111-111111111111';
const auth = (purpose = 'human') => ({ authenticator: 'lares-console', attributes: { user_id: 'owner@example.invalid', lares_member_id: 'Owner-ID', lares_admission_nonce: 'a'.repeat(43), lares_purpose: purpose } });
// What eve hands an approval policy / an executor: the session, the call, the input.
const context = (purpose = 'human') => ({ session: { id: 'wrun_test', turn: { id: 'turn-1', sequence: 0 }, auth: { current: auth(purpose), initiator: auth() } }, abortSignal: new AbortController().signal, callId: 'call-1', toolInput: {}, toolName: 'fixture' });
const consoleCtx = { session: { id: 'wrun_console', auth: { current: auth(), initiator: auth() } } };
const nativeCtx = { session: { id: 'wrun_native', auth: { current: null, initiator: { authenticator: 'telegram', principalId: 'fixture-owner', principalType: 'user' } } } };

beforeEach(() => { fake.thisAgent.mockResolvedValue({ loaded: { definition: {} } }); fake.granted = ['fixture']; fake.verify.mockImplementation(async (ctx: any) => ctx?.session?.auth?.current?.attributes?.lares_purpose !== undefined); });
afterEach(() => { vi.unstubAllEnvs(); fake.query.mockReset(); fake.execute.mockReset(); fake.approval.mockReset(); fake.thisAgent.mockReset(); fake.verify.mockReset(); });

describe('both catalogues guard their callbacks before underlying execution or approval policy', () => {
  for (const [role, resolver] of [['chief', chief], ['creative', creative]] as const) {
    it(`${role}: a tool built for a native conversation refuses private execution before source or policy`, async () => {
      const t = (await runDynamic(resolver, nativeCtx)).fixture;
      await expect(t.execute({}, context())).rejects.toThrow('Conversation authority');
      await expect(t.approval.request(context())).rejects.toThrow('Conversation authority');
      expect(fake.execute).not.toHaveBeenCalled(); expect(fake.approval).not.toHaveBeenCalled(); expect(fake.query).not.toHaveBeenCalled();
    });

    it(`${role}: a native conversation gets no response policy, so eve's own responder rule applies to Approve and to Deny`, async () => {
      const t = (await runDynamic(resolver, nativeCtx)).fixture;
      expect(t.approval.response).toBeUndefined();
      expect(typeof t.approval.request).toBe('function');
    });

    it(`${role}: a bound console conversation gets a response policy that refuses an unbound answer, for Approve and for Deny`, async () => {
      // The one gated tool each role may show in a private conversation.
      const gated = role === 'chief' ? 'agent-kit__vault_write' : 'lares_read_public_doc';
      fake.granted = [gated];
      const t = (await runDynamic(resolver, consoleCtx))[gated];
      expect(typeof t.approval.response).toBe('function');
      for (const decision of ['approve', 'deny']) {
        const answer = { request: { interactionId: 'i1', callId: 'call-1', toolName: gated }, response: { decision, principal: { authenticator: 'slack-webhook', attributes: { user_id: 'U1' } } }, session: { id: 'wrun_console', initiator: auth() } };
        // A refusal is a `rejected` answer or a throw; either way eve keeps the card pending.
        const refused = await t.approval.response(answer).then((r: any) => r.status === 'rejected', () => true);
        expect(refused, decision).toBe(true);
      }
      // Nothing was recorded as a decision (a read of the card is all that may have happened).
      expect(fake.query.mock.calls.filter(([sql]) => /^\s*(UPDATE|INSERT|DELETE)/i.test(String(sql)))).toEqual([]);
    });

    it(`${role}: malformed cold strict reconstruction fails before exposing tools`, async () => {
      const c = { session: { id: 'wrun_cold', auth: { current: null as never, initiator: auth() } } };
      fake.verify.mockRejectedValue(new Error('Conversation authority is not available'));
      await expect(runDynamic(resolver, c)).rejects.toThrow('Conversation authority');
      expect(fake.execute).not.toHaveBeenCalled(); expect(fake.approval).not.toHaveBeenCalled();
    });

    it(`${role}: the tool list is decided once per conversation and rebuilt from plain JSON`, async () => {
      const store = new Map<string, string>();
      const first = await runDynamic(resolver, nativeCtx, store);
      fake.granted = [];                       // a grant change mid-conversation must not reach it
      const second = await runDynamic(resolver, nativeCtx, store);
      expect(Object.keys(second)).toEqual(Object.keys(first));
      expect(fake.thisAgent).toHaveBeenCalledTimes(1);
      expect([...store.values()].every((v) => { JSON.parse(v); return true; })).toBe(true);
      // A new conversation decides again.
      expect(Object.keys(await runDynamic(resolver, { session: { id: 'wrun_other', auth: nativeCtx.session.auth } }, store))).toEqual([]);
    });

    it(`${role}: a gated tool has the object form with a card title, an ungated tool has no approval at all`, async () => {
      fake.granted = ['fixture', 'gmail_search'];
      const tools = await runDynamic(resolver, nativeCtx);
      expect(typeof tools.fixture.approval).toBe('object');
      expect(typeof tools.fixture.approval.prompt).toBe('function');
      expect(tools.gmail_search.approval).toBeUndefined();
    });

    it(`${role}: the card title is the tool's summary, falls back to the generic title, and never throws`, async () => {
      fake.granted = ['gmail_send', 'fixture'];
      const tools = await runDynamic(resolver, nativeCtx);
      const prompt = tools.gmail_send.approval.prompt;
      expect(prompt({ toolName: 'gmail_send', input: { to: ['a@x.example'] }, callId: 'c' })).toBe('Send email to a@x.example');
      expect(tools.fixture.approval.prompt({ toolName: 'fixture', input: {}, callId: 'c' })).toBe('Approve tool call: fixture');
      expect(() => prompt({ toolName: 'gmail_send', input: { get to() { throw new Error('boom'); } }, callId: 'c' })).not.toThrow();
      expect(prompt({ toolName: 'gmail_send', input: { get to() { throw new Error('boom'); } }, callId: 'c' })).toSatisfy((v: unknown) => v === undefined || typeof v === 'string');
      expect(prompt(undefined)).toBeUndefined();
    });
  }

  it('chief: an ordinary conversation gets exactly the granted tools that are not private-only', async () => {
    fake.granted = ['fixture', 'gmail_search', 'tracks_list'];
    expect(Object.keys(await runDynamic(chief, nativeCtx)).sort()).toEqual(['fixture', 'gmail_search']);
  });

  it('chief: a verified private console conversation gets the private subset, and nothing outside it', async () => {
    fake.granted = ['fixture', 'gmail_search', 'tracks_list'];
    expect(Object.keys(await runDynamic(chief, consoleCtx)).sort()).toEqual(['gmail_search', 'tracks_list']);
  });

  it('chief: an unverified private console conversation gets nothing private (the resolver refuses)', async () => {
    fake.granted = ['fixture', 'gmail_search', 'tracks_list'];
    fake.verify.mockRejectedValue(new Error('Conversation authority is not available'));
    await expect(runDynamic(chief, consoleCtx)).rejects.toThrow('Conversation authority');
  });

  it('an approval resolver cannot become a new human instruction', () => {
    expect(humanTurnRefusal({ current: auth('resolver'), initiator: auth() }, 'Refused.', { LARES_AGENT_INCARNATION: inc, LARES_CONSOLE_PRINCIPAL: 'owner@example.invalid' })).toContain('no new human instruction');
  });
});
