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
 * Ported verbatim from `services/agent-runtime/lib/adapters/route/classify.ts`. The `llm`
 * interface is a plain `(prompt: string) => Promise<string>`, so `lib/llm-complete.ts`'s
 * `gatewayComplete` is a drop-in and tests can inject a fake.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

const VALID_BRANDS = ["ORAKEL", "ZERO7", "MURMUR"] as const;
export type RouteBrand = (typeof VALID_BRANDS)[number];

/** Pipeline order, earliest first — the routing engine refuses to propose a stage at or
 *  before an opportunity's current one (Finago, 2026-09-07: QUALIFIED → CONTACTED was offered). */
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
): string {
  const activityLines = activity
    .map(
      (a) =>
        `[${a.at}] ${a.kind.toUpperCase()} | subject: "${a.subject}" | body: "${a.body}"`,
    )
    .join("\n");

  const oppLines =
    openOpportunities.length > 0
      ? openOpportunities
          .map((o) => `  - id:${o.id} name:"${o.name}" brand:${o.brand} stage:${o.stage}`)
          .join("\n")
      : "  (none)";

  return [
    "You are a CRM routing classifier for Heiberg Industries.",
    "",
    "BRANDS (pick exactly one, or null if none applies):",
    "  ORAKEL  — B2B data intelligence platform for Norwegian SMBs",
    "  ZERO7   — AI music creation platform",
    "  MURMUR  — audio AI / transcription product",
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
    '- Choose action:"move" when an open opportunity for that brand already exists (advance it).',
    '- Choose action:"create" when no open opportunity exists for that brand (start a new one).',
    '- Choose action:"none" when content is off-topic, ambiguous, or there is no clear brand signal.',
    "",
    "OPEN OPPORTUNITIES for this contact:",
    oppLines,
    "",
    "RECENT ACTIVITY:",
    activityLines,
    "",
    "Respond with ONLY a JSON object, no prose or code fences:",
    '{"brand":"ORAKEL|ZERO7|MURMUR|null","stage":"NEW|CONTACTED|MEETING|QUALIFIED|PROPOSAL|CUSTOMER|LOST|null","action":"move|create|none","confidence":0.0,"reasoning":"one line"}',
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

function toValidBrand(v: unknown): RouteBrand | null {
  return VALID_BRANDS.includes(v as RouteBrand) ? (v as RouteBrand) : null;
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
}) {
  const { llm } = deps;

  return {
    async classify(input: {
      activity: RouteActivity[];
      openOpportunities: OpenOpportunity[];
    }): Promise<RouteDecision> {
      // Short-circuit: no activity → nothing to classify
      if (input.activity.length === 0) {
        return safeNone("no activity to classify");
      }

      const prompt = buildPrompt(input.activity, input.openOpportunities);

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
        brand: toValidBrand(j.brand),
        stage: toValidStage(j.stage),
        action: toValidAction(j.action),
        confidence: toClampedConfidence(j.confidence),
        reasoning: typeof j.reasoning === "string" ? j.reasoning.trim() : "",
      };
    },
  };
}
