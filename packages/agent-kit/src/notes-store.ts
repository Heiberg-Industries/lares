import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";

import type { VaultArea } from "./skill-grants.js";

/**
 * The engine behind the Brain and Atlas hands.
 *
 * Both stores are the same shape — a directory of markdown, synced from elsewhere — so
 * they share one implementation and differ only in the env var naming their root. Brain is
 * personal and Saga-only; Atlas is the per-brand business store. Keeping them in one module
 * is what the plan asks for, and it means the ORB-51 posture below is written once.
 *
 * Ported from `services/box/lib/brain-source.ts` (walk, exclusions, tokenised search,
 * backlinks) as a read-only reference — agent-box is untouched by this plan.
 */

export type StoreName = "brain" | "atlas";

const STORE_ENV: Record<StoreName, string> = {
  brain: "VAULT_PATH",
  atlas: "ATLAS_PATH",
};

/** The Vault area an agent is granted, resolved to the legacy store axis above (ADR-0017 rule 1,
 *  Owner decision C4 — `VAULT_PATH`/`ATLAS_PATH` keep their names; only what an agent is GRANTED
 *  changes). `taste` and `facts` are NOT file stores: `taste` has no mount yet (Owner decision
 *  C2) and `facts` names database tables (`standing_facts` and friends), not markdown — every
 *  caller gets `undefined` for those two and must handle it rather than defaulting to the
 *  personal store. */
export function storeForArea(area: VaultArea): StoreName | undefined {
  switch (area) {
    case "private":
      return "brain";
    case "shared":
      return "atlas";
    case "taste":
    case "facts":
      return undefined;
  }
}

/** The area a legacy store answers to. Only the two areas that ARE file stores today have one. */
export function areaForStore(store: StoreName): VaultArea {
  return store === "brain" ? "private" : "shared";
}

// `_meta` is excluded as of ORB-171, and the reason outgrew the ticket that added it. It began
// as a QUALITY bug — searchNotes surfaced Saga's own conversation logs under `_meta/conversations`
// and cited them as Brain knowledge (three of three "Cyrus" hits were her own transcripts). Under
// the multi-user design it is a PRIVACY bug: those logs are one user's private conversations, and
// search would hand them to whoever asked. The exclusion applies to every store uniformly; a
// consumer that genuinely needs `_meta` (the dream cycle) reads it by its own path, never through
// this store's list/search/grep.
const EXCLUDED_DIRS = new Set([".git", ".locks", ".trash", ".obsidian", "node_modules", "_meta"]);

/** No store was configured at all — distinct from a store that is configured but sick. */
export class StorePathNotConfiguredError extends Error {
  constructor(readonly store: StoreName) {
    super(`${store} is not configured: ${STORE_ENV[store]} is unset`);
    this.name = "StorePathNotConfiguredError";
  }
}

/**
 * ORB-51's whole point. A store with no markdown under it — an unmounted volume, a wrong
 * path, an empty clone — must fail loudly. An LLM cannot tell "the vault is broken" from
 * "your query matched nothing" if both come back as an empty list, and the failure mode
 * that produces is the worst kind: she reports, confidently, that Bendik has no notes on
 * something he has written about for a year.
 */
export class StoreUnhealthyError extends Error {
  constructor(readonly root: string) {
    super(`store unhealthy: no markdown files found anywhere under ${root}`);
    this.name = "StoreUnhealthyError";
  }
}

/** The store is healthy; this note is simply not in it. Search again, don't panic. */
export class NoteNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`note not found: ${path}`);
    this.name = "NoteNotFoundError";
  }
}

/** The requested path resolves outside the store — traversal, absolute, or via a symlink. */
export class NotePathEscapesStoreError extends Error {
  constructor(readonly path: string) {
    super(`path escapes the store: ${path}`);
    this.name = "NotePathEscapesStoreError";
  }
}

/** The configured root of a store. Read from the env per call — never at module scope. */
export function storeRoot(store: StoreName, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[STORE_ENV[store]]?.trim();
  if (value === undefined || value.length === 0) throw new StorePathNotConfiguredError(store);
  return value;
}

/** The configured root for a Vault area, resolved through the file store it maps to
 *  (`storeForArea`). Throws naming the area when it has no file store at all (`taste`,
 *  `facts`) — never falls back to the personal store on the caller's behalf; throws
 *  `StorePathNotConfiguredError` when the area DOES map to a store but that store's env var
 *  is unset, exactly as `storeRoot` already does. */
export function storeRootForArea(area: VaultArea, env: NodeJS.ProcessEnv = process.env): string {
  const store = storeForArea(area);
  if (store === undefined) throw new Error(`"${area}" is not a file store — it has no root to read`);
  return storeRoot(store, env);
}

function walk(dir: string, base: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(abs, base));
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      results.push(relative(base, abs));
    }
  }
  return results;
}

/** Every markdown note in the store, store-relative. Throws if the store is sick. */
export function listNotes(root: string): string[] {
  const absRoot = resolve(root);
  let files: string[];
  try {
    files = walk(absRoot, absRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // A missing or non-directory root is the "misconfigured mount" case by another name,
    // so it must surface as the same typed error rather than a raw ENOENT.
    if (code === "ENOENT" || code === "ENOTDIR") throw new StoreUnhealthyError(absRoot);
    throw err;
  }
  if (files.length === 0) throw new StoreUnhealthyError(absRoot);
  return files;
}

export interface SearchResult {
  hits: string[];
  files: number;
}

/**
 * Per-file content cache (ORB-171). searchNotes used to re-read EVERY file on EVERY call —
 * ~980 files per person-lookup on the real Brain — for a corpus that changes a handful of
 * files a day. Keyed by absolute path, invalidated by (mtimeMs, size); a stat per file per
 * search is what a search costs now. Process-local and bounded: at the cap the cache is
 * cleared outright rather than LRU-managed, because the corpus that big means the mount
 * changed under us and stale heuristics are worse than one cold pass.
 */
const CONTENT_CACHE = new Map<string, { mtimeMs: number; size: number; lower: string; raw: string }>();
const CONTENT_CACHE_MAX = 8192;
let cacheFileReads = 0;

/** Test seam: how many real file reads the cache has performed since process start. */
export function _contentCacheReadsForTests(): number {
  return cacheFileReads;
}

function cachedContent(abs: string): { lower: string; raw: string } | null {
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(abs);
  } catch {
    CONTENT_CACHE.delete(abs);
    return null;
  }
  const hit = CONTENT_CACHE.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    CONTENT_CACHE.delete(abs);
    return null;
  }
  cacheFileReads++;
  if (CONTENT_CACHE.size >= CONTENT_CACHE_MAX) CONTENT_CACHE.clear();
  const entry = { mtimeMs: st.mtimeMs, size: st.size, lower: raw.toLowerCase(), raw };
  CONTENT_CACHE.set(abs, entry);
  return entry;
}

/**
 * Tokenised search. LLM callers send natural multi-word queries ("Vol de Nuit
 * positioning"); tokens are unicode word chunks (æøå safe), under two characters dropped.
 * A note hits when ALL tokens appear in its path or content.
 *
 * THE FALLBACK IS ANCHORED (ORB-171). It used to rank any-token hits — and on the live
 * Atlas that returned three files for "atcyrus.com" that contained the token `com` and the
 * subject zero times, which the org-lookup then printed as paths worth opening. The rule
 * now: a fallback hit must contain the query's MOST DISTINCTIVE token — lowest document
 * frequency, ties broken by length — and when that token appears NOWHERE, the fallback
 * returns nothing, because the store genuinely lacks the subject and anything else is
 * noise wearing a path. An honest empty beats a plausible wrong list; this is the same
 * lesson as ORB-168's geocoder, one layer up.
 */
export function searchNotes(query: string, root: string, reader?: Reader): SearchResult {
  const absRoot = resolve(root);
  const files = listNotes(absRoot);

  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return { hits: [], files: files.length };

  const scored = files.map((relPath) => {
    let haystack = relPath.toLowerCase();
    const cached = cachedContent(join(absRoot, relPath));
    if (cached !== null) haystack += "\n" + cached.lower;
    // an unreadable entry scores on its path alone rather than being dropped silently
    const present = tokens.filter((t) => haystack.includes(t));
    return { relPath, present, n: present.length, raw: cached?.raw ?? "" };
  });

  // The scope filter reads `raw` off the SAME cache entry the scorer just populated — no
  // extra file reads. An unreadable file (raw === "") falls back to the store's default
  // scope via noteScope(""), same as any note with no frontmatter.
  const rawByPath = new Map(scored.map((s) => [s.relPath, s.raw]));
  const visible = (relPaths: string[]): string[] =>
    reader === undefined ? relPaths : relPaths.filter((p) => visibleTo(rawByPath.get(p) ?? "", reader));

  const all = scored.filter((s) => s.n === tokens.length).map((s) => s.relPath);
  if (all.length > 0) return { hits: visible(all), files: files.length };

  // Document frequency per token, over path+content. The ANCHOR SET is every token tied for
  // the lowest df — equally distinctive tokens are equally valid anchors, so "vol nuit" over
  // one vol-file and one nuit-file still returns both (the pre-ORB-171 contract). When the
  // lowest df is ZERO the most distinctive thing asked for appears nowhere, and the fallback
  // returns nothing at all.
  const df = new Map<string, number>(tokens.map((t) => [t, 0]));
  for (const s of scored) for (const t of s.present) df.set(t, (df.get(t) ?? 0) + 1);
  const minDf = Math.min(...tokens.map((t) => df.get(t)!));
  if (minDf === 0) return { hits: [], files: files.length };
  const anchors = new Set(tokens.filter((t) => df.get(t) === minDf));

  const hits = scored
    .filter((s) => s.present.some((t) => anchors.has(t)))
    .sort((a, b) => b.n - a.n)
    .slice(0, 20)
    .map((s) => s.relPath);
  return { hits: visible(hits), files: files.length };
}

/**
 * Whether an absolute path stays inside `root`, lexically AND after symlinks are followed.
 *
 * Both halves are load-bearing. The lexical check alone lets a symlink inside the store
 * read anything it points at; the resolved check alone is not enough either, because a
 * ROOT can itself be a symlink (/srv could be a link to a data volume; on macOS /var is
 * /private/var) and comparing a resolved path against an unresolved root denies everything.
 *
 * A path that cannot be resolved — one that does not exist yet — is judged on its lexical
 * form alone. It reads nothing, and the caller reports it as missing in its own words
 * rather than as a permission refusal.
 *
 * This began life in lib/fs-allowlist.ts, the ORB-52 fence around eve's built-in
 * read_file/glob/grep. Those tools were disabled outright on 2026-08-13 (see
 * agent/tools/read_file.ts) and the fence went with them; only this primitive survives,
 * here, where it is actually used. `git show cee7a998` has the fence if it is ever needed.
 */
function resolvesWithin(candidate: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  // Boundary-aware: a plain startsWith would let /srv/brain-private pass as /srv/brain.
  const isUnder = (path: string, base: string): boolean =>
    path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);

  if (!isUnder(resolve(candidate), resolvedRoot)) return false;
  let real: string;
  try {
    real = realpathSync(resolve(candidate));
  } catch {
    return true;
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(resolvedRoot);
  } catch {
    // An unresolvable root matches nothing real — the fail-closed direction.
    realRoot = resolvedRoot;
  }
  return isUnder(real, realRoot);
}

/**
 * Resolves a store-relative path to an absolute one, refusing anything that lands outside
 * the store. Absolute inputs are refused outright rather than accepted-if-inside: these
 * tools take store-relative paths, and accepting both forms is how a caller ends up
 * reasoning about container paths it should never see.
 *
 * Exported (Task 9 / ORB-52) so the Brain write path (`lib/vault-git.ts`) reuses this
 * traversal/symlink-safe containment check rather than reimplementing the old
 * `brain-source.ts`'s simpler prefix-only `assertSafe`.
 */
export function resolveInStore(notePath: string, root: string): string {
  const absRoot = resolve(root);
  if (notePath.startsWith("/")) throw new NotePathEscapesStoreError(notePath);
  // ORB-153 (3) — an in-store dotfile directory is not a note. `.git/` is the store's own
  // history and `.locks/` its lock files; a tool reaching either through a "note path" is
  // reaching past the store even though the path never leaves the directory. Every segment
  // is checked, so `notes/.hidden.md` and `.` fail the same way. Defence in depth: today no
  // tool takes a model-supplied write path (writes derive `_inbox/<slug>.md`; drop and file
  // route through `git rm`/`git mv`, which refuse `.git/` anyway) — closed while it is cheap.
  if (notePath.split(/[\\/]+/).some((segment) => segment.startsWith("."))) {
    throw new NotePathEscapesStoreError(notePath);
  }
  const abs = resolve(absRoot, notePath);
  if (!resolvesWithin(abs, absRoot)) throw new NotePathEscapesStoreError(notePath);
  return abs;
}

export interface NoteContent {
  path: string;
  content: string;
  lines: number;
}

// ── Knowledge scope (multi-user substrate, spec Part 2) ────────────────────────────────
// Three scopes, assigned by frontmatter with a per-store default — policy-per-source, not
// per-document ACLs. Parsed with a small hand parser, NOT a YAML library: the store already
// avoids heavyweight deps, and the grammar here is three known keys.
export type NoteScope = "org" | "participants" | "private";

export interface ScopeInfo {
  scope: NoteScope;
  participants: string[]; // canonical user ids; only meaningful when scope === "participants"
  owner?: string;         // canonical user id; only meaningful when scope === "private"
}

const STORE_DEFAULT_SCOPE: Readonly<Record<StoreName, NoteScope>> = {
  brain: "private", // personal knowledge — the spec's shipped default
  atlas: "org",     // business knowledge — every member benefits, none of it is personal
};

export function noteScope(raw: string, store: StoreName): ScopeInfo {
  const fallback: ScopeInfo = { scope: STORE_DEFAULT_SCOPE[store], participants: [], owner: undefined };
  // A CRLF-saved file ("---\r\n") used to defeat this LF-only check and fall back to the store
  // default — in atlas that meant an explicit `scope: private` silently WIDENED to `org`, the one
  // malformed-input path that widened past a declared value rather than narrowing. Normalised
  // here, once, so every read below sees LF. (LAR pre-launch wave 3A.)
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return fallback;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return fallback;
  const head = text.slice(4, end);
  const get = (key: string): string | undefined => {
    const m = head.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m?.[1]?.trim();
  };
  const declared = get("scope");
  const participants = (get("participants") ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const owner = get("owner");
  if (declared === "org" || declared === "participants" || declared === "private") {
    return { scope: declared, participants, owner };
  }
  // Unknown or absent value → the store default. For brain that IS private; for atlas the
  // default is org, which is what the spec ships — a typo can never widen past the default.
  return { ...fallback, participants, owner };
}

// ── Reader scope filter (multi-user substrate, spec Part 2, Task 5) ────────────────────
// Applied ONCE, here, below every tool — a tool that forgets to pass a reader gets the
// legacy unfiltered path, never a leak. `reader` absent is the single-user default.
export interface Reader {
  userId: string;
  store: StoreName;
}

const SCOPE_ORDER: Readonly<Record<NoteScope, number>> = { private: 0, participants: 1, org: 2 };

/** For derivation writers: a note built from several sources inherits the narrowest scope. */
export function narrowestScope(scopes: NoteScope[]): NoteScope {
  // No sources = no evidence the derivation may spread: private, the narrowest.
  let n: NoteScope = scopes[0] ?? "private";
  for (const s of scopes) if (SCOPE_ORDER[s] < SCOPE_ORDER[n]) n = s;
  return n;
}

function visibleTo(raw: string, reader: Reader): boolean {
  const info = noteScope(raw, reader.store);
  if (info.scope === "org") return true;
  if (info.scope === "participants") return info.participants.includes(reader.userId);
  // private: an explicit owner must match. A brain note with NO owner frontmatter is the
  // store owner's — today's whole vault. The store's owner is not knowable from the file
  // alone, so an owner-less private note in a SHARED store (atlas) is visible to nobody but
  // via the legacy path; in brain it is visible (one vault = one owner until the per-user
  // layout lands — see the second-user runbook).
  if (info.owner !== undefined) return info.owner === reader.userId;
  return reader.store === "brain";
}

export function readNote(notePath: string, root: string, reader?: Reader): NoteContent {
  const abs = resolveInStore(notePath, root);
  // Health is checked BEFORE the read so an unmounted store reports as unhealthy rather
  // than as "that note doesn't exist" — the ORB-51 distinction, applied to reads.
  listNotes(root);
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") throw new NoteNotFoundError(notePath);
    throw err;
  }
  // An invisible note throws the SAME error as a missing one — an existence oracle is
  // itself a leak. No separate "forbidden" error class exists, and none should.
  if (reader !== undefined && !visibleTo(content, reader)) throw new NoteNotFoundError(notePath);
  // Counted the way eve's own read_file counts (a trailing newline does not add a line),
  // so the two tools never disagree about the size of the same file.
  const parts = content.split("\n");
  const lines = parts.length > 0 && parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
  return { path: notePath, content, lines };
}

export interface BacklinkResult {
  path: string;
  backlinks: string[];
  files: number;
}

/**
 * Notes that wikilink to this one.
 *
 * Obsidian's link form is `[[note-name]]`, optionally with `|an alias` or `#a-heading`.
 * The reference implementation in agent-box interpolates the note name straight into a
 * RegExp; here it is escaped, because a note called `c++ (notes)` is either a syntax error
 * or a pattern matching the wrong thing.
 */
export function findBacklinks(notePath: string, root: string, reader?: Reader): BacklinkResult {
  resolveInStore(notePath, root);
  const absRoot = resolve(root);
  const files = listNotes(absRoot);
  const stem = basename(notePath, ".md").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // The `[|#\]]` boundary is what keeps [[frameworks-extended]] from counting as a link to
  // [[frameworks]] — Obsidian treats those as different notes.
  const pattern = new RegExp(`\\[\\[${stem}(?=[|#\\]])[^\\]]*\\]\\]`, "iu");

  const backlinks = files.filter((relPath) => {
    if (relPath === notePath) return false;
    const cached = cachedContent(join(absRoot, relPath)); // ORB-171: same cache as searchNotes
    if (cached === null || !pattern.test(cached.raw)) return false;
    // A citer that the reader cannot see must not out itself by name — the citing note's
    // OWN visibility gates it, same rule as a search hit.
    if (reader !== undefined && !visibleTo(cached.raw, reader)) return false;
    return true;
  });
  return { path: notePath, backlinks, files: files.length };
}

/** Present for symmetry with readNote — used by the tools to report store size. */
export function storeSize(root: string): number {
  return listNotes(root).length;
}

/** Whether a store-relative path points at a directory, used to give a better error. */
export function isDirectory(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}
