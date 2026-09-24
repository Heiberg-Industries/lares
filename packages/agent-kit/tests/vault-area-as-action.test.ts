/**
 * W5C-s8 — THE AREA IS THE ACTION (controller ruling, 2026-09-19).
 *
 * WHAT WENT WRONG WITHOUT THIS. Until W5C-s5 a board-approved vault tool's ratchet key was the
 * capability it was registered under: chief-of-staff's `atlas_resolve_proposal` read
 * `(agent, "atlas", "")` and `forget` / `memory_resolve_proposal` read `(agent, "memory", "")`.
 * Folding the three names into one `vault` left all three reading ONE row, `(agent, "vault", "")` —
 * so switching the shared-store proposal lane to ✓ would have switched `forget` to ✓ with it, and
 * 🚫 on the facts would have switched off the shared store. A rename is not allowed to merge two
 * permissions the owner set apart.
 *
 * THE RULING: the tool's AREA is the ratchet `action`. `(agent, "vault", "shared")`,
 * `(agent, "vault", "facts")`, `(agent, "vault", "private")` — one row each, 1:1 with the three old
 * `(agent, <old capability>, "")` rows, so nothing merges and nothing widens.
 *
 * Everything here runs against the REAL committed neutral declarations
 * (`templates/<role>/agent.json`) and the REAL tool→capability / tool→area tables in
 * `always-ask.ts` — never a fixture manifest with a hand-written grant, because the thing being
 * proved is that the shipped definitions and the shipped catalogue agree on the key.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boardApproval, type BoardDeps, clearBoardCache, setBoardDeps } from "../src/board-approval.js";
import type { AutonomyLevel } from "../src/manifest.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The REAL committed neutral declaration for a role — the same source vault-tool-names.test.ts reads. */
function template(role: string): unknown {
  return JSON.parse(readFileSync(join(here, "..", "templates", role, "agent.json"), "utf8"));
}

interface Recorded { tool: string; capability: string; decision: string; reason: string }

/** A board whose rows are keyed by the FULL ratchet key, `agent/capability/action` — the whole
 *  point of this file is which of those keys the policy asks for, so a fake that ignored `action`
 *  (as `board-approval.test.ts`'s does, deliberately) could not see the bug. */
function board(levels: Record<string, AutonomyLevel> = {}) {
  const reads: string[] = [];
  const events: Recorded[] = [];
  const explicitLevel = vi.fn(async (agent: string, capability: string, action?: string) => {
    reads.push(`${agent}/${capability}/${action ?? ""}`);
    return levels[`${agent}/${capability}/${action ?? ""}`] ?? null;
  });
  const deps: BoardDeps = {
    explicitLevel,
    record: async (e) => { events.push({ tool: e.tool, capability: e.capability, decision: e.decision, reason: e.reason }); },
    now: () => 0,
  };
  return { deps, explicitLevel, reads, events };
}

/** The evidence write is fire-and-forget (`void deps.record(...)`), so it lands a tick later. */
const settle = () => new Promise((r) => setImmediate(r));

afterEach(() => {
  clearBoardCache();
  setBoardDeps(null);
  vi.restoreAllMocks();
});

describe("a board-approved vault tool looks its level up under its AREA", () => {
  it("chief-of-staff's shared-store proposal lane reads (agent, vault, shared)", async () => {
    const f = board();
    setBoardDeps(f.deps);
    await boardApproval(template("chief-of-staff"), "atlas_resolve_proposal")();
    expect(f.explicitLevel).toHaveBeenCalledWith("chief-of-staff", "vault", "shared");
  });

  it("its two fact tools read (agent, vault, facts)", async () => {
    const f = board();
    setBoardDeps(f.deps);
    await boardApproval(template("chief-of-staff"), "forget")();
    await boardApproval(template("chief-of-staff"), "memory_resolve_proposal")();
    expect(f.reads).toEqual(["chief-of-staff/vault/facts"]); // one read, then the 30 s cache
    expect(f.explicitLevel).toHaveBeenCalledWith("chief-of-staff", "vault", "facts");
  });

  it("a level set for the shared area is NOT read by a facts tool — the merge is undone", async () => {
    const f = board({ "chief-of-staff/vault/shared": "autonomous" });
    setBoardDeps(f.deps);
    // The owner switched the shared-store proposal lane on…
    expect(await boardApproval(template("chief-of-staff"), "atlas_resolve_proposal")()).toBe("not-applicable");
    // …and the facts lane is untouched: no row of its own, so it falls back to the definition's
    // own `vault: gated`. Before the ruling both tools read one row and this was "not-applicable".
    expect(await boardApproval(template("chief-of-staff"), "memory_resolve_proposal")()).toBe("user-approval");
    expect(f.reads).toEqual(["chief-of-staff/vault/shared", "chief-of-staff/vault/facts"]);
  });

  it("…and the other way round: 🚫 on the facts does not switch off the shared store", async () => {
    const f = board({ "chief-of-staff/vault/facts": "never" });
    setBoardDeps(f.deps);
    expect(await boardApproval(template("chief-of-staff"), "memory_resolve_proposal")()).toMatchObject({ type: "denied" });
    expect(await boardApproval(template("chief-of-staff"), "atlas_resolve_proposal")()).toBe("user-approval");
  });

  it("creative's own shared-store write reads (agent, vault, shared)", async () => {
    const f = board({ "creative/vault/shared": "autonomous" });
    setBoardDeps(f.deps);
    expect(await boardApproval(template("creative"), "vault_write")()).toBe("not-applicable");
    expect(f.explicitLevel).toHaveBeenCalledWith("creative", "vault", "shared");
  });

  it("the kit's own personal-store tools read (agent, vault, private)", async () => {
    const f = board();
    setBoardDeps(f.deps);
    await boardApproval(template("chief-of-staff"), "agent-kit__vault_write")();
    expect(f.explicitLevel).toHaveBeenCalledWith("chief-of-staff", "vault", "private");
  });

  it("an explicit `action` from the caller still wins over the area", async () => {
    const f = board({ "creative/vault/one-off": "autonomous" });
    setBoardDeps(f.deps);
    expect(await boardApproval(template("creative"), "vault_write", { action: "one-off" })()).toBe("not-applicable");
    expect(f.reads).toEqual(["creative/vault/one-off"]);
  });

  it("a non-vault tool is byte-identical: no action at all", async () => {
    const f = board();
    setBoardDeps(f.deps);
    await boardApproval(template("chief-of-staff"), "gmail_send")();
    expect(f.explicitLevel).toHaveBeenCalledWith("chief-of-staff", "gmail", undefined);
  });

  it("the evidence names the tool, so the area is recoverable from the log", async () => {
    // `approval_events` (038) has no `action` column, so the evidence row is keyed on the
    // capability alone — the AREA is recoverable from the `tool` column it already carries, which
    // is how the console attributes a vault decision to one of the three rows.
    const f = board();
    setBoardDeps(f.deps);
    await boardApproval(template("chief-of-staff"), "atlas_resolve_proposal")();
    await settle();
    expect(f.events).toEqual([expect.objectContaining({ tool: "atlas_resolve_proposal", capability: "vault" })]);
  });
});

describe("a vault tool the area table does not know fails closed", () => {
  it("asks, records failed-closed, and never reads a level — exactly as an unknown capability does", async () => {
    // No such tool exists today (`CAPABILITY_DOCS.vault.tools` IS the three area groups), and this
    // is the guard that keeps it that way: a future vault tool added to the capability doc but not
    // to the area table must not quietly fall back to the merged `action = ''` row.
    vi.resetModules();
    vi.doMock("../src/always-ask.js", async () => {
      const actual = await vi.importActual<typeof import("../src/always-ask.js")>("../src/always-ask.js");
      return { ...actual, areaOfTool: (t: string) => (t === "vault_read" ? undefined : actual.areaOfTool(t)) };
    });
    try {
      const fresh = await import("../src/board-approval.js");
      const f = board({ "chief-of-staff/vault/": "autonomous" });
      fresh.setBoardDeps(f.deps);
      expect(await fresh.boardApproval(template("chief-of-staff"), "vault_read")()).toBe("user-approval");
      await settle();
      expect(f.reads).toEqual([]);
      expect(f.events).toEqual([expect.objectContaining({ tool: "vault_read", decision: "failed-closed" })]);
      fresh.setBoardDeps(null);
      fresh.clearBoardCache();
    } finally {
      vi.doUnmock("../src/always-ask.js");
      vi.resetModules();
    }
  });
});
