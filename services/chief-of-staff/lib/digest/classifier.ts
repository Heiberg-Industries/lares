import { basename } from "node:path";
import {
  DESTINATIONS, BODY_CHARS_FOR_CLASSIFY,
  type DigestDecision, type DigestType,
} from "./types.js";
import { groundingClause, labeledContext } from "@lares/compose-contract";

export type DigestLlm = (prompt: string) => Promise<string>;

export interface ClassifyContext {
  projects: string[];
  noteNames: string[];     // basenames (no .md) the model may link to
  contextNote?: string;    // optional note the owner attached to the capture
}

const VALID_TYPES: DigestType[] = ["transcript", "inspiration", "writing-seed", "reference", "person-signal"];

function buildPrompt(item: { path: string; body: string }, ctx: ClassifyContext): string {
  const head = item.body.slice(0, BODY_CHARS_FOR_CLASSIFY);
  return [
    "You categorise a captured note for the owner's private notes.",
    "Classify it into ONE type and decide where it belongs.",
    "",
    "Types and destinations:",
    "- transcript: a meeting/call transcript or transcribed voice note → goes to a project's transcripts/ folder.",
    ctx.projects.length > 0
      ? `  The project MUST be one of: ${ctx.projects.join(", ")}.`
      : '  No project has a transcripts/ folder yet, so leave the project empty and choose route="ask".',
    "- inspiration: an article/reference kept for taste/inspiration, not to act on → inspiration/.",
    "- writing-seed: a starting point for the owner's OWN writing → writing-seeds/.",
    "- reference: generally useful knowledge with no clearer home → reads/.",
    "- person-signal: primarily about a specific person/company in the owner's network.",
    "",
    'Choose route="file" ONLY when you are clearly sure of the type AND (for a transcript) the project.',
    'When genuinely unsure between two homes, choose route="ask" and explain the choice in `reason`.',
    "Always choose route=\"ask\" for person-signal (it is handled separately).",
    "",
    groundingClause(),
    "",
    labeledContext([
      { label: "Context note from the owner", content: ctx.contextNote ? `"${ctx.contextNote}"` : "", note: "this OVERRIDES your guess" },
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
    if (!ctx.projects.includes(project)) {
      route = "ask"; reason = reasonIn || `transcript but project unclear (got "${project || "none"}")`;
    } else {
      destination = `${project}/transcripts`;
    }
  } else {
    destination = DESTINATIONS[type];
  }

  return { route: route as DigestDecision["route"], type, project, destination, title, summary, links, reason };
}

// ── Saved web links: one call per article ──────────────────────────────────────────────────
// A saved link the reader can open is always an `article`, and always filed: the model is asked
// only for a summary, a few topics, up to three passages worth quoting and links to existing
// notes. Code checks every one of those afterwards (`lib/digest/article.ts`); a reply that cannot
// be read still files the article, with nothing proposed.

export interface ArticleClassification {
  summary: string;
  /** At most six, unchecked; `normaliseTopics` decides which survive. */
  topics: string[];
  /** At most three, unchecked; `filterExcerpts` keeps only those found word for word. */
  excerpts: string[];
  /** Wikilinks to real note names only. */
  links: string[];
  /** True when the model's reply could not be read (nothing was proposed). */
  unreadable?: boolean;
}

export interface ArticleDecision extends ArticleClassification {
  type: "article";
  route: "file";
}

export interface ArticleInput {
  title: string;
  url: string;
  /** The owner's own words saved with the link; empty when there are none. */
  ownerNote: string;
  /** The page's full text; only the start is sent. */
  text: string;
}

export interface ArticleContext {
  /** Basenames (no .md) the model may link to. */
  noteNames: string[];
}

const MAX_ARTICLE_TOPICS = 6;
const MAX_ARTICLE_EXCERPTS = 3;

function buildArticlePrompt(item: ArticleInput, ctx: ArticleContext): string {
  return [
    "You read a saved web article for a small business's knowledge base.",
    "Write a short summary and propose a few topic labels and a few passages worth quoting.",
    "",
    "- summary: 2 to 4 plain sentences about what the article says. No opinions of your own.",
    "- topics: up to 6 short labels (one to three words each, lowercase, no punctuation).",
    "- excerpts: up to 3 passages COPIED EXACTLY from the article text below, each between 40 and 400",
    "  characters. Copy them word for word; do not shorten, rephrase or combine. Leave the list empty",
    "  if nothing is worth quoting.",
    `- links: names of existing notes this article clearly relates to, chosen only from: ${ctx.noteNames.join(", ") || "(none)"}.`,
    "",
    groundingClause(),
    "",
    labeledContext([
      { label: "Note from the person who saved this link", content: item.ownerNote ? `"${item.ownerNote}"` : "", note: "their own words; use as context" },
      { label: "Title and link", content: `${item.title}\n${item.url}` },
      { label: "ARTICLE TEXT (start of the page)", content: item.text.slice(0, BODY_CHARS_FOR_CLASSIFY), thirdParty: true },
    ]),
    "",
    "Respond with ONLY a JSON object, no prose:",
    '{"summary":"<text>","topics":["<label>", ...],"excerpts":["<exact passage>", ...],"links":["<note name>", ...]}',
  ].join("\n");
}

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").slice(0, max);
}

export async function classifyArticle(
  item: ArticleInput,
  ctx: ArticleContext,
  llm: DigestLlm,
): Promise<ArticleDecision> {
  const j = parse(await llm(buildArticlePrompt(item, ctx)));
  if (!j) {
    return { type: "article", route: "file", summary: "", topics: [], excerpts: [], links: [], unreadable: true };
  }
  const valid = new Set(ctx.noteNames.map((n) => n.toLowerCase()));
  return {
    type: "article",
    route: "file",
    summary: typeof j.summary === "string" ? j.summary.trim() : "",
    topics: stringList(j.topics, MAX_ARTICLE_TOPICS),
    excerpts: stringList(j.excerpts, MAX_ARTICLE_EXCERPTS),
    links: stringList(j.links, 20)
      .map((l) => l.replace(/^\[\[|\]\]$/g, "").trim())
      .filter((l) => valid.has(l.toLowerCase()))
      .map((l) => `[[${l}]]`),
  };
}
