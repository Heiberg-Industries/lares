// A file the owner told the agent to forget must not be resurrected by a later
// Notion pull (ADR-0017 rule 7; WAVE-3-NOTES W5B-s4). `runApplySync`'s CREATE branch
// consults an injected `pathWasForgotten` dependency for exactly this — see its
// header in ../lib/apply-sync.ts for why it is a dependency rather than a direct
// `@lares/vault-format/forget-ledger` call inside the engine (the engine takes no DB
// handle of its own; every other guard here is an injected async predicate too).
//
// In-memory only, like every other apply-sync seam test in this package — no
// Docker, no Postgres. The dependency itself (the real `wasPathForgotten` wired
// against the forget_ledger table) is `@lares/vault-format/forget-ledger`'s own
// concern and is covered by that package's own tests.
import { describe, it, expect } from "vitest";
import { runApplySync, type ApplySyncDeps, type ApplySyncOptions } from "../lib/apply-sync.js";
import { docRenderHash, type PullDocProps, type RenderedDoc } from "../lib/pull-sync.js";
import { sha256 } from "../lib/wiki-sync.js";
import { makeCreateScope } from "../lib/desk-scope.js";
import { makeCollisionLookup } from "./helpers/collision-world.js";
import type { LinkedRow, ProposalRow } from "../lib/store.js";

const SCOPE = makeCreateScope({
  desks: { deskDirs: [{ dir: "people", project: "W" }], twoWayDirs: [], mirrorFilePrefixes: [] },
  transcripts: { dir: "transcripts", projects: [] },
});
const OPTS: ApplySyncOptions = { dryRun: false, inCreateScope: SCOPE };

const PATH = "people/ada.md";
const OTHER_PATH = "people/other.md";
const BODY = "notes from Notion";

function makeProps(vaultPath: string): PullDocProps {
  return { name: "Ada", project: "W", folder: "people", vaultPath, frontmatter: "", archived: false, sync: "✍️ Desk" };
}

function makeCreateProposal(over: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: 9,
    vaultPath: PATH,
    notionPageId: "n9",
    proposedBody: BODY,
    baseMdHash: "",
    notionHash: sha256(BODY),
    diffPreview: `+ ${BODY}`,
    kind: "create",
    notionOwned: false,
    state: "approved",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    ...over,
  };
}

interface Scenario {
  forgottenAt?: Date | null;
  pathWasForgottenThrows?: boolean;
}

/** No doc row anywhere — the state every one of these creates requires. */
const NO_ROWS = new Map<string, LinkedRow>();

function makeDeps(cfg: Scenario) {
  const created: Array<{ vaultPath: string; content: string }> = [];
  const proposalStates: Array<{ id: number; state: string }> = [];
  const frozenCalls: Array<{ vaultPath: string; reason: string }> = [];
  const notified: string[] = [];
  const onDisk = new Set<string>();
  const rendered: Record<string, RenderedDoc> = {
    [PATH]: { markdown: BODY, props: makeProps(PATH) },
    [OTHER_PATH]: { markdown: BODY, props: makeProps(OTHER_PATH) },
  };

  const impl: ApplySyncDeps = {
    getOpenProposals: async () => [],
    getRejectedUnexecuted: async () => [],
    getLinkedRows: async () => new Map(NO_ROWS),
    renderDoc: async (vaultPath) => {
      const doc = rendered[vaultPath];
      if (doc === undefined) throw new Error(`ENOENT: ${vaultPath}`);
      return doc;
    },
    readVaultFile: async (vaultPath) => {
      throw new Error(`unexpected read: ${vaultPath}`);
    },
    writeVaultFile: async (vaultPath) => {
      throw new Error(`unexpected write: ${vaultPath}`);
    },
    vaultFileExists: async (vaultPath) => onDisk.has(vaultPath),
    listCollisionCandidates: makeCollisionLookup(() => onDisk),
    createVaultFile: async (vaultPath, content) => {
      onDisk.add(vaultPath);
      created.push({ vaultPath, content });
    },
    patchPageMarkdown: async () => {
      throw new Error("unexpected Notion write");
    },
    updateDocProps: async () => {
      throw new Error("unexpected Notion write");
    },
    getPageMarkdown: async () => {
      throw new Error("unexpected Notion read");
    },
    upsertDocSynced: async () => {},
    linkPageToVaultFile: async () => {},
    recordNotionAccounted: async () => {},
    updateNotionWatermark: async () => {},
    setProposalState: async (id, state) => {
      proposalStates.push({ id, state });
    },
    markProposalReverted: async () => {},
    freezeDoc: async (vaultPath, reason) => {
      frozenCalls.push({ vaultPath, reason });
    },
    recordDocError: async () => {},
    notify: async (message) => {
      notified.push(message);
    },
    pathWasForgotten: async (vaultPath) => {
      if (cfg.pathWasForgottenThrows === true) throw new Error("forget_ledger unreachable");
      return vaultPath === PATH ? cfg.forgottenAt ?? null : null;
    },
  };

  return { impl, created, proposalStates, frozenCalls, notified, onDisk };
}

describe("runApplySync — the create branch and the forget ledger", () => {
  it("does not create a vault file the owner told it to forget", async () => {
    const forgottenAt = new Date("2026-08-04T00:00:00.000Z");
    const d = makeDeps({ forgottenAt });
    const result = await runApplySync(OPTS, { ...d.impl, getOpenProposals: async () => [makeCreateProposal()] });

    expect(d.created).toEqual([]);
    expect(result.applied).toBe(0);
    expect(result.superseded).toBe(1);
    // Refused through the SAME channel every other refused create reaches the owner
    // through — never a silent drop — and it names the date plainly, never the words
    // (the ledger holds none).
    expect(d.notified).toHaveLength(1);
    expect(d.notified[0]).toMatch(/refused/i);
    expect(d.notified[0]).toContain(PATH);
    expect(d.notified[0]).toContain("forget this file on 2026-08-04");
    // Not a freeze: guard 0 already proved no doc row exists for this path, and a
    // freeze is a claim about a row.
    expect(d.frozenCalls).toEqual([]);
    expect(d.proposalStates).toEqual([{ id: 9, state: "superseded" }]);
  });

  it("creates a file that was never forgotten", async () => {
    const d = makeDeps({ forgottenAt: null });
    const result = await runApplySync(OPTS, { ...d.impl, getOpenProposals: async () => [makeCreateProposal()] });

    expect(d.created).toHaveLength(1);
    expect(d.created[0]!.vaultPath).toBe(PATH);
    expect(result.applied).toBe(1);
    expect(result.superseded).toBe(0);
  });

  it("creates normally when the forget-ledger check itself fails", async () => {
    const d = makeDeps({ pathWasForgottenThrows: true });
    const result = await runApplySync(OPTS, { ...d.impl, getOpenProposals: async () => [makeCreateProposal()] });

    expect(d.created).toHaveLength(1);
    expect(result.applied).toBe(1);
    expect(result.superseded).toBe(0);
  });

  it("leaves the UPDATE path alone — the ledger is asked only for a create", async () => {
    let asked = false;
    const d = makeDeps({});
    const trackingDeps: ApplySyncDeps = {
      ...d.impl,
      getOpenProposals: async () => [
        makeCreateProposal({
          id: 11, kind: "update", vaultPath: OTHER_PATH, notionPageId: "n11",
          baseMdHash: docRenderHash({ markdown: BODY, props: makeProps(OTHER_PATH) }),
        }),
      ],
      getLinkedRows: async () => new Map([[OTHER_PATH, {
        pageId: "n11", mdHash: docRenderHash({ markdown: BODY, props: makeProps(OTHER_PATH) }),
        notionHash: sha256(BODY), notionLastEdited: null, state: "synced", direction: "two_way",
        target: "docs" as const,
      }]]),
      readVaultFile: async () => `---\ntitle: Ada\n---\n\n${BODY}\n`,
      writeVaultFile: async () => {},
      pathWasForgotten: async () => {
        asked = true;
        return null;
      },
    };
    await runApplySync(OPTS, trackingDeps);
    expect(asked).toBe(false);
  });
});
