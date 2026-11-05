import { describe, it, expect } from "vitest";

import {
  makeScheduledVault, scheduledVaultMounted, splitRawNote, ScheduledVaultError, ScheduledVaultTooLargeError,
  type BrokerRequest,
} from "../lib/scheduled-vault.js";
import { makeKeeperDreamBrain } from "../agent/schedules/dream.js";
import { makeKeeperInbox } from "../lib/clipping/step.js";
import { renderClipNote } from "../lib/clipping/record.js";
import { ClippingFailure } from "../lib/clipping/notion-reader.js";

/** A fake keeper: remembers notes, answers the operations the way the real one does. */
function fakeKeeper(opts: { refuse?: boolean; pageSize?: number } = {}) {
  const files = new Map<string, string>();
  const calls: Array<{ op: string; input: any; timeoutMs?: number }> = [];
  const request: BrokerRequest = async (op, input: any, timeoutMs) => {
    calls.push({ op, input, timeoutMs });
    if (opts.refuse) throw new Error("Vault reader unavailable");
    if (input.operation === "list") {
      const all = [...files.keys()].filter((p) => p.startsWith(input.prefix)).sort().filter((p) => p > (input.cursor ?? ""));
      const size = opts.pageSize ?? 200, page = all.slice(0, size);
      return { ok: true, paths: page, ...(all.length > size ? { nextCursor: page.at(-1) } : {}) };
    }
    if (input.operation === "read") {
      const c = files.get(input.path);
      if (c === undefined) return { ok: true, found: false };
      return input.probe ? { ok: true, found: true } : { ok: true, found: true, content: c };
    }
    if (input.operation === "write") {
      files.set(input.path, `---\n${Object.entries(input.frontmatter).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${input.body}`);
      return { ok: true, commit: "abc1234" };
    }
    if (input.operation === "write-verbatim") {
      const same = files.get(input.path) === input.content;
      files.set(input.path, input.content);
      return same ? { ok: true, path: input.path, unchanged: true } : { ok: true, path: input.path, commit: "abc1234" };
    }
    if (input.operation === "remove") return { ok: true, removed: files.delete(input.path) };
    throw new Error("unexpected");
  };
  return { files, calls, request };
}

describe("scheduled vault adapter", () => {
  it("is used only when no Vault folder is mounted", () => {
    expect(scheduledVaultMounted({})).toBe(false);
    expect(scheduledVaultMounted({ VAULT_PATH: "  " })).toBe(false);
    expect(scheduledVaultMounted({ VAULT_PATH: "/some/folder" })).toBe(true);
  });

  it("names its schedule and area on every call and asks for the longer deadline", async () => {
    const k = fakeKeeper();
    const vault = makeScheduledVault("dream", { request: k.request });
    await vault.write("_meta/dream/2026-11-01.md", { frontmatter: { cursor: "x" }, body: "b", message: "learning: x" });
    await vault.read("_meta/dream/2026-11-01.md");
    expect(k.calls.map((c) => c.input.schedule)).toEqual(["dream", "dream"]);
    expect(k.calls.every((c) => c.op === "vault.scheduled" && c.input.area === "private" && c.timeoutMs === 10_000)).toBe(true);
    // Nothing in a request names an owner: keeper reads the owner from the agent's access record.
    expect(JSON.stringify(k.calls)).not.toMatch(/owner/i);
  });

  it("lists every page in order", async () => {
    const k = fakeKeeper({ pageSize: 2 });
    for (const n of "abcde") k.files.set(`_inbox/clip-${n}.md`, "x");
    const vault = makeScheduledVault("clipping-requests", { request: k.request });
    expect(await vault.list("_inbox/")).toEqual(["a", "b", "c", "d", "e"].map((n) => `_inbox/clip-${n}.md`));
    expect(k.calls.length).toBe(3);
  });

  it("reads a missing note as undefined and a refusal as an error, never as 'nothing there'", async () => {
    const vault = makeScheduledVault("clipping-requests", { request: fakeKeeper().request });
    expect(await vault.read("_inbox/none.md")).toBeUndefined();
    expect(await vault.exists("_inbox/none.md")).toBe(false);
    const refused = makeScheduledVault("clipping-requests", { request: fakeKeeper({ refuse: true }).request });
    await expect(refused.exists("_inbox/none.md")).rejects.toBeInstanceOf(ScheduledVaultError);
    await expect(refused.list("_inbox/")).rejects.toBeInstanceOf(ScheduledVaultError);
  });

  it("refuses a body over one frame before sending, with a clear error", async () => {
    const k = fakeKeeper();
    const vault = makeScheduledVault("clipping-requests", { request: k.request });
    await expect(vault.write("_inbox/big.md", { frontmatter: {}, body: "x".repeat(200 * 1024) })).rejects.toBeInstanceOf(ScheduledVaultTooLargeError);
    expect(k.calls.length).toBe(0);
  });

  it("splits raw front matter from the text after it", () => {
    const raw = renderClipNote({
      sourceId: "s", sourceItemId: "p1", url: "https://example.com/a", title: "A title", sourceKind: "notion",
      capturedAt: "2026-11-01T00:00:00Z", sourceRevision: "r1", owner: "organisation", visibility: "shared", tags: ["x", "y"], note: "my note",
    } as any);
    const { frontmatter, body } = splitRawNote(raw);
    expect(frontmatter).toMatchObject({ url: "https://example.com/a", title: "A title", notion_page: "p1", tags: "x, y", lares_origin: "synced" });
    expect(body).toBe("my note\n");
    expect(splitRawNote("no front matter")).toEqual({ frontmatter: {}, body: "no front matter" });
  });
});

describe("the dream cycle's brain through keeper", () => {
  it("lists the two folders it reads, reads, and commits with its own message", async () => {
    const k = fakeKeeper();
    k.files.set("_meta/dream/2026-10-31.md", "---\ncursor: z\n---\n\nold");
    k.files.set("_meta/conversations/2026-10-31/a.md", "log");
    const brain = makeKeeperDreamBrain(makeScheduledVault("dream", { request: k.request }));
    expect(await brain.list()).toEqual(["_meta/dream/2026-10-31.md", "_meta/conversations/2026-10-31/a.md"]);
    expect(await brain.read("_meta/dream/2026-10-31.md")).toContain("cursor: z");
    await expect(brain.read("_meta/dream/none.md")).rejects.toThrow("not found");
    const out = await brain.commitNote({ path: "_meta/dream/2026-11-01.md", frontmatter: { cursor: "n", promoted: 1 }, body: "b", message: "learning: 2026-11-01" });
    expect(out).toEqual({ commit: "abc1234" });
    expect(k.calls.at(-1)!.input).toMatchObject({ operation: "write", message: "learning: 2026-11-01", frontmatter: { cursor: "n", promoted: 1 } });
  });
});

describe("a verbatim write through keeper", () => {
  it("sends the whole file as it is and reports a commit, then 'unchanged' for the same file", async () => {
    const k = fakeKeeper();
    const vault = makeScheduledVault("digest", { request: k.request });
    const content = "---\nlares_origin: third_party\nsources:\n  - resource: https://example.com/a\n---\n\nBody\n";
    expect(await vault.writeVerbatim("articles/a.md", content, "digest: file a")).toEqual({ commit: "abc1234", unchanged: false });
    expect(k.calls.at(-1)).toMatchObject({ op: "vault.scheduled", input: { schedule: "digest", operation: "write-verbatim", area: "private", path: "articles/a.md", content, message: "digest: file a" } });
    expect(k.files.get("articles/a.md")).toBe(content);
    expect(await vault.writeVerbatim("articles/a.md", content)).toEqual({ commit: null, unchanged: true });
  });

  it("refuses an oversize file before sending, and turns a keeper refusal into a failure", async () => {
    const k = fakeKeeper();
    await expect(makeScheduledVault("digest", { request: k.request }).writeVerbatim("articles/a.txt", "x".repeat(193 * 1024))).rejects.toBeInstanceOf(ScheduledVaultTooLargeError);
    expect(k.calls).toHaveLength(0);
    await expect(makeScheduledVault("digest", { request: fakeKeeper({ refuse: true }).request }).writeVerbatim("articles/a.txt", "t")).rejects.toBeInstanceOf(ScheduledVaultError);
  });
});

describe("the clipping inbox through keeper", () => {
  it("writes a clip as agent-stamped front matter, checks and removes it", async () => {
    const k = fakeKeeper();
    const inbox = makeKeeperInbox(makeScheduledVault("clipping-requests", { request: k.request }));
    expect(await inbox.exists("_inbox/clip-s-p.md")).toBe(false);
    await inbox.write("_inbox/clip-s-p.md", "---\nurl: https://example.com/a\nlares_origin: synced\n---\n\ntext\n");
    expect(k.calls.at(-1)!.input).toMatchObject({ operation: "write", path: "_inbox/clip-s-p.md", frontmatter: { url: "https://example.com/a" }, body: "text\n" });
    expect(await inbox.exists("_inbox/clip-s-p.md")).toBe(true);
    await inbox.remove("_inbox/clip-s-p.md");
    expect(k.files.size).toBe(0);
  });

  it("turns a keeper refusal into a plain failure the pass records, not a 'not there'", async () => {
    const inbox = makeKeeperInbox(makeScheduledVault("clipping-requests", { request: fakeKeeper({ refuse: true }).request }));
    for (const run of [() => inbox.exists("_inbox/x.md"), () => inbox.write("_inbox/x.md", "t"), () => inbox.remove("_inbox/x.md")]) {
      const e = await Promise.resolve(run()).catch((err) => err);
      expect(e).toBeInstanceOf(ClippingFailure);
      expect((e as ClippingFailure).outcome).toBe("local-error");
    }
  });
});
