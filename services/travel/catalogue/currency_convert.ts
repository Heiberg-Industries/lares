/**
 * agent/tools/currency_convert.ts — real currency conversion (NEW, 2026-08-16 approved
 * improvement, Tier 1 #2 — no old-Marcel equivalent). Thin wrapper only: the Frankfurter
 * HTTP client and the `CurrencyUnavailableError` posture both live in `lib/currency.ts`.
 *
 * Boundary + ORB-51 posture (never a silent wrong number — see MEMORY.md
 * `project_saga_brain_search_bug`, the Brain-search bug's own lesson about ambiguous
 * "empty" results): the model must NEVER estimate, guess, or recall a stale rate from its
 * own training data. `lib/currency.ts`'s `convert()` THROWS a typed
 * `CurrencyUnavailableError` on any network/parse/missing-rate failure rather than returning
 * a fallback number — that throw is left to propagate out of `execute()` here rather than
 * being caught into a soft `{ error }` payload, because a currency figure the group might
 * act on (paying a bill, splitting a cost) is real-money territory, not garnish a model
 * should quietly paper over.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import { makeCurrency, type Currency } from "../lib/currency.js";

let cachedCurrency: Currency | undefined;

function realCurrency(): Currency {
  cachedCurrency ??= makeCurrency({ fetch: telegramFetch });
  return cachedCurrency;
}

export interface CurrencyConvertDeps {
  currency(): Currency;
}

export const defaultCurrencyConvertDeps: CurrencyConvertDeps = { currency: realCurrency };

const inputSchema = z.object({
  amount: z.number(),
  from: z.string().min(3).max(3).describe("3-letter currency code, e.g. EUR"),
  to: z.string().min(3).max(3).describe("3-letter currency code, e.g. NOK"),
});

export function createCurrencyConvertTool(deps: CurrencyConvertDeps) {
  return defineTool({
    description:
      "Convert an amount between two currencies using a REAL, live ECB reference rate " +
      "(Frankfurter). The model must NEVER estimate, guess, or recall a stale exchange rate " +
      "from its own training data — every currency figure the group sees must come from this " +
      "tool. On failure this tool errors out rather than returning a number — never show a " +
      "possibly-wrong amount; tell the group the lookup failed and offer to retry.",
    inputSchema,
    async execute({ amount, from, to }) {
      return deps.currency().convert(amount, from, to);
    },
  });
}

export default createCurrencyConvertTool(defaultCurrencyConvertDeps);
