/**
 * ORB-133 Task 6 — the schedule's two decisions that are not the runner's: whether it may run
 * at all, and where the result goes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { digestGate, chooseTarget, listInboxFiles, DIGEST_LLM_OPTIONS } from "../agent/schedules/digest.js";

const saved = { ...process.env };
beforeEach(() => { process.env = { ...saved }; });
afterEach(() => { process.env = { ...saved }; });

describe("digestGate — fails closed, and is independent of the service-wide gate", () => {
  it("is off when its own gate is unset, even with schedules live", () => {
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    delete process.env["EVE_DIGEST_LIVE"];
    expect(digestGate()).toBe(false);
  });

  it('is off for anything other than exactly "1"', () => {
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    for (const v of ["0", "true", "yes", "", " 1", "1 "]) {
      process.env["EVE_DIGEST_LIVE"] = v;
      expect(digestGate(), `EVE_DIGEST_LIVE=${JSON.stringify(v)} must not enable the digest`).toBe(false);
    }
  });

  it("is on only when BOTH gates are exactly 1", () => {
    process.env["EVE_SCHEDULES_LIVE"] = "1";
    process.env["EVE_DIGEST_LIVE"] = "1";
    expect(digestGate()).toBe(true);
  });

  // The whole point of the second gate: it must be possible to ship the code to the box with
  // schedules already live, and still have the digest dark until the old digest container is stopped.
  it("stays off when the service gate is off but its own is on", () => {
    process.env["EVE_SCHEDULES_LIVE"] = "0";
    process.env["EVE_DIGEST_LIVE"] = "1";
    expect(digestGate()).toBe(false);
  });
});

describe("chooseTarget — a scheduled pass DMs the owner; an on-demand pass replies where it was asked", () => {
  const req = (threadRef: string) => ({ id: "r", door: "slack", threadRef });

  it("a scheduled pass goes to the DM, ignoring any request that rode along in the same tick", () => {
    expect(chooseTarget(true, [req("C_THREAD")], "U_DM")).toBe("U_DM");
  });

  it("an on-demand pass replies in the requesting thread, not the DM", () => {
    expect(chooseTarget(false, [req("C_THREAD")], "U_DM")).toBe("C_THREAD");
  });

  it("an on-demand pass with no threadRef falls back to the DM rather than going nowhere", () => {
    expect(chooseTarget(false, [], "U_DM")).toBe("U_DM");
  });

  it("takes the FIRST request's thread when several were claimed at once", () => {
    expect(chooseTarget(false, [req("FIRST"), req("SECOND")], "U_DM")).toBe("FIRST");
  });
});

/**
 * LAR-17-s3 — PIN, asserted against the source: the digest's slots come from the setting
 * (`scheduleHours("digest")`), read before `dueScheduledSlot` is ever called, and no hardcoded
 * `[9, 17]` default rides along inside this file (the removed default belonged to
 * `lib/digest/schedule.ts`'s `dueScheduledSlot`, whose own tests in digest-modules.test.ts cover
 * that it now REQUIRES an hours array).
 */
describe("digest.ts reads its slots from the setting (LAR-17-s3)", () => {
  it("calls scheduleHours before dueScheduledSlot, and passes no literal [9, 17]", async () => {
    const src = await (await import("node:fs/promises")).readFile(
      new URL("../agent/schedules/digest.ts", import.meta.url),
      "utf8",
    );
    expect(src.indexOf('scheduleHours("digest")')).toBeGreaterThan(-1);
    expect(src.indexOf('scheduleHours("digest")')).toBeLessThan(src.indexOf("dueScheduledSlot("));
    expect(src).not.toContain("[9, 17]");
  });
});

/**
 * Articles child 1b: the digest files articles. The pieces that carry the decisions are tested on
 * their own (`digest-article-area.test.ts`, `digest-article-file.test.ts`,
 * `clipping-ledger-article.test.ts`); these pin that the schedule actually uses them, in the
 * places that matter, and the small behaviours that live in this file.
 */
describe("the digest schedule switches article filing on", () => {
  const read = () => readFile(new URL("../agent/schedules/digest.ts", import.meta.url), "utf8");

  it("hands the runner an article filer built from the setting and the grant-checked shared root", async () => {
    const src = await read();
    expect(src).toMatch(/articleTargets\(\{/);
    expect(src).toMatch(/fileArticle: makeArticleFiler\(\{\s*privateRoot: root,\s*sharedRoot: targets\.sharedRoot,\s*articleArea: targets\.articleArea,/);
    // The grant is read from the running agent's own definition, never assumed.
    expect(src).toMatch(/readDefinition: async \(\) => \(await thisAgent\(undefined\)\)\.loaded\.definition/);
  });

  it("reads the setting and the grant once, before the runner starts", async () => {
    const src = await read();
    expect(src.indexOf("await articleTargets(")).toBeGreaterThan(-1);
    expect(src.indexOf("await articleTargets(")).toBeLessThan(src.indexOf("await runDigest({"));
  });

  it("records where each article went, best effort, through the ledger hook", async () => {
    expect(await read()).toMatch(/onFiled: makeLedgerOnFiled\(db, log\)/);
  });

  it("makes every model call with no retries and an 800-token ceiling", async () => {
    expect(DIGEST_LLM_OPTIONS).toEqual({ maxRetries: 0, maxOutputTokens: 800 });
    expect(await read()).toMatch(/llm: \(prompt: string\) => gatewayComplete\(prompt, DIGEST_LLM_OPTIONS\)/);
  });

  it("keeps the clipping-choice gating and the runner's opening keys in order", async () => {
    const src = await read();
    expect(src).toMatch(/runDigest\(\{\s+agent: AGENT,\s+mode,\s+notices,/);
    expect(src).toContain("readClippingChoice(db)");
    expect(src).toContain('choice === "notion"');
    expect(src).toContain('choice === "karakeep"');
  });
});

describe("listInboxFiles lists the oldest saved links first", () => {
  it("sorts by modification time, oldest first, and ignores anything that is not a note", () => {
    const root = mkdtempSync(join(tmpdir(), "inbox-order-"));
    try {
      mkdirSync(join(root, "_inbox"));
      const put = (name: string, body: string, secondsAgo: number) => {
        const abs = join(root, "_inbox", name);
        writeFileSync(abs, body);
        const t = new Date(Date.now() - secondsAgo * 1000);
        utimesSync(abs, t, t);
      };
      // Names sort the opposite way round to their age, so a name sort would get it wrong.
      put("a-newest.md", "n", 10);
      put("b-oldest.md", "o", 3000);
      put("c-middle.md", "m", 500);
      put("notes.txt", "x", 9000);
      mkdirSync(join(root, "_inbox", "d-folder.md"));

      expect(listInboxFiles(root).map((f) => f.path)).toEqual([
        "_inbox/b-oldest.md", "_inbox/c-middle.md", "_inbox/a-newest.md",
      ]);
      expect(listInboxFiles(root).map((f) => f.body)).toEqual(["o", "m", "n"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("breaks a tie on the name, so the order is the same every time", () => {
    const root = mkdtempSync(join(tmpdir(), "inbox-tie-"));
    try {
      mkdirSync(join(root, "_inbox"));
      const t = new Date("2026-10-01T10:00:00Z");
      for (const name of ["z.md", "a.md", "m.md"]) {
        const abs = join(root, "_inbox", name);
        writeFileSync(abs, name);
        utimesSync(abs, t, t);
      }
      expect(listInboxFiles(root).map((f) => f.path)).toEqual(["_inbox/a.md", "_inbox/m.md", "_inbox/z.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is empty when there is no inbox", () => {
    const root = mkdtempSync(join(tmpdir(), "inbox-none-"));
    try {
      expect(listInboxFiles(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
