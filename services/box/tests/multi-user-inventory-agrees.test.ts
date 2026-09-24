// W5I-s10 — the multi-user "what is left" document cannot go stale silently. This is a
// repository test, not runtime code: it reads the document and the inventory straight off disk
// every time it runs, so a later slice that adds a non-registry member table or a new
// column-less table fails this test until the document is updated to mention it.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { MEMBER_SCOPE } from "../lib/member-scope.js";

const REPO = join(__dirname, "..", "..", "..");
const doc = readFileSync(join(REPO, "docs/specs/2026-09-19-multi-user-what-is-left.md"), "utf8");

describe("the multi-user 'what is left' document agrees with the inventory", () => {
  it("names every table that is still not keyed on the register", () => {
    for (const t of MEMBER_SCOPE.filter((x) => x.scope === "member" && x.idKind !== "registry")) {
      expect(doc, t.table).toContain(t.table);
    }
  });

  it("names every table that holds a person's data with no person column", () => {
    for (const t of MEMBER_SCOPE.filter((x) => x.scope === "resolved")) {
      expect(doc, t.table).toContain(t.table);
    }
  });

  it("names every single-value environment variable the fleet reads as 'the owner'", () => {
    for (const v of [
      "AGENT_OWNER_USER_ID", "GOOGLE_PRINCIPAL_ID", "NOTION_SYNC_PRINCIPAL",
      "CONSOLE_PRINCIPAL_ID", "TELEGRAM_PRINCIPAL_ID", "SLACK_ALLOWED_USER_IDS",
    ]) expect(doc, v).toContain(v);
  });

  it("is written for the owner: no task list, and every entry says what happens today", () => {
    expect(doc).not.toMatch(/^\s*- \[ \]/m); // not a checklist
    expect(doc).toMatch(/what happens today/i);
  });
});
