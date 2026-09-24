import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withNoteLock, __chainsSize } from "../lib/note-lock.js";

describe("withNoteLock", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "brain-lock-"));
  });

  it("serialises concurrent writers to the same note (no lost appends)", async () => {
    const note = "wiki/person/jane.md";
    const target = join(root, note);
    mkdirSync(join(root, "wiki/person"), { recursive: true });
    writeFileSync(target, "");
    const append = (line: string) =>
      withNoteLock(root, note, async () => {
        const cur = readFileSync(target, "utf8");
        await new Promise((r) => setTimeout(r, 5)); // widen the race window
        writeFileSync(target, cur + line + "\n");
      });
    await Promise.all([append("A"), append("B"), append("C")]);
    const lines = readFileSync(target, "utf8").trim().split("\n").sort();
    expect(lines).toEqual(["A", "B", "C"]); // all three survived → lock held
    rmSync(root, { recursive: true, force: true });
  });

  it("lets writers to DIFFERENT notes proceed without blocking each other", async () => {
    const order: string[] = [];
    await Promise.all([
      withNoteLock(root, "a.md", async () => { await new Promise((r) => setTimeout(r, 20)); order.push("a"); }),
      withNoteLock(root, "b.md", async () => { order.push("b"); }),
    ]);
    expect(order[0]).toBe("b"); // b finished first → it never waited on a's lock
    rmSync(root, { recursive: true, force: true });
  });
});

describe("withNoteLock chain eviction", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lock-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("does not retain settled chains", async () => {
    for (let i = 0; i < 5; i++) {
      await withNoteLock(root, `note-${i}.md`, async () => { /* no-op */ });
    }
    // All five settled and none overlap → map drained back to empty.
    expect(__chainsSize()).toBe(0);
  });

  it("serialises concurrent writes to the same note", async () => {
    const order: number[] = [];
    await Promise.all([
      withNoteLock(root, "same.md", async () => { order.push(1); await new Promise(r => setTimeout(r, 20)); order.push(2); }),
      withNoteLock(root, "same.md", async () => { order.push(3); }),
    ]);
    // Second call must not interleave inside the first.
    expect(order).toEqual([1, 2, 3]);
  });

  it("rejection does not wedge: evicts map entry and allows subsequent callers", async () => {
    // (a) the rejected promise rejects with the thrown error
    await expect(
      withNoteLock(root, "x.md", async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");

    // (b) the map entry is evicted — chain size back to 0
    expect(__chainsSize()).toBe(0);

    // (c) a subsequent call for the SAME note still runs (chain is not wedged)
    let ran = false;
    await withNoteLock(root, "x.md", async () => { ran = true; });
    expect(ran).toBe(true);
    expect(__chainsSize()).toBe(0);
  });
});
