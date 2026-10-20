// The factories are thin; what needs proof is the RESOLUTION rule, so it is extracted as its
// own export and tested directly — the tool bodies then have no branching left to get wrong.
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readerForTurn, readTool, speakerFromAuth } from "../src/note-tools.js";

/** A note tool asks which areas the session may open, and refuses every one when
 *  nobody answers. These tests are about `onRead` and the reader, so they grant the private
 *  area and nothing else — `tests/vault-areas.test.ts` is where the guard itself is proved. */
const PRIVATE_ONLY = () => ["private"] as const;

// A schedule turn that touched the shared store failed with "unknown is not a member of
// this installation". A schedule's `to(...).send(prompt, { auth: appAuth })` lands eve's own app
// principal in `auth.current` — authenticator "app", no user attribute — and the decoder turned
// that into a speaker called "unknown", which the registry rightly refused. The app principal is
// the AGENT acting, not a person asking: with no member named it is "no speaker", so rule (a)
// applies and the agent reads as its configured owner. A per-member schedule that names a member
// in attributes keeps resolving that member.
describe("speakerFromAuth — a schedule turn's app principal is not a speaker", () => {
  it("app principal with no user attribute → undefined (resolves as the agent's owner)", () => {
    expect(speakerFromAuth({ current: { authenticator: "app", principalId: "eve:app", principalType: "runtime" } }))
      .toBeUndefined();
  });

  it("app principal that names a member (a per-member schedule) is still that member", () => {
    expect(speakerFromAuth({ current: { authenticator: "app", principalType: "runtime", attributes: { user_id: "emil" } } }))
      .toEqual({ system: "app", alias: "emil" });
  });

  it("a human on Slack is unchanged", () => {
    expect(speakerFromAuth({ current: { authenticator: "slack-webhook", attributes: { user_id: "U1" } } }))
      .toEqual({ system: "slack", alias: "U1" });
  });

  it("a human authenticator with no user id still fails closed as 'unknown'", () => {
    expect(speakerFromAuth({ current: { authenticator: "slack-webhook" } })).toEqual({ system: "slack", alias: "unknown" });
  });

  it("no auth at all is no speaker", () => {
    expect(speakerFromAuth(undefined)).toBeUndefined();
    expect(speakerFromAuth({ current: null })).toBeUndefined();
  });
});

describe("readerForTurn — who is the store being read for?", () => {
  it("a schedule turn (no human) with an owning agent reads as the agent's own user", async () => {
    const r = await readerForTurn(undefined, "brain", { AGENT_OWNER_USER_ID: "owner-1" }, async () => {
      throw new Error("must not resolve");
    });
    expect(r).toEqual({ userId: "owner-1", store: "brain" });
  });

  it("a schedule turn with no owner configured takes the legacy unfiltered path", async () => {
    expect(await readerForTurn(undefined, "brain", {}, async () => undefined)).toBeUndefined();
  });

  it("a human turn resolves via the registry", async () => {
    const r = await readerForTurn({ system: "slack", alias: "U1" }, "brain", {}, async () => ({
      id: "owner-1",
      orgId: "owner-1",
      orgRole: "owner" as const,
      displayName: "B",
    }));
    expect(r).toEqual({ userId: "owner-1", store: "brain" });
  });

  it("an unresolved stranger is an error, never the unfiltered path", async () => {
    await expect(
      readerForTurn({ system: "slack", alias: "U_NOBODY" }, "brain", {}, async () => undefined),
    ).rejects.toThrow(/not a member/);
  });

  it("an identity-registry outage propagates, never resolves to the unfiltered path", async () => {
    class FakeOutage extends Error {}
    await expect(
      readerForTurn({ system: "slack", alias: "U1" }, "brain", {}, async () => {
        throw new FakeOutage("registry unreachable");
      }),
    ).rejects.toBeInstanceOf(FakeOutage);
  });
});

// ── readTool's onRead dep ─────────────────────────────────────────────────
//
// A service (chief-of-staff) needs to know when its own reads succeed, to record them —
// but agent-kit is shared by every role service and must not import a service's lib. The
// injected `onRead` callback is the seam: optional, called only after a read SUCCEEDS, and
// the default (no deps) is today's behaviour exactly, so every caller that does not pass
// `deps` (services/creative, the mounted `vault_read` extension tool) is
// unaffected.
describe("readTool's onRead dep", () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env["VAULT_PATH"];
  });

  function fixture(path: string, content: string): void {
    dir = mkdtempSync(join(tmpdir(), "eve-note-tools-"));
    const abs = join(dir, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
    process.env["VAULT_PATH"] = dir;
  }

  it("fires with the store, the path asked for, and the turn's session/turn ids", async () => {
    fixture("people/vera.md", "# Vera\n");
    const calls: Array<[string, string, string | undefined, string | undefined]> = [];
    const tool = readTool({
      areas: PRIVATE_ONLY,
      onRead: (store, path, sessionId, turnId) => {
        calls.push([store, path, sessionId, turnId]);
      },
    });

    await tool.execute(
      { area: "private", path: "people/vera.md" },
      { session: { id: "s1", turn: { id: "t1" }, auth: null } } as never,
    );

    expect(calls).toEqual([["brain", "people/vera.md", "s1", "t1"]]);
  });

  it("passes undefined ids when ctx cannot name the turn, rather than guessing", async () => {
    fixture("people/vera.md", "# Vera\n");
    const calls: Array<[string | undefined, string | undefined]> = [];
    const tool = readTool({
      areas: PRIVATE_ONLY,
      onRead: (_store, _path, sessionId, turnId) => {
        calls.push([sessionId, turnId]);
      },
    });

    await tool.execute({ area: "private", path: "people/vera.md" }, { session: { id: "s1", auth: null } } as never);

    expect(calls).toEqual([["s1", undefined]]);
  });

  it("never fires when the read throws — a read that failed opened nothing", async () => {
    fixture("people/vera.md", "# Vera\n");
    const calls: unknown[] = [];
    const tool = readTool({ areas: PRIVATE_ONLY, onRead: (...args) => calls.push(args) });

    await expect(
      tool.execute(
        { area: "private", path: "people/missing.md" },
        { session: { id: "s1", turn: { id: "t1" }, auth: null } } as never,
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("with no onRead, reads exactly as before — the default every other caller relies on", async () => {
    fixture("people/vera.md", "# Vera — plain.\n");
    const tool = readTool({ areas: PRIVATE_ONLY });
    const result = await tool.execute(
      { area: "private", path: "people/vera.md" },
      { session: { id: "s1", turn: { id: "t1" }, auth: null } } as never,
    );
    // `execute` is typed as value-or-stream; this tool always answers with a value.
    expect((result as { content: string }).content).toContain("plain");
  });
});

describe("readTool pages long notes", () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env["VAULT_PATH"];
  });
  function fixture(path: string, content: string): void {
    dir = mkdtempSync(join(tmpdir(), "eve-note-tools-"));
    const abs = join(dir, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
    process.env["VAULT_PATH"] = dir;
  }
  const ctx = { session: { id: "s1", turn: { id: "t1" }, auth: null } } as never;
  type Page = { content: string; truncated?: boolean; totalChars?: number; nextOffset?: number; note?: string; lines: number };
  const read = async (offset?: number): Promise<Page> =>
    (await readTool({ areas: PRIVATE_ONLY }).execute(
      { area: "private", path: "long.md", ...(offset === undefined ? {} : { offset }) },
      ctx,
    )) as Page;

  it("a short note comes back whole, with no paging fields", async () => {
    fixture("long.md", "# Short\n");
    const r = await read();
    expect(r.content).toBe("# Short\n");
    expect(r.truncated).toBeUndefined();
    expect(r.note).toBeUndefined();
  });

  it("a long note is cut at 12,000 characters with a note and the next offset", async () => {
    fixture("long.md", "a".repeat(30000));
    const r = await read();
    expect(r.content).toHaveLength(12000);
    expect(r.truncated).toBe(true);
    expect(r.totalChars).toBe(30000);
    expect(r.nextOffset).toBe(12000);
    expect(r.note).toContain("offset=12000");
  });

  it("offset returns the next page, and the last page carries no note", async () => {
    const text = "x".repeat(12000) + "y".repeat(12000) + "z".repeat(500);
    fixture("long.md", text);
    const second = await read(12000);
    expect(second.content).toBe("y".repeat(12000));
    expect(second.nextOffset).toBe(24000);
    const last = await read(24000);
    expect(last.content).toBe("z".repeat(500));
    expect(last.truncated).toBeUndefined();
    expect(last.note).toBeUndefined();
  });

  it("an offset past the end gives empty content and an explanation", async () => {
    fixture("long.md", "short");
    const r = await read(999);
    expect(r.content).toBe("");
    expect(r.note).toContain("past the end");
  });
});
