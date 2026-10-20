/**
 * Route classifier — activity → routing decision.
 *
 * `makeRouteClassifier({ llm }).classify({ activity, openOpportunities })` → `RouteDecision`
 *
 * Given a person's recent activity (emails/meetings) and their current open opportunities in
 * Twenty, asks the gateway LLM to decide: which brand the signal belongs to, which pipeline
 * stage, whether to move an existing opp / create a new one / do nothing, and a confidence +
 * one-line reason.
 *
 * Short-circuits to a safe "none" decision when activity is empty — no LLM call. Gracefully
 * returns a safe fallback on any parse failure — never throws.
 *
 * The `llm` interface is a plain `(prompt: string) => Promise<string>`, so `lib/llm-complete.ts`'s
 * `gatewayComplete` is a drop-in and tests can inject a fake.
 */

import { crmBrands, type CrmBrand } from "./crm-brands.js";
import { stripQuoted } from "./voice-learn.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A brand id as the installation configured it (`CRM_BRANDS`, lib/crm-brands.ts). */
export type RouteBrand = string;

/** Pipeline order, earliest first — the routing engine refuses to propose a stage at or
 *  before an opportunity's current one (Ledgerly: QUALIFIED → CONTACTED was offered). */
export const VALID_STAGES = [
  "NEW",
  "CONTACTED",
  "MEETING",
  "QUALIFIED",
  "PROPOSAL",
  "CUSTOMER",
  "LOST",
] as const;
export type RouteStage = (typeof VALID_STAGES)[number];

const VALID_ACTIONS = ["move", "create", "none"] as const;
export type RouteAction = (typeof VALID_ACTIONS)[number];

export interface RouteDecision {
  brand: RouteBrand | null;
  stage: RouteStage | null;
  action: RouteAction;
  confidence: number;
  reasoning: string;
}

/** A summarised activity signal from email or calendar. */
export interface RouteActivity {
  personHandle: string;
  kind: "email" | "meeting";
  subject: string;
  /** Trimmed body content — keep this content-light (a short slice). */
  body: string;
  at: string;
}

/** An open opportunity already tracked in Twenty for this person. */
export interface OpenOpportunity {
  id: string;
  name: string;
  stage: string;
  brand: string;
}

// ─── Safe fallback ────────────────────────────────────────────────────────────

function safeNone(reasoning: string): RouteDecision {
  return { brand: null, stage: null, action: "none", confidence: 0, reasoning };
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(
  activity: RouteActivity[],
  openOpportunities: OpenOpportunity[],
  brands: readonly CrmBrand[],
  self: { handles: readonly string[]; domains: readonly string[] },
): string {
  // Quoted reply tails carry the owner's own earlier text and signature, which says nothing
  // about the contact's brand; only what the contact wrote reaches the classifier.
  const activityLines = activity
    .map(
      (a) =>
        `[${a.at}] ${a.kind.toUpperCase()} | subject: "${a.subject}" | body: "${stripQuoted(a.body).trim()}"`,
    )
    .join("\n");

  const oppLines =
    openOpportunities.length > 0
      ? openOpportunities
          .map((o) => `  - id:${o.id} name:"${o.name}" brand:${o.brand} stage:${o.stage}`)
          .join("\n")
      : "  (none)";

  return [
    "You are a CRM routing classifier.",
    "",
    "BRANDS (pick exactly one, or null if none applies):",
    ...brands.map((b) => (b.description ? `  ${b.id} — ${b.description}` : `  ${b.id}`)),
    "",
    "PIPELINE STAGES (ordered NEW → CUSTOMER; LOST is separate):",
    "  NEW | CONTACTED | MEETING | QUALIFIED | PROPOSAL | CUSTOMER | LOST",
    "",
    "TASK:",
    "Given recent activity from a contact and their open opportunities,",
    "decide the best CRM routing action.",
    "",
    "RULES:",
    '- Pick a configured brand only when the content clearly identifies that brand.',
    "- The owner's own name, signature, addresses and domains are never evidence for a brand.",
    '- Choose action:"move" when an open opportunity for that brand already exists (advance it).',
    '- Choose action:"create" when no open opportunity exists for that brand (start a new one).',
    '- Choose action:"none" when content is off-topic, ambiguous, or there is no clear brand signal.',
    "",
    `THE OWNER (never evidence for a brand): addresses ${self.handles.length > 0 ? self.handles.join(", ") : "(none known)"}; domains ${self.domains.length > 0 ? self.domains.join(", ") : "(none known)"}`,
    "",
    "OPEN OPPORTUNITIES for this contact:",
    oppLines,
    "",
    "RECENT ACTIVITY:",
    activityLines,
    "",
    "Respond with ONLY a JSON object, no prose or code fences:",
    `{"brand":"${[...brands.map((b) => b.id), "null"].join("|")}","stage":"NEW|CONTACTED|MEETING|QUALIFIED|PROPOSAL|CUSTOMER|LOST|null","action":"move|create|none","confidence":0.0,"reasoning":"one line"}`,
  ].join("\n");
}

// ─── JSON parser (code-fence tolerant) ───────────────────────────────────────

function parseObject(raw: string): Record<string, unknown> | null {
  // Grab the first {...} block — tolerates ```json fences and surrounding prose
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

// ─── Validators ───────────────────────────────────────────────────────────────

function toValidBrand(v: unknown, brands: readonly CrmBrand[]): RouteBrand | null {
  return typeof v === "string" && brands.some((b) => b.id === v) ? v : null;
}

function toValidStage(v: unknown): RouteStage | null {
  return VALID_STAGES.includes(v as RouteStage) ? (v as RouteStage) : null;
}

function toValidAction(v: unknown): RouteAction {
  return VALID_ACTIONS.includes(v as RouteAction) ? (v as RouteAction) : "none";
}

function toClampedConfidence(v: unknown): number {
  if (typeof v !== "number" || isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function makeRouteClassifier(deps: {
  llm: (prompt: string) => Promise<string>;
  /** The installation's brands; read from `CRM_BRANDS` when omitted. */
  brands?: readonly CrmBrand[];
  /** The owner's own email addresses; with their domains, never evidence for a brand. */
  selfHandles?: readonly string[];
  /** Extra owner domains (the org's own); domains of `selfHandles` are added automatically. */
  selfDomains?: readonly string[];
}) {
  const { llm } = deps;
  const selfHandles = [...new Set((deps.selfHandles ?? []).map((h) => h.trim().toLowerCase()).filter((h) => h !== ""))];
  const selfDomains = [
    ...new Set(
      [...(deps.selfDomains ?? []), ...selfHandles.map((h) => h.slice(h.lastIndexOf("@") + 1))]
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d !== "" && !d.includes("@")),
    ),
  ];

  return {
    async classify(input: {
      activity: RouteActivity[];
      openOpportunities: OpenOpportunity[];
    }): Promise<RouteDecision> {
      // Short-circuit: no activity → nothing to classify
      if (input.activity.length === 0) {
        return safeNone("no activity to classify");
      }

      const brands = deps.brands ?? crmBrands();
      if (brands.length === 0) {
        return safeNone("no CRM brands are configured");
      }

      const prompt = buildPrompt(input.activity, input.openOpportunities, brands, { handles: selfHandles, domains: selfDomains });

      let raw: string;
      try {
        raw = await llm(prompt);
      } catch {
        return safeNone("llm call failed");
      }

      const j = parseObject(raw);
      if (!j) {
        return safeNone("could not parse classifier output");
      }

      return {
        brand: toValidBrand(j.brand, brands),
        stage: toValidStage(j.stage),
        action: toValidAction(j.action),
        confidence: toClampedConfidence(j.confidence),
        reasoning: typeof j.reasoning === "string" ? j.reasoning.trim() : "",
      };
    },
  };
}
