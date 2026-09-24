import { describe, it, expect } from "vitest";
import { parseArgs, buildReaders, checkOkf, decideProposal } from "../lib/cli.js";
import { assertReaderWiring } from "../lib/config.js";
import type { Config } from "../lib/config.js";
import type { AtlasWriter } from "../lib/adapters/atlas-writer.js";

const config = (): Config => ({
  atlasPath: "/srv/atlas",
  vaultPath: "/srv/brain",
  githubToken: "ghp_x",
  notionToken: "ntn_x",
  gatewayUrl: "https://gateway.example/anthropic",
  gatewayKey: "sk-x",
  draftModel: "some-model",
  tickMs: 86_400_000,
  live: false,
});

describe("parseArgs", () => {
  it("defaults to the daemon when no flag is given", () => {
    expect(parseArgs([])).toEqual({ mode: "daemon" });
  });

  it("reads each operator mode", () => {
    expect(parseArgs(["--once"])).toEqual({ mode: "once" });
    expect(parseArgs(["--migrate-okf"])).toEqual({ mode: "migrate-okf" });
    expect(parseArgs(["--check-okf"])).toEqual({ mode: "check-okf" });
    expect(parseArgs(["--doctor"])).toEqual({ mode: "doctor" });
    expect(parseArgs(["--list"])).toEqual({ mode: "list" });
  });

  it("reads a decision and its id", () => {
    expect(parseArgs(["--approve", "12"])).toEqual({ mode: "approve", id: 12 });
    expect(parseArgs(["--reject", "3"])).toEqual({ mode: "reject", id: 3 });
  });

  it("REFUSES two modes at once rather than picking a winner", () => {
    // "--check-okf --migrate-okf" is someone asking to preview AND to write. Guessing is
    // how a preview becomes a write.
    expect(() => parseArgs(["--check-okf", "--migrate-okf"])).toThrow(/both modes/i);
    expect(() => parseArgs(["--once", "--doctor"])).toThrow(/both modes/i);
  });

  it("REFUSES an id that is not a whole number", () => {
    // Number("3.5") truncates and Number("3abc") is NaN; either would reach the database as
    // a different id than the one typed.
    for (const bad of ["3.5", "3abc", "-1", "0", "", "abc"]) {
      expect(() => parseArgs(["--approve", bad])).toThrow(/not a proposal id|needs a proposal id/i);
    }
  });

  it("REFUSES a decision with no id at all", () => {
    expect(() => parseArgs(["--approve"])).toThrow(/needs a proposal id/i);
  });

  it("REFUSES an unknown flag instead of silently running the daemon", () => {
    // The dangerous shape: a typo'd `--onc` parsed as "no mode" would start the daemon.
    expect(() => parseArgs(["--onc"])).toThrow(/unknown argument/i);
  });
});

describe("buildReaders", () => {
  it("produces a map the wiring sentinel accepts", () => {
    // The root's own output, checked by the root's own guard — so a wrong prefix here is
    // caught by the test rather than at 03:00 on the box.
    const readers = buildReaders(config(), { getPageMarkdown: async () => "# page" });
    expect(() => assertReaderWiring(readers)).not.toThrow();
  });

  it("roots the two local readers at DIFFERENT stores", () => {
    const readers = buildReaders(config(), { getPageMarkdown: async () => "# page" });
    expect(readers.atlas).not.toBe(readers.vault);
    expect(readers.atlas.id).toBe("atlas");
    expect(readers.vault.id).toBe("vault");
  });
});

describe("checkOkf", () => {
  const writer = (files: Record<string, string>): AtlasWriter => ({
    listNotes: () => Object.keys(files).sort(),
    readNote: (p) => files[p]!,
    writeNotes: async () => { throw new Error("checkOkf must not write"); },
  });

  it("reports nothing on a conformant bundle and exits clean", () => {
    const lines: string[] = [];
    const res = checkOkf(writer({ "_projects/soma.md": "---\ntype: venture\n---\n\n# SOMA\n" }), (s) => lines.push(s));
    expect(res.findings).toBe(0);
    expect(lines.join("\n")).toMatch(/conform/i);
  });

  it("names each non-conformant note", () => {
    const lines: string[] = [];
    const res = checkOkf(writer({
      "_projects/soma.md": "---\ntype: venture\n---\n\n# SOMA\n",
      "_projects/bare.md": "# No frontmatter\n",
    }), (s) => lines.push(s));
    expect(res.findings).toBe(1);
    expect(lines.join("\n")).toMatch(/_projects\/bare\.md/);
  });

  it("never writes — it is a report", () => {
    // `writeNotes` throws above; reaching it would fail this test loudly.
    expect(() => checkOkf(writer({ "a.md": "# a\n" }), () => {})).not.toThrow();
  });
});

describe("decideProposal", () => {
  it("says 'approved' and 'rejected' — not the concatenated 'approveed'", async () => {
    // It printed "approveed" on its first real use, in a codebase where bin/saga.ts already
    // carries a comment about this exact trap. An English past tense is not a suffix rule.
    const rows: Record<number, { id: number; notePath: string }> = {
      1: { id: 1, notePath: "_projects/alpha.md" },
    };
    const db = { query: async () => ({ rows: [{ id: 1, note_path: "_projects/alpha.md",
      proposed_note: "x", base_body_hash: "b", sources_hash: "s", diff_preview: "",
      state: "approved", created_at: new Date() }] }) } as never;
    void rows;
    for (const [action, want, unwanted] of [
      ["approve", "approved", "approveed"], ["reject", "rejected", "rejecteded"],
    ] as const) {
      const lines: string[] = [];
      await decideProposal(db, 1, action, (s2) => lines.push(s2));
      const out = lines.join("\n");
      expect(out).toContain(want);
      expect(out).not.toContain(unwanted);
    }
  });
});
