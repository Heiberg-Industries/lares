/**
 * Filing a saved web link as an `article` note: the pure half.
 *
 * Everything here is decided by code from the inbox note, the fetched page and the model's
 * proposal. No git, no model, no network: `article-file.ts` writes, `classifier.ts` asks the model.
 *
 * WHAT AN ARTICLE NOTE IS. One note per saved link, in the `articles/` folder of whichever store
 * the link belongs to, keeping the link, who saved it, the owner's own clip note and where it
 * came from. The page's full text lives in a `<name>.txt` companion beside the note, never in the
 * note, so search over notes (which reads `.md` only) stays about what the owner wrote and what
 * Lares summarised, not about every word of every page.
 *
 * THE MODEL PROPOSES, CODE DECIDES. The model's summary, topics and excerpts are suggestions: a
 * topic must be a short plain phrase, and an excerpt survives only if it is found word for word in
 * the page. Where the note lives, who owns it, what scope it has and what origin it carries are
 * never the model's call (they follow the inbox note's own source), and they only ever narrow.
 *
 * FRONTMATTER IS WRITTEN BY A DEDICATED RENDERER because the shared serialiser cannot write nested
 * mappings (`sources`, `generated`). Free text (title, link) is JSON-quoted so a value cannot add a
 * line or close the block; fixed tokens (`type`, `scope`, `owner`, `lares_origin`, ...) are
 * written bare so the readers that match `key: value` lines (scope, erase, Atlas) still see them.
 */
import { createHash } from "node:crypto";

import { ARTICLE_FULL_TEXT_KEY, ARTICLE_READING_KEY } from "@lares/agent-kit/article";
import { isOrigin, type Origin } from "@lares/agent-kit/origin";

import { normaliseUrl } from "../clipping/record.js";
import type { ArticleClassification } from "./classifier.js";
import { parseFrontmatter, stripFrontmatter } from "./extract.js";

export type ArticleArea = "shared" | "private";

/** The folder both stores keep articles in. */
export const ARTICLES_DIR = "articles";

/** What the digest knows about a saved link from its inbox note. */
export interface InboxClip {
  url: string | undefined;
  title: string | undefined;
  /** `notion`, `karakeep` or absent. */
  source: string | undefined;
  /** ISO date or date-time the link was saved. */
  saved: string | undefined;
  notionPage: string | undefined;
  owner: string | undefined;
  visibility: string | undefined;
  laresOrigin: string | undefined;
  tags: string[];
  /** The owner's own words after the frontmatter, with a bare link line removed. */
  note: string;
}

const OWNER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/;
const ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ORGANISATION = "organisation";

export function parseInboxClip(raw: string): InboxClip {
  const fm = parseFrontmatter(raw);
  const url = fm["url"];
  const urlKey = url ? normaliseUrl(url) : null;
  const note = stripFrontmatter(raw)
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t === "") return true;
      if (url !== undefined && t === url) return false;
      return !(urlKey !== null && normaliseUrl(t) === urlKey && /^\S+$/.test(t));
    })
    .join("\n")
    .trim();
  return {
    url,
    title: fm["title"],
    source: fm["source"],
    saved: fm["saved"],
    notionPage: fm["notion_page"],
    owner: fm["owner"],
    visibility: fm["visibility"],
    laresOrigin: fm["lares_origin"],
    tags: (fm["tags"] ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    note,
  };
}

/** The source's owner: `organisation` when the inbox note names none (Karakeep). */
function sourceOwner(clip: InboxClip): string {
  return clip.owner ?? ORGANISATION;
}

/**
 * Which store an article belongs in, given the installation's article area setting (`shared`, the
 * engine default, or `private`; see `article-area.ts`).
 *
 * The setting is a ceiling, never a floor to widen from:
 *   - `private` sends every clip to the private area.
 *   - A clip whose source is private is never shared, whatever the setting says.
 *   - A clip an organisation source marked `shared`, a Karakeep clip (recorded as the
 *     organisation's) and a link pasted in chat (no source, no visibility, no member owner) follow
 *     the setting. A pasted link belongs to the agent that was given it, which is why it follows
 *     the same setting as the organisation's own saves.
 *   - Anything else (an owner that is not a plain id, a visibility or a source this code does not
 *     know, a chat link that names a member) is not trusted and stays private.
 *
 * Whether the shared area can actually be written (a grant on the filing agent, a folder that is
 * mounted writable) is the filer's concern, not this function's.
 */
export function chooseArea(clip: InboxClip, setting: ArticleArea): ArticleArea {
  if (setting === "private") return "private";
  if (clip.owner !== undefined && !OWNER_TOKEN.test(clip.owner)) return "private";
  if (clip.visibility === "private") return "private";
  if (clip.visibility === "shared" || clip.source === "karakeep") return "shared";
  const pastedInChat =
    clip.visibility === undefined && clip.source === undefined &&
    (clip.owner === undefined || clip.owner === ORGANISATION);
  return pastedInChat ? "shared" : "private";
}

/** A valid inbox origin is carried; Karakeep is `synced`; anything else fails closed. */
export function originFor(clip: InboxClip): Origin {
  if (isOrigin(clip.laresOrigin)) return clip.laresOrigin;
  if (clip.source === "karakeep") return "synced";
  return "third_party";
}

/** Letters beyond ASCII, digits, spaces and hyphens; no commas, brackets or emoji. */
const TOPIC_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N} -]*$/u;
const MAX_TOPICS = 8;

/** Clip tags first, then the model's topics: lowercase, short, plain, de-duplicated. */
export function normaliseTopics(clipTags: readonly string[], modelTopics: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of [...clipTags, ...modelTopics]) {
    const topic = String(raw).replace(/\s+/g, " ").trim().toLowerCase();
    if (topic.length === 0 || topic.length > 30) continue;
    if (!TOPIC_SHAPE.test(topic)) continue;
    if (topic.split(" ").length > 3) continue;
    if (!out.includes(topic)) out.push(topic);
    if (out.length === MAX_TOPICS) break;
  }
  return out;
}

const MIN_EXCERPT = 40;
const MAX_EXCERPT = 400;
const MAX_EXCERPTS = 3;
/** The model is asked for 2 to 4 sentences; code does not trust it to stop there. */
const MAX_SUMMARY = 1200;

/** Whitespace collapsed, curly quotes straightened, long dashes made hyphens. */
function squash(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keep an excerpt only if it is 40 to 400 characters and found word for word in the page.
 * "Word for word" is judged after `squash`, and the excerpt that is kept (and later written to the
 * note) is that squashed form: straight quotes, plain hyphens, single spaces. It is not
 * necessarily byte-identical to the page's own typography.
 */
export function filterExcerpts(proposed: readonly string[], fullText: string): string[] {
  const haystack = squash(fullText);
  const out: string[] = [];
  for (const raw of proposed) {
    const excerpt = squash(String(raw));
    if (excerpt.length < MIN_EXCERPT || excerpt.length > MAX_EXCERPT) continue;
    if (!haystack.includes(excerpt)) continue;
    if (!out.includes(excerpt)) out.push(excerpt);
    if (out.length === MAX_EXCERPTS) break;
  }
  return out;
}

const MAX_BASE = 60;

/** A file-name stem: ASCII letters and digits, hyphens, Nordic letters spelled out. */
function slug(text: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, MAX_BASE).replace(/-+$/g, "");
}

function usableTitle(title: string | undefined): string | undefined {
  const t = title?.trim();
  return t && t.toLowerCase() !== "untitled" ? t : undefined;
}

/** The title shown on the note: the page's own, else the clip's, else the link. */
export function articleTitle(opts: { readabilityTitle?: string; clipTitle?: string; url: string }): string {
  return (usableTitle(opts.readabilityTitle) ?? usableTitle(opts.clipTitle) ?? opts.url).replace(/\s+/g, " ").slice(0, 200);
}

/** The file-name stem: the page title, else the clip title, else the link's host and path. */
export function articleBase(opts: { readabilityTitle?: string; clipTitle?: string; url: string }): string {
  for (const candidate of [usableTitle(opts.readabilityTitle), usableTitle(opts.clipTitle)]) {
    const s = candidate ? slug(candidate) : "";
    if (s) return s;
  }
  try {
    const u = new URL(opts.url);
    const s = slug(`${u.host}${u.pathname}`);
    if (s) return s;
  } catch {
    /* fall through */
  }
  return "article";
}

/** A different link with the same stem: the first six hex characters of the link's hash. */
export function suffixedBase(base: string, urlKey: string): string {
  const hash = createHash("sha256").update(urlKey).digest("hex").slice(0, 6);
  return `${base}-${hash}`;
}

/** Whether an existing article note was filed for this (normalised) link. */
export function filedLinkMatches(existingRaw: string, urlKey: string): boolean {
  const m = existingRaw.replace(/\r\n/g, "\n").match(/^sources:[ \t]*\n[ \t]+-[ \t]+resource:[ \t]*(.+)$/m);
  if (!m) return false;
  let value = m[1]!.trim();
  if (value.startsWith('"')) {
    try {
      value = JSON.parse(value) as string;
    } catch {
      return false;
    }
  }
  return normaliseUrl(value) === urlKey;
}

export interface BuildArticleInput {
  /** The inbox note exactly as it was saved (frontmatter and the owner's note). */
  inboxBody: string;
  article: { url: string; title: string; text: string };
  classification: ArticleClassification;
  /** The store the note is actually going into (after any fall-back from shared to private). */
  area: ArticleArea;
  /** The file-name stem, already checked free (or suffixed) in the target store. */
  base: string;
  now: Date;
  /** The pass date, used when the inbox note carries no usable `saved:`. */
  today: string;
}

export interface BuiltArticle {
  /** Store-relative paths, in the target store. */
  notePath: string;
  companionPath: string;
  noteRaw: string;
  companionText: string;
  title: string;
  message: string;
}

const q = (s: string): string => JSON.stringify(s);

export function buildArticle(input: BuildArticleInput): BuiltArticle {
  const { article, classification, area, base } = input;
  const clip = parseInboxClip(input.inboxBody);
  const owner = sourceOwner(clip);
  const companionName = `${base}.txt`;
  const title = articleTitle({ readabilityTitle: article.title, clipTitle: clip.title, url: article.url });
  const link = clip.url ?? article.url;

  const topics = normaliseTopics(clip.tags, classification.topics);
  const excerpts = filterExcerpts(classification.excerpts, article.text);
  const captured = clip.saved && /^\d{4}-\d{2}-\d{2}/.test(clip.saved) ? clip.saved.slice(0, 10) : input.today;
  const ownerLine: string[] = [];
  if (area === "shared") {
    if (OWNER_TOKEN.test(owner)) ownerLine.push(`owner: ${owner}`);
  } else if (owner !== ORGANISATION && OWNER_TOKEN.test(owner)) {
    // A private note with `owner: organisation` is invisible to every reader, so a private note
    // names an owner only when it is a member.
    ownerLine.push(`owner: ${owner}`);
  }

  const frontmatter = [
    "---",
    "type: article",
    `title: ${q(title)}`,
    "sources:",
    `  - resource: ${q(link)}`,
    `${ARTICLE_READING_KEY}: to-read`,
    `topics: [${topics.map(q).join(", ")}]`,
    `gathered_by: ${owner === ORGANISATION || !OWNER_TOKEN.test(owner) ? "owner" : `member:${owner}`}`,
    `captured: ${captured}`,
    "generated:",
    '  by: "process:digest"',
    `  at: ${q(input.now.toISOString().replace(/\.\d{3}Z$/, "Z"))}`,
    `lares_origin: ${originFor(clip)}`,
    ...ownerLine,
    `scope: ${area === "shared" ? "org" : "private"}`,
    ...(clip.notionPage && ID_TOKEN.test(clip.notionPage) ? [`notion_page: ${clip.notionPage}`] : []),
    `${ARTICLE_FULL_TEXT_KEY}: ${companionName}`,
    "---",
  ];

  const sections: string[] = [];
  const summary = classification.summary.trim().slice(0, MAX_SUMMARY);
  if (summary) sections.push(summary);
  if (excerpts.length > 0) {
    sections.push(
      [
        "## Proposed excerpts",
        "_Suggested by Lares from the page text. Not confirmed by you._",
        "",
        excerpts.map((e) => `> ${e}`).join("\n\n"),
      ].join("\n"),
    );
  }
  if (clip.note) sections.push(`## Note\n${clip.note}`);
  // Names of notes in the private store must not travel into the shared one.
  if (area === "private" && classification.links.length > 0) {
    sections.push(`## Related\n${classification.links.join(" ")}`);
  }
  sections.push(`## Full text\n[Full text](${companionName})`);

  return {
    notePath: `${ARTICLES_DIR}/${base}.md`,
    companionPath: `${ARTICLES_DIR}/${companionName}`,
    noteRaw: `${frontmatter.join("\n")}\n\n${sections.join("\n\n")}\n`,
    companionText: article.text,
    title,
    message: `digest: file article ${base} → ${ARTICLES_DIR}`,
  };
}
