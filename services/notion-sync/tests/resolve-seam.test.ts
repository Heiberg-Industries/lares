// `notion-sync resolve`, driven the way an operator actually drives it: through
// the real commands, against a real store, a real git vault and a fake Notion —
// and then through a WHOLE tick in the order the daemon runs it (pull → apply →
// push wiki → push desks).
//
// This is the seam no per-pass test could see (final review, C1). Each engine
// was individually right about a frozen row, and the loop still could not
// converge: pull runs FIRST and re-detected the same two-sided conflict that
// froze the row, push skips frozen rows so it never healed anything, and apply
// (once its state gate landed) will not write a frozen row either. Both resolve
// paths therefore have to be proven end-to-end — the command's own write, then
// the next tick leaving the row alone — or "resolve" is a button that does
// nothing.
//
// Same shared-world shape as reject-seam.test.ts, one layer lower: that file
// shares an in-memory world between two engines; this one shares a real
// container, a real vault clone and one fake Notion between every composition
// root a tick touches.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { startTestDb, type TestDb } from "@lares/agent-box/tests/helpers/pg.js";
import { makeNotionFetch, type FakeNotionState } from "./helpers/fake-notion.js";
import {
  resolveFrozenDoc, approveProposal, makeDocRender,
  syncPullOnce, syncApplyOnce, syncWikiOnce, syncDeskPushOnce,
} from "../lib/cli.js";
import { loadNotionSyncConfig } from "../lib/config.js";
import { upsertDocSynced, freezeDoc, getOpenProposals, getDeskRows } from "../lib/store.js";
import { docRenderHash } from "../lib/pull-sync.js";
import { sha256 } from "../lib/wiki-sync.js";

const DESK = "desks/orakel";
const PATH = `${DESK}/note.md`;
const FRONTMATTER = "---\ntitle: Note\n---\n";
/** The same block after an approved pull has written it: the file's own keys, verbatim,
 *  plus the one key the write's provenance decides (W4D-s2 — the body under it came
 *  from Notion, so the file says so). */
const STAMPED_FRONTMATTER = "---\nlares_origin: synced\ntitle: Note\n---\n";
/** The vault's side of the conflict: edited after the last successful sync. */
const VAULT_SOURCE = `${FRONTMATTER}\nvault body, edited after the last sync\n`;
/** Notion's side of the same conflict. */
const NOTION_BODY = "Notion's own version, typed in the app";
/** What the last pull actually saw — so both stored hashes are stale, as in a real freeze. */
const LAST_SEEN = "the body the last pull saw";

const WATERMARK = "2026-08-04T09:00:00.000Z";
const AFTER_WRITES = "2026-08-04T12:00:00.000Z";

let tdb: TestDb;
let db: Pool;
let root: string;
let vaultPath: string;
let prevEnv: Record<string, string | undefined>;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", vaultPath, ...args]).toString().trim();
}

beforeAll(async () => {
  tdb = await startTestDb();
  db = tdb.pool;

  // A real clone with a real remote: apply writes the vault through
  // makeVaultWriter, which takes the fleet's note lock and commits + pushes.
  // Faking that away would skip the half of the loop that touches the Brain.
  root = await mkdtemp(join(tmpdir(), "notion-sync-resolve-seam-"));
  const bare = join(root, "brain.git");
  vaultPath = join(root, "brain");
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  execFileSync("git", ["clone", "-q", bare, vaultPath]);
  git("config", "user.email", "sync@lares.test");
  git("config", "user.name", "notion-sync");
  await mkdir(join(vaultPath, DESK), { recursive: true });
  await mkdir(join(vaultPath, "wiki"), { recursive: true });

  const cfgPath = join(root, "config.json");
  await writeFile(cfgPath, JSON.stringify({
    notionVersion: "2026-03-11",
    meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
    docsDataSourceId: "11111111-1111-1111-1111-111111111111",
    wikiDir: "wiki",
    wikiProject: "Portfolio",
    deskDirs: [{ dir: DESK, project: "Orakel" }],
    twoWayDirs: [DESK],
    vaultPath,
    selfEmail: "owner@example.com",
    projects: [{ notionProject: "Orakel", vaultFolder: "orakel" }],
  }));

  const url = new URL(tdb.connectionString);
  prevEnv = {
    PGHOST: process.env.PGHOST,
    PGPORT: process.env.PGPORT,
    PGDATABASE: process.env.PGDATABASE,
    PGUSER: process.env.PGUSER,
    PGPASSWORD: process.env.PGPASSWORD,
    NOTION_SYNC_CONFIG: process.env.NOTION_SYNC_CONFIG,
    NOTION_TOKEN: process.env.NOTION_TOKEN,
  };
  process.env.PGHOST = url.hostname;
  process.env.PGPORT = url.port;
  process.env.PGDATABASE = url.pathname.slice(1);
  process.env.PGUSER = decodeURIComponent(url.username);
  process.env.PGPASSWORD = decodeURIComponent(url.password);
  process.env.NOTION_SYNC_CONFIG = cfgPath;
  process.env.NOTION_TOKEN = "test-notion-token";
}, 180_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
  await tdb?.stop();
});

beforeEach(async () => {
  await db.query("DELETE FROM notion_sync_proposals");
  await db.query("DELETE FROM notion_sync_docs");
  await writeFile(join(vaultPath, DESK, "note.md"), VAULT_SOURCE, "utf8");
  git("add", "--all");
  // --allow-empty: the file may already be committed byte-identical from the
  // previous test, and this is fixture setup, not a behaviour under test.
  git("commit", "-q", "--allow-empty", "-m", "seed");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The two-sided conflict every test here starts from: both stored hashes stale, row frozen. */
async function freezeConflict(): Promise<void> {
  await upsertDocSynced(db, {
    vaultPath: PATH,
    pageId: "pnote",
    mdHash: "hash-from-before-the-vault-was-edited",
    notionHash: sha256(LAST_SEEN),
    notionLastEdited: WATERMARK,
    direction: "two_way",
  });
  await freezeDoc(db, PATH, "changed in both Notion and the vault");
}

/**
 * One tick, in the daemon's order and through the daemon's own composition
 * roots (lib/cli.ts tickPasses fixes the order; attendees is left out because
 * this world has no calendar). Returns what each pass reported.
 */
async function tick() {
  const pull = await syncPullOnce({ dryRun: false });
  const apply = await syncApplyOnce({ dryRun: false });
  const wiki = await syncWikiOnce({ dryRun: false });
  const desk = await syncDeskPushOnce({ dryRun: false });
  return { pull, apply, wiki, desk };
}

/** The push-shaped render of the vault file as it stands right now. */
const renderNow = () => makeDocRender(loadNotionSyncConfig(), db).renderDoc(PATH);

describe("resolve --keep md, then a whole tick", () => {
  it("writes the vault's version to Notion and the next tick leaves it alone — no re-freeze", async () => {
    await freezeConflict();
    const notion: FakeNotionState = {
      markdown: { pnote: NOTION_BODY },
      queries: [[{ pageId: "pnote", vaultPath: PATH, lastEditedTime: AFTER_WRITES }]],
    };
    vi.stubGlobal("fetch", makeNotionFetch(notion).impl);

    const message = await resolveFrozenDoc(PATH, "md");
    expect(message).toMatch(/kept the vault version/);

    const rendered = await renderNow();
    // Notion holds the vault's version from the moment the command returns —
    // not "after the next push", which never came.
    expect(notion.markdown.pnote).toBe(`stored:${rendered.markdown}`);

    const t1 = await tick();
    // The whole point: pull runs first and finds nothing to react to.
    expect(t1.pull?.frozen).toBe(0);
    expect(t1.pull?.proposed).toBe(0);
    expect(t1.pull?.unchanged).toBe(1);
    expect(t1.apply?.applied).toBe(0);
    expect(t1.apply?.skipped).toBe(0);
    // …and the push has nothing to do either, because the stored md_hash is true.
    expect(t1.desk?.perDir[0].summary).toContain("0 created, 0 patched, 1 skipped");

    const row = (await getDeskRows(db)).get(PATH);
    expect(row?.state).toBe("synced");
    expect(row?.mdHash).toBe(docRenderHash(rendered));
    expect(row?.notionHash).toBe(sha256(`stored:${rendered.markdown}`));
    // The watermark caught up from an OBSERVED reading, on the tick after the write.
    expect(row?.notionLastEdited).toBe(AFTER_WRITES);
    // The vault was never touched — keeping it is the whole decision.
    expect(await readFile(join(vaultPath, DESK, "note.md"), "utf8")).toBe(VAULT_SOURCE);
    expect(await getOpenProposals(db)).toEqual([]);

    // A second tick is silent too: convergence, not a one-tick truce.
    const t2 = await tick();
    expect(t2.pull?.frozen).toBe(0);
    expect(t2.pull?.proposed).toBe(0);
    expect(t2.desk?.perDir[0].summary).toContain("0 patched, 1 skipped");
  }, 60_000);
});

describe("resolve --keep notion, then approve, then a whole tick", () => {
  it("lands Notion's version in the vault and converges — no re-freeze, no stacked proposal", async () => {
    await freezeConflict();
    const notion: FakeNotionState = {
      markdown: { pnote: NOTION_BODY },
      queries: [[{ pageId: "pnote", vaultPath: PATH, lastEditedTime: AFTER_WRITES }]],
    };
    vi.stubGlobal("fetch", makeNotionFetch(notion).impl);

    expect(await resolveFrozenDoc(PATH, "notion")).toMatch(/forced proposal/);
    await approveProposal(PATH);

    const t1 = await tick();
    // pull finds the page holding exactly the hash `resolve` stamped on the row,
    // so it takes the `unchanged` branch: proposeDesk is never entered, nothing
    // is re-frozen, and apply is free to land the approval. Before C1 the row
    // re-froze here and apply refused to write a frozen row — the approved
    // proposal could never land, on any tick.
    expect(t1.pull?.frozen).toBe(0);
    expect(t1.pull?.unchanged).toBe(1);
    expect(t1.pull?.proposed).toBe(0);
    expect(t1.apply?.applied).toBe(1);
    expect(t1.apply?.skipped).toBe(0);

    // The vault file now carries Notion's body under its OWN frontmatter…
    const written = await readFile(join(vaultPath, DESK, "note.md"), "utf8");
    expect(written).toBe(`${STAMPED_FRONTMATTER}\n${NOTION_BODY}\n`);
    expect(git("log", "-1", "--pretty=%s")).toBe(`notion-sync: apply ${PATH}`);
    // …and the same tick's push carried it back to Notion.
    expect(t1.desk?.perDir[0].summary).toContain("0 created, 1 patched");

    const rendered = await renderNow();
    expect(notion.markdown.pnote).toBe(`stored:${rendered.markdown}`);
    const row = (await getDeskRows(db)).get(PATH);
    expect(row?.state).toBe("synced");
    expect(row?.mdHash).toBe(docRenderHash(rendered));
    expect(row?.notionHash).toBe(sha256(`stored:${rendered.markdown}`));
    const proposals = await db.query<{ state: string }>(`SELECT state FROM notion_sync_proposals`);
    expect(proposals.rows.map((r) => r.state)).toEqual(["applied"]);

    // The tick after: nothing to propose, nothing to freeze, nothing to push.
    const t2 = await tick();
    expect(t2.pull?.frozen).toBe(0);
    expect(t2.pull?.proposed).toBe(0);
    expect(t2.pull?.unchanged).toBe(1);
    expect(t2.apply?.scanned).toBe(0);
    expect(t2.desk?.perDir[0].summary).toContain("0 patched, 1 skipped");
    expect((await getDeskRows(db)).get(PATH)?.state).toBe("synced");
  }, 60_000);
});

describe("a PENDING proposal never lets the same tick's push overwrite it", () => {
  // The narrowing of C1(a) (re-review): deferring the conflict check for an
  // APPROVED proposal is safe because apply consumes it earlier in the same tick.
  // Deferring it for a PENDING one is not: nothing consumes it, so the row stays
  // 'synced' with a stale md_hash and the push at the end of the SAME tick
  // re-patches the page from the vault — destroying the human's queued edit
  // before they ever ruled on it. A pending proposal therefore takes the ordinary
  // path, and the conflict check freezes the row when the vault moved too.
  it("freezes when the vault moves under a pending proposal, and the push skips the frozen row", async () => {
    const notion: FakeNotionState = {
      markdown: { pnote: NOTION_BODY },
      queries: [[{ pageId: "pnote", vaultPath: PATH, lastEditedTime: AFTER_WRITES }]],
    };
    vi.stubGlobal("fetch", makeNotionFetch(notion).impl);

    // A row in step with both sides: only Notion has moved, so pull proposes.
    await upsertDocSynced(db, {
      vaultPath: PATH,
      pageId: "pnote",
      mdHash: docRenderHash(await renderNow()),
      notionHash: sha256(LAST_SEEN),
      notionLastEdited: WATERMARK,
      direction: "two_way",
    });

    const first = await syncPullOnce({ dryRun: false });
    expect(first?.proposed).toBe(1);
    const open = await getOpenProposals(db);
    expect(open).toHaveLength(1);
    expect(open[0].state).toBe("pending");   // nobody has judged it yet

    // …and now the human edits the vault file too, before deciding.
    await writeFile(join(vaultPath, DESK, "note.md"), `${FRONTMATTER}\na later vault edit\n`, "utf8");

    const t = await tick();
    expect(t.pull?.frozen).toBe(1);
    expect(t.pull?.awaitingApproval).toBe(0);
    expect(t.pull?.proposed).toBe(0);          // never stacks a second proposal
    // The push must not carry the vault's newer text over the queued edit.
    expect(t.desk?.perDir[0].summary).toContain("0 created, 0 patched");
    expect(t.desk?.perDir[0].summary).toContain("1 frozen");
    expect(notion.markdown.pnote).toBe(NOTION_BODY);
    expect((await getDeskRows(db)).get(PATH)?.state).toBe("frozen");
    // The human's edit is still theirs to judge, once they resolve the freeze.
    expect((await getOpenProposals(db))[0].state).toBe("pending");
  }, 60_000);
});

describe("resolve --keep notion, when a tick lands before the human approves", () => {
  // The realistic sequence, and the one the first seam test missed: the runbook
  // un-quiesces after a resolve, and the daemon ticks IMMEDIATELY on startup —
  // so a full tick almost always runs between `resolve` and `approve`. Until the
  // forced proposal is applied the row's stored md_hash is still the pre-conflict
  // one, and with the approved-only defer that stale hash re-tripped the conflict
  // check: the row re-froze and the pending proposal was orphaned. `resolve
  // --keep notion` therefore stamps the row's own hashes to what it has just
  // observed, so the waiting period is quiet on both sides.
  it("stays synced and keeps Notion's version while the proposal waits, then applies on approve", async () => {
    await freezeConflict();
    const notion: FakeNotionState = {
      markdown: { pnote: NOTION_BODY },
      queries: [[{ pageId: "pnote", vaultPath: PATH, lastEditedTime: AFTER_WRITES }]],
    };
    vi.stubGlobal("fetch", makeNotionFetch(notion).impl);

    expect(await resolveFrozenDoc(PATH, "notion")).toMatch(/forced proposal/);

    // ── A whole tick with nobody having approved anything.
    const waiting = await tick();
    expect(waiting.pull?.frozen).toBe(0);
    expect(waiting.pull?.proposed).toBe(0);
    expect(waiting.pull?.unchanged).toBe(1);
    expect(waiting.apply?.applied).toBe(0);
    // The push must not carry the vault's version over the content the human is
    // about to rule on — while the proposal is open the file is held back before
    // it is even rendered, so it reports as awaiting approval rather than as an
    // ordinary in-step skip.
    expect(waiting.desk?.perDir[0].summary).toContain("0 created, 0 patched");
    expect(waiting.desk?.perDir[0].summary).toContain("1 awaiting approval");
    expect(notion.markdown.pnote).toBe(NOTION_BODY);

    const row = (await getDeskRows(db)).get(PATH);
    expect(row?.state).toBe("synced");                 // not re-frozen
    expect(row?.notionLastEdited).toBe(AFTER_WRITES);  // the watermark advanced
    const open = await getOpenProposals(db);
    expect(open).toHaveLength(1);
    expect(open[0].state).toBe("pending");             // still theirs to judge

    // ── Now they approve, and the next tick carries it out.
    await approveProposal(PATH);
    const landing = await tick();
    expect(landing.pull?.frozen).toBe(0);
    expect(landing.apply?.applied).toBe(1);
    expect(await readFile(join(vaultPath, DESK, "note.md"), "utf8"))
      .toBe(`${STAMPED_FRONTMATTER}\n${NOTION_BODY}\n`);
    expect(landing.desk?.perDir[0].summary).toContain("0 created, 1 patched");
    expect(notion.markdown.pnote).toBe(`stored:${(await renderNow()).markdown}`);

    // ── And the tick after that is silent.
    const quiet = await tick();
    expect(quiet.pull?.frozen).toBe(0);
    expect(quiet.pull?.proposed).toBe(0);
    expect(quiet.pull?.unchanged).toBe(1);
    expect(quiet.apply?.scanned).toBe(0);
    expect(quiet.desk?.perDir[0].summary).toContain("0 patched, 1 skipped");
    expect((await getDeskRows(db)).get(PATH)?.state).toBe("synced");
  }, 60_000);
});

describe("a vault edit inside the resolve→approve window", () => {
  // The last hole (final review, round 3). `resolve --keep notion` stamps the
  // row's hashes so the wait is quiet — which also means pull's `unchanged`
  // branch has nothing to freeze. If the human then edits the VAULT file while
  // their own proposal waits, the desk push is the only pass left looking at the
  // row, and it is proposal-blind: it would patch Notion with the vault's newer
  // text, over the exact content the proposal references. The push therefore
  // skips any path with an open decision on it.
  it("is never pushed over the pending proposal, and the stale approve freezes honestly", async () => {
    await freezeConflict();
    const notion: FakeNotionState = {
      markdown: { pnote: NOTION_BODY },
      queries: [[{ pageId: "pnote", vaultPath: PATH, lastEditedTime: AFTER_WRITES }]],
    };
    vi.stubGlobal("fetch", makeNotionFetch(notion).impl);

    expect(await resolveFrozenDoc(PATH, "notion")).toMatch(/forced proposal/);

    // The human edits the vault file while their own proposal is still pending.
    await writeFile(join(vaultPath, DESK, "note.md"), `${FRONTMATTER}\na vault edit made while deciding\n`, "utf8");

    const waiting = await tick();
    expect(waiting.pull?.frozen).toBe(0);
    expect(waiting.apply?.applied).toBe(0);
    // The push held the row back rather than patching Notion from the vault.
    expect(waiting.desk?.perDir[0].summary).toContain("0 created, 0 patched");
    expect(waiting.desk?.perDir[0].summary).toContain("1 awaiting approval");
    expect(notion.markdown.pnote).toBe(NOTION_BODY);
    expect((await getDeskRows(db)).get(PATH)?.state).toBe("synced");
    expect((await getOpenProposals(db))[0].state).toBe("pending");

    // Approving it now is a STALE approve: the vault moved after the proposal was
    // based on it, so apply refuses to write, supersedes and freezes (§18.4).
    await approveProposal(PATH);
    const deciding = await tick();
    expect(deciding.apply?.applied).toBe(0);
    expect(deciding.apply?.superseded).toBe(1);
    // Notion is STILL untouched: the row is frozen by the time the push runs.
    expect(notion.markdown.pnote).toBe(NOTION_BODY);
    expect(deciding.desk?.perDir[0].summary).toContain("0 patched");
    const row = (await getDeskRows(db)).get(PATH);
    expect(row?.state).toBe("frozen");
    expect(await getOpenProposals(db)).toEqual([]);

    // …and that freeze is resolvable, which is the whole point of it.
    expect(await resolveFrozenDoc(PATH, "md")).toMatch(/kept the vault version/);
    expect((await getDeskRows(db)).get(PATH)?.state).toBe("synced");
  }, 60_000);
});
