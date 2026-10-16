// W7A-s2 — THE PERMISSIONS BOARD DECIDES THE VAULT'S OWN WRITES TOO.
//
// The hole this closes: the three tools the chief of staff actually uses to write, move and
// delete notes in the personal area (`agent-kit__vault_write` / `_file` / `_drop`) were built by
// the factories in `../extension/lib/note-write-tools.ts`, which hard-coded eve's `always()`.
// The board was never consulted for them, so a 🚫 on "Private notes" did not refuse them and no
// `approval_events` row was ever written — the console's evidence column for that row was
// permanently blank. `services/chief-of-staff/tests/board-wiring.test.ts` bans a bare `always()`,
// but it only scans that service's own two directories, and this `always()` lived in the kit.
//
// THE BAR, AND WHY EACH CASE BELOW EXISTS: nothing may become EASIER than it was unless the
// owner moved a dial. So the cases are written against the REAL committed declaration
// (`services/chief-of-staff/agent.json` — the one `lib/board.ts` binds `approvalFor` to), never
// a fixture with a hand-written grant, and against the REAL tool→area table: with no `ratchet`
// row, the definition's own `vault: "gated"` is the fallback and all three ask exactly as they
// did under `always()`. The two directions the owner CAN now move are pinned too: 🚫 refuses,
// and ✓ acts on its own for the two non-destructive tools while `_drop` keeps asking, because
// deleting is an always-ask `delete` category that no setting can loosen (owner decision A1).
//
// WHY THE FACTORY STILL DEFAULTS TO `always()`: the mounted `../extension/tools/vault_*.ts`
// copies have no policy to inject (an extension has no per-session definition read), and every
// role service supersedes them. A default of "ask" is the honest answer for a tool nobody has
// wired to a board.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { boardApproval, type BoardDeps, clearBoardCache, setBoardDeps } from "../src/board-approval.js";
import type { AutonomyLevel } from "../src/manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const COS = join(here, "..", "..", "..", "services", "chief-of-staff", "catalogue");

/** The REAL declaration the chief of staff's `approvalFor` is bound to — `lib/board.ts` imports
 *  this very file. Read from disk rather than imported so this kit test needs no path mapping. */
const DECLARATION: unknown = JSON.parse(
  readFileSync(join(here, "..", "..", "..", "services", "chief-of-staff", "agent.json"), "utf8"),
);

const THREE = ["agent-kit__vault_write", "agent-kit__vault_file", "agent-kit__vault_drop"] as const;

interface Recorded { tool: string; capability: string; decision: string; reason: string }

/** A board keyed on the FULL ratchet key `agent/capability/action`, the way
 *  `vault-area-as-action.test.ts`'s fake is: the whole question here is which row these three
 *  tools land on, so a fake that ignored `action` could not see the answer. */
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

describe("the Vault's own write tools answer to the permissions board", () => {
  it("uses the injected policy instead of always() when one is given", async () => {
    const { writeTool } = await import("../extension/lib/note-write-tools.js");
    const calls: unknown[] = [];
    const tool = writeTool({ approval: (ctx) => { calls.push(ctx); return "user-approval"; } }) as unknown as {
      approval?: (ctx?: unknown) => unknown;
    };
    expect(typeof tool.approval).toBe("function");
    expect(await tool.approval!({ toolInput: { area: "private" } })).toBe("user-approval");
    expect(calls).toEqual([{ toolInput: { area: "private" } }]);
  });

  it("still asks, every time, when no policy is injected", async () => {
    const { dropTool } = await import("../extension/lib/note-write-tools.js");
    const tool = dropTool() as unknown as { approval?: (ctx?: unknown) => unknown };
    expect(await tool.approval!({})).toBe("user-approval");
  });

  it("the chief of staff's three vault writes name themselves to the board", () => {
    for (const name of THREE) {
      expect(readFileSync(join(COS, `${name}.ts`), "utf8"), name).toContain(`approvalFor("${name}")`);
    }
  });

  it("the chief of staff's three vault writes also inject the card check (W7A-s6)", () => {
    for (const name of THREE) {
      expect(readFileSync(join(COS, `${name}.ts`), "utf8"), name).toContain("assertApprovedCall:");
    }
  });
});

// W7A-s6 — the extension bundle cannot import @lares/agent-kit/approval-ledger (see
// note-write-tools.ts's own header), so the freshness/payload check is injected through
// `NoteWriteDeps.assertApprovedCall`. These cases pin the ORDER inside `execute`: the approver
// check (bound, in production, to `extension.config.brain?.isApprovedPrincipal`) runs first and
// unconditionally, exactly as it always has; the injected check runs after it and before any
// area is resolved or any git write happens.
describe("the injected card check runs after the approver and before any git write", () => {
  let written: { frontmatter?: Record<string, unknown>; body?: string } | undefined;

  beforeEach(() => {
    written = undefined;
    vi.resetModules();
    // Same technique as vault-write-origin.test.ts: a plain `import` never runs eve's mount
    // factory, so the production `assertApprover` always refuses here (vault-write-gate.test.ts's
    // own header explains why) — mocked so these cases can observe what happens once it PASSES.
    vi.doMock("../extension/lib/approval-gate.js", () => ({
      approverFrom: () => ({ userId: "U1" }),
      assertApprover: () => undefined,
    }));
    vi.doMock("../src/vault-git.js", () => ({
      commitNote: async (o: { frontmatter: Record<string, unknown>; body: string }) => {
        written = o;
        return { commit: "abc1234" };
      },
    }));
    vi.doMock("../src/notes-store.js", () => ({ storeRootForArea: () => "/tmp/vault" }));
  });

  afterEach(() => {
    vi.doUnmock("../extension/lib/approval-gate.js");
    vi.doUnmock("../src/vault-git.js");
    vi.doUnmock("../src/notes-store.js");
  });

  it("a refusal from the injected check happens with the approver already having passed, and before any write", async () => {
    const { writeTool } = await import("../extension/lib/note-write-tools.js");
    const seen: unknown[] = [];
    const tool = writeTool({
      areas: () => ["private"],
      assertApprovedCall: async (ctx, input) => {
        seen.push(input); // reached at all ⇒ the approver check above it already passed
        throw new Error("stale — refused by the injected check");
      },
    });
    await expect(
      tool.execute({ area: "private", title: "t", body: "b" }, { session: { id: "s" } } as never),
    ).rejects.toThrow("stale — refused by the injected check");
    expect(seen).toEqual([{ area: "private", title: "t", body: "b" }]);
    expect(written).toBeUndefined();
  });

  it("when the injected check passes, the write proceeds exactly as it did before this slice", async () => {
    const { writeTool } = await import("../extension/lib/note-write-tools.js");
    const order: string[] = [];
    const tool = writeTool({
      areas: () => ["private"],
      assertApprovedCall: async () => {
        order.push("card-checked");
      },
    });
    await tool.execute({ area: "private", title: "t", body: "b" }, { session: { id: "s" } } as never);
    expect(order).toEqual(["card-checked"]);
    expect(written?.frontmatter?.["title"]).toBe("t");
  });

  it("omitting the injected check costs nothing — no check, and the write proceeds", async () => {
    const { writeTool } = await import("../extension/lib/note-write-tools.js");
    const tool = writeTool({ areas: () => ["private"] });
    await tool.execute({ area: "private", title: "t", body: "b" }, { session: { id: "s" } } as never);
    expect(written?.frontmatter?.["title"]).toBe("t");
  });
});

describe("nothing is easier than it was until the owner moves the dial", () => {
  it("with no row on the board, all three ask — exactly as the hard-coded always() did", async () => {
    const f = board(); // no rows at all: the fallback is the declaration's own `vault: "gated"`
    setBoardDeps(f.deps);
    for (const name of THREE) {
      expect(await boardApproval(DECLARATION, name)(), name).toBe("user-approval");
    }
    // One read, then the 30 s cache: all three sit on the SAME row, the one the console already
    // renders as "Private notes".
    expect(f.reads).toEqual(["chief-of-staff/vault/private"]);
  });

  it("every one of the three is keyed on (agent, vault, private) — the Private notes row", async () => {
    for (const name of THREE) {
      clearBoardCache();
      const f = board();
      setBoardDeps(f.deps);
      await boardApproval(DECLARATION, name)();
      expect(f.explicitLevel, name).toHaveBeenCalledWith("chief-of-staff", "vault", "private");
    }
  });
});

describe("🚫 on Private notes refuses all three, and the refusal is evidence", () => {
  it("each one is denied in a sentence the model can relay, and recorded", async () => {
    for (const name of THREE) {
      clearBoardCache();
      const f = board({ "chief-of-staff/vault/private": "never" });
      setBoardDeps(f.deps);
      expect(await boardApproval(DECLARATION, name)(), name).toEqual({
        type: "denied",
        reason: "vault is switched off for chief-of-staff on the permissions board",
      });
      await settle();
      expect(f.events, name).toEqual([
        expect.objectContaining({ tool: name, capability: "vault", decision: "denied" }),
      ]);
    }
  });
});

describe("deleting a note always asks, whatever the dial says", () => {
  it("✓ on Private notes lets a save and a move act alone, but never a delete", async () => {
    const f = board({ "chief-of-staff/vault/private": "autonomous" });
    setBoardDeps(f.deps);
    // Owner decision A1: setting the dial to "act on its own" is allowed to remove the card from
    // the two non-destructive tools…
    expect(await boardApproval(DECLARATION, "agent-kit__vault_write")()).toBe("not-applicable");
    expect(await boardApproval(DECLARATION, "agent-kit__vault_file")()).toBe("not-applicable");
    // …and is NOT allowed to remove it from the one that destroys a note. `agent-kit__vault_drop`
    // is `["delete"]` in `TOOL_CATEGORIES`, an always-ask category no setting can loosen.
    expect(await boardApproval(DECLARATION, "agent-kit__vault_drop")()).toBe("user-approval");
    await settle();
    expect(f.events.map((e) => `${e.tool}:${e.decision}`)).toEqual([
      "agent-kit__vault_write:autonomous",
      "agent-kit__vault_file:autonomous",
      "agent-kit__vault_drop:locked",
    ]);
  });
});
