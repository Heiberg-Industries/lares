import { beforeEach, describe, expect, it } from "vitest";

import { makeScheduledVault, splitRawNote, type BrokerRequest } from "../lib/scheduled-vault.js";
import { heldInboxKind, makeKeeperDigestPorts, resetHeldLogForTests } from "../lib/digest/keeper-ports.js";
import { projectsFromPaths } from "../lib/digest/filer.js";
import { fileDecision } from "../lib/digest/filer.js";
import { runDigest } from "../lib/digest/runner.js";

/** A fake keeper that remembers notes and can be told to fail an operation. */
function fakeKeeper(opts: { pageSize?: number; failOn?: (op: string, input: any) => boolean } = {}) {
  const files = new Map<string, string>();
  const calls: Array<{ operation: string; path?: string; destination?: string }> = [];
  const request: BrokerRequest = async (_op, input: any) => {
    calls.push({ operation: input.operation, path: input.path, destination: input.destination });
    if (opts.failOn?.(input.operation, input)) throw new Error("Vault reader unavailable");
    switch (input.operation) {
      case "list": {
        const all = [...files.keys()].filter((p) => input.prefix === "" || p.startsWith(input.prefix)).sort().filter((p) => p > (input.cursor ?? ""));
        const size = opts.pageSize ?? 200, page = all.slice(0, size);
        return { ok: true, paths: page, ...(all.length > size ? { nextCursor: page.at(-1) } : {}) };
      }
      case "read": {
        const c = files.get(input.path);
        if (c === undefined) return { ok: true, found: false };
        return input.probe ? { ok: true, found: true } : { ok: true, found: true, content: c };
      }
      case "write":
        files.set(input.path, `---\n${Object.entries(input.frontmatter).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${input.body}`);
        return { ok: true, commit: "abc1234" };
      case "move": {
        const c = files.get(input.path);
        if (c === undefined || files.has(input.destination)) throw new Error("refused");
        files.delete(input.path); files.set(input.destination, c);
        return { ok: true, commit: "mv" };
      }
      case "remove": return { ok: true, removed: files.delete(input.path) };
    }
    throw new Error("unexpected");
  };
  return { files, calls, request };
}

const note = (extra: string, body = "text") => `---\n${extra}\n---\n\n${body}\n`;
const ports = (k: ReturnType<typeof fakeKeeper>, log: (m: string) => void = () => {}) =>
  makeKeeperDigestPorts(makeScheduledVault("digest", { request: k.request }), log);

beforeEach(() => resetHeldLogForTests());

describe("digest ports through keeper", () => {
  it("lists the inbox flat, oldest save first, and leaves links and attachments where they are, saying so once per change", async () => {
    const k = fakeKeeper();
    k.files.set("_inbox/b.md", note("saved: 2026-11-02T00:00:00Z", "later thought"));
    k.files.set("_inbox/a.md", note("saved: 2026-11-01T00:00:00Z", "earlier thought"));
    k.files.set("_inbox/undated.md", "no front matter at all");
    k.files.set("_inbox/link.md", note("url: https://example.com/x"));
    k.files.set("_inbox/bare.md", "https://example.com/y");
    k.files.set("_inbox/scan.md", note("attachment: files/scan.pdf"));
    k.files.set("_inbox/sub/deep.md", "not the digest's");
    const lines: string[] = [];
    const p = ports(k, (m) => lines.push(m));
    expect((await p.listInbox()).map((i) => i.path)).toEqual(["_inbox/a.md", "_inbox/b.md", "_inbox/undated.md"]);
    await p.listInbox();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/articles cannot be filed yet on this install: 2 saved link\(s\) and 1 attachment\(s\)/);
    k.files.delete("_inbox/bare.md");
    await p.listInbox();
    expect(lines).toHaveLength(2);
  });

  it("classifies what is held", () => {
    expect(heldInboxKind("---\nattachment: x/y.png\n---\n")).toBe("attachment");
    expect(heldInboxKind("---\nattachment: x/y.txt\n---\n")).toBeNull();
    expect(heldInboxKind("a plain thought")).toBeNull();
  });

  it("reads note names and projects from a listing that spans several pages, taken once", async () => {
    const k = fakeKeeper({ pageSize: 2 });
    for (const path of ["inspiration/one.md", "reads/two.md", "Project A/transcripts/call.md", "Project A/notes.md", "_inbox/x.md", "Project B/transcripts/call2.md", "a,b/transcripts/c.md"]) k.files.set(path, "x");
    const p = ports(k);
    expect((await p.noteNames()).sort()).toEqual(["c", "call", "call2", "notes", "one", "two", "x"]);
    expect(await p.projects()).toEqual(["Project A", "Project B"]);
    expect(k.calls.filter((c) => c.operation === "list").length).toBe(4); // 7 paths at 2 a page, once
  });

  it("projects from paths use the same exclusions as the folder listing", () => {
    expect(projectsFromPaths(["_x/transcripts/a.md", ".h/transcripts/a.md", "p/transcripts/a.md", "p/transcripts/b.md", "q/other/a.md", "transcripts/a.md"])).toEqual(["p"]);
  });

  it("files by moving first and rewriting after, so the note is in one place at every step", async () => {
    const k = fakeKeeper();
    k.files.set("_inbox/n.md", note("saved: 2026-11-01T00:00:00Z", "original"));
    const out = await ports(k).fileNote({
      destPath: "reads/a-title.md", sourcePath: "_inbox/n.md", frontmatter: { title: "A\ntitle", filed_by: "digest" }, body: "Summary", message: "digest: file A",
    });
    expect(out.commit).toBe("abc1234");
    expect(k.calls.map((c) => c.operation).filter((o) => o !== "read")).toEqual(["move", "write"]);
    expect(k.files.has("_inbox/n.md")).toBe(false);
    expect(k.files.get("reads/a-title.md")).toContain("title: A title");
  });

  it("a failure between the two steps leaves the note filed once and never back in the inbox", async () => {
    const k = fakeKeeper({ failOn: (op) => op === "write" });
    k.files.set("_inbox/n.md", note("saved: 2026-11-01T00:00:00Z", "original thought"));
    const p = ports(k);
    const summary = await runDigest({
      agent: "assistant", mode: "on-demand", capturedAt: "2026-11-04",
      listInbox: () => p.listInbox(), alreadySkipped: async () => [], noteNames: () => p.noteNames(), projects: () => p.projects(),
      llm: async () => JSON.stringify({ route: "file", type: "reference", title: "A title", summary: "S", links: [], reason: "clear" }),
      fileNote: p.fileNote, recordSkip: async () => {}, post: async () => {},
    });
    expect(summary.errors).toHaveLength(1);
    expect(k.files.has("_inbox/n.md")).toBe(false);
    expect([...k.files.keys()]).toEqual(["reads/a-title.md"]);
    expect(k.files.get("reads/a-title.md")).toContain("original thought");
    // The next pass finds nothing to file again.
    expect(await p.listInbox()).toEqual([]);
  });

  it("a failure of the move itself leaves the note in the inbox and writes nothing", async () => {
    const k = fakeKeeper({ failOn: (op) => op === "move" });
    k.files.set("_inbox/n.md", note("saved: 2026-11-01T00:00:00Z", "t"));
    await expect(fileDecision(
      { route: "file", type: "reference", destination: "reads", title: "T", summary: "S", links: [], reason: "r" },
      { path: "_inbox/n.md", body: "t", capturedAt: "2026-11-04" }, ports(k).fileNote,
    )).rejects.toThrow();
    expect([...k.files.keys()]).toEqual(["_inbox/n.md"]);
  });

  it("never replaces a note that already has the name: the next free name is used", async () => {
    const k = fakeKeeper();
    k.files.set("reads/a-title.md", "mine");
    k.files.set("reads/a-title-2.md", "also mine");
    k.files.set("_inbox/n.md", note("saved: x", "new"));
    await ports(k).fileNote({ destPath: "reads/a-title.md", sourcePath: "_inbox/n.md", frontmatter: { title: "A" }, body: "S", message: "m" });
    expect(k.files.get("reads/a-title.md")).toBe("mine");
    expect(k.files.get("reads/a-title-2.md")).toBe("also mine");
    expect(k.files.get("reads/a-title-3.md")).toContain("S");
  });

  it("writes a pulled Karakeep note raw, with tabs in values made safe, and refuses to read an attachment", async () => {
    const k = fakeKeeper();
    const p = ports(k);
    await p.writeRawNote("_inbox/karakeep-b1.md", "---\nurl: https://example.com/a\ntitle: A\tB\nkarakeep_id: b1\n---\n\n\n");
    expect(k.calls.at(-1)).toMatchObject({ operation: "write", path: "_inbox/karakeep-b1.md" });
    expect(k.files.get("_inbox/karakeep-b1.md")).toContain("title: A B");
    expect(splitRawNote("---\nk: a\u0007b\n---\n\nx").frontmatter["k"]).toBe("a b");
    await expect(p.readFile("files/x.pdf")).rejects.toThrow(/cannot be read yet/);
  });

  it("a refusal or outage while listing is an error, never an empty inbox", async () => {
    const p = ports(fakeKeeper({ failOn: () => true }));
    await expect(p.listInbox()).rejects.toThrow();
    await expect(p.noteNames()).rejects.toThrow();
  });
});
