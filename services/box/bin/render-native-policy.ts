/**
 * Builds the reviewed model-budget policy from what the owner confirmed in `lares budget setup`:
 * the model, its prices and the two monthly limits. Run in a container of the engine image with no
 * network and no mounts, so the money arithmetic stays in the engine and is never restated in
 * shell or Python. Reads one JSON request on stdin, writes one JSON result on stdout.
 *
 * Exit codes: 0 the policy was written · 1 refused; the reason is on stderr, nothing was written.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalBudgetMoney } from "@lares/agent-kit/budget-admission-store";
import { gatewayCanonical, gatewayHash } from "@lares/agent-kit/gateway-admission-protocol";
import { gatewayMaximumLiability, gatewayPricingSchema } from "@lares/agent-kit/gateway-pricing";
import { rejectDuplicateJsonKeys } from "../../keeper/lib/budget-native-client.js";
import { parseBudgetNativePolicyDocument, type BudgetNativePolicyDocument } from "../../keeper/lib/budget-native-host.js";
import { gatewayAdmissionProfile, gatewayOptionsFromSettings, PURPOSE_MODEL_PURPOSES, type PurposeModelPurpose } from "../lib/gateway-config.js";

/** Largest prompt, in tokens, one model call may carry. It sets the amount held per call. */
export const REVIEWED_INPUT_TOKENS = 100_000;

export interface NativePolicyRequest {
  readonly alias: string;
  readonly providerModel: string;
  /** A model of its own for the writer, utility or gate purpose, as in installation.env. The reviewed capability must be the
   *  exact profile the gateway runs, so these are carried into it, and each needs its own entry in `aliasPrices`. */
  readonly purposeModels?: Readonly<Partial<Record<PurposeModelPurpose, string>>>;
  /** The embedding model, as in installation.env. It is priced on input tokens alone, through `aliasPrices`. */
  readonly embedding?: { readonly model: string; readonly baseUrl: string; readonly maxInputTokens?: number | string };
  readonly gatewayUrl: string;
  readonly installationLimit: string;
  readonly personLimit: string;
  /** The brain's prices. A purpose that runs the brain's model is priced with these too. */
  readonly prices: AliasPrices;
  /** Prices by served alias (for example "lares-writer") for each alias that runs a model of its own. The embedding alias
   *  needs only `input`; its other rates are always zero. */
  readonly aliasPrices?: Readonly<Record<string, Partial<AliasPrices>>>;
}

export interface AliasPrices { readonly input: string; readonly output: string; readonly cacheRead: string; readonly cacheWrite: string }

export interface PricedAlias {
  readonly alias: string;
  /** `provider/model` for a chat alias, the bare model name for the embedding alias. */
  readonly model: string;
  readonly prices: AliasPrices;
}

export interface NativePolicyResult {
  readonly policy: BudgetNativePolicyDocument;
  /** The brain's, as before. */
  readonly maximumLiability: string;
  readonly model: string;
  /** Every served alias with the prices its policy carries, in policy order (the brain first). */
  readonly pricedAliases: readonly PricedAlias[];
  readonly installationLimit: string;
  readonly personLimit: string;
  readonly prices: AliasPrices;
}

function units(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
}

function positiveMoney(value: unknown, label: string): string {
  try {
    const canonical = canonicalBudgetMoney(String(value));
    if (canonical === "0" || canonical.length > 37) throw new Error();
    // The gateway's budget fields are JSON numbers; a value they cannot carry exactly is refused.
    if (canonicalBudgetMoney(String(Number(canonical))) !== canonical || Number(canonical) > 1_000_000_000) throw new Error();
    return canonical;
  } catch {
    throw new Error(`${label} must be a positive amount in US dollars, for example 50 or 12.50.`);
  }
}

function price(value: unknown, label: string): string {
  try { return canonicalBudgetMoney(String(value)); }
  catch { throw new Error(`The ${label} price must be a number of US dollars per million tokens, for example 2.5.`); }
}

export function renderNativePolicy(request: NativePolicyRequest): NativePolicyResult {
  const installationLimit = positiveMoney(request.installationLimit, "The installation limit");
  const personLimit = positiveMoney(request.personLimit, "The per-person limit");
  if (units(personLimit) > units(installationLimit))
    throw new Error(`The per-person limit ($${personLimit}) is above the installation limit ($${installationLimit}).`);
  const requested = request.purposeModels ?? {};
  if (typeof requested !== "object" || Object.keys(requested).some(name => !(PURPOSE_MODEL_PURPOSES as readonly string[]).includes(name)))
    throw new Error("Only the writer, utility and gate purposes can name a model of their own.");
  const capability = gatewayAdmissionProfile(gatewayOptionsFromSettings({
    LARES_MODEL_ALIAS: request.alias, LARES_MODEL: request.providerModel,
    LARES_MODEL_WRITER: requested.writer, LARES_MODEL_UTILITY: requested.utility, LARES_MODEL_GATE: requested.gate,
    ...(request.embedding ? {
      LARES_EMBED_MODEL: request.embedding.model, LARES_EMBED_BASE_URL: request.embedding.baseUrl,
      ...(request.embedding.maxInputTokens === undefined ? {} : { LARES_EMBED_MAX_INPUT_TOKENS: String(request.embedding.maxInputTokens) }),
    } : {}),
  }));
  const prices = {
    input: price(request.prices.input, "input"),
    output: price(request.prices.output, "output"),
    cacheRead: price(request.prices.cacheRead, "cache read"),
    cacheWrite: price(request.prices.cacheWrite, "cache write"),
  };
  const capabilityHash = gatewayHash(gatewayCanonical(capability));
  const extraPrices = request.aliasPrices ?? {};
  if (typeof extraPrices !== "object" || Object.keys(extraPrices).some(name => !capability.aliases.includes(name) || name === request.alias))
    throw new Error("A price was given for an alias this gateway does not serve.");
  const embedding = capability.embedding;
  const ownModels = (capability.purposeModels ?? {}) as Record<string, string>;
  const gatewayOrigin = new URL(request.gatewayUrl).origin;
  const endpointHash = createHash("sha256").update(`lares.native-endpoint.v1\0${gatewayOrigin}\0${capability.providerBaseUrl}`).digest("hex");

  // One policy per served alias, the brain's first. They share the team, user and membership blocks and differ in the key's
  // alias, the model's rates and the limits one call may hold.
  const entries = capability.aliases.map(alias => {
    let aliasPrices: AliasPrices, format: "openai" | "anthropic" | "embedding", limits: { inputTokens: number; outputTokens: number }, model: string;
    if (embedding && alias === embedding.alias) {
      const given = extraPrices[alias];
      if (!given || given.input === undefined) throw new Error(`The embedding model ${embedding.model} (${alias}) needs an input price.`);
      aliasPrices = { input: price(given.input, `${alias} input`), output: "0", cacheRead: "0", cacheWrite: "0" };
      format = "embedding";
      limits = { inputTokens: embedding.maxInputs * embedding.maxInputTokens, outputTokens: 1 };
      model = embedding.model;
    } else {
      const own = ownModels[alias];
      if (own === undefined) {
        // This alias runs the brain's model, so it is priced as the brain is.
        aliasPrices = prices;
        model = `${capability.provider}/${capability.model}`;
      } else {
        const given = extraPrices[alias];
        if (!given) throw new Error(`The model ${capability.provider}/${own} (${alias}) needs its prices.`);
        aliasPrices = {
          input: price(given.input, `${alias} input`), output: price(given.output, `${alias} output`),
          cacheRead: price(given.cacheRead, `${alias} cache read`), cacheWrite: price(given.cacheWrite, `${alias} cache write`),
        };
        model = `${capability.provider}/${own}`;
      }
      format = capability.provider as "openai" | "anthropic";
      limits = { inputTokens: REVIEWED_INPUT_TOKENS, outputTokens: capability.maxOutputTokens };
    }
    const pricing = gatewayPricingSchema.parse({ version: 1, capabilityHash, format, limits, usdPerMillionTokens: aliasPrices });
    let maximumLiability: string;
    try { maximumLiability = gatewayMaximumLiability(pricing); }
    catch { throw new Error(`The prices for ${alias} must not all be zero.`); }
    // Every call first holds its largest possible cost. Setup does not otherwise check this, and a
    // limit below the hold would refuse every call.
    if (units(maximumLiability) > units(personLimit))
      throw new Error(`One model call${alias === request.alias ? "" : ` to ${alias}`} can cost up to $${maximumLiability} at these prices, which is more than the per-person limit of $${personLimit}. Raise the limit.`);
    return {
      alias, model, aliasPrices,
      policy: {
        capability, pricing, maximumLiability,
        team: { maxBudget: installationLimit, models: capability.aliases, budgetDuration: "1d" },
        user: { maxBudget: personLimit, userRole: "internal_user", autoCreateKey: false },
        membership: { maxBudget: personLimit, allowedModels: capability.aliases, budgetDuration: "1d", role: "user" },
        key: { maxBudget: personLimit, models: [alias], budgetDuration: "1d", keyType: "llm_api", blocked: true },
      },
    };
  });
  // The gateway's own daily caps are a backstop set no lower than the monthly limits, so the
  // monthly budget ledger stays the one rule a person can actually run into.
  const policy = parseBudgetNativePolicyDocument(JSON.stringify({ endpointHash, policies: entries.map(entry => entry.policy) }));
  return {
    policy, maximumLiability: policy.policies[0]!.maximumLiability, model: `${capability.provider}/${capability.model}`,
    pricedAliases: entries.map(({ alias, model, aliasPrices }) => ({ alias, model, prices: aliasPrices })),
    installationLimit, personLimit, prices,
  };
}

export function main(input: string, out: (value: string) => void): number {
  rejectDuplicateJsonKeys(input);
  out(JSON.stringify(renderNativePolicy(JSON.parse(input) as NativePolicyRequest)));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(readFileSync(0, "utf8"), value => process.stdout.write(`${value}\n`)); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "the model budget policy could not be built"}\n`);
    process.exitCode = 1;
  }
}
