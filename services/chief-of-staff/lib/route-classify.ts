/**
 * Route classifier — activity → routing decision.
 *
 * `makeRouteClassifier({ llm }).classify({ activity, openOpportunities })` → `RouteDecision`
 *
 * Given a person's recent activity (emails/meetings) and their current open opportunities in
 * Twenty, asks the gateway LLM to decide: which live track the signal belongs to, which step,
 * whether to move an existing opportunity / create a new one / do nothing, and a confidence +
 * one-line reason.
 *
 * Short-circuits to a safe "none" decision when activity is empty — no LLM call. Gracefully
 * returns a safe fallback on any parse failure — never throws.
 *
 * The `llm` interface is a plain `(prompt: string) => Promise<string>`, so `lib/llm-complete.ts`'s
 * `gatewayComplete` is a drop-in and tests can inject a fake.
 */

import type { Track } from "@lares/agent-kit/tracks";
import { stripQuoted } from "./voice-learn.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Exact track value from Twenty's live opportunity metadata. */
export type RouteBrand = string;

/** Exact step value from Twenty's live metadata, scoped to a selected track. */
export type RouteStage = string;

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
  tracks: readonly Track[],
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
    "You are a workflow routing classifier.",
    "",
    "OWNER'S EXISTING TRACKS (pick exactly one, or null if none applies):",
    ...tracks.map((track) => `  ${track.id} (${track.name}) — ${track.purpose || "No purpose description"}; steps in order: ${track.steps.join(" | ")}`),
    "",
    "STEPS are listed in each track above. Choose only a step listed for the selected track.",
    "",
    "TASK:",
    "Given recent activity from a contact and their open track items,",
    "decide whether an existing workflow item should move or a new one should start.",
    "",
    "RULES:",
    '- Pick an existing track only when the content clearly fits its purpose.',
    "- The owner's own name, signature, addresses and domains are never evidence for a track.",
    '- Choose action:"move" when an open item for that track exists (advance it).',
    '- Choose action:"create" when no open item exists for that track (start a new one).',
    '- Choose action:"none" when content is off-topic, ambiguous, or no track fits.',
    "",
    `THE OWNER (never evidence for a track): addresses ${self.handles.length > 0 ? self.handles.join(", ") : "(none known)"}; domains ${self.domains.length > 0 ? self.domains.join(", ") : "(none known)"}`,
    "",
    "OPEN TRACK ITEMS for this contact:",
    oppLines,
    "",
    "RECENT ACTIVITY:",
    activityLines,
    "",
    "Respond with ONLY a JSON object, no prose or code fences:",
    `{"brand":"${[...tracks.map((track) => track.id), "null"].join("|")}","stage":"a listed step for the selected track, or null","action":"move|create|none","confidence":0.0,"reasoning":"one line"}`,
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

function toValidBrand(v: unknown, tracks: readonly Track[]): RouteBrand | null {
  return typeof v === "string" && tracks.some((track) => track.id === v) ? v : null;
}

function toValidStage(v: unknown, track: Track | undefined): RouteStage | null {
  return typeof v === "string" && track?.steps.includes(v) ? v : null;
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
  /** Synthetic adapter data may be bound in tests; production supplies tracks per scan. */
  tracks?: readonly Track[];
  /** The owner's own email addresses; with their domains, never evidence for a track. */
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
      tracks?: readonly Track[];
    }): Promise<RouteDecision> {
      // Short-circuit: no activity → nothing to classify
      if (input.activity.length === 0) {
        return safeNone("no activity to classify");
      }

      const tracks = input.tracks ?? deps.tracks ?? [];
      if (tracks.length === 0) {
        return safeNone("no Twenty tracks are configured in live metadata");
      }

      const prompt = buildPrompt(input.activity, input.openOpportunities, tracks, { handles: selfHandles, domains: selfDomains });

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
        brand: toValidBrand(j.brand, tracks),
        stage: toValidStage(j.stage, tracks.find((track) => track.id === j.brand)),
        action: toValidAction(j.action),
        confidence: toClampedConfidence(j.confidence),
        reasoning: typeof j.reasoning === "string" ? j.reasoning.trim() : "",
      };
    },
  };
}
