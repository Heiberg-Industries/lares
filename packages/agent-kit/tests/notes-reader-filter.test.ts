import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBacklinks, narrowestScope, readNote, searchNotes } from "../src/notes-store.js";

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), "scope-vault-"));
  writeFileSync(join(root, "open.md"), "---\nscope: org\n---\nquarterly zeppelin figures\n");
  writeFileSync(
    join(root, "room.md"),
    "---\nscope: participants\nparticipants: [bendik, stefan]\n---\nzeppelin hiring transcript\n",
  );
  writeFileSync(
    join(root, "mine.md"),
    "---\nscope: private\nowner: bendik\n---\nzeppelin private reflection, links [[open]]\n",
  );
  return root;
}

describe("the reader filter — enforced in the store, below every tool", () => {
  it("absent reader = the legacy unfiltered path (single-user installs keep working)", () => {
    expect(searchNotes("zeppelin", vault()).hits).toHaveLength(3);
  });

  it("a participant sees org + their rooms + their own private notes", () => {
    const hits = searchNotes("zeppelin", vault(), { userId: "bendik", store: "brain" }).hits;
    expect([...hits].sort()).toEqual(["mine.md", "open.md", "room.md"]);
  });

  it("a member outside the room sees only org notes", () => {
    const hits = searchNotes("zeppelin", vault(), { userId: "kari", store: "brain" }).hits;
    expect(hits).toEqual(["open.md"]);
  });

  it("readNote refuses an invisible note with the same error as a missing one — no existence oracle", () => {
    const root = vault();
    let missing: unknown;
    let hidden: unknown;
    try {
      readNote("no-such.md", root, { userId: "kari", store: "brain" });
    } catch (e) {
      missing = e;
    }
    try {
      readNote("mine.md", root, { userId: "kari", store: "brain" });
    } catch (e) {
      hidden = e;
    }
    expect(hidden).toBeDefined();
    expect((hidden as Error).constructor).toBe((missing as Error).constructor);
  });

  it("findBacklinks never cites an invisible note as a citer", () => {
    const root = vault();
    const forKari = findBacklinks("open.md", root, { userId: "kari", store: "brain" });
    expect(forKari.backlinks).toHaveLength(0); // mine.md links here but kari cannot know that
  });

  it("filters through the anchored-fallback branch too, not just the exact-match branch", () => {
    // Every other test here queries "zeppelin", which every fixture note contains — so
    // `all.length > 0` and searchNotes always resolves via the exact-match branch. This
    // fixture is built so NO note contains every query token, forcing the ORB-171 anchored
    // fallback (src/notes-store.ts's `df`/`anchors` path) to be what produces the hit that
    // then gets filtered.
    const root = mkdtempSync(join(tmpdir(), "scope-vault-fallback-"));
    // "gadget" is common (df 2, both org notes) and never becomes the anchor. "prototype"
    // appears ONLY in the private note (df 1) and is the sole anchor — the fallback's only
    // hit. No file contains both tokens, so the exact-match branch is empty here.
    writeFileSync(join(root, "public.md"), "---\nscope: org\n---\ngadget catalogue\n");
    writeFileSync(join(root, "other.md"), "---\nscope: org\n---\ngadget pricing\n");
    writeFileSync(join(root, "secret.md"), "---\nscope: private\nowner: bendik\n---\nprototype notes\n");

    // Sanity: unfiltered, the fallback surfaces the anchor-carrying private note (proves this
    // query actually exercises the fallback branch, not the exact-match one).
    expect(searchNotes("gadget prototype", root).hits).toEqual(["secret.md"]);

    // The owner sees their own private note via the fallback branch.
    expect(searchNotes("gadget prototype", root, { userId: "bendik", store: "brain" }).hits).toEqual([
      "secret.md",
    ]);

    // Anyone else must not — the fallback branch's visible() call is what drops it, proving
    // that branch (not just the exact-match one) is filtered.
    expect(searchNotes("gadget prototype", root, { userId: "kari", store: "brain" }).hits).toEqual([]);
  });

  it("narrowestScope: a derivation inherits the narrowest of its sources", () => {
    expect(narrowestScope(["org", "participants"])).toBe("participants");
    expect(narrowestScope(["org", "participants", "private"])).toBe("private");
    expect(narrowestScope(["org"])).toBe("org");
    expect(narrowestScope([])).toBe("private"); // no sources = no evidence it may spread
  });
});
