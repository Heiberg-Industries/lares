// services/console/lib/taste-store.ts — the console's read/write layer over /srv/taste.
//
// The console is the taste store's EDITOR: the only writer in v1 (ORB-97's access model — no
// agent writes it; Marcel mounts the same path read-only). This file owns the filesystem half;
// @lares/taste owns what a file MEANS, and is the same package Marcel parses with, so the two
// sides cannot drift.
//
// Everything here is synchronous. The store is a handful of small files on a local bind mount,
// written by one operator clicking a button — async would buy nothing and cost clarity.
import fs from "node:fs";
import path from "node:path";

import {
  TASTE_DOMAINS,
  assignFilenames,
  domainFor,
  entryFilename,
  parseEntry,
  serializeEntry,
  type TasteDomain,
  type TasteEntry,
} from "@lares/taste";

export function tasteRoot(): string {
  return process.env.TASTE_ROOT ?? "/srv/taste";
}

/** One file on disk. `entry` is null when the file could not be parsed — an unreadable file must
 *  show up in the browse view (where it can be deleted) rather than crashing the page or, worse,
 *  silently vanishing from a list Bendik is using to decide what he has. */
export interface StoredEntry {
  domain: TasteDomain;
  file: string;
  entry: TasteEntry | null;
  error?: string;
}

/** Filenames come from `entryFilename` on the write path, but the DELETE path takes one from the
 *  browser. Anything with a separator, a traversal segment, or a non-.md suffix is refused
 *  outright — the console runs with write access to a mounted host directory, and this is the
 *  only place a caller-supplied path component reaches the filesystem. */
export function assertSafeFilename(file: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(file) || file.includes("..")) {
    throw new Error(`taste: refusing unsafe file name "${file}"`);
  }
}

export function assertDomain(domain: string): TasteDomain {
  if (!(TASTE_DOMAINS as readonly string[]).includes(domain)) {
    throw new Error(`taste: unknown domain "${domain}"`);
  }
  return domain as TasteDomain;
}

function domainDir(domain: TasteDomain): string {
  return path.join(tasteRoot(), domain);
}

export function listDomain(domain: TasteDomain): StoredEntry[] {
  const dir = domainDir(domain);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    // Store not mounted yet, or the domain folder never created: an empty domain, not an error.
    return [];
  }
  return files.map((file) => {
    try {
      return { domain, file, entry: parseEntry(fs.readFileSync(path.join(dir, file), "utf8")) };
    } catch (err) {
      return { domain, file, entry: null, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

export function listAll(): Record<TasteDomain, StoredEntry[]> {
  return Object.fromEntries(TASTE_DOMAINS.map((d) => [d, listDomain(d)])) as Record<TasteDomain, StoredEntry[]>;
}

export interface WriteResult {
  /** Entries that landed on a path nothing occupied. */
  added: number;
  /** Entries that overwrote an existing file — the upsert half of "re-import creates no
   *  duplicates". Counted before writing, so the number reported is the number replaced. */
  replaced: number;
  /** Entries whose name could not become a filename at all, with the reason. Reported rather
   *  than thrown: one unusable row must not sink an import of two hundred good ones. */
  skipped: Array<{ name: string; reason: string }>;
}

/** What the store already holds at that exact path, or nothing. Used only to carry a stamp
 *  forward; an unreadable file is treated as absent, because the write is about to replace it. */
function priorAt(full: string): TasteEntry | null {
  try {
    return parseEntry(fs.readFileSync(full, "utf8"));
  } catch {
    return null;
  }
}

export function writeEntries(entries: readonly TasteEntry[], now: Date = new Date()): WriteResult {
  const at = now.toISOString();
  const result: WriteResult = { added: 0, replaced: 0, skipped: [] };

  // Filenames are assigned across the WHOLE batch, not per entry: a saved list routinely holds
  // one name at several places (Bendik's NYC list has two Supremes, two Roberta's, two Santo
  // Tacos — separate outlets, blocks apart, and some chains have more). Named per entry, each
  // group collapsed to one file and the other outlets vanished silently.
  // Unusable entries are filtered BEFORE the batch step, one at a time, because
  // `assignFilenames` names the whole batch at once: a single unnameable row reaching it would
  // throw and take every good row with it. One bad row must cost only itself.
  const assignable: TasteEntry[] = [];
  for (const entry of entries) {
    try {
      serializeEntry(entry);
      entryFilename(entry);
      assignable.push(entry);
    } catch (err) {
      result.skipped.push({ name: entry.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const { entry, file } of assignFilenames(assignable)) {
    const dir = domainDir(domainFor(entry.type));
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, file);
    const existed = fs.existsSync(full);

    // The paste path has no diff to consult, so the file on disk IS the prior state (ORB-110):
    // nothing there -> newly imported; something there -> updated now, keeping whatever
    // `importedAt` it already carried. Re-pasting a list is a deliberate act, so unlike the
    // Takeout re-upload this does not compare content first.
    const prior = existed ? priorAt(full) : null;
    const stamped: TasteEntry = existed
      ? { ...entry, ...(prior?.importedAt === undefined ? {} : { importedAt: prior.importedAt }), updatedAt: at }
      : { ...entry, importedAt: at };

    fs.writeFileSync(full, serializeEntry(stamped));
    if (existed) result.replaced++;
    else result.added++;
  }
  return result;
}

/** Writes one already-named, already-serialised place file. The batch import owns naming
 *  (`applyListDiff` -> `assignFilenames`), so it needs a writer that does not re-derive one. */
export function writeRawEntry(file: string, body: string): void {
  assertSafeFilename(file);
  const dir = domainDir("places");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
}

export function deleteEntry(domain: TasteDomain, file: string): boolean {
  assertSafeFilename(file);
  const full = path.join(domainDir(domain), file);
  if (!fs.existsSync(full)) return false;
  fs.unlinkSync(full);
  return true;
}

/**
 * Freeform pasted text → list items. Bendik pastes whatever he has: a bulleted list, a numbered
 * one, or bare lines out of a note. All three are the same list, so all three parse the same.
 */
export function parsePastedLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, "").trim())
    .filter((l) => l !== "");
}
