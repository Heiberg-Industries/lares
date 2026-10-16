// Vendor-neutral orchestration of the wiki one-way md→Notion pass (Phase 2 plan,
// T4): every side effect arrives as an injected dep, mirroring run.ts. The pass is
// idempotent-by-construction — change detection is sha256 of the RENDERED outputs
// (plan decision 1; body plus the prop-bearing fields, see wikiRenderHash), the
// resolver is a pure function of the store snapshot (plan decision 2), so the
// first live pass IS the backfill and steady state is a no-op.
import { createHash } from "node:crypto";
import {
  renderWikiPage, assertPushSafe, assertPushSafeSource,
  type RenderedWikiPage, type ResolvedWikiLink,
} from "./translate.js";
import type { DocRow, DocSyncedInput } from "./store.js";

/**
 * Structural twin of the adapter's DocPageProps, defined here so the pure engine
 * never imports from adapters/ — the composition root (cli.ts) hands the same
 * shape to the Notion client, and TypeScript's structural typing keeps the two
 * honest without a shared import.
 */
export interface WikiDocProps {
  name: string;
  project: string;
  folder: string;
  vaultPath: string;
  frontmatter: string;
  archived: boolean;
  /**
   * The desk/mirror stamp (Phase 3, spec §18.1) — the `Sync` select property,
   * added to the Docs DB by hand at deploy. Optional and opaque here: the engine
   * never decides its value, it only carries whatever `opts.syncProp` returns for
   * the row, so no direction vocabulary leaks into this pure pass.
   */
  sync?: string;
}

/** What the adoption guard needs from a remote Docs row — adapter shape, engine vocabulary. */
export interface RemoteDocRow {
  pageId: string;
  lastEditedTime: string;
  /** The join key back to the vault — "" when the row was created by hand. */
  vaultPath: string;
}

export interface WikiSyncDeps {
  /** Relative paths under wikiDir (the engine sorts them for determinism). */
  listWikiFiles: () => Promise<string[]>;
  readWikiFile: (relPath: string) => Promise<string>;
  getDocRows: () => Promise<Map<string, DocRow>>;
  /** Remote Docs rows — only consulted by the adoption guard on an empty store. */
  queryDocs: () => Promise<RemoteDocRow[]>;
  createDocPage: (props: WikiDocProps, markdown: string) => Promise<{ pageId: string }>;
  patchPageMarkdown: (pageId: string, markdown: string) => Promise<void>;
  updateDocProps: (pageId: string, props: Partial<WikiDocProps>) => Promise<void>;
  getPageMarkdown: (pageId: string) => Promise<string>;
  upsertDocSynced: (doc: DocSyncedInput) => Promise<void>;
  recordDocError: (vaultPath: string, message: string) => Promise<void>;
  markDocOrphaned: (vaultPath: string, reason: string) => Promise<void>;
}

export interface WikiSyncOptions {
  /** Vault-relative wiki directory ("wiki") — prefixes vault_path and Folder. Config, never code. */
  wikiDir: string;
  /** The Notion `Project` select value every wiki row carries. Config, never code. */
  project: string;
  dryRun: boolean;
  /**
   * Process only the first N sorted files (scratch testing). A limited run skips
   * the archive step entirely: a truncated listing cannot prove a file is absent.
   */
  limit?: number;
  /**
   * The `Sync` stamp for a given vault path (Phase 3, spec §18.1), sent on every
   * create and re-asserted on every property refresh so a patched row can never
   * lose it. Injected because the value is a function of the row's CURRENT
   * direction, and direction is store state this pass deliberately does not read
   * (it takes {pageId, mdHash, state} and nothing more — see store.ts getDocRows).
   * Absent ⇒ the property is omitted entirely, which is Phase 2's behaviour and
   * leaves whatever Notion already holds untouched (a partial PATCH never clears
   * an unsent property).
   */
  syncProp?: (vaultPath: string) => string | undefined;
  /**
   * Vault paths this pass must not write, because a human decision about them is
   * still open (a pending or approved proposal). The composition root reads the
   * open proposals once per pass and hands them in; absent ⇒ nothing is held back,
   * which is the wiki mirror's case (a mirror row never carries a proposal).
   *
   * The generalisation of the frozen skip above it (final review, round 3): this
   * engine is direction-blind and proposal-blind — it re-patches anything whose
   * render no longer matches the stored hash — so a vault edit made while a
   * proposal waits would push the vault's newer text over the exact Notion
   * content the proposal references, before the human ever ruled on it. Pull
   * cannot catch that one: `resolve` stamps the row's hashes on the way out, so
   * pull's `unchanged` branch (correctly) sees nothing to react to. The push is
   * therefore where the rule belongs — push never races an open decision.
   */
  skipVaultPaths?: ReadonlySet<string>;
  /**
   * Vault paths NOTION owns — rows whose direction is `notion_to_md` (Phase 4).
   * This pass must not write Notion for any of them, ever: not a patch, not a
   * create, not the Archived=true sweep at the end. The vault file is a projection
   * of the Notion page, so pushing it back is the projection overwriting its own
   * source.
   *
   * Separate from `skipVaultPaths`, though both mean "do not write", because the
   * two are different facts about a row and reporting them as one would mislead an
   * operator: `skipVaultPaths` is TRANSIENT (a decision is open; the write lands
   * once it is made) while this is PERMANENT until an explicit direction change.
   * They also disagree in the archive sweep — a held-back path is archived on a
   * later tick, a Notion-owned one never is.
   *
   * A set rather than a direction lookup because this engine is deliberately
   * direction-blind: it takes `{pageId, mdHash, state}` and nothing more
   * (store.ts getDocRows), and the same reasoning that keeps `syncProp` injected
   * keeps the vocabulary out of here. The composition root already reads the desk
   * rows once per pass and derives it (`notionOwnedPaths`, direction.ts).
   *
   * Absent ⇒ nothing is held back, which is the wiki mirror pass's case: a mirror
   * dir has no Notion-owned rows by definition.
   */
  readOnlyVaultPaths?: ReadonlySet<string>;
  /**
   * Vault paths inside this dir that config has carved OUT of it (Phase 4,
   * `deskDirs[].exclude` — pass `makeDeskExclusion(cfg.desks)`). Absent ⇒ nothing
   * is carved out, which is the wiki mirror's case and every caller's behaviour
   * before this option existed.
   *
   * The row-side half of the same carve-out the file listing already applies
   * (adapters/vault-files.ts), and it is NOT redundant with it — it is the half
   * that stops the pruning from being read as a deletion. This engine's three
   * "is this path mine" questions are answered from two different sources: the
   * FILES it was handed, and the ROWS/remote pages it reads. Prune only the
   * files and the other two conclude the opposite: the archive step reads a
   * newly-excluded path as "file missing from vault" and retires a page nobody
   * deleted (Archived=true plus an orphan flag, on every excluded row, on the
   * first tick after the exclusion ships), and the adoption guard re-adopts the
   * disowned pages whenever a dir's remaining rows are all excluded ones.
   */
  isExcluded?: (vaultPath: string) => boolean;
}

export interface WikiSyncResult {
  scanned: number;
  created: number;
  patched: number;
  skipped: number;
  archived: number;
  errored: number;
  /**
   * Rows this pass declined to touch because they are frozen (spec §6). Counted
   * separately from `skipped`, which means "already in step" — a frozen row is
   * the opposite: known to be out of step, and deliberately left that way until a
   * human runs `notion-sync resolve`.
   */
  frozen: number;
  /**
   * Rows this pass declined to touch because an open proposal (pending or
   * approved) still references what Notion holds — see `skipVaultPaths`. Counted
   * apart from `frozen` because the row is perfectly healthy: it is waiting on a
   * human, not on a repair.
   */
  awaitingApproval: number;
  /**
   * Rows this pass left alone because NOTION owns them (`readOnlyVaultPaths`).
   * Counted apart from `awaitingApproval` because nothing is pending: this is the
   * steady state for a one-way Notion→vault document, not a wait.
   */
  notionOwned: number;
  /**
   * Writes whose Notion outcome could not be recorded locally — same containment
   * class as the attendee pass (see run.ts). For a CREATE this drift is the one
   * that cannot self-heal: a page without a row means the next tick creates a
   * duplicate. A non-zero value must fail the command.
   */
  bookkeepingFailed: number;
  summary: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The change-detection hash covers everything a write sends that the VAULT can
 * change: the rendered body plus the prop-bearing outputs (title, frontmatter).
 * Hashing the markdown alone makes a frontmatter-only or title-only edit a
 * permanent silent drop — translate.ts strips frontmatter from the body, so the
 * render stays byte-identical, the row skips every tick, and the Notion
 * Name/Frontmatter properties never catch up ("heals on the next body change"
 * never comes for a page that only got retitled). Folder is derived from the
 * path (a rename is a new vault_path — a create plus an archive, not a patch)
 * and Project is config, so neither belongs here. NUL separators keep the three
 * fields unambiguous; no vault content can forge a boundary.
 */
export function wikiRenderHash(
  rendered: Pick<RenderedWikiPage, "markdown" | "title" | "frontmatter">,
): string {
  return sha256(`${rendered.markdown}\u0000${rendered.title}\u0000${rendered.frontmatter}`);
}

/** The store keeps page ids; mentions need URLs. Notion's canonical short form. */
export function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

/**
 * Same containment as run.ts's tryRecord, keyed by vault path: a bookkeeping
 * write failure is logged and counted, never allowed to abort the run or be
 * misfiled as a Notion failure. See run.ts for the full rationale — the split
 * between contained partial failure and loud total failure is identical here.
 */
async function tryRecord(what: string, vaultPath: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`notion-sync: bookkeeping write failed (${what}) for ${vaultPath}: ${message}`);
    return false;
  }
}

/**
 * Reconciliation guard (plan T4, spec §12 spirit): a store with ZERO doc rows in
 * front of a populated Docs database is a recovery scenario, not a cold start —
 * creating would duplicate every page. Remote rows are adopted into the in-memory
 * map by Vault Path with an empty hash (the post-create pin's sentinel — never
 * equal to a real render), so every matching file takes the patch path. Rows
 * without a Vault Path (hand-made pages) and rows outside wikiDir (other passes'
 * documents) are never ours to touch.
 *
 * The adopted entries are RETURNED so the caller can pin them into the store
 * before doing anything else. An adopted row that lives only in this run's
 * memory is a trap: recordDocError and markDocOrphaned are UPDATEs by design
 * (see store.ts), so against a row the store never saw they match zero rows and
 * the flag silently vanishes — the archive path would set Archived in Notion
 * yet record no state, and the file's later return would CREATE a duplicate,
 * the exact outcome adoption exists to prevent. Pinning everything up front
 * also makes a crash mid-recovery safe: the store is non-empty from the first
 * pin on, so a rerun skips adoption — any row not yet persisted would be
 * invisible to it and duplicate on the next create.
 */
async function adoptRemoteRows(
  wikiDir: string,
  rows: Map<string, DocRow>,
  deps: WikiSyncDeps,
  isExcluded: (vaultPath: string) => boolean,
): Promise<Array<[vaultPath: string, row: DocRow]>> {
  const best = new Map<string, RemoteDocRow>();
  for (const remote of await deps.queryDocs()) {
    if (remote.vaultPath === "" || !remote.vaultPath.startsWith(`${wikiDir}/`)) continue;
    // A page under a carved-out sub-path is not this dir's to adopt — adopting it
    // would pin a store row for a path this pass has been told to ignore, and the
    // archive step below would then retire the page it just claimed.
    if (isExcluded(remote.vaultPath)) continue;
    const current = best.get(remote.vaultPath);
    if (current !== undefined) {
      // Two pages claim the same file. Adopt the most recently edited (ties broken
      // by page id, so re-runs pick the same one); the loser is left alone —
      // never-delete posture — for a human to remove.
      console.error(
        `notion-sync: two Notion pages claim vault path ${remote.vaultPath} ` +
        `(${current.pageId}, ${remote.pageId}) — adopting the most recently edited`,
      );
      const newer =
        remote.lastEditedTime > current.lastEditedTime ||
        (remote.lastEditedTime === current.lastEditedTime && remote.pageId > current.pageId);
      if (!newer) continue;
    }
    best.set(remote.vaultPath, remote);
  }
  const adopted: Array<[vaultPath: string, row: DocRow]> = [];
  for (const [vaultPath, remote] of [...best].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const row: DocRow = { pageId: remote.pageId, mdHash: "", state: "synced" };
    rows.set(vaultPath, row);
    adopted.push([vaultPath, row]);
  }
  return adopted;
}

export async function runWikiSync(opts: WikiSyncOptions, deps: WikiSyncDeps): Promise<WikiSyncResult> {
  const listed = [...await deps.listWikiFiles()].sort();
  const rows = await deps.getDocRows();
  const isExcluded = opts.isExcluded ?? (() => false);

  // Both recovery guards below ask about THIS dir, not the whole table. Since
  // Phase 3 the same engine runs once per desk folder over one shared `docs` table
  // (cli.ts syncDeskPushOnce), and counting every row would break both of them:
  // one populated folder would mask another folder's cold start — adoption
  // skipped, every existing page duplicated, the exact outcome adoption exists to
  // prevent — and one folder's rows would turn another folder's legitimately
  // empty listing into a hard failure.
  //
  // "This dir" means the dir MINUS whatever config carved out of it (Phase 4):
  // the listing these two guards are weighed against no longer contains excluded
  // files, so counting their rows would compare two different scopes.
  const rowsInDir = [...rows.keys()]
    .filter((path) => path.startsWith(`${opts.wikiDir}/`) && !isExcluded(path)).length;

  const adopted = rowsInDir === 0 ? await adoptRemoteRows(opts.wikiDir, rows, deps, isExcluded) : [];

  // An empty listing while rows exist (locally or just adopted) is never a
  // legitimate "vault emptied" state — it is what a missing /srv/brain mount or a
  // wikiDir typo produces. Fail loudly instead of archiving every page; the same
  // posture as run.ts's empty-calendar guard.
  if (listed.length === 0 && rowsInDir + adopted.length > 0) {
    throw new Error(
      `notion-sync: listing returned 0 files under ${opts.wikiDir} while ` +
      `${rowsInDir + adopted.length} doc row(s) exist there — refusing to archive them all; ` +
      `check the vault mount and the configured directory before re-running`,
    );
  }

  const files = opts.limit === undefined ? listed : listed.slice(0, opts.limit);

  let created = 0;
  let patched = 0;
  let skipped = 0;
  let archived = 0;
  let errored = 0;
  let frozen = 0;
  let awaitingApproval = 0;
  let notionOwned = 0;
  let bookkeepingFailed = 0;

  // Pin every adopted row into the store BEFORE any Notion write — see
  // adoptRemoteRows for why a memory-only row is a duplicate-maker. All adopted
  // rows are pinned, even ones `limit` keeps out of this run's file loop: the
  // pin is recovery state, not a Notion write. A failed pin recreates exactly
  // the memory-only trap, so it counts as bookkeepingFailed (contained, loud,
  // fails the command) even though the row's own patch may still heal it below.
  if (!opts.dryRun) {
    for (const [vaultPath, row] of adopted) {
      if (!await tryRecord("adopt", vaultPath, () => deps.upsertDocSynced({
        vaultPath, pageId: row.pageId, mdHash: "", notionHash: "", notionLastEdited: null,
      }))) {
        bookkeepingFailed += 1;
      }
    }
  }

  // Read everything up front: the resolver needs every target's title before the
  // first file renders. A failed read is contained per doc in the main loop — and
  // deliberately keeps the file out of the archive step, because a failed read and
  // a deletion look identical (spec §7) and only one of them may flag anything.
  const sources = new Map<string, string>();
  const readErrors = new Map<string, string>();
  for (const relPath of files) {
    try {
      sources.set(relPath, await deps.readWikiFile(relPath));
    } catch (err) {
      readErrors.set(relPath, err instanceof Error ? err.message : String(err));
    }
  }

  // Titles come from a resolver-free render: a page's title never depends on link
  // resolution (frontmatter → H1 → stem), which is what breaks the circularity of
  // "rendering a needs b's title, rendering b needs a's title".
  const titles = new Map<string, string>();
  for (const [relPath, source] of sources) {
    try {
      titles.set(relPath, renderWikiPage(source, { path: relPath, resolve: () => null }).title);
    } catch {
      // The main loop re-renders and contains the same failure per doc.
    }
  }

  // The resolver is a SNAPSHOT of the store as of this tick's start — pages created
  // later in this same run stay unresolved until the next tick. That keeps every
  // render a pure function of (vault content, store snapshot), which the
  // hash-of-render convergence argument depends on (plan decision 2): pass 1
  // escapes, pass 2 linkifies exactly the files whose render changed, pass 3 no-ops.
  const resolve = buildResolver(opts.wikiDir, rows, titles);

  // Per-document, not per-run: a failure on one file must not discard the files
  // already applied, and the next tick resumes from what is left (spec §2). The
  // client's own throttle is the rate limiter; the loop stays sequential.
  for (const relPath of files) {
    const vaultPath = `${opts.wikiDir}/${relPath}`;
    const row = rows.get(vaultPath);

    // A frozen row is written to on NEITHER side until a human resolves it (spec
    // §6). Checked before everything else, including the read-failure path, for
    // two reasons: the revival logic below re-pushes any non-'synced' row
    // WHOLESALE (see the state check further down), which here would overwrite
    // the very Notion content the human is being asked to judge; and
    // recordDocError on a frozen row would count strikes toward state='error',
    // silently destroying the freeze the conflict created.
    if (row !== undefined && row.state === "frozen") {
      frozen += 1;
      continue;
    }

    // The same rule, one step earlier in the story: a row whose Notion content a
    // human is still judging gets no write either (spec §18.4). Checked here, in
    // the same place and for the same reason as the freeze — before the read, the
    // render and any Notion call — because the write this prevents is precisely
    // the wholesale patch below, and it would land on the content the open
    // proposal was raised about.
    if (opts.skipVaultPaths?.has(vaultPath) === true) {
      awaitingApproval += 1;
      console.log(
        `notion-sync: ${vaultPath} not pushed — an open proposal is awaiting a decision`,
      );
      continue;
    }

    // …and the permanent version of the same rule (Phase 4): NOTION owns this
    // document, so the vault file is its projection and pushing it back is the
    // projection overwriting its own source. Checked in the same place and for the
    // same reason as the two skips above — before the read, the render and any
    // Notion call — because the write it prevents is the wholesale patch below.
    //
    // This is the load-bearing half of `notion_to_md` on the push side. Without it
    // the direction is decorative: a local edit to a Notion-authored file (Obsidian
    // on the phone, a fleet writer, a git pull) makes the render disagree with
    // md_hash, and this pass would faithfully patch Notion with it — a silent
    // md→Notion write for a document declared one-way the other way.
    if (opts.readOnlyVaultPaths?.has(vaultPath) === true) {
      notionOwned += 1;
      console.log(
        `notion-sync: ${vaultPath} not pushed — Notion owns this document (direction notion_to_md)`,
      );
      continue;
    }

    const source = sources.get(relPath);
    if (source === undefined) {
      errored += 1;
      const message = readErrors.get(relPath) ?? "unreadable";
      console.error(`notion-sync: wiki read failed for ${vaultPath}: ${message}`);
      if (!opts.dryRun && row !== undefined) {
        if (!await tryRecord("error", vaultPath, () => deps.recordDocError(vaultPath, message))) {
          bookkeepingFailed += 1;
        }
      }
      continue;
    }

    let rendered: RenderedWikiPage;
    let mdHash: string;
    try {
      // The SOURCE-side lint, before anything is rendered (Phase 4): a file carrying
      // a live <transcript> block is a meeting transcript, and transcripts are
      // one-way Notion→vault permanently (§17.2). Escaping does not make it
      // pushable, so unlike the two tags below this one has to be asked of the raw
      // bytes — after `renderWikiPage` the block is an inert `\<transcript>` and
      // indistinguishable from prose. Ordinarily nothing gets this far (the push is
      // handed a hold-back set covering every path a non-docs row owns, and config
      // carves the folder out of the listing); this is what holds when neither did.
      assertPushSafeSource(source);
      rendered = renderWikiPage(source, { path: relPath, resolve });
      // The spec §4.3 lint, on EVERY outbound body. A vault file carrying a live
      // <page/<database (e.g. inside a code fence) lands here every tick and, with
      // a row, walks the 3-strike path to 'error' — permanently, by design.
      assertPushSafe(rendered.markdown);
      mdHash = wikiRenderHash(rendered);
    } catch (err) {
      errored += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`notion-sync: render failed for ${vaultPath}: ${message}`);
      if (!opts.dryRun && row !== undefined) {
        if (!await tryRecord("error", vaultPath, () => deps.recordDocError(vaultPath, message))) {
          bookkeepingFailed += 1;
        }
      }
      // No row (pre-create failure): summary-only, per the T3 decision — a missing
      // row means "create", so the file naturally retries next tick.
      continue;
    }

    // The stored hash is only trusted on a row in state 'synced'. A flagged row is
    // re-pushed wholesale even when the hash matches: 'unmatched' means the Notion
    // row sits Archived and a returned file must revive it (clear the checkbox,
    // reset the state); 'error' means the last cycle never completed. Both heal
    // through the ordinary patch path rather than a special case.
    if (row !== undefined && row.state === "synced" && row.mdHash === mdHash) {
      skipped += 1;
      continue;
    }

    // Fidelity notes (H5/H6 collapse, unknown callouts, code-span joins) surface
    // only when the doc is actually (re)written — warning 457 times per tick about
    // files that skip would bury the log.
    for (const warning of rendered.warnings) {
      console.warn(`notion-sync: ${vaultPath}: ${warning}`);
    }

    const sync = opts.syncProp?.(vaultPath);
    const props: WikiDocProps = {
      name: rendered.title,
      project: opts.project,
      folder: rendered.folderHint === undefined
        ? opts.wikiDir
        : `${opts.wikiDir}/${rendered.folderHint}`,
      vaultPath,
      frontmatter: rendered.frontmatter,
      archived: false,
      ...(sync === undefined ? {} : { sync }),
    };

    if (opts.dryRun) {
      if (row === undefined) created += 1;
      else patched += 1;
      continue;
    }

    let pageId: string;
    if (row === undefined) {
      try {
        pageId = (await deps.createDocPage(props, rendered.markdown)).pageId;
      } catch (err) {
        errored += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`notion-sync: create failed for ${vaultPath}: ${message}`);
        continue; // Pre-create: summary-only, retries next tick (no row = "create").
      }
      created += 1;
    } else {
      pageId = row.pageId;
      try {
        await deps.patchPageMarkdown(pageId, rendered.markdown);
        // Full property refresh, not just the body: the change hash covers title
        // and frontmatter too (wikiRenderHash), so this write is what carries a
        // prop-only edit through. archived:false is also the revive path's
        // un-archive.
        await deps.updateDocProps(pageId, props);
      } catch (err) {
        errored += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`notion-sync: patch failed for ${vaultPath}: ${message}`);
        if (!await tryRecord("error", vaultPath, () => deps.recordDocError(vaultPath, message))) {
          bookkeepingFailed += 1;
        }
        continue;
      }
      patched += 1;
    }

    // Hash-after-write — the sole defence against the sync conflicting with itself
    // (spec §3): re-read what Notion actually stored and hash THAT, never the body
    // we pushed. The ordering write → read-back → upsert is load-bearing.
    let notionMarkdown: string;
    try {
      notionMarkdown = await deps.getPageMarkdown(pageId);
    } catch (err) {
      errored += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`notion-sync: hash-after-write read failed for ${vaultPath}: ${message}`);
      if (row === undefined) {
        // The page EXISTS but nothing records it yet — losing the id here is the
        // one drift that duplicates the page next tick. Pin it with empty hashes:
        // "" never matches a real render, so the next tick re-patches this same
        // page and re-attempts the verification read.
        const pinned = await tryRecord("pin", vaultPath, () => deps.upsertDocSynced({
          vaultPath, pageId, mdHash: "", notionHash: "", notionLastEdited: null,
        }));
        if (!pinned) {
          bookkeepingFailed += 1;
          console.error(
            `notion-sync: page ${pageId} for ${vaultPath} was created but could NOT be ` +
            `recorded — the next run will create a duplicate unless this is resolved`,
          );
          continue;
        }
      }
      // For a patch, deliberately NO upsert: the stored hash stays stale, which
      // forces a clean re-patch + read-back next tick. Self-healing.
      if (!await tryRecord("error", vaultPath, () => deps.recordDocError(vaultPath, message))) {
        bookkeepingFailed += 1;
      }
      continue;
    }

    // notion_last_edited stays null: this one-way pass never reads it back, and
    // Phase 3's conflict detection will populate it from its own queries. Writing
    // a value we did not observe would be a guess dressed as a watermark.
    const recorded = await tryRecord("synced", vaultPath, () => deps.upsertDocSynced({
      vaultPath, pageId, mdHash, notionHash: sha256(notionMarkdown), notionLastEdited: null,
    }));
    if (!recorded) {
      bookkeepingFailed += 1;
      if (row === undefined) {
        console.error(
          `notion-sync: page ${pageId} for ${vaultPath} was created but could NOT be ` +
          `recorded — the next run will create a duplicate unless this is resolved`,
        );
      }
    }
  }

  // Freeze-and-flag for vanished files (spec §7): Archived=true on the Notion row,
  // 'unmatched' on the state row, nothing deleted anywhere — and only once, so an
  // already-flagged row stays quiet. Scoped to wikiDir: other passes' docs rows
  // share target='docs' from Phase 3 on and are never this pass's to archive.
  if (opts.limit === undefined) {
    const listedPaths = new Set(files.map((relPath) => `${opts.wikiDir}/${relPath}`));
    for (const [vaultPath, row] of rows) {
      if (!vaultPath.startsWith(`${opts.wikiDir}/`)) continue;
      // A carved-out path is absent from `listedPaths` BY CONFIG, not because the
      // file went away (Phase 4) — the vault file is right there. Archiving it
      // would write "file missing from vault" about a file that exists and retire
      // a page on a premise that is simply untrue. Whatever should happen to the
      // rows an exclusion leaves behind is a deliberate, one-off decision, never a
      // side effect of the sweep that runs every tick.
      if (isExcluded(vaultPath)) continue;
      if (listedPaths.has(vaultPath)) continue;
      if (row.state === "unmatched") continue;
      // Same rule as the main loop: a frozen row gets no write of any kind, and
      // Archived=true is a write. The conflict outranks the archive — a human's
      // `resolve` returns the row to 'synced', and the next tick archives it then
      // if the file is still gone.
      if (row.state === "frozen") continue;
      // …and the same for a row with an open proposal: Archived=true is a write,
      // and archiving a page a human is mid-decision on would retire the very
      // content they are judging. The next tick archives it once the decision is
      // made and the file is still gone.
      if (opts.skipVaultPaths?.has(vaultPath) === true) {
        awaitingApproval += 1;
        continue;
      }
      // Archived=true is a Notion write, and for a Notion-owned row the vault has
      // no standing to make it: the file is a projection, and a projection going
      // missing says nothing about whether its source should be retired. The
      // opposite direction is the one that is real, and pull already implements it
      // — page trashed in Notion ⇒ the vault file moves to `_archive/`
      // (handleMissingPage). Permanent, so unlike the skip above this row is never
      // archived on a later tick.
      if (opts.readOnlyVaultPaths?.has(vaultPath) === true) {
        notionOwned += 1;
        continue;
      }
      if (opts.dryRun) {
        archived += 1;
        continue;
      }
      try {
        await deps.updateDocProps(row.pageId, { archived: true });
      } catch (err) {
        errored += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`notion-sync: archive failed for ${vaultPath}: ${message}`);
        if (!await tryRecord("error", vaultPath, () => deps.recordDocError(vaultPath, message))) {
          bookkeepingFailed += 1;
        }
        continue;
      }
      archived += 1;
      // Notion already carries the flag at this point; like the create/patch path,
      // a bookkeeping failure here is contained and counted, never re-thrown.
      if (!await tryRecord("orphaned", vaultPath, () =>
        deps.markDocOrphaned(vaultPath, "file missing from vault"))) {
        bookkeepingFailed += 1;
      }
    }
  }

  return {
    scanned: files.length,
    created,
    patched,
    skipped,
    archived,
    errored,
    frozen,
    awaitingApproval,
    notionOwned,
    bookkeepingFailed,
    summary:
      `${created} created, ${patched} patched, ${skipped} skipped, ${archived} archived, ` +
      `${errored} errored, ${frozen} frozen, ${awaitingApproval} awaiting approval, ` +
      `${notionOwned} notion-owned, ` +
      `${bookkeepingFailed} bookkeeping-failed, ` +
      `${files.length} scanned${opts.dryRun ? " (dry-run)" : ""}`,
  };
}

/**
 * Builds the deterministic wikilink resolver from (files present this tick,
 * their titles, the store snapshot). A target resolves only when BOTH exist: a
 * store row (the page id) and a readable file (the title) — an orphaned page is
 * mid-archive and has no business being mentioned.
 *
 * Matching, most to least specific, all case-sensitive:
 *   1. exact wikiDir-relative path ("people/jane"), also accepted with the
 *      wikiDir prefix ("wiki/people/jane") as written from the vault root;
 *   2. bare-stem match ("jane") when exactly ONE file carries that stem —
 *      Obsidian's shortest-path convention; an ambiguous stem stays an escaped
 *      literal rather than guessing.
 * A "#heading" suffix is dropped for matching; targets outside wikiDir (raw/,
 * project folders) fall through to null and render as escaped literals (§4.1).
 *
 * Exported (Phase 3, T7) rather than kept private: the pull/apply/resolve paths
 * render the SAME vault file to compare hashes against what this pass pushed, so
 * they must build the resolver from this exact function. A second implementation
 * that resolved one link differently would make every wikilinked desk file read
 * as "changed in both sides" forever — the resolver is an input to the render,
 * and the render IS the hash (plan decision 1). `rows` is narrowed to the one
 * field used, so the desk passes can pass their wider row type unchanged.
 */
export function buildResolver(
  wikiDir: string,
  rows: Map<string, Pick<DocRow, "pageId">>,
  titles: Map<string, string>,
): (target: string) => ResolvedWikiLink | null {
  const byPath = new Map<string, ResolvedWikiLink>();
  const byStem = new Map<string, ResolvedWikiLink[]>();
  for (const [relPath, title] of titles) {
    const row = rows.get(`${wikiDir}/${relPath}`);
    if (row === undefined) continue;
    const link: ResolvedWikiLink = { url: notionPageUrl(row.pageId), title };
    const key = relPath.replace(/\.md$/i, "");
    byPath.set(key, link);
    const stem = key.split("/").pop() ?? key;
    const stems = byStem.get(stem);
    if (stems === undefined) byStem.set(stem, [link]);
    else stems.push(link);
  }
  return (target) => {
    let t = target.split("#")[0].trim();
    if (t.startsWith(`${wikiDir}/`)) t = t.slice(wikiDir.length + 1);
    if (t === "") return null;
    const exact = byPath.get(t);
    if (exact !== undefined) return exact;
    if (t.includes("/")) return null;
    const stems = byStem.get(t);
    return stems !== undefined && stems.length === 1 ? stems[0] : null;
  };
}
