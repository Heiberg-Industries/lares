import { verifyPrivateConsoleModel } from './private-console-surface.js';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { defineState } from 'eve/context';
import { defineDynamic, type DynamicResolveContext } from 'eve/tools';
export { currentModelInvocation, currentModelPurposeClaim } from './model-invocation.js';
import { captureModelInvocation, runModelInvocation, type ModelInvocation } from './model-invocation.js';

// A durable session marker, not a process-wide success flag. A repair on disk after a failed
// resolver must not let that already-misconfigured turn run with its neutral compiled prompt.
const ready = defineState<boolean>('lares.definition-model-ready', () => false);
const gatewayAlias = defineState<string | null>('lares.session-gateway-alias', () => null);

export const SESSION_MODEL_CONTEXT_WINDOW_TOKENS = 200_000;
export const MODEL_COMPACTION_REFUSED = 'Model compaction requires a fresh trusted invocation';
/** Registered as an awaited compaction.requested hook by each role. Compaction has no
 * fresh purpose-bound invocation yet; refuse before either summary or main HTTP work. */
export function refuseModelCompaction(): never { throw new Error(MODEL_COMPACTION_REFUSED); }

/** Persist only the alias, never a provider object or credential. Bare dynamic IDs are
 * routed by Eve through Vercel, so the actual provider is selected at step scope below. */
export function pinSessionGatewayAlias(alias: string): null {
  if (!alias.trim()) throw new Error('Session gateway alias is missing');
  gatewayAlias.update(() => alias);
  return null;
}

/** Reconstruct the provider for the already-pinned alias; never reread the definition
 * mid-conversation. Eve permits live LanguageModel objects only at step scope. */
export function sessionGatewayModel(provider: (alias: string) => LanguageModel, verifyAuthority: () => Promise<unknown> = async () => {}, invocation?: ModelInvocation): { model: Exclude<LanguageModel, string>; modelContextWindowTokens: number } {
  const alias = gatewayAlias.get();
  if (!alias) throw new Error('Session gateway alias is not pinned');
  return { model: guardDefinitionModel(provider(alias), async () => { await assertModelDefinitionReady(); await verifyAuthority(); }, invocation), modelContextWindowTokens: SESSION_MODEL_CONTEXT_WINDOW_TOKENS };
}

/**
 * THE AGENT `model`. One event, `step.started`, and deliberately no other.
 *
 * eve 0.33.0 removed the compiled `fallback` this used to carry, and eve 0.60.1 enforces two
 * rules that together leave exactly one legal shape
 * (`node_modules/eve/dist/src/runtime/agent/resolve-model.js`):
 *
 *  - a declared handler MUST return a concrete selection — "Dynamic model resolver returned no
 *    model"; the old `session.started` handler returned `null`, which now throws;
 *  - `session.started` and `turn.started` are resolved with `durability: "durable"`, and a
 *    durable selection may not be a provider object — "Return a model id string, or use a
 *    `step.started` model resolver".
 *
 * A model-id string is the one thing this project must never hand eve: eve resolves a bare id
 * through the Vercel AI Gateway, and every model call here goes through the self-hosted LiteLLM
 * gateway instead. So the definition read moves to the session's FIRST step and the alias is
 * pinned in durable session state; later steps rebuild the provider from the pin without
 * re-reading anything. eve runs `step.started` immediately before it resolves the model for
 * every step (`dist/src/harness/tool-loop.js`) and a throw here lands in `failModelSelection`,
 * so the failure mode is a failed turn, never a different model.
 */
export function definitionModel(input: {
  /** One read of this agent's definition; returns the gateway alias to talk to. */
  readonly resolveAlias: (sessionId: string | undefined, session: DynamicResolveContext['session'] | undefined) => Promise<string>;
  /** Optional synchronous role-specific reservation before authority verification awaits.
   * This may only mark trusted framework coordinates locally; it must not grant authority. */
  readonly preparePurpose?: (event: unknown, session: DynamicResolveContext['session'] | undefined) => void;
  /** Optional role-specific authority adapter. Roles without one retain their current path. */
  readonly claimPurpose?: (invocation: ModelInvocation) => Promise<void>;
  /** Builds the LiteLLM-backed provider for an alias. Never a bare id string. */
  readonly provider: (alias: string) => LanguageModel;
}) {
  return defineDynamic({
    events: {
      'step.started': async (
        event: unknown,
        ctx?: DynamicResolveContext,
      ): Promise<{ model: Exclude<LanguageModel, string>; modelContextWindowTokens: number }> => {
        // Capture the authenticated session before awaiting: later resolver work must not
        // change the authority closed over by this selected model.
        const authorityContext = structuredClone({ session: ctx?.session });
        const stepEvent = structuredClone(event);
        input.preparePurpose?.(stepEvent, authorityContext.session);
        const verifyAuthority = () => verifyPrivateConsoleModel(authorityContext);
        await verifyAuthority();
        if (gatewayAlias.get() === null) pinSessionGatewayAlias(await input.resolveAlias(authorityContext.session?.id, authorityContext.session));
        const invocation = captureModelInvocation(stepEvent, authorityContext.session, gatewayAlias.get()!);
        await input.claimPurpose?.(invocation);
        return sessionGatewayModel(input.provider, verifyAuthority, invocation);
      },
    },
  });
}

export async function resolveDefinitionForModel<T>(resolve: () => Promise<T>): Promise<T> {
  if (!process.env.LARES_DEFINITION_DIR?.trim()) return resolve();
  ready.update(() => false);
  const result = await resolve();
  ready.update(() => true);
  return result;
}

export async function assertModelDefinitionReady(): Promise<void> {
  if (process.env.LARES_DEFINITION_DIR?.trim() && !ready.get()) {
    throw new Error('No valid session definition was resolved; refusing the compiled model fallback');
  }
}

/** Eve catches dynamic model resolver errors and uses its compiled fallback. Check readiness
 * at the provider boundary too. Construction performs no I/O. The normal session resolver
 * sets the marker only after loading either a valid folder or its validated last-valid cache.
 * Both streaming modes are guarded, before the underlying model/provider can execute.
 */
/**
 * The most a single reply may produce. The AI SDK does not know a gateway purpose alias
 * (`lares-brain`, …), assumes an unknown model is an old one and silently caps the reply at 4096
 * output tokens, which cuts long briefs off mid-sentence. Applied only when the caller set no
 * limit of its own, so a call that asks for less (or more) is untouched. Chosen to sit under the
 * output ceiling of every current model the gateway can route to.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

export function guardDefinitionModel(
  model: LanguageModel,
  resolveReady: () => Promise<unknown> = assertModelDefinitionReady,
  invocation?: ModelInvocation,
): Exclude<LanguageModel, string> {
  if (typeof model === 'string') throw new Error('Definition fallback requires a provider model object');
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: async ({ params }) =>
        params.maxOutputTokens === undefined ? { ...params, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS } : params,
      wrapGenerate: async ({ doGenerate }) => {
        const call = async () => { await resolveReady(); return doGenerate(); };
        return invocation ? runModelInvocation(invocation, call) : call();
      },
      wrapStream: async ({ doStream }) => {
        const call = async () => { await resolveReady(); return doStream(); };
        return invocation ? runModelInvocation(invocation, call) : call();
      },
    },
  });
}
