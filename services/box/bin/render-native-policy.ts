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
import { gatewayAdmissionProfile } from "../lib/gateway-config.js";

/** Largest prompt, in tokens, one model call may carry. It sets the amount held per call. */
export const REVIEWED_INPUT_TOKENS = 100_000;

export interface NativePolicyRequest {
  readonly alias: string;
  readonly providerModel: string;
  readonly gatewayUrl: string;
  readonly installationLimit: string;
  readonly personLimit: string;
  readonly prices: { readonly input: string; readonly output: string; readonly cacheRead: string; readonly cacheWrite: string };
}

export interface NativePolicyResult {
  readonly policy: BudgetNativePolicyDocument;
  readonly maximumLiability: string;
  readonly model: string;
  readonly installationLimit: string;
  readonly personLimit: string;
  readonly prices: NativePolicyRequest["prices"];
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
  const capability = gatewayAdmissionProfile({ alias: request.alias, providerModel: request.providerModel });
  const prices = {
    input: price(request.prices.input, "input"),
    output: price(request.prices.output, "output"),
    cacheRead: price(request.prices.cacheRead, "cache read"),
    cacheWrite: price(request.prices.cacheWrite, "cache write"),
  };
  const pricing = gatewayPricingSchema.parse({
    version: 1,
    capabilityHash: gatewayHash(gatewayCanonical(capability)),
    format: capability.provider,
    limits: { inputTokens: REVIEWED_INPUT_TOKENS, outputTokens: capability.maxOutputTokens },
    usdPerMillionTokens: prices,
  });
  const maximumLiability = gatewayMaximumLiability(pricing);
  // Every call first holds its largest possible cost. Setup does not otherwise check this, and a
  // limit below the hold would refuse every call.
  if (units(maximumLiability) > units(personLimit))
    throw new Error(`One model call can cost up to $${maximumLiability} at these prices, which is more than the per-person limit of $${personLimit}. Raise the limit.`);
  const gatewayOrigin = new URL(request.gatewayUrl).origin;
  const endpointHash = createHash("sha256").update(`lares.native-endpoint.v1\0${gatewayOrigin}\0${capability.providerBaseUrl}`).digest("hex");
  // The gateway's own daily caps are a backstop set no lower than the monthly limits, so the
  // monthly budget ledger stays the one rule a person can actually run into.
  const policy = parseBudgetNativePolicyDocument(JSON.stringify({
    endpointHash,
    policies: [{
      capability,
      pricing,
      maximumLiability,
      team: { maxBudget: installationLimit, models: capability.aliases, budgetDuration: "1d" },
      user: { maxBudget: personLimit, userRole: "internal_user", autoCreateKey: false },
      membership: { maxBudget: personLimit, allowedModels: capability.aliases, budgetDuration: "1d", role: "user" },
      key: { maxBudget: personLimit, models: [request.alias], budgetDuration: "1d", keyType: "llm_api", blocked: true },
    }],
  }));
  return { policy, maximumLiability, model: `${capability.provider}/${capability.model}`, installationLimit, personLimit, prices };
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
