/**
 * One-shot text completion over the LiteLLM gateway — the `think`/`llm` dependency both the
 * commercial radar (`ICP`-fit scoring) and the CRM routing classifier need.
 *
 * The old runtime's equivalent (`services/agent-runtime/lib/adapters/digest/gateway-llm.ts`)
 * hand-rolled a raw fetch against the gateway's `/v1/messages` endpoint with an
 * `x-api-key` header. eve-saga already has an established, single way to obtain a model —
 * `lib/gateway-provider.ts`'s `gatewayModel()`, which every other model call in this service
 * goes through — so this wraps that with the AI SDK's `generateText` instead of re-deriving
 * a second HTTP client for the gateway.
 *
 * ORB-225: this service names PURPOSES, not models. Every call site passes (or omits) a
 * `purpose` — `"utility"` (the default: classification, filing, summaries, obligation-intent
 * reads), `"writer"` (a drafted reply a human will read and send), or `"brain"` (reflection,
 * ideation, commercial scoring) — and `resolveModelForPurpose` turns that into a model id in
 * this order: an explicit `opts.model` wins outright (a caller that names a model, e.g. a
 * per-language voice override or `DREAM_MODEL`, means it); failing that, the purpose's own env
 * knob (`UTILITY_MODEL` / `WRITER_MODEL` / `EVE_SAGA_MODEL` for brain — kept as the brain knob
 * for continuity with the agent's own model env); failing that, the purpose's standing alias
 * (`heiberg-utility` / `heiberg-writer` / `heiberg-brain`), which the gateway maps to a real
 * model — so a model swap is a gateway edit, never a code change here.
 */
import { generateText } from "ai";
import { gatewayModel } from "./gateway-provider.js";

export type Purpose = "utility" | "writer" | "brain";

const PURPOSE_ENV: Record<Purpose, string> = {
  utility: "UTILITY_MODEL",
  writer: "WRITER_MODEL",
  brain: "EVE_SAGA_MODEL",
};

/** Exported so a caller that needs to name a purpose's standing alias without restating it
 *  (the dream's spend cap, `lib/dream/spend.ts`) reads it from here rather than typing it
 *  again. */
export const PURPOSE_ALIAS: Record<Purpose, string> = {
  utility: "heiberg-utility",
  writer: "heiberg-writer",
  brain: "heiberg-brain",
};

/** Pure resolution: explicit model > the purpose's env knob > the purpose's alias. Exported
 *  so this precedence is directly testable without a gateway or a generateText call. */
export function resolveModelForPurpose(
  purpose: Purpose,
  env: Record<string, string | undefined>,
  explicit?: string,
): string {
  if (explicit) return explicit;
  const fromEnv = env[PURPOSE_ENV[purpose]];
  if (fromEnv) return fromEnv;
  return PURPOSE_ALIAS[purpose];
}

/**
 * THINKING SHARES `max_tokens`. The `writer` and `brain` aliases sit on models that think before
 * they answer (Fable 5.1: always, cannot be switched off; Opus 5: on by default), and every
 * thinking token is spent out of the same output cap as the visible text. A cap sized for the
 * visible text alone is therefore a cap the model cannot meet.
 *
 * Folkepuls, 2026-09-07 — the first real writer call after ORB-225 pointed `heiberg-writer` at
 * Fable 5.1: the compose call asked for 1024 tokens, the model spent 540–630 of them thinking
 * (gateway spend log, `completion_tokens_details.reasoning_tokens`), and the email JSON came back
 * cut off mid-string on all three attempts. Nothing in this service named the cap; the only trace
 * was a `SyntaxError` in the schedule log.
 *
 * So the floor lives here, beside the purpose→model mapping that decides whether thinking is in
 * play, and applies to every writer/brain call whatever the call site asked for. A cap is a
 * ceiling, not a spend — the model returns what it needs — so raising it costs nothing on a
 * normal reply and only bounds a runaway one (8192 × $50/M output ≈ $0.41 worst case per call).
 * `utility` (Mistral small, no thinking) keeps its caller's cap and the 512 default.
 */
export const THINKING_MODEL_MIN_OUTPUT_TOKENS = 8192;

const DEFAULT_OUTPUT_TOKENS = 512;

const THINKING_PURPOSES: ReadonlySet<Purpose> = new Set<Purpose>(["writer", "brain"]);

/** Pure: the `max_tokens` that actually goes on the wire for a purpose. */
export function outputTokenBudget(purpose: Purpose, requested: number | undefined): number {
  const asked = requested ?? DEFAULT_OUTPUT_TOKENS;
  return THINKING_PURPOSES.has(purpose) ? Math.max(asked, THINKING_MODEL_MIN_OUTPUT_TOKENS) : asked;
}

export interface GatewayCompleteOptions {
  model?: string;
  /** What this completion is FOR — resolves to a model via `resolveModelForPurpose`.
   *  Omitted, this is a "utility" call (classification, filing, summaries). */
  purpose?: Purpose;
  maxOutputTokens?: number;
  /**
   * Attempts BEYOND the first. Omitted, the AI SDK's own default of 2 applies — i.e. three
   * attempts at the wire, silently, which is the right default for a call whose failure costs
   * the caller a feature and whose retry costs a few cents.
   *
   * It is the WRONG default for a capped, per-pass budget: ORB-45 Task 10's obligation intent
   * read documents itself as "no retry, one bounded read per item", and
   * `INTENT_MAX_PER_PASS = 8` is sized as a spend ceiling on that basis. Without this option
   * that claim was false at the wire and the real ceiling was 24 calls. Both intent call sites
   * (`agent/schedules/morning-brief.ts`, `agent/schedules/evening-brief.ts`) now pass 0.
   */
  maxRetries?: number;
  /**
   * Called with the provider's reported usage once the completion returns, when the provider
   * reported one at all. Additive: every existing call site omits it and is unaffected —
   * `generateText` already returns `usage`, this just stops discarding it for a caller that
   * asks. See `lib/dream/spend.ts`'s `actualStepCost` for the first caller.
   */
  onUsage?: (usage: { inputTokens?: number; outputTokens?: number }) => void;
}

/** Calls the gateway for a single completion and returns the plain text. Throws whatever
 *  the AI SDK throws on a transport/HTTP failure — callers that want a best-effort
 *  degrade (e.g. the commercial radar's ICP-fit scoring) wrap this themselves; this
 *  function does not swallow anything. */
export async function gatewayComplete(prompt: string, opts: GatewayCompleteOptions = {}): Promise<string> {
  const purpose = opts.purpose ?? "utility";
  const model = resolveModelForPurpose(purpose, process.env, opts.model);
  const maxOutputTokens = outputTokenBudget(purpose, opts.maxOutputTokens);
  const { text, finishReason, usage } = await generateText({
    model: gatewayModel(model),
    prompt,
    maxOutputTokens,
    // Passed through only when the caller asked: omitting the key entirely leaves the AI SDK's
    // own default in place, so every existing call site (the commercial radar's ICP scoring, the
    // CRM routing classifier, email triage) keeps the retry behaviour it was written against.
    ...(opts.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries }),
  });
  if (opts.onUsage && usage) {
    opts.onUsage({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
  }
  // A reply that stopped on length is a truncated reply, and the caller will usually fail on it
  // downstream in a way that does not name the cause (the Folkepuls compose failed as a JSON
  // SyntaxError three times). Say what happened here, where the cap and the model are known.
  // Warn, don't throw — the text is still returned, exactly as before.
  if (finishReason === "length") {
    console.warn(
      `gatewayComplete: reply from ${model} stopped at maxOutputTokens=${maxOutputTokens} — ` +
        "output truncated (on a thinking model, thinking tokens count against this cap)",
    );
  }
  return text;
}
