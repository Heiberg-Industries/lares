/**
 * packages/agent-kit/tests/live/probe-invocation.mts — shared by the hand-run gateway probes
 * (`gateway-prompt-cache`, `gateway-lane-anthropic`, `gateway-lane-openai-compatible`). Not a
 * probe itself, so it has no `.live.mts` extension.
 *
 * WHY. `gatewayModel()`'s fetch refuses every physical request that is not inside a fresh
 * trusted model invocation ("A fresh trusted model invocation is required",
 * `claimModelDispatch()` in `../../src/model-invocation.ts`). In an agent, the model resolver
 * opens one per model call (`../../src/definition-model.ts`). A probe has no eve session, so
 * each of its model calls opens one here, through the same exported functions:
 * `captureModelInvocation` with fresh coordinates, then `runModelInvocation` around the call.
 * This is the shape `../gateway-provider.test.ts` uses for its own unit tests.
 *
 * WHAT IT ADDS TO THE REQUEST: nothing. No model-purpose claim is attached and no owner job is
 * opened, so the provider takes its plain route: the key from `GATEWAY_KEY_FILE`, the same
 * headers and body as before the guard existed. An ordinary LiteLLM gateway sees exactly the
 * request it saw before. On a managed runtime (`LARES_MODEL_PURPOSE_RUNTIME_SOCKET` set) the
 * provider refuses to read a key file at all, so these probes do not run there.
 *
 * One invocation allows exactly ONE physical request. A retry inside the same invocation is
 * refused, so every probe call passes `maxRetries: 0` and a failure shows the gateway's own error.
 */
import { randomUUID } from "node:crypto";
import { captureModelInvocation, runModelInvocation } from "../../src/model-invocation.js";

const PROBE_SESSION = { id: `live-probe-${randomUUID()}`, auth: { current: null, initiator: null } };

/** Runs one model call (one `generateText`, or one `streamText` together with reading its
 *  stream) inside its own fresh invocation. `alias` is the alias under test, as an agent's
 *  invocation would carry it; it is not sent anywhere. */
export function inProbeInvocation<T>(alias: string, call: () => Promise<T>): Promise<T> {
  const invocation = captureModelInvocation(
    { type: "step.started", data: { turnId: randomUUID(), sequence: 0, stepIndex: 0 } },
    PROBE_SESSION,
    alias,
  );
  return runModelInvocation(invocation, call);
}
