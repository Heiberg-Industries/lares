import { AsyncLocalStorage } from 'node:async_hooks';
import { gatewayRawRequestHash, type GatewayModelPath } from './gateway-admission-protocol.js';
import { modelPurposeDispatchRequest, modelPurposeRequest, MODEL_PURPOSE_DISPATCH_BODY_MAX } from './model-purpose-client.js';

/**
 * Model calls that run outside any conversation: a scheduled job, or a tool that needs a model
 * while some member is chatting. They have no conversation step to claim, so they ask the Keeper
 * for one ticket per physical request instead. The Keeper charges that ticket to the installation
 * owner it has on record. Nothing here names the payer: not the agent, not its environment.
 *
 * This is deliberately its own context, separate from `model-invocation.ts`. A conversation step
 * can never become an owner job, and an owner job can never claim a conversation step.
 */
export const OWNER_JOB_REFUSED = 'Owner job authority is not available';
const ALIAS = /^[a-z][a-z0-9-]{1,63}$/;
export interface OwnerJob { readonly alias: string }
const current = new AsyncLocalStorage<OwnerJob>();
const refuse = (): never => { throw new Error(OWNER_JOB_REFUSED); };

/** Run `call` as an owner job for the named gateway model alias. */
export function withOwnerJob<T>(alias: string, call: () => Promise<T>): Promise<T> {
  if (!ALIAS.test(alias)) refuse();
  return current.run(Object.freeze({ alias }), call);
}

/** Routing hint for the provider adapter: true while inside `withOwnerJob`. */
export function hasOwnerJob(): boolean { return current.getStore() !== undefined; }
export function currentOwnerJob(): OwnerJob | undefined { return current.getStore(); }

/** Ask the Keeper for one ticket for this exact request. The request id is burned before the
 * socket opens (see `modelPurposeRequest`), so a timeout is uncertain and is never retried here. */
export async function prepareOwnerJobIntent(
  alias: string, method: 'POST', path: GatewayModelPath, rawBody: Uint8Array,
): Promise<{ ticket: string; expiresAt: number }> {
  if (!ALIAS.test(alias) || rawBody.byteLength > MODEL_PURPOSE_DISPATCH_BODY_MAX) refuse();
  const requestHash = gatewayRawRequestHash(method, path, rawBody);
  const result = await modelPurposeRequest<{ ticket?: unknown; expiresAt?: unknown }>('job.consume', {
    alias, request: { method, path, requestHash },
  });
  if (typeof result.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.ticket) ||
      typeof result.expiresAt !== 'number' || !Number.isSafeInteger(result.expiresAt) ||
      result.expiresAt <= Date.now()) return refuse();
  return Object.freeze({ ticket: result.ticket, expiresAt: result.expiresAt });
}

/** Prepare a ticket and send the exact bytes through the Keeper. Never falls back to the legacy
 * gateway key: a failed or uncertain transport ends here. */
export async function dispatchOwnerJob(input: {
  alias: string;
  path: GatewayModelPath;
  rawBody: Uint8Array;
  headers?: HeadersInit;
  signal?: AbortSignal;
}): Promise<Response> {
  const prepared = await prepareOwnerJobIntent(input.alias, 'POST', input.path, input.rawBody);
  const headers = new Headers(input.headers);
  headers.delete('authorization');
  headers.delete('x-api-key');
  return modelPurposeDispatchRequest({
    ticket: prepared.ticket, method: 'POST', path: input.path, rawBody: input.rawBody,
    deadline: prepared.expiresAt, headers, signal: input.signal,
  });
}
