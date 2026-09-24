import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { guardDefinitionModel, resolveDefinitionForModel, assertModelDefinitionReady, pinSessionGatewayAlias, sessionGatewayModel, definitionModel } from '../src/definition-model.js';

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
 * The agent `model` itself, since eve 0.60.
 *
 * eve 0.33.0 removed `defineDynamic({ fallback })` ("Dynamic models and subagents now resolve
 * without compiled fallbacks or placeholder configs. `defineDynamic` accepts only `events`",
 * node_modules/eve/CHANGELOG.md, ccaa596), and 0.60.1 refuses both halves of the old shape at
 * runtime: a handler returning nothing throws ("Every matching dynamic model handler must
 * return a concrete model selection") and a session- or turn-scoped handler may not return a
 * provider object at all ("durable model selections must be serializable. Return a model id
 * string, or use a \"step.started\" model resolver") — both in
 * node_modules/eve/dist/src/runtime/agent/resolve-model.js.
 *
 * A model-id STRING at session scope is the one thing this project cannot ship: eve would route
 * it through the Vercel AI Gateway, past the self-hosted LiteLLM gateway every model call must
 * use. So the resolver declares ONE event, `step.started`, which is the only scope where a
 * constructed provider object is legal — and the definition read that used to happen at
 * `session.started` happens on the session's first step instead, pinned in durable session
 * state so no later step re-reads it.
 */
describe('the agent model resolver', () => {
  const stepOf = (resolver: ReturnType<typeof definitionModel>) => {
    const step = resolver.events['step.started'];
    if (step === undefined) throw new Error('the resolver declares no step.started handler');
    return step;
  };

  it('declares step.started and nothing else, so no scope can hand eve a routable id', () => {
    const resolver = definitionModel({ resolveAlias: async () => 'tenant-brain', provider: (alias) => new MockLanguageModelV3({ modelId: alias }) });
    expect(Object.keys(resolver.events)).toEqual(['step.started']);
    // eve reads exactly this at build time: `eventNames: Object.keys(o.events)` in
    // node_modules/eve/dist/src/compiler/normalize-agent-config.js.
    expect(resolver.kind).toBe('eve:dynamic');
  });

  it('reads the definition once and reuses the pin on every later step of the session', async () => {
    const resolveAlias = vi.fn(async (_sessionId: string | undefined) => 'tenant-brain');
    const provider = vi.fn((alias: string) => new MockLanguageModelV3({ modelId: alias }));
    const step = stepOf(definitionModel({ resolveAlias, provider }));
    const first = await step(undefined, { session: { id: 'session-one' } } as never);
    const second = await step(undefined, { session: { id: 'session-one' } } as never);
    // ONE read for the conversation — the contract `session.started` used to carry.
    expect(resolveAlias.mock.calls).toEqual([['session-one']]);
    // ...and every step still rebuilds the provider from the pinned alias, because eve keeps a
    // live provider object only for the step it was selected in.
    expect(provider.mock.calls).toEqual([['tenant-brain'], ['tenant-brain']]);
    expect(first.model).not.toBeTypeOf('string');
    expect((second.model as { modelId: string }).modelId).toBe('tenant-brain');
    expect(second.modelContextWindowTokens).toBe(200_000);
  });

  it('fails the step when the definition cannot be read, instead of selecting something else', async () => {
    const provider = vi.fn((alias: string) => new MockLanguageModelV3({ modelId: alias }));
    const step = stepOf(definitionModel({ resolveAlias: async () => { throw new Error('definition unreadable'); }, provider }));
    await expect(step(undefined, { session: { id: 'session-two' } } as never)).rejects.toThrow('definition unreadable');
    expect(provider).not.toHaveBeenCalled();
  });

  it('fails the step rather than pin an empty alias', async () => {
    const step = stepOf(definitionModel({ resolveAlias: async () => '  ', provider: (alias) => new MockLanguageModelV3({ modelId: alias }) }));
    await expect(step(undefined, { session: { id: 'session-three' } } as never)).rejects.toThrow('Session gateway alias is missing');
  });

  it('still refuses at the provider boundary when no definition was resolved for the session', async () => {
    vi.stubEnv('LARES_DEFINITION_DIR', '/synthetic');
    const call = vi.fn(async () => { throw new Error('PROVIDER REACHED'); });
    const step = stepOf(definitionModel({
      // A resolver that pins an alias without ever marking the session ready — the shape a
      // caller gets wrong when it forgets `resolveDefinitionForModel`.
      resolveAlias: async () => 'tenant-brain',
      provider: () => new MockLanguageModelV3({ doGenerate: call, doStream: call }),
    }));
    const selection = await step(undefined, { session: { id: 'session-four' } } as never);
    await expect((selection.model as MockLanguageModelV3).doGenerate({ prompt: [] })).rejects.toThrow('No valid session definition');
    expect(call).not.toHaveBeenCalled();
  });
});
