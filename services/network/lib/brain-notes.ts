import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Db } from "./db.js";
import { STRENGTH_LEVELS } from "@lares/strength";

export type ChannelStat = { channel: string; n: number; lastAt: string };
export type BrainSignal = { kind: string; at: string; evidence: string | null };

export type BrainContact = {
  id: number;
  displayName: string;
  company: string | null;
  title: string | null;
  band: string;
  dormantWarm: boolean;
  lastInteractionAt: string | null;
  twentyId: string | null;
  linkedinUrl: string | null;
  channels: ChannelStat[];
  signals: BrainSignal[];
};

/**
 * Active relationships: warm now (GOOD+) or in the reactivation queue
 * (dormant_warm). Bare handles (resolved = 0) excluded. NEVER selects
 * interactions.content — notes are derived metadata only (privacy section
 * of the 2026-06-10 design spec).
 */
export function selectActiveContacts(db: Db): BrainContact[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.display_name AS displayName, c.company, c.title,
              p.band, p.dormant_warm AS dormantWarm,
              p.last_interaction_at AS lastInteractionAt,
              c.twenty_id_cache AS twentyId
       FROM pulse p JOIN contacts c ON c.id = p.contact_id
       WHERE c.resolved = 1
         AND (p.dormant_warm = 1 OR p.band IN ('GOOD','STRONG','VERY_STRONG'))
       ORDER BY c.display_name, c.id`,
    )
    .all() as Array<Omit<BrainContact, "dormantWarm" | "linkedinUrl" | "channels" | "signals"> & { dormantWarm: number }>;

  const channelStmt = db.prepare(
    `SELECT channel, COUNT(*) AS n, MAX(at) AS lastAt
     FROM interactions
     WHERE contact_id = ? AND channel != 'linkedin_invite'
       AND (channel != 'call' OR answered = 1)
     GROUP BY channel
     ORDER BY n DESC, lastAt DESC, channel`,
  );
  const linkedinStmt = db.prepare(
    "SELECT value FROM identities WHERE contact_id = ? AND kind = 'linkedin_url' ORDER BY id LIMIT 1",
  );
  const signalStmt = db.prepare(
    "SELECT kind, at, evidence FROM signals WHERE contact_id = ? ORDER BY at DESC",
  );

  return rows.map((r) => ({
    ...r,
    dormantWarm: !!r.dormantWarm,
    linkedinUrl: (linkedinStmt.get(r.id) as { value: string } | undefined)?.value ?? null,
    channels: channelStmt.all(r.id) as ChannelStat[],
    signals: signalStmt.all(r.id) as BrainSignal[],
  }));
}

/** ASCII slug; ø/æ get explicit mappings (NFKD does not decompose them). */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "unnamed";
}

/**
 * Person slugs; name collisions within the set get a `-<id>` suffix. NOTE:
 * a slug can change when the collision set changes (a second "John Smith"
 * turning warm renames the first). The regenerator self-heals — the old
 * file is deleted via its owner marker and all links are regenerated — at
 * the cost of resetting that note's `created:` date.
 */
export function assignSlugs(contacts: BrainContact[]): Map<number, string> {
  const counts = new Map<string, number>();
  for (const c of contacts) {
    const s = slugify(c.displayName);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const out = new Map<number, string>();
  for (const c of contacts) {
    const s = slugify(c.displayName);
    out.set(c.id, counts.get(s)! > 1 ? `${s}-${c.id}` : s);
  }
  return out;
}

/** Where the relationship lives: most interactions, ties broken by recency. */
export function preferredChannel(channels: ChannelStat[]): string | null {
  if (channels.length === 0) return null;
  const top = [...channels].sort((a, b) => b.n - a.n || b.lastAt.localeCompare(a.lastAt))[0]!;
  return top.channel;
}

// ---------------------------------------------------------------------------
// Note composers — pure markdown, no I/O
// ---------------------------------------------------------------------------

const CHANNEL_LABELS: Record<string, string> = { imessage: "iMessage", linkedin: "LinkedIn", call: "Phone", instagram: "Instagram", facebook: "Facebook" };
const label = (channel: string): string => CHANNEL_LABELS[channel] ?? channel;
const bandRank = (band: string): number => STRENGTH_LEVELS.indexOf(band as (typeof STRENGTH_LEVELS)[number]);

/**
 * Contact-sourced strings go into markdown body text and wikilink aliases;
 * collapse whitespace and strip link metacharacters so a weird display name
 * can only mangle its own line, never the note structure. Frontmatter titles
 * don't need this — they're JSON-escaped.
 */
const clean = (s: string): string => s.replace(/\s+/g, " ").replace(/\|/g, "/").replace(/\]\]/g, ")]").trim();

/** Loud failure beats publishing a broken [[undefined|...]] link. */
function slugFor(slugs: Map<number, string>, c: BrainContact): string {
  const s = slugs.get(c.id);
  if (!s) throw new Error(`no slug assigned for contact ${c.id} (${c.displayName})`);
  return s;
}

const FOOTER = "*Auto-generated nightly by `pnpm network brain-notes` — edits here are overwritten.*";
const SOURCE_LINE = 'source: "~/.lares/network.db (derived)"';

function renderEvidence(evidence: string | null): string {
  if (!evidence) return "";
  try {
    const parsed = JSON.parse(evidence) as unknown;
    if (typeof parsed !== "object" || parsed === null) return ` (${clean(String(parsed))})`;
    const entries = Object.entries(parsed as Record<string, unknown>);
    return entries.length ? ` (${entries.map(([k, v]) => `${clean(k)}: ${clean(String(v))}`).join(", ")})` : "";
  } catch {
    return ` (${clean(evidence)})`;
  }
}

export function composePersonNote(c: BrainContact, opts: { created: string; companySlug: string | null; owner: string }): string {
  const last = c.lastInteractionAt?.slice(0, 10) ?? null;
  const pref = preferredChannel(c.channels);
  const lastChannel = c.channels.length
    ? [...c.channels].sort((a, b) => b.lastAt.localeCompare(a.lastAt))[0]!.channel
    : null;

  const summary = [
    c.title && c.company ? `${clean(c.title)}, ${clean(c.company)}` : (c.title ? clean(c.title) : c.company ? clean(c.company) : null),
    c.dormantWarm ? `${c.band} — in the reactivation queue` : c.band,
    last ? `last contact ${last}${lastChannel ? ` via ${label(lastChannel)}` : ""}` : "no logged interactions",
  ].filter(Boolean).join(" · ");

  const facts: string[] = [];
  if (c.company) facts.push(`- **Company:** ${opts.companySlug ? `[[${opts.companySlug}|${clean(c.company)}]]` : clean(c.company)}`);
  if (c.title) facts.push(`- **Title:** ${clean(c.title)}`);
  if (pref) facts.push(`- **Preferred channel:** ${label(pref)}`);
  if (c.channels.length) {
    const stats = [...c.channels]
      .sort((a, b) => b.n - a.n || a.channel.localeCompare(b.channel))
      .map((ch) => `${label(ch.channel)} — ${ch.n}×, last ${ch.lastAt.slice(0, 10)}`)
      .join(" · ");
    facts.push(`- **Channels:** ${stats}`);
  }
  if (c.linkedinUrl) facts.push(`- **LinkedIn:** ${c.linkedinUrl}`);
  facts.push(`- **CRM:** ${c.twentyId ? "linked to Twenty" : "not in Twenty"}`);

  const signals = c.signals.length
    ? ["", "## Signals", ...c.signals.map((s) => `- ${s.at.slice(0, 10)} — ${s.kind}${renderEvidence(s.evidence)}`)]
    : [];

  return [
    "---",
    `title: ${JSON.stringify(c.displayName)}`,
    "type: person",
    SOURCE_LINE,
    "origin: network",
    `owner: ${opts.owner}`,
    `created: ${opts.created}`,
    `pulse_band: ${c.band}`,
    `dormant_warm: ${c.dormantWarm}`,
    ...(last ? [`last_interaction: ${last}`] : []),
    "tags: [network, person]",
    "---",
    "",
    `# ${clean(c.displayName)}`,
    "",
    `> [!summary] ${summary}.`,
    "",
    ...facts,
    ...signals,
    "",
    FOOTER,
    "",
  ].join("\n");
}

export function composeCompanyNote(
  name: string,
  people: BrainContact[],
  slugs: Map<number, string>,
  opts: { created: string; owner: string },
): string {
  const sorted = [...people].sort(
    (a, b) => bandRank(b.band) - bandRank(a.band) || a.displayName.localeCompare(b.displayName),
  );
  return [
    "---",
    `title: ${JSON.stringify(name)}`,
    "type: company",
    SOURCE_LINE,
    "origin: network",
    `owner: ${opts.owner}`,
    `created: ${opts.created}`,
    `people_count: ${people.length}`,
    "tags: [network, company]",
    "---",
    "",
    `# ${clean(name)}`,
    "",
    `> [!summary] ${people.length} active relationship${people.length === 1 ? "" : "s"} at ${clean(name)}.`,
    "",
    ...sorted.map((p) => {
      const bits = [
        p.title ? clean(p.title) : null,
        p.dormantWarm ? `${p.band} (dormant)` : p.band,
        p.lastInteractionAt ? `last ${p.lastInteractionAt.slice(0, 10)}` : null,
      ].filter(Boolean);
      return `- [[${slugFor(slugs, p)}|${clean(p.displayName)}]] — ${bits.join(" · ")}`;
    }),
    "",
    FOOTER,
    "",
  ].join("\n");
}

export function composeMapPage(
  contacts: BrainContact[],
  slugs: Map<number, string>,
  companies: Map<string, { name: string; people: BrainContact[] }>,
  opts: { created: string; owner: string },
): string {
  const line = (c: BrainContact, withBand: boolean) => {
    const bits = [
      withBand ? c.band : null,
      c.company ? clean(c.company) : null,
      c.lastInteractionAt ? `last ${c.lastInteractionAt.slice(0, 10)}` : null,
    ].filter(Boolean);
    return `- [[${slugFor(slugs, c)}|${clean(c.displayName)}]]${bits.length ? ` — ${bits.join(" · ")}` : ""}`;
  };
  const warm = contacts
    .filter((c) => !c.dormantWarm)
    .sort((a, b) => bandRank(b.band) - bandRank(a.band) || a.displayName.localeCompare(b.displayName));
  const dormant = contacts
    .filter((c) => c.dormantWarm)
    .sort((a, b) => (b.lastInteractionAt ?? "").localeCompare(a.lastInteractionAt ?? ""));
  const companyList = [...companies.entries()].sort(
    (a, b) => b[1].people.length - a[1].people.length || a[1].name.localeCompare(b[1].name),
  );

  return [
    "---",
    'title: "Network — warm contacts & companies"',
    "type: overview",
    SOURCE_LINE,
    "origin: network",
    `owner: ${opts.owner}`,
    `created: ${opts.created}`,
    "tags: [network, overview]",
    "---",
    "",
    "# Network — warm contacts & companies",
    "",
    `> [!summary] ${contacts.length} active relationships (${warm.length} warm, ${dormant.length} in the reactivation queue) across ${companies.size} companies. Regenerated nightly from the network db.`,
    "",
    "## Warm",
    ...warm.map((c) => line(c, true)),
    "",
    "## Reactivation queue (once warm, gone quiet)",
    ...dormant.map((c) => line(c, false)),
    "",
    "## Companies",
    ...companyList.map(([slug, g]) => `- [[${slug}|${clean(g.name)}]] — ${g.people.length}`),
    "",
    FOOTER,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Orchestrator — file I/O
// ---------------------------------------------------------------------------

export type BrainNotesResult = {
  dryRun: boolean;
  /** Paths created or updated this run. */
  written: string[];
  /** Planned files whose content was already up to date. */
  unchanged: number;
  /** Stale owner-marked files retired to the vault's tracked `_archive/`. */
  deleted: string[];
  /** Archived notes removed because their contact turned warm again. */
  reclaimed: string[];
  /** Files in managed dirs that could not be read; left alone, reported. */
  skipped: string[];
};

/** The importer's marker only counts inside the YAML frontmatter block — a note that merely
 * mentions it in body text is not ours. New form: `origin: network` (the importer) beside
 * `owner: <person>` (the member whose network this is — the Brain's scope filter shows a private
 * note only to its owner, and `network` is not a person; 2026-09-07). Legacy form `owner: network`
 * is still recognised so a re-run can retire and rewrite files written before the change. */
export function isNetworkOwned(content: string): boolean {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return fm ? /^(origin: network|owner: network)\r?$/m.test(fm[1]!) : false;
}

function createdFor(path: string, today: string): string {
  if (!existsSync(path)) return today;
  try {
    const m = readFileSync(path, "utf8").match(/^created: (\d{4}-\d{2}-\d{2})$/m);
    return m?.[1] ?? today;
  } catch {
    return today;
  }
}

export function regenerateBrainNotes(
  db: Db,
  opts: { vaultPath: string; now: Date; dryRun?: boolean; owner: string },
): BrainNotesResult {
  const dryRun = !!opts.dryRun;
  const today = opts.now.toISOString().slice(0, 10);
  const peopleDir = join(opts.vaultPath, "wiki", "people");
  const companiesDir = join(opts.vaultPath, "wiki", "companies");
  const mapPath = join(opts.vaultPath, "wiki", "network.md");

  /**
   * Where a retired note goes: `_archive/wiki/<people|companies>/`, mirroring
   * the live tree.
   *
   * NOT the vault's `.trash/`, which is where this used to write. `.trash/` is
   * gitignored and owned by Obsidian's "Empty trash" command, so a retired note
   * never reached the box, no agent could ever read it, and it was one menu
   * click from gone. A relationship going quiet is precisely when the context
   * is worth keeping — so retirement must archive, not discard.
   *
   * Mirroring the subdirectory (rather than one flat folder) keeps a person and
   * a company that slugify identically from colliding in the archive.
   *
   * Returns null for a planned path outside the two managed dirs (the map page),
   * which is never archived and never reclaimed.
   */
  const archiveDirFor = (dir: string): string | null =>
    dir === peopleDir
      ? join(opts.vaultPath, "_archive", "wiki", "people")
      : dir === companiesDir
        ? join(opts.vaultPath, "_archive", "wiki", "companies")
        : null;

  const contacts = selectActiveContacts(db);
  const slugs = assignSlugs(contacts);

  // Group people by company (slug-keyed so "Acme"/"acme " collapse).
  const companies = new Map<string, { name: string; people: BrainContact[] }>();
  for (const c of contacts) {
    const name = c.company?.trim();
    if (!name) continue;
    const key = slugify(name);
    const group = companies.get(key) ?? { name, people: [] };
    group.people.push(c);
    companies.set(key, group);
  }

  const planned = new Map<string, string>(); // absolute path → content
  for (const c of contacts) {
    const path = join(peopleDir, `${slugs.get(c.id)!}.md`);
    const companySlug = c.company?.trim() ? slugify(c.company.trim()) : null;
    planned.set(path, composePersonNote(c, { created: createdFor(path, today), companySlug, owner: opts.owner }));
  }
  for (const [slug, group] of companies) {
    const path = join(companiesDir, `${slug}.md`);
    planned.set(path, composeCompanyNote(group.name, group.people, slugs, { created: createdFor(path, today), owner: opts.owner }));
  }
  planned.set(mapPath, composeMapPage(contacts, slugs, companies, { created: createdFor(mapPath, today), owner: opts.owner }));

  const written: string[] = [];
  const deleted: string[] = [];
  const reclaimed: string[] = [];
  const skipped: string[] = [];
  let unchanged = 0;

  if (!dryRun) {
    mkdirSync(peopleDir, { recursive: true });
    mkdirSync(companiesDir, { recursive: true });
  }
  for (const [path, content] of planned) {
    let existing: string | null = null;
    if (existsSync(path)) {
      try {
        existing = readFileSync(path, "utf8");
      } catch {
        // Unreadable on-disk file (permissions, iCloud eviction): writing
        // over it would likely fail too — leave it alone and report it.
        skipped.push(path);
        continue;
      }
    }
    if (existing !== null && !isNetworkOwned(existing)) {
      // A hand-authored file sits at a planned path: never overwrite it.
      // (Generated content always carries the marker, so a marker-less
      // file here cannot be ours.)
      skipped.push(path);
      continue;
    }
    if (existing === content) {
      unchanged++;
      continue;
    }
    if (!dryRun) writeFileSync(path, content);
    written.push(path);
  }

  // A contact who turns warm again gets a live note back — so any archived copy
  // must go, or a search finds two notes for one person and the stale one wins
  // as often as not. This is the exact inverse of the retire pass below, and it
  // has to run every time: a note that is `unchanged` on disk can still have an
  // archived twin from an earlier cycle.
  const skippedPaths = new Set(skipped);
  for (const path of planned.keys()) {
    if (skippedPaths.has(path)) continue; // not ours to reclaim for
    const archiveDir = archiveDirFor(dirname(path));
    if (!archiveDir) continue;
    const archived = join(archiveDir, basename(path));
    if (!existsSync(archived)) continue;
    if (!dryRun) rmSync(archived);
    reclaimed.push(archived);
  }

  // Retire machine-owned notes that fell out of the active set. The marker
  // must sit in the frontmatter; body-text mentions don't count. Retired notes
  // move to the vault's tracked `_archive/` so a cooled relationship stays
  // readable to agents and a mistaken retirement is reversible. An unreadable
  // neighbor file is skipped and reported — one bad file must not kill the
  // nightly run.
  for (const dir of [peopleDir, companiesDir]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const path = join(dir, f);
      if (planned.has(path)) continue;
      let content: string;
      try {
        content = readFileSync(path, "utf8");
      } catch {
        skipped.push(path);
        continue;
      }
      if (!isNetworkOwned(content)) continue;
      const archiveDir = archiveDirFor(dir);
      if (!archiveDir) continue;
      if (!dryRun) {
        mkdirSync(archiveDir, { recursive: true });
        let dest = join(archiveDir, f);
        for (let i = 2; existsSync(dest); i++) dest = join(archiveDir, `${f.slice(0, -3)}-${i}.md`);
        renameSync(path, dest);
      }
      deleted.push(path);
    }
  }

  return { dryRun, written, unchanged, deleted, reclaimed, skipped };
}
