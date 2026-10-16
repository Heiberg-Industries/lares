/**
 * One-shot text completion over the LiteLLM gateway — the `llm` dependency the ported studio
 * pipeline needs for its individual stages (each stage is a single prompt-in/text-out call,
 * not a session).
 *
 * Modelled on `services/chief-of-staff/lib/llm-complete.ts`, which wraps this service's single
 * established way of obtaining a model — `lib/gateway-provider.ts`'s `gatewayModel()` — with
 * the AI SDK's `generateText`, rather than re-deriving a second raw HTTP client against the
 * gateway's `/v1/messages` the way the old runtime's
 * `services/agent-runtime/lib/adapters/digest/gateway-llm.ts` did.
 *
 * Model precedence: STUDIO_MODEL first, because the old runtime's studio integration read
 * exactly that env var (the old runtime's registry, now history) — so the box's existing
 * configuration keeps working across the cutover. AGENT_MODEL is the service-wide
 * fallback. The default is the installation's brain alias, `<LARES_MODEL_PREFIX>-brain`: studio stages are ideation,
 * which is the brain purpose, not the old runtime's hard-coded model id.
 *
 * Deliberately NOT sourced from agent.json's `model`: that field is the model the SESSION
 * boots with (agent/agent.ts). A studio stage is free to run on a different, cheaper model
 * without changing which model the creative agent converses as.
 */
import { generateText } from "ai";
import { purposeModel } from "@lares/agent-kit/gateway-status";
import { gatewayModel } from "./gateway-provider.js";

export interface GatewayCompleteOptions {
  model?: string;
  maxOutputTokens?: number;
}

/** Calls the gateway for a single completion and returns the plain text. Throws whatever the
 *  AI SDK throws on a transport/HTTP failure — callers that want a best-effort degrade wrap
 *  this themselves; this function does not swallow anything. */
export async function gatewayComplete(prompt: string, opts: GatewayCompleteOptions = {}): Promise<string> {
  const model =
    opts.model ?? process.env["STUDIO_MODEL"] ?? process.env["AGENT_MODEL"] ?? purposeModel("brain");
  const { text } = await generateText({
    model: gatewayModel(model),
    prompt,
    maxOutputTokens: opts.maxOutputTokens ?? 512,
  });
  return text;
}
