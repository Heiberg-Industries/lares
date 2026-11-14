import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { emptySessionView } from 'eve/events';
import type { DynamicModelContext } from 'eve/models';
import * as privateSurface from '../src/private-console-surface.js';
import { currentModelInvocation, type ModelInvocationSession } from '../src/model-invocation.js';
import { currentOwnerJob, hasOwnerJob } from '../src/owner-job.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, guardDefinitionModel, resolveDefinitionForModel, assertModelDefinitionReady, pinSessionGatewayAlias, sessionGatewayModel, definitionModel, definitionModelResolver, modelStepCoordinates } from '../src/definition-model.js';

const session = (id: string) => ({ id, auth: { current: null, initiator: null } });
// The stream position a made-up view reports. `eve/events` is real except for `position`, which
// reads a number off the stand-in view below: a view at a later position can only be built by
// folding real stream lines, and what these tests vary is the position, not the fold.
const viewAt = (line: number) => ({ line }) as never;
vi.mock('eve/events', async (actual) => {
  const real = await actual<typeof import('eve/events')>();
  return { ...real, position: (view: unknown) => (view as { line?: unknown }).line !== undefined ? (view as { line: number }).line : real.position(view as never) };
});
/** What eve 1.0 hands a dynamic `model`: the session, its latest turn and the session view. */
const modelContext = (sessionId: string, turn: { id: string; status?: 'running' | 'paused' | 'settled' } | null = { id: 'turn_0' }, line = 0) => ({
  session: session(sessionId),
  turn: turn === null ? null : { id: turn.id, status: turn.status ?? 'running', input: [] },
  view: viewAt(line),
}) as unknown as DynamicModelContext;
const state = vi.hoisted(() => ({ values: new Map<string, unknown>(), reads: 0 }));
vi.mock('eve/context', () => ({ defineState: (key: string, initial: () => unknown) => ({
  get: () => { state.reads++; return state.values.has(key) ? state.values.get(key) : initial(); },
  update: (fn: (value: unknown) => unknown) => { state.values.set(key, fn(state.values.has(key) ? state.values.get(key) : initial())); },
}) }));
afterEach(() => { vi.unstubAllEnvs(); state.values.clear(); state.reads = 0; });

describe('definition fallback provider boundary', () => {
  it('leaves the neutral unmounted runtime free of context requirements', async () => {
    vi.stubEnv('LARES_DEFINITION_DIR', '');
    await expect(resolveDefinitionForModel(async () => 'neutral')).resolves.toBe('neutral');
    await expect(assertModelDefinitionReady()).resolves.toBeUndefined();
    expect(state.reads).toBe(0);
  });
  it('marks only successful session resolution ready and resets before another attempt', async () => {
    vi.stubEnv('LARES_DEFINITION_DIR', '/synthetic');
    await expect(assertModelDefinitionReady()).rejects.toThrow('No valid session definition');
    await expect(resolveDefinitionForModel(async () => 'last-valid')).resolves.toBe('last-valid');
    await expect(assertModelDefinitionReady()).resolves.toBeUndefined();
    await expect(resolveDefinitionForModel(async () => { throw new Error('invalid'); })).rejects.toThrow('invalid');
    await expect(assertModelDefinitionReady()).rejects.toThrow('No valid session definition');
  });
  for (const method of ['doGenerate', 'doStream'] as const) {
    it(`refuses ${method} before provider execution, then recovers`, async () => {
      const call = vi.fn(async () => { throw new Error('PROVIDER REACHED'); });
      const provider = new MockLanguageModelV3({ doGenerate: call, doStream: call });
      const resolve = vi.fn(async () => { throw new Error('no last valid definition'); });
      const wrapped = guardDefinitionModel(provider, resolve) as Exclude<ReturnType<typeof guardDefinitionModel>, string>;
      expect(resolve).not.toHaveBeenCalled();
      const options = { prompt: [] };
      await expect(wrapped[method](options)).rejects.toThrow('no last valid definition');
      expect(call).not.toHaveBeenCalled();
      resolve.mockImplementation(async () => undefined as never);
      await expect(wrapped[method](options)).rejects.toThrow('PROVIDER REACHED');
      expect(call).toHaveBeenCalledTimes(1);
    });
  }
});

it('pins the alias as durable data and reconstructs a direct provider without returning a gateway ID', () => {
 const provider = vi.fn((alias: string) => new MockLanguageModelV3({modelId: alias}));
 expect(() => sessionGatewayModel(provider)).toThrow('not pinned');
 expect(pinSessionGatewayAlias('tenant-brain')).toBeNull();
 const first = sessionGatewayModel(provider), second = sessionGatewayModel(provider);
 expect(first.model).not.toBeTypeOf('string');
 expect(first.modelContextWindowTokens).toBe(200_000);
 expect(provider.mock.calls).toEqual([['tenant-brain'], ['tenant-brain']]);
 expect(second.model.modelId).toBe('tenant-brain');
});
/**
 * The agent `model` itself, on eve 1.0.
 *
 * A dynamic model is ONE function eve calls before every ordinary model call
 * (node_modules/eve/docs/dynamic-configuration/index.md); the events map of 0.60.1
 * (`step.started`) is gone, and so is the event it was handed. Two things carry over unchanged:
 *
 *  - a model-id STRING is the one thing this project cannot hand eve: eve would route it through
 *    the Vercel AI Gateway, past the self-hosted LiteLLM gateway every model call must use. The
 *    function always returns a constructed provider object with its context window;
 *  - the definition is read on the conversation's FIRST call and the alias is pinned in durable
 *    session state, so no later call re-reads it.
 *
 * What is new is where the call's coordinates come from: eve's own session view
 * (`modelStepCoordinates`), since no event carries them any more.
 */
describe('the agent model resolver', () => {
  it('is an opaque eve dynamic value holding one function, with no events map', () => {
    const resolver = definitionModel({ resolveAlias: async () => 'tenant-brain', provider: (alias) => new MockLanguageModelV3({ modelId: alias }) });
    // eve 1.0 brands a `defineDynamic()` value with this symbol and rejects any other key
    // (node_modules/eve/dist/src/dynamic/definition.js, `assertDynamicSentinelKeys`).
    expect(typeof Reflect.get(resolver, Symbol.for('eve.dynamic'))).toBe('function');
    expect(Object.keys(resolver)).toEqual([]);
  });

  it('reads the definition once and reuses the pin on every later model call of the session', async () => {
    const resolveAlias = vi.fn(async (_sessionId: string | undefined, _session: ModelInvocationSession | undefined) => 'tenant-brain');
    const provider = vi.fn((alias: string) => new MockLanguageModelV3({ modelId: alias }));
    const select = definitionModelResolver({ resolveAlias, provider });
    const first = await select(modelContext('session-one', { id: 'turn_0' }, 2));
    const second = await select(modelContext('session-one', { id: 'turn_0' }, 9));
    const nextTurn = await select(modelContext('session-one', { id: 'turn_1' }, 20));
    // ONE read for the conversation.
    expect(resolveAlias.mock.calls).toEqual([['session-one', session('session-one')]]);
    // ...and every call still rebuilds the provider from the pinned alias.
    expect(provider.mock.calls).toEqual([['tenant-brain'], ['tenant-brain'], ['tenant-brain']]);
    expect(first.model).not.toBeTypeOf('string');
    expect((second.model as { modelId: string }).modelId).toBe('tenant-brain');
    expect((nextTurn.model as { modelId: string }).modelId).toBe('tenant-brain');
    expect(second.modelContextWindowTokens).toBe(200_000);
  });

  it('a changed definition reaches the next conversation and never one already running', async () => {
    // The definition on disk: what `resolveAlias` reads when it is asked.
    let onDisk = 'model-before-the-edit';
    const select = definitionModelResolver({ resolveAlias: async () => onDisk, provider: (alias) => new MockLanguageModelV3({ modelId: alias }) });
    const modelId = async (ctx: DynamicModelContext) => ((await select(ctx)).model as { modelId: string }).modelId;
    // eve keeps session state per conversation; this fixture's store is one map, so each
    // conversation's state is swapped in by hand.
    const stores = new Map<string, Map<string, unknown>>();
    const inSession = async <T>(id: string, run: () => Promise<T>): Promise<T> => {
      const store = stores.get(id) ?? new Map<string, unknown>();
      stores.set(id, store);
      state.values = store;
      return run();
    };
    expect(await inSession('running', () => modelId(modelContext('running', { id: 'turn_0' }, 1)))).toBe('model-before-the-edit');
    onDisk = 'model-after-the-edit';
    // The running conversation keeps its model: later calls, later turns.
    expect(await inSession('running', () => modelId(modelContext('running', { id: 'turn_0' }, 5)))).toBe('model-before-the-edit');
    expect(await inSession('running', () => modelId(modelContext('running', { id: 'turn_3' }, 40)))).toBe('model-before-the-edit');
    // The next conversation reads the definition as it is now.
    expect(await inSession('next', () => modelId(modelContext('next', { id: 'turn_0' }, 1)))).toBe('model-after-the-edit');
    // ...and the first one is still where it was.
    expect(await inSession('running', () => modelId(modelContext('running', { id: 'turn_4' }, 60)))).toBe('model-before-the-edit');
  });

  it('uses the session and coordinates captured before verification, whatever changes while it waits', async () => {
    let release!: () => void;
    const verification = new Promise<boolean>(resolve => { release = () => resolve(false); });
    const verifySession = vi.spyOn(privateSurface, 'verifyPrivateConsoleSession').mockImplementation(() => verification);
    const verifyModel = vi.spyOn(privateSurface, 'verifyPrivateConsoleModel').mockResolvedValue(undefined);
    try {
      const context = modelContext('original-session', { id: 'turn_2' }, 3) as unknown as { session: { id: string }; turn: { id: string } };
      const resolveAlias = vi.fn(async (_id: string | undefined, _capturedSession: ModelInvocationSession | undefined) => 'fixture-brain');
      const providerCall = vi.fn(async () => {
        expect(currentModelInvocation()).toMatchObject({
          session: { id: 'original-session' },
          event: { type: 'step.started', data: { turnId: 'turn_2', sequence: 2, stepIndex: 3 } },
        });
        throw new Error('captured provider reached');
      });
      const selected = definitionModelResolver({ resolveAlias, provider: () => new MockLanguageModelV3({ doGenerate: providerCall }) })(context as never);
      context.session.id = 'changed-session';
      context.turn.id = 'turn_5';
      release();
      const selection = await selected;
      expect(resolveAlias).toHaveBeenCalledExactlyOnceWith('original-session', session('original-session'));
      expect(verifySession).toHaveBeenCalledWith({ session: session('original-session') });
      await expect((selection.model as MockLanguageModelV3).doGenerate({ prompt: [] })).rejects.toThrow('captured provider reached');
      // The full model check, private persona marker included, runs at the provider boundary.
      expect(verifyModel).toHaveBeenCalledWith({ session: session('original-session') });
      expect(providerCall).toHaveBeenCalledTimes(1);
    } finally { verifySession.mockRestore(); verifyModel.mockRestore(); }
  });

  it('checks the session when the model is selected and the full model authority before any request leaves', async () => {
    // eve 1.0 chooses the model before it evaluates the instructions, so the private persona's
    // marker cannot be required at selection on a conversation's first call. It is required at
    // the provider boundary, which is after the instructions and before the provider.
    const order: string[] = [];
    const verifySession = vi.spyOn(privateSurface, 'verifyPrivateConsoleSession').mockImplementation(async () => { order.push('session'); return true; });
    const verifyModel = vi.spyOn(privateSurface, 'verifyPrivateConsoleModel').mockImplementation(async () => { order.push('model'); throw new Error('Console authority refused'); });
    try {
      const call = vi.fn(async () => { throw new Error('PROVIDER REACHED'); });
      const selection = await definitionModelResolver({ resolveAlias: async () => 'fixture-brain', provider: () => new MockLanguageModelV3({ doGenerate: call, doStream: call }) })(modelContext('private-session'));
      expect(order).toEqual(['session']);
      await expect((selection.model as MockLanguageModelV3).doGenerate({ prompt: [] })).rejects.toThrow('Console authority refused');
      expect(order).toEqual(['session', 'model']);
      expect(call).not.toHaveBeenCalled();
    } finally { verifySession.mockRestore(); verifyModel.mockRestore(); }
  });

  it('selects nothing for a conversation whose session authority is refused', async () => {
    const verifySession = vi.spyOn(privateSurface, 'verifyPrivateConsoleSession').mockRejectedValue(new Error('Console authority refused'));
    try {
      const resolveAlias = vi.fn(async () => 'fixture-brain');
      const provider = vi.fn((alias: string) => new MockLanguageModelV3({ modelId: alias }));
      await expect(definitionModelResolver({ resolveAlias, provider })(modelContext('refused-session'))).rejects.toThrow('Console authority refused');
      expect(resolveAlias).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
    } finally { verifySession.mockRestore(); }
  });

  it('a second evaluation of the same model call shares one single-use invocation', async () => {
    // eve may run the function twice for one model call (a fresh process rebuilding its values,
    // a development double-check). Both selections sit on the same coordinates, so only one of
    // the two model objects can ever reach the provider.
    const call = vi.fn(async () => { throw new Error('PROVIDER REACHED'); });
    const select = definitionModelResolver({ resolveAlias: async () => 'tenant-brain', provider: () => new MockLanguageModelV3({ doGenerate: call, doStream: call }) });
    const rebuilt = await select(modelContext('twice-session', { id: 'turn_0' }, 7));
    const used = await select(modelContext('twice-session', { id: 'turn_0' }, 7));
    await expect((used.model as MockLanguageModelV3).doGenerate({ prompt: [] })).rejects.toThrow('PROVIDER REACHED');
    await expect((rebuilt.model as MockLanguageModelV3).doGenerate({ prompt: [] })).rejects.toThrow('fresh trusted model invocation');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('fails the selection when the definition cannot be read, instead of selecting something else', async () => {
    const provider = vi.fn((alias: string) => new MockLanguageModelV3({ modelId: alias }));
    const select = definitionModelResolver({ resolveAlias: async () => { throw new Error('definition unreadable'); }, provider });
    await expect(select(modelContext('session-two'))).rejects.toThrow('definition unreadable');
    expect(provider).not.toHaveBeenCalled();
  });

  it('fails the selection rather than pin an empty alias', async () => {
    const select = definitionModelResolver({ resolveAlias: async () => '  ', provider: (alias) => new MockLanguageModelV3({ modelId: alias }) });
    await expect(select(modelContext('session-three'))).rejects.toThrow('Session gateway alias is missing');
  });

  it('still refuses at the provider boundary when no definition was resolved for the session', async () => {
    vi.stubEnv('LARES_DEFINITION_DIR', '/synthetic');
    const call = vi.fn(async () => { throw new Error('PROVIDER REACHED'); });
    const select = definitionModelResolver({
      // A resolver that pins an alias without ever marking the session ready — the shape a
      // caller gets wrong when it forgets `resolveDefinitionForModel`.
      resolveAlias: async () => 'tenant-brain',
      provider: () => new MockLanguageModelV3({ doGenerate: call, doStream: call }),
    });
    const selection = await select(modelContext('session-four'));
    await expect((selection.model as MockLanguageModelV3).doGenerate({ prompt: [] })).rejects.toThrow('No valid session definition');
    expect(call).not.toHaveBeenCalled();
  });
});

describe('a managed runtime authority for door and schedule conversations', () => {
  it('reserves the point before any await and attaches the door claim before the provider is reached', async () => {
    const order: string[] = [];
    const providerCall = vi.fn(async () => {
      order.push('provider');
      expect(currentModelInvocation()).toMatchObject({ session: { id: 'door-session' }, alias: 'fixture-brain' });
      expect(hasOwnerJob()).toBe(false);
      throw new Error('door provider reached');
    });
    const managedAuthority = {
      prepare: vi.fn((event: unknown, captured: unknown) => { order.push('prepare'); expect(event).toMatchObject({ data: { turnId: 'turn_1', sequence: 1, stepIndex: 4 } }); expect(captured).toEqual(session('door-session')); }),
      claim: vi.fn(async (invocation: { session: { id: string }; alias: string }) => { order.push('claim'); expect(invocation).toMatchObject({ session: { id: 'door-session' }, alias: 'fixture-brain' }); return 'door' as const; }),
    };
    const select = definitionModelResolver({
      resolveAlias: async () => { order.push('alias'); return 'fixture-brain'; },
      preparePurpose: () => { order.push('purpose-prepare'); },
      claimPurpose: async () => { order.push('purpose-claim'); },
      managedAuthority,
      provider: () => new MockLanguageModelV3({ doGenerate: providerCall }),
    });
    const selection = await select(modelContext('door-session', { id: 'turn_1' }, 4));
    expect(order).toEqual(['purpose-prepare', 'prepare', 'alias', 'purpose-claim', 'claim']);
    await expect((selection.model as MockLanguageModelV3).doGenerate({ prompt: [] })).rejects.toThrow('door provider reached');
    expect(order.at(-1)).toBe('provider');
  });

  it('selects nothing when the managed authority refuses', async () => {
    const provider = vi.fn((alias: string) => new MockLanguageModelV3({ modelId: alias }));
    const select = definitionModelResolver({
      resolveAlias: async () => 'fixture-brain', provider,
      managedAuthority: { prepare: () => undefined, claim: async () => { throw new Error('door refused'); } },
    });
    await expect(select(modelContext('refused-door'))).rejects.toThrow('door refused');
    expect(provider).not.toHaveBeenCalled();
  });

  it('runs a schedule conversation\'s call as an owner job for the pinned alias, inside its own invocation', async () => {
    const seen: unknown[] = [];
    const providerCall = vi.fn(async () => {
      seen.push(hasOwnerJob(), currentOwnerJob(), currentModelInvocation()?.alias);
      throw new Error('owner job provider reached');
    });
    const select = definitionModelResolver({
      resolveAlias: async () => 'fixture-brain',
      managedAuthority: { prepare: () => undefined, claim: async () => 'owner-job' as const },
      provider: () => new MockLanguageModelV3({ doGenerate: providerCall, doStream: providerCall }),
    });
    const selection = await select(modelContext('schedule-session', { id: 'turn_0' }, 2));
    await expect((selection.model as MockLanguageModelV3).doStream({ prompt: [] })).rejects.toThrow('owner job provider reached');
    expect(seen).toEqual([true, { alias: 'fixture-brain' }, 'fixture-brain']);
    expect(hasOwnerJob()).toBe(false);
  });

  it('a call whose route is "none" is not an owner job', async () => {
    const seen: boolean[] = [];
    const select = definitionModelResolver({
      resolveAlias: async () => 'fixture-brain',
      managedAuthority: { prepare: () => undefined, claim: async () => 'none' as const },
      provider: () => new MockLanguageModelV3({ doGenerate: async () => { seen.push(hasOwnerJob()); throw new Error('stop'); } }),
    });
    const selection = await select(modelContext('plain-session'));
    await expect((selection.model as MockLanguageModelV3).doGenerate({ prompt: [] })).rejects.toThrow('stop');
    expect(seen).toEqual([false]);
  });
});

describe('where a model call sits, read off the session view', () => {
  it('takes the turn from its id, the way eve numbers turns, and the step from the stream position', () => {
    expect(modelStepCoordinates(modelContext('s', { id: 'turn_0' }, 0))).toEqual({ type: 'step.started', data: { turnId: 'turn_0', sequence: 0, stepIndex: 0 } });
    expect(modelStepCoordinates(modelContext('s', { id: 'turn_12', status: 'paused' }, 345))).toEqual({ type: 'step.started', data: { turnId: 'turn_12', sequence: 12, stepIndex: 345 } });
  });

  it('reads the position of a real, empty session view as zero', () => {
    const real = { ...modelContext('s'), view: emptySessionView() } as unknown as DynamicModelContext;
    expect(modelStepCoordinates(real).data.stepIndex).toBe(0);
  });

  it.each([
    ['no turn yet', null, 0],
    ['a turn that already settled', { id: 'turn_3', status: 'settled' as const }, 4],
    ['a turn id eve does not mint', { id: 'turn-one' }, 0],
    ['a turn id with a leading zero', { id: 'turn_01' }, 0],
    ['an empty turn id', { id: '' }, 0],
    ['a negative position', { id: 'turn_0' }, -1],
    ['a fractional position', { id: 'turn_0' }, 1.5],
  ])('refuses rather than guess: %s', async (_label, turn, line) => {
    expect(() => modelStepCoordinates(modelContext('s', turn, line))).toThrow('No running turn to select a model for');
    // ...and the resolver built on it selects nothing: no definition read, no provider.
    const resolveAlias = vi.fn(async () => 'tenant-brain');
    const provider = vi.fn((alias: string) => new MockLanguageModelV3({ modelId: alias }));
    await expect(definitionModelResolver({ resolveAlias, provider })(modelContext('s', turn, line))).rejects.toThrow('No running turn to select a model for');
    expect(resolveAlias).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
});

describe('output length', () => {
  for (const method of ['doGenerate', 'doStream'] as const) {
    it(`${method} gets an explicit output limit unless the caller set one`, async () => {
      const seen: Array<number | undefined> = [];
      const call = vi.fn(async (o: { maxOutputTokens?: number }) => { seen.push(o.maxOutputTokens); throw new Error('stop'); });
      const provider = new MockLanguageModelV3({ doGenerate: call as never, doStream: call as never });
      const wrapped = guardDefinitionModel(provider, async () => undefined) as Exclude<ReturnType<typeof guardDefinitionModel>, string>;
      await expect(wrapped[method]({ prompt: [] })).rejects.toThrow('stop');
      await expect(wrapped[method]({ prompt: [], maxOutputTokens: 500 })).rejects.toThrow('stop');
      expect(seen).toEqual([DEFAULT_MAX_OUTPUT_TOKENS, 500]);
    });
  }
});
