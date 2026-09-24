import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchTool, readTool, backlinksTool, listTool } from "@lares/agent-kit/note-tools";
import {
  NoteNotFoundError,
  NotePathEscapesStoreError,
  StorePathNotConfiguredError,
  StoreUnhealthyError,
} from "@lares/agent-kit/notes-store";
import type { ToolContext } from "eve/tools";

/**
 * The read-only hands (Task 10). Engine behaviour is covered in notes-store.test.ts; this
 * file covers the wiring that engine tests cannot: that each tool reads the RIGHT env var,
 * that Brain and Atlas do not cross, and that the typed errors survive the tool boundary
 * instead of arriving as a bare Error the model cannot act on.
 *
 * ORB-143 Task 2: vault_search/vault_read/vault_backlinks live mounted in the
 * @lares/agent-kit eve extension (agent-kit__vault_*), not as local files this test can
 * import by relative path. Unlike orakel's extension tools (see tools-read-batch.test.ts's
 * header comment), the factory these build — searchTool/readTool/backlinksTool from
 * @lares/agent-kit/note-tools — touches ZERO extension config: it resolves the store root
 * via storeRootForArea(area), which reads VAULT_PATH/ATLAS_PATH from process.env directly. So
 * reconstructing the exact same tool the catalogue builds here is a faithful test of the real
 * logic, not a weakened stand-in — it just skips eve's extension-config binding machinery,
 * which this tool never touches anyway.
 *
 * W5C-s3: there is ONE set of these now, told which area to read, and the separate atlas_*
 * hands are gone. `areas` stands in for `lib/vault-areas.ts`'s per-session definition read —
 * this agent's declaration grants both note areas, so both are open here. The narrower case
 * (an agent granted one area reaching for the other) is proved against the guard itself, in
 * packages/agent-kit/tests/vault-areas.test.ts, and once more below.
 */
const bothAreas = () => ["private", "shared"] as const;
const vaultSearch = searchTool({ areas: bothAreas });
const vaultRead = readTool({ areas: bothAreas });
const vaultBacklinks = backlinksTool({ areas: bothAreas });
const vaultList = listTool({ areas: bothAreas });

// The hands never touch ctx — they read the filesystem directly rather than through eve's
// sandbox — so an empty cast exercises execute() without booting the runtime.
const ctx = {} as ToolContext;

let dir: string;

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env["VAULT_PATH"];
  delete process.env["ATLAS_PATH"];
});

function twoStores(): { brain: string; atlas: string } {
  dir = mkdtempSync(join(tmpdir(), "eve-hands-"));
  const brain = join(dir, "brain");
  const atlas = join(dir, "atlas");
  mkdirSync(join(brain, "ventures"), { recursive: true });
  mkdirSync(atlas, { recursive: true });
  writeFileSync(join(brain, "ventures", "soma.md"), "# SOMA\n\nHospitality venture.\n");
  writeFileSync(join(brain, "index.md"), "Links to [[soma]] and more.\n");
  writeFileSync(join(atlas, "orakel.md"), "# Orakel\n\nNorwegian company intelligence.\n");
  process.env["VAULT_PATH"] = brain;
  process.env["ATLAS_PATH"] = atlas;
  return { brain, atlas };
}

describe("the private area", () => {
  it("search returns store-relative hits and the area's size", async () => {
    twoStores();
    expect(await vaultSearch.execute({ area: "private", q: "SOMA hospitality" }, ctx)).toEqual({
      hits: ["ventures/soma.md"],
      files: 2,
    });
  });

  it("read returns a note's content by the path search gave", async () => {
    twoStores();
    const result = await vaultRead.execute({ area: "private", path: "ventures/soma.md" }, ctx);
    expect(result.content).toContain("Hospitality venture");
    expect(result.lines).toBe(3);
  });

  it("backlinks finds the note that wikilinks to it", async () => {
    twoStores();
    expect(await vaultBacklinks.execute({ area: "private", path: "ventures/soma.md" }, ctx)).toEqual({
      path: "ventures/soma.md",
      backlinks: ["index.md"],
      files: 2,
    });
  });
});

describe("the shared area, through the same tools", () => {
  it("search reads ATLAS_PATH, not VAULT_PATH", async () => {
    twoStores();
    expect(await vaultSearch.execute({ area: "shared", q: "Orakel" }, ctx)).toEqual({
      hits: ["orakel.md"],
      files: 1,
    });
  });

  it("reads the shared area through the same tool that reads the private one", async () => {
    twoStores();
    expect((await vaultRead.execute({ area: "shared", path: "orakel.md" }, ctx)).content).toContain(
      "company intelligence",
    );
  });

  it("lists each area separately", async () => {
    twoStores();
    expect(await vaultList.execute({ area: "shared" }, ctx)).toEqual({ notes: ["orakel.md"], files: 1 });
  });

  it("the two areas do not cross", async () => {
    twoStores();
    // A private note is not in the shared area and vice versa. ONE set of tools for both makes
    // this the thing most likely to break silently, and a wrong-area answer is worse than no
    // answer: one store is personal, the other is the business's, and the split is deliberate.
    await expect(vaultRead.execute({ area: "shared", path: "ventures/soma.md" }, ctx)).rejects.toThrow(
      NoteNotFoundError,
    );
    await expect(vaultRead.execute({ area: "private", path: "orakel.md" }, ctx)).rejects.toThrow(
      NoteNotFoundError,
    );
  });

  it("refuses an area this agent was not granted, naming it", async () => {
    twoStores();
    const privateOnly = readTool({ areas: () => ["private"] as const });
    await expect(privateOnly.execute({ area: "shared", path: "orakel.md" }, ctx)).rejects.toThrow(
      /shared/,
    );
  });
});

describe("the ORB-51 posture, at the tool boundary", () => {
  it("an unmounted store is an error, never an empty result", async () => {
    dir = mkdtempSync(join(tmpdir(), "eve-hands-"));
    process.env["VAULT_PATH"] = join(dir, "not-mounted");
    // The defect this exists to prevent: she reports "nothing in the vault about X" when
    // the vault simply is not there.
    await expect(vaultSearch.execute({ area: "private", q: "anything" }, ctx)).rejects.toThrow(
      StoreUnhealthyError,
    );
  });

  it("an unconfigured store names the missing variable", async () => {
    dir = mkdtempSync(join(tmpdir(), "eve-hands-"));
    delete process.env["ATLAS_PATH"];
    await expect(vaultSearch.execute({ area: "shared", q: "anything" }, ctx)).rejects.toThrow(
      StorePathNotConfiguredError,
    );
  });

  it("refuses to read outside its store, absolutely or by traversal", async () => {
    twoStores();
    await expect(
      vaultRead.execute({ area: "private", path: "/run/secrets/gateway-key" }, ctx),
    ).rejects.toThrow(NotePathEscapesStoreError);
    await expect(
      vaultRead.execute({ area: "private", path: "../atlas/orakel.md" }, ctx),
    ).rejects.toThrow(NotePathEscapesStoreError);
  });
});
