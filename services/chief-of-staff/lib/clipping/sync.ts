/**
 * One clipping pass for one source (LAR-113): read what changed in Notion, bring new links
 * into `_inbox`, keep the ledger, apply edits and trashes ONLY to clips still waiting in the
 * inbox. No model call anywhere in here.
 *
 * ORDER MATTERS. The inbox file is written BEFORE the ledger row, and its path is derived from
 * the source id and page id, so a crash between the two rewrites the same file on the next pass
 * and never makes a second one. An item the ledger calls `imported` therefore always had its
 * file written; if the file is gone later, the digest filed it (or the owner removed it) and the
 * ledger moves it to `filed-unknown`, after which the vault is the truth and sync never touches it.
 *
 * WATERMARK. Moves only when the whole pass succeeded. On any failure nothing is committed to the
 * source row except the failed outcome; the pages already written are safe to re-read.
 */


import { clipInboxPath, mapPageToClip, renderClipNote, type MappedPage } from "./record.js";
import {
  ClippingFailure, MAX_TRASH_CHECKS, OVERLAP_MS, isPageGone, queryChangedPages, readSchema,
  type NotionLike,
} from "./notion-reader.js";
import {
  emptyCounts, findDuplicate, getItem, listWaiting, markChecked, putItem, setItemState, type Queryable,
  type Counts, type SourceRow,
} from "./store.js";

/** The slice of the vault's `_inbox` the sync touches. */
export interface InboxPort {
  exists(relPath: string): boolean;
  write(relPath: string, body: string): Promise<void>;
  remove(relPath: string): Promise<void>;
}

export interface SyncDeps {
  db: Queryable;
  client: NotionLike;
  source: SourceRow;
  inbox: InboxPort;
  /** Test seams. */
  pageSize?: number;
  maxPages?: number;
  maxTrashChecks?: number;
}

export interface SyncResult {
  counts: Counts;
  warnings: string[];
  /** The watermark to commit, or null to leave it as it was. */
  watermark: Date | null;
  capped: boolean;
}

const revisionOf = (iso: string): Date => new Date(iso);

async function applyMapped(deps: SyncDeps, m: MappedPage, counts: Counts): Promise<void> {
  const { db, source, inbox } = deps;

  const itemId = m.kind === "clip" ? m.clip.sourceItemId : m.sourceItemId;
  const revision = m.kind === "clip" ? m.clip.sourceRevision : m.sourceRevision;
  const existing = await getItem(db, source.id, itemId);

  if (m.kind === "trashed") {
    if (existing?.state === "imported") await trashWaiting(deps, existing.sourceItemId, existing.inboxPath, counts);
    return;
  }

  const newer = !existing?.sourceRevision || revisionOf(revision) > existing.sourceRevision;

  if (m.kind === "skip") {
    // A clip already in the inbox that lost its link keeps its note; only record that we saw it.
    if (existing && existing.state !== "skipped" && existing.state !== "trashed") {
      if (newer) await setItemState(db, source.id, m.sourceItemId, existing.state, m.sourceRevision);
      return;
    }
    if (existing?.state === "skipped" && existing.skipReason === "no-link") {
      if (newer) await setItemState(db, source.id, m.sourceItemId, "skipped", m.sourceRevision);
      return;
    }
    await putItem(db, {
      sourceId: source.id, sourceItemId: m.sourceItemId, container: source.dataSourceId,
      owner: source.owner, visibility: source.visibility, urlKey: null,
      sourceRevision: m.sourceRevision, state: "skipped", skipReason: "no-link", inboxPath: null,
    });
    counts.skipped++;
    counts.noLink++;
    return;
  }

  const { clip } = m;
  const path = clipInboxPath(source.id, clip.sourceItemId);

  if (existing?.state === "imported") {
    if (!newer) return;
    if (inbox.exists(path)) {
      await inbox.write(path, renderClipNote(clip));
      await putItem(db, {
        sourceId: source.id, sourceItemId: clip.sourceItemId, container: clip.sourceContainer,
        owner: clip.owner, visibility: clip.visibility, urlKey: clip.urlKey,
        sourceRevision: clip.sourceRevision, state: "imported", inboxPath: path,
      });
      counts.updated++;
    } else {
      // Filed since we last looked: the vault is the truth now. Record, count, touch nothing.
      await setItemState(db, source.id, clip.sourceItemId, "filed-unknown", clip.sourceRevision);
      counts.editedAfterFiling++;
    }
    return;
  }

  if (existing?.state === "filed-unknown") {
    if (newer) {
      await setItemState(db, source.id, clip.sourceItemId, "filed-unknown", clip.sourceRevision);
      counts.editedAfterFiling++;
    }
    return;
  }

  // New, previously skipped (and edited), or restored from the trash: evaluate as an import.
  if (existing && existing.state === "skipped" && !newer) return;
  const dup = await findDuplicate(db, {
    owner: clip.owner, visibility: clip.visibility, urlKey: clip.urlKey,
    sourceId: source.id, sourceItemId: clip.sourceItemId,
  });
  if (dup) {
    if (existing?.state === "skipped" && existing.skipReason === "duplicate") {
      await setItemState(db, source.id, clip.sourceItemId, "skipped", clip.sourceRevision);
      return;
    }
    await putItem(db, {
      sourceId: source.id, sourceItemId: clip.sourceItemId, container: clip.sourceContainer,
      owner: clip.owner, visibility: clip.visibility, urlKey: clip.urlKey,
      sourceRevision: clip.sourceRevision, state: "skipped", skipReason: "duplicate", inboxPath: null,
    });
    counts.skipped++;
    counts.duplicates++;
    return;
  }
  await inbox.write(path, renderClipNote(clip)); // file first, ledger second
  await putItem(db, {
    sourceId: source.id, sourceItemId: clip.sourceItemId, container: clip.sourceContainer,
    owner: clip.owner, visibility: clip.visibility, urlKey: clip.urlKey,
    sourceRevision: clip.sourceRevision, state: "imported", inboxPath: path,
  });
  counts.imported++;
}

async function trashWaiting(deps: SyncDeps, itemId: string, inboxPath: string | null, counts: Counts): Promise<void> {
  const path = inboxPath ?? clipInboxPath(deps.source.id, itemId);
  // Still unfiled? Then the note goes. If it is already gone it was filed: leave the vault alone.
  if (deps.inbox.exists(path)) {
    await deps.inbox.remove(path);
    await setItemState(deps.db, deps.source.id, itemId, "trashed");
    counts.trashed++;
  } else {
    await setItemState(deps.db, deps.source.id, itemId, "filed-unknown");
  }
}

export async function runClippingSync(deps: SyncDeps): Promise<SyncResult> {
  const { db, client, source, inbox } = deps;
  const counts = emptyCounts();

  const { warnings } = await readSchema(client, source);

  // A pass that was cut short resumes exactly at the watermark; a complete one re-reads a little
  // behind it so an edit that landed late is not missed.
  const since = source.watermark
    ? new Date(source.watermark.getTime() - (source.watermarkCapped ? 0 : OVERLAP_MS))
    : null;

  const { pages, capped } = await queryChangedPages(client, source, since, {
    maxPages: deps.maxPages, pageSize: deps.pageSize,
  });

  for (const page of pages) {
    await applyMapped(deps, mapPageToClip(page as never, source), counts);
  }

  let watermark: Date | null = null;
  if (pages.length > 0) {
    const last = revisionOf((pages[pages.length - 1] as { last_edited_time: string }).last_edited_time);
    if (capped && since && last.getTime() <= since.getTime()) {
      // A whole capped pass inside one instant makes no progress; say so rather than loop forever.
      throw new ClippingFailure(
        "incomplete",
        "More changes than one pass can read arrived within a single minute.",
        "Nothing to do if this stops by itself; otherwise ask for help.",
      );
    }
    watermark = last;
  }

  // Clips still waiting in the inbox: filed ones drop out of the list, the rest are checked for
  // a trash, a bounded number per pass.
  const budget = deps.maxTrashChecks ?? MAX_TRASH_CHECKS;
  let checks = 0;
  for (const item of await listWaiting(db, source.id)) {
    const path = item.inboxPath ?? clipInboxPath(source.id, item.sourceItemId);
    if (!inbox.exists(path)) {
      await setItemState(db, source.id, item.sourceItemId, "filed-unknown");
      continue;
    }
    if (checks >= budget) continue;
    checks++;
    if (await isPageGone(client, item.sourceItemId)) {
      await trashWaiting(deps, item.sourceItemId, path, counts);
    } else {
      await markChecked(db, source.id, item.sourceItemId);
    }
  }

  return { counts, warnings, watermark, capped };
}
