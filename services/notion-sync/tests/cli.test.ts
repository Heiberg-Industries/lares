import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import type { Pool } from "pg";
import { startTestDb, type TestDb } from "@lares/agent-box/tests/helpers/pg.js";
import { makeNotionFetch } from "./helpers/fake-notion.js";
import { makeNotionStore, meetingPageProps } from "./helpers/fake-notion-store.js";
import {
  runPassesContained, syncWikiOnce, runFidelityOnce, tickPasses, syncStampFor, makeDocRender,
  parseOneShotArgs, archiveExcludedDryRun,
  syncPullOnce, syncApplyOnce, syncDeskPushOnce, runReconcile, runEnableTwoWay,
  syncNotionBornOnce, syncPeopleOnce,
  syncArchiveExcludedOnce, syncTranscriptsOnce, runAdoptionReportOnce,
  listOpenProposals, approveProposal, rejectProposal, resolveFrozenDoc,
  registerNotionSyncCommands,
  SYNC_DESK, SYNC_MIRROR, SYNC_SOURCE,
  readSecretOptional,
  notifyFromEnv,
} from "../lib/cli.js";
import { loadNotionSyncConfig } from "../lib/config.js";
import {
  upsertDocSynced, freezeDoc, insertProposal, getOpenProposals, setProposalState,
  getDeskRows, getRejectedUnexecuted, markProposalReverted, recordDocError, replaceFidelity,
  linkPageToVaultFile, recordMeetingUnmatched, resolveProposal, rejectConsequence,
  getLinkedRows,
  type ProposalRow,
} from "../lib/store.js";
import { runApplySync } from "../lib/apply-sync.js";
import { runWikiSync } from "../lib/wiki-sync.js";
import { docRenderHash } from "../lib/pull-sync.js";
import { makeCreateScope } from "../lib/desk-scope.js";
import { sha256 } from "../lib/wiki-sync.js";

/** A vault with one passing file and two failing (aliased-wikilink) files, one
 *  under wiki/ and one under desks/orakel/ — shared by every runFidelityOnce test. */
async function withFidelityVault(fn: (vaultPath: string) => Promise<void>): Promise<void> {
  const vaultPath = await mkdtemp(join(tmpdir(), "notion-sync-fidelity-cli-"));
  try {
    await mkdir(join(vaultPath, "wiki"), { recursive: true });
    await mkdir(join(vaultPath, "desks", "orakel"), { recursive: true });
    // W4D-s3: the gate now also refuses any file with no lares_origin stamp, so
    // every file here gets one — this fixture means to fail on the ALIAS, not
    // on a missing stamp (a downstream test asserts the exact "body mismatch" reason).
    const stamp = "---\nlares_origin: synced\n---\n\n";
    await writeFile(join(vaultPath, "wiki", "pass.md"), `${stamp}hello\n`);
    // Aliased wikilink: pull always reconstructs a bare target and drops the
    // alias, so this fails on both sides of the wiki/desks split.
    await writeFile(join(vaultPath, "wiki", "fail.md"), `${stamp}See [[x|aliased]] here.\n`);
    await writeFile(join(vaultPath, "desks", "orakel", "fail.md"), `${stamp}See [[y|aliased]] here.\n`);
    await fn(vaultPath);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

describe("runPassesContained — the tick's pass isolation", () => {
  it("runs every pass even when an earlier one throws, and reports the tick unclean", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ran: string[] = [];
      const clean = await runPassesContained([
        { name: "attendees", run: async () => { ran.push("attendees"); throw new Error("boom"); } },
        { name: "wiki", run: async () => { ran.push("wiki"); return 0; } },
      ]);
      expect(ran).toEqual(["attendees", "wiki"]);
      expect(clean).toBe(false);
      expect(spy.mock.calls.flat().map(String).join("\n")).toContain("attendees pass failed");
    } finally {
      spy.mockRestore();
    }
  });

  it("reports unclean when a pass completes but left bookkeeping failures", async () => {
    expect(await runPassesContained([{ name: "wiki", run: async () => 2 }])).toBe(false);
  });

  it("reports clean when every pass completes with zero bookkeeping failures", async () => {
    expect(await runPassesContained([
      { name: "attendees", run: async () => 0 },
      { name: "wiki", run: async () => 0 },
    ])).toBe(true);
  });
});

describe("tickPasses — the tick's order (A1, spec §6/§18.4)", () => {
  it("is attendees → transcripts → notion-born → pull → apply → push wiki → push desks → people, in that order", async () => {
    const ran: string[] = [];
    const spy = (name: string) => async (): Promise<number> => {
      ran.push(name);
      return 0;
    };
    const passes = tickPasses({
      attendees: spy("attendees"), transcripts: spy("transcripts"),
      notionBorn: spy("notion-born"),
      pull: spy("pull"), apply: spy("apply"),
      wiki: spy("wiki"), desk: spy("desk"), people: spy("people"),
    });

    const order = ["attendees", "transcripts", "notion-born", "pull", "apply", "wiki", "desk", "people"];
    expect(passes.map((p) => p.name)).toEqual(order);
    expect(await runPassesContained(passes)).toBe(true);
    // The assertion that matters: every push runs AFTER pull. A push before pull
    // would overwrite a human's Notion edit before the conflict check could fire.
    expect(ran).toEqual(order);
    expect(ran.indexOf("pull")).toBeLessThan(ran.indexOf("wiki"));
    expect(ran.indexOf("pull")).toBeLessThan(ran.indexOf("desk"));
    expect(ran.indexOf("apply")).toBeLessThan(ran.indexOf("wiki"));
    // …and BOTH create proposers run BEFORE apply: each has to see a rejection while
    // it is still unexecuted, or the tick after a 👎 re-proposes what was declined.
    expect(ran.indexOf("transcripts")).toBeLessThan(ran.indexOf("apply"));
    expect(ran.indexOf("notion-born")).toBeLessThan(ran.indexOf("apply"));
    // …and people runs AFTER attendees, whose `Attendees` string it derives the
    // relation from. It is last because nothing else reads what it writes.
    expect(ran.indexOf("attendees")).toBeLessThan(ran.indexOf("people"));
  });

  it("still runs the later passes when an earlier one throws — containment is unchanged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ran: string[] = [];
      const ok = (name: string) => async (): Promise<number> => {
        ran.push(name);
        return 0;
      };
      const clean = await runPassesContained(tickPasses({
        attendees: ok("attendees"), transcripts: ok("transcripts"),
        notionBorn: ok("notion-born"),
        pull: async () => { throw new Error("notion down"); },
        apply: ok("apply"), wiki: ok("wiki"), desk: ok("desk"), people: ok("people"),
      }));
      expect(clean).toBe(false);
      expect(ran).toEqual(["attendees", "transcripts", "notion-born", "apply", "wiki", "desk", "people"]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("parseOneShotArgs — the entrypoint's flag guard", () => {
  it("reads each one-shot, and the tick flags, on their own", () => {
    expect(parseOneShotArgs([])).toEqual({ once: false });
    expect(parseOneShotArgs(["--once"])).toEqual({ once: true });
    expect(parseOneShotArgs(["--reconcile"])).toEqual({ once: false, mode: "reconcile" });
    expect(parseOneShotArgs(["--fidelity-record"])).toEqual({ once: false, mode: "fidelity-record" });
    expect(parseOneShotArgs(["--enable-two-way", "desks/x"]))
      .toEqual({ once: false, mode: "enable-two-way", dir: "desks/x" });
    expect(parseOneShotArgs(["--archive-excluded"])).toEqual({ once: false, mode: "archive-excluded" });
    // Unrelated flags travel alongside untouched.
    expect(parseOneShotArgs(["--reconcile", "--dry-run"])).toEqual({ once: false, mode: "reconcile" });
    // --no-dry-run is bin/notion-sync.ts's own concern (T3, runOneShot), not this
    // parser's — it is not even a --dry-run variant this function recognises, so
    // it travels alongside untouched exactly like the line above.
    expect(parseOneShotArgs(["--archive-excluded", "--no-dry-run"]))
      .toEqual({ once: false, mode: "archive-excluded" });
  });

  // FIX WAVE, ITEM 2. The box runs THIS package, never the `lares` CLI, so a
  // command that exists only as a commander subcommand cannot be run where the
  // vault, the database and the token are. `adoption-report` was in that state, and
  // so were the three single-pass previews the runbook's deploy steps call for.
  it("reads the four Phase 4 modes the runbook tells an operator to run on the box", () => {
    expect(parseOneShotArgs(["--adoption-report"])).toEqual({ once: false, mode: "adoption-report" });
    expect(parseOneShotArgs(["--transcripts"])).toEqual({ once: false, mode: "transcripts" });
    expect(parseOneShotArgs(["--notion-born"])).toEqual({ once: false, mode: "notion-born" });
    expect(parseOneShotArgs(["--people"])).toEqual({ once: false, mode: "people" });
    // …each with the shared dry-run flag alongside, which is how the runbook
    // previews a pass before enabling it. The flag itself is read in
    // bin/notion-sync.ts, so it travels through here untouched.
    expect(parseOneShotArgs(["--transcripts", "--dry-run"])).toEqual({ once: false, mode: "transcripts" });
    expect(parseOneShotArgs(["--people", "--dry-run"])).toEqual({ once: false, mode: "people" });
  });

  it("holds the four new modes to the same mutual exclusivity as every other one-shot", () => {
    expect(() => parseOneShotArgs(["--transcripts", "--people"]))
      .toThrow(/one one-shot flag at a time.*--transcripts --people/s);
    expect(() => parseOneShotArgs(["--adoption-report", "--archive-excluded"]))
      .toThrow(/one one-shot flag at a time/);
    expect(() => parseOneShotArgs(["--once", "--notion-born"]))
      .toThrow(/--once runs the tick.*--notion-born/s);
  });

  it("refuses two one-shots, or a one-shot with --once — never silently runs one and drops the other", () => {
    expect(() => parseOneShotArgs(["--reconcile", "--fidelity-record"]))
      .toThrow(/one one-shot flag at a time.*--reconcile --fidelity-record/s);
    expect(() => parseOneShotArgs(["--reconcile", "--enable-two-way", "desks/x"]))
      .toThrow(/one one-shot flag at a time/);
    expect(() => parseOneShotArgs(["--once", "--reconcile"]))
      .toThrow(/--once runs the tick.*--reconcile/s);
    expect(() => parseOneShotArgs(["--archive-excluded", "--reconcile"]))
      .toThrow(/one one-shot flag at a time/);
    expect(() => parseOneShotArgs(["--once", "--archive-excluded"]))
      .toThrow(/--once runs the tick.*--archive-excluded/s);
  });

  it("refuses --enable-two-way without a dir, including when the next token is another flag", () => {
    expect(() => parseOneShotArgs(["--enable-two-way"])).toThrow(/needs a desk dir/);
    expect(() => parseOneShotArgs(["--enable-two-way", "--dry-run"])).toThrow(/needs a desk dir/);
  });

  // I1 (final review): `resolve` was reachable only through the commander CLI,
  // which does not exist on the box — the one place with the vault, the database
  // and the token. A frozen row was therefore unresolvable in production.
  it("reads --resolve with its path and side", () => {
    expect(parseOneShotArgs(["--resolve", "desks/orakel/note.md", "--keep", "md"]))
      .toEqual({ once: false, mode: "resolve", path: "desks/orakel/note.md", keep: "md" });
    expect(parseOneShotArgs(["--keep", "notion", "--resolve", "desks/orakel/note.md"]))
      .toEqual({ once: false, mode: "resolve", path: "desks/orakel/note.md", keep: "notion" });
  });

  it("refuses --resolve without a path, without --keep, or with a --keep it cannot honour", () => {
    expect(() => parseOneShotArgs(["--resolve"])).toThrow(/needs a vault path/);
    expect(() => parseOneShotArgs(["--resolve", "--keep", "md"])).toThrow(/needs a vault path/);
    expect(() => parseOneShotArgs(["--resolve", "desks/orakel/note.md"]))
      .toThrow(/--keep md\|notion/);
    expect(() => parseOneShotArgs(["--resolve", "desks/orakel/note.md", "--keep", "both"]))
      .toThrow(/--keep must be "md" or "notion"/);
    expect(() => parseOneShotArgs(["--resolve", "desks/orakel/note.md", "--keep"]))
      .toThrow(/--keep must be "md" or "notion"/);
    // A --keep with no --resolve is a typo that must not silently start a daemon.
    expect(() => parseOneShotArgs(["--keep", "md"])).toThrow(/--keep only means something with --resolve/);
  });

  it("refuses --resolve under a dry-run flag rather than writing live behind one", () => {
    // The other one-shots rehearse; this one carries out a decision a human has
    // already made, so there is nothing to rehearse — and silently writing for
    // real while the operator believes they are rehearsing is the worst of the
    // available behaviours.
    expect(() => parseOneShotArgs(["--resolve", "p.md", "--keep", "md", "--dry-run"]))
      .toThrow(/--resolve is always live/);
    expect(() => parseOneShotArgs(["--dry-run", "--resolve", "p.md", "--keep", "notion"]))
      .toThrow(/drop --dry-run/);
    // …and the rollout modes still take it.
    expect(parseOneShotArgs(["--reconcile", "--dry-run"])).toEqual({ once: false, mode: "reconcile" });
  });

  it("holds --resolve to the same mutual exclusivity as every other one-shot", () => {
    expect(() => parseOneShotArgs(["--reconcile", "--resolve", "p.md", "--keep", "md"]))
      .toThrow(/one one-shot flag at a time/);
    expect(() => parseOneShotArgs(["--once", "--resolve", "p.md", "--keep", "md"]))
      .toThrow(/--once runs the tick/);
  });

  // LAR-64: `approve <path>` / `reject <path>` existed only as commander subcommands
  // (lib/cli.ts registerNotionSyncCommands) with no caller left after the lares CLI
  // split, and the box has no lares checkout to run them from. Typing the old form
  // there — a bare positional argument — used to fall through silently into daemon
  // mode instead of erroring, once starting a second sync tick mid-pull.
  it("reads --approve and --reject with their vault path", () => {
    expect(parseOneShotArgs(["--approve", "desks/orakel/note.md"]))
      .toEqual({ once: false, mode: "approve", path: "desks/orakel/note.md" });
    expect(parseOneShotArgs(["--reject", "desks/orakel/note.md"]))
      .toEqual({ once: false, mode: "reject", path: "desks/orakel/note.md" });
  });

  it("refuses --approve / --reject without a path, mirroring --resolve", () => {
    expect(() => parseOneShotArgs(["--approve"])).toThrow(/needs a vault path/);
    expect(() => parseOneShotArgs(["--approve", "--dry-run"])).toThrow(/needs a vault path/);
    expect(() => parseOneShotArgs(["--reject"])).toThrow(/needs a vault path/);
    expect(() => parseOneShotArgs(["--reject", "--dry-run"])).toThrow(/needs a vault path/);
  });

  it("refuses --approve / --reject under a dry-run flag rather than writing live behind one", () => {
    expect(() => parseOneShotArgs(["--approve", "p.md", "--dry-run"]))
      .toThrow(/--approve is always live/);
    expect(() => parseOneShotArgs(["--dry-run", "--reject", "p.md"]))
      .toThrow(/--reject is always live/);
  });

  it("holds --approve / --reject to the same mutual exclusivity as every other one-shot", () => {
    expect(() => parseOneShotArgs(["--once", "--approve", "p.md"]))
      .toThrow(/--once runs the tick.*--approve/s);
    expect(() => parseOneShotArgs(["--once", "--reject", "p.md"]))
      .toThrow(/--once runs the tick.*--reject/s);
    expect(() => parseOneShotArgs(["--approve", "p.md", "--reject", "q.md"]))
      .toThrow(/one one-shot flag at a time/);
    expect(() => parseOneShotArgs(["--reconcile", "--approve", "p.md"]))
      .toThrow(/one one-shot flag at a time/);
    expect(() => parseOneShotArgs(["--resolve", "p.md", "--keep", "md", "--approve", "q.md"]))
      .toThrow(/one one-shot flag at a time/);
  });

  // The trap that made this ticket: `approve <path>` (no leading `--`) used to be
  // silently ignored by this function, and the daemon would start ticking instead.
  it("refuses a bare positional argument — the old `approve <path>` typo", () => {
    expect(() => parseOneShotArgs(["approve", "desks/orakel/note.md"]))
      .toThrow(/unexpected argument "approve"/);
    expect(() => parseOneShotArgs(["reject", "desks/orakel/note.md"]))
      .toThrow(/unexpected argument "reject"/);
  });

  it("refuses trailing garbage after a valid one-shot's own path", () => {
    expect(() => parseOneShotArgs(["--approve", "desks/orakel/note.md", "extra"]))
      .toThrow(/unexpected argument "extra"/);
  });

  it("refuses an unknown --flag instead of silently falling through to the daemon", () => {
    expect(() => parseOneShotArgs(["--bogus"])).toThrow(/unknown flag "--bogus"/);
    expect(() => parseOneShotArgs(["--once", "--bogus"])).toThrow(/unknown flag "--bogus"/);
  });
});

describe("archiveExcludedDryRun — the box's most destructive one-shot's polarity (fix round 1, Important 1)", () => {
  // Extracted from an inline `||`/`!includes` expression in bin/notion-sync.ts
  // specifically because nothing imports that file to catch a mutation of it —
  // reviewer mutation-testing swapped the operators there and the whole
  // 559-test suite stayed green. Four combinations; the fourth (--no-dry-run
  // alongside a true sharedDryRun) is refused by bin/notion-sync.ts BEFORE this
  // function is ever called in the real entrypoint (mirrors the --resolve +
  // --dry-run refusal) — this function itself still answers it safely rather
  // than throwing, since a pure polarity function with no side effect is not
  // the layer that should own that refusal.
  it("no flags, no env: dry-run (the safe default)", () => {
    expect(archiveExcludedDryRun([], false)).toBe(true);
  });

  it("--no-dry-run, no env: live (the one explicit way to write)", () => {
    expect(archiveExcludedDryRun(["--no-dry-run"], false)).toBe(false);
  });

  it("no flags, env forces dry-run: still dry-run", () => {
    expect(archiveExcludedDryRun([], true)).toBe(true);
  });

  it("--no-dry-run AND env forces dry-run: dry-run wins (the combination bin/notion-sync.ts refuses outright before reaching here)", () => {
    expect(archiveExcludedDryRun(["--no-dry-run"], true)).toBe(true);
  });
});

describe("syncStampFor — one rule for what the Sync property says", () => {
  it("reports the row's CURRENT direction, and treats an absent row as mirror", () => {
    expect(syncStampFor({ direction: "two_way" })).toBe(SYNC_DESK);
    expect(syncStampFor({ direction: "md_to_notion" })).toBe(SYNC_MIRROR);
    // A file with no row yet is a create — and everything starts Mirror until an
    // explicit enable-two-way flips it (plan decision 4).
    expect(syncStampFor(undefined)).toBe(SYNC_MIRROR);
  });

  // CHANGED in Phase 4 (T3b fix round 1). This assertion used to read
  // `notion_to_md → SYNC_MIRROR`, which pinned the defect rather than a decision:
  // the stamp's contract is that Notion can never disagree with the behaviour the
  // store applies, and a Notion-owned row behaves like neither of the other two.
  // 🔒 Mirror would tell Bendik his edits here get reverted (they arrive as a 👍
  // proposal) and would make `reconcile` LOCK the one kind of page whose whole
  // purpose is that he writes it in Notion.
  it("gives a Notion-owned row its own stamp, never the mirror's", () => {
    expect(syncStampFor({ direction: "notion_to_md" })).toBe(SYNC_SOURCE);
    expect(SYNC_SOURCE).not.toBe(SYNC_MIRROR);
    expect(SYNC_SOURCE).not.toBe(SYNC_DESK);
  });
});

// ---------------------------------------------------------------------------
// T7 (Phase 4) — the People projection, through the REAL composition root.
//
// No database anywhere in this block, deliberately: `syncPeopleOnce` never calls
// poolFromEnv(), because the People rows in Notion ARE its state. A function that
// opens no database connection cannot leave a row behind in one, and running it
// with none reachable is the strongest form that proof can take.
// ---------------------------------------------------------------------------
describe("syncPeopleOnce — the composition root", () => {
  const peopleCfg = {
    notionVersion: "2026-03-11",
    meetingsDataSourceId: "meetings-ds",
    vaultPath: "/srv/vault",
    selfEmail: "owner@example.com",
    projects: [{ notionProject: "ExampleProject", vaultFolder: "example-project" }],
    people: { dataSourceId: "people-ds" },
  };

  /** Routes Notion to the stateful fake and Twenty to a fixed people list. */
  function routed(store: ReturnType<typeof makeNotionStore>, people: unknown[]) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://crm.example.com/")) {
        return new Response(
          JSON.stringify({ data: { people }, pageInfo: { hasNextPage: false, endCursor: null } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return store.impl(url, init);
    });
  }

  async function withPeopleEnv(fn: () => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "notion-sync-people-"));
    const cfgPath = join(dir, "config.json");
    await writeFile(cfgPath, JSON.stringify(peopleCfg));
    const prev = {
      cfg: process.env.NOTION_SYNC_CONFIG, token: process.env.NOTION_TOKEN,
      base: process.env.TWENTY_BASE_URL, key: process.env.TWENTY_KEY,
    };
    process.env.NOTION_SYNC_CONFIG = cfgPath;
    process.env.NOTION_TOKEN = "notion-test-token";
    process.env.TWENTY_BASE_URL = "https://crm.example.com";
    process.env.TWENTY_KEY = "twenty-test-key";
    try {
      await fn();
    } finally {
      for (const [name, value] of [
        ["NOTION_SYNC_CONFIG", prev.cfg], ["NOTION_TOKEN", prev.token],
        ["TWENTY_BASE_URL", prev.base], ["TWENTY_KEY", prev.key],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      vi.unstubAllGlobals();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("projects the attendee, links the meeting, and is silent on the next two ticks", async () => {
    const store = makeNotionStore();
    store.seed("meetings-ds", "meet-1", meetingPageProps({
      title: "Alex // Bendik",
      attendees: "Alex Partner <alex@partner.example>, Bendik <owner@example.com>",
    }));
    vi.stubGlobal("fetch", routed(store, [{
      id: "rec-1", name: { firstName: "Alex", lastName: "Partner" },
      emails: { primaryEmail: "alex@partner.example", additionalEmails: [] },
    }]));

    await withPeopleEnv(async () => {
      const first = await syncPeopleOnce({ dryRun: false });
      expect(first).toMatchObject({ created: 1, relationsUpdated: 1, errored: 0 });

      const writes = (): number => store.requests
        .filter((r) => r.method !== "POST" || !r.path.endsWith("/query")).length;
      const settled = writes();
      for (const label of ["tick 2", "tick 3"]) {
        const again = await syncPeopleOnce({ dryRun: false });
        expect(again, label).toMatchObject({ created: 0, updated: 0, relationsUpdated: 0 });
        expect(writes(), label).toBe(settled);
      }

      // The `Source` label came from the adapter, not from the engine.
      const created = [...store.pages.values()].find((page) => page.dataSourceId === "people-ds");
      expect(created?.properties).toMatchObject({
        Email: { email: "alex@partner.example" },
        Source: { select: { name: "Twenty" } },
      });
    });
  });

  it("writes NOTHING in dry-run, through the real client", async () => {
    const store = makeNotionStore();
    store.seed("meetings-ds", "meet-1", meetingPageProps({
      attendees: "Alex <alex@partner.example>, Bendik <owner@example.com>",
    }));
    vi.stubGlobal("fetch", routed(store, [{
      id: "rec-1", name: { firstName: "Alex", lastName: "Partner" },
      emails: { primaryEmail: "alex@partner.example" },
    }]));

    await withPeopleEnv(async () => {
      const res = await syncPeopleOnce({ dryRun: true });
      expect(res).toMatchObject({ created: 1, relationsUpdated: 1 });
      expect(store.requests.filter((r) => r.method !== "POST" || !r.path.endsWith("/query"))).toEqual([]);
      expect([...store.pages.values()].filter((page) => page.dataSourceId === "people-ds")).toEqual([]);
    });
  });
});

describe("the pass compositions — unconfigured skips", () => {
  /** Runs `fn` with NOTION_SYNC_CONFIG pointed at a config file of `raw`. */
  async function withConfig(raw: unknown, fn: () => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "notion-sync-cfg-"));
    const cfgPath = join(dir, "config.json");
    await writeFile(cfgPath, JSON.stringify(raw));
    const prev = process.env.NOTION_SYNC_CONFIG;
    process.env.NOTION_SYNC_CONFIG = cfgPath;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.NOTION_SYNC_CONFIG;
      else process.env.NOTION_SYNC_CONFIG = prev;
      await rm(dir, { recursive: true, force: true });
    }
  }

  // The real on-box Phase 1 config shape (see config.test.ts) — no wiki keys.
  const phase1 = {
    notionVersion: "2026-03-11",
    meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
    vaultPath: "/srv/vault",
    selfEmail: "owner@example.com",
    projects: [{ notionProject: "ExampleProject", vaultFolder: "example-project" }],
  };
  const phase2 = {
    ...phase1,
    docsDataSourceId: "11111111-1111-1111-1111-111111111111",
    wikiDir: "wiki",
    wikiProject: "Portfolio",
  };

  it("every doc-side pass returns null and logs a skip on a Phase 1 config", async () => {
    // The skip must happen before any pool or Notion client is built, so this
    // needs nothing but the config file itself.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await withConfig(phase1, async () => {
        expect(await syncWikiOnce({ dryRun: false })).toBeNull();
        expect(await syncDeskPushOnce({ dryRun: false })).toBeNull();
        expect(await syncPullOnce({ dryRun: false })).toBeNull();
        expect(await syncApplyOnce({ dryRun: false })).toBeNull();
        expect(await runReconcile({ dryRun: false })).toBeNull();
        // T7: no `people` section ⇒ the pass does nothing at all, and the vault
        // gains no fourth contact store by omission.
        expect(await syncPeopleOnce({ dryRun: false })).toBeNull();
      });
      expect(log.mock.calls.flat().map(String).join("\n")).toContain("not configured");
    } finally {
      log.mockRestore();
    }
  });

  it("the desk push skips on a Phase 2 config while pull/apply still run — mirror rows are theirs too", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await withConfig(phase2, async () => {
        // No deskDirs: nothing to push. But the pull/apply gate is the Docs
        // database, not deskDirs — a wiki mirror row's accidental Notion edit is
        // reverted by the pull pass, and those rows exist here.
        expect(await syncDeskPushOnce({ dryRun: false })).toBeNull();
        const skips = log.mock.calls.flat().map(String).join("\n");
        expect(skips).toContain("desk push: not configured");
        expect(skips).not.toContain("pull: not configured");
      });
    } finally {
      log.mockRestore();
    }
  });

  it("enable-two-way refuses a dir that is not in twoWayDirs — the pilot dial is config", async () => {
    await withConfig(
      { ...phase2, deskDirs: [{ dir: "desks/one", project: "One" }] },
      async () => {
        await expect(runEnableTwoWay("desks/one", { dryRun: true })).rejects.toThrow(/twoWayDirs/);
      },
    );
    await withConfig(phase2, async () => {
      await expect(runEnableTwoWay("desks/one", { dryRun: true })).rejects.toThrow(/deskDirs/);
    });
  });
});

// ---------------------------------------------------------------------------
// T5 (Phase 4, ORB-39) — the adoption report, through the REAL composition root.
//
// tests/adoption-report.test.ts proves the pure engine's matching rules and its
// own lack of write capability (a source scan of lib/adoption-report.ts — safe
// there because that file has no OTHER reason to import writeFileSync/child_process/
// the vault writer). It cannot prove the WRAPPER is equally clean, because cli.ts
// legitimately imports writeFileSync and the vault writer for half a dozen OTHER
// commands — a source scan of the whole file would find them and mean nothing.
// This is the dynamic proof T3's review demanded after its first version made
// exactly that mistake for archive-excluded.ts: run the real `runAdoptionReportOnce`
// against a real filesystem and a fake Notion, and show nothing moved.
//
// Deliberately the ONLY describe block in this file that runs with NO Postgres
// reachable at all — every other block spins up a real testcontainer in its
// beforeAll. That absence IS one of the three proofs below: a function that
// cannot open a database connection cannot leave a row in one.
// ---------------------------------------------------------------------------
describe("runAdoptionReportOnce — T5 (Phase 4): the adoption report, through the real composition root", () => {
  let vaultPath: string;
  let cfgPath: string;
  let prevEnv: Record<string, string | undefined>;

  const KRISTIANIA = "zero7/transcripts/2026-03-25-kristiania-maida.md";
  const BENDIK_LARS = "zero7/transcripts/Bendik & Lars @Today 13 00 382cc987b45780c38dfbf6ad2a8e32ad.md";
  const NESTED = "zero7/transcripts/analysis/analysis.md";
  const ORPHAN = "orakel/transcripts/2026-01-01-orphan-call.md";

  /** Every file under `dir`, recursively, as relPath -> content — a snapshot to
   *  diff before/after a run that must not have touched any of it. */
  async function snapshotDir(dir: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    async function walk(sub: string): Promise<void> {
      for (const entry of await readdir(join(dir, sub), { withFileTypes: true })) {
        const rel = sub === "" ? entry.name : `${sub}/${entry.name}`;
        if (entry.isDirectory()) await walk(rel);
        else out[rel] = await readFile(join(dir, rel), "utf8");
      }
    }
    await walk("");
    return out;
  }

  beforeAll(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), "notion-sync-adoption-report-"));
    await mkdir(join(vaultPath, "zero7", "transcripts", "analysis"), { recursive: true });
    await mkdir(join(vaultPath, "orakel", "transcripts"), { recursive: true });

    // The exact filenames the T5 brief documents as measured on the live box —
    // an exact page-id match, a tidy date+title match, a nested two-deep file,
    // and (in a different project folder) an orphan with no Meetings row at all.
    await writeFile(join(vaultPath, KRISTIANIA), "# Kristiania Maida\n\nnotes\n");
    await writeFile(join(vaultPath, BENDIK_LARS), "# Bendik & Lars\n\nnotes\n");
    await writeFile(join(vaultPath, NESTED), "# Analysis\n\nnotes\n");
    await writeFile(join(vaultPath, ORPHAN), "# Orphan\n\nnotes\n");

    cfgPath = join(vaultPath, "config.json");
    await writeFile(cfgPath, JSON.stringify({
      notionVersion: "2026-03-11",
      meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
      vaultPath,
      selfEmail: "owner@example.com",
      projects: [{ notionProject: "Zero7", vaultFolder: "zero7" }],
      transcripts: {
        dir: "transcripts",
        projects: [
          { notionProject: "Zero7", vaultFolder: "zero7" },
          { notionProject: "Orakel", vaultFolder: "orakel" },
        ],
      },
      // Deliberately NO wiki/desks section — T4's own report notes the transcripts
      // group is independent of the desks group, and this composition root never
      // reads either, so a report-only config with no other section configured is
      // exactly what a brand-new deployment doing ONLY T5 would have.
    }));

    prevEnv = {
      PGHOST: process.env.PGHOST, PGPORT: process.env.PGPORT, PGDATABASE: process.env.PGDATABASE,
      PGUSER: process.env.PGUSER, PGPASSWORD: process.env.PGPASSWORD,
      NOTION_SYNC_CONFIG: process.env.NOTION_SYNC_CONFIG, NOTION_TOKEN: process.env.NOTION_TOKEN,
    };
    // No PG* vars set to anything reachable — see "never opens a database
    // connection" below, which depends on this.
    delete process.env.PGHOST;
    delete process.env.PGPORT;
    delete process.env.PGDATABASE;
    delete process.env.PGUSER;
    delete process.env.PGPASSWORD;
    process.env.NOTION_SYNC_CONFIG = cfgPath;
    process.env.NOTION_TOKEN = "test-notion-token";
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(vaultPath, { recursive: true, force: true });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it("not configured (no transcripts section): returns null and logs a skip, before any Notion call", async () => {
    const bareCfgPath = join(vaultPath, "config-no-transcripts.json");
    await writeFile(bareCfgPath, JSON.stringify({
      notionVersion: "2026-03-11",
      meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
      vaultPath,
      selfEmail: "owner@example.com",
      projects: [{ notionProject: "Zero7", vaultFolder: "zero7" }],
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.env.NOTION_SYNC_CONFIG = bareCfgPath;
      // No fetch stub at all — if this reached Notion, the real global fetch
      // would try a live network call and this test would hang or fail loudly.
      expect(await runAdoptionReportOnce()).toBeNull();
      expect(log.mock.calls.flat().map(String).join("\n")).toContain("not configured");
    } finally {
      log.mockRestore();
      process.env.NOTION_SYNC_CONFIG = cfgPath;
    }
  });

  it("matches through the REAL vault walk and the REAL Notion query mapping", async () => {
    const fake = makeNotionFetch({
      markdown: {},
      queries: [[
        {
          pageId: "382cc987-b457-80c3-8dfb-f6ad2a8e32ad", vaultPath: "",
          lastEditedTime: "2026-08-01T00:00:00.000Z",
          title: "Bendik & Lars", project: "Zero7", startsAt: "2026-01-10T09:00:00.000+01:00",
        },
        {
          pageId: "p-tidy", vaultPath: "",
          lastEditedTime: "2026-08-01T00:00:00.000Z",
          title: "Kristiania Maida", project: "Zero7", startsAt: "2026-03-25T14:00:00.000+01:00",
        },
        {
          pageId: "p-nobody", vaultPath: "",
          lastEditedTime: "2026-08-01T00:00:00.000Z",
          title: "Nobody Wrote This Down", project: "Zero7", startsAt: "2026-02-02T09:00:00.000+01:00",
        },
      ]],
    });
    vi.stubGlobal("fetch", fake.impl);

    const result = await runAdoptionReportOnce();

    expect(result).not.toBeNull();
    expect(result?.totalMeetings).toBe(3);
    // 3 under zero7/transcripts (incl. the nested one) + 1 under orakel/transcripts.
    expect(result?.totalVaultFiles).toBe(4);
    expect(result?.confident.map((c) => c.vaultPath).sort()).toEqual([BENDIK_LARS, KRISTIANIA].sort());
    expect(result?.unmatchedMeetings.map((m) => m.pageId)).toEqual(["p-nobody"]);
    expect(result?.unmatchedFiles.map((f) => f.vaultPath).sort()).toEqual([NESTED, ORPHAN].sort());

    // Read-only over the wire: every request this run made was a data-source
    // QUERY — nothing that could change a Notion page (a PATCH, or a POST to
    // create a page) was ever sent.
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const req of fake.requests) {
      expect(req.method, `unexpected write-shaped request: ${req.method} ${req.path}`).toBe("POST");
      expect(req.path.endsWith("/query"), `unexpected write-shaped request: ${req.method} ${req.path}`).toBe(true);
    }
  });

  it("never touches the vault — every file's bytes, and the directory listing itself, are identical before and after", async () => {
    const before = await snapshotDir(vaultPath);
    const fake = makeNotionFetch({ markdown: {}, queries: [[]] });
    vi.stubGlobal("fetch", fake.impl);

    await runAdoptionReportOnce();

    expect(await snapshotDir(vaultPath)).toEqual(before);
  });

  it("never opens a database connection — succeeds with no Postgres reachable at all (the strongest form of 'no store write')", async () => {
    // PG* are unset for this entire describe block (see beforeAll). If
    // runAdoptionReportOnce called poolFromEnv() anywhere in its path, this
    // test — not a mock, a genuine absence — would reject with a connection
    // error instead of resolving. See runAdoptionReportOnce's own doc comment
    // in lib/cli.ts for why there is nothing in this command's path that could.
    const fake = makeNotionFetch({ markdown: {}, queries: [[]] });
    vi.stubGlobal("fetch", fake.impl);
    await expect(runAdoptionReportOnce()).resolves.not.toBeNull();
  });

  it("a project folder with no transcripts directory yet contributes 0 files rather than failing the whole report", async () => {
    const missingDirCfgPath = join(vaultPath, "config-missing-project-dir.json");
    await writeFile(missingDirCfgPath, JSON.stringify({
      notionVersion: "2026-03-11",
      meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
      vaultPath,
      selfEmail: "owner@example.com",
      projects: [{ notionProject: "Zero7", vaultFolder: "zero7" }],
      transcripts: {
        dir: "transcripts",
        projects: [
          { notionProject: "Zero7", vaultFolder: "zero7" },
          // "murmur" is configured but has no vault folder at all on disk yet —
          // the ground truth's own shape (not every desk has transcripts from day one).
          { notionProject: "Murmur", vaultFolder: "murmur" },
        ],
      },
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = makeNotionFetch({ markdown: {}, queries: [[]] });
    vi.stubGlobal("fetch", fake.impl);
    try {
      process.env.NOTION_SYNC_CONFIG = missingDirCfgPath;
      const result = await runAdoptionReportOnce();
      // The 3 real zero7 files are still found; murmur contributes 0, not a crash.
      expect(result?.totalVaultFiles).toBe(3);
      expect(errorSpy.mock.calls.flat().map(String).join("\n")).toContain("could not list murmur/transcripts");
    } finally {
      errorSpy.mockRestore();
      process.env.NOTION_SYNC_CONFIG = cfgPath;
    }
  });

  it("fix round 1, Minor — two transcripts.projects entries sharing one vaultFolder do not double-count that folder's files", async () => {
    // config.ts only rejects a duplicate notionProject, never a duplicate
    // vaultFolder (config.test.ts) — two Notion projects can legitimately share
    // one vault folder. Walking per PROJECT ENTRY rather than per RESOLVED
    // DIRECTORY would list "zero7/transcripts" twice and double every file in it:
    // totalVaultFiles counted high, and each real file appearing as two identical
    // unmatchedFiles rows if it matched nothing. The accounting guard cannot
    // catch this on its own — it verifies the ARITHMETIC, not whether the INPUT
    // was already doubled — so this has to be proven at the composition root.
    const sharedFolderCfgPath = join(vaultPath, "config-shared-folder.json");
    await writeFile(sharedFolderCfgPath, JSON.stringify({
      notionVersion: "2026-03-11",
      meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
      vaultPath,
      selfEmail: "owner@example.com",
      projects: [{ notionProject: "Zero7", vaultFolder: "zero7" }],
      transcripts: {
        dir: "transcripts",
        projects: [
          { notionProject: "Zero7", vaultFolder: "zero7" },
          // A second Notion project pointed at the SAME vault folder as the first.
          { notionProject: "Zero7 Legacy", vaultFolder: "zero7" },
        ],
      },
    }));
    const fake = makeNotionFetch({ markdown: {}, queries: [[]] });
    vi.stubGlobal("fetch", fake.impl);
    try {
      process.env.NOTION_SYNC_CONFIG = sharedFolderCfgPath;
      const result = await runAdoptionReportOnce();
      // The 3 real zero7 files (2 top-level + 1 nested), counted ONCE each — not 6.
      expect(result?.totalVaultFiles).toBe(3);
      expect(result?.unmatchedFiles.map((f) => f.vaultPath).sort()).toEqual([
        BENDIK_LARS, KRISTIANIA, NESTED,
      ].sort());
    } finally {
      process.env.NOTION_SYNC_CONFIG = cfgPath;
    }
  });
});

// FIX WAVE, ITEM 2 — the entrypoint's OWN wiring, run as the box runs it.
//
// Everything else in this file drives lib/. bin/notion-sync.ts is a different
// artifact: it is the container's ONLY entry point (the image ships this package,
// not the `lares` CLI, and the box has no lares checkout), and it is the file where
// a missing flag makes a documented operator command simply not exist. Nothing
// imported it, so nothing could catch that — which is exactly how `adoption-report`
// and three single-pass previews shipped unreachable.
//
// So: spawn it, with the flags the runbook tells Bendik to type, against a config
// that has none of the Phase 3/4 sections. Each pass must recognise its flag, log
// its own "not configured" skip and exit 0 — and the DISCRIMINATION is real, because
// an unrecognised flag falls through to the daemon gate and prints "built ok —
// daemon gated OFF" instead (which is what every one of these did before the fix).
describe("bin/notion-sync.ts — the box's one-shot flags, spawned for real", () => {
  const ENTRYPOINT = join(import.meta.dirname, "..", "bin", "notion-sync.ts");
  const TSX = join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsx");
  let dir: string;
  let cfgPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "notion-sync-entrypoint-"));
    cfgPath = join(dir, "config.json");
    // A Phase 1 config: no `transcripts`, no `people`, no `wikiDir`/`deskDirs`. Every
    // Phase 4 pass gates on its own section and returns before it builds a pool or a
    // Notion client, so this run needs no database, no token and no network.
    await writeFile(cfgPath, JSON.stringify({
      notionVersion: "2026-03-11",
      meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
      vaultPath: dir,
      selfEmail: "owner@example.com",
      projects: [{ notionProject: "ExampleProject", vaultFolder: "example-project" }],
    }));
  });

  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  /** Runs the entrypoint with `args` and returns what an operator would see. */
  function run(args: string[]): { stdout: string; status: number } {
    // A DELIBERATELY BARE environment: no PG* at all, so a branch that opened a
    // database connection could not silently succeed against a stray local
    // Postgres — it would hang or throw. That is what pins `--adoption-report`'s
    // "never opens a connection" property at the entrypoint as well as in lib/.
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NOTION_SYNC_CONFIG: cfgPath,
    };
    try {
      const stdout = execFileSync(TSX, [ENTRYPOINT, ...args], {
        env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
      });
      return { stdout, status: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: `${e.stdout ?? ""}${e.stderr ?? ""}`, status: e.status ?? 1 };
    }
  }

  it.each([
    ["--adoption-report", "adoption-report: transcripts not configured, skipping"],
    ["--transcripts", "transcripts: not configured, skipping"],
    ["--notion-born", "notion-born: not configured, skipping"],
    ["--people", "people: not configured, skipping"],
  ])("%s reaches its own pass and exits 0", (flag, expected) => {
    const { stdout, status } = run([flag]);
    expect(stdout).toContain(expected);
    // The failure mode this test exists for: an unrecognised flag is not an error,
    // it silently becomes "no mode requested".
    expect(stdout).not.toContain("daemon gated OFF");
    expect(status).toBe(0);
  }, 60_000);

  it("--transcripts --dry-run is accepted, not refused like --resolve is", () => {
    const { stdout, status } = run(["--transcripts", "--dry-run"]);
    expect(stdout).toContain("transcripts: not configured, skipping");
    expect(status).toBe(0);
  }, 60_000);

  it("still refuses two one-shots at once, through the real parser", () => {
    const { stdout, status } = run(["--transcripts", "--people"]);
    expect(stdout).toMatch(/one one-shot flag at a time/);
    expect(status).not.toBe(0);
  }, 60_000);

  // LAR-64: this used to be the bug — a flag this file does not know was not an
  // error, it fell through to the daemon gate, and "the command ran and printed
  // something" was never evidence that the command exists. parseOneShotArgs now
  // refuses it outright, through the real spawned entrypoint, not just the unit
  // test on the pure function above.
  it("an unknown flag is refused, not silently ignored into the daemon gate", () => {
    const { stdout, status } = run(["--no-such-mode"]);
    expect(stdout).toContain('unknown flag "--no-such-mode"');
    expect(stdout).not.toContain("daemon gated OFF");
    expect(status).not.toBe(0);
  }, 60_000);

  // Same fix, the bare-positional shape: the exact typo the ticket was filed for
  // (`notion-sync.ts approve <path>`) used to start a daemon tick instead of
  // erroring.
  it("a bare positional argument is refused, not silently ignored into the daemon gate", () => {
    const { stdout, status } = run(["approve", "desks/example/note.md"]);
    expect(stdout).toContain('unexpected argument "approve"');
    expect(stdout).not.toContain("daemon gated OFF");
    expect(status).not.toBe(0);
  }, 60_000);
});

describe("runFidelityOnce — vault walk + engine wiring, no DB (record: false)", () => {
  it("reports every file but counts zero sync-eligible failures when no prefix is given", async () => {
    await withFidelityVault(async (vaultPath) => {
      const run = await runFidelityOnce({ vaultPath, eligiblePrefixes: [], record: false });
      expect(run.result.passed).toBe(1);
      expect(run.result.failed).toHaveLength(2);
      expect(run.eligibleFailedCount).toBe(0);
      expect(run.failed.every((f) => f.eligible === false)).toBe(true);
      expect(run.summary).toBe("fidelity: 1 passed, 2 failed (0 sync-eligible failures), 3 scanned");
    });
  });

  it("counts only failures under an eligible prefix toward eligibleFailedCount", async () => {
    await withFidelityVault(async (vaultPath) => {
      const run = await runFidelityOnce({ vaultPath, eligiblePrefixes: ["wiki/"], record: false });
      expect(run.eligibleFailedCount).toBe(1);
      const byPath = new Map(run.failed.map((f) => [f.path, f.eligible]));
      expect(byPath.get("wiki/fail.md")).toBe(true);
      expect(byPath.get("desks/orakel/fail.md")).toBe(false);
      expect(run.summary).toBe("fidelity: 1 passed, 2 failed (1 sync-eligible failures), 3 scanned");
    });
  });

  it("treats multiple eligible prefixes independently", async () => {
    await withFidelityVault(async (vaultPath) => {
      const run = await runFidelityOnce({
        vaultPath, eligiblePrefixes: ["wiki/", "desks/orakel/"], record: false,
      });
      expect(run.eligibleFailedCount).toBe(2);
    });
  });
});

describe("runFidelityOnce — record: true persists via replaceFidelity (T3), real Postgres", () => {
  // Same harness store.test.ts uses (agent-box's shared testcontainer helper, which
  // already applies 016_notion_sync_phase3.sql). runFidelityOnce hardcodes
  // poolFromEnv() internally — same as syncWikiOnce/syncAttendeesOnce — so the way
  // to prove its --record wiring for real, without changing that composition, is
  // to point PG* at this container for the duration of the test.
  let tdb: TestDb;
  let db: Pool;
  let prevEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    tdb = await startTestDb();
    db = tdb.pool;
    const url = new URL(tdb.connectionString);
    prevEnv = {
      PGHOST: process.env.PGHOST,
      PGPORT: process.env.PGPORT,
      PGDATABASE: process.env.PGDATABASE,
      PGUSER: process.env.PGUSER,
      PGPASSWORD: process.env.PGPASSWORD,
    };
    process.env.PGHOST = url.hostname;
    process.env.PGPORT = url.port;
    process.env.PGDATABASE = url.pathname.slice(1);
    process.env.PGUSER = decodeURIComponent(url.username);
    process.env.PGPASSWORD = decodeURIComponent(url.password);
  }, 120_000);

  afterAll(async () => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await tdb?.stop();
  });

  it("maps each file's verdict to notion_sync_fidelity exactly: reason present on failure, absent on pass", async () => {
    await withFidelityVault(async (vaultPath) => {
      const run = await runFidelityOnce({ vaultPath, eligiblePrefixes: [], record: true });
      expect(run.result.passed).toBe(1);
      expect(run.result.failed).toHaveLength(2);

      const res = await db.query<{ vault_path: string; passed: boolean; reason: string | null }>(
        `SELECT vault_path, passed, reason FROM notion_sync_fidelity
          WHERE vault_path = ANY($1) ORDER BY vault_path`,
        [["wiki/pass.md", "wiki/fail.md", "desks/orakel/fail.md"]],
      );
      const rows = new Map(res.rows.map((r) => [r.vault_path, r]));

      expect(rows.get("wiki/pass.md")).toEqual({ vault_path: "wiki/pass.md", passed: true, reason: null });
      expect(rows.get("wiki/fail.md")?.passed).toBe(false);
      expect(rows.get("wiki/fail.md")?.reason).toMatch(/body mismatch/);
      expect(rows.get("desks/orakel/fail.md")?.passed).toBe(false);
      expect(rows.get("desks/orakel/fail.md")?.reason).toMatch(/body mismatch/);
    });
  });

  it("does not touch the database at all when record is false", async () => {
    // A vault_path unique to this test — never written by any record:true call in
    // this file — so a row appearing for it can only mean record:false wrote it.
    const vaultPath = await mkdtemp(join(tmpdir(), "notion-sync-fidelity-norecord-"));
    try {
      await writeFile(join(vaultPath, "unrecorded-marker.md"), "nothing to see here\n");
      await runFidelityOnce({ vaultPath, eligiblePrefixes: [], record: false });
      const res = await db.query(
        `SELECT 1 FROM notion_sync_fidelity WHERE vault_path = 'unrecorded-marker.md'`,
      );
      expect(res.rowCount).toBe(0);
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });
});

describe("T6 — the proposals surface (listOpenProposals / approve / reject / resolve)", () => {
  // Own container + its own PG*/NOTION_SYNC_CONFIG/NOTION_TOKEN env, same shape as
  // the "record: true" fidelity block above: every function under test here
  // hardcodes poolFromEnv()/loadNotionSyncConfig() internally, so the only way to
  // drive them for real (without changing that composition) is to point the
  // process env at a real container and a real config file for the duration.
  let tdb: TestDb;
  let db: Pool;
  let vaultPath: string;
  let prevEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    tdb = await startTestDb();
    db = tdb.pool;
    vaultPath = await mkdtemp(join(tmpdir(), "notion-sync-proposals-cli-"));
    await mkdir(join(vaultPath, "desks", "orakel"), { recursive: true });

    await mkdir(join(vaultPath, "wiki"), { recursive: true });
    const cfgPath = join(vaultPath, "config.json");
    await writeFile(cfgPath, JSON.stringify({
      notionVersion: "2026-03-11",
      meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
      docsDataSourceId: "11111111-1111-1111-1111-111111111111",
      wikiDir: "wiki",
      wikiProject: "Portfolio",
      // The desk dir every path in this block lives under — makeDocRender maps a
      // vault path to its dir (and so its Project and its wikilink scope) from
      // exactly this config, the way the real passes do.
      deskDirs: [{ dir: "desks/orakel", project: "Orakel" }],
      twoWayDirs: ["desks/orakel"],
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
  }, 120_000);

  afterAll(async () => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(vaultPath, { recursive: true, force: true });
    await tdb?.stop();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("listOpenProposals", () => {
    // F2 (T6 review): the diff shown is the ONE captured at propose time and
    // persisted (diff_preview) — not a live re-diff against the vault file as
    // it stands now. No vault file is written in this test at all, proving
    // listOpenProposals no longer touches the filesystem to do its job.
    it("pairs each open proposal with its STORED diff preview, not a live re-diff", async () => {
      const id = await insertProposal(db, {
        vaultPath: "desks/orakel/diffable.md",
        notionPageId: "page-diffable",
        proposedBody: "new body line",
        baseMdHash: "base-hash",
        notionHash: "notion-hash",
        diffPreview: "- old body line\n+ new body line",
      });

      const rows = await listOpenProposals();
      const row = rows.find((r) => r.id === id);
      expect(row).toBeDefined();
      expect(row?.vaultPath).toBe("desks/orakel/diffable.md");
      expect(row?.state).toBe("pending");
      expect(row?.diff).toBe("- old body line\n+ new body line");
    });

    it("shows the 016 column default ('') when a proposal was inserted without a diffPreview", async () => {
      const id = await insertProposal(db, {
        vaultPath: "desks/orakel/no-preview.md",
        notionPageId: "page-no-preview",
        proposedBody: "notion content",
        baseMdHash: "base-hash",
        notionHash: "notion-hash",
      });
      const rows = await listOpenProposals();
      expect(rows.find((r) => r.id === id)?.diff).toBe("");
    });
  });

  describe("approveProposal / rejectProposal", () => {
    it("approves the open proposal for a path", async () => {
      const path = "desks/orakel/to-approve.md";
      const id = await insertProposal(db, {
        vaultPath: path, notionPageId: "page-approve",
        proposedBody: "x", baseMdHash: "b", notionHash: "n",
      });
      await approveProposal(path);
      const open = await getOpenProposals(db);
      expect(open.find((p) => p.id === id)?.state).toBe("approved");
    });

    it("rejects the open proposal for a path and touches NOTHING else — no revert, resolved_at stays NULL", async () => {
      const path = "desks/orakel/to-reject.md";
      const id = await insertProposal(db, {
        vaultPath: path, notionPageId: "page-reject",
        proposedBody: "x", baseMdHash: "b", notionHash: "n",
      });
      await rejectProposal(path);
      const res = await db.query<{ state: string; resolved_at: Date | null }>(
        `SELECT state, resolved_at FROM notion_sync_proposals WHERE id = $1`, [id],
      );
      expect(res.rows[0].state).toBe("rejected");
      // The revert is runApplySync's job on its next tick, not the CLI's — see
      // store.ts setProposalState. If this ever stamps resolved_at, the engine
      // would treat an unreverted rejection as already closed and skip it forever.
      expect(res.rows[0].resolved_at).toBeNull();
    });

    it("errors clearly when there is no open proposal for the path", async () => {
      await expect(approveProposal("desks/orakel/never-proposed.md")).rejects.toThrow(/no open proposal/);
      await expect(rejectProposal("desks/orakel/never-proposed.md")).rejects.toThrow(/no open proposal/);
    });

    // The 7th string (fix round 4). The CLI is one of the three sanctioned
    // resolution surfaces, and its reject message was unconditional — "Notion
    // reverts to the vault version on the next tick" — which is false for two of
    // the three outcomes. It survived three rounds because nothing tested it.
    //
    // These pin the DECIDED ROW the command returns, which is what the message is
    // built from; the message itself is `rejectConsequence`'s, shared with every
    // other surface, and its wording is pinned in agent-box's own tests.
    /**
     * Runs the REAL registered command, so the assertion lands on the actual
     * `console.log` line — which is the thing that was wrong. Asserting on
     * `rejectConsequence(row)` instead would only re-test the shared function and
     * would still pass if the command went back to writing its own sentence.
     */
    async function runCliCommand(...argv: string[]): Promise<string> {
      const program = new Command();
      program.exitOverride();
      registerNotionSyncCommands(program);
      const lines: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
      try {
        await program.parseAsync(["node", "lares", "notion-sync", ...argv]);
      } finally {
        log.mockRestore();
      }
      return lines.join("\n");
    }

    it("PRINTS the right consequence for a Notion-owned edit — no revert promised", async () => {
      const path = "desks/orakel/cli-print-owned.md";
      await upsertDocSynced(db, {
        vaultPath: path, pageId: "page-cli-print-owned", mdHash: "h", notionHash: "n",
        notionLastEdited: "2026-08-01T00:00:00.000Z", direction: "notion_to_md",
      });
      await insertProposal(db, {
        vaultPath: path, notionPageId: "page-cli-print-owned",
        proposedBody: "x", baseMdHash: "b", notionHash: "n",
      });

      const output = await runCliCommand("reject", path);

      expect(output).toContain(`rejected ${path}`);
      // The string that stood here for three rounds — "Notion reverts to the vault
      // version on the next tick" — is false for this row: round 2 stopped the
      // engine writing Notion for a Notion-owned document.
      expect(output).not.toMatch(/revert/i);
      expect(output).toMatch(/left as it is/);
      expect(output).toMatch(/nothing is written on either side/);
    }, 30_000);

    it("PRINTS the right consequence for a create — nothing is reverted, nothing in Notion changes", async () => {
      const path = "desks/orakel/cli-print-create.md";
      await insertProposal(db, {
        vaultPath: path, notionPageId: "page-cli-print-create",
        proposedBody: "x", baseMdHash: "", notionHash: "n", kind: "create",
      });

      const output = await runCliCommand("reject", path);

      expect(output).toMatch(/the file is not created/);
      expect(output).toMatch(/nothing in Notion changes/);
      expect(output).not.toMatch(/revert/i);
    }, 30_000);

    it("PRINTS the revert for an ordinary two-way edit — the one case that was always right", async () => {
      const path = "desks/orakel/cli-print-mirror.md";
      await upsertDocSynced(db, {
        vaultPath: path, pageId: "page-cli-print-mirror", mdHash: "h", notionHash: "n",
        notionLastEdited: "2026-08-01T00:00:00.000Z", direction: "two_way",
      });
      await insertProposal(db, {
        vaultPath: path, notionPageId: "page-cli-print-mirror",
        proposedBody: "x", baseMdHash: "b", notionHash: "n",
      });

      const output = await runCliCommand("reject", path);
      expect(output).toMatch(/reverted back to it/);
    }, 30_000);

    it("PRINTS 'created', not 'applies', when approving a create", async () => {
      const path = "desks/orakel/cli-print-approve-create.md";
      await insertProposal(db, {
        vaultPath: path, notionPageId: "page-cli-print-approve-create",
        proposedBody: "x", baseMdHash: "", notionHash: "n", kind: "create",
      });

      const output = await runCliCommand("approve", path);
      expect(output).toMatch(/the file is created in the vault/);
      expect(output).toMatch(/next sync tick/);
    }, 30_000);

    it("does not act on a proposal that is no longer open (already applied)", async () => {
      const path = "desks/orakel/already-applied.md";
      const id = await insertProposal(db, {
        vaultPath: path, notionPageId: "page-applied",
        proposedBody: "x", baseMdHash: "b", notionHash: "n",
      });
      await setProposalState(db, id, "applied");
      await expect(rejectProposal(path)).rejects.toThrow(/no open proposal/);
    });
  });

  describe("resolveFrozenDoc", () => {
    it("errors when there is no doc row for the path", async () => {
      await expect(resolveFrozenDoc("desks/orakel/no-such-row.md", "md")).rejects.toThrow(/no doc row/);
    });

    it("errors when the row is not frozen", async () => {
      const path = "desks/orakel/not-frozen.md";
      await upsertDocSynced(db, {
        vaultPath: path, pageId: "page-not-frozen", mdHash: "h1", notionHash: "n1", notionLastEdited: null,
      });
      await expect(resolveFrozenDoc(path, "md")).rejects.toThrow(/not frozen/);
    });

    // C1(b) (final review): `--keep md` used to unfreeze and hope the push pass
    // would heal the row. It cannot: pull runs FIRST in a tick, re-detects the
    // same two-sided conflict (both stored hashes are stale by definition on a
    // frozen row) and re-freezes — and push skips frozen rows, so it never got a
    // turn. The command has to WRITE the side it chose, exactly as the mirror
    // revert does, and record the hash-after-write reading.
    it("--keep md: overwrites the Notion page from the vault, records both hashes, and unfreezes", async () => {
      const path = "desks/orakel/keep-md.md";
      await writeFile(
        join(vaultPath, "desks", "orakel", "keep-md.md"),
        "---\ntitle: Keep Md\n---\nthe vault's version, which wins\n",
      );
      await upsertDocSynced(db, {
        vaultPath: path, pageId: "pkeepmd", mdHash: "stale-hash-from-before-the-conflict",
        notionHash: sha256("what a human typed in Notion"),
        notionLastEdited: "2026-08-04T09:00:00.000Z", direction: "two_way",
      });
      await freezeDoc(db, path, "changed in both Notion and the vault");
      // An open proposal about the Notion side: choosing the vault decides it.
      const openId = await insertProposal(db, {
        vaultPath: path, notionPageId: "pkeepmd",
        proposedBody: "what a human typed in Notion", baseMdHash: "old", notionHash: "older-notion-hash",
      });

      const fake = makeNotionFetch({
        markdown: { pkeepmd: "what a human typed in Notion" },
        queries: [[{ pageId: "pkeepmd", vaultPath: path, lastEditedTime: "2026-08-04T12:00:00.000Z" }]],
      });
      vi.stubGlobal("fetch", fake.impl);

      const message = await resolveFrozenDoc(path, "md");
      expect(message).toMatch(/kept the vault version/);

      // The body Notion now holds is the vault's, rendered exactly as the push
      // pass would send it.
      const rendered = await makeDocRender(loadNotionSyncConfig(), db).renderDoc(path);
      const contentPatch = fake.requests.find((r) => r.method === "PATCH" && r.path.endsWith("/markdown"));
      expect((contentPatch?.body?.replace_content as { new_str?: string })?.new_str)
        .toBe(rendered.markdown);
      // Properties travel with the body — including the stamp the row's own
      // direction earns, never a guessed one.
      const propsPatch = fake.requests.find((r) => r.method === "PATCH" && r.body?.properties !== undefined);
      expect(propsPatch?.body).toMatchObject({ properties: { Sync: { select: { name: SYNC_DESK } } } });

      const res = await db.query<{
        state: string; frozen_reason: string | null; md_hash: string;
        notion_hash: string; notion_last_edited: Date | null;
      }>(
        `SELECT state, frozen_reason, md_hash, notion_hash, notion_last_edited
           FROM notion_sync_docs WHERE vault_path = $1`, [path],
      );
      expect(res.rows[0].state).toBe("synced");
      expect(res.rows[0].frozen_reason).toBeNull();
      expect(res.rows[0].md_hash).toBe(docRenderHash(rendered));
      // Hash-after-write: what NOTION stored, never the bytes we sent.
      expect(res.rows[0].notion_hash).toBe(sha256(`stored:${rendered.markdown}`));
      // No invented watermark. The store COALESCEs the null through, so the next
      // pull re-reads once, finds the hash equal and stamps an OBSERVED value.
      expect(res.rows[0].notion_last_edited?.toISOString()).toBe("2026-08-04T09:00:00.000Z");

      const proposal = (await db.query<{ state: string }>(
        `SELECT state FROM notion_sync_proposals WHERE id = $1`, [openId],
      )).rows[0];
      expect(proposal.state).toBe("superseded");
    });

    // The one place a human can still push the vault over a Notion-owned page, and
    // the exit the freeze ping used to point them at. It is allowed — this is the
    // manual override on a frozen row, and an operator who has read both sides must
    // not be locked out — but it must never be silent (fix round 3).
    it("--keep md: WARNS before overwriting a Notion-owned page from the vault", async () => {
      const path = "desks/orakel/keep-md-owned.md";
      await writeFile(
        join(vaultPath, "desks", "orakel", "keep-md-owned.md"),
        "---\ntitle: Owned\n---\nthe vault's copy\n",
      );
      await upsertDocSynced(db, {
        vaultPath: path, pageId: "pkeepowned", mdHash: "stale",
        notionHash: sha256("what Notion holds"),
        notionLastEdited: "2026-08-04T09:00:00.000Z", direction: "notion_to_md",
      });
      await freezeDoc(db, path, "changed in both Notion and the vault");
      const fake = makeNotionFetch({
        markdown: { pkeepowned: "what Notion holds" },
        queries: [[{ pageId: "pkeepowned", vaultPath: path, lastEditedTime: "2026-08-04T12:00:00.000Z" }]],
      });
      vi.stubGlobal("fetch", fake.impl);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const message = await resolveFrozenDoc(path, "md");
        // Still performed — a warning, not a refusal.
        expect(message).toMatch(/kept the vault version/);
        const warned = warn.mock.calls.map((c) => String(c[0])).join("\n");
        expect(warned).toMatch(/Notion-owned/);
        expect(warned).toMatch(/OVERWRITE the Notion page/);
        expect(warned).toMatch(/--keep notion/);
      } finally {
        warn.mockRestore();
      }
    }, 30_000);

    it("--keep md: says nothing extra for an ordinary two-way row", async () => {
      const path = "desks/orakel/keep-md-quiet.md";
      await writeFile(
        join(vaultPath, "desks", "orakel", "keep-md-quiet.md"),
        "---\ntitle: Quiet\n---\nthe vault's version\n",
      );
      await upsertDocSynced(db, {
        vaultPath: path, pageId: "pkeepquiet", mdHash: "stale",
        notionHash: sha256("notion side"),
        notionLastEdited: "2026-08-04T09:00:00.000Z", direction: "two_way",
      });
      await freezeDoc(db, path, "changed in both Notion and the vault");
      const fake = makeNotionFetch({
        markdown: { pkeepquiet: "notion side" },
        queries: [[{ pageId: "pkeepquiet", vaultPath: path, lastEditedTime: "2026-08-04T12:00:00.000Z" }]],
      });
      vi.stubGlobal("fetch", fake.impl);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await resolveFrozenDoc(path, "md");
        const warned = warn.mock.calls.map((c) => String(c[0])).join("\n");
        expect(warned).not.toMatch(/Notion-owned/);
      } finally {
        warn.mockRestore();
      }
    }, 30_000);

    it("--keep md: a failed Notion write leaves the row frozen and says which step failed", async () => {
      const path = "desks/orakel/keep-md-fails.md";
      await writeFile(
        join(vaultPath, "desks", "orakel", "keep-md-fails.md"),
        "---\ntitle: Fails\n---\nthe vault's version\n",
      );
      await upsertDocSynced(db, {
        vaultPath: path, pageId: "pkeepmdfails", mdHash: "stale", notionHash: "n1",
        notionLastEdited: null, direction: "two_way",
      });
      await freezeDoc(db, path, "changed in both Notion and the vault");

      vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

      await expect(resolveFrozenDoc(path, "md")).rejects.toThrow(/stays frozen/);
      const res = await db.query<{ state: string }>(
        `SELECT state FROM notion_sync_docs WHERE vault_path = $1`, [path],
      );
      expect(res.rows[0].state).toBe("frozen");
    }, 30_000);

    it("--keep notion: reads the live page, forces a proposal, supersedes any open one, and unfreezes", async () => {
      const path = "desks/orakel/keep-notion.md";
      // A real vault file, deliberately NOT matching the stored md_hash below —
      // that mismatch IS the conflict-freeze condition (pull-sync.ts
      // proposeDesk), so this fixture must mirror it rather than special-case
      // it away, or the test would not be exercising the state resolve
      // actually runs against (F1: baseMdHash must be a FRESH render, not the
      // stale stored value — see the "converges through approve+apply" test
      // below for the full loop this enables).
      await writeFile(
        join(vaultPath, "desks", "orakel", "keep-notion.md"),
        "---\ntitle: Keep Notion\n---\nthe vault's current body\n",
      );
      await upsertDocSynced(db, {
        vaultPath: path, pageId: "page-keep-notion", mdHash: "stale-hash-from-before-the-conflict",
        notionHash: "n1", notionLastEdited: null,
      });
      await freezeDoc(db, path, "changed in both Notion and the vault");
      const staleId = await insertProposal(db, {
        vaultPath: path, notionPageId: "page-keep-notion",
        proposedBody: "an earlier, now-stale proposal", baseMdHash: "old", notionHash: "old-notion-hash",
      });

      const fetchSpy = vi.fn(async (url: string) => {
        expect(url).toBe("https://api.notion.com/v1/pages/page-keep-notion/markdown");
        return new Response(JSON.stringify({ markdown: "current Notion body", truncated: false }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchSpy);

      const message = await resolveFrozenDoc(path, "notion");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(message).toMatch(/forced proposal/);
      expect(message).toContain(path);

      const open = await getOpenProposals(db);
      const forced = open.find((p) => p.vaultPath === path);
      expect(forced).toBeDefined();
      expect(forced?.state).toBe("pending");
      expect(forced?.proposedBody).toBe("current Notion body");
      // A FRESH render of the vault file as it stands right now (F1 fix) —
      // NOT the row's stale stored md_hash, and specifically NOT equal to it:
      // this row is frozen exactly because those two differ.
      expect(forced?.baseMdHash)
        .toBe(docRenderHash(await makeDocRender(loadNotionSyncConfig(), db).renderDoc(path)));
      expect(forced?.baseMdHash).not.toBe("stale-hash-from-before-the-conflict");
      // F2: a forced proposal gets a diff preview too — current vault body vs
      // the proposed (reverse-translated) Notion content — persisted for the
      // console, which has no vault mount to derive one of its own.
      expect(forced?.diffPreview).toContain("- the vault's current body");
      expect(forced?.diffPreview).toContain("+ current Notion body");

      const staleRow = (await db.query<{ state: string }>(
        `SELECT state FROM notion_sync_proposals WHERE id = $1`, [staleId],
      )).rows[0];
      expect(staleRow.state).toBe("superseded");

      const docRow = (await db.query<{ state: string }>(
        `SELECT state FROM notion_sync_docs WHERE vault_path = $1`, [path],
      )).rows[0];
      expect(docRow.state).toBe("synced");
    });

    // F1 (review finding): the seam listOpenProposals/approveProposal/
    // resolveFrozenDoc's own unit tests could not see — whether the forced
    // proposal actually converges once a human approves it and the engine
    // (runApplySync, T7) applies it for real. Runs the FULL loop against the
    // real store and a real filesystem: freeze a row in genuine conflict
    // shape (vault content does not match the row's stored md_hash — the
    // conflict-freeze condition itself), resolve --keep notion, approve, then
    // hand the result to runApplySync wired with real deps. Before the fix
    // this always superseded-and-refroze on the first approval, because
    // baseMdHash was seeded from the same stale md_hash that caused the
    // freeze in the first place.
    it("F1 — converges through a real approve+apply cycle: the applied vault file gets Notion's content", async () => {
      const path = "desks/orakel/converge.md";
      const absPath = join(vaultPath, "desks", "orakel", "converge.md");

      await writeFile(absPath, "---\ntitle: Converge\n---\noriginal vault body\n");
      await upsertDocSynced(db, {
        vaultPath: path, pageId: "page-converge",
        mdHash: "stale-hash-from-before-the-conflict",
        notionHash: "old-notion-hash", notionLastEdited: null, direction: "two_way",
      });
      // The edit that (together with a Notion-side edit) produced the
      // conflict: the file now differs from the row's stored md_hash for real.
      await writeFile(absPath, "---\ntitle: Converge\n---\nvault body, edited after the last sync\n");
      await freezeDoc(db, path, "changed in both Notion and the vault");

      const fetchSpy = vi.fn(async () => new Response(
        JSON.stringify({ markdown: "Notion's current body", truncated: false }), { status: 200 },
      ));
      vi.stubGlobal("fetch", fetchSpy);

      const resolveMessage = await resolveFrozenDoc(path, "notion");
      expect(resolveMessage).toMatch(/forced proposal/);

      await approveProposal(path);

      // Scoped to THIS test's own row/proposal: the "T6" describe block
      // shares one database across every test in this file (see its
      // beforeAll), and earlier tests (approveProposal/rejectProposal) leave
      // rows behind with no vault files backing them — an unscoped
      // getOpenProposals/getDeskRows would hand those to runApplySync too,
      // making the aggregate result.applied/superseded/frozen counts below
      // depend on execution order instead of on this test's own scenario.
      const result = await runApplySync({ dryRun: false, inCreateScope: makeCreateScope({}) }, {
        getOpenProposals: async () => (await getOpenProposals(db)).filter((p) => p.vaultPath === path),
        getRejectedUnexecuted: async () =>
          (await getRejectedUnexecuted(db)).filter((p) => p.vaultPath === path),
        getLinkedRows: async () => {
          const rows = await getDeskRows(db);
          const row = rows.get(path);
          return row === undefined ? new Map() : new Map([[path, { ...row, target: "docs" as const }]]);
        },
        // The SAME composition resolveFrozenDoc used to seed baseMdHash — the
        // exact seam this test exists to prove agrees with itself.
        renderDoc: makeDocRender(loadNotionSyncConfig(), db).renderDoc,
        readVaultFile: (p) => readFile(join(vaultPath, p), "utf8"),
        writeVaultFile: async (p, content) => {
          await writeFile(join(vaultPath, p), content, "utf8");
        },
        vaultFileExists: async () => { throw new Error("not expected: no create proposals in this test"); },
        createVaultFile: async () => { throw new Error("not expected: no create proposals in this test"); },
        listCollisionCandidates: async () => { throw new Error("not expected: no create proposals in this test"); },
        patchPageMarkdown: async () => { throw new Error("not expected: no rejected proposals in this test"); },
        updateDocProps: async () => { throw new Error("not expected: no rejected proposals in this test"); },
        getPageMarkdown: async () => { throw new Error("not expected: no rejected proposals in this test"); },
        upsertDocSynced: (doc) => upsertDocSynced(db, doc),
        linkPageToVaultFile: (doc) => linkPageToVaultFile(db, doc),
        updateNotionWatermark: async () => { throw new Error("not expected: no notion-owned rows in this test"); },
        recordNotionAccounted: async () => { throw new Error("not expected: no create proposals in this test"); },
        setProposalState: (id, state) => setProposalState(db, id, state),
        markProposalReverted: (id) => markProposalReverted(db, id),
        freezeDoc: (p, reason) => freezeDoc(db, p, reason),
        recordDocError: (p, message) => recordDocError(db, p, message),
        notify: async () => {},
        // Not this test's concern — no create proposals here; the forget-ledger gate
        // is covered end to end in tests/forget-ledger-gate.test.ts.
        pathWasForgotten: async () => { throw new Error("not expected: no create proposals in this test"); },
      });

      // The bug: this used to be `{ applied: 0, superseded: 1, frozen: 1 }` —
      // the forced proposal re-froze itself on its first approval, forever.
      expect(result.applied).toBe(1);
      expect(result.superseded).toBe(0);
      expect(result.frozen).toBe(0);

      const written = await readFile(absPath, "utf8");
      expect(written).toContain("Notion's current body");
      // The frontmatter block is read verbatim from disk at apply time
      // (apply-sync.ts), never from the proposal — it must survive untouched.
      expect(written).toContain("title: Converge");

      const proposalRow = (await db.query<{ state: string }>(
        `SELECT state FROM notion_sync_proposals WHERE vault_path = $1 ORDER BY created_at DESC LIMIT 1`,
        [path],
      )).rows[0];
      expect(proposalRow.state).toBe("applied");
    });
  });
});

// ---------------------------------------------------------------------------
// T7 — the shared render and the two rollout commands, against a real Postgres
// and a fake Notion. Every function under test hardcodes poolFromEnv() /
// loadNotionSyncConfig() internally (the composition-root shape this package
// uses everywhere), so the way to drive them for real is to point the process
// env at a container, a temp vault and a real config file for the block.
// ---------------------------------------------------------------------------

describe("T7 — makeDocRender, reconcile and enable-two-way (real Postgres, fake Notion)", () => {
  let tdb: TestDb;
  let db: Pool;
  let vaultPath: string;
  let prevEnv: Record<string, string | undefined>;

  const DESK = "desks/orakel";
  // W4D-s3: runEnableTwoWay's live leg now also refuses a file with no lares_origin
  // stamp (a pull would otherwise leave it with no origin at all). Fixtures below
  // that predate that rule and are meant to reach the live-leg body comparison get
  // this prefixed so they still test what they were written to test.
  const STAMP = "---\nlares_origin: synced\n---\n\n";

  beforeAll(async () => {
    tdb = await startTestDb();
    db = tdb.pool;
    vaultPath = await mkdtemp(join(tmpdir(), "notion-sync-t7-"));
    await mkdir(join(vaultPath, DESK), { recursive: true });
    await mkdir(join(vaultPath, "wiki"), { recursive: true });

    const cfgPath = join(vaultPath, "config.json");
    await writeFile(cfgPath, JSON.stringify({
      notionVersion: "2026-03-11",
      meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
      docsDataSourceId: "11111111-1111-1111-1111-111111111111",
      wikiDir: "wiki",
      wikiProject: "Portfolio",
      deskDirs: [{ dir: DESK, project: "Orakel" }],
      twoWayDirs: [DESK],
      mirrorFilePrefixes: [`${DESK}/ghost__`],
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
  }, 120_000);

  afterAll(async () => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(vaultPath, { recursive: true, force: true });
    await tdb?.stop();
  });

  // reconcile and the desk push act on EVERY doc row in the store, so each test
  // has to own the table outright — a row another test left behind would be read,
  // stamped and (missing from that test's query) treated as a deleted page.
  beforeEach(async () => {
    await db.query("DELETE FROM notion_sync_proposals");
    await db.query("DELETE FROM notion_sync_docs");
    await db.query("DELETE FROM notion_sync_fidelity");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("makeDocRender — the ONE render every hash comparison goes through", () => {
    it("resolves wikilinks through the push pass's own resolver, scoped to the file's dir", async () => {
      await writeFile(join(vaultPath, DESK, "target.md"), "# Target\n\nbody\n");
      await writeFile(join(vaultPath, DESK, "linker.md"), "See [[target]] here.\n");
      await upsertDocSynced(db, {
        vaultPath: `${DESK}/target.md`, pageId: "ptarget", mdHash: "h", notionHash: "n", notionLastEdited: null,
      });
      await upsertDocSynced(db, {
        vaultPath: `${DESK}/linker.md`, pageId: "plinker", mdHash: "h", notionHash: "n", notionLastEdited: null,
      });

      const rendered = await makeDocRender(loadNotionSyncConfig(), db).renderDoc(`${DESK}/linker.md`);

      // A resolver-free render would leave "See \[\[target\]\] here." — which is
      // what made every wikilinked desk file read as a two-sided conflict before
      // this composition was shared (T6 re-review).
      expect(rendered.markdown)
        .toBe('See <mention-page url="https://www.notion.so/ptarget">Target</mention-page> here.');
      expect(rendered.props).toMatchObject({
        name: "linker",
        project: "Orakel",
        folder: DESK,
        vaultPath: `${DESK}/linker.md`,
        archived: false,
      });
    });

    it("stamps Sync from the row's CURRENT direction, both ways", async () => {
      await writeFile(join(vaultPath, DESK, "mirror-row.md"), "# Mirror\n\nbody\n");
      await writeFile(join(vaultPath, DESK, "desk-row.md"), "# Desk\n\nbody\n");
      await upsertDocSynced(db, {
        vaultPath: `${DESK}/mirror-row.md`, pageId: "pmirrorrow", mdHash: "h", notionHash: "n",
        notionLastEdited: null,
      });
      await upsertDocSynced(db, {
        vaultPath: `${DESK}/desk-row.md`, pageId: "pdeskrow", mdHash: "h", notionHash: "n",
        notionLastEdited: null, direction: "two_way",
      });

      const render = makeDocRender(loadNotionSyncConfig(), db);
      expect((await render.renderDoc(`${DESK}/mirror-row.md`)).props.sync).toBe(SYNC_MIRROR);
      expect((await render.renderDoc(`${DESK}/desk-row.md`)).props.sync).toBe(SYNC_DESK);
    });

    it("refuses a path outside every configured sync directory rather than guessing a Project", async () => {
      await expect(makeDocRender(loadNotionSyncConfig(), db).renderDoc("raw/notes.md"))
        .rejects.toThrow(/not under any configured sync directory/);
    });
  });

  describe("runReconcile — §18.5 ordering: read, then stamp, then baseline", () => {
    it("reads an unbaselined row the tick would skip, stamps it, and baselines from the LATER query", async () => {
      await writeFile(join(vaultPath, DESK, "rec.md"), "# Rec\n\nbody\n");
      const stored = "notion body";
      await upsertDocSynced(db, {
        vaultPath: `${DESK}/rec.md`, pageId: "prec", mdHash: "h",
        // Hash-equal, so the read pass has nothing to revert — this test is about
        // WHICH rows get read and WHEN the baseline is taken, not about reverting.
        notionHash: sha256(stored),
        // NULL: the routine tick skips this row as unbaselined. reconcile must not.
        notionLastEdited: null,
      });

      const fake = makeNotionFetch({
        markdown: { prec: stored },
        queries: [
          [{ pageId: "prec", vaultPath: `${DESK}/rec.md`, lastEditedTime: "2026-08-04T10:00:00.000Z" }],
          // The stamping writes bump last_edited_time — this is that bump.
          [{ pageId: "prec", vaultPath: `${DESK}/rec.md`, lastEditedTime: "2026-08-04T11:00:00.000Z" }],
        ],
      });
      vi.stubGlobal("fetch", fake.impl);

      const result = await runReconcile({ dryRun: false });
      expect(result).not.toBeNull();
      expect(result?.pull.read).toBe(1);
      expect(result?.stamped).toBe(1);
      expect(result?.stampFailed).toBe(0);
      expect(result?.baselined).toBe(1);

      // The mirror stamp: icon + lock as top-level PATCH fields, Sync as a property.
      const metaPatch = fake.requests.find((r) => r.method === "PATCH" && r.body?.is_locked !== undefined);
      expect(metaPatch?.body).toMatchObject({ is_locked: true, icon: { type: "emoji", emoji: "🔒" } });
      const propsPatch = fake.requests.find((r) => r.method === "PATCH" && r.body?.properties !== undefined);
      expect(propsPatch?.body).toMatchObject({ properties: { Sync: { select: { name: SYNC_MIRROR } } } });

      // The ordering rule itself: the query the baseline comes from is the one
      // taken AFTER the stamping, not the one the read pass used.
      const queryIdx = fake.requests
        .map((r, i) => (r.path.endsWith("/query") ? i : -1)).filter((i) => i >= 0);
      const lastPatchIdx = fake.requests.map((r, i) => (r.method === "PATCH" ? i : -1))
        .filter((i) => i >= 0).pop() ?? -1;
      expect(queryIdx).toHaveLength(2);
      expect(queryIdx[1]).toBeGreaterThan(lastPatchIdx);

      const row = (await db.query<{ notion_last_edited: Date }>(
        `SELECT notion_last_edited FROM notion_sync_docs WHERE vault_path = $1`, [`${DESK}/rec.md`],
      )).rows[0];
      expect(row.notion_last_edited.toISOString()).toBe("2026-08-04T11:00:00.000Z");
    }, 30_000);

    it("clears the lock and the icon on a row that is already two-way — a re-run must not re-lock the pilot", async () => {
      await writeFile(join(vaultPath, DESK, "pilot.md"), "# Pilot\n\nbody\n");
      const stored = "pilot body";
      await upsertDocSynced(db, {
        vaultPath: `${DESK}/pilot.md`, pageId: "ppilot", mdHash: "h",
        notionHash: sha256(stored), notionLastEdited: "2026-08-04T09:00:00.000Z", direction: "two_way",
      });
      const fake = makeNotionFetch({
        markdown: { ppilot: stored },
        queries: [[{ pageId: "ppilot", vaultPath: `${DESK}/pilot.md`, lastEditedTime: "2026-08-04T10:00:00.000Z" }]],
      });
      vi.stubGlobal("fetch", fake.impl);

      await runReconcile({ dryRun: false });

      const metaPatch = fake.requests.find((r) => r.method === "PATCH" && r.body?.is_locked !== undefined);
      expect(metaPatch?.body).toMatchObject({ is_locked: false, icon: null });
      const propsPatch = fake.requests.find((r) => r.method === "PATCH" && r.body?.properties !== undefined);
      expect(propsPatch?.body).toMatchObject({ properties: { Sync: { select: { name: SYNC_DESK } } } });
    }, 30_000);

    // The polarity, pinned in all three directions (fix round 2). The lock is a
    // speed bump meaning "your edit here will be reverted"; it belongs to MIRROR
    // rows only. The test used to be `!isDesk`, which locked Notion-owned pages —
    // the one kind whose entire purpose is that Bendik writes them in Notion.
    it("locks and 🔒-icons a MIRROR row, and neither a two-way nor a Notion-owned one", async () => {
      const cases: Array<[string, string, boolean, string]> = [
        ["md_to_notion", "pmirror", true, SYNC_MIRROR],
        ["two_way", "ptwoway", false, SYNC_DESK],
        ["notion_to_md", "powned", false, SYNC_SOURCE],
      ];
      for (const [direction, pageId, expectLocked, expectStamp] of cases) {
        await db.query("DELETE FROM notion_sync_docs");
        const name = `polarity-${pageId}`;
        await writeFile(join(vaultPath, DESK, `${name}.md`), `# P\n\nbody\n`);
        const stored = "body";
        await upsertDocSynced(db, {
          vaultPath: `${DESK}/${name}.md`, pageId, mdHash: "h",
          notionHash: sha256(stored), notionLastEdited: "2026-08-04T09:00:00.000Z", direction,
        });
        const fake = makeNotionFetch({
          markdown: { [pageId]: stored },
          queries: [[{ pageId, vaultPath: `${DESK}/${name}.md`, lastEditedTime: "2026-08-04T10:00:00.000Z" }]],
        });
        vi.stubGlobal("fetch", fake.impl);

        await runReconcile({ dryRun: false });

        const metaPatch = fake.requests.find((r) => r.method === "PATCH" && r.body?.is_locked !== undefined);
        expect(metaPatch?.body, `is_locked for ${direction}`).toMatchObject({
          is_locked: expectLocked,
          icon: expectLocked ? { type: "emoji", emoji: "🔒" } : null,
        });
        const propsPatch = fake.requests.find((r) => r.method === "PATCH" && r.body?.properties !== undefined);
        expect(propsPatch?.body, `stamp for ${direction}`)
          .toMatchObject({ properties: { Sync: { select: { name: expectStamp } } } });
        vi.unstubAllGlobals();
      }
    }, 60_000);

    it("dry-run reads and reports but writes nothing at all", async () => {
      await writeFile(join(vaultPath, DESK, "dry.md"), "# Dry\n\nbody\n");
      const stored = "dry body";
      await upsertDocSynced(db, {
        vaultPath: `${DESK}/dry.md`, pageId: "pdry", mdHash: "h",
        notionHash: sha256(stored), notionLastEdited: null,
      });
      const fake = makeNotionFetch({
        markdown: { pdry: stored },
        queries: [[{ pageId: "pdry", vaultPath: `${DESK}/dry.md`, lastEditedTime: "2026-08-04T10:00:00.000Z" }]],
      });
      vi.stubGlobal("fetch", fake.impl);

      const result = await runReconcile({ dryRun: true });
      expect(result?.stamped).toBe(0);
      expect(result?.baselined).toBe(0);
      expect(fake.requests.filter((r) => r.method === "PATCH")).toEqual([]);
      const row = (await db.query<{ notion_last_edited: Date | null }>(
        `SELECT notion_last_edited FROM notion_sync_docs WHERE vault_path = $1`, [`${DESK}/dry.md`],
      )).rows[0];
      expect(row.notion_last_edited).toBeNull();
    }, 30_000);
  });

  describe("runEnableTwoWay — both fidelity legs, per file", () => {
    it("enables only what passes, reports every skip with its reason, and never touches the rest", async () => {
      const files: Array<[name: string, pageId: string, vault: string, live: string]> = [
        // Passes both legs: the live markdown reverse-translates back to the file.
        ["ok.md", "pok", `${STAMP}hello\n`, "hello"],
        // Fidelity table says nothing about it — "not checked" is not "fine".
        ["nofid.md", "pnofid", `${STAMP}hello\n`, "hello"],
        // Mirror by config, whatever the gate says (plan decision 8).
        ["ghost__post.md", "pghost", `${STAMP}hello\n`, "hello"],
        // Passes offline, fails live: Notion's own serialisation differs.
        ["drift.md", "pdrift", `${STAMP}hello\n`, "something else entirely"],
        // Passes both legs, but ONLY through normalisation: the vault file is
        // spaced tight, the pulled body comes back canonical. Enabling it is
        // right; doing so silently is not — the first apply rewrites its spacing.
        ["reflow.md", "preflow", `${STAMP}# Title\nprose\n`, "# Title\nprose"],
      ];
      for (const [name, pageId, vault] of files) {
        await writeFile(join(vaultPath, DESK, name), vault);
        await upsertDocSynced(db, {
          vaultPath: `${DESK}/${name}`, pageId, mdHash: "h", notionHash: "n",
          notionLastEdited: "2026-08-04T09:00:00.000Z",
        });
      }
      await replaceFidelity(db, [
        { vaultPath: `${DESK}/ok.md`, passed: true },
        { vaultPath: `${DESK}/ghost__post.md`, passed: true },
        { vaultPath: `${DESK}/drift.md`, passed: true },
        { vaultPath: `${DESK}/reflow.md`, passed: true },
      ]);

      const fake = makeNotionFetch({
        markdown: Object.fromEntries(files.map(([, pageId, , live]) => [pageId, live])),
        queries: [files.map(([name, pageId]) => ({
          pageId, vaultPath: `${DESK}/${name}`, lastEditedTime: "2026-08-04T12:00:00.000Z",
        }))],
      });
      vi.stubGlobal("fetch", fake.impl);

      const result = await runEnableTwoWay(DESK, { dryRun: false });

      expect(result.enabled).toEqual([`${DESK}/ok.md`, `${DESK}/reflow.md`]);
      // Only the one that passed on normalisation alone is flagged: the operator
      // sees which files a first apply will re-space before flipping them.
      expect(result.reflowed).toEqual([`${DESK}/reflow.md`]);
      expect(result.summary).toContain("1 will reflow");
      const reasons = new Map(result.skipped.map((s) => [s.vaultPath, s.reason]));
      expect(reasons.get(`${DESK}/nofid.md`)).toMatch(/fidelity/);
      expect(reasons.get(`${DESK}/ghost__post.md`)).toMatch(/mirrorFilePrefixes/);
      expect(reasons.get(`${DESK}/drift.md`)).toMatch(/live round-trip differs/);

      const rows = await db.query<{ vault_path: string; direction: string; notion_last_edited: Date | null }>(
        `SELECT vault_path, direction, notion_last_edited FROM notion_sync_docs ORDER BY vault_path`,
      );
      const byPath = new Map(rows.rows.map((r) => [r.vault_path, r]));
      expect(byPath.get(`${DESK}/ok.md`)?.direction).toBe("two_way");
      for (const name of ["nofid.md", "ghost__post.md", "drift.md"]) {
        expect(byPath.get(`${DESK}/${name}`)?.direction).toBe("md_to_notion");
      }
      // A3: the watermark is a real observed reading, taken after the writes above.
      expect(byPath.get(`${DESK}/ok.md`)?.notion_last_edited?.toISOString())
        .toBe("2026-08-04T12:00:00.000Z");
      // …paired with the hash of the content that was actually read.
      const hash = (await db.query<{ notion_hash: string }>(
        `SELECT notion_hash FROM notion_sync_docs WHERE vault_path = $1`, [`${DESK}/ok.md`],
      )).rows[0].notion_hash;
      expect(hash).toBe(sha256("hello"));

      // The unlock is part of enabling: a page that is now editable must not keep
      // advertising a lock (§18.1).
      const metaPatch = fake.requests.find((r) => r.method === "PATCH" && r.body?.is_locked !== undefined);
      expect(metaPatch?.body).toMatchObject({ is_locked: false, icon: null });
      const propsPatch = fake.requests.find((r) => r.method === "PATCH" && r.body?.properties !== undefined);
      expect(propsPatch?.body).toMatchObject({ properties: { Sync: { select: { name: SYNC_DESK } } } });
      // Skipped rows are skipped BEFORE the page is even read, except the one
      // whose live leg had to be read to fail it — so: ok, reflow, drift.
      expect(fake.requests.filter((r) => r.path.endsWith("/markdown") && r.method === "GET"))
        .toHaveLength(3);
    }, 30_000);

    // W4D-s3: the live leg refuses a file with no lares_origin stamp, exactly as
    // lib/fidelity.ts's offline gate does — a stale "passed" fidelity row must not
    // let a pull silently drop a file's provenance.
    it("refuses to enable a file with no lares_origin stamp, naming what would be lost", async () => {
      await writeFile(join(vaultPath, DESK, "nostamp.md"), "hello\n");
      await upsertDocSynced(db, {
        vaultPath: `${DESK}/nostamp.md`, pageId: "pnostamp", mdHash: "h", notionHash: "n",
        notionLastEdited: "2026-08-04T09:00:00.000Z",
      });
      await replaceFidelity(db, [{ vaultPath: `${DESK}/nostamp.md`, passed: true }]);
      const fake = makeNotionFetch({ markdown: { pnostamp: "hello" }, queries: [[]] });
      vi.stubGlobal("fetch", fake.impl);

      const result = await runEnableTwoWay(DESK, { dryRun: false });

      expect(result.enabled).toEqual([]);
      expect(result.skipped[0].reason).toMatch(/no origin at all/);
      const row = (await db.query<{ direction: string }>(
        `SELECT direction FROM notion_sync_docs WHERE vault_path = $1`, [`${DESK}/nostamp.md`],
      )).rows[0];
      expect(row.direction).toBe("md_to_notion");
    }, 30_000);

    // F2 (T7 review): the store flip and the two Notion writes cannot be one
    // transaction, so both halves of the recovery story need proving — a failure
    // must not abandon the rest of the dir, and a re-run must repair what it left.
    it("contains a mid-dir failure: the row is reported, the following files still get enabled", async () => {
      for (const [name, pageId] of [["a-fails.md", "pafails"], ["b-ok.md", "pbok"]]) {
        await writeFile(join(vaultPath, DESK, name), `${STAMP}hello\n`);
        await upsertDocSynced(db, {
          vaultPath: `${DESK}/${name}`, pageId, mdHash: "h", notionHash: "n",
          notionLastEdited: "2026-08-04T09:00:00.000Z",
        });
        await replaceFidelity(db, [{ vaultPath: `${DESK}/${name}`, passed: true }]);
      }

      const fake = makeNotionFetch({
        markdown: { pafails: "hello", pbok: "hello" },
        queries: [[{ pageId: "pbok", vaultPath: `${DESK}/b-ok.md`, lastEditedTime: "2026-08-04T12:00:00.000Z" }]],
      });
      // The first row's unlock PATCH fails; everything else behaves.
      const failing = vi.fn(async (url: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "PATCH" && new URL(url).pathname === "/v1/pages/pafails") {
          return new Response("gone", { status: 404 });
        }
        return fake.impl(url, init);
      });
      vi.stubGlobal("fetch", failing);

      const result = await runEnableTwoWay(DESK, { dryRun: false });

      expect(result.enabled).toEqual([`${DESK}/b-ok.md`]);
      expect(result.skipped.find((s) => s.vaultPath === `${DESK}/a-fails.md`)?.reason)
        .toMatch(/enable failed \(re-run to repair\)/);
      const rows = await db.query<{ vault_path: string; direction: string }>(
        `SELECT vault_path, direction FROM notion_sync_docs ORDER BY vault_path`,
      );
      const byPath = new Map(rows.rows.map((r) => [r.vault_path, r.direction]));
      // The failed row IS two-way in the store with Notion still locked — the exact
      // half-flipped state the next test repairs.
      expect(byPath.get(`${DESK}/a-fails.md`)).toBe("two_way");
      expect(byPath.get(`${DESK}/b-ok.md`)).toBe("two_way");
    }, 30_000);

    it("re-run repairs a half-flipped row: an already-two-way row is re-asserted, not skipped", async () => {
      await writeFile(join(vaultPath, DESK, "half.md"), "hello\n");
      // two_way in the store, but Notion never got the unlock — what a failure
      // between the two writes leaves behind. The stored hash MATCHES what the
      // page holds: nothing was edited in Notion, so the baseline below is a
      // watermark repair and not the absorption C2 forbids.
      await upsertDocSynced(db, {
        vaultPath: `${DESK}/half.md`, pageId: "phalf", mdHash: "h", notionHash: sha256("hello"),
        notionLastEdited: "2026-08-04T09:00:00.000Z", direction: "two_way",
      });

      const fake = makeNotionFetch({
        markdown: { phalf: "hello" },
        queries: [[{ pageId: "phalf", vaultPath: `${DESK}/half.md`, lastEditedTime: "2026-08-04T12:00:00.000Z" }]],
      });
      vi.stubGlobal("fetch", fake.impl);

      const result = await runEnableTwoWay(DESK, { dryRun: false });

      expect(result.skipped[0].reason).toMatch(/re-asserted/);
      const metaPatch = fake.requests.find((r) => r.method === "PATCH" && r.body?.is_locked !== undefined);
      expect(metaPatch?.body).toMatchObject({ is_locked: false, icon: null });
      const propsPatch = fake.requests.find((r) => r.method === "PATCH" && r.body?.properties !== undefined);
      expect(propsPatch?.body).toMatchObject({ properties: { Sync: { select: { name: SYNC_DESK } } } });
      // Re-asserted rows are baselined too — the repair leaves nothing half-done.
      const row = (await db.query<{ notion_hash: string; notion_last_edited: Date | null }>(
        `SELECT notion_hash, notion_last_edited FROM notion_sync_docs WHERE vault_path = $1`,
        [`${DESK}/half.md`],
      )).rows[0];
      expect(row.notion_hash).toBe(sha256("hello"));
      expect(row.notion_last_edited?.toISOString()).toBe("2026-08-04T12:00:00.000Z");
    }, 30_000);

    // C2 (final review): the re-assert branch baselined from the page it had just
    // read, whatever that page held. On a row whose page a human edited since the
    // last pull, that stored the edit's own hash as the "seen" baseline — pull
    // then compared the edit against itself, found no change, and the edit was
    // gone forever. A re-assert may only baseline content the store already knew.
    it("never absorbs a pending Notion edit on re-assert: no baseline, reported, left for pull", async () => {
      const path = `${DESK}/pending-edit.md`;
      await writeFile(join(vaultPath, DESK, "pending-edit.md"), "the vault's body\n");
      await upsertDocSynced(db, {
        vaultPath: path, pageId: "ppending", mdHash: "h",
        // What the last pull saw. The page now holds something else entirely.
        notionHash: sha256("the body the last pull saw"),
        notionLastEdited: "2026-08-04T09:00:00.000Z", direction: "two_way",
      });
      // Keep the row's md_hash honest so the pull pass below proposes rather than
      // freezing: only the NOTION side has moved in this scenario.
      const renderHash = docRenderHash(await makeDocRender(loadNotionSyncConfig(), db).renderDoc(path));
      await db.query(`UPDATE notion_sync_docs SET md_hash = $2 WHERE vault_path = $1`, [path, renderHash]);

      const humanEdit = "a human edit nobody has ruled on yet";
      const fake = makeNotionFetch({
        markdown: { ppending: humanEdit },
        queries: [[{ pageId: "ppending", vaultPath: path, lastEditedTime: "2026-08-04T12:00:00.000Z" }]],
      });
      vi.stubGlobal("fetch", fake.impl);

      const result = await runEnableTwoWay(DESK, { dryRun: false });
      expect(result.skipped[0].reason).toMatch(/pending Notion edit/);

      const row = (await db.query<{ notion_hash: string; notion_last_edited: Date | null }>(
        `SELECT notion_hash, notion_last_edited FROM notion_sync_docs WHERE vault_path = $1`, [path],
      )).rows[0];
      expect(row.notion_hash).toBe(sha256("the body the last pull saw"));
      expect(row.notion_last_edited?.toISOString()).toBe("2026-08-04T09:00:00.000Z");

      // …and the pull pass right after picks the edit up as an ordinary proposal,
      // which is the whole point of not absorbing it.
      const pull = await syncPullOnce({ dryRun: false });
      expect(pull?.proposed).toBe(1);
      const open = await getOpenProposals(db);
      expect(open.find((p) => p.vaultPath === path)?.proposedBody).toBe(humanEdit);
    }, 30_000);

    it("skips a frozen row — enabling write-back on a conflict a human owns is not this command's call", async () => {
      await writeFile(join(vaultPath, DESK, "frozen.md"), "hello\n");
      await upsertDocSynced(db, {
        vaultPath: `${DESK}/frozen.md`, pageId: "pfrozen", mdHash: "h", notionHash: "n",
        notionLastEdited: "2026-08-04T09:00:00.000Z",
      });
      await freezeDoc(db, `${DESK}/frozen.md`, "changed in both Notion and the vault");
      await replaceFidelity(db, [{ vaultPath: `${DESK}/frozen.md`, passed: true }]);

      const fake = makeNotionFetch({ markdown: { pfrozen: "hello" }, queries: [[]] });
      vi.stubGlobal("fetch", fake.impl);

      const result = await runEnableTwoWay(DESK, { dryRun: false });
      expect(result.enabled).toEqual([]);
      expect(result.skipped[0].reason).toMatch(/state is 'frozen'/);
      expect(fake.requests).toEqual([]);
    }, 30_000);

    it("dry-run reports what would be enabled and writes nothing", async () => {
      await writeFile(join(vaultPath, DESK, "dry-enable.md"), `${STAMP}hello\n`);
      await upsertDocSynced(db, {
        vaultPath: `${DESK}/dry-enable.md`, pageId: "pdryenable", mdHash: "h", notionHash: "n",
        notionLastEdited: "2026-08-04T09:00:00.000Z",
      });
      await replaceFidelity(db, [{ vaultPath: `${DESK}/dry-enable.md`, passed: true }]);
      const fake = makeNotionFetch({ markdown: { pdryenable: "hello" }, queries: [[]] });
      vi.stubGlobal("fetch", fake.impl);

      const result = await runEnableTwoWay(DESK, { dryRun: true });
      expect(result.enabled).toEqual([`${DESK}/dry-enable.md`]);
      expect(fake.requests.filter((r) => r.method === "PATCH")).toEqual([]);
      const row = (await db.query<{ direction: string }>(
        `SELECT direction FROM notion_sync_docs WHERE vault_path = $1`, [`${DESK}/dry-enable.md`],
      )).rows[0];
      expect(row.direction).toBe("md_to_notion");
    }, 30_000);
  });

  describe("syncDeskPushOnce — the Phase 2 engine, once per desk dir", () => {
    it("creates a desk file's page with that dir's Project and the mirror stamp", async () => {
      await writeFile(join(vaultPath, DESK, "fresh.md"), "# Fresh\n\nbody\n");
      const fake = makeNotionFetch({ markdown: {}, queries: [[]] });
      vi.stubGlobal("fetch", fake.impl);

      const result = await syncDeskPushOnce({ dryRun: false });
      expect(result).not.toBeNull();
      expect(result?.dirsFailed).toBe(0);
      expect(result?.bookkeepingFailed).toBe(0);
      expect(result?.perDir[0].summary).toContain("created");

      const create = fake.requests.find((r) => r.method === "POST" && r.path === "/v1/pages");
      expect(create?.body).toMatchObject({
        properties: {
          Project: { select: { name: "Orakel" } },
          Sync: { select: { name: SYNC_MIRROR } },
        },
      });
      const rows = await db.query<{ vault_path: string }>(
        `SELECT vault_path FROM notion_sync_docs WHERE target = 'docs'`,
      );
      expect(rows.rows.map((r) => r.vault_path)).toContain(`${DESK}/fresh.md`);
    }, 30_000);
  });
});

// ---------------------------------------------------------------------------
// T3 (Phase 4, fix round 1, Important 1c) — syncArchiveExcludedOnce, real
// Postgres, fake Notion. THE gap this closes: archive-excluded.test.ts's unit
// suite constructs `isExcluded` itself and hands it straight to the pure
// engine, so it never exercises cli.ts's OWN `makeDeskExclusion(cfg.desks)`
// wiring line at all — a mutation there (reviewer testing: `isExcluded: () =>
// true`) left the entire 559-test suite green. This block drives the REAL
// syncArchiveExcludedOnce, so THIS wiring line is finally inside the test
// boundary.
//
// A separate Postgres + config from T7's own block, deliberately: T7's shared
// config has no `deskDirs[].exclude`, and adding one there would change the
// scope every other T7 test reasons about. Same pattern the file already uses
// three times over (runFidelityOnce/record:true, T6, T7) for exactly this
// reason — one config per concern, not one shared config bent to fit all of
// them.
// ---------------------------------------------------------------------------

describe("syncArchiveExcludedOnce — real Postgres, fake Notion (fix round 1, Important 1c)", () => {
  let tdb: TestDb;
  let db: Pool;
  let vaultPath: string;
  let cfgPath: string;
  let prevEnv: Record<string, string | undefined>;

  const DESK = "zero7";

  beforeAll(async () => {
    tdb = await startTestDb();
    db = tdb.pool;
    vaultPath = await mkdtemp(join(tmpdir(), "notion-sync-archive-excluded-"));

    cfgPath = join(vaultPath, "config.json");
    await writeFile(cfgPath, JSON.stringify({
      notionVersion: "2026-03-11",
      meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
      docsDataSourceId: "11111111-1111-1111-1111-111111111111",
      wikiDir: "wiki",
      wikiProject: "Portfolio",
      deskDirs: [{ dir: DESK, project: "Zero7", exclude: ["transcripts"] }],
      twoWayDirs: [],
      mirrorFilePrefixes: [],
      vaultPath,
      selfEmail: "owner@example.com",
      projects: [{ notionProject: "Zero7", vaultFolder: "zero7" }],
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
  }, 120_000);

  afterAll(async () => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(vaultPath, { recursive: true, force: true });
    await tdb?.stop();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM notion_sync_docs");
    process.env.NOTION_SYNC_CONFIG = cfgPath;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("trashes and orphans only the row config's exclude selects — exercises cli.ts's OWN isExcluded wiring, not a test-constructed one", async () => {
    await upsertDocSynced(db, {
      vaultPath: `${DESK}/transcripts/call.md`, pageId: "p-excluded",
      mdHash: "h", notionHash: "n", notionLastEdited: "2026-08-01T00:00:00.000Z",
    });
    // Same desk dir, outside "transcripts" — real desk work.
    await upsertDocSynced(db, {
      vaultPath: `${DESK}/note.md`, pageId: "p-desk-not-excluded",
      mdHash: "h", notionHash: "n", notionLastEdited: "2026-08-01T00:00:00.000Z",
    });
    // No desk dir at all — a wiki mirror row. A predicate that answered
    // "excluded" for this (or anything not positively named by an `exclude`
    // entry) would be exactly the `() => true`-shaped bug under test.
    await upsertDocSynced(db, {
      vaultPath: "wiki/some-page.md", pageId: "p-wiki-mirror",
      mdHash: "h", notionHash: "n", notionLastEdited: "2026-08-01T00:00:00.000Z",
    });

    const fake = makeNotionFetch({ markdown: {}, queries: [[]] });
    vi.stubGlobal("fetch", fake.impl);

    const result = await syncArchiveExcludedOnce({ dryRun: false });

    // Every trash PATCH this run made — /v1/pages/{id}, never .../markdown.
    const trashRequests = fake.requests.filter((r) => r.method === "PATCH" && !r.path.endsWith("/markdown"));
    expect(trashRequests.map((r) => r.path)).toEqual(["/v1/pages/p-excluded"]);
    expect(trashRequests[0].body).toEqual({ in_trash: true });
    expect(result.trashed.map((r) => r.vaultPath)).toEqual([`${DESK}/transcripts/call.md`]);

    const rows = await getDeskRows(db);
    expect(rows.get(`${DESK}/transcripts/call.md`)?.state).toBe("unmatched");
    // The critical negative assertion, at the wiring level this time: neither
    // untouched row's state moved AT ALL.
    expect(rows.get(`${DESK}/note.md`)?.state).toBe("synced");
    expect(rows.get("wiki/some-page.md")?.state).toBe("synced");
  }, 30_000);

  it("never touches the filesystem — a vaultPath pointed at a directory that does not exist still succeeds (fix round 1, Minor 2)", async () => {
    // The structural proof at the ENGINE level lives in archive-excluded.test.ts
    // ("has no filesystem capability at all"); that test explicitly scopes
    // itself to lib/archive-excluded.ts because cli.ts (home of
    // syncArchiveExcludedOnce) legitimately imports writeFileSync and the vault
    // writer FOR OTHER COMMANDS. This is the dynamic proof at the WRAPPER level
    // instead: if syncArchiveExcludedOnce called anything fs-touching —
    // readVaultFile, the vault writer, even a stat — pointing vaultPath at a
    // directory that genuinely does not exist would fail loudly. It doesn't,
    // because it never looks; the whole pass is DB + HTTP only.
    const badVaultDir = join(vaultPath, "does-not-exist", "really-not");
    const badCfgPath = join(vaultPath, "config-bad-vault.json");
    await writeFile(badCfgPath, JSON.stringify({
      notionVersion: "2026-03-11",
      meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
      docsDataSourceId: "11111111-1111-1111-1111-111111111111",
      wikiDir: "wiki",
      wikiProject: "Portfolio",
      deskDirs: [{ dir: DESK, project: "Zero7", exclude: ["transcripts"] }],
      twoWayDirs: [],
      mirrorFilePrefixes: [],
      vaultPath: badVaultDir,
      selfEmail: "owner@example.com",
      projects: [{ notionProject: "Zero7", vaultFolder: "zero7" }],
    }));
    process.env.NOTION_SYNC_CONFIG = badCfgPath;

    await upsertDocSynced(db, {
      vaultPath: `${DESK}/transcripts/call.md`, pageId: "p-1",
      mdHash: "h", notionHash: "n", notionLastEdited: "2026-08-01T00:00:00.000Z",
    });
    // Not excluded — a real row set always has one (see the defence-in-depth
    // guard, archive-excluded.ts); without it this test would trip THAT guard
    // instead of testing what it means to.
    await upsertDocSynced(db, {
      vaultPath: `${DESK}/note.md`, pageId: "p-control",
      mdHash: "h", notionHash: "n", notionLastEdited: "2026-08-01T00:00:00.000Z",
    });
    const fake = makeNotionFetch({ markdown: {}, queries: [[]] });
    vi.stubGlobal("fetch", fake.impl);

    const result = await syncArchiveExcludedOnce({ dryRun: false });
    expect(result.failed).toEqual([]);
    expect(result.trashed.map((r) => r.vaultPath)).toEqual([`${DESK}/transcripts/call.md`]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Phase 4 fix round 2 — the composition roots that wire the two Notion-owned
// guards. Both are single lines in cli.ts, and BOTH can be neutered
// (`new Set()`, `() => true`) with every unit test in this repo still green,
// because the unit tests construct their own predicates. These drive the real
// wrappers so the wiring itself is under test — the same answer T3's fix round
// gave for `isExcluded`.
// ---------------------------------------------------------------------------

describe("the Notion-owned wiring, through the real composition roots (fix round 2)", () => {
  let tdb: TestDb;
  let db: Pool;
  let vaultPath: string;
  let cfgPath: string;
  let prevEnv: Record<string, string | undefined>;

  const DESK = "zero7";

  beforeAll(async () => {
    tdb = await startTestDb();
    db = tdb.pool;
    vaultPath = await mkdtemp(join(tmpdir(), "notion-sync-owned-wiring-"));
    await mkdir(join(vaultPath, DESK), { recursive: true });
    // A real git repo: createVaultFile commits what it writes (that is the whole
    // point of the vault writer), so a bare temp dir would fail at `git add`.
    execFileSync("git", ["init", "-q", "-b", "main", vaultPath]);
    execFileSync("git", ["-C", vaultPath, "config", "user.email", "sync@lares.test"]);
    execFileSync("git", ["-C", vaultPath, "config", "user.name", "notion-sync"]);

    cfgPath = join(vaultPath, "config.json");
    await writeFile(cfgPath, JSON.stringify({
      notionVersion: "2026-03-11",
      meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
      docsDataSourceId: "11111111-1111-1111-1111-111111111111",
      wikiDir: "wiki",
      wikiProject: "Portfolio",
      deskDirs: [{ dir: DESK, project: "Zero7", exclude: ["transcripts"] }],
      twoWayDirs: [],
      mirrorFilePrefixes: [],
      vaultPath,
      selfEmail: "owner@example.com",
      projects: [{ notionProject: "Zero7", vaultFolder: "zero7" }],
    }));

    const url = new URL(tdb.connectionString);
    prevEnv = {
      PGHOST: process.env.PGHOST, PGPORT: process.env.PGPORT,
      PGDATABASE: process.env.PGDATABASE, PGUSER: process.env.PGUSER,
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
  }, 120_000);

  afterAll(async () => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(vaultPath, { recursive: true, force: true });
    await tdb?.stop();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM notion_sync_proposals");
    await db.query("DELETE FROM notion_sync_docs");
    process.env.NOTION_SYNC_CONFIG = cfgPath;
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  // Mutation this kills: `readOnlyVaultPaths: new Set()` in syncDeskPushOnce.
  it("syncDeskPushOnce never PATCHes a Notion-owned page, however far the vault has drifted", async () => {
    await writeFile(join(vaultPath, DESK, "owned.md"), "# Owned\n\nedited locally, on the phone\n");
    await writeFile(join(vaultPath, DESK, "mirror.md"), "# Mirror\n\nalso edited locally\n");
    // Both rows carry a stale md_hash, so a direction-blind push would patch BOTH.
    await upsertDocSynced(db, {
      vaultPath: `${DESK}/owned.md`, pageId: "p-owned", mdHash: "stale",
      notionHash: "n", notionLastEdited: "2026-08-01T00:00:00.000Z", direction: "notion_to_md",
    });
    await upsertDocSynced(db, {
      vaultPath: `${DESK}/mirror.md`, pageId: "p-mirror", mdHash: "stale",
      notionHash: "n", notionLastEdited: "2026-08-01T00:00:00.000Z", direction: "md_to_notion",
    });

    const fake = makeNotionFetch({
      markdown: { "p-owned": "whatever", "p-mirror": "whatever" },
      queries: [[
        { pageId: "p-owned", vaultPath: `${DESK}/owned.md`, lastEditedTime: "2026-08-01T00:00:00.000Z" },
        { pageId: "p-mirror", vaultPath: `${DESK}/mirror.md`, lastEditedTime: "2026-08-01T00:00:00.000Z" },
      ]],
    });
    vi.stubGlobal("fetch", fake.impl);

    await syncDeskPushOnce({ dryRun: false });

    const touched = fake.requests
      .filter((r) => r.method === "PATCH" || r.method === "POST")
      .map((r) => r.path);
    // The mirror row was pushed; the Notion-owned one was not touched at all.
    expect(touched.some((p) => p.includes("p-mirror"))).toBe(true);
    expect(touched.some((p) => p.includes("p-owned"))).toBe(false);
  }, 60_000);

  // The DAMAGE the recount guard exists to prevent, proven at the engine boundary —
  // which is the only place a mis-wired hold-back set can be injected, since the
  // composition root derives its own. `new Set()` is the mutation; this is what it
  // costs. (Renamed from a version that claimed to test the throw and asserted no
  // throw — fix round 3.)
  it("an EMPTY hold-back set is what the recount guard is protecting against: the page gets pushed", async () => {
    await writeFile(join(vaultPath, DESK, "owned2.md"), "# Owned\n\ndrifted\n");
    const rows = new Map([[`${DESK}/owned2.md`, {
      pageId: "p-owned2", mdHash: "stale", state: "synced" as const,
    }]]);
    const patched: string[] = [];
    const result = await runWikiSync(
      {
        wikiDir: DESK, project: "Zero7", dryRun: false,
        // The mutation: the row IS notion_to_md in the store, and the set is empty.
        readOnlyVaultPaths: new Set<string>(),
      },
      {
        listWikiFiles: async () => ["owned2.md"],
        readWikiFile: async () => "# Owned\n\ndrifted\n",
        getDocRows: async () => rows,
        queryDocs: async () => [],
        createDocPage: async () => ({ pageId: "new" }),
        patchPageMarkdown: async (pageId) => { patched.push(pageId); },
        updateDocProps: async () => {},
        getPageMarkdown: async () => "stored",
        upsertDocSynced: async () => {},
        recordDocError: async () => {},
        markDocOrphaned: async () => {},
      },
    );
    expect(patched).toEqual(["p-owned2"]);      // pushed — the damage
    expect(result.notionOwned).toBe(0);

    // …and with the set the composition root actually derives, it is not.
    const held: string[] = [];
    const guarded = await runWikiSync(
      {
        wikiDir: DESK, project: "Zero7", dryRun: false,
        readOnlyVaultPaths: new Set([`${DESK}/owned2.md`]),
      },
      {
        listWikiFiles: async () => ["owned2.md"],
        readWikiFile: async () => "# Owned\n\ndrifted\n",
        getDocRows: async () => rows,
        queryDocs: async () => [],
        createDocPage: async () => ({ pageId: "new" }),
        patchPageMarkdown: async (pageId) => { held.push(pageId); },
        updateDocProps: async () => {},
        getPageMarkdown: async () => "stored",
        upsertDocSynced: async () => {},
        recordDocError: async () => {},
        markDocOrphaned: async () => {},
      },
    );
    expect(held).toEqual([]);
    expect(guarded.notionOwned).toBe(1);
  }, 60_000);

  // Mutation this kills: `inCreateScope: () => true` in syncApplyOnce.
  it("syncApplyOnce refuses a create outside every configured folder, through cli.ts's own scope wiring", async () => {
    const id = await insertProposal(db, {
      vaultPath: "personal/secrets.md", notionPageId: "p-create-out",
      proposedBody: "---\ntitle: x\n---\n\nbody", baseMdHash: "", notionHash: "nh",
      diffPreview: "+ body", kind: "create",
    });
    await setProposalState(db, id, "approved");

    const fake = makeNotionFetch({ markdown: {}, queries: [[]] });
    vi.stubGlobal("fetch", fake.impl);

    const result = await syncApplyOnce({ dryRun: false });

    expect(result?.applied).toBe(0);
    expect(result?.superseded).toBe(1);
    // Nothing on disk, anywhere.
    await expect(readFile(join(vaultPath, "personal", "secrets.md"), "utf8")).rejects.toThrow();
    const after = await getOpenProposals(db);
    expect(after.find((p) => p.id === id)).toBeUndefined();   // closed, not queued
  }, 60_000);

  it("syncApplyOnce ACCEPTS a create inside a configured desk dir — the guard is not refusing everything", async () => {
    const id = await insertProposal(db, {
      vaultPath: `${DESK}/from-notion.md`, notionPageId: "p-create-in",
      proposedBody: "---\ntitle: From Notion\n---\n\nbody from notion",
      baseMdHash: "", notionHash: "nh2", diffPreview: "+ body from notion", kind: "create",
    });
    await setProposalState(db, id, "approved");

    const fake = makeNotionFetch({ markdown: {}, queries: [[]] });
    vi.stubGlobal("fetch", fake.impl);

    const result = await syncApplyOnce({ dryRun: false });

    expect(result?.applied).toBe(1);
    expect(await readFile(join(vaultPath, DESK, "from-notion.md"), "utf8"))
      .toBe("---\nlares_origin: synced\ntitle: From Notion\n---\n\nbody from notion\n");
    // …and it joined the store bound to the page it came from, Notion-owned.
    const rows = await getDeskRows(db);
    expect(rows.get(`${DESK}/from-notion.md`)?.direction).toBe("notion_to_md");
    expect(rows.get(`${DESK}/from-notion.md`)?.pageId).toBe("p-create-in");
  }, 60_000);

  // ── T6 — the Notion-born page, through EVERY composition root ─────────────
  //
  // The in-memory seam (notion-born-seam.test.ts) proves the tick-to-tick logic
  // against a hand-modelled store. What it cannot prove is the part that only real
  // components can answer: that the real SQL, the real vault writer (git commit and
  // all), the real config parsing and the real desk PUSH agree with the model — in
  // particular that the push, which walks this very folder, neither adopts nor
  // patches the file this pass just made.
  //
  // Its own vault, deliberately: the desk push lists every file under the dir, and
  // the block above leaves files there whose rows this describe's beforeEach
  // deletes. Sharing it would mean the push adopting THOSE and the assertion below
  // being about the wrong thing.
  describe("notion-born (T6)", () => {
    const BORN_PAGE = "born-page-1";
    const BORN_TITLE = "Løpende notater — strategi";
    const BORN_PATH = `${DESK}/loepende-notater-strategi.md`;
    // What GET /markdown returns for a page a human made in Notion: no H1 at all.
    const BORN_MD = "## Første avsnitt\n\nnoe innhold";
    let bornVault: string;
    let bornCfgPath: string;

    beforeAll(async () => {
      bornVault = await mkdtemp(join(tmpdir(), "notion-sync-born-"));
      await mkdir(join(bornVault, DESK), { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main", bornVault]);
      execFileSync("git", ["-C", bornVault, "config", "user.email", "sync@lares.test"]);
      execFileSync("git", ["-C", bornVault, "config", "user.name", "notion-sync"]);
      bornCfgPath = join(bornVault, "config.json");
      await writeFile(bornCfgPath, JSON.stringify({
        notionVersion: "2026-03-11",
        meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
        docsDataSourceId: "11111111-1111-1111-1111-111111111111",
        wikiDir: "wiki",
        wikiProject: "Portfolio",
        deskDirs: [{ dir: DESK, project: "Zero7", exclude: ["transcripts"] }],
        twoWayDirs: [],
        mirrorFilePrefixes: [],
        vaultPath: bornVault,
        selfEmail: "owner@example.com",
        projects: [{ notionProject: "Zero7", vaultFolder: DESK }],
      }));
    }, 60_000);

    afterAll(async () => { await rm(bornVault, { recursive: true, force: true }); });

    beforeEach(() => { process.env.NOTION_SYNC_CONFIG = bornCfgPath; });

    /** The Docs query as Notion answers it for this page, on every tick. */
    const bornQuery = (folder?: string) => [[{
      pageId: BORN_PAGE,
      // EMPTY, on every tick and forever: the `Vault Path` property is written by
      // the PUSH pass, and the push holds a Notion-owned row back. So the remote
      // row never learns it has a file, and the STORE row is the only thing that
      // stops this pass proposing the same create again. That is exactly why the
      // engine consults both.
      vaultPath: "",
      lastEditedTime: "2026-08-05T10:00:00.000Z",
      name: BORN_TITLE,
      project: "Zero7",
      ...(folder === undefined ? {} : { folder }),
    }]];

    it("creates the file once, then five ticks of nothing — no re-proposal, no churn, no Notion write", async () => {
      const fake = makeNotionFetch({ markdown: { [BORN_PAGE]: BORN_MD }, queries: bornQuery() });
      vi.stubGlobal("fetch", fake.impl);

      // ── TICK 1 — proposed, nothing written. ────────────────────────────────
      const first = await syncNotionBornOnce({ dryRun: false });
      expect(first?.proposed).toBe(1);
      expect(first?.skipped).toEqual([]);
      const open = await getOpenProposals(db);
      expect(open).toHaveLength(1);
      expect(open[0].kind).toBe("create");
      expect(open[0].vaultPath).toBe(BORN_PATH);
      expect(open[0].baseMdHash).toBe("");
      expect(open[0].proposedBody.endsWith("\n")).toBe(false);
      expect(open[0].diffPreview.startsWith("+ ")).toBe(true);
      await expect(readFile(join(bornVault, BORN_PATH), "utf8")).rejects.toThrow();

      // Bendik taps Approve — through the ONE guarded transition every human-facing
      // surface uses (spec §20.1), not a bare state write.
      await resolveProposal(db, open[0].id, "approve");

      // ── TICK 2 — apply writes it. ──────────────────────────────────────────
      await syncNotionBornOnce({ dryRun: false });
      await syncPullOnce({ dryRun: false });
      const applied = await syncApplyOnce({ dryRun: false });
      expect(applied?.applied).toBe(1);

      const bytes = await readFile(join(bornVault, BORN_PATH), "utf8");
      // JSON-quoted, because the em dash is outside `yamlScalar`'s bare-safe set —
      // the shared quoting rule being conservative, which is the right direction for
      // a value every tool that reads the vault's frontmatter has to parse.
      expect(bytes).toContain(`title: ${JSON.stringify(BORN_TITLE)}`);
      expect(bytes).toContain(`# ${BORN_TITLE}`);
      expect(bytes).toContain(`notion_page: ${BORN_PAGE}`);
      expect(bytes.endsWith("\n")).toBe(true);
      expect(bytes.endsWith("\n\n")).toBe(false);      // exactly one, added by apply

      // ONE row, bound to the page it came from, Notion-owned.
      const count = await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM notion_sync_docs");
      expect(count.rows[0].n).toBe("1");
      const rows = await getDeskRows(db);
      expect(rows.get(BORN_PATH)?.pageId).toBe(BORN_PAGE);
      expect(rows.get(BORN_PATH)?.direction).toBe("notion_to_md");
      expect(rows.get(BORN_PATH)?.state).toBe("synced");

      // ── TICKS 3–7 — the whole tick, PUSH INCLUDED. ─────────────────────────
      const requestsBefore = fake.requests.length;
      const rowAfterApply = { ...rows.get(BORN_PATH) };
      for (let i = 0; i < 5; i += 1) {
        await syncNotionBornOnce({ dryRun: false });
        await syncPullOnce({ dryRun: false });
        await syncApplyOnce({ dryRun: false });
        await syncDeskPushOnce({ dryRun: false });
      }

      // Nothing new was ever asked of Bendik…
      expect(await getOpenProposals(db)).toEqual([]);
      const proposals = await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM notion_sync_proposals");
      expect(proposals.rows[0].n).toBe("1");
      // …the file is byte-identical…
      expect(await readFile(join(bornVault, BORN_PATH), "utf8")).toBe(bytes);
      // …the row never froze and its hashes stopped moving…
      expect({ ...(await getDeskRows(db)).get(BORN_PATH) }).toEqual({
        ...rowAfterApply,
        // The one field that legitimately advances: pull records the watermark it
        // OBSERVED on the first tick that found the hashes equal, and never again.
        notionLastEdited: "2026-08-05T10:00:00.000Z",
      });
      // …and NOTHING was written to Notion by any pass, including the push that
      // walks this very folder and would otherwise have adopted the file into a
      // second page.
      const writes = fake.requests
        .slice(requestsBefore)
        .filter((r) => r.method === "PATCH" || (r.method === "POST" && r.path === "/v1/pages"));
      expect(writes).toEqual([]);
    }, 120_000);

    it("refuses a Folder Bendik could type that escapes, or names a machine-owned area", async () => {
      // Driven through the REAL config parsing and the REAL scope wiring, so this
      // is the whole chain from a Notion property to a refusal, not the engine's
      // predicate in isolation.
      for (const folder of ["../etc", "/etc", "wiki", "_archive", ".git", "personal", `${DESK}/transcripts`]) {
        const fake = makeNotionFetch({ markdown: { [BORN_PAGE]: BORN_MD }, queries: bornQuery(folder) });
        vi.stubGlobal("fetch", fake.impl);

        const result = await syncNotionBornOnce({ dryRun: false });
        expect(result?.proposed, `Folder ${JSON.stringify(folder)} must not be proposed`).toBe(0);
        expect(result?.skipped).toHaveLength(1);
        expect(await getOpenProposals(db)).toEqual([]);
        // …and no state row was created for a page that was never proposed.
        const count = await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM notion_sync_docs");
        expect(count.rows[0].n).toBe("0");
      }
    }, 120_000);

    it("never overwrites a hand-written note whose name the slug lands on", async () => {
      await writeFile(join(bornVault, DESK, "loepende-notater-strategi.md"), "# Mine egne notater\n");
      try {
        const fake = makeNotionFetch({ markdown: { [BORN_PAGE]: BORN_MD }, queries: bornQuery() });
        vi.stubGlobal("fetch", fake.impl);

        const result = await syncNotionBornOnce({ dryRun: false });
        expect(result?.proposed).toBe(0);
        expect(result?.skipped[0].reason).toMatch(/already exists/i);
        expect(await readFile(join(bornVault, BORN_PATH), "utf8")).toBe("# Mine egne notater\n");
      } finally {
        await rm(join(bornVault, DESK, "loepende-notater-strategi.md"), { force: true });
      }
    }, 60_000);

    // Round 1, Important A — through the REAL walker, on a REAL filesystem. An
    // in-memory test cannot prove this: the whole defect is that `lstat` answers for
    // the filesystem underneath it, so the proof has to run against one.
    it("never creates a file that differs only by CASE from one already in the vault", async () => {
      await writeFile(join(bornVault, DESK, "Loepende-Notater-Strategi.md"), "# Mine egne notater\n");
      try {
        const fake = makeNotionFetch({ markdown: { [BORN_PAGE]: BORN_MD }, queries: bornQuery() });
        vi.stubGlobal("fetch", fake.impl);

        const result = await syncNotionBornOnce({ dryRun: false });
        expect(result?.proposed).toBe(0);
        expect(result?.skipped).toHaveLength(1);
        // WHICH of the two halves refuses it depends on the filesystem this runs on,
        // and that is the finding rather than a wrinkle in the test: on the BOX
        // (Linux/ext4, case-sensitive) `lstat` cannot see the collision and the new
        // normalisation guard is the only thing that catches it; on a case-INsensitive
        // host the exact-match guard gets there first. Both refuse, and the engine
        // test pins the new guard on its own with a world where `lstat` says no.
        expect(result?.skipped[0].reason)
          .toMatch(/SAME FILE as that path on macOS|already exists at that path/);
        expect(await getOpenProposals(db)).toEqual([]);

        // The vault holds ONE of them — his.
        const listed = await readdir(join(bornVault, DESK));
        expect(listed.filter((f) => /loepende-notater-strategi\.md/i.test(f)))
          .toEqual(["Loepende-Notater-Strategi.md"]);
      } finally {
        await rm(join(bornVault, DESK, "Loepende-Notater-Strategi.md"), { force: true });
      }
    }, 60_000);

    // Round 3, Important 2 — the `cli.ts` wiring itself. Mutating
    // `listCollisionCandidates: vault.listCollisionCandidates` to `async () => []`
    // used to leave the whole package green; now the apply pass refuses to run ANY
    // create against a lookup that answers nothing at the vault root, so every
    // composition-root create test — this one, and `syncApplyOnce ACCEPTS a create
    // inside a configured desk dir` above — goes red on that mutation.
    it("refuses every create when the collision lookup is mis-wired (the sentinel, through cli.ts)", async () => {
      const id = await insertProposal(db, {
        vaultPath: `${DESK}/wiring-probe.md`, notionPageId: "p-wiring",
        proposedBody: "---\ntitle: x\n---\n\nbody", baseMdHash: "", notionHash: "nh",
        diffPreview: "+ body", kind: "create",
      });
      await setProposalState(db, id, "approved");

      const fake = makeNotionFetch({ markdown: {}, queries: [[]] });
      vi.stubGlobal("fetch", fake.impl);

      // The real wiring answers, so the create lands — which is what proves the
      // sentinel is not simply refusing everything.
      const ok = await syncApplyOnce({ dryRun: false });
      expect(ok?.applied).toBe(1);
      await rm(join(bornVault, DESK, "wiring-probe.md"), { force: true });

      // …and the engine, handed the mutation's value, refuses rather than creating.
      // A FRESH approved create, because the one above is now applied and a tick with
      // no create to protect deliberately never probes.
      const id2 = await insertProposal(db, {
        vaultPath: `${DESK}/wiring-probe-2.md`, notionPageId: "p-wiring-2",
        proposedBody: "---\ntitle: x\n---\n\nbody", baseMdHash: "", notionHash: "nh2",
        diffPreview: "+ body", kind: "create",
      });
      await setProposalState(db, id2, "approved");

      await expect(runApplySync(
        { dryRun: false, inCreateScope: makeCreateScope(loadNotionSyncConfig()) },
        {
          getOpenProposals: () => getOpenProposals(db),
          getRejectedUnexecuted: () => getRejectedUnexecuted(db),
          getLinkedRows: () => getLinkedRows(db),
          renderDoc: async () => { throw new Error("not reached"); },
          readVaultFile: async () => { throw new Error("not reached"); },
          writeVaultFile: async () => { throw new Error("not reached"); },
          vaultFileExists: async () => false,
          createVaultFile: async () => { throw new Error("a create must never be reached"); },
          // THE MUTATION the review reported as invisible: a plausible NON-EMPTY
          // constant stub, which the one-probe sentinel let through.
          listCollisionCandidates: async () => [".git"],
          patchPageMarkdown: async () => {},
          updateDocProps: async () => {},
          getPageMarkdown: async () => "",
          upsertDocSynced: (doc) => upsertDocSynced(db, doc),
          linkPageToVaultFile: (doc) => linkPageToVaultFile(db, doc),
          updateNotionWatermark: async () => {},
          recordNotionAccounted: async () => {},
          setProposalState: (pid, st) => setProposalState(db, pid, st),
          markProposalReverted: async () => {},
          freezeDoc: async () => {},
          recordDocError: async () => {},
          notify: async () => {},
          pathWasForgotten: async () => null,
        },
      )).rejects.toThrow(/not resolving the path it was given/);
    }, 60_000);

    // Round 4. The only shipped test that reached guard 3b through the real
    // composition root was refused by guard 3 first on a case-insensitive Mac — so on
    // a developer machine nothing exercised the wiring at all, which is how a
    // non-empty wrong answer stayed invisible. An ANCESTOR collision is the shape that
    // reaches 3b on Linux and on the box; on a Mac guard 3 still refuses it, so the
    // test is a real proof there and an honest no-op here. Same property the adapter
    // tests already have.
    it("refuses an approved create whose ANCESTOR directory collides, through the real roots", async () => {
      const hisDir = join(bornVault, DESK, "Prosjekt");
      await mkdir(hisDir, { recursive: true });
      await writeFile(join(hisDir, "Loepende-Notater.md"), "# Mine egne notater\n");
      try {
        const id = await insertProposal(db, {
          vaultPath: `${DESK}/prosjekt/loepende-notater.md`, notionPageId: "p-ancestor",
          proposedBody: "---\ntitle: x\n---\n\nbody", baseMdHash: "", notionHash: "nh-anc",
          diffPreview: "+ body", kind: "create",
        });
        await setProposalState(db, id, "approved");

        const fake = makeNotionFetch({ markdown: {}, queries: [[]] });
        vi.stubGlobal("fetch", fake.impl);

        const result = await syncApplyOnce({ dryRun: false });

        expect(result?.applied).toBe(0);
        expect(result?.superseded).toBe(1);
        // His file is byte-identical…
        expect(await readFile(join(hisDir, "Loepende-Notater.md"), "utf8")).toBe("# Mine egne notater\n");
        // …and no SECOND spelling of the directory was created beside his. On the box
        // that is the whole damage: two dirs and two files there, one of each on his
        // Mac, his note shadowed on the next pull.
        const spellings = (await readdir(join(bornVault, DESK)))
          .filter((name) => name.toLowerCase() === "prosjekt");
        expect(spellings).toEqual(["Prosjekt"]);
        expect(await getOpenProposals(db)).toEqual([]);
      } finally {
        await rm(hisDir, { recursive: true, force: true });
        await rm(join(bornVault, DESK, "prosjekt"), { recursive: true, force: true });
      }
    }, 60_000);

    it("a rejected create is not proposed again on the next tick", async () => {
      const fake = makeNotionFetch({ markdown: { [BORN_PAGE]: BORN_MD }, queries: bornQuery() });
      vi.stubGlobal("fetch", fake.impl);

      await syncNotionBornOnce({ dryRun: false });
      const open = await getOpenProposals(db);
      await resolveProposal(db, open[0].id, "reject");

      // The tick that carries the rejection out — the proposer runs FIRST, and must
      // stay silent because the decline is still unexecuted.
      const during = await syncNotionBornOnce({ dryRun: false });
      expect(during?.awaitingDecline).toBe(1);
      const declined = await syncApplyOnce({ dryRun: false });
      expect(declined?.declined).toBe(1);

      // …and then silent for good, because the decline is recorded ON THE ROW the
      // proposer had to create before it ever asked.
      const after = await syncNotionBornOnce({ dryRun: false });
      expect(after?.proposed).toBe(0);
      expect(after?.accounted).toBe(1);
      expect(await getOpenProposals(db)).toEqual([]);
      await expect(readFile(join(bornVault, BORN_PATH), "utf8")).rejects.toThrow();
    }, 120_000);

    it("is a no-op when the deployment has no desk folders", async () => {
      const noDesks = join(bornVault, "config-no-desks.json");
      await writeFile(noDesks, JSON.stringify({
        notionVersion: "2026-03-11",
        meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
        docsDataSourceId: "11111111-1111-1111-1111-111111111111",
        wikiDir: "wiki",
        wikiProject: "Portfolio",
        vaultPath: bornVault,
        selfEmail: "owner@example.com",
        projects: [{ notionProject: "Zero7", vaultFolder: DESK }],
      }));
      process.env.NOTION_SYNC_CONFIG = noDesks;
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no call may be made"); }));

      expect(await syncNotionBornOnce({ dryRun: false })).toBeNull();
    }, 60_000);
  });

  // ── T4 — the transcript pass, through BOTH composition roots ───────────────
  //
  // The in-memory seam (transcript-seam.test.ts) proves the tick-to-tick logic
  // against a hand-modelled store. What it CANNOT prove is the thing this task's
  // blocking design question was about: that the real SQL does what the model says
  // — that a transcript's create lands on the existing MEETINGS row instead of
  // violating `notion_page_id UNIQUE`, and that the row it lands on stays invisible
  // to every desk pass afterwards. That needs the real statements and a real table.
  describe("transcripts (T4)", () => {
    const TRANSCRIPT_PAGE = "meeting-page-1";
    const TRANSCRIPT_PATH = `${DESK}/transcripts/2026-08-05-ukesmoete.md`;
    const MEETING_MD = "## Beslutninger\n- [x] valgte alternativ to\n\n<transcript>\nBendik: ja\n</transcript>";
    let transcriptCfgPath: string;

    beforeAll(async () => {
      // Its own config: the shared one has no `transcripts` section, which is
      // exactly how a deployment says "this pass does not run".
      transcriptCfgPath = join(vaultPath, "config-transcripts.json");
      await writeFile(transcriptCfgPath, JSON.stringify({
        notionVersion: "2026-03-11",
        meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
        docsDataSourceId: "11111111-1111-1111-1111-111111111111",
        wikiDir: "wiki",
        wikiProject: "Portfolio",
        deskDirs: [{ dir: DESK, project: "Zero7", exclude: ["transcripts"] }],
        twoWayDirs: [],
        mirrorFilePrefixes: [],
        transcripts: { dir: "transcripts", projects: [{ notionProject: "Zero7", vaultFolder: DESK }] },
        vaultPath,
        selfEmail: "owner@example.com",
        projects: [{ notionProject: "Zero7", vaultFolder: "zero7" }],
      }));
    });

    beforeEach(async () => {
      process.env.NOTION_SYNC_CONFIG = transcriptCfgPath;
      // The vault dir is shared across this block, and the outer beforeEach only
      // clears the DATABASE. A transcript file left behind by an earlier test would
      // make the next one skip with "a vault file already exists there" — which is
      // the pass working correctly, and would silently gut the test.
      await rm(join(vaultPath, TRANSCRIPT_PATH), { force: true });
    });

    const meetingsQuery = (title: string) => [[{
      pageId: TRANSCRIPT_PAGE, vaultPath: "", lastEditedTime: "2026-08-05T10:00:00.000Z",
      title, project: "Zero7", startsAt: "2026-08-05T09:00:00.000+02:00",
    }]];

    it("first sync → approve → apply: the file lands, and the MEETINGS row carries its path", async () => {
      // The attendee pass has already met this meeting and could not match it to a
      // calendar event — the live shape for 6 of the 50 rows, and the one that would
      // strand a transcript behind a state gate that means something else.
      await recordMeetingUnmatched(db, TRANSCRIPT_PAGE, "no calendar candidate");

      const fake = makeNotionFetch({
        markdown: { [TRANSCRIPT_PAGE]: MEETING_MD },
        queries: meetingsQuery("Ukesmøte"),
      });
      vi.stubGlobal("fetch", fake.impl);

      const proposeResult = await syncTranscriptsOnce({ dryRun: false });
      expect(proposeResult?.proposed).toBe(1);

      const open = await getOpenProposals(db);
      const proposal = open.find((row) => row.vaultPath === TRANSCRIPT_PATH);
      expect(proposal?.kind).toBe("create");
      expect(proposal?.baseMdHash).toBe("");
      expect(proposal?.diffPreview).toMatch(/^\+ /m);
      // A CREATE joins to no row (that is its premise), so notionOwned is false —
      // and nothing depends on it, because rejectOutcome settles `kind` first.
      expect(proposal?.notionOwned).toBe(false);

      await resolveProposal(db, proposal?.id as number, "approve");
      const applyResult = await syncApplyOnce({ dryRun: false });

      expect(applyResult?.applied).toBe(1);
      expect(applyResult?.bookkeepingFailed).toBe(0);
      const written = await readFile(join(vaultPath, TRANSCRIPT_PATH), "utf8");
      // The <transcript> block survived byte-intact, and exactly one trailing newline.
      expect(written).toContain("<transcript>\nBendik: ja\n</transcript>");
      expect(written.endsWith("</transcript>\n")).toBe(true);
      expect(written).toContain("notion_page: meeting-page-1");

      // THE ROW. One row, still `meetings`, now carrying the vault path — no second
      // row, and no UNIQUE violation (which would have surfaced as bookkeepingFailed).
      const rows = await db.query<{ target: string; vault_path: string | null; direction: string; state: string }>(
        `SELECT target, vault_path, direction, state FROM notion_sync_docs WHERE notion_page_id = $1`,
        [TRANSCRIPT_PAGE],
      );
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0].target).toBe("meetings");
      expect(rows.rows[0].vault_path).toBe(TRANSCRIPT_PATH);
      expect(rows.rows[0].direction).toBe("notion_to_md");
      // The attendee pass's verdict was NOT overwritten by this pass's bookkeeping.
      expect(rows.rows[0].state).toBe("unmatched");

      // …and the desk passes still cannot see it: `target='docs'` excludes it
      // structurally, on top of config's own `exclude` carve-out.
      expect((await getDeskRows(db)).has(TRANSCRIPT_PATH)).toBe(false);

      // A SECOND tick proposes nothing: the row now accounts for this content.
      const second = await syncTranscriptsOnce({ dryRun: false });
      expect(second?.proposed).toBe(0);
      expect(second?.unchanged).toBe(1);

      // …and a Notion edit now proposes an UPDATE that KNOWS Notion owns it. This
      // is the assertion the docs-scoped proposal join failed: it answered
      // notionOwned=false for a document whose row says notion_to_md, and
      // rejectConsequence would then have promised Bendik a Notion revert that the
      // engine correctly refuses to perform.
      fake.requests.length = 0;
      const edited = makeNotionFetch({
        markdown: { [TRANSCRIPT_PAGE]: `${MEETING_MD}\n\nen ny linje` },
        queries: meetingsQuery("Ukesmøte"),
      });
      vi.stubGlobal("fetch", edited.impl);
      const third = await syncTranscriptsOnce({ dryRun: false });
      expect(third?.proposed).toBe(1);
      const update = (await getOpenProposals(db)).find((row) => row.vaultPath === TRANSCRIPT_PATH);
      expect(update?.kind).toBe("update");
      expect(update?.notionOwned).toBe(true);
      expect(rejectConsequence(update as ProposalRow)).toMatch(/Notion owns this document/);
      expect(rejectConsequence(update as ProposalRow)).not.toMatch(/reverted back to it/);
    }, 60_000);

    it("a rejected transcript is not proposed again on the next tick", async () => {
      const fake = makeNotionFetch({
        markdown: { [TRANSCRIPT_PAGE]: MEETING_MD },
        queries: meetingsQuery("Ukesmøte"),
      });
      vi.stubGlobal("fetch", fake.impl);

      await syncTranscriptsOnce({ dryRun: false });
      const open = await getOpenProposals(db);
      const proposal = open.find((row) => row.vaultPath === TRANSCRIPT_PATH);
      await resolveProposal(db, proposal?.id as number, "reject");

      // The tick that carries the rejection out: the transcript pass runs FIRST and
      // must stay silent, then apply records the decline.
      const quiet = await syncTranscriptsOnce({ dryRun: false });
      expect(quiet?.proposed).toBe(0);
      expect(quiet?.awaitingDecline).toBe(1);
      const applied = await syncApplyOnce({ dryRun: false });
      expect(applied?.declined).toBe(1);
      expect(applied?.bookkeepingFailed).toBe(0);

      // THE REQUIREMENT: the next tick asks nothing. Nothing was created either.
      const next = await syncTranscriptsOnce({ dryRun: false });
      expect(next?.proposed).toBe(0);
      expect(await getOpenProposals(db)).toEqual([]);
      await expect(readFile(join(vaultPath, TRANSCRIPT_PATH), "utf8")).rejects.toThrow();
    }, 60_000);

    it("is a clean no-op when the config has no transcripts section", async () => {
      process.env.NOTION_SYNC_CONFIG = cfgPath;
      expect(await syncTranscriptsOnce({ dryRun: false })).toBeNull();
    });

    // FIX WAVE, ITEM 1 — the eighth instance of this phase's signature failure, and
    // the first between two passes. Apply's guard 0 reads across BOTH targets and
    // refuses a create for a path any row owns; the proposer read `target='meetings'`
    // only, so it could not see the DOCS row sitting on the path it was claiming.
    //
    // The shape is the live database, not a hypothetical: Phase 3's sweep left 32
    // docs rows on `*/transcripts/*` paths, T3 orphans them and keeps them, and the
    // file under one disappears the moment Bendik acts on this pass's own skip text
    // by deleting or renaming a matched transcript.
    //
    // This runs through the REAL composition root, so it is also the sentinel on the
    // wiring: mutating `getLinkedRows: () => getLinkedRows(pool)` in cli.ts to
    // `async () => new Map()` turns the first assertion from 0 into 1.
    it("does not propose a create for a path a DOCS row owns with no file on disk — over five ticks", async () => {
      await upsertDocSynced(db, {
        vaultPath: TRANSCRIPT_PATH, pageId: "legacy-doc-1", mdHash: "legacy-render",
        notionHash: "legacy", notionLastEdited: "2026-07-01T00:00:00.000Z",
        direction: "md_to_notion",
      });

      const fake = makeNotionFetch({
        markdown: { [TRANSCRIPT_PAGE]: MEETING_MD },
        queries: meetingsQuery("Ukesmøte"),
      });
      vi.stubGlobal("fetch", fake.impl);

      // Five ticks, approving anything that appears — which is what turns the defect
      // from a stuck proposal into an endless propose/refuse/re-propose loop.
      for (let i = 0; i < 5; i += 1) {
        const result = await syncTranscriptsOnce({ dryRun: false });
        expect(result?.proposed).toBe(0);
        expect(result?.skipped[0]?.reason).toContain("legacy-doc-1");
        for (const open of await getOpenProposals(db)) {
          await resolveProposal(db, open.id, "approve");
        }
        await syncApplyOnce({ dryRun: false });
      }

      expect(await getOpenProposals(db)).toEqual([]);
      await expect(readFile(join(vaultPath, TRANSCRIPT_PATH), "utf8")).rejects.toThrow();
      // The legacy row is untouched — this pass reads it, it does not clean up after
      // Phase 3. That is `archive-excluded`'s job, and it has already run.
      const legacy = await db.query<{ vault_path: string }>(
        `SELECT vault_path FROM notion_sync_docs WHERE notion_page_id = 'legacy-doc-1'`,
      );
      expect(legacy.rows[0].vault_path).toBe(TRANSCRIPT_PATH);
    }, 60_000);

    // THE CRITICAL (review round 1). The desk-scope carve-out is a line in a config
    // file, and an operator editing that file — adding a project, renaming a dir,
    // deleting a line — can remove it from under a transcript that synced fine last
    // week. From that tick the desk push's walker LISTS the file, `getDocRows`
    // (target='docs') cannot see the Meetings row that owns it, so the push adopts
    // it: a second Notion page, and `upsertDocSynced`'s ON CONFLICT (vault_path)
    // repointing the Meetings row at the page it just invented. `target` is never in
    // that UPDATE, so the row stays 'meetings', stays invisible, and the whole thing
    // happens again on the next tick — one duplicate page an hour, forever.
    //
    // Refusing to PROPOSE cannot stop this; the destruction is in a different pass.
    it("CRITICAL: the desk push cannot adopt a path a MEETINGS row owns, even with the carve-out gone", async () => {
      // 1. A transcript that synced normally, while the carve-out was in place.
      const fake = makeNotionFetch({
        markdown: { [TRANSCRIPT_PAGE]: MEETING_MD },
        queries: meetingsQuery("Ukesmøte"),
      });
      vi.stubGlobal("fetch", fake.impl);
      await syncTranscriptsOnce({ dryRun: false });
      const proposal = (await getOpenProposals(db)).find((row) => row.vaultPath === TRANSCRIPT_PATH);
      await resolveProposal(db, proposal?.id as number, "approve");
      await syncApplyOnce({ dryRun: false });
      expect(await readFile(join(vaultPath, TRANSCRIPT_PATH), "utf8")).toContain("<transcript>");

      // 2. The operator edits the config and the `exclude` line is gone.
      const brokenCfg = join(vaultPath, "config-carve-out-dropped.json");
      await writeFile(brokenCfg, JSON.stringify({
        notionVersion: "2026-03-11",
        meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
        docsDataSourceId: "11111111-1111-1111-1111-111111111111",
        wikiDir: "wiki",
        wikiProject: "Portfolio",
        deskDirs: [{ dir: DESK, project: "Zero7" }],          // ← no exclude
        twoWayDirs: [],
        mirrorFilePrefixes: [],
        transcripts: { dir: "transcripts", projects: [{ notionProject: "Zero7", vaultFolder: DESK }] },
        vaultPath,
        selfEmail: "owner@example.com",
        projects: [{ notionProject: "Zero7", vaultFolder: "zero7" }],
      }));
      process.env.NOTION_SYNC_CONFIG = brokenCfg;

      // 3. Two desk-push ticks with the carve-out gone.
      const push = makeNotionFetch({ markdown: {}, queries: [[]] });
      vi.stubGlobal("fetch", push.impl);
      await syncDeskPushOnce({ dryRun: false });
      await syncDeskPushOnce({ dryRun: false });

      // ZERO Notion writes FOR THE TRANSCRIPT, and the row still points at the
      // meeting it came from. Filtered by the path in the request body rather than
      // by method alone: this vault dir is shared with the block's other tests, so
      // their ordinary desk files are legitimately created here too.
      const touchedTranscript = push.requests.filter(
        (r) => r.method !== "GET" && JSON.stringify(r.body ?? {}).includes(TRANSCRIPT_PATH),
      );
      expect(touchedTranscript).toEqual([]);
      const rows = await db.query<{ notion_page_id: string; target: string }>(
        `SELECT notion_page_id, target FROM notion_sync_docs WHERE vault_path = $1`,
        [TRANSCRIPT_PATH],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].notion_page_id).toBe(TRANSCRIPT_PAGE);
      expect(rows.rows[0].target).toBe("meetings");
      // …and the file is untouched on disk.
      expect(await readFile(join(vaultPath, TRANSCRIPT_PATH), "utf8")).toContain("<transcript>");
    }, 60_000);
  });
});

describe("readSecretOptional(\"SIGNAL_SPINE_TOKEN\") — ORB-178 / ORB-35 item 4 _FILE precedence", () => {
  const KEY = "SIGNAL_SPINE_TOKEN";
  const FILE_KEY = "SIGNAL_SPINE_TOKEN_FILE";
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "notion-sync-spine-token-"));
    delete process.env[KEY];
    delete process.env[FILE_KEY];
  });

  afterEach(async () => {
    delete process.env[KEY];
    delete process.env[FILE_KEY];
    await rm(dir, { recursive: true, force: true });
  });

  it("prefers SIGNAL_SPINE_TOKEN_FILE, trimmed, over the plain env var", async () => {
    const tokenPath = join(dir, "token");
    await writeFile(tokenPath, "  from-file-token  \n");
    process.env[FILE_KEY] = tokenPath;
    process.env[KEY] = "from-env";

    expect(readSecretOptional(KEY)).toBe("from-file-token");
  });

  it("falls back to the plain env var when SIGNAL_SPINE_TOKEN_FILE is unset", () => {
    process.env[KEY] = "from-env";
    expect(readSecretOptional(KEY)).toBe("from-env");
  });

  it("is undefined when neither is set", () => {
    expect(readSecretOptional(KEY)).toBeUndefined();
  });
});

describe("notifyFromEnv — ORB-178 final-review: a configured-but-unusable spine token file must say so", () => {
  const KEY = "SIGNAL_SPINE_TOKEN";
  const FILE_KEY = "SIGNAL_SPINE_TOKEN_FILE";
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "notion-sync-notify-spine-token-"));
    delete process.env[KEY];
    delete process.env[FILE_KEY];
  });

  afterEach(async () => {
    delete process.env[KEY];
    delete process.env[FILE_KEY];
    await rm(dir, { recursive: true, force: true });
  });

  it("console.errors the path when _FILE points at a missing file, and still builds a (degraded) notify", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const tokenPath = join(dir, "does-not-exist");
      process.env[FILE_KEY] = tokenPath;

      const notify = notifyFromEnv();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toContain(tokenPath);
      expect(typeof notify).toBe("function");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("console.errors the path when _FILE points at a blank file", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const tokenPath = join(dir, "blank-token");
      await writeFile(tokenPath, "");
      process.env[FILE_KEY] = tokenPath;

      notifyFromEnv();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toContain(tokenPath);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does NOT console.error when neither _FILE nor the plain env var is set — the legitimate not-configured case", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      notifyFromEnv();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
