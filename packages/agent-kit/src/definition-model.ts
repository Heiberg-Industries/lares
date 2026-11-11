import { verifyPrivateConsoleModel, verifyPrivateConsoleSession } from './private-console-surface.js';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { defineState } from 'eve/context';
import { position } from 'eve/events';
import { defineDynamic, type DynamicModelContext } from 'eve/models';
export { currentModelInvocation, currentModelPurposeClaim } from './model-invocation.js';
import { captureModelInvocation, runModelInvocation, type ModelInvocation, type ModelInvocationSession } from './model-invocation.js';

// A durable session marker, not a process-wide success flag. A repair on disk after a failed
// resolver must not let that already-misconfigured turn run with its neutral compiled prompt.
const ready = defineState<boolean>('lares.definition-model-ready', () => false);
const gatewayAlias = defineState<string | null>('lares.session-gateway-alias', () => null);

export const SESSION_MODEL_CONTEXT_WINDOW_TOKENS = 200_000;
export const MODEL_COMPACTION_REFUSED = 'Model compaction requires a fresh trusted invocation';
export const MODEL_SELECTION_REFUSED = 'No running turn to select a model for';

// Sessions whose history is being compacted RIGHT NOW, in this process. eve 1.0 awaits the
// `context.started` hook before the summary call, in the same process, but no longer lets that
// hook stop the call by throwing: a hook error only fails the turn at its next checkpoint, after
// the summary request has already left. The summary is sent through the turn's own selected
// model, so the guard below reads this set and refuses before the provider is reached.
// Process-local on purpose: the hook and the call it guards are one uninterrupted sequence, and
// a durable marker would outlive a compaction that never reports its end.
const compacting = new Set<string>();
const MAX_COMPACTING_SESSIONS = 4_096;

/** Registered on `context.started` (any kind but a plain clear) by each role. Compaction has no
 * fresh purpose-bound invocation of its own; it must spend neither the main step's claim nor an
 * unclaimed call. Marks the session, then throws so the turn fails as well. With no session id
 * the mark cannot be scoped, and with the set full it cannot be kept: either way every guarded
 * call in this process is refused until restart, never let through. */
export function refuseModelCompaction(sessionId?: string): never {
  const scoped = typeof sessionId === 'string' && sessionId !== '' && compacting.size < MAX_COMPACTING_SESSIONS;
  compacting.add(scoped ? sessionId : '*');
  throw new Error(MODEL_COMPACTION_REFUSED);
}

/** Registered on `context.settled`: the compaction is over, whatever its outcome. */
export function modelCompactionSettled(sessionId?: string): void {
  if (typeof sessionId === 'string' && sessionId) compacting.delete(sessionId);
}

function assertNotCompacting(sessionId: string | undefined): void {
  if (compacting.has('*') || (sessionId !== undefined && compacting.has(sessionId))) throw new Error(MODEL_COMPACTION_REFUSED);
}

/** Persist only the alias, never a provider object or credential. A bare model id is routed by
 * eve through the Vercel AI Gateway, so the provider object is rebuilt on every selection. */
export function pinSessionGatewayAlias(alias: string): null {
  if (!alias.trim()) throw new Error('Session gateway alias is missing');
  gatewayAlias.update(() => alias);
  return null;
}

/** Reconstruct the provider for the already-pinned alias; never reread the definition
 * mid-conversation. */
export function sessionGatewayModel(provider: (alias: string) => LanguageModel, verifyAuthority: () => Promise<unknown> = async () => {}, invocation?: ModelInvocation): { model: Exclude<LanguageModel, string>; modelContextWindowTokens: number } {
  const alias = gatewayAlias.get();
  if (!alias) throw new Error('Session gateway alias is not pinned');
  return { model: guardDefinitionModel(provider(alias), async () => { await assertModelDefinitionReady(); await verifyAuthority(); }, invocation), modelContextWindowTokens: SESSION_MODEL_CONTEXT_WINDOW_TOKENS };
}

/** A model call's coordinates, in the record Keeper and the budget store already authenticate. */
export interface ModelStepEvent {
  readonly type: 'step.started';
  readonly data: { readonly turnId: string; readonly sequence: number; readonly stepIndex: number };
}

/**
 * Where the next model call sits, read off eve's own session view.
 *
 * eve 1.0 hands a dynamic `model` no event (0.60.1 passed `step.started` with `turnId`,
 * `sequence` and `stepIndex`), and its public context carries no step counter. What it does
 * carry, the same in every process:
 *
 *  - `ctx.turn.id`, the latest turn. eve mints turn ids as `turn_<n>` with `n` the turn's
 *    zero-based position in the session (`dist/src/protocol/session-projection.js`,
 *    `turnCoordinates`; `harness/session-machine/view.js`, `activeTurnId`), and reports that same
 *    `n` to tools and hooks as `ctx.session.turn.sequence`. So `sequence` is parsed from the id,
 *    exactly as eve's own `turnSequence` does, and an id in any other shape is refused rather
 *    than guessed at.
 *  - `position(ctx.view)`, the session stream's position as of its latest commit. Every model
 *    call records new lines before the next one is selected, so the position is different for
 *    every model call of a session and identical for two evaluations of the same one. It stands
 *    in for `stepIndex`, which every consumer treats as an opaque non-negative integer. It is no
 *    longer "the nth step of the turn": eve prunes settled runs from the view, so that count
 *    cannot be read back.
 *
 * A turn that already settled is refused: nothing may select a model between turns.
 */
export function modelStepCoordinates(ctx: Pick<DynamicModelContext, 'turn' | 'view'>): ModelStepEvent {
  const turn = ctx.turn;
  if (!turn || typeof turn.id !== 'string' || turn.status === 'settled') throw new Error(MODEL_SELECTION_REFUSED);
  const parsed = /^turn_(0|[1-9]\d{0,14})$/.exec(turn.id);
  const stepIndex = position(ctx.view);
  if (!parsed || !Number.isSafeInteger(stepIndex) || stepIndex < 0) throw new Error(MODEL_SELECTION_REFUSED);
  return { type: 'step.started', data: { turnId: turn.id, sequence: Number(parsed[1]), stepIndex } };
}

export interface DefinitionModelInput {
  /** One read of this agent's definition; returns the gateway alias to talk to. */
  readonly resolveAlias: (sessionId: string | undefined, session: ModelInvocationSession | undefined) => Promise<string>;
  /** Optional synchronous role-specific reservation before authority verification awaits.
   * This may only mark trusted framework coordinates locally; it must not grant authority. */
  readonly preparePurpose?: (event: unknown, session: ModelInvocationSession | undefined) => void;
  /** Optional role-specific authority adapter. Roles without one retain their current path. */
  readonly claimPurpose?: (invocation: ModelInvocation) => Promise<void>;
  /** Builds the LiteLLM-backed provider for an alias. Never a bare id string. */
  readonly provider: (alias: string) => LanguageModel;
}

/**
 * The function behind {@link definitionModel}, exported so a test can call it with a made-up
 * context instead of reaching into eve's opaque `defineDynamic()` value.
 *
 * eve 1.0 calls it before every ordinary model call (`docs/dynamic-configuration/index.md`), and
 * may call it again for the same call: once more in a fresh process that rebuilds its values
 * before the step runs, and twice in development. So:
 *
 *  - the definition is read ONCE per conversation. The alias is pinned in durable session state
 *    on the first call and every later call rebuilds the provider from the pin, so a definition's
 *    model change reaches the next conversation and never one already running. State, not
 *    `ctx.memo`: a memo is discarded when the image changes, which would move a running
 *    conversation to the new model mid-thread;
 *  - a repeated run for the same coordinates shares one single-use claim (`model-invocation.ts`),
 *    so it can never produce a second model call;
 *  - every failure THROWS. Before a model call that fails the turn (`REACTION_FAILED`); eve has
 *    no compiled fallback model to fall through to.
 *
 * A model-id string is the one thing this project must never hand eve: eve resolves a bare id
 * through the Vercel AI Gateway, and every model call here goes through the self-hosted LiteLLM
 * gateway instead. The selection is therefore always a provider object with its context window.
 */
export function definitionModelResolver(input: DefinitionModelInput) {
  return async (ctx: DynamicModelContext): Promise<{ model: Exclude<LanguageModel, string>; modelContextWindowTokens: number }> => {
    // Capture the authenticated session and the coordinates before awaiting: later resolver
    // work must not change the authority closed over by this selected model.
    const stepEvent = modelStepCoordinates(ctx);
    const authorityContext = structuredClone({ session: ctx.session });
    input.preparePurpose?.(stepEvent, authorityContext.session);
    // Two checks, because eve 1.0 chooses the model BEFORE it evaluates the instructions
    // (`dist/src/definitions/step.js`, `evaluateStepValues`), where 0.60.1 resolved the persona
    // at session start, ahead of the first step. `verifyPrivateConsoleModel` also requires the
    // private persona to have been installed, which on a conversation's first model call has
    // not happened yet at this point. So the session's own authority is verified here, and the
    // full model check, persona marker included, runs at the provider boundary, after the
    // instructions and before any request leaves (`guardDefinitionModel`).
    await verifyPrivateConsoleSession(authorityContext);
    const verifyAuthority = () => verifyPrivateConsoleModel(authorityContext);
    if (gatewayAlias.get() === null) pinSessionGatewayAlias(await input.resolveAlias(authorityContext.session?.id, authorityContext.session));
    const invocation = captureModelInvocation(stepEvent, authorityContext.session, gatewayAlias.get()!);
    await input.claimPurpose?.(invocation);
    return sessionGatewayModel(input.provider, verifyAuthority, invocation);
  };
}

/** THE AGENT `model`: eve 1.0's one-function dynamic form around {@link definitionModelResolver}. */
export function definitionModel(input: DefinitionModelInput) {
  return defineDynamic(definitionModelResolver(input));
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

/** Readiness is checked at the provider boundary too, not only when the model is selected: a
 * selected model object can be reused (a fresh process rebuilding its values, a compaction
 * summary). Construction performs no I/O. The normal session resolver sets the marker only
 * after loading either a valid folder or its validated last-valid cache. Both streaming modes
 * are guarded, before the underlying model/provider can execute, and a session whose history is
 * being compacted is refused first (see `refuseModelCompaction`).
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
        assertNotCompacting(invocation?.session.id);
        const call = async () => { await resolveReady(); return doGenerate(); };
        return invocation ? runModelInvocation(invocation, call) : call();
      },
      wrapStream: async ({ doStream }) => {
        assertNotCompacting(invocation?.session.id);
        const call = async () => { await resolveReady(); return doStream(); };
        return invocation ? runModelInvocation(invocation, call) : call();
      },
    },
  });
}
