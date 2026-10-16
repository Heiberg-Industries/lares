import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRefreshLock } from "../src/refresh-lock.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "refresh-lock-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the refresh lock", () => {
  it("runs the refresh once and returns its value", async () => {
    const lock = makeRefreshLock({ root });
    let ran = 0;
    const v = await lock.withRefresh("google:acct", async () => { ran++; return "token-1"; }, async () => undefined);
    expect(v).toBe("token-1");
    expect(ran).toBe(1);
  });

  it("a concurrent caller waits and takes the first caller's result, never refreshing twice", async () => {
    const lock = makeRefreshLock({ root });
    let ran = 0;
    let stored: string | undefined;
    const refresh = async () => { ran++; await new Promise((r) => setTimeout(r, 25)); stored = `token-${ran}`; return stored; };
    const recheck = async () => stored;
    const [a, b] = await Promise.all([
      lock.withRefresh("google:acct", refresh, recheck),
      lock.withRefresh("google:acct", refresh, recheck),
    ]);
    expect(ran).toBe(1);
    expect(a).toBe("token-1");
    expect(b).toBe("token-1");
  });

  it("different keys do not block each other", async () => {
    const lock = makeRefreshLock({ root });
    let ran = 0;
    await Promise.all([
      lock.withRefresh("a", async () => { ran++; return 1; }, async () => undefined),
      lock.withRefresh("b", async () => { ran++; return 1; }, async () => undefined),
    ]);
    expect(ran).toBe(2);
  });

  it("releases on a throw, so one failure does not wedge the key forever", async () => {
    const lock = makeRefreshLock({ root });
    await expect(lock.withRefresh("k", async () => { throw new Error("refused"); }, async () => undefined)).rejects.toThrow("refused");
    expect(await lock.withRefresh("k", async () => "ok", async () => undefined)).toBe("ok");
  });

  it("breaks a stale lock left by a killed process", async () => {
    mkdirSync(join(root, "k"), { recursive: true });
    writeFileSync(join(root, "k", "held-at"), String(Date.now() - 60_000));
    const lock = makeRefreshLock({ root, staleMs: 30_000 });
    expect(await lock.withRefresh("k", async () => "ok", async () => undefined)).toBe("ok");
  });

  it("refreshes itself rather than hanging when the holder finishes without storing anything", async () => {
    const lock = makeRefreshLock({ root, waitMs: 200 });
    // recheck keeps returning undefined; the waiter must eventually take the lock and refresh.
    let ran = 0;
    const [a, b] = await Promise.all([
      lock.withRefresh("k", async () => { ran++; await new Promise((r) => setTimeout(r, 20)); return "x"; }, async () => undefined),
      lock.withRefresh("k", async () => { ran++; await new Promise((r) => setTimeout(r, 20)); return "x"; }, async () => undefined),
    ]);
    expect([a, b]).toEqual(["x", "x"]);
    expect(ran).toBe(2);
  });

  it("gives up with a named error rather than waiting forever", async () => {
    mkdirSync(join(root, "k"), { recursive: true });
    writeFileSync(join(root, "k", "held-at"), String(Date.now()));
    const lock = makeRefreshLock({ root, waitMs: 50, staleMs: 10 * 60_000 });
    await expect(lock.withRefresh("k", async () => "x", async () => undefined)).rejects.toThrow(/still refreshing/i);
  });
});
