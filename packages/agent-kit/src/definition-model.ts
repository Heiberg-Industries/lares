import { wrapLanguageModel, type LanguageModel } from 'ai';
import { defineState } from 'eve/context';
import { defineDynamic } from 'eve/tools';

// A durable session marker, not a process-wide success flag. A repair on disk after a failed
// resolver must not let that already-misconfigured turn run with its neutral compiled prompt.
const ready = defineState<boolean>('lares.definition-model-ready', () => false);
const gatewayAlias = defineState<string | null>('lares.session-gateway-alias', () => null);

/** Persist only the alias, never a provider object or credential. Bare dynamic IDs are
 * routed by Eve through Vercel, so the actual provider is selected at step scope below. */
export function pinSessionGatewayAlias(alias: string): null {
  if (!alias.trim()) throw new Error('Session gateway alias is missing');
  gatewayAlias.update(() => alias);
  return null;
}

/** Reconstruct the provider for the already-pinned alias; never reread the definition
 * mid-conversation. Eve permits live LanguageModel objects only at step scope. */
export function sessionGatewayModel(provider: (alias: string) => LanguageModel): { model: Exclude<LanguageModel, string>; modelContextWindowTokens: number } {
  const alias = gatewayAlias.get();
  if (!alias) throw new Error('Session gateway alias is not pinned');
  return { model: guardDefinitionModel(provider(alias)), modelContextWindowTokens: 200_000 };
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
  readonly resolveAlias: (sessionId: string | undefined) => Promise<string>;
  /** Builds the LiteLLM-backed provider for an alias. Never a bare id string. */
  readonly provider: (alias: string) => LanguageModel;
}) {
  return defineDynamic({
    events: {
      'step.started': async (
        _event: unknown,
        ctx?: { readonly session?: { readonly id?: string } },
      ): Promise<{ model: Exclude<LanguageModel, string>; modelContextWindowTokens: number }> => {
        if (gatewayAlias.get() === null) pinSessionGatewayAlias(await input.resolveAlias(ctx?.session?.id));
        return sessionGatewayModel(input.provider);
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
export function guardDefinitionModel(
  model: LanguageModel,
  resolveReady: () => Promise<unknown> = assertModelDefinitionReady,
): Exclude<LanguageModel, string> {
  if (typeof model === 'string') throw new Error('Definition fallback requires a provider model object');
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate }) => { await resolveReady(); return doGenerate(); },
      wrapStream: async ({ doStream }) => { await resolveReady(); return doStream(); },
    },
  });
}
