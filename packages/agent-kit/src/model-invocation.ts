import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { DynamicResolveContext } from 'eve/tools';

export const MODEL_INVOCATION_REFUSED = 'A fresh trusted model invocation is required';

type Session = DynamicResolveContext['session'];
type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;

/** Coordinates come from Eve's actual step.started event, not its resolver context.
 * The session snapshot preserves initiator and current authentication separately, including
 * an exact approval resume. Eve can emit the exact empty turnId after a pending action
 * settles; preserve it with its actual sequence/stepIndex instead of inventing a turn.
 * This object is server context, never model input or telemetry. */
export interface ModelInvocation {
  readonly event: { readonly type: 'step.started'; readonly data: {
    readonly turnId: string; readonly sequence: number; readonly stepIndex: number;
  } };
  readonly session: Frozen<Session>;
  readonly alias: string;
}
interface Claim { entered: boolean; dispatched: boolean }
const claims = new WeakMap<ModelInvocation, Claim>();
// A repeated resolver event must share its burned claim even if it constructs a new model.
// Never evict tombstones and silently rearm an old event. This bounded process-local guard
// refuses new selections when full; durable admission owns restart/erasure-safe suppression.
const stepClaims = new Map<string, Claim>();
const MAX_PROCESS_STEP_CLAIMS = 65_536;
const current = new AsyncLocalStorage<ModelInvocation>();
const refuse = (): never => { throw new Error(MODEL_INVOCATION_REFUSED); };

function freeze<T>(value: T): Frozen<T> {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value as Frozen<T>;
}

/** Called only by the trusted dynamic model resolver after authority verification. Shape
 * validation does not authenticate a session. Never construct coordinates from counters,
 * client claims, prior selections, or a fallback when the framework event is absent. */
export function captureModelInvocation(event: unknown, session: Session | undefined, alias: string): ModelInvocation {
  const e = event as { type?: unknown; data?: { turnId?: unknown; sequence?: unknown; stepIndex?: unknown } } | null;
  if (e?.type !== 'step.started' || typeof e.data?.turnId !== 'string' || (e.data.turnId !== '' && !e.data.turnId.trim()) ||
      !Number.isSafeInteger(e.data.sequence) || (e.data.sequence as number) < 0 ||
      !Number.isSafeInteger(e.data.stepIndex) || (e.data.stepIndex as number) < 0 ||
      !session?.id?.trim() || !session.auth || !Object.hasOwn(session.auth, 'current') ||
      !Object.hasOwn(session.auth, 'initiator') || !alias.trim()) refuse();
  const invocation = freeze(structuredClone({
    event: { type: 'step.started' as const, data: {
      turnId: e!.data!.turnId as string, sequence: e!.data!.sequence as number, stepIndex: e!.data!.stepIndex as number,
    } }, session: session!, alias,
  }));
  const key = createHash('sha256').update(JSON.stringify([session!.id, invocation.event.data.turnId,
    invocation.event.data.sequence, invocation.event.data.stepIndex])).digest('hex');
  let claim = stepClaims.get(key);
  if (!claim) {
    if (stepClaims.size >= MAX_PROCESS_STEP_CLAIMS) refuse();
    claim = { entered: false, dispatched: false };
    stepClaims.set(key, claim);
  }
  claims.set(invocation, claim);
  return invocation;
}

/** Enter once, before any asynchronous verification or provider work. Eve's outer retries
 * and recovery reuse the selected model and cannot acquire a fresh invocation this way. */
export function runModelInvocation<T>(invocation: ModelInvocation, call: () => Promise<T>): Promise<T> {
  const claim = claims.get(invocation);
  if (!claim || claim.entered) refuse();
  claim!.entered = true;
  return current.run(invocation, call);
}

/** Read-only for later admission adapters. Absence never establishes authority. */
export function currentModelInvocation(): ModelInvocation | undefined { return current.getStore(); }

/** The final physical fetch seam calls this after shaping the body, immediately before
 * dispatch. Burn synchronously, including on failed/aborted/uncertain HTTP outcomes. */
export function claimModelDispatch(): ModelInvocation {
  const invocation = current.getStore();
  const claim = invocation && claims.get(invocation);
  if (!invocation || !claim?.entered || claim.dispatched) refuse();
  claim!.dispatched = true;
  return invocation!;
}
