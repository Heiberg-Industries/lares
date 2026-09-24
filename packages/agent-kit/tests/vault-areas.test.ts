// W5C-s3. One set of note tools, told which area to read.
//
// The rule proved here: the areas a session may open are derived from the declaration's own
// `vault` grant, and only from it — W5C-s9 removed the window where `brain`, `atlas` and
// `memory` each opened one area of their own; a definition that still spells one of them now
// fails `assertDeclarationIntegrity` before `grantedVaultAreas` ever runs (`one-name.test.ts`
// proves that side). The tools enforce the area they ARE granted themselves — a refusal is a
// rejected promise naming the area, not a description in a persona.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backlinksTool, listTool, readTool, searchTool } from "../src/note-tools.js";
import { NoteNotFoundError } from "../src/notes-store.js";
import { grantedVaultAreas, parseManifest, type AgentManifest } from "../src/manifest.js";

const ctx = {} as never;

function declaration(grants: Array<Record<string, unknown>>, autonomy: Record<string, string> = {}): AgentManifest {
  return parseManifest({
    name: "fixture-agent",
    model: "fixture-brain",
    grants,
    autonomy,
    skills: [],
    channels: [],
  });
}

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  delete process.env["VAULT_PATH"];
  delete process.env["ATLAS_PATH"];
});

function twoAreas(): void {
  dir = mkdtempSync(join(tmpdir(), "eve-vault-areas-"));
  const priv = join(dir, "private");
  const shared = join(dir, "shared");
  mkdirSync(join(priv, "people"), { recursive: true });
  mkdirSync(join(shared, "companies"), { recursive: true });
  writeFileSync(join(priv, "people", "ada.md"), "# Ada\n\nA private note linking [[x]].\n");
  writeFileSync(join(priv, "private-only.md"), "# Only here\n");
  writeFileSync(join(shared, "companies", "x.md"), "# X\n\nA shared venture note.\n");
  process.env["VAULT_PATH"] = priv;
  process.env["ATLAS_PATH"] = shared;
}

/** An authority standing in for a service's own `thisAgent(session)` read. */
const granting = (...areas: string[]) => () => areas as never;

describe("grantedVaultAreas — the areas a definition may open today", () => {
  it("reads a `vault` grant's own areas", () => {
    expect(
      grantedVaultAreas(declaration([{ capability: "vault", scope: "write-with-confirm", areas: ["shared", "facts"] }])),
    ).toEqual(["shared", "facts"]);
  });

  it("gives a declared non-grant and a `never` autonomy nothing at all", () => {
    expect(grantedVaultAreas(declaration([{ capability: "vault", scope: "none", areas: ["private"] }]))).toEqual([]);
    expect(
      grantedVaultAreas(declaration([{ capability: "vault", scope: "write-with-confirm", areas: ["shared"] }], { vault: "never" })),
    ).toEqual([]);
  });

  it("orders the answer by VAULT_AREAS, not by the order `areas` was written in", () => {
    expect(
      grantedVaultAreas(declaration([{ capability: "vault", scope: "write-with-confirm", areas: ["facts", "shared", "private"] }])),
    ).toEqual(["private", "shared", "facts"]);
  });

  // `one-name.test.ts` proves the retired-capability side of this: a manifest that still names
  // `brain`, `atlas` or `memory` has no `vault` grant for `grantedVaultAreas` to read (so it opens
  // nothing), and separately fails `assertDeclarationIntegrity` loudly before it ever gets that far.
});

describe("one set of note tools, told which area to read", () => {
  it("reads the shared area through the same tool that reads the private one", async () => {
    twoAreas();
    const vault_read = readTool({ areas: granting("private", "shared") });
    // `execute` is typed as value-or-stream; this tool always answers with a value.
    const priv = (await vault_read.execute({ area: "private", path: "people/ada.md" }, ctx)) as { content: string };
    expect(priv.content).toContain("A private note");
    const shared = (await vault_read.execute({ area: "shared", path: "companies/x.md" }, ctx)) as { content: string };
    expect(shared.content).toContain("A shared venture note");
  });

  it("searches, lists and follows backlinks in whichever area it is given", async () => {
    twoAreas();
    const areas = granting("private", "shared");
    expect(await searchTool({ areas }).execute({ area: "shared", q: "venture" }, ctx)).toEqual({
      hits: ["companies/x.md"],
      files: 1,
    });
    expect(await listTool({ areas }).execute({ area: "private" }, ctx)).toEqual({
      notes: ["people/ada.md", "private-only.md"],
      files: 2,
    });
    expect(await backlinksTool({ areas }).execute({ area: "private", path: "x.md" }, ctx)).toEqual({
      path: "x.md",
      backlinks: ["people/ada.md"],
      files: 2,
    });
  });

  it("refuses an area this agent was not granted", async () => {
    twoAreas();
    const privateOnly = readTool({ areas: granting("private") });
    await expect(privateOnly.execute({ area: "shared", path: "companies/x.md" }, ctx)).rejects.toThrow(/shared/);

    const sharedOnly = readTool({ areas: granting("shared") });
    await expect(sharedOnly.execute({ area: "private", path: "people/ada.md" }, ctx)).rejects.toThrow(/private/);
  });

  it("refuses everything when no authority was wired in — fail closed, never open", async () => {
    twoAreas();
    await expect(readTool().execute({ area: "private", path: "people/ada.md" }, ctx)).rejects.toThrow(/private/);
    await expect(readTool().execute({ area: "shared", path: "companies/x.md" }, ctx)).rejects.toThrow(/shared/);
  });

  it("refuses an area that is not a file store", async () => {
    twoAreas();
    const everything = readTool({ areas: granting("private", "shared", "taste", "facts") });
    await expect(everything.execute({ area: "facts", path: "x" } as never, ctx)).rejects.toThrow();
    await expect(everything.execute({ area: "taste", path: "x" } as never, ctx)).rejects.toThrow();
  });

  it("keeps the two areas apart: a private path is not readable as shared", async () => {
    twoAreas();
    const vault_read = readTool({ areas: granting("private", "shared") });
    await expect(vault_read.execute({ area: "shared", path: "private-only.md" }, ctx)).rejects.toThrow(NoteNotFoundError);
    await expect(vault_read.execute({ area: "private", path: "companies/x.md" }, ctx)).rejects.toThrow(NoteNotFoundError);
  });

  it("checks the grant BEFORE it touches the filesystem — an ungranted area is refused even unmounted", async () => {
    dir = mkdtempSync(join(tmpdir(), "eve-vault-areas-"));
    const privateOnly = searchTool({ areas: granting("private") });
    await expect(privateOnly.execute({ area: "shared", q: "anything" }, ctx)).rejects.toThrow(/shared/);
  });

  it("names both areas in what the model reads, and neither installation's folder", () => {
    for (const tool of [readTool(), listTool(), searchTool(), backlinksTool()]) {
      expect(tool.description).toMatch(/area/i);
      expect(tool.description).not.toMatch(/\b(Brain|Atlas)\b/);
    }
  });
});
