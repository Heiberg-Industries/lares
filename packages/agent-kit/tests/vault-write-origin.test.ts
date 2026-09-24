import { describe, it, expect, beforeEach, vi } from "vitest";
import { readOriginFrontmatter } from "../src/origin.js";

const ctx = { session: { id: "s1", turn: { id: "t1" }, auth: { current: { authenticator: "slack-webhook", principalId: "U1" } } } } as never;

let written: { frontmatter: Record<string, unknown>; body: string } | undefined;

beforeEach(() => {
  written = undefined;
  vi.resetModules();
  vi.doMock("../src/vault-git.js", () => ({
    commitNote: async (o: never) => { written = o as never; return { commit: "abc1234" }; },
  }));
  vi.doMock("../src/notes-store.js", () => ({ storeRootForArea: () => "/tmp/vault" }));
  vi.doMock("../extension/lib/approval-gate.js", () => ({ approverFrom: () => "U1", assertApprover: () => undefined }));
});

/**
 * DEVIATION FROM THE SLICE'S GIVEN TEST CODE, and why (reported per BUILDER.md) — the same fix
 * W3A-s5 already made to `origin-taint-reads.test.ts` (its own header explains the mechanism at
 * length): a static, file-top import of `../src/origin-taint.js` is bound BEFORE any
 * `vi.resetModules()` runs, so it is a DIFFERENT module instance — with its own separate
 * `taints` Map — than the one the dynamically re-imported tool resolves to after
 * `vi.resetModules()`. Confirmed by running the slice's given test verbatim first: "stamps
 * third_party once the turn has read somebody else's words" failed with "expected 'agent' to be
 * 'third_party'" — the taint was set on a module instance the tool never reads from.
 * `taintTurn` must come from the SAME fresh import the tool itself will use.
 */
async function freshTaint() {
  return import("../src/origin-taint.js");
}

/** W5C-s4: the write tool is a FACTORY now, and the mounted copy deliberately carries no area
 *  authority (it would refuse every area). Every case here builds its own instance with the
 *  personal area open — the same thing
 *  `services/chief-of-staff/catalogue/agent-kit__vault_write.ts` does with the session's real
 *  grant — so these cases still test the stamp rather than the guard. */
async function writeToolWithAuthority() {
  const { writeTool } = await import("../extension/lib/note-write-tools.js");
  return writeTool({ areas: () => ["private"] });
}

describe("vault_write stamps where the note came from", () => {
  it("stamps lares_origin: agent on an untainted turn", async () => {
    const tool = await writeToolWithAuthority();
    await tool.execute({ area: "private", title: "A note", body: "text" }, ctx);
    expect(written!.frontmatter["lares_origin"]).toBe("agent");
  });

  it("stamps third_party once the turn has read somebody else's words", async () => {
    (await freshTaint()).taintTurn({ sessionId: "s1", turnId: "t1" }, "third_party");
    const tool = await writeToolWithAuthority();
    await tool.execute({ area: "private", title: "A note", body: "text" }, ctx);
    expect(written!.frontmatter["lares_origin"]).toBe("third_party");
  });

  it("the stamp survives a round trip through the note's own bytes", async () => {
    const tool = await writeToolWithAuthority();
    await tool.execute({ area: "private", title: "A note", body: "text" }, ctx);
    const raw = ["---", ...Object.entries(written!.frontmatter).map(([k, v]) => `${k}: ${v}`), "---", "", written!.body].join("\n");
    expect(readOriginFrontmatter(raw)).toBe("agent");
  });

  it("carries no persona or owner name", async () => {
    const tool = await writeToolWithAuthority();
    await tool.execute({ area: "private", title: "A note", body: "text" }, ctx);
    const text = JSON.stringify(written!.frontmatter) + String(tool.description);
    expect(text.toLowerCase()).not.toMatch(/saga|marcel|calliope|bendik|heiberg/);
  });

  it("takes no origin from the model", async () => {
    const tool = await writeToolWithAuthority();
    expect(Object.keys((tool.inputSchema as never as { shape: object }).shape).sort()).toEqual(["area", "body", "tags", "title"]);
  });

  it("fails closed to third_party when the turn key cannot be determined, and still writes the note", async () => {
    // No session at all: turnKeyFrom(ctx) returns undefined. The spec's fail-closed rule —
    // an unattributable write gets the LEAST trusted class, never the intended one — and a
    // hook or context problem must never cost the owner their note (the write still succeeds).
    const noTurnCtx = { session: { auth: { current: { authenticator: "slack-webhook", principalId: "U1" } } } } as never;
    const tool = await writeToolWithAuthority();
    const result = await tool.execute({ area: "private", title: "A note", body: "text" }, noTurnCtx);
    expect(written!.frontmatter["lares_origin"]).toBe("third_party");
    expect(result).toEqual({ commit: "abc1234" });
  });
});
