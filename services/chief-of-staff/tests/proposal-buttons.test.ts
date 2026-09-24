/**
 * One-tap proposal buttons (lib/proposal-buttons.ts) — parsing, announcement shape, and
 * above all the callback handler's security contract: the TAPPER's Telegram id is checked
 * against the allowlist (fail-closed), a resolved proposal cannot be re-tapped into a
 * second state change, and cosmetic failures never mask a completed resolve.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  parseProposalCallback,
  proposalCallbackData,
  buildNotionAnnouncement,
  buildAtlasAnnouncement,
  buildMemoryAnnouncement,
  handleProposalCallback,
  type ProposalCallbackDeps,
} from "../lib/proposal-buttons.js";
import type { ProposalRow, AtlasUnannouncedRow, MemoryProposalRow } from "../lib/proposals-store.js";

const BENDIK_TG = "123456789";

beforeEach(() => {
  process.env["TELEGRAM_PRINCIPAL_ID"] = BENDIK_TG;
});

afterEach(() => {
  delete process.env["TELEGRAM_PRINCIPAL_ID"];
});

function notionRow(overrides: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: 61, vaultPath: "_desk/folkepuls.md", notionPageId: "p", proposedBody: "b",
    baseMdHash: "h", notionHash: "h", diffPreview: "+ x", kind: "create", notionOwned: false,
    state: "pending", createdAt: new Date("2026-08-14T10:12:00Z"), ...overrides,
  };
}

function atlasRow(overrides: Partial<AtlasUnannouncedRow> = {}): AtlasUnannouncedRow {
  return {
    id: 7, notePath: "_projects/orakel.md", proposedNote: "n", baseBodyHash: "h",
    sourcesHash: "h", diffPreview: "+ y", state: "pending",
    createdAt: new Date("2026-08-14T10:12:00Z"), brand: "Orakel", ...overrides,
  };
}

function memoryRow(overrides: Partial<MemoryProposalRow> = {}): MemoryProposalRow {
  return {
    id: 3, action: "supersede", existingId: "abc-123", existingText: "prefers long replies",
    proposedText: "prefers short replies", subject: "tone", origin: "owner",
    source: "dream-cycle-2026-09-18", ref: "", kind: "", state: "pending",
    createdAt: new Date("2026-08-14T10:12:00Z"), ...overrides,
  };
}

// Captured from buildMemoryAnnouncement's supersede branch before W5X-s5 taught it a third
// (`add`) shape — this test pins that the refactor left it byte-for-byte unchanged.
const SUPERSEDE_TEXT_BEFORE = [
  "Memory change #3 — tone.",
  "",
  "A nightly run believes something the owner told me has changed. It is not allowed to",
  "replace that on its own, so nothing has happened yet.",
  "",
  "Standing now: prefers long replies",
  "Would become: prefers short replies",
  "",
  "Approve → the existing preference is replaced with the proposed one.",
  "Reject → the existing preference is left exactly as it is, and this change is not proposed " +
    "again until something new is observed.",
  "",
  "Reply with approve or reject and I will put the card up.",
].join("\n");

function fakeDeps(opts: { resolveThrows?: boolean } = {}) {
  const calls: string[] = [];
  const deps: ProposalCallbackDeps = {
    async resolveNotion(id, action) {
      if (opts.resolveThrows) throw new Error("not open");
      calls.push(`notion:${action}:${id}`);
    },
    async resolveAtlas(id, action) {
      if (opts.resolveThrows) throw new Error("not open");
      calls.push(`atlas:${action}:${id}`);
    },
    async answer(_id, text) { calls.push(`answer:${text}`); },
    async removeButtons(chat, msg) { calls.push(`strip:${chat}:${msg}`); },
    async confirm(_chat, text) { calls.push(`confirm:${text}`); },
  };
  return { deps, calls };
}

describe("callback data round-trip", () => {
  it("emits and parses the old runtime's exact convention", () => {
    expect(proposalCallbackData("np", "approve", 61)).toBe("np:a:61");
    expect(proposalCallbackData("ap", "reject", 7)).toBe("ap:r:7");
    expect(parseProposalCallback("np:a:61")).toEqual({ lane: "np", action: "approve", id: 61 });
    expect(parseProposalCallback("ap:r:7")).toEqual({ lane: "ap", action: "reject", id: 7 });
  });

  it("rejects everything else — HITL prefixes, garbage, absent", () => {
    for (const bad of ["eve_input:xyz", "np:a:", "np:x:1", "zz:a:1", "", undefined]) {
      expect(parseProposalCallback(bad)).toBeUndefined();
    }
  });
});

describe("announcement builders", () => {
  it("notion: names the file, quotes the store's consequence sentences, carries its own button pair", () => {
    const a = buildNotionAnnouncement(notionRow());
    expect(a.text).toContain("#61");
    expect(a.text).toContain("NEW FILE: _desk/folkepuls.md");
    expect(a.text).toContain("Proposed file content:\n+ x");
    expect(a.parseMode).toBe("HTML");
    expect(a.text).toMatch(/Approve → .*\n.*Reject → /s);
    const json = JSON.stringify(a.replyMarkup);
    expect(json).toContain('"np:a:61"');
    expect(json).toContain('"np:r:61"');
  });

  it("atlas: names the note and brand, carries ap: buttons", () => {
    const a = buildAtlasAnnouncement(atlasRow());
    expect(a.text).toContain("#7");
    expect(a.text).toContain("_projects/orakel.md");
    expect(a.text).toContain("(Orakel)");
    expect(a.text).toContain("Diff:\n+ y");
    expect(JSON.stringify(a.replyMarkup)).toContain('"ap:a:7"');
  });

  it("notion edit: shows a real-shaped diff literally under Telegram HTML parsing", () => {
    const diff = "@@ -1,3 +1,3 @@\n-old_name = `before`\n+new_name = *after* [review] <safe> & sound";
    const a = buildNotionAnnouncement(notionRow({ kind: "update", diffPreview: diff }));

    expect(a.text).toContain("Diff:\n@@ -1,3 +1,3 @@");
    expect(a.text).toContain("-old_name = `before`");
    expect(a.text).toContain("+new_name = *after* [review] &lt;safe&gt; &amp; sound");
    expect(a.text).not.toContain("<safe>");
  });

  it("notion create: falls back to proposed body when no diff preview was stored", () => {
    const a = buildNotionAnnouncement(notionRow({ diffPreview: "", proposedBody: "# New note\nBody" }));
    expect(a.text).toContain("Proposed file content:\n# New note\nBody");
    expect(a.text).not.toContain("no preview stored");
  });

  it("empty edit and Atlas previews say that no preview was stored", () => {
    expect(buildNotionAnnouncement(notionRow({ kind: "update", diffPreview: "" })).text)
      .toContain("Preview: no preview stored for this proposal.");
    expect(buildAtlasAnnouncement(atlasRow({ diffPreview: "" })).text)
      .toContain("Preview: no preview stored for this proposal.");
  });

  it("truncates long previews on line boundaries with an accurate omitted-line count", () => {
    const lines = Array.from(
      { length: 300 },
      (_, i) => `+ line ${i.toString().padStart(3, "0")} <${"x".repeat(20)}>`,
    );
    const a = buildAtlasAnnouncement(atlasRow({ diffPreview: lines.join("\n") }));
    const match = /… \((\d+) more lines\)/.exec(a.text);

    expect(match).not.toBeNull();
    const shownLines = a.text.slice(a.text.indexOf("Diff:\n") + 6, a.text.indexOf("\n… (")).split("\n");
    expect(Number(match![1])).toBe(lines.length - shownLines.length);
    expect(a.text.length).toBeLessThan(4096);
  });

  it("an add announcement offers a new thing, and never implies something is being replaced", () => {
    const a = buildMemoryAnnouncement(memoryRow({
      id: 7, action: "add", existingId: "", existingText: "", proposedText: "prefers short replies",
      subject: "tone", origin: "agent", source: "dream-cycle-2026-09-19", ref: "identity-x",
      kind: "preference", state: "pending", createdAt: new Date(0),
    }));
    expect(a.text).toContain("#7");
    expect(a.text).toContain("prefers short replies");
    expect(a.text).toMatch(/noticed|worked out/i);
    expect(a.text).not.toMatch(/Standing now|replace/i);
    expect(a.replyMarkup).toEqual({ inline_keyboard: [] });
    expect(a.text).not.toMatch(/\b(Saga|Marcel|Calliope|bendik|orbis|heiberg)\b/i);
  });

  it("leaves the supersede announcement byte-identical", () => {
    expect(buildMemoryAnnouncement(memoryRow()).text).toBe(SUPERSEDE_TEXT_BEFORE);
  });
});

describe("handleProposalCallback — the security contract", () => {
  const msg = { messageId: "42", chat: { id: "123456789" } };

  it("resolves on an allowlisted tapper, answers, strips buttons, confirms", async () => {
    const { deps, calls } = fakeDeps();
    const out = await handleProposalCallback(
      { id: "cq1", from: { id: BENDIK_TG }, data: "np:a:61", message: msg },
      deps,
    );
    expect(out).toBe("resolved");
    expect(calls[0]).toBe("notion:approve:61");
    expect(calls).toContain("strip:123456789:42");
    expect(calls.find((c) => c.startsWith("confirm:"))).toContain("Notion proposal #61");
  });

  it("refuses a STRANGER's tap — resolve is never called", async () => {
    const { deps, calls } = fakeDeps();
    const out = await handleProposalCallback(
      { id: "cq2", from: { id: 999 }, data: "np:a:61", message: msg },
      deps,
    );
    expect(out).toBe("refused-unknown-tapper");
    expect(calls).toEqual(["answer:Not allowed."]);
  });

  it("refuses an ABSENT from.id — fail-closed like a wrong one", async () => {
    const { deps, calls } = fakeDeps();
    const out = await handleProposalCallback({ id: "cq3", data: "ap:r:7", message: msg }, deps);
    expect(out).toBe("refused-unknown-tapper");
    expect(calls).toEqual(["answer:Not allowed."]);
  });

  it("a double-tap (or conversationally-resolved proposal) answers 'already resolved', no second state change", async () => {
    const { deps, calls } = fakeDeps({ resolveThrows: true });
    const out = await handleProposalCallback(
      { id: "cq4", from: { id: BENDIK_TG }, data: "np:r:61", message: msg },
      deps,
    );
    expect(out).toBe("already-resolved");
    expect(calls).toEqual(["answer:Notion proposal #61 was already resolved."]);
  });

  it("non-proposal callback data is left for the channel's fallback", async () => {
    const { deps, calls } = fakeDeps();
    const out = await handleProposalCallback(
      { id: "cq5", from: { id: BENDIK_TG }, data: "something:else", message: msg },
      deps,
    );
    expect(out).toBe("not-a-proposal-callback");
    expect(calls).toEqual([]);
  });

  it("routes the ap lane to the atlas resolver", async () => {
    const { deps, calls } = fakeDeps();
    await handleProposalCallback(
      { id: "cq6", from: { id: BENDIK_TG }, data: "ap:a:7", message: msg },
      deps,
    );
    expect(calls[0]).toBe("atlas:approve:7");
  });

  it("a failure in the cosmetic steps (strip/confirm) does not undo or mask the resolve", async () => {
    const { deps, calls } = fakeDeps();
    deps.removeButtons = async () => { throw new Error("edit failed"); };
    deps.confirm = async () => { throw new Error("send failed"); };
    const out = await handleProposalCallback(
      { id: "cq7", from: { id: BENDIK_TG }, data: "np:a:61", message: msg },
      deps,
    );
    expect(out).toBe("resolved");
    expect(calls[0]).toBe("notion:approve:61");
  });
});
