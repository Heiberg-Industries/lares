import { basename } from "node:path";
import {
  PROJECTS, DESTINATIONS, BODY_CHARS_FOR_CLASSIFY,
  type DigestDecision, type DigestType,
} from "./types.js";
import { groundingClause, labeledContext } from "@lares/compose-contract";

export type DigestLlm = (prompt: string) => Promise<string>;

export interface ClassifyContext {
  projects: string[];
  noteNames: string[];     // basenames (no .md) the model may link to
  contextNote?: string;    // optional note Bendik attached to the capture
}

const VALID_TYPES: DigestType[] = ["transcript", "inspiration", "writing-seed", "reference", "person-signal"];

function buildPrompt(item: { path: string; body: string }, ctx: ClassifyContext): string {
  const head = item.body.slice(0, BODY_CHARS_FOR_CLASSIFY);
  return [
    "You categorise a captured note for Bendik's knowledge base (the Brain).",
    "Classify it into ONE type and decide where it belongs.",
    "",
    "Types and destinations:",
    "- transcript: a meeting/call transcript or transcribed voice note → goes to a project's transcripts/ folder.",
    `  The project MUST be one of: ${ctx.projects.join(", ")}.`,
    "- inspiration: an article/reference kept for taste/inspiration, not to act on → inspiration/.",
    "- writing-seed: a starting point for Bendik's OWN writing → writing-seeds/.",
    "- reference: generally useful knowledge with no clearer home → reads/.",
    "- person-signal: primarily about a specific person/company in his network.",
    "",
    'Choose route="file" ONLY when you are clearly sure of the type AND (for a transcript) the project.',
    'When genuinely unsure between two homes, choose route="ask" and explain the choice in `reason`.',
    "Always choose route=\"ask\" for person-signal (it is handled separately).",
    "",
    groundingClause(),
    "",
    labeledContext([
      { label: "Context note from Bendik", content: ctx.contextNote ? `"${ctx.contextNote}"` : "", note: "this OVERRIDES your guess" },
    ]),
    "",
    `Existing note names you MAY reference as links (use exact names, omit if none fit): ${ctx.noteNames.join(", ")}`,
    "",
    "Respond with ONLY a JSON object, no prose:",
    '{"route":"file|ask","type":"<one type>","project":"<project or empty>","title":"<short title>",',
    '"summary":"<2-4 line summary>","links":["<note name>", ...],"reason":"<one line>"}',
    "",
    labeledContext([{ label: `NOTE (${basename(item.path)})`, content: head }]),
  ].filter(Boolean).join("\n");
}

function parse(raw: string): Record<string, unknown> | null {
  // tolerate code fences / surrounding prose: grab the first {...} block
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export async function classifyItem(
  item: { path: string; body: string },
  ctx: ClassifyContext,
  llm: DigestLlm,
): Promise<DigestDecision> {
  const raw = await llm(buildPrompt(item, ctx));
  const j = parse(raw);
  if (!j) {
    return { route: "ask", type: "reference", destination: "reads", title: basename(item.path, ".md"),
      summary: "", links: [], reason: "could not parse classifier output" };
  }

  const type = (VALID_TYPES.includes(j.type as DigestType) ? j.type : "reference") as DigestType;
  const title = String(j.title ?? basename(item.path, ".md")).trim() || basename(item.path, ".md");
  const summary = String(j.summary ?? "");
  const reasonIn = String(j.reason ?? "");

  // validate proposed links against real note names, wrap as wikilinks
  const valid = new Set(ctx.noteNames.map((n) => n.toLowerCase()));
  const links = (Array.isArray(j.links) ? j.links : [])
    .map((l) => String(l).replace(/^\[\[|\]\]$/g, "").trim())
    .filter((l) => valid.has(l.toLowerCase()))
    .map((l) => `[[${l}]]`);

  // resolve destination + enforce guardrails
  let route = j.route === "file" ? "file" : "ask";
  let destination = "";
  let project: string | undefined;
  let reason = reasonIn;

  if (type === "person-signal") {
    route = "ask"; destination = ""; reason = reasonIn || "person/company signal — handled separately";
  } else if (type === "transcript") {
    project = String(j.project ?? "").trim();
    if (!PROJECTS.includes(project as (typeof PROJECTS)[number])) {
      route = "ask"; reason = reasonIn || `transcript but project unclear (got "${project || "none"}")`;
    } else {
      destination = `${project}/transcripts`;
    }
  } else {
    destination = DESTINATIONS[type];
  }

  return { route: route as DigestDecision["route"], type, project, destination, title, summary, links, reason };
}
