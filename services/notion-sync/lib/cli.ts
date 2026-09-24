import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { poolFromEnv, type Queryable } from "@lares/agent-box";
import { loadNotionSyncConfig } from "./config.js";
import type { NotionSyncConfig } from "./types.js";
import {
  DEFAULT_CREATED_TOLERANCE_MINUTES, DEFAULT_STARVATION_STREAK,
  DEFAULT_STARVATION_WINDOW_DAYS, DEFAULT_TOLERANCE_MINUTES,
} from "./attendees.js";
import { makeNotionClient } from "./adapters/notion-client.js";
import { makeCalendarSource, type CalendarOrgConfig } from "./adapters/calendar-source.js";
import { makeVaultFiles, makeVaultWalk } from "./adapters/vault-files.js";
import { makeVaultWriter } from "./adapters/vault-writer.js";
import { makeSignalNotify, type Notify } from "./adapters/signal-notify.js";
import { makeDeskExclusion, makeCreateScope, withoutExcluded } from "./desk-scope.js";
import { TWO_WAY, vaultOwns, notionOwns, pushHoldBack } from "./direction.js";
import {
  recordMeetingSynced, recordMeetingUnmatched, recordMeetingError, setLastRunAt, countByState,
  getDocRows, upsertDocSynced, recordDocError, markDocOrphaned, replaceFidelity,
  getDeskRows, getOpenProposals, setProposalState, unfreezeDoc, insertProposal,
  getFrozenDocs, getStaleProposals, getRejectedUnexecuted, markProposalReverted, updateNotionWatermark,
  freezeDoc, setDocDirection, getFidelityPassed, resolveProposal,
  getLinkedRows, getMeetingRows, ensureMeetingRow, linkPageToVaultFile, recordNotionAccounted,
  getPageRows, ensureDocsRow,
  approveConsequence, rejectConsequence,
  type DeskRow, type ProposalState, type ProposalRow, type ProposalAction,
} from "./store.js";
import { runAttendeeSync, type AttendeeSyncResult } from "./run.js";
import { runWikiSync, buildResolver, type WikiSyncResult, sha256 } from "./wiki-sync.js";
import { runFidelity, splitSource, type RunFidelityResult } from "./fidelity.js";
import {
  runPullSync, diffPreview, splitFrontmatter, buildPageResolver, docRenderHash, pageKey,
  overwritePageFromVault,
  type PullSyncResult, type RenderedDoc,
} from "./pull-sync.js";
import { runApplySync, type ApplySyncResult } from "./apply-sync.js";
import { runArchiveExcluded, type ArchiveExcludedResult } from "./archive-excluded.js";
import { runTranscriptSync, type TranscriptSyncResult } from "./transcript-sync.js";
import { runNotionBornSync, type NotionBornSyncResult } from "./notion-born-sync.js";
import { runPeopleSync, type PeopleSyncResult } from "./people-sync.js";
import { makeTwentyPeopleSource } from "./adapters/twenty-people.js";
import { runAdoptionReport, type AdoptionReportResult } from "./adoption-report.js";
import { parseNotionPage, assertPullSafe, normalizeForFidelity } from "./translate-pull.js";
import { renderWikiPage, assertPushSafe, type ResolvedWikiLink } from "./translate.js";
// Straight from @lares/vault-format — the dependency-free package, not the role kit this
// service must never import (the sync-jobs image does not contain it).
import { originAfterWrite, readOriginFrontmatter } from "@lares/vault-format/origin";
import { wasPathForgotten, isMissingLedgerTable } from "@lares/vault-format/forget-ledger";
import { ownerOfPath } from "./path-owner.js";

/** Reads a secret from `<NAME>_FILE` if set, else `<NAME>`. Mirrors the box convention. */
function readSecret(name: string): string {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  const value = process.env[name];
  if (!value) throw new Error(`${name} (or ${name}_FILE) is required`);
  return value;
}

/** Same lookup, but absent is a legitimate answer. Exported so ORB-178's `_FILE` precedence
 *  (SIGNAL_SPINE_TOKEN included — see notifyFromEnv below) is directly unit-testable without
 *  the DB/testcontainers machinery the rest of this file's exports pull in. */
export function readSecretOptional(name: string): string | undefined {
  try {
    return readSecret(name);
  } catch {
    return undefined;
  }
}

/** The message of whatever was thrown — same helper every engine here carries. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fails loudly on a missing required env var, same posture as readSecret. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * The 64-hex AES key that decrypts the calendar OAuth refresh tokens.
 *
 * Read through readSecret rather than agent-box's `keyFromEnv()` so the box can mount
 * it as a Docker secret (`TOKEN_ENC_KEY_FILE=/run/secrets/token-enc-key`) like every
 * other secret this service takes. This key decrypts ALL oauth_tokens rows, so it has
 * no business being copied into a second plaintext env file just for this job.
 */
function tokenEncKey(): string {
  const key = readSecret("TOKEN_ENC_KEY");
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("TOKEN_ENC_KEY must be 64 hex chars (32 bytes)");
  }
  return key;
}

function orgsFromEnv(): CalendarOrgConfig[] {
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? "";
  const orgs: CalendarOrgConfig[] = [];
  for (const suffix of ["HEIBERG", "ZERO7"]) {
    const clientId = readSecretOptional(`GOOGLE_CLIENT_ID_${suffix}`);
    const clientSecret = readSecretOptional(`GOOGLE_CLIENT_SECRET_${suffix}`);
    if (clientId && clientSecret) {
      orgs.push({ orgId: suffix.toLowerCase(), clientId, clientSecret, redirectUri });
    }
  }
  if (orgs.length === 0) throw new Error("no GOOGLE_CLIENT_ID_* / GOOGLE_CLIENT_SECRET_* pair is set");
  return orgs;
}

// ---------------------------------------------------------------------------
// Phase 3 shared vocabulary and the ONE render (spec §18.1, plan T7)
// ---------------------------------------------------------------------------

/** The `Sync` select values (spec §18.1). Written by the sync, never by hand. */
export const SYNC_DESK = "✍️ Desk";
export const SYNC_MIRROR = "🔒 Mirror";
/**
 * The third stamp (Phase 4): Notion authored this document and the vault is its
 * projection. It needs its own value because the stamp's whole contract is that
 * "the property in Notion can never disagree with the behaviour the store will
 * actually apply" — and a `notion_to_md` row behaves like NEITHER of the other two.
 * Stamping it 🔒 Mirror would tell Bendik his edits here get reverted (they do not
 * — they arrive as a 👍 proposal) and, worse, `reconcile` would LOCK the page,
 * because it locks everything it does not consider a desk. Locking the one kind of
 * page whose entire purpose is that he writes it in Notion is the exact inversion
 * this constant exists to prevent.
 */
export const SYNC_SOURCE = "📥 Notion source";
/** The page icon every mirror row carries — the glance-level signal (§18.1). */
const MIRROR_ICON = "🔒";

/** How often the long one-shot commands report progress. */
const PROGRESS_EVERY = 50;

/**
 * The signal-spine ping, or a console.log when the box has not wired it yet.
 *
 * `SIGNAL_SPINE_TOKEN_FILE` set but resolving to no token (missing path,
 * unreadable, or a blank file) is not the legitimate "not configured" case —
 * it is a configuration bug that would otherwise silently degrade every human
 * ping to console.log with no signal anyone misconfigured it. console.error
 * once and keep degrading regardless: a sync tick must never fail on the
 * spine (see makeSignalNotify's own posture above). Exported so ORB-178's
 * final-review fix is directly unit-testable, same reasoning as
 * readSecretOptional above.
 */
export function notifyFromEnv(): Notify {
  const token = readSecretOptional("SIGNAL_SPINE_TOKEN");
  const file = process.env.SIGNAL_SPINE_TOKEN_FILE;
  if (file && !token) {
    console.error(
      `notion-sync: SIGNAL_SPINE_TOKEN_FILE is set (${file}) but yields no token — every human ping degrades to console.log until this is fixed`,
    );
  }
  return makeSignalNotify({
    url: process.env.SIGNAL_SPINE_URL,
    token,
  });
}

/**
 * The stamp a row's CURRENT direction earns — the single rule behind every place
 * this service writes `Sync` (push create/patch, mirror revert, reject revert,
 * reconcile, enable-two-way). Direction is the switch (plan decision 4); the
 * stamp only ever reports it, so the property in Notion can never disagree with
 * the behaviour the store will actually apply.
 */
export function syncStampFor(row: Pick<DeskRow, "direction"> | undefined): string {
  if (row === undefined) return SYNC_MIRROR;   // an unadopted file starts as a mirror
  if (row.direction === TWO_WAY) return SYNC_DESK;
  return notionOwns(row.direction) ? SYNC_SOURCE : SYNC_MIRROR;
}

/**
 * One synced directory: the vault folder, the Notion `Project` its rows carry,
 * and whatever config has carved out of it (Phase 4 `deskDirs[].exclude`, absent
 * for the wiki dir). The exclusion rides along because the render must agree with
 * the push pass's render, and the push pass's resolver only knows the files its
 * (pruned) listing gave it — see makeDocRender.
 */
interface SyncDir {
  dir: string;
  project: string;
  exclude?: string[];
}

/** What `buildResolver` hands `renderWikiPage` — a wikilink target → page, or null. */
type WikiLinkResolver = (target: string) => ResolvedWikiLink | null;

/**
 * Every directory this deployment syncs, wiki first. Config, never code — the
 * mapping lives in `wikiDir`/`wikiProject` and `deskDirs`, and the parser has
 * already proved no two of them overlap, so "which dir owns this path" has
 * exactly one answer.
 */
function syncDirs(cfg: NotionSyncConfig): SyncDir[] {
  return [
    ...(cfg.wiki === undefined ? [] : [{ dir: cfg.wiki.wikiDir, project: cfg.wiki.project }]),
    ...(cfg.desks?.deskDirs ?? []),
  ];
}

/**
 * Every synced directory as a vault-path prefix — the fidelity gate's
 * "sync-eligible" set. Exported so the container entrypoint's `--fidelity-record`
 * scopes the gate exactly the way the `fidelity` command does; a file that can be
 * pushed is a file whose round-trip failure has to fail the command.
 */
export function syncDirPrefixes(cfg: NotionSyncConfig): string[] {
  return syncDirs(cfg).map((owner) => `${owner.dir}/`);
}

/**
 * The ONE resolver-aware render of a vault file, shared by every place a hash is
 * compared or a body is sent to Notion outside the push engine itself: the pull
 * pass's `renderDoc`, the apply pass's `renderDoc`, and `resolve --keep notion`.
 *
 * Why it has to be shared, and why it has to resolve wikilinks: the change
 * detection on the desk side is `docRenderHash(render now) === row.md_hash`, and
 * `md_hash` is what the PUSH pass stored from ITS render — which resolves
 * `[[wikilinks]]` into `<mention-page>` tags through wiki-sync.ts's own resolver.
 * A render here that resolved nothing would differ from the stored hash for every
 * file containing a single wikilink, and those files would then read as "changed
 * in both sides" on every tick: frozen, then re-frozen by their own `resolve
 * --keep notion`, forever (T6 re-review). So this builds the resolver from the
 * SAME function (`buildResolver`), over the SAME two inputs — the store snapshot
 * and a resolver-free title pass over the dir's files.
 *
 * Scoped per directory, exactly like the push pass: a desk file's `[[wiki/foo]]`
 * resolves to nothing and renders as an escaped literal on both sides (the
 * accepted Phase 3 limitation, plan decision 2) — the point is that both sides
 * agree.
 *
 * The store snapshot and each dir's title pass are read ONCE and cached for the
 * life of the returned object, which is one pass. That is not just an
 * optimisation: it is the same "resolver is a snapshot as of this tick's start"
 * property the push pass's convergence argument rests on (wiki-sync.ts).
 */
export function makeDocRender(cfg: NotionSyncConfig, db: Queryable) {
  const dirs = syncDirs(cfg);
  const vault = makeVaultWalk({ vaultPath: cfg.vaultPath });
  let rowsOnce: Promise<Map<string, DeskRow>> | undefined;
  const resolverByDir = new Map<string, Promise<WikiLinkResolver>>();

  const rows = (): Promise<Map<string, DeskRow>> => (rowsOnce ??= getDeskRows(db));

  function dirOf(vaultPath: string): SyncDir {
    const owner = dirs.find((d) => vaultPath.startsWith(`${d.dir}/`));
    if (owner === undefined) {
      throw new Error(
        `notion-sync: ${vaultPath} is not under any configured sync directory ` +
        `(${dirs.map((d) => d.dir).join(", ") || "none configured"})`,
      );
    }
    return owner;
  }

  async function buildDirResolver(owner: SyncDir): Promise<WikiLinkResolver> {
    // The SAME file set the push pass sees, exclusions and all (Phase 4). Not a
    // detail: `md_hash` is compared across this render and the push pass's, so the
    // two resolvers must be built over the same universe. Leave a carved-out
    // sub-tree in here and a `[[link]]` to one of its files resolves to a mention
    // in this render while the push renders it as an escaped literal — the two
    // hashes then differ for every file carrying such a link, permanently, which
    // is the "changed in both sides" freeze loop this function's own comment
    // above exists to prevent.
    const files = makeVaultFiles({
      vaultPath: cfg.vaultPath,
      wikiDir: owner.dir,
      ...(owner.exclude === undefined ? {} : { exclude: owner.exclude }),
    });
    // Titles come from a resolver-free render, for the same reason the push pass
    // takes them that way: a page's title never depends on link resolution, which
    // is what breaks the circularity of "rendering a needs b's title".
    const titles = new Map<string, string>();
    for (const relPath of [...await files.listWikiFiles()].sort()) {
      try {
        const source = await files.readWikiFile(relPath);
        titles.set(relPath, renderWikiPage(source, { path: relPath, resolve: () => null }).title);
      } catch {
        // Same containment as the push pass: an unreadable file is simply not a
        // link target this pass can offer, and the caller's own render of THAT
        // file will fail loudly on its own terms.
      }
    }
    return buildResolver(owner.dir, await rows(), titles);
  }

  function resolverFor(owner: SyncDir): Promise<WikiLinkResolver> {
    let cached = resolverByDir.get(owner.dir);
    if (cached === undefined) {
      cached = buildDirResolver(owner);
      resolverByDir.set(owner.dir, cached);
    }
    return cached;
  }

  /** The push-shaped render of `vaultPath` as it stands on disk right now. */
  async function renderDoc(vaultPath: string): Promise<RenderedDoc> {
    const owner = dirOf(vaultPath);
    const resolve = await resolverFor(owner);
    const relPath = vaultPath.slice(owner.dir.length + 1);
    const source = await vault.readVaultFile(vaultPath);
    const rendered = renderWikiPage(source, { path: relPath, resolve });
    // The §4.3 lint, on every outbound body — this render feeds real patches.
    assertPushSafe(rendered.markdown);
    return {
      markdown: rendered.markdown,
      props: {
        name: rendered.title,
        project: owner.project,
        folder: rendered.folderHint === undefined
          ? owner.dir
          : `${owner.dir}/${rendered.folderHint}`,
        vaultPath,
        frontmatter: rendered.frontmatter,
        archived: false,
        // A full property refresh must never drop the stamp (spec §18.6), and
        // the row's own direction is the only thing allowed to decide it.
        sync: syncStampFor((await rows()).get(vaultPath)),
      },
    };
  }

  return { renderDoc, rows };
}

export interface AttendeeRunOptions {
  dryRun: boolean;
  toleranceMinutes: number;
}

/**
 * The ORB-155 dials, as one object, so the daemon and the commander CLI cannot
 * drift apart on them. Every value is a documented constant in attendees.ts; they
 * are wired here rather than defaulted inside the engine because the engine takes
 * its whole configuration as arguments, and a silent default is a value nobody
 * can see in a log line.
 */
const MATCH_DIALS = {
  createdToleranceMinutes: DEFAULT_CREATED_TOLERANCE_MINUTES,
  starvationStreak: DEFAULT_STARVATION_STREAK,
  starvationWindowDays: DEFAULT_STARVATION_WINDOW_DAYS,
} as const;

/**
 * One attendee pass: loads config, opens a pool, wires the real adapters, runs, closes.
 *
 * Exported so the container entrypoint (`bin/notion-sync.ts`) can drive it on a schedule
 * without going through commander. Everything it touches is per-call, so a long-lived
 * scheduler gets a fresh pool and a fresh calendar resolution each tick.
 */
export async function syncAttendeesOnce(opts: AttendeeRunOptions): Promise<AttendeeSyncResult> {
  const cfg = loadNotionSyncConfig();
  const pool = poolFromEnv();
  try {
    const notion = makeNotionClient({
      token: readSecret("NOTION_TOKEN"),
      version: cfg.notionVersion,
    });
    const calendar = makeCalendarSource({
      db: pool,
      keyHex: tokenEncKey(),
      orgs: orgsFromEnv(),
      principal: requireEnv("NOTION_SYNC_PRINCIPAL"),
    });
    // The owner is every mailbox the principal has enrolled, not one address:
    // a meeting in the second org would otherwise not recognise them as self and
    // sort them mid-list, breaking the "owner last" format the job must match.
    // The config's selfEmail covers aliases the resolver cannot see.
    const selfEmails = [...new Set(
      [...cfg.selfEmails, ...await calendar.ownerEmails()]
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email !== ""),
    )];
    // recordMeetingSynced persists notion_last_edited for Phase 3's conflict
    // detection; queryMeetings already carries it per row, so stash it here
    // (listMeetings always runs before any recordSynced call) rather than
    // widening AttendeeSyncDeps just to pass one extra field through.
    let editedById = new Map<string, string>();
    const result = await runAttendeeSync(
      {
        selfEmails,
        toleranceMinutes: opts.toleranceMinutes,
        windowDays: cfg.calendarWindowDays,
        now: new Date(),
        dryRun: opts.dryRun,
        ...MATCH_DIALS,
      },
      {
        listMeetings: async () => {
          const rows = await notion.queryMeetings(cfg.meetingsDataSourceId);
          editedById = new Map(rows.map((r) => [r.pageId, r.lastEditedTime]));
          return rows;
        },
        listEvents: calendar.listEvents,
        updateMeetingMatch: (pageId, value) => notion.updateMeetingMatch(pageId, value),
        updateMeetingStatus: (pageId, value) => notion.updateMeetingStatus(pageId, value), // ORB-27
        recordSynced: (pageId) =>
          // `||`, not `??`: toMeetingRow yields "" when Notion omits
          // last_edited_time, and Postgres rejects "" as a TIMESTAMPTZ.
          recordMeetingSynced(pool, pageId, editedById.get(pageId) || null),
        recordUnmatched: (pageId, reason) => recordMeetingUnmatched(pool, pageId, reason),
        recordError: (pageId, message) => recordMeetingError(pool, pageId, message),
        // The systemic-starvation ping (ORB-155, decision 3). Same spine path every
        // other pass here uses; unconfigured, it is a console line, never a crash.
        notify: notifyFromEnv(),
      },
    );
    if (!opts.dryRun) await setLastRunAt(pool, new Date());
    return result;
  } finally {
    await pool.end();
  }
}

export interface WikiRunOptions {
  dryRun: boolean;
  /** Process only the first N sorted files (scratch tests). */
  limit?: number;
}

/**
 * One wiki pass: loads config, opens a pool, wires the real adapters, runs,
 * closes — the exact syncAttendeesOnce shape, exported for the same reason (the
 * container entrypoint drives it on a schedule without going through commander).
 *
 * Returns null when the config has no wiki section: the absence of
 * `docsDataSourceId` is how a Phase 1 deployment says "no wiki pass", so it must
 * stay a clean, logged skip — before any pool or Notion client is built — rather
 * than an error, or the shared tick would fail on every box that has not wired
 * up the Docs database yet.
 */
export async function syncWikiOnce(opts: WikiRunOptions): Promise<WikiSyncResult | null> {
  const cfg = loadNotionSyncConfig();
  const wiki = cfg.wiki;
  if (wiki === undefined) {
    console.log("notion-sync: wiki sync: not configured, skipping");
    return null;
  }
  const pool = poolFromEnv();
  try {
    const notion = makeNotionClient({
      token: readSecret("NOTION_TOKEN"),
      version: cfg.notionVersion,
    });
    const vault = makeVaultFiles({ vaultPath: cfg.vaultPath, wikiDir: wiki.wikiDir });
    // Read once, before the pass: the engine's syncProp must answer synchronously,
    // and the answer is store state (direction) the push engine deliberately does
    // not read for itself. Every wiki row is a mirror row today — the stamp still
    // comes from the row rather than from a constant, so there is exactly one rule
    // in this service for what `Sync` says.
    // ACROSS TARGETS (Phase 4, review round 1): the stamp only ever needs docs rows,
    // but the hold-back set below must see the paths a MEETINGS row owns, and taking
    // both from one read is what stops the two from being derived from different
    // snapshots. The wiki dir cannot overlap a transcripts dir (config refuses it),
    // so the set is empty for this pass today — it is here so that "no push may
    // write a path another target owns" is a property of every push caller rather
    // than of the one that happens to need it.
    const linkedRows = await getLinkedRows(pool);
    const heldBack = pushHoldBack(linkedRows);
    // WikiDocProps (engine) and DocPageProps (adapter) are deliberate structural
    // twins — see wiki-sync.ts — so the create/update lambdas below are where
    // TypeScript checks the two shapes against each other.
    return await runWikiSync(
      {
        wikiDir: wiki.wikiDir,
        project: wiki.project,
        dryRun: opts.dryRun,
        syncProp: (vaultPath) => syncStampFor(linkedRows.get(vaultPath)),
        readOnlyVaultPaths: heldBack,
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
      },
      {
        listWikiFiles: vault.listWikiFiles,
        readWikiFile: vault.readWikiFile,
        getDocRows: () => getDocRows(pool),
        queryDocs: () => notion.queryDocs(wiki.docsDataSourceId),
        createDocPage: (props, markdown) => notion.createDocPage(wiki.docsDataSourceId, props, markdown),
        patchPageMarkdown: notion.patchPageMarkdown,
        updateDocProps: notion.updateDocProps,
        getPageMarkdown: notion.getPageMarkdown,
        upsertDocSynced: (doc) => upsertDocSynced(pool, doc),
        recordDocError: (vaultPath, message) => recordDocError(pool, vaultPath, message),
        markDocOrphaned: (vaultPath, reason) => markDocOrphaned(pool, vaultPath, reason),
      },
    );
  } finally {
    await pool.end();
  }
}

export interface DeskPushResult {
  perDir: Array<{ dir: string; summary: string }>;
  /** Dirs whose pass threw outright — a config/mount problem, not a per-doc one. */
  dirsFailed: number;
  bookkeepingFailed: number;
  summary: string;
}

/**
 * The desk push: the SAME Phase 2 engine, once per configured desk folder with
 * that folder's dir and Project (plan decision 2 — no second push engine). Rows
 * carry the stamp their CURRENT direction earns; `deskDirs`/`twoWayDirs` say
 * which folders exist and which are eligible for the pilot, never which rows are
 * two-way — that is per row, and only `enable-two-way` sets it.
 *
 * One pool and ONE store snapshot across all dirs (the stamp must not change
 * mid-pass), but each dir's engine run is contained: a missing mount or a bad
 * listing in one folder must not starve the next, exactly as the tick's passes
 * are contained from each other.
 */
export async function syncDeskPushOnce(opts: WikiRunOptions): Promise<DeskPushResult | null> {
  const cfg = loadNotionSyncConfig();
  const wiki = cfg.wiki;
  const desks = cfg.desks;
  if (wiki === undefined || desks === undefined) {
    console.log("notion-sync: desk push: not configured, skipping");
    return null;
  }
  const pool = poolFromEnv();
  try {
    const notion = makeNotionClient({
      token: readSecret("NOTION_TOKEN"),
      version: cfg.notionVersion,
    });
    // ACROSS TARGETS — see syncWikiOnce. This is the pass the Critical was found in.
    const linkedRows = await getLinkedRows(pool);
    const syncProp = (vaultPath: string): string => syncStampFor(linkedRows.get(vaultPath));
    // Read ONCE for the whole desk pass, like the store snapshot above and for the
    // same reason: every dir must reason about the same set of open decisions, and
    // a proposal appearing mid-pass must not change what an earlier dir did. Any
    // path with a pending or approved proposal is held back from the push — see
    // WikiSyncOptions.skipVaultPaths. The wiki mirror pass passes nothing: a mirror
    // row is never proposed on.
    const awaitingDecision = new Set(
      (await getOpenProposals(pool)).map((proposal) => proposal.vaultPath),
    );
    // Derived from the SAME snapshot as `syncProp` above, so the stamp a row gets
    // and the decision to hold it back can never be taken from two different reads
    // of the table. Two kinds of row are in it (direction.ts pushHoldBack): the ones
    // Notion owns (`notion_to_md`), and the ones belonging to ANOTHER TARGET — a
    // transcript's Meetings row, which this engine's own `getDocRows` cannot see and
    // would therefore adopt. The push writes nothing for either, in either of its
    // two write paths.
    const notionOwnedHere = pushHoldBack(linkedRows);

    // Defence in depth (fix round 2), the same shape archive-excluded uses for
    // `isExcluded`: this line is the ONLY wire connecting "push never pushes a
    // Notion-owned row" to production, and neutering it to `new Set()` leaves every
    // unit test green while the push pass silently overwrites Notion-owned pages
    // from their own vault projections. Recounted independently from the snapshot
    // and compared, so a set that is empty, stale, or built from a different read
    // fails loudly here rather than quietly there.
    const expectedNotionOwned = [...linkedRows.values()]
      .filter((row) => notionOwns(row.direction) || row.target !== "docs").length;
    if (notionOwnedHere.size !== expectedNotionOwned) {
      throw new Error(
        `notion-sync: desk push: the Notion-owned hold-back set covers ${notionOwnedHere.size} ` +
        `row(s) but the store snapshot holds ${expectedNotionOwned} — refusing to push with a ` +
        "hold-back set that does not match the directions it is derived from",
      );
    }

    const perDir: Array<{ dir: string; summary: string }> = [];
    let dirsFailed = 0;
    let bookkeepingFailed = 0;

    // The carve-out (Phase 4, plan decision 5), derived ONCE from config for the
    // whole pass. Both halves below take it and both are needed: `exclude` keeps
    // the excluded files out of the LISTING (this is how the transcripts became
    // Docs pages in the first place — the walk recurses the whole subtree), and
    // `isExcluded` keeps the excluded ROWS out of the archive/adoption sweep,
    // which would otherwise read the pruned listing as "these files are gone".
    const isExcluded = makeDeskExclusion(desks);

    for (const entry of desks.deskDirs) {
      const vault = makeVaultFiles({
        vaultPath: cfg.vaultPath,
        wikiDir: entry.dir,
        ...(entry.exclude === undefined ? {} : { exclude: entry.exclude }),
      });
      try {
        const result = await runWikiSync(
          {
            wikiDir: entry.dir,
            project: entry.project,
            dryRun: opts.dryRun,
            syncProp,
            skipVaultPaths: awaitingDecision,
            readOnlyVaultPaths: notionOwnedHere,
            isExcluded,
            ...(opts.limit === undefined ? {} : { limit: opts.limit }),
          },
          {
            listWikiFiles: vault.listWikiFiles,
            readWikiFile: vault.readWikiFile,
            getDocRows: () => getDocRows(pool),
            queryDocs: () => notion.queryDocs(wiki.docsDataSourceId),
            createDocPage: (props, markdown) => notion.createDocPage(wiki.docsDataSourceId, props, markdown),
            patchPageMarkdown: notion.patchPageMarkdown,
            updateDocProps: notion.updateDocProps,
            getPageMarkdown: notion.getPageMarkdown,
            upsertDocSynced: (doc) => upsertDocSynced(pool, doc),
            recordDocError: (vaultPath, message) => recordDocError(pool, vaultPath, message),
            markDocOrphaned: (vaultPath, reason) => markDocOrphaned(pool, vaultPath, reason),
          },
        );
        perDir.push({ dir: entry.dir, summary: result.summary });
        bookkeepingFailed += result.bookkeepingFailed;
      } catch (err) {
        dirsFailed += 1;
        console.error(`notion-sync: desk push failed for ${entry.dir}`, err);
      }
    }

    return {
      perDir,
      dirsFailed,
      bookkeepingFailed,
      summary:
        `${desks.deskDirs.length} dir(s), ${dirsFailed} failed, ` +
        `${bookkeepingFailed} bookkeeping-failed`,
    };
  } finally {
    await pool.end();
  }
}

export interface PullRunOptions {
  dryRun: boolean;
}

/**
 * One pull pass: what Notion says about the pages this service owns (spec §18.4).
 *
 * Gated on the Docs database, NOT on `deskDirs`: the pull direction covers mirror
 * rows too — the auto-revert that makes a wiki page's accidental Notion edit
 * bounce back (§18.1) is this pass, and those rows exist on a Phase 2 deployment
 * with no desk folders at all. Without `docsDataSourceId` there is no `queryDocs`
 * to run and no rows to reason about, so that is the honest gate.
 */
export async function syncPullOnce(opts: PullRunOptions): Promise<PullSyncResult | null> {
  const cfg = loadNotionSyncConfig();
  const wiki = cfg.wiki;
  if (wiki === undefined) {
    console.log("notion-sync: pull: not configured, skipping");
    return null;
  }
  const pool = poolFromEnv();
  try {
    const notion = makeNotionClient({
      token: readSecret("NOTION_TOKEN"),
      version: cfg.notionVersion,
    });
    const vault = makeVaultWalk({ vaultPath: cfg.vaultPath });
    const writer = makeVaultWriter({ vaultPath: cfg.vaultPath });
    const { renderDoc } = makeDocRender(cfg, pool);
    return await runPullSync({ dryRun: opts.dryRun, isExcluded: makeDeskExclusion(cfg.desks) }, {
      queryDocs: () => notion.queryDocs(wiki.docsDataSourceId),
      // Deliberately the RAW store read: the engine scopes the snapshot itself
      // (its `isExcluded` option), so there is exactly one place the carve-out
      // is applied on this side and no call site can wire a half-scoped pass.
      getDeskRows: () => getDeskRows(pool),
      getFrozenDocs: () => getFrozenDocs(pool),
      getStaleProposals: (hours) => getStaleProposals(pool, hours),
      getOpenProposals: () => getOpenProposals(pool),
      getRejectedUnexecuted: () => getRejectedUnexecuted(pool),
      getPageMarkdown: notion.getPageMarkdown,
      patchPageMarkdown: notion.patchPageMarkdown,
      updateDocProps: notion.updateDocProps,
      createDocPage: (props, markdown) => notion.createDocPage(wiki.docsDataSourceId, props, markdown),
      renderDoc,
      readVaultFile: vault.readVaultFile,
      archiveVaultFile: writer.archiveVaultFile,
      insertProposal: (input) => insertProposal(pool, input),
      setProposalState: (id, state) => setProposalState(pool, id, state),
      upsertDocSynced: (doc) => upsertDocSynced(pool, doc),
      updateNotionWatermark: (vaultPath, notionHash, notionLastEdited) =>
        updateNotionWatermark(pool, vaultPath, notionHash, notionLastEdited),
      freezeDoc: (vaultPath, reason) => freezeDoc(pool, vaultPath, reason),
      markDocOrphaned: (vaultPath, reason) => markDocOrphaned(pool, vaultPath, reason),
      recordDocError: (vaultPath, message) => recordDocError(pool, vaultPath, message),
      notify: notifyFromEnv(),
    });
  } finally {
    await pool.end();
  }
}

/**
 * WHO the `forget_ledger` guard checks a vault path against — per PATH now, not per
 * box (W5I-s9). The old `resolveInstallationOwner` asked "how many rows does `users`
 * hold?" once per tick and answered `null` — guard off, for everyone — the moment a
 * second member existed. `path-owner.ts`'s `ownerOfPath` asks the question per file
 * instead: frontmatter `owner:` first (resolved through the register so an alias
 * still works), then a per-member vault area (ADR-0017 rule 1, arrives with track
 * 5C), then the sole member if there is exactly one, else unknown. See its header for
 * the full ladder and why a shared/org path is never attributed to a sole member.
 *
 * FAILS OPEN, always, exactly like a missing `forget_ledger` table: `ownerOfPath`
 * never throws, and an unresolved owner simply skips the ledger check for that one
 * path. Tallied, not logged per path — `unresolvedThisTick` below turns any number of
 * unresolved paths in one apply pass into ONE summary line, not one per file.
 *
 * THE READER HALF OF ONE RULE (W5I-s7): `forget_ledger.owner` is always the register's
 * canonical id (`users.id`) — never a channel spelling, never an alias.
 * `wasPathForgotten` (`@lares/vault-format/forget-ledger`) also refuses anything handed
 * to it that does not even LOOK like a canonical id (`assertCanonicalOwner`), and
 * chief-of-staff's `checkOwnerKeyAgreement` (W5I-s5b) is what keeps ITS configured key
 * agreeing with the same register `ownerOfPath` reads.
 */

/**
 * One apply pass: the decisions a human made on proposals, carried out (§18.4).
 * Same gate as the pull pass, and for the same reason — a deployment with no Docs
 * database has no doc rows, so no proposals and nothing to apply.
 */
export async function syncApplyOnce(opts: PullRunOptions): Promise<ApplySyncResult | null> {
  const cfg = loadNotionSyncConfig();
  if (cfg.wiki === undefined) {
    console.log("notion-sync: apply: not configured, skipping");
    return null;
  }
  const pool = poolFromEnv();
  try {
    const notion = makeNotionClient({
      token: readSecret("NOTION_TOKEN"),
      version: cfg.notionVersion,
    });
    const vault = makeVaultWalk({ vaultPath: cfg.vaultPath });
    const writer = makeVaultWriter({ vaultPath: cfg.vaultPath });
    const { renderDoc } = makeDocRender(cfg, pool);
    // Tallies every CREATE this tick whose path `ownerOfPath` could not attribute to
    // a member (a shared/org path, several members with no marker, or an unreadable
    // register) — reported as ONE summary line after the pass, not one per file.
    const unresolvedThisTick = new Map<string, number>();
    const result = await runApplySync({ dryRun: opts.dryRun, inCreateScope: makeCreateScope(cfg) }, {
      getOpenProposals: () => getOpenProposals(pool),
      getRejectedUnexecuted: () => getRejectedUnexecuted(pool),
      // ACROSS TARGETS (Phase 4): a transcript's state row is its Meetings row, so a
      // docs-only read would resolve every transcript proposal to "row missing".
      getLinkedRows: () => getLinkedRows(pool),
      renderDoc,
      readVaultFile: vault.readVaultFile,
      writeVaultFile: writer.writeVaultFile,
      vaultFileExists: vault.vaultFileExists,
      createVaultFile: writer.createVaultFile,
      // The target's ancestry, resolved case-insensitively and then listed — a
      // handful of readdirs, never a walk, because guard 3b runs per approved create.
      listCollisionCandidates: vault.listCollisionCandidates,
      patchPageMarkdown: notion.patchPageMarkdown,
      updateDocProps: notion.updateDocProps,
      getPageMarkdown: notion.getPageMarkdown,
      upsertDocSynced: (doc) => upsertDocSynced(pool, doc),
      linkPageToVaultFile: (doc) => linkPageToVaultFile(pool, doc),
      updateNotionWatermark: (vaultPath, notionHash, notionLastEdited) =>
        updateNotionWatermark(pool, vaultPath, notionHash, notionLastEdited),
      recordNotionAccounted: (pageId, notionHash) => recordNotionAccounted(pool, pageId, notionHash),
      setProposalState: (id, state) => setProposalState(pool, id, state),
      markProposalReverted: (id) => markProposalReverted(pool, id),
      freezeDoc: (vaultPath, reason) => freezeDoc(pool, vaultPath, reason),
      recordDocError: (vaultPath, message) => recordDocError(pool, vaultPath, message),
      notify: notifyFromEnv(),
      pathWasForgotten: async (vaultPath) => {
        // No file on disk yet — the normal case for a CREATE. `ownerOfPath`'s
        // frontmatter rule (1) simply does not match an empty string, and falls
        // through to the path-shape and sole-member rules below it.
        let frontmatter = "";
        try {
          frontmatter = await vault.readVaultFile(vaultPath);
        } catch {
          // ENOENT, expected; any other read failure is likewise not this guard's
          // concern — `ownerOfPath` fails open on whatever frontmatter it is given.
        }
        const who = await ownerOfPath(pool, vaultPath, frontmatter);
        if (who.owner === null) {
          unresolvedThisTick.set(who.why, (unresolvedThisTick.get(who.why) ?? 0) + 1);
          return null;
        }
        try {
          const entry = await wasPathForgotten(pool, { owner: who.owner, path: vaultPath });
          return entry === null ? null : entry.forgottenAt;
        } catch (err) {
          if (isMissingLedgerTable(err)) return null;
          throw err;
        }
      },
    });
    if (unresolvedThisTick.size > 0) {
      const total = [...unresolvedThisTick.values()].reduce((a, b) => a + b, 0);
      const breakdown = [...unresolvedThisTick.entries()].map(([why, n]) => `${n} ${why}`).join(", ");
      console.warn(
        `notion-sync: forget ledger: could not attribute an owner for ${total} create(s) this tick ` +
        `(${breakdown}) — the forget check did not run for them`,
      );
    }
    return result;
  } finally {
    await pool.end();
  }
}

/**
 * One transcript pass (T4): the Meetings rows Notion holds, proposed into the vault.
 *
 * Gated on `cfg.transcripts` alone — absent, the pass logs a skip and does nothing,
 * so the image can ship ahead of the box's config file (the deploy-ahead-of-env rule
 * every optional section here follows). `meetingsDataSourceId` is top-level and has
 * been required since Phase 1, so there is no second thing to check.
 */
export async function syncTranscriptsOnce(opts: PullRunOptions): Promise<TranscriptSyncResult | null> {
  const cfg = loadNotionSyncConfig();
  const transcripts = cfg.transcripts;
  if (transcripts === undefined) {
    console.log("notion-sync: transcripts: not configured, skipping");
    return null;
  }
  const pool = poolFromEnv();
  try {
    const notion = makeNotionClient({
      token: readSecret("NOTION_TOKEN"),
      version: cfg.notionVersion,
    });
    const vault = makeVaultWalk({ vaultPath: cfg.vaultPath });
    const { renderDoc } = makeDocRender(cfg, pool);
    return await runTranscriptSync(
      {
        dryRun: opts.dryRun,
        dir: transcripts.dir,
        projects: transcripts.projects,
        // The SAME derivation every other boundary scopes itself by. A transcript
        // may only land where the desk passes have been told not to look.
        isExcluded: makeDeskExclusion(cfg.desks),
      },
      {
        queryMeetings: () => notion.queryMeetings(cfg.meetingsDataSourceId),
        getMeetingRows: () => getMeetingRows(pool),
        // The SAME reader `syncApplyOnce` hands its own engine, so the proposer and
        // apply's guard 0 ask one question of one snapshot shape. A narrower read
        // here is how a create that can never land gets proposed every tick forever
        // (fix wave, item 1).
        getLinkedRows: () => getLinkedRows(pool),
        getOpenProposals: () => getOpenProposals(pool),
        getRejectedUnexecuted: () => getRejectedUnexecuted(pool),
        getPageMarkdown: notion.getPageMarkdown,
        // The SAME render the apply pass will re-run at apply time, which is what
        // makes the base hash this pass stores and the hash apply re-checks
        // comparable at all.
        renderDoc,
        readVaultFile: vault.readVaultFile,
        vaultFileExists: vault.vaultFileExists,
        ensureMeetingRow: (pageId) => ensureMeetingRow(pool, pageId),
        insertProposal: (input) => insertProposal(pool, input),
        setProposalState: (id, state) => setProposalState(pool, id, state),
        recordNotionAccounted: (pageId, notionHash) => recordNotionAccounted(pool, pageId, notionHash),
        notify: notifyFromEnv(),
      },
    );
  } finally {
    await pool.end();
  }
}

/**
 * One Notion-born pass (T6): the Docs pages a human created in Notion that have no
 * vault file yet, proposed into the vault.
 *
 * Gated on `cfg.desks` as well as `cfg.wiki`, and both gates are load-bearing rather
 * than defensive:
 *
 *  - **`wiki`** carries `docsDataSourceId`, so without it there is no Docs query to
 *    make — the same honest gate `syncPullOnce` uses.
 *  - **`desks`** carries `deskDirs`, which is BOTH halves of where a page may land:
 *    the Project→folder mapping, and the only set of folders `makeCreateScope` will
 *    let a create into. With no desk dirs every derived path would be refused, so
 *    the pass has literally nothing it could do — and saying so once beats reporting
 *    every page in the database as out of scope, every tick.
 *
 * Either absent ⇒ log and continue, the deploy-ahead-of-env contract every optional
 * section here follows.
 */
export async function syncNotionBornOnce(opts: PullRunOptions): Promise<NotionBornSyncResult | null> {
  const cfg = loadNotionSyncConfig();
  const wiki = cfg.wiki;
  const desks = cfg.desks;
  if (wiki === undefined || desks === undefined) {
    console.log("notion-sync: notion-born: not configured, skipping");
    return null;
  }
  const pool = poolFromEnv();
  try {
    const notion = makeNotionClient({
      token: readSecret("NOTION_TOKEN"),
      version: cfg.notionVersion,
    });
    const vault = makeVaultWalk({ vaultPath: cfg.vaultPath });
    return await runNotionBornSync(
      {
        dryRun: opts.dryRun,
        // The desk dirs, as the Project→folder mapping. Derived here rather than in
        // the engine because this is the layer that knows config's shape, and the
        // engine takes the same `ProjectMapping[]` the transcript pass does.
        projects: desks.deskDirs.map((entry) => ({
          notionProject: entry.project, vaultFolder: entry.dir,
        })),
        // The SAME predicate the apply pass re-checks immediately before the write.
        inCreateScope: makeCreateScope(cfg),
        // …and the SAME carve-out derivation every other boundary scopes itself by.
        // Here it is a refusal: a Notion-born page may not land in a sub-tree config
        // has handed to another pass.
        isExcluded: makeDeskExclusion(cfg.desks),
        // …and the half a missing `exclude` line makes invisible to it.
        ...(cfg.transcripts === undefined ? {} : { transcriptsDir: cfg.transcripts.dir }),
      },
      {
        queryDocs: () => notion.queryDocs(wiki.docsDataSourceId),
        getPageRows: () => getPageRows(pool),
        getDeskRows: () => getDeskRows(pool),
        getOpenProposals: () => getOpenProposals(pool),
        getRejectedUnexecuted: () => getRejectedUnexecuted(pool),
        getPageMarkdown: notion.getPageMarkdown,
        vaultFileExists: vault.vaultFileExists,
        // The WHOLE vault root, not the target's parent: the walker already exists,
        // is already the fidelity gate's file universe, and a per-parent listing
        // would be one readdir per candidate rather than one walk per tick.
        listVaultFiles: vault.listAllFiles,
        ensureDocsRow: (pageId) => ensureDocsRow(pool, pageId),
        insertProposal: (input) => insertProposal(pool, input),
        setProposalState: (id, state) => setProposalState(pool, id, state),
      },
    );
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// T7 (Phase 4, ORB-39) — the People projection and the Meetings→People relation.
// ---------------------------------------------------------------------------

/**
 * One People pass (T7): the people a Meetings row's `Attendees` names, projected
 * from the source of truth into the Notion People database, and the relation
 * between the two.
 *
 * Gated on `cfg.people` alone — absent, the pass logs a skip and does nothing, so
 * the image can ship ahead of the box's config file and ahead of the People
 * database itself (the deploy-ahead-of-env rule every optional section here
 * follows). `meetingsDataSourceId` is top-level and has been required since Phase
 * 1, so there is no second thing to check.
 *
 * Like `runAdoptionReportOnce` and unlike every other sync pass, it never calls
 * `poolFromEnv()`. It has no state of its own: the People rows in Notion ARE the
 * state, and `Source ID`/`Email` are the two identities the next tick re-reads. A
 * local table mirroring what Notion already holds would just be a second place for
 * the same fact to be wrong — and a pass that opens no database connection cannot
 * leave a row behind in one.
 *
 * The source credentials are required rather than optional ONCE `people` is
 * configured, and they fail loudly (readSecret throws) for the same reason
 * `NOTION_TOKEN` does: deploy-ahead-of-env is about the config SECTION, and a
 * configured pass that cannot reach its source has nothing honest to do.
 */
export async function syncPeopleOnce(opts: { dryRun: boolean }): Promise<PeopleSyncResult | null> {
  const cfg = loadNotionSyncConfig();
  const people = cfg.people;
  if (people === undefined) {
    console.log("notion-sync: people: not configured, skipping");
    return null;
  }
  const notion = makeNotionClient({ token: readSecret("NOTION_TOKEN"), version: cfg.notionVersion });
  const source = makeTwentyPeopleSource({
    baseUrl: requireEnv("TWENTY_BASE_URL"),
    apiKey: readSecret("TWENTY_KEY"),
  });

  return await runPeopleSync(
    {
      dryRun: opts.dryRun,
      // Config's `selfEmail` only. Unlike the attendee pass this does not union in
      // the calendar resolver's mailboxes: doing so would drag the whole OAuth
      // stack (a pool, TOKEN_ENC_KEY, both Google client pairs) into a pass that
      // otherwise needs none of it, to refine a list whose job here is merely to
      // keep the owner out of his own meetings' attendee set. An alias config does
      // not name simply shows up as one unresolved address, reported and fixable
      // with one line of config.
      selfEmails: cfg.selfEmails,
    },
    {
      listSourcePeople: source.listPeople,
      queryPeople: () => notion.queryPeople(people.dataSourceId),
      queryMeetings: () => notion.queryMeetings(cfg.meetingsDataSourceId),
      createPerson: (props) => notion.createPersonPage(people.dataSourceId, props),
      updatePerson: notion.updatePersonProps,
      updateMeetingPeople: notion.updateMeetingPeople,
      // The same spine path pull/apply/transcripts use — the two irreversible-from-
      // Notion outcomes have to reach a human, and an hourly container's stdout is
      // not a place a human reads.
      notify: notifyFromEnv(),
    },
  );
}

// ---------------------------------------------------------------------------
// T5 (Phase 4, ORB-39) — the adoption report (plan decision 2): matches the 32
// pre-existing vault transcripts (Phase 3's accidental sweep — carved out of
// scope and retired from Notion by T3, but left on disk untouched) against the
// Meetings rows, and reports Confident / Ambiguous / Unmatched. Bendik rules on
// adoption from this output; this command decides nothing and writes nothing —
// see lib/adoption-report.ts's header for how that is a property of the engine's
// TYPE rather than a promise this wrapper keeps by convention.
// ---------------------------------------------------------------------------

/**
 * One adoption-report pass: loads config, builds a read-only Notion client, walks
 * each configured transcript folder, and runs the pure engine.
 *
 * Unlike every other composition root in this file, this one never calls
 * `poolFromEnv()`. There is nothing for it to READ from the store — the report
 * is a point-in-time comparison, not a sync pass, and has no prior-tick state to
 * consult (AdoptionReportDeps's own doc comment) — so there is nothing it could
 * accidentally WRITE there either. A function that never opens a database
 * connection cannot leave a row behind in one; tests/cli.test.ts's wrapper-level
 * zero-writes test runs this with no database reachable at all and asserts it
 * still succeeds, which is the strongest form this proof can take.
 *
 * Gated on `cfg.transcripts` alone, the same contract `syncTranscriptsOnce`
 * uses: its absence is how a deployment says "no transcript folders configured
 * yet", and this report has no folders to walk without it.
 */
/**
 * The adoption report, printed for a human.
 *
 * Extracted from the commander action and exported for the reason item 2 of the
 * final fix wave exists: the box runs THIS package, not the `lares` CLI, so every
 * operator command has to be reachable from `bin/notion-sync.ts` too — and a
 * fifty-line printer copied into the entrypoint is a second report that drifts from
 * this one the first time a section is added. One printer, two surfaces.
 *
 * Writes to stdout and nothing else: no file, no database, no Notion. That is the
 * whole of T5's "report only" contract at this layer (the engine's half is
 * structural — see lib/adoption-report.ts).
 */
export function printAdoptionReport(result: AdoptionReportResult): void {
  console.log(
    `notion-sync: adoption-report — ${result.totalMeetings} Meetings rows, ` +
    `${result.totalVaultFiles} vault files`,
  );

  console.log(`\nCONFIDENT — safe to skim and rule on (${result.confident.length})`);
  for (const row of result.confident) {
    console.log(`  ${row.vaultPath}`);
    console.log(
      `    <- "${row.title}" (${row.pageId})  ${row.date ?? "no date"}  ${row.project ?? "no project"}`,
    );
    console.log(`    [${row.basis}] ${row.reason}`);
  }

  // A SEPARATE section, deliberately — never folded into CONFIDENT (fix
  // round 1, Critical): a title-only match can be a genuine false positive
  // (an unrelated file whose name merely happens to start with a short,
  // common meeting title), so these are worth opening before ruling on them.
  console.log(`\nTITLE-ONLY — no date to confirm, worth a quick look before ruling (${result.titleOnly.length})`);
  for (const row of result.titleOnly) {
    console.log(`  ${row.vaultPath}`);
    console.log(
      `    <- "${row.title}" (${row.pageId})  ${row.date ?? "no date"}  ${row.project ?? "no project"}`,
    );
    console.log(`    [${row.basis}] ${row.reason}`);
  }

  console.log(`\nAMBIGUOUS (${result.ambiguous.length} group(s))`);
  for (const group of result.ambiguous) {
    console.log("  ---");
    for (const m of group.meetings) {
      console.log(`  meeting: "${m.title}" (${m.pageId})  ${m.date ?? "no date"}  ${m.project ?? "no project"}`);
    }
    for (const path of group.vaultPaths) console.log(`  file:    ${path}`);
    for (const c of group.candidates) {
      console.log(`    candidate: ${c.vaultPath}  <-  "${c.title}" (${c.pageId})  [${c.basis}] ${c.reason}`);
    }
  }

  console.log(`\nUNMATCHED MEETINGS — no vault file (${result.unmatchedMeetings.length})`);
  for (const m of result.unmatchedMeetings) {
    console.log(`  "${m.title}" (${m.pageId})  ${m.date ?? "no date"}  ${m.project ?? "no project"}`);
  }

  console.log(`\nUNMATCHED FILES — no Meetings row (${result.unmatchedFiles.length})`);
  for (const f of result.unmatchedFiles) {
    console.log(`  ${f.vaultPath}  (read as: ${f.parsedDate ?? "no date"}, "${f.parsedTitleSlug}")`);
    // A filename-shaped id that matched nothing is worth a different note
    // than "no id at all" (fix round 1, Minor) — usually the Notion page
    // this file once pointed at was deleted, or moved out of Meetings.
    if (f.parsedPageIdHex !== null) {
      console.log(`    the filename embeds a Notion-id-shaped token (${f.parsedPageIdHex}) that matches no current Meetings row — deleted in Notion?`);
    }
  }

  console.log(`\n${result.summary}`);
}

export async function runAdoptionReportOnce(): Promise<AdoptionReportResult | null> {
  const cfg = loadNotionSyncConfig();
  const transcripts = cfg.transcripts;
  if (transcripts === undefined) {
    console.log("notion-sync: adoption-report: transcripts not configured, skipping");
    return null;
  }
  const notion = makeNotionClient({ token: readSecret("NOTION_TOKEN"), version: cfg.notionVersion });

  return await runAdoptionReport({
    queryMeetings: () => notion.queryMeetings(cfg.meetingsDataSourceId),
    // One `listWikiFiles` walk per configured project folder, vault-root-
    // relative paths reconstructed by prefixing (`listWikiFiles` itself returns
    // paths relative to the wikiDir it was given) — this is what turns the
    // nested `analysis/analysis.md` case into `zero7/transcripts/analysis/
    // analysis.md` for free, since the walker already recurses subdirectories.
    listVaultFiles: async () => {
      // De-duplicated by the RESOLVED directory (fix round 1, Minor), not by
      // project entry: `transcripts.projects` maps Notion `Project` -> vault
      // folder, and config.ts only rejects a duplicate `notionProject`, never a
      // duplicate `vaultFolder` — two Notion projects can legitimately share one
      // vault folder. Walking per PROJECT would then list the same folder twice
      // and double every file in it: `totalVaultFiles` counted high, and each
      // real file would appear as two separate (identical) `unmatchedFiles` rows
      // if it matched nothing. The accounting guard would stay self-consistent
      // throughout and never catch this — it checks the arithmetic, not whether
      // the INPUT was sound — so this has to be fixed at the source, not detected
      // downstream.
      const dirs = [...new Set(transcripts.projects.map((p) => `${p.vaultFolder}/${transcripts.dir}`))];
      const all: string[] = [];
      for (const dir of dirs) {
        let files: string[];
        try {
          files = await makeVaultFiles({ vaultPath: cfg.vaultPath, wikiDir: dir }).listWikiFiles();
        } catch (err) {
          // A configured project whose transcript folder does not exist (yet, or
          // any more — this report is meant to be re-run after Bendik acts on an
          // earlier one) contributes zero files rather than aborting the WHOLE
          // report over one project's missing directory. Per-project containment,
          // same posture as syncDeskPushOnce's own per-dir try/catch.
          console.error(
            `notion-sync: adoption-report: could not list ${dir}: ${errorText(err)} — treating as 0 files for this folder`,
          );
          continue;
        }
        all.push(...files.map((f) => `${dir}/${f}`));
      }
      return all;
    },
  });
}

// ---------------------------------------------------------------------------
// T3 (Phase 4, ORB-39) — retiring the Docs rows config's `deskDirs[].exclude`
// has carved out of the desk scope: `notion-sync archive-excluded`. T2 stopped
// the sync engine from creating or iterating these paths; this command removes
// the rows that already existed before that carve-out shipped.
// ---------------------------------------------------------------------------

export interface ArchiveExcludedRunOptions {
  dryRun: boolean;
}

/**
 * One archive-excluded pass: loads config, opens a pool, wires the real
 * adapters, runs the pure engine, closes — same shape as syncApplyOnce/
 * syncPullOnce. Unlike those, there is no "not configured, skipping" branch:
 * `isExcluded` (desk-scope.ts) already answers "nothing" for a config with no
 * `desks` section at all, so an unconfigured deployment simply finds zero rows
 * in scope and reports that, rather than needing a second way to say the same
 * thing.
 */
export async function syncArchiveExcludedOnce(opts: ArchiveExcludedRunOptions): Promise<ArchiveExcludedResult> {
  const cfg = loadNotionSyncConfig();
  const pool = poolFromEnv();
  try {
    const notion = makeNotionClient({
      token: readSecret("NOTION_TOKEN"),
      version: cfg.notionVersion,
    });
    return await runArchiveExcluded(
      { dryRun: opts.dryRun, isExcluded: makeDeskExclusion(cfg.desks) },
      {
        getDeskRows: () => getDeskRows(pool),
        trashPage: notion.trashPage,
        markDocOrphaned: (vaultPath, reason) => markDocOrphaned(pool, vaultPath, reason),
      },
    );
  } finally {
    await pool.end();
  }
}

export interface FidelityRunOptions {
  vaultPath: string;
  /**
   * Vault-path prefixes (each ending "/") whose failures count toward the exit
   * code. A file outside every prefix still gets checked and reported — it just
   * can't fail the command (Phase 3 plan T2: report-only until a dir is scoped in).
   */
  eligiblePrefixes: string[];
  /** Persist verdicts into notion_sync_fidelity (T3) — needs NOTION_SYNC db env. */
  record: boolean;
}

export interface FidelityFailureAnnotated {
  path: string;
  reason: string;
  /** Whether this failure falls under an eligible prefix (and so fails the exit code). */
  eligible: boolean;
}

export interface FidelityRunResult {
  result: RunFidelityResult;
  failed: FidelityFailureAnnotated[];
  eligibleFailedCount: number;
  summary: string;
}

/**
 * One fidelity pass: walks the whole vault (not scoped to wikiDir — the gate has
 * to see desk folders too, once T7 lands), round-trips every file through
 * lib/fidelity.ts, and optionally records verdicts. No pool is opened unless
 * `record` is set, so a plain report run works on a laptop with no database at
 * all — the reason `--vault` exists (see registerNotionSyncCommands).
 */
export async function runFidelityOnce(opts: FidelityRunOptions): Promise<FidelityRunResult> {
  const vault = makeVaultWalk({ vaultPath: opts.vaultPath });
  const files = await vault.listAllFiles();
  const result = await runFidelity(files, vault.readVaultFile);

  const isEligible = (path: string): boolean =>
    opts.eligiblePrefixes.some((prefix) => path.startsWith(prefix));
  const failed = result.failed.map((f) => ({ ...f, eligible: isEligible(f.path) }));
  const eligibleFailedCount = failed.filter((f) => f.eligible).length;

  const summary =
    `fidelity: ${result.passed} passed, ${result.failed.length} failed ` +
    `(${eligibleFailedCount} sync-eligible failures), ${result.report.scanned} scanned`;

  if (opts.record) {
    const pool = poolFromEnv();
    try {
      await replaceFidelity(pool, result.report.results.map((r) => ({
        vaultPath: r.path,
        passed: r.passed,
        ...(r.reason === undefined ? {} : { reason: r.reason }),
      })));
    } finally {
      await pool.end();
    }
  }

  return { result, failed, eligibleFailedCount, summary };
}

// ---------------------------------------------------------------------------
// T6 — the proposals surface (spec §18.4/§18.6): `notion-sync proposals`,
// `approve <path>`, `reject <path>`, `resolve <path> --keep md|notion`. Every
// function here opens/closes its own pool, same shape as syncWikiOnce/
// runFidelityOnce, so the container entrypoint or a future console route can
// call them without going through commander.
// ---------------------------------------------------------------------------

export interface ProposalListRow {
  id: number;
  vaultPath: string;
  state: ProposalState;
  createdAt: Date;
  /** The diff preview captured at PROPOSE time (pull-sync.ts's diffPreview, or
   *  cli.ts resolveFrozenDoc's own for a forced proposal) and persisted on the
   *  row (`diff_preview`, T6 review F2) — not a live re-diff against the vault
   *  file as it stands now. Deliberately the SAME value the console shows
   *  (console has no vault mount to derive one of its own): one stored
   *  preview per proposal, not two computations that could disagree. */
  diff: string;
}

/** Every open proposal (pending + approved), with its stored diff preview. */
export async function listOpenProposals(): Promise<ProposalListRow[]> {
  const pool = poolFromEnv();
  try {
    const proposals = await getOpenProposals(pool);
    return proposals.map((p) => ({
      id: p.id,
      vaultPath: p.vaultPath,
      state: p.state,
      createdAt: p.createdAt,
      diff: p.diffPreview,
    }));
  } finally {
    await pool.end();
  }
}

/**
 * Flips the OPEN proposal for `vaultPath` to `approved`|`rejected` and nothing
 * else — the engine (runApplySync, wired in T7) does the actual write on its
 * next tick. `reject` in particular must not touch the vault or Notion here:
 * `resolveProposal` deliberately leaves resolved_at NULL on a rejection, because
 * the row still owes the world a decision the engine has not carried out yet, and
 * stamping it from the CLI would make an unexecuted rejection indistinguishable
 * from one the engine has finished (see store.ts setProposalState).
 */
async function setOpenProposalState(
  vaultPath: string, action: ProposalAction,
): Promise<ProposalRow> {
  const pool = poolFromEnv();
  try {
    const open = await getOpenProposals(pool);
    const proposal = open.find((p) => p.vaultPath === vaultPath);
    if (proposal === undefined) {
      throw new Error(`notion-sync: no open proposal for ${vaultPath} — nothing to ${action}`);
    }
    // `resolveProposal`, not a bare setProposalState — the ONE guarded transition
    // every other surface uses (spec §20.1). This lookup is by path and the flip is
    // by id, so the two are a read-then-write against an engine tick that may be
    // resolving the same row right now; the guard's state predicate is what closes
    // that. It also RETURNS the row, which is how the caller says what it just did
    // without a second read (fix round 4).
    return await resolveProposal(pool, proposal.id, action);
  } finally {
    await pool.end();
  }
}

/** The decided row, so the caller can state the consequence — see setOpenProposalState. */
export const approveProposal = (vaultPath: string): Promise<ProposalRow> =>
  setOpenProposalState(vaultPath, "approve");

/** Moves the row and NOTHING else — the engine acts on its next tick. */
export const rejectProposal = (vaultPath: string): Promise<ProposalRow> =>
  setOpenProposalState(vaultPath, "reject");

// Re-exported so bin/notion-sync.ts's `--approve`/`--reject` one-shots (LAR-64) can
// state the same consequence the commander commands below print, without reaching
// past this file into store.ts for it.
export { approveConsequence, rejectConsequence };

export type ResolveKeep = "md" | "notion";

/**
 * `notion-sync resolve <path> --keep md|notion` (spec §6, frozen rows).
 *
 * --keep md: the vault wins, so this command WRITES the vault's version to
 * Notion — the same three writes as a mirror revert (patch body, refresh
 * properties, read back and hash what Notion stored), through the shared
 * `overwritePageFromVault`.
 *
 * It used to unfreeze and leave the write to the next push, which could not
 * work and never did (C1, final review): a tick is pull → apply → push, and
 * pull runs against a row whose stored md_hash AND notion_hash are both stale
 * by definition on a conflict freeze. So pull re-detected the same two-sided
 * conflict and re-froze the row, and the push pass skips frozen rows (spec §6)
 * — the heal never got a turn, on any tick, ever. Writing here closes the loop
 * in one command: both stored hashes become true again, so the next pull's
 * `unchanged` branch simply moves the watermark and the next push skips.
 *
 * Any open proposal for the path is superseded, because choosing the vault
 * decides it: leaving it open would let a later approve re-freeze the row it
 * just resolved (apply's baseMdHash re-check would refuse a proposal based on
 * a render the vault has moved past).
 *
 * --keep notion: read Notion's current content and force it through the
 * ordinary proposal gate, superseding any open proposal already on this path
 * (the partial unique index notion_sync_proposals_open allows only one
 * pending/approved row per vault_path — store.ts insertProposal). This
 * command still never writes the vault itself: the human approves the forced
 * proposal like any other (spec §18.4), and the engine applies it. It DOES
 * stamp the row's own two hashes with what it just observed before unfreezing,
 * so that the wait between this command and the approve is quiet on both sides
 * — there is almost always a tick in that wait, and without the stamp the row's
 * pre-conflict md_hash re-tripped the conflict check and orphaned the proposal
 * that was just forced. See the stamp's own comment for each following case.
 *
 * baseMdHash on the forced proposal is a FRESH render of the vault file taken
 * right now (`makeDocRender`'s renderDoc + `docRenderHash`) — NOT the row's
 * stored md_hash. This is not the cosmetic choice it might look like: this command
 * only runs on a FROZEN row, and a conflict freeze exists precisely because
 * `docRenderHash(current render) !== row.mdHash` (pull-sync.ts proposeDesk's
 * CONFLICT_REASON check) — that is the definition of "frozen for this
 * reason". Seeding baseMdHash from the stale stored value would therefore
 * guarantee a mismatch against apply-sync.ts's own stale-check on the very
 * first approval, every time: the forced proposal would supersede and
 * re-freeze itself instead of ever applying, and a second `resolve` would
 * reproduce the exact same loop forever (T6 review finding F1). Taking the
 * hash fresh, right now, means the stale-check at approve-time only trips on
 * GENUINE drift — a further vault edit between this `resolve` and the human's
 * `approve` — which is exactly what it exists to catch.
 */
export async function resolveFrozenDoc(vaultPath: string, keep: ResolveKeep): Promise<string> {
  const pool = poolFromEnv();
  try {
    const rows = await getDeskRows(pool);
    const row = rows.get(vaultPath);
    if (row === undefined) {
      throw new Error(`notion-sync: no doc row for ${vaultPath}`);
    }
    if (row.state !== "frozen") {
      throw new Error(`notion-sync: ${vaultPath} is not frozen (state: ${row.state}) — nothing to resolve`);
    }

    // Both branches write Notion now (C1), so the config and the client are
    // loaded once, before the split.
    const cfg = loadNotionSyncConfig();
    const notion = makeNotionClient({ token: readSecret("NOTION_TOKEN"), version: cfg.notionVersion });
    // The ONE resolver-aware render (see makeDocRender): the same composition
    // the push and pull passes hash against, and it applies the §4.3 push lint
    // itself, so nothing here can send a body the push pass would refuse.
    const render = makeDocRender(cfg, pool);

    if (keep === "md") {
      // `--keep md` writes Notion from the vault. For a NOTION-OWNED row that is
      // the projection overwriting its own source — the one write direction.ts says
      // no pass may make — so it is announced loudly before it happens rather than
      // silently done (Phase 4 fix round 2).
      //
      // A warning and not a refusal, deliberately: this command is the human's
      // manual override, run by hand on the box against a frozen row, and an
      // operator who has read the two sides and decided the vault is right must not
      // be locked out of saying so. What they must not do is discover afterwards.
      if (notionOwns(row.direction)) {
        console.warn(
          `notion-sync: WARNING — ${vaultPath} is Notion-owned (direction notion_to_md). ` +
          `--keep md will OVERWRITE the Notion page, which is the source of this document, ` +
          `with the vault's copy of it. --keep notion is the direction-preserving exit.`,
        );
      }
      const rendered = await render.renderDoc(vaultPath);
      const outcome = await overwritePageFromVault(row.pageId, rendered, {
        patchPageMarkdown: notion.patchPageMarkdown,
        updateDocProps: notion.updateDocProps,
        getPageMarkdown: notion.getPageMarkdown,
      });
      if (!outcome.ok) {
        // Nothing local has been touched yet, so the row is exactly as it was:
        // still frozen, still the human's, and this command is re-runnable. A
        // half-done write (body patched, read-back failed) is the same story —
        // the stored hashes stay stale, which is what makes a re-run correct.
        throw new Error(
          `notion-sync: ${vaultPath}: keeping the vault version failed at the ` +
          `${outcome.step} step (${errorText(outcome.error)}) — the row stays frozen; re-run when it is fixed`,
        );
      }

      // An open proposal for this path ruled on the side that just lost.
      const openProposal = (await getOpenProposals(pool)).find((p) => p.vaultPath === vaultPath);
      if (openProposal !== undefined) {
        await setProposalState(pool, openProposal.id, "superseded");
      }

      // Both hashes are now true readings: the render we sent, and what Notion
      // stored. `notionLastEdited: null` is not a gap — updateNotionWatermark
      // ASSIGNS while this COALESCEs, and the only honest timestamp for the write
      // we just made would cost a full Docs query for one row. Keeping the older
      // value makes the next pull re-read once (the `>=` pre-filter), find the
      // hash equal, and stamp an OBSERVED value through the `unchanged` branch —
      // the same one-tick convergence the mirror revert relies on.
      await upsertDocSynced(pool, {
        vaultPath,
        pageId: row.pageId,
        mdHash: docRenderHash(rendered),
        notionHash: outcome.notionHash,
        notionLastEdited: null,
        direction: row.direction,
      });
      await unfreezeDoc(pool, vaultPath);
      return (
        `${vaultPath}: kept the vault version — Notion overwritten from the vault` +
        `${openProposal === undefined ? "" : `, proposal #${openProposal.id} superseded`}; row unfrozen`
      );
    }

    const notionMarkdown = await notion.getPageMarkdown(row.pageId);
    // Same resolver a live pull tick would build from the same snapshot
    // (pull-sync.ts proposeDesk), so a `[[wikilink]]` in Notion's content
    // resolves to a real vault target here too, not an escaped literal.
    //
    // Scoped exactly as the pull pass scopes it (Phase 4): pull applies the
    // carve-out to its snapshot BEFORE building this resolver, so a mention of a
    // carved-out page comes back as a plain link there. Building it from the raw
    // rows here would make this command propose a body a pull tick never would —
    // and the push pass, whose own resolver is built over the pruned listing,
    // would then render that wikilink back as an escaped literal, so the file
    // would churn on every tick. The three resolvers are one invariant, not three
    // independent choices.
    const resolvePage = buildPageResolver(withoutExcluded(rows, makeDeskExclusion(cfg.desks)));
    const parsed = parseNotionPage(notionMarkdown, { resolvePage });
    assertPullSafe(parsed.body);
    for (const warning of parsed.warnings) {
      console.warn(`notion-sync: ${vaultPath}: ${warning}`);
    }

    // Fresh, not stored — see this function's doc comment (F1): row.mdHash is
    // stale BY DEFINITION on a conflict-frozen row. Rendered through the same
    // shared, resolver-aware composition the push and pull passes use, so a
    // wikilinked file's forced proposal is comparable to what apply will
    // re-render at approve time (T6 re-review: a resolver-free render here would
    // never match, and the row would supersede-and-refreeze forever).
    //
    // Taken BEFORE the supersede below, not after: a render that throws (an
    // unreadable file, a §4.3 refusal) must leave the world exactly as it found
    // it — otherwise the open proposal is gone, no replacement exists, and the
    // row is frozen with nothing to approve.
    const freshRender = await render.renderDoc(vaultPath);

    const existing = (await getOpenProposals(pool)).find((p) => p.vaultPath === vaultPath);
    if (existing !== undefined) {
      await setProposalState(pool, existing.id, "superseded");
    }

    // The same "before" side pull-sync.ts's own diff preview uses — the RAW
    // vault body (Obsidian-flavored), not the push-rendered one above (that's
    // Notion-flavored, and diffing it against parsed.body's Obsidian flavor
    // would be an apples-to-oranges comparison full of spurious noise). A
    // read failure degrades the preview, never the proposal itself (T6
    // review, F2 — the console has no vault mount to derive one on its own).
    let before = "";
    try {
      const vault = makeVaultWalk({ vaultPath: cfg.vaultPath });
      before = splitFrontmatter(await vault.readVaultFile(vaultPath)).body;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`notion-sync: diff preview unavailable for ${vaultPath}: ${message}`);
    }
    const preview = diffPreview(before, parsed.body);

    // Computed once and used for both the proposal and the stamp below: the two
    // must be the same two readings, or the next tick would judge the proposal
    // against a state the row never claimed.
    const baseMdHash = docRenderHash(freshRender);
    const liveNotionHash = sha256(notionMarkdown);

    const id = await insertProposal(pool, {
      vaultPath,
      notionPageId: row.pageId,
      proposedBody: parsed.body,
      baseMdHash,
      notionHash: liveNotionHash,
      diffPreview: preview,
    });

    // Make the row's own hashes true BEFORE unfreezing it, or the waiting period
    // between this command and the human's `approve` is not quiet — and there is
    // almost always a tick in it (the runbook un-quiesces after a resolve, and
    // the daemon ticks immediately on startup). The row's stored md_hash is the
    // pre-conflict one by definition here, so the next pull's conflict check
    // would re-freeze the row and orphan the proposal that was just forced.
    //
    // Both values are OBSERVED, not invented: the render this command just took
    // (the same one the proposal is based on) and the hash of the page it just
    // read. `notionLastEdited: null` keeps whatever reading the row had — the
    // store COALESCEs it — so the next pull re-reads once and the `unchanged`
    // branch stamps a real timestamp.
    //
    // What each case does from here: no edit → pull's hash matches, watermark
    // advances, proposeDesk is never entered, and push skips because the render
    // matches, so Notion keeps the human's version while they decide. A NEW
    // Notion edit before the approve → the hash differs, so the ordinary desk
    // flow supersedes this proposal with the newer content. A VAULT edit before
    // the approve → pull's unchanged branch never sees it (Notion is static);
    // the push holds the path back until the decision closes (skipVaultPaths,
    // wiki-sync.ts), and the freeze arrives at the stale approve.
    // The approve itself → apply's baseMdHash re-check passes (the vault has not
    // moved), it writes, and the same tick's push heals both hashes.
    //
    // Ordering is deliberate: upsertDocSynced deliberately preserves a 'frozen'
    // state (store.ts), so it stamps the hashes without lifting the freeze, and
    // unfreezeDoc is the one act that lifts it — leaving a failure here with the
    // row still frozen and the command re-runnable.
    await upsertDocSynced(pool, {
      vaultPath,
      pageId: row.pageId,
      mdHash: baseMdHash,
      notionHash: liveNotionHash,
      notionLastEdited: null,
      direction: row.direction,
    });
    await unfreezeDoc(pool, vaultPath);
    return (
      `${vaultPath}: forced proposal #${id} from the current Notion content — ` +
      `review with: notion-sync proposals — approve with: notion-sync approve ${vaultPath}`
    );
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// T7 — the two one-shot rollout commands (spec §18.5): `reconcile` closes the
// window between Phase 2 go-live and now and takes the first watermark reading;
// `enable-two-way` is the per-file switch that turns a desk folder's rows from
// 🔒 Mirror into ✍️ Desk, one dir at a time.
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  pull: PullSyncResult;
  /** Rows whose Sync/icon/lock stamp was (re)written. */
  stamped: number;
  stampFailed: number;
  /** Rows whose `notion_last_edited` baseline was taken from the fresh query. */
  baselined: number;
  /**
   * Rows deliberately left unbaselined: no page in the fresh query (nothing
   * observed) or no stored content hash to pair a real timestamp with.
   */
  baselineSkipped: number;
  /** Rows whose baseline write itself failed — contained, counted, re-runnable. */
  baselineFailed: number;
  summary: string;
}

/**
 * `notion-sync reconcile` — the one-time go-live pass (spec §18.5), idempotent
 * enough to re-run whenever the two sides need re-anchoring.
 *
 * Three phases, in an order that is the whole point of the command:
 *
 *   1. **Read every row once** and let the ordinary pull engine decide what each
 *      divergence means (`readAllRows`). Any page hand-edited between Phase 2
 *      go-live and now therefore takes the NORMAL path — a mirror row is reverted
 *      from the vault with a ping, a desk row becomes a proposal, a two-sided
 *      change freezes — instead of being silently absorbed by a baseline.
 *   2. **Stamp** every row with what its direction earns: `Sync`, plus the 🔒 icon
 *      and `is_locked` for mirror rows (§18.1), cleared for desk rows so a re-run
 *      after a pilot cannot re-lock the pages it just opened.
 *   3. **Only then baseline** `notion_last_edited`, from a queryDocs taken AFTER
 *      the stamping. Ordering matters and is not cosmetic: property writes bump
 *      `last_edited_time`, so a baseline taken first would sit BELOW every stamp
 *      and blind the pre-filter to every edit made before it (§18.5).
 *
 * The baseline pairs each row's freshly OBSERVED timestamp with the notion_hash
 * the store holds at that moment — never an invented one. For a row phase 1 read
 * cleanly that hash is current; for a row that froze, errored or now carries a
 * proposal it is deliberately still the pre-divergence value, which is exactly
 * what makes the next tick re-read and re-detect rather than forget.
 */
export async function runReconcile(opts: { dryRun: boolean }): Promise<ReconcileResult | null> {
  const cfg = loadNotionSyncConfig();
  const wiki = cfg.wiki;
  if (wiki === undefined) {
    console.log("notion-sync: reconcile: no Docs database configured, nothing to reconcile");
    return null;
  }
  const pool = poolFromEnv();
  try {
    const notion = makeNotionClient({
      token: readSecret("NOTION_TOKEN"),
      version: cfg.notionVersion,
    });
    const vault = makeVaultWalk({ vaultPath: cfg.vaultPath });
    const writer = makeVaultWriter({ vaultPath: cfg.vaultPath });
    const { renderDoc } = makeDocRender(cfg, pool);

    // Derived once for all three phases below: the read pass and the two snapshot
    // loops after it must agree on what this service owns, or the sweep would
    // stamp and baseline rows the pass it is reconciling never looks at.
    const isExcluded = makeDeskExclusion(cfg.desks);

    // Phase 1 — the read pass. ~457 pages at the client's throttle is minutes,
    // not seconds, so it says where it has got to; the counter lives here rather
    // than in the engine because progress is a property of THIS command's
    // one-shot shape, not of the pass.
    let reads = 0;
    const pull = await runPullSync({ dryRun: opts.dryRun, readAllRows: true, isExcluded }, {
      queryDocs: () => notion.queryDocs(wiki.docsDataSourceId),
      getDeskRows: () => getDeskRows(pool),
      getFrozenDocs: () => getFrozenDocs(pool),
      getStaleProposals: (hours) => getStaleProposals(pool, hours),
      getOpenProposals: () => getOpenProposals(pool),
      getRejectedUnexecuted: () => getRejectedUnexecuted(pool),
      getPageMarkdown: async (pageId) => {
        const markdown = await notion.getPageMarkdown(pageId);
        reads += 1;
        if (reads % PROGRESS_EVERY === 0) console.log(`notion-sync: reconcile: ${reads} page(s) read…`);
        return markdown;
      },
      patchPageMarkdown: notion.patchPageMarkdown,
      updateDocProps: notion.updateDocProps,
      createDocPage: (props, markdown) => notion.createDocPage(wiki.docsDataSourceId, props, markdown),
      renderDoc,
      readVaultFile: vault.readVaultFile,
      archiveVaultFile: writer.archiveVaultFile,
      insertProposal: (input) => insertProposal(pool, input),
      setProposalState: (id, state) => setProposalState(pool, id, state),
      upsertDocSynced: (doc) => upsertDocSynced(pool, doc),
      updateNotionWatermark: (vaultPath, notionHash, notionLastEdited) =>
        updateNotionWatermark(pool, vaultPath, notionHash, notionLastEdited),
      freezeDoc: (vaultPath, reason) => freezeDoc(pool, vaultPath, reason),
      markDocOrphaned: (vaultPath, reason) => markDocOrphaned(pool, vaultPath, reason),
      recordDocError: (vaultPath, message) => recordDocError(pool, vaultPath, message),
      notify: notifyFromEnv(),
    });
    console.log(`notion-sync: reconcile: read pass — ${pull.summary}`);

    // Re-read AFTER the pull pass: it may have reverted, recreated or frozen rows,
    // and both remaining phases must act on what the store holds now. Scoped like
    // the read pass: phase 2 below WRITES Notion for every row it iterates (icon,
    // lock, `Sync` stamp), and a path config has carved out is not this service's
    // to lock or stamp — least of all as a side effect of a go-live sweep.
    const rows = [...withoutExcluded(await getDeskRows(pool), isExcluded)]
      .sort(([a], [b]) => (a < b ? -1 : 1));

    if (opts.dryRun) {
      return {
        pull,
        stamped: 0,
        stampFailed: 0,
        baselined: 0,
        baselineSkipped: 0,
        baselineFailed: 0,
        summary:
          `reconcile (dry-run): ${pull.summary}; ` +
          `${rows.length} row(s) would be stamped and baselined`,
      };
    }

    // Phase 2 — the stamp.
    let stamped = 0;
    let stampFailed = 0;
    for (const [vaultPath, row] of rows) {
      // The lock and the 🔒 icon belong to MIRROR rows only, and the test used to
      // be `!isDesk` — which locked `notion_to_md` pages too (Phase 4). The lock is
      // a speed bump that says "your edit here will be reverted"; for a Notion-owned
      // page that is false, and the bump would sit in front of the one workflow the
      // direction exists to support. Only a page the vault overwrites gets locked.
      const isMirror = vaultOwns(row.direction);
      try {
        await notion.updatePageMeta(row.pageId, {
          icon: isMirror ? MIRROR_ICON : null,
          isLocked: isMirror,
        });
        await notion.updateDocProps(row.pageId, { sync: syncStampFor(row) });
        stamped += 1;
        if (stamped % PROGRESS_EVERY === 0) console.log(`notion-sync: reconcile: ${stamped} row(s) stamped…`);
      } catch (err) {
        // Contained per row, exactly like every other write in this service: one
        // page whose id has gone stale must not cost the other 456 their stamp.
        stampFailed += 1;
        console.error(`notion-sync: reconcile: stamp failed for ${vaultPath}: ${errorText(err)}`);
      }
    }

    // Phase 3 — the baseline, from a query taken after the stamping.
    const observed = new Map(
      (await notion.queryDocs(wiki.docsDataSourceId)).map((remote) => [pageKey(remote.pageId), remote.lastEditedTime]),
    );
    // Same scope as phase 2, for the same reason plus one: a watermark exists so
    // the pull pass knows when to re-read a row, and the pull pass never reads an
    // excluded row at all — baselining one would be bookkeeping for a question
    // nothing asks.
    const current = withoutExcluded(await getDeskRows(pool), isExcluded);
    let baselined = 0;
    let baselineSkipped = 0;
    let baselineFailed = 0;
    for (const [vaultPath, row] of [...current].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const lastEdited = observed.get(pageKey(row.pageId));
      if (lastEdited === undefined || lastEdited === "") {
        // No page, no reading. A guessed watermark would skip real edits forever;
        // an absent one just means the next tick treats the row as unbaselined,
        // which is a re-run of this command away from being fixed.
        baselineSkipped += 1;
        console.warn(`notion-sync: reconcile: no page in the fresh query for ${vaultPath} — not baselined`);
        continue;
      }
      if (!row.notionHash) {
        // A real timestamp paired with the "" pin would be a lie in the one place
        // the system trusts absolutely: the next tick's pre-filter would see a
        // watermark, decline to re-read, and the row would sit on a hash that was
        // never a reading of anything. Leaving it unbaselined is honest — and now
        // self-healing, since the pull pass reads a hash-bearing unbaselined row on
        // its own (F1) and this shape gets its hash from the next push.
        baselineSkipped += 1;
        console.warn(
          `notion-sync: reconcile: ${vaultPath} has no stored content hash (a pin) — not baselined; ` +
          `the next push writes one`,
        );
        continue;
      }
      try {
        await updateNotionWatermark(pool, vaultPath, row.notionHash, lastEdited);
        baselined += 1;
      } catch (err) {
        // Same containment as the stamp loop above: one row's failed write must
        // not cost the other 456 their baseline, and an unbaselined row is a
        // re-run away from being fixed.
        baselineFailed += 1;
        console.error(`notion-sync: reconcile: baseline failed for ${vaultPath}: ${errorText(err)}`);
      }
    }

    return {
      pull,
      stamped,
      stampFailed,
      baselined,
      baselineSkipped,
      baselineFailed,
      summary:
        `reconcile: ${pull.summary}; ${stamped} stamped (${stampFailed} failed), ` +
        `${baselined} baselined (${baselineSkipped} left unbaselined, ${baselineFailed} failed)`,
    };
  } finally {
    await pool.end();
  }
}

export interface EnableTwoWayResult {
  dir: string;
  enabled: string[];
  /**
   * The subset of `enabled` whose live round trip matched only AFTER
   * normalisation — the vault file and the body Notion gives back differ in
   * block spacing (translate-pull.ts's OUTPUT SHAPE note). Enabling them is
   * correct; the operator just needs to know that the FIRST applied Notion edit
   * rewrites those files' spacing to the canonical form, once.
   */
  reflowed: string[];
  skipped: Array<{ vaultPath: string; reason: string }>;
  summary: string;
}

/**
 * `notion-sync enable-two-way --dir <dir>` — the ONLY thing in this service that
 * makes a row two-way (plan decision 4), one file at a time, and only when both
 * legs of the fidelity gate say the round trip survives (spec §4.5/§18.3):
 *
 *   - the **offline leg**: a passing row in `notion_sync_fidelity`, recorded by
 *     `notion-sync fidelity --record`. That table is a record of a past run, so a
 *     missing row is a "not checked", never a "fine";
 *   - the **live leg**: this page's REAL `GET /markdown`, reverse-translated and
 *     compared to the vault file after normalisation. The offline leg only
 *     exercises our own translator pair; this one is the first time Notion's
 *     serializer gets a vote, and it is the vote that matters.
 *
 * Everything that does not pass KEEPS THE DIRECTION IT HAD and is reported with its
 * reason — 🔒 Mirror for a `md_to_notion` row, 📥 Notion source for a `notion_to_md`
 * one (Phase 4: "stays 🔒 Mirror" was true when mirror was the only alternative to
 * two-way, and is not any more).
 *
 * A `notion_to_md` row IS a legitimate candidate here, and deliberately so:
 * promoting a Notion-born page to two-way after both fidelity legs pass is exactly
 * the operator decision this command exists for. What cannot reach it is a
 * transcript — those live under a `deskDirs[].exclude` path, and the row snapshot
 * below is scoped by that same exclusion, so spec §17.2's "one-way, permanently"
 * holds structurally rather than by a rule stated here.
 *
 * `mirrorFilePrefixes` files are refused here by design: this is where direction
 * is decided, so it is the one place that rule needs to exist (plan decision 8).
 */

/**
 * Mirrors lib/fidelity.ts's own private frontmatterCloseDisagrees, independently —
 * the same deliberate non-import this file's splitSource already uses for the same
 * reason (fidelity.ts's header: "the two legs must never disagree"). This service's
 * own splitters close a frontmatter block on a line whose trim() is exactly "---";
 * @lares/vault-format's readOriginFrontmatter closes it on a line that merely
 * startsWith("---") — so a "----" line ends the block for one reading and not the
 * other, and a stamp read this way can be wrong about which bytes are frontmatter.
 */
function frontmatterCloseDisagrees(source: string): boolean {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return false;
  let trimClose = -1;
  let startsWithClose = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (trimClose === -1 && lines[i]!.trim() === "---") trimClose = i;
    if (startsWithClose === -1 && lines[i]!.startsWith("---")) startsWithClose = i;
  }
  return trimClose !== startsWithClose;
}

export async function runEnableTwoWay(dir: string, opts: { dryRun: boolean }): Promise<EnableTwoWayResult> {
  const cfg = loadNotionSyncConfig();
  const wiki = cfg.wiki;
  const desks = cfg.desks;
  if (wiki === undefined || desks === undefined) {
    throw new Error("notion-sync: enable-two-way needs deskDirs (and docsDataSourceId) in the config");
  }
  if (!desks.twoWayDirs.includes(dir)) {
    throw new Error(
      `notion-sync: "${dir}" is not one of twoWayDirs (${desks.twoWayDirs.join(", ") || "none"}) — ` +
      `the pilot dial is config, so widen it there first`,
    );
  }

  const pool = poolFromEnv();
  try {
    const notion = makeNotionClient({
      token: readSecret("NOTION_TOKEN"),
      version: cfg.notionVersion,
    });
    const vault = makeVaultWalk({ vaultPath: cfg.vaultPath });
    const allRows = await getDeskRows(pool);
    const passed = await getFidelityPassed(pool);
    const isExcluded = makeDeskExclusion(desks);
    // The same resolver a pull tick builds from the same snapshot — a
    // `<mention-page>` in the live markdown has to come back as the wikilink the
    // vault actually holds, or every linked file would "fail" the live leg.
    //
    // Scoped exactly as pull scopes it (Phase 4), and for a reason specific to
    // this command: the NOTION side this live leg compares against was written by
    // the push pass, whose resolver is built over the same pruned listing — so a
    // mention of a carved-out page comes back as a plain link, which is what the
    // vault file holds too. Resolving it to a wikilink here would make the two
    // sides differ and fail the live leg for every file that mentions one,
    // refusing to enable a file that is perfectly fine. (The earlier wording said
    // the push pass WROTE THE VAULT FILE, which it never does — only the apply
    // pass writes the vault. The scoping argument is the same either way; the
    // false clause pointed a reader at the wrong pass. T2 review, minor.)
    const resolvePage = buildPageResolver(withoutExcluded(allRows, isExcluded));

    const enabled: string[] = [];
    const reflowed: string[] = [];
    const skipped: Array<{ vaultPath: string; reason: string }> = [];
    /** Enabled rows awaiting their watermark — see the baseline note below. */
    const toBaseline: Array<{ vaultPath: string; pageId: string; notionHash: string }> = [];

    // Candidates = this dir MINUS whatever config carved out of it (Phase 4).
    // Not a nicety: this command is the ONLY thing that makes a row two-way, and
    // two-way is what lets Notion write back into the vault. A carved-out folder
    // is owned by another pass with its own rules — the transcript folder's are
    // that its pages cannot be pushed back at all — so a row there must never be
    // flippable, no matter how wide the twoWayDirs dial is opened later. Reported
    // as a non-candidate rather than a `skipped` reason: `skipped` is for files
    // that were candidates and failed a gate; these were never candidates.
    const rows = [...allRows]
      .filter(([vaultPath]) => vaultPath.startsWith(`${dir}/`) && !isExcluded(vaultPath))
      .sort(([a], [b]) => (a < b ? -1 : 1));

    /**
     * The Notion half of enabling a row: unlock, drop the 🔒, stamp ✍️ Desk.
     * Every one of these is idempotent, which is what lets an already-two-way row
     * be REPAIRED rather than skipped (see the branch below).
     */
    async function openPage(pageId: string): Promise<void> {
      // Unlock and drop the 🔒 in the same beat as the property: the icon is the
      // glance-level signal and the lock is the speed bump, and a page that is now
      // editable must not keep advertising that it is not (§18.1).
      await notion.updatePageMeta(pageId, { icon: null, isLocked: false });
      await notion.updateDocProps(pageId, { sync: SYNC_DESK });
    }

    for (const [vaultPath, row] of rows) {
      if (row.direction === TWO_WAY) {
        // Deliberately NOT a skip. The store flip and the two Notion writes cannot
        // be one transaction, so a failure between them leaves a row that is
        // two-way in the store but still locked and stamped 🔒 Mirror in Notion —
        // and a skip here would make that state permanent, since nothing else ever
        // revisits it. Re-asserting instead makes a second run of this command the
        // repair, which is what an operator will reach for anyway. All three writes
        // are idempotent, so re-asserting a row that is already correct costs two
        // API calls and changes nothing.
        if (opts.dryRun) {
          skipped.push({ vaultPath, reason: "already two-way (a live run re-asserts its Notion state)" });
          continue;
        }
        try {
          await openPage(row.pageId);
          const live = await notion.getPageMarkdown(row.pageId);
          // The baseline may only ever record content the store ALREADY knew
          // about (C2, final review). A re-assert reads the page for one reason —
          // to pair a fresh watermark with the hash the row holds — and if the
          // page has moved since the last pull, that read is an UNSEEN human edit.
          // Writing its hash here would tell the pull pass "you have already
          // considered this content", and the edit would be silently absorbed:
          // never proposed, never reverted, gone. So on a mismatch nothing is
          // written — not the hash, not the watermark (which would blind the
          // pre-filter just as badly) — and the row is reported and left exactly
          // as it was, for the pull pass to propose in the ordinary way.
          if (sha256(live) === row.notionHash) {
            toBaseline.push({ vaultPath, pageId: row.pageId, notionHash: row.notionHash });
            skipped.push({ vaultPath, reason: "already two-way — Notion state re-asserted" });
          } else {
            skipped.push({
              vaultPath,
              reason: "already two-way, Notion state re-asserted — pending Notion edit, " +
                "left for the pull pass (it will arrive as a proposal)",
            });
          }
        } catch (err) {
          skipped.push({ vaultPath, reason: `already two-way, re-assert failed: ${errorText(err)}` });
        }
        continue;
      }
      if (row.state !== "synced") {
        skipped.push({ vaultPath, reason: `row state is '${row.state}', not 'synced'` });
        continue;
      }
      const mirrored = desks.mirrorFilePrefixes.find((prefix) => vaultPath.startsWith(prefix));
      if (mirrored !== undefined) {
        skipped.push({ vaultPath, reason: `mirror by config (mirrorFilePrefixes: "${mirrored}")` });
        continue;
      }
      if (!passed.has(vaultPath)) {
        skipped.push({
          vaultPath,
          reason: "no passing fidelity record — run `notion-sync fidelity --record` and read its report",
        });
        continue;
      }

      let live: string;
      let pulledBody: string;
      try {
        live = await notion.getPageMarkdown(row.pageId);
        const parsed = parseNotionPage(live, { resolvePage });
        assertPullSafe(parsed.body);
        pulledBody = parsed.body;
      } catch (err) {
        skipped.push({ vaultPath, reason: `live leg: ${errorText(err)}` });
        continue;
      }

      let vaultSource: string;
      let sourceBody: string;
      try {
        vaultSource = await vault.readVaultFile(vaultPath);
        sourceBody = splitSource(vaultSource).body;
      } catch (err) {
        skipped.push({ vaultPath, reason: `vault read: ${errorText(err)}` });
        continue;
      }

      // ADR-0017 rule 9, live leg: the same verdict the offline gate computes in
      // lib/fidelity.ts's checkOne, against the file as it stands right now — the
      // offline leg only proves the LAST recorded fidelity pass, and the file may
      // have changed on disk since. The two legs must never disagree (fidelity.ts's
      // own header), so the reasons are identical.
      if (frontmatterCloseDisagrees(vaultSource)) {
        skipped.push({
          vaultPath,
          reason: "this file's frontmatter block ends ambiguously (a line starting with \"---\" that " +
            "is not exactly \"---\") — refusing rather than guessing which stamp survives a pull",
        });
        continue;
      }
      const stamp = readOriginFrontmatter(vaultSource);
      if (stamp === undefined) {
        skipped.push({ vaultPath, reason: "a pull would leave this file with no origin at all" });
        continue;
      }
      const afterStamp = originAfterWrite(stamp, "synced");
      if (afterStamp !== stamp) {
        skipped.push({
          vaultPath,
          reason: `a pull would leave this file's origin as "${afterStamp}" instead of "${stamp}" — refusing rather than widening it`,
        });
        continue;
      }

      if (normalizeForFidelity(sourceBody) !== normalizeForFidelity(pulledBody)) {
        const preview = diffPreview(normalizeForFidelity(sourceBody), normalizeForFidelity(pulledBody));
        skipped.push({
          vaultPath,
          reason: `live round-trip differs (Notion's own serialisation) — ${preview.split("\n")[0]}`,
        });
        continue;
      }

      // Equal after normalisation, not before: this file's blocks are spaced
      // some way other than the canonical one, so the first Notion edit applied
      // to it will rewrite that spacing once. Reported, never a reason to
      // refuse — the content round-trips, which is what direction turns on.
      if (sourceBody !== pulledBody) reflowed.push(vaultPath);

      if (opts.dryRun) {
        enabled.push(vaultPath);
        continue;
      }

      // Contained per row, like every other write loop in this service: one page
      // whose id has gone stale, or one 5xx, must not abandon the rest of the dir
      // half-enabled. A failure part-way through leaves the row two-way in the
      // store and still locked in Notion — which the branch at the top of this
      // loop repairs on the next run, so the reported failure is actionable rather
      // than terminal.
      try {
        await setDocDirection(pool, vaultPath, TWO_WAY);
        await openPage(row.pageId);
      } catch (err) {
        skipped.push({ vaultPath, reason: `enable failed (re-run to repair): ${errorText(err)}` });
        continue;
      }
      enabled.push(vaultPath);
      toBaseline.push({ vaultPath, pageId: row.pageId, notionHash: sha256(live) });
    }

    // Same §18.5 ordering rule as reconcile: the writes above bumped
    // `last_edited_time`, so the watermark comes from a query taken after them,
    // and only for rows the query actually returns (never a guessed value).
    //
    // The hash is the one read for the live leg (or, on a re-assert, the row's
    // own — a re-assert whose page has moved is not baselined at all, see above).
    // Properties and icons do not change a page's markdown —
    // the push pass's own hash-after-write read happens after a property write and
    // converges to all-skips — and if that ever stopped being true the next tick
    // would re-read, see a different hash and raise a proposal: visible, gated,
    // never a silent write.
    if (toBaseline.length > 0) {
      const observed = new Map(
        (await notion.queryDocs(wiki.docsDataSourceId))
          .map((remote) => [pageKey(remote.pageId), remote.lastEditedTime]),
      );
      for (const entry of toBaseline) {
        const lastEdited = observed.get(pageKey(entry.pageId));
        if (lastEdited === undefined || lastEdited === "") {
          console.warn(
            `notion-sync: ${entry.vaultPath} enabled but not baselined — no page in the fresh ` +
            `Docs query; the next pull tick reads it once and baselines it then`,
          );
          continue;
        }
        await updateNotionWatermark(pool, entry.vaultPath, entry.notionHash, lastEdited);
      }
    }

    return {
      dir,
      enabled,
      reflowed,
      skipped,
      summary:
        `enable-two-way ${dir}: ${enabled.length} enabled (${reflowed.length} will reflow on first apply), ` +
        `${skipped.length} skipped, ` +
        `${rows.length} row(s) in scope${opts.dryRun ? " (dry-run)" : ""}`,
    };
  } finally {
    await pool.end();
  }
}

/** Minutes/hours/days, whichever is coarsest without going to zero — presentation-only. */
function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The one-shot operator actions the container entrypoint can be asked for.
 *
 * THE RULE THIS LIST ENCODES (README, "Operator commands"): the image ships this
 * package, not the `lares` CLI, and the box has no lares checkout — so a command
 * that exists only as a commander subcommand cannot be run where the vault, the
 * database and the Notion token are. Every operator command the docs tell Bendik to
 * run has to appear here too. Phase 4 shipped four that did not (fix wave, item 2):
 * `adoption-report`, and the single-pass previews the runbook's own deploy steps
 * call for.
 */
export type OneShotMode =
  | "reconcile" | "fidelity-record" | "enable-two-way" | "resolve" | "archive-excluded"
  | "adoption-report" | "transcripts" | "notion-born" | "people" | "approve" | "reject";

export interface OneShotArgs {
  /** `--once`: run a single tick. Mutually exclusive with every mode below. */
  once: boolean;
  /** The single one-shot requested, if any. */
  mode?: OneShotMode;
  /** The desk dir, present only for `enable-two-way`. */
  dir?: string;
  /** The vault path, present for `resolve`, `approve` and `reject`. */
  path?: string;
  /** Which side wins, present only for `resolve`. */
  keep?: ResolveKeep;
}

/**
 * Reads the entrypoint's one-shot flags, and refuses anything ambiguous.
 *
 * A pure function of argv, living here rather than inline in bin/notion-sync.ts,
 * for one reason: it is the only logic in that file with a wrong answer available,
 * and a wrong answer is expensive — `--reconcile --fidelity-record` silently
 * running one and dropping the other is exactly the kind of thing a runbook step
 * gets blamed for a week later. Pure and exported, it is testable without a
 * process; the entrypoint stays the thin wiring it should be.
 *
 * `--resolve <path> --keep md|notion` is a one-shot like the others (I1, final
 * review): the box has no lares checkout, so the commander `resolve` command
 * cannot be run where the vault, the database and the token are — which made a
 * frozen row unresolvable in production. Both halves are required together and
 * neither is guessed: a missing path, a missing `--keep` or a `--keep` this
 * service cannot honour is a loud error, never a default.
 *
 * `--approve <path>` / `--reject <path>` (LAR-64) have the same no-lares-checkout
 * problem as `--resolve`, and a sharper failure mode: the commander `approve
 * <path>` / `reject <path>` subcommands had no caller left after the lares CLI
 * was deleted in the split, and typing that old form on the box — a bare
 * positional argument — used to fall through silently into daemon mode instead
 * of erroring, once starting a second sync tick mid-pull. That is why this
 * function now refuses every argument it does not recognise, positional or
 * `--flag`, instead of quietly ignoring it.
 */
export function parseOneShotArgs(argv: string[]): OneShotArgs {
  const once = argv.includes("--once");
  const enableAt = argv.indexOf("--enable-two-way");
  const dir = enableAt === -1 ? undefined : argv[enableAt + 1];
  if (enableAt !== -1 && (dir === undefined || dir.startsWith("--"))) {
    throw new Error("--enable-two-way needs a desk dir, e.g. --enable-two-way desks/example");
  }

  const resolveAt = argv.indexOf("--resolve");
  const resolvePath = resolveAt === -1 ? undefined : argv[resolveAt + 1];
  if (resolveAt !== -1 && (resolvePath === undefined || resolvePath.startsWith("--"))) {
    throw new Error("--resolve needs a vault path, e.g. --resolve desks/example/note.md --keep md");
  }
  const keepAt = argv.indexOf("--keep");
  const keepValue = keepAt === -1 ? undefined : argv[keepAt + 1];
  // `--keep` alone is a typo, and the wrong thing to be forgiving about: without
  // a mode this file falls through to the daemon, so a mistyped resolve would
  // quietly start ticking instead of resolving anything.
  if (keepAt !== -1 && resolveAt === -1) {
    throw new Error("--keep only means something with --resolve <path>");
  }
  if (resolveAt !== -1 && keepAt === -1) {
    throw new Error(
      `--resolve needs --keep md|notion — which side of the conflict wins for ${resolvePath as string}`,
    );
  }
  if (keepAt !== -1 && keepValue !== "md" && keepValue !== "notion") {
    throw new Error(`--keep must be "md" or "notion", got "${keepValue ?? ""}"`);
  }
  // The other one-shots rehearse; this one carries out a decision the human has
  // already made, so there is nothing for a dry-run to show them — and running
  // the live write anyway, under a flag that says otherwise, is worse than
  // refusing. (The entrypoint refuses NOTION_SYNC_DRY_RUN=1 the same way; this
  // half is the one that can be a pure function of argv.)
  if (resolveAt !== -1 && argv.includes("--dry-run")) {
    throw new Error("--resolve is always live: it writes the side you named — drop --dry-run");
  }

  // `--approve <path>` / `--reject <path>` (LAR-64): the same fix as `--resolve`
  // above, for the same reason — approveProposal/rejectProposal already exist and
  // are guarded (setOpenProposalState → resolveProposal), but had no caller on the
  // box. A missing path is a loud error, never a default.
  const approveAt = argv.indexOf("--approve");
  const approvePath = approveAt === -1 ? undefined : argv[approveAt + 1];
  if (approveAt !== -1 && (approvePath === undefined || approvePath.startsWith("--"))) {
    throw new Error("--approve needs a vault path, e.g. --approve desks/example/note.md");
  }
  const rejectAt = argv.indexOf("--reject");
  const rejectPath = rejectAt === -1 ? undefined : argv[rejectAt + 1];
  if (rejectAt !== -1 && (rejectPath === undefined || rejectPath.startsWith("--"))) {
    throw new Error("--reject needs a vault path, e.g. --reject desks/example/note.md");
  }
  // Same posture as --resolve immediately above: the human has already decided,
  // so there is nothing to rehearse.
  if (approveAt !== -1 && argv.includes("--dry-run")) {
    throw new Error("--approve is always live: it flips the proposal now — drop --dry-run");
  }
  if (rejectAt !== -1 && argv.includes("--dry-run")) {
    throw new Error("--reject is always live: it flips the proposal now — drop --dry-run");
  }

  // Refuse anything this function does not recognise — a bare positional (the old
  // `approve <path>` typo that used to fall through into daemon mode instead of
  // erroring) or an unknown `--flag` — rather than silently ignoring it, which is
  // exactly what let that typo through in the first place.
  const consumed = new Set<number>();
  for (const at of [enableAt, resolveAt, keepAt, approveAt, rejectAt]) {
    if (at === -1) continue;
    consumed.add(at);
    consumed.add(at + 1);
  }
  const knownBooleanFlags = new Set([
    "--once", "--dry-run", "--no-dry-run", "--reconcile", "--fidelity-record",
    "--archive-excluded", "--adoption-report", "--transcripts", "--notion-born", "--people",
  ]);
  const validOneShots =
    "--approve <path>, --reject <path>, --resolve <path> --keep md|notion, --enable-two-way <dir>, " +
    "--reconcile, --fidelity-record, --archive-excluded, --adoption-report, --transcripts, " +
    "--notion-born, --people, or --once";
  for (let i = 0; i < argv.length; i++) {
    if (consumed.has(i) || knownBooleanFlags.has(argv[i])) continue;
    const token = argv[i];
    throw token.startsWith("--")
      ? new Error(`unknown flag "${token}" — valid one-shots are ${validOneShots}`)
      : new Error(
        `unexpected argument "${token}" — one-shots take flags, not a bare path; ` +
        `valid one-shots are ${validOneShots}`,
      );
  }

  const requested: Array<[OneShotMode, string]> = [
    ...(argv.includes("--reconcile") ? [["reconcile", "--reconcile"] as [OneShotMode, string]] : []),
    ...(argv.includes("--fidelity-record")
      ? [["fidelity-record", "--fidelity-record"] as [OneShotMode, string]]
      : []),
    ...(argv.includes("--archive-excluded")
      ? [["archive-excluded", "--archive-excluded"] as [OneShotMode, string]]
      : []),
    // The four added by the final fix wave (item 2). `--adoption-report` writes
    // nothing anywhere, ever; the three pass flags run exactly one pass of a tick
    // and honour --dry-run/NOTION_SYNC_DRY_RUN like the daemon does, which is what
    // makes the runbook's `transcripts --dry-run` / `people --dry-run` preview steps
    // runnable on the box at all.
    ...(argv.includes("--adoption-report")
      ? [["adoption-report", "--adoption-report"] as [OneShotMode, string]]
      : []),
    ...(argv.includes("--transcripts") ? [["transcripts", "--transcripts"] as [OneShotMode, string]] : []),
    ...(argv.includes("--notion-born") ? [["notion-born", "--notion-born"] as [OneShotMode, string]] : []),
    ...(argv.includes("--people") ? [["people", "--people"] as [OneShotMode, string]] : []),
    ...(enableAt === -1 ? [] : [["enable-two-way", "--enable-two-way"] as [OneShotMode, string]]),
    ...(resolveAt === -1 ? [] : [["resolve", "--resolve"] as [OneShotMode, string]]),
    ...(approveAt === -1 ? [] : [["approve", "--approve"] as [OneShotMode, string]]),
    ...(rejectAt === -1 ? [] : [["reject", "--reject"] as [OneShotMode, string]]),
  ];
  if (requested.length > 1) {
    throw new Error(`pass one one-shot flag at a time, got: ${requested.map(([, flag]) => flag).join(" ")}`);
  }
  if (requested.length === 1 && once) {
    throw new Error(`--once runs the tick; it cannot be combined with ${requested[0][1]}`);
  }

  // At most one of these is ever set — `requested` above has already refused any
  // combination that could set more than one — so picking the first defined one
  // is unambiguous.
  const path = resolvePath ?? approvePath ?? rejectPath;

  return {
    once,
    ...(requested.length === 0 ? {} : { mode: requested[0][0] }),
    ...(dir === undefined ? {} : { dir }),
    ...(path === undefined ? {} : { path }),
    ...(keepValue === undefined ? {} : { keep: keepValue as ResolveKeep }),
  };
}

/**
 * `archive-excluded`'s dry-run default (fix round 1, Important 1) — the
 * opposite polarity from every other one-shot mode above: this command
 * trashes real Notion pages, so the safe (report-only) behaviour must be what
 * happens with no flags at all, and `--no-dry-run` is the one explicit way to
 * ask for live writes.
 *
 * Extracted and exported for the same reason parseOneShotArgs is (see its own
 * doc comment): this expression decides whether the box's most destructive
 * one-shot writes or merely reports, and nothing imports bin/notion-sync.ts to
 * catch a mutation of it — reviewer mutation-testing on this diff found that a
 * `||`/`&&` typo at the call site would go live with the whole 559-test suite
 * green, because no test exercised bin/notion-sync.ts's own source at all.
 *
 * `sharedDryRun` is bin/notion-sync.ts's existing --dry-run/NOTION_SYNC_DRY_RUN
 * const. This function does not resolve a CONTRADICTION between that safety
 * net and an explicit `--no-dry-run` — bin/notion-sync.ts refuses that
 * combination outright, before this is ever called (mirrors the --resolve +
 * --dry-run refusal already there), so by the time this runs, only the
 * combinations below are still possible:
 *
 *   argv                 sharedDryRun  →  result
 *   []                   false            true   (default: safe)
 *   ["--no-dry-run"]     false            false  (explicit: write)
 *   []                   true             true   (env forces safe)
 *   ["--no-dry-run"]     true             refused before this runs, see above
 */
export function archiveExcludedDryRun(argv: string[], sharedDryRun: boolean): boolean {
  return sharedDryRun || !argv.includes("--no-dry-run");
}

export interface SyncPass {
  name: string;
  /** Runs the pass; resolves to its bookkeepingFailed count. */
  run: () => Promise<number>;
}

/**
 * Runs the passes in order, containing each failure so a broken attendee pass
 * can never starve the wiki pass (or vice versa) — the tick's pass-isolation
 * rule. Returns false when any pass threw or completed with bookkeeping
 * failures: the --once entrypoint turns that into a non-zero exit, while the
 * daemon logs it and waits for the next tick to retry whatever is left.
 */
export async function runPassesContained(passes: SyncPass[]): Promise<boolean> {
  let clean = true;
  for (const pass of passes) {
    try {
      if (await pass.run() > 0) clean = false;
    } catch (err) {
      clean = false;
      console.error(`notion-sync: ${pass.name} pass failed`, err);
    }
  }
  return clean;
}

/** The passes one tick runs, in the one order they may run in. */
export interface TickRunners {
  attendees: () => Promise<number>;
  transcripts: () => Promise<number>;
  notionBorn: () => Promise<number>;
  pull: () => Promise<number>;
  apply: () => Promise<number>;
  wiki: () => Promise<number>;
  desk: () => Promise<number>;
  people: () => Promise<number>;
}

/**
 * The tick, as an ordered list — pure, so the order itself is testable and the
 * container entrypoint stays a thin wiring file.
 *
 * The order is load-bearing, and it is NOT the obvious one:
 *
 *   attendees → transcripts → notion-born → **pull → apply → push (wiki, then each desk dir)**
 *
 * Transcripts sits second, and its position matters in one direction only: BEFORE
 * apply. It reads Meetings (which the attendee pass has just finished writing) and
 * writes neither Notion nor the vault, so nothing downstream of it can be disturbed
 * — but it has to see a rejection before apply CLOSES it, or the tick after a 👎
 * would re-propose the very transcript that was just declined. Same reason pull
 * reads `getRejectedUnexecuted`, and the same fix.
 *
 * Notion-born (T6) sits beside it for exactly the same reason and with exactly the
 * same freedom: it is the OTHER create proposer, it writes neither side, and it must
 * see a rejection while that rejection is still unexecuted. Its position relative to
 * pull is free — pull iterates STORE rows and a Notion-born page has none with a
 * path, so neither pass can see the other's subject — and the two proposers are kept
 * adjacent so the tick reads as "everything that ASKS, then everything that DOES".
 *
 * Push before pull would be wrong in a way no later step could repair. The push
 * engine is direction-blind: it re-patches any row whose render no longer matches
 * the stored `md_hash`, and it revives non-'synced' rows wholesale. A human's
 * Notion edit lives only in Notion until pull has seen it, so a push that ran
 * first would overwrite that edit before the conflict check (§6) ever got to
 * fire — silently, and with no record of what was lost beyond Notion's own page
 * history. Pull first means the edit is either reverted deliberately (mirror),
 * proposed for a 👍 (desk) or frozen (both sides moved) BEFORE anything is
 * written over it.
 *
 * Apply sits between them because it is the only pass that writes the vault: an
 * approved proposal lands on disk, and the push that follows in the SAME tick
 * carries it back to Notion and takes the hash-after-write reading that closes
 * the loop (see apply-sync.ts's note on the deliberately stale md_hash).
 *
 * People (T7) sits LAST, and its position matters in one direction only: after
 * ATTENDEES, whose `Attendees` string it derives the relation from. Everything
 * else about it is isolation. It touches neither the vault nor the store nor the
 * proposal queue, and the only Notion writes it makes are to the People database
 * and to two Meetings properties nothing else in this file reads — so running it
 * after the pushes means its patches cannot bump a `last_edited_time` that an
 * earlier pass in the same tick has already taken a reading of.
 *
 * Two residual windows, both accepted and bounded:
 *
 *   - A Notion edit that lands between pull's read of a page and push's patch of
 *     it — at most one tick wide — is still overwritten for a mirror row. Notion's
 *     page history keeps the content, and the alternative (locking, or a second
 *     read immediately before every patch) costs a re-read per row per tick to
 *     close a gap that mirror rows are, by definition, not supposed to have edits
 *     in.
 *   - During a backfill, a desk file's render can change between two ticks for a
 *     reason that is not an edit: a `[[wikilink]]` whose target page did not exist
 *     yet becomes resolvable once that page is created, so the render — and its
 *     hash — legitimately move (wiki-sync.ts's resolver is a snapshot as of the
 *     pass's start, which is what makes the backfill converge in three passes). If
 *     a human edits that same page in Notion inside that window, pull sees both
 *     hashes differ and freezes it as a two-sided conflict instead of proposing
 *     it. That is the fail-safe direction — nothing is written, and one
 *     `notion-sync resolve --keep notion` turns it back into a proposal — and it
 *     stops entirely once the dir has converged.
 */
export function tickPasses(runners: TickRunners): SyncPass[] {
  return [
    { name: "attendees", run: runners.attendees },
    { name: "transcripts", run: runners.transcripts },
    { name: "notion-born", run: runners.notionBorn },
    { name: "pull", run: runners.pull },
    { name: "apply", run: runners.apply },
    { name: "wiki", run: runners.wiki },
    { name: "desk", run: runners.desk },
    { name: "people", run: runners.people },
  ];
}

export function registerNotionSyncCommands(program: Command): void {
  const cmd = program.command("notion-sync").description("Keep the Brain vault and Notion in step");

  cmd
    .command("attendees")
    .description("Fill Notion meeting Attendees from Google Calendar")
    .option("--dry-run", "report the plan without writing", false)
    .option("--tolerance <minutes>", "start-time match window", String(DEFAULT_TOLERANCE_MINUTES))
    .action(async (opts: { dryRun: boolean; tolerance: string }) => {
      const toleranceMinutes = Number(opts.tolerance);
      if (!Number.isFinite(toleranceMinutes) || toleranceMinutes <= 0) {
        throw new Error(`--tolerance must be a positive number, got "${opts.tolerance}"`);
      }

      const result = await syncAttendeesOnce({ dryRun: opts.dryRun, toleranceMinutes });
      console.log(result.summary);
      if (result.bookkeepingFailed > 0) {
        // Notion is already updated for these rows and the next run will skip them
        // (their Attendees is no longer empty), so the local state has drifted for
        // good. Nothing to retry — but the run must not report success.
        console.error(
          `notion-sync: ${result.bookkeepingFailed} row(s) could not be recorded in the ` +
          `state database; see the errors above. Notion is correct, the local record is not.`,
        );
        process.exitCode = 1;
      }
    });

  cmd
    .command("wiki")
    .description("Push wiki markdown one-way into the Notion Docs database")
    .option("--dry-run", "report the plan without writing", false)
    .option("--limit <n>", "process only the first N sorted files (scratch tests)")
    .action(async (opts: { dryRun: boolean; limit?: string }) => {
      let limit: number | undefined;
      if (opts.limit !== undefined) {
        limit = Number(opts.limit);
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new Error(`--limit must be a positive integer, got "${opts.limit}"`);
        }
      }

      const result = await syncWikiOnce({
        dryRun: opts.dryRun,
        ...(limit === undefined ? {} : { limit }),
      });
      if (result === null) return; // not configured — syncWikiOnce logged the skip
      console.log(result.summary);
      if (result.bookkeepingFailed > 0) {
        // Same posture as the attendees command — and here the stakes are higher:
        // an unrecorded CREATE means the next run makes a duplicate page (see
        // wiki-sync.ts), so the run must not report success.
        console.error(
          `notion-sync: ${result.bookkeepingFailed} doc(s) could not be recorded in the ` +
          `state database; see the errors above. Notion may be correct, the local record is not.`,
        );
        process.exitCode = 1;
      }
    });

  cmd
    .command("desk-push")
    .description("Push each configured desk folder into the Notion Docs database (md→Notion)")
    .option("--dry-run", "report the plan without writing", false)
    .option("--limit <n>", "process only the first N sorted files per dir (scratch tests)")
    .action(async (opts: { dryRun: boolean; limit?: string }) => {
      let limit: number | undefined;
      if (opts.limit !== undefined) {
        limit = Number(opts.limit);
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new Error(`--limit must be a positive integer, got "${opts.limit}"`);
        }
      }
      const result = await syncDeskPushOnce({
        dryRun: opts.dryRun,
        ...(limit === undefined ? {} : { limit }),
      });
      if (result === null) return; // not configured — syncDeskPushOnce logged the skip
      for (const dir of result.perDir) console.log(`${dir.dir}: ${dir.summary}`);
      console.log(result.summary);
      if (result.bookkeepingFailed > 0 || result.dirsFailed > 0) process.exitCode = 1;
    });

  cmd
    .command("pull")
    .description("Read what Notion holds: revert mirror edits, propose desk edits, freeze conflicts")
    .option("--dry-run", "report the plan without writing", false)
    .action(async (opts: { dryRun: boolean }) => {
      const result = await syncPullOnce({ dryRun: opts.dryRun });
      if (result === null) return;
      console.log(result.summary);
      if (result.bookkeepingFailed > 0) process.exitCode = 1;
    });

  cmd
    .command("apply")
    .description("Carry out approved/rejected proposals — the only pass that writes the vault")
    .option("--dry-run", "report the plan without writing", false)
    .action(async (opts: { dryRun: boolean }) => {
      const result = await syncApplyOnce({ dryRun: opts.dryRun });
      if (result === null) return;
      console.log(result.summary);
      if (result.bookkeepingFailed > 0) process.exitCode = 1;
    });

  cmd
    .command("transcripts")
    .description(
      "T4 (Phase 4): propose Notion Meetings transcripts into the vault, one-way " +
      "and 👍-gated. Writes nothing itself — every file lands through the proposal queue.",
    )
    .option("--dry-run", "report the plan without writing", false)
    .action(async (opts: { dryRun: boolean }) => {
      const result = await syncTranscriptsOnce({ dryRun: opts.dryRun });
      if (result === null) return;
      // Every skip is REPORTED, never silent: an unmapped Project, a missing Date
      // and an already-occupied path are all things only Bendik can resolve, and a
      // count alone would not tell him which meeting to go and look at.
      for (const skip of result.skipped) {
        console.log(`  skipped: ${skip.vaultPath ?? skip.pageId} — ${skip.reason}`);
      }
      console.log(`notion-sync: transcripts ${result.summary}`);
      if (result.bookkeepingFailed > 0) process.exitCode = 1;
    });

  cmd
    .command("notion-born")
    .description(
      "T6 (Phase 4): propose Notion Docs pages a human created there — pages with no " +
      "vault file — into the vault as NEW FILES, 👍-gated. Writes nothing itself. " +
      "Run --dry-run first: it prints every page it would create and every one it " +
      "refuses, with the reason.",
    )
    .option("--dry-run", "report the plan without writing", false)
    .action(async (opts: { dryRun: boolean }) => {
      const result = await syncNotionBornOnce({ dryRun: opts.dryRun });
      if (result === null) return;
      // Every skip is REPORTED, never silent (the brief's requirement 6): an
      // unmappable Project, a refused Folder and a slug that collides with an
      // existing file are all things only Bendik can resolve, and a count alone
      // would not tell him which page to go and look at.
      for (const skip of result.skipped) {
        console.log(`  skipped: ${skip.vaultPath ?? skip.pageId} (${skip.title}) — ${skip.reason}`);
      }
      console.log(`notion-sync: notion-born ${result.summary}`);
      if (result.bookkeepingFailed > 0) process.exitCode = 1;
    });

  cmd
    .command("people")
    .description(
      "T7 (Phase 4): project the people your Meetings rows name from the source of " +
      "truth into the Notion People database, and link each meeting to them. " +
      "READ-MOSTLY: it creates and updates People rows and never deletes one, and it " +
      "never writes back to the source. An attendee it cannot match is left out of " +
      "the relation and named in `People Unmatched` — never guessed at.",
    )
    .option("--dry-run", "report the plan without writing", false)
    .action(async (opts: { dryRun: boolean }) => {
      const result = await syncPeopleOnce({ dryRun: opts.dryRun });
      if (result === null) return;
      // Every refusal is REPORTED, never silent: a duplicated email, a Source ID
      // that belongs to someone else and a truncated relation are all messes only
      // Bendik can settle, and a count alone would not tell him which row to open.
      for (const dup of result.duplicates) {
        console.log(`  duplicate email: ${dup.email} — People rows ${dup.pageIds.join(", ")}`);
      }
      for (const clash of result.contestedAddresses) {
        console.log(
          `  contested address: ${clash.email} — stays with People row ${clash.boundTo} ` +
          `(${clash.boundBy}); also claimed by ${clash.alsoClaimedBy.join(", ")}`,
        );
      }
      for (const row of result.relabelled) {
        console.log(`  relabelled: People row ${row.pageId} "${row.from}" → "${row.to}" (${row.sourceId})`);
      }
      for (const skip of result.skipped) {
        console.log(`  skipped: ${skip.name} (${skip.sourceId}) — ${skip.reason}`);
      }
      for (const skip of result.meetingsSkipped) {
        console.log(`  skipped meeting: ${skip.title} (${skip.pageId}) — ${skip.reason}`);
      }
      // A settled meeting whose people grew — the one remaining way a person can
      // join a meeting they did not attend, so it is never silent.
      for (const late of result.lateLinks) {
        console.log(`  late link: ${late.title} (${late.pageId}) — now also ${late.emails.join(", ")}`);
      }
      console.log(`notion-sync: people ${result.summary}`);
    });

  cmd
    .command("adoption-report")
    .description(
      "T5 (Phase 4): match the pre-existing vault transcripts against the Notion Meetings " +
      "rows by page id / date+title / title-only, and report Confident / title-only / " +
      "Ambiguous / Unmatched. REPORT ONLY — writes nothing, anywhere, ever. Bendik rules on " +
      "adoption from this output.",
    )
    // A boolean, never a path: this command is read-only by contract, and the ONLY
    // way `--json` could become a write is if it took a destination to write TO.
    // It doesn't — there is no such option — so printing to a file is not a
    // possibility this flag's SHAPE allows, not just a thing it happens not to do.
    .option("--json", "print the full report as JSON to stdout (never to a file)", false)
    .action(async (opts: { json: boolean }) => {
      const result = await runAdoptionReportOnce();
      if (result === null) return; // not configured — runAdoptionReportOnce logged the skip

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printAdoptionReport(result);
    });

  cmd
    .command("archive-excluded")
    .description(
      "T3 (Phase 4): trash the Notion pages for Docs rows the current config's " +
      "deskDirs[].exclude has carved out of desk scope, and mark their state rows " +
      "orphaned. Dry-run by DEFAULT — pass --no-dry-run to actually write.",
    )
    .option("--no-dry-run", "actually trash pages and mark rows orphaned (default: dry-run, writes nothing)")
    .action(async (opts: { dryRun: boolean }) => {
      const result = await syncArchiveExcludedOnce({ dryRun: opts.dryRun });
      // "would trash" vs "trashed" (fix round 1, Important 2): a dry-run report
      // must never read like a completed live run. result.dryRun (not the local
      // opts.dryRun) is the source of truth here on purpose — it is what the
      // engine actually did, not what was asked for.
      const verb = result.dryRun ? "would trash" : "trashed";
      for (const row of result.trashed) console.log(`  ${verb}: ${row.vaultPath}  (${row.pageId})`);
      for (const row of result.alreadyDone) console.log(`  already done: ${row.vaultPath}  (${row.pageId})`);
      for (const row of result.skipped) console.log(`  skipped: ${row.vaultPath} — ${row.reason}`);
      for (const row of result.failed) console.log(`  FAILED: ${row.vaultPath} — ${row.reason}`);
      for (const row of result.orphanFailed) console.log(`  ORPHAN-FAILED: ${row.vaultPath} — ${row.reason}`);
      console.log(result.summary);
      if (result.failed.length > 0 || result.orphanFailed.length > 0) process.exitCode = 1;
    });

  cmd
    .command("reconcile")
    .description(
      "One-time go-live pass (spec §18.5): re-read every page, handle anything that " +
      "diverged the normal way, stamp Sync/icon/lock, then take the notion_last_edited " +
      "baseline from a fresh query. Idempotent — safe to re-run.",
    )
    .option("--dry-run", "report the plan without writing", false)
    .action(async (opts: { dryRun: boolean }) => {
      const result = await runReconcile({ dryRun: opts.dryRun });
      if (result === null) return;
      console.log(result.summary);
      if (result.pull.bookkeepingFailed > 0 || result.stampFailed > 0 || result.baselineFailed > 0) {
        process.exitCode = 1;
      }
    });

  cmd
    .command("enable-two-way")
    .description(
      "Turn a desk folder's rows from 🔒 Mirror into ✍️ Desk, per file, only where both " +
      "fidelity legs pass (spec §4.5/§18.3). Everything else stays Mirror and is reported.",
    )
    .requiredOption("--dir <dir>", "the desk dir to enable — must be listed in twoWayDirs")
    .option("--dry-run", "report which files would be enabled, without writing", false)
    .action(async (opts: { dir: string; dryRun: boolean }) => {
      const result = await runEnableTwoWay(opts.dir, { dryRun: opts.dryRun });
      for (const path of result.enabled) {
        const reflow = result.reflowed.includes(path)
          ? "  [reflow: the first applied Notion edit rewrites this file's block spacing]"
          : "";
        console.log(`  enabled  ${path}${reflow}`);
      }
      for (const skip of result.skipped) console.log(`  skipped  ${skip.vaultPath} — ${skip.reason}`);
      console.log(result.summary);
    });

  cmd
    .command("fidelity")
    .description(
      "Round-trip every vault markdown file push->pull offline and report byte fidelity " +
      "(spec §4.5/§18.3 — the precondition for `enable-two-way`). Every file is checked and " +
      "reported, but the exit code only fails on SYNC-ELIGIBLE files: wikiDir (from config) " +
      "counts automatically, and --eligible names any other vault-path prefixes that must " +
      "pass (desk dirs land in a later phase). With no wiki config and no --eligible, nothing " +
      "is eligible and the command always exits 0 — pure report mode.",
    )
    .option(
      "--vault <path>",
      "vault root to scan — overrides config vaultPath (runs without a box config); " +
      "skips config load entirely, so wikiDir auto-eligibility does not apply unless --eligible is also given",
    )
    .option("--eligible <prefixes>", "comma-separated vault-path prefixes whose failures must fail the command")
    .option("--json <path>", "write the full per-file report as JSON to this path")
    .option("--record", "persist pass/fail verdicts into notion_sync_fidelity (needs the state database)", false)
    .action(async (opts: { vault?: string; eligible?: string; json?: string; record: boolean }) => {
      let vaultPath: string;
      const eligiblePrefixes: string[] = [];
      if (opts.vault !== undefined) {
        vaultPath = opts.vault;
      } else {
        const cfg = loadNotionSyncConfig();
        vaultPath = cfg.vaultPath;
        // Every synced directory is eligible the moment it is configured — the
        // wiki mirror and every desk folder alike. A desk folder's files are the
        // ones `enable-two-way` will consult this table about, so a failure there
        // has to fail the command rather than read as a stress-test curiosity.
        eligiblePrefixes.push(...syncDirPrefixes(cfg));
      }
      if (opts.eligible !== undefined) {
        for (const raw of opts.eligible.split(",")) {
          const trimmed = raw.trim();
          if (trimmed === "") continue;
          eligiblePrefixes.push(trimmed.endsWith("/") ? trimmed : `${trimmed}/`);
        }
      }

      const { failed, eligibleFailedCount, summary, result } = await runFidelityOnce({
        vaultPath, eligiblePrefixes, record: opts.record,
      });
      console.log(summary);
      for (const f of failed) {
        console.log(`  ${f.eligible ? "[eligible]" : "[report-only]"} ${f.path}: ${f.reason}`);
      }
      if (failed.some((f) => f.reason.includes("origin"))) {
        console.log(
          "  fix: run `notion-sync fidelity`, then add `lares_origin:` to the named files.",
        );
      }

      if (opts.json !== undefined) {
        writeFileSync(opts.json, JSON.stringify(result.report, null, 2));
      }

      if (eligibleFailedCount > 0) process.exitCode = 1;
    });

  cmd
    .command("status")
    .description("Show resolved config and row counts by state")
    .action(async () => {
      const cfg = loadNotionSyncConfig();
      console.log(`Notion version:  ${cfg.notionVersion}`);
      console.log(`Meetings source: ${cfg.meetingsDataSourceId}`);
      console.log(`Docs source:     ${
        cfg.wiki === undefined
          ? "(not configured — wiki pass skips)"
          : `${cfg.wiki.docsDataSourceId} (wikiDir ${cfg.wiki.wikiDir})`
      }`);
      console.log(`Desk dirs:       ${
        cfg.desks === undefined
          ? "(not configured — the desk push skips)"
          : cfg.desks.deskDirs.map((d) => `${d.dir} → ${d.project}`).join(", ")
      }`);
      console.log(`Two-way dirs:    ${
        cfg.desks === undefined || cfg.desks.twoWayDirs.length === 0
          ? "(none — every row stays 🔒 Mirror)"
          : cfg.desks.twoWayDirs.join(", ")
      }`);
      console.log(`Vault:           ${cfg.vaultPath}`);
      console.log(`Projects:        ${cfg.projects.map((p) => p.notionProject).join(", ")}`);
      const pool = poolFromEnv();
      try {
        const counts = await countByState(pool);
        console.log(
          `Rows:            ${counts.synced} synced, ${counts.unmatched} unmatched, ` +
          `${counts.retrying} retrying, ${counts.frozen} frozen, ${counts.error} error`,
        );
      } finally {
        await pool.end();
      }
    });

  cmd
    .command("proposals")
    .description("List open Notion→vault edits awaiting approve/reject (spec §18.4)")
    .action(async () => {
      const rows = await listOpenProposals();
      if (rows.length === 0) {
        console.log("notion-sync: no open proposals");
        return;
      }
      for (const row of rows) {
        console.log(
          `#${row.id}  ${row.vaultPath}  [${row.state}]  ${formatAge(Date.now() - row.createdAt.getTime())} old`,
        );
        for (const line of row.diff.split("\n")) console.log(`    ${line}`);
      }
    });

  // Both messages come from the SHARED consequence functions (@lares/agent-box), like
  // Saga's DM, her hand, the Telegram button reply and the console card. The
  // `.description()` strings above them cannot: commander registers them at startup,
  // with no row in hand, so they describe the whole space instead of one outcome —
  // which is exactly why the old "the engine reverts Notion on its next tick" was
  // wrong for two of the three.
  cmd
    .command("approve <path>")
    .description("Approve the open proposal for <path> — the engine carries it out on its next tick")
    .action(async (path: string) => {
      const row = await approveProposal(path);
      console.log(`notion-sync: approved ${path} — ${approveConsequence(row)}`);
    });

  cmd
    .command("reject <path>")
    .description(
      "Reject the open proposal for <path>. What that means depends on the row: an ordinary " +
      "edit reverts the Notion page from the vault, a Notion-owned document writes nothing on " +
      "either side, and a create is simply not created. The engine acts on its next tick.",
    )
    .action(async (path: string) => {
      const row = await rejectProposal(path);
      console.log(`notion-sync: rejected ${path} — ${rejectConsequence(row)}`);
    });

  cmd
    .command("resolve <path>")
    .description("Resolve a frozen row by choosing which side wins (spec §6)")
    .requiredOption("--keep <side>", "md | notion")
    .action(async (path: string, opts: { keep: string }) => {
      if (opts.keep !== "md" && opts.keep !== "notion") {
        throw new Error(`--keep must be "md" or "notion", got "${opts.keep}"`);
      }
      console.log(await resolveFrozenDoc(path, opts.keep));
    });
}
