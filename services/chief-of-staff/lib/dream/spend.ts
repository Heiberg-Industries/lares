/**
 * A spend cap on the dream cycle's one model call — ADR-0018 report 01's fail-closed-on-unpriced
 * pattern applied to a scheduled learning run: refuse to run at all against a model this file
 * has no price for, rather than assume it is cheap.
 *
 * There is no gateway spend table to read from here. `LEARNING_MODEL_PRICES` only knows the
 * model STRING the dream cycle sends — see its own doc comment for exactly what that can and
 * cannot notice. This is a local, pre-call ceiling, not a measurement of what the gateway
 * actually billed; `actualStepCost` reports the real usage the provider handed back, when it
 * handed one back at all.
 */
import { purposeAlias, type Purpose } from "../llm-complete.js";

type Price = { inPerM: number; outPerM: number };

/**
 * USD per million tokens, per PURPOSE, for the purposes a learning run may use. A PRICE TABLE
 * IN THE ENGINE IS A BELIEF, NOT A FACT: the gateway maps an alias to a real model and bills
 * it, and this table only knows the string we send. It cannot notice an alias repointed at a
 * pricier model — that is a gateway-side change, and key sampler is where it would
 * show up. What it CAN do, and does, is refuse to run at all against a model nobody has
 * priced, which is report 01's fail-closed-on-unpriced pattern.
 *
 * Keyed on the purpose, not on a full model name: every installation has its own alias prefix
 * (`<prefix>-brain`), and the dream's one model call always resolves through the `brain`
 * purpose (`agent/schedules/dream.ts`). An installation that points `DREAM_MODEL` at a
 * different model id must add its own line to `LEARNING_MODEL_PRICES` or the run refuses.
 */
export const LEARNING_PURPOSE_PRICES: Readonly<Partial<Record<Purpose, Price>>> = {
  brain: { inPerM: 5, outPerM: 25 },
};

/** USD per million tokens for named model ids that are not a purpose alias. Empty by default. */
export const LEARNING_MODEL_PRICES: Readonly<Record<string, Price>> = {};

/** The price for a model name: a purpose's standing alias on this installation, else a named
 *  model id with its own line. Undefined means unpriced. */
function priceFor(model: string, env: Record<string, string | undefined>): Price | undefined {
  if (Object.hasOwn(LEARNING_MODEL_PRICES, model)) return LEARNING_MODEL_PRICES[model];
  for (const [purpose, price] of Object.entries(LEARNING_PURPOSE_PRICES) as [Purpose, Price][]) {
    // No prefix set means no alias to recognise; the model is then unpriced, never guessed.
    if (env["LARES_MODEL_PREFIX"] && purposeAlias(purpose, env) === model) return price;
  }
  return undefined;
}

/** The most one reflection step may be expected to cost, in USD. */
export const DREAM_STEP_CAP_USD = 0.5;

export class UnpricedModelError extends Error {}
export class StepTooExpensiveError extends Error {}

/**
 * Before the call: refuse an unpriced model, and refuse a prompt whose WORST case at the
 * applied output cap already exceeds the step cap. Both throw; the schedule turns either into
 * a skipped run with a signal, never a partial one.
 */
export function assertStepAffordable(input: {
  model: string;
  promptChars: number;
  maxOutputTokens: number;
}, env: Record<string, string | undefined> = process.env): { estimateUsd: number } {
  const price = priceFor(input.model, env);
  if (!price) {
    throw new UnpricedModelError(
      `dream: refusing to run against "${input.model}" — it has no entry in ` +
        "lib/dream/spend.ts's LEARNING_MODEL_PRICES, so its cost cannot be bounded. Add a " +
        "price line there before pointing a learning run at it.",
    );
  }

  // A deliberate over-estimate — 1 token ≈ 4 characters is generous for input tokens, and a
  // cap that under-counts is not a cap.
  const estimatedInputTokens = Math.ceil(input.promptChars / 4);
  const estimateUsd =
    (estimatedInputTokens * price.inPerM) / 1_000_000 + (input.maxOutputTokens * price.outPerM) / 1_000_000;

  if (estimateUsd > DREAM_STEP_CAP_USD) {
    throw new StepTooExpensiveError(
      `dream: refusing to run against "${input.model}" — the worst-case cost of this step ` +
        `($${estimateUsd.toFixed(4)}) already exceeds the per-step cap ` +
        `($${DREAM_STEP_CAP_USD.toFixed(2)}). promptChars=${input.promptChars} ` +
        `maxOutputTokens=${input.maxOutputTokens}`,
    );
  }

  return { estimateUsd };
}

/**
 * After the call: the actual cost from the reported usage, for the note and the log. Returns
 * undefined when the provider reported no usage — absence is stated, never guessed as zero —
 * and also when the model has no price, for the same reason `assertStepAffordable` would have
 * refused it before the call.
 */
export function actualStepCost(
  model: string,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  if (!usage) return undefined;
  const price = priceFor(model, env);
  if (!price) return undefined;
  return (
    ((usage.inputTokens ?? 0) * price.inPerM) / 1_000_000 +
    ((usage.outputTokens ?? 0) * price.outPerM) / 1_000_000
  );
}
