/**
 * What a scheduled job may touch in the Vault, by name. A schedule is not a model and has no card to
 * approve: keeper lets it act only where THIS table names the schedule, the area and the path, and only
 * when the agent's own definition also grants the area (a write needs a write grant). A path outside
 * the schedule's own rules is refused, however the request was built.
 *
 * Pure data and checks. Shared by keeper (which enforces it) and the agent side (which refuses early).
 */

import { Buffer } from "node:buffer";

import { readOriginFrontmatter } from "@lares/vault-format/origin";

export type ScheduledVaultArea = "private" | "shared";
export type ScheduledVaultOperation = "list" | "read" | "write" | "write-verbatim" | "move" | "remove";

export interface ScheduledVaultRule {
  area: ScheduledVaultArea;
  /** Folders a listing may be taken under, each ending in "/". */
  listPrefixes: readonly string[];
  /** The empty prefix: list every note in the area (the ordinary listing, which hides `_meta/`). Names only. */
  listAll?: boolean;
  read: RegExp;
  write: RegExp;
  remove: RegExp;
  /** Paths a VERBATIM write may save: the whole file as sent, nothing added or rewritten. Never, unless a rule names them. */
  verbatim: RegExp;
  /** The one `lares_origin` a verbatim `.md` file must carry in its own front matter. */
  verbatimOrigin?: "third_party" | "synced";
}

const NEVER = /^(?!)/;

/** Every path the policy accepts: relative, no traversal, no hidden segment, no control characters. */
export function plainVaultPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 512 && !path.startsWith("/") &&
    !/[\\\x00-\x1f\x7f]/.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith("."));
}

// The digest: pulls saved links into the inbox, reads the inbox, moves a note it has classified out of the
// inbox into the one folder it belongs in and rewrites it there. The folders are the ones the classifier
// can name: three fixed ones, and `<project>/transcripts/` for a project the Vault already has.
const DIGEST_INBOX_NOTE = String.raw`_inbox\/[^/]+\.md`;
const DIGEST_PULLED_NOTE = String.raw`_inbox\/(?:clip|karakeep)-[A-Za-z0-9._-]+\.md`;
const DIGEST_FILED_NOTE = String.raw`(?:(?:inspiration|writing-seeds|reads)|[^/_.][^/]*\/transcripts)\/[a-z0-9]+(?:-[a-z0-9]+)*\.md`;
// A filed article: `articles/<slug>.md` and its plain-text companion `articles/<slug>.txt`. The slug is lower-case
// letters and digits joined by single hyphens; a same-title different link ends in a six-character hex suffix, which fits.
const DIGEST_ARTICLE_STEM = String.raw`articles\/[a-z0-9]+(?:-[a-z0-9]+)*`;
const DIGEST_ARTICLE_FILE = String.raw`${DIGEST_ARTICLE_STEM}\.(?:md|txt)`;
export const SCHEDULED_VAULT_POLICY: Readonly<Record<string, readonly ScheduledVaultRule[]>> = {
  // The nightly cycle: finds its cursor in its own dated notes, reads old conversation logs, writes one dated note.
  dream: [{
    area: "private",
    listPrefixes: ["_meta/dream/", "_meta/conversations/"],
    read: /^_meta\/(?:dream|conversations)\/(?:[^/]+\/)*[^/]+\.md$/,
    write: /^_meta\/dream\/\d{4}-\d{2}-\d{2}\.md$/,
    remove: NEVER,
    verbatim: NEVER,
  }],
  // The clipping drain: saves saved links into the inbox, replaces a clip when it changes, drops one that was trashed.
  "clipping-requests": [{
    area: "private",
    listPrefixes: ["_inbox/"],
    read: /^_inbox\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
    write: /^_inbox\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
    remove: /^_inbox\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
    verbatim: NEVER,
  }],
  // The digest: see the note above the patterns. Listing the whole area is for note names only.
  digest: [{
    area: "private",
    listPrefixes: ["_inbox/", "articles/"],
    listAll: true,
    read: new RegExp(`^(?:${DIGEST_INBOX_NOTE}|${DIGEST_FILED_NOTE}|${DIGEST_ARTICLE_STEM}\\.md)$`),
    write: new RegExp(`^(?:${DIGEST_PULLED_NOTE}|${DIGEST_FILED_NOTE})$`),
    remove: new RegExp(`^${DIGEST_INBOX_NOTE}$`),
    verbatim: new RegExp(`^${DIGEST_ARTICLE_FILE}$`),
    verbatimOrigin: "third_party",
  }, {
    // The shared area: ONLY a filed article and its text companion, which the digest's standing approval for
    // `articles/` covers (ADR-0017, amendment 2026-10-09). No other write, no removal, no listing of the whole area.
    area: "shared",
    listPrefixes: ["articles/"],
    read: new RegExp(`^${DIGEST_ARTICLE_STEM}\\.md$`),
    write: NEVER,
    remove: NEVER,
    verbatim: new RegExp(`^${DIGEST_ARTICLE_FILE}$`),
    verbatimOrigin: "third_party",
  }],
};

export function isScheduledVaultSchedule(name: unknown): name is string {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(SCHEDULED_VAULT_POLICY, name);
}

export function scheduledVaultRule(schedule: string, area: unknown): ScheduledVaultRule | undefined {
  return isScheduledVaultSchedule(schedule) ? SCHEDULED_VAULT_POLICY[schedule]!.find((rule) => rule.area === area) : undefined;
}

export function scheduledPathAllowed(rule: ScheduledVaultRule, operation: "read" | "write" | "remove" | "verbatim", path: unknown): boolean {
  return plainVaultPath(path) && rule[operation].test(path);
}

export function scheduledPrefixAllowed(rule: ScheduledVaultRule, prefix: unknown): prefix is string {
  return typeof prefix === "string" && (prefix === "" ? rule.listAll === true : rule.listPrefixes.includes(prefix));
}

/** A note body in one frame is 256 KB shared with the envelope; the rest is for the frame itself. */
export const SCHEDULED_VAULT_MAX_BODY_BYTES = 192 * 1024;
export const SCHEDULED_VAULT_LIST_DEFAULT = 200;
export const SCHEDULED_VAULT_LIST_MAX = 500;
/** One commit message: a single line, bounded. */
export const scheduledMessageOk = (message: unknown): message is string =>
  typeof message === "string" && message.length > 0 && message.length <= 200 && !/[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(message);

/**
 * Why a verbatim write must be refused, as a sentence, or null when it may go ahead. The bytes are saved as sent, so this
 * is the only place the file is judged: valid text, no NUL, within the body limit; a `.md` file opens with a front-matter
 * block holding exactly one `lares_origin` line equal to the rule's origin; any other file has no front matter at all.
 */
export function scheduledVerbatimRefusal(rule: ScheduledVaultRule, path: unknown, content: unknown): string | null {
  if (!scheduledPathAllowed(rule, "verbatim", path)) return "This schedule may not save a file at that path as it is.";
  if (typeof content !== "string") return "The file to save must be text.";
  if (content.includes("\u0000")) return "The file contains a NUL character, so it is not text.";
  if (Buffer.from(content, "utf8").toString("utf8") !== content) return "The file is not valid UTF-8 text.";
  if (Buffer.byteLength(content, "utf8") > SCHEDULED_VAULT_MAX_BODY_BYTES) return "The file is too large to save in one piece.";
  if (!(path as string).endsWith(".md")) {
    return /^---[ \t]*(?:\r?\n|$)/.test(content) ? "A plain-text companion file must not start with front matter." : null;
  }
  if (!rule.verbatimOrigin) return "This schedule has no origin to stamp on a file saved as it is.";
  // The block is found exactly as the readers find it (`readOriginFrontmatter`, `noteScope`).
  if (!content.startsWith("---\n")) return "A note must start with a front-matter block.";
  const end = content.indexOf("\n---", 4);
  if (end === -1) return "A note must start with a front-matter block.";
  const after = content.slice(end + 4, end + 5);
  if (after !== "" && after !== "\n") return "The front matter must end with a line that is only ---.";
  const block = content.slice(4, end);
  if (block.includes("\r")) return "The front matter must use plain line endings.";
  const originLines = block.split("\n").filter((line) => /^["']?lares_origin["']?[ \t]*:/.test(line));
  if (originLines.length !== 1) return "The front matter must have exactly one lares_origin line.";
  if (originLines[0] !== `lares_origin: ${rule.verbatimOrigin}`) return `The lares_origin of this file must be ${rule.verbatimOrigin}.`;
  if (readOriginFrontmatter(content) !== rule.verbatimOrigin) return `The lares_origin of this file must be ${rule.verbatimOrigin}.`;
  return null;
}
