// A test that no new table can forget it holds member data.
//
// This is a repository test, not runtime code — it reads services/box/sql straight off disk
// every time it runs (styled after tests/migration-numbering.test.ts), so it keeps catching a
// missing inventory entry as new migrations land, rather than only pinning what is true today.
//
// Every table in the inventory now names the SQL file that creates it. The dream tables used to
// be the runtime-DDL exception; migration 026 makes their schema ownership explicit too.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { MEMBER_SCOPE, scopeOf, tablesInBoxSql } from "../lib/member-scope.js";

describe("member-scope inventory", () => {
  it("classifies every table services/box/sql creates, exactly once", () => {
    const onDisk = tablesInBoxSql(join(__dirname, "..", "sql")).sort();
    const listed = MEMBER_SCOPE.map((t) => t.table).sort();
    expect(new Set(listed).size).toBe(listed.length); // no duplicates
    expect(listed).toEqual(expect.arrayContaining(onDisk));
    expect(onDisk.filter((t) => !listed.includes(t))).toEqual([]);
  });

  it("gives every member table a column, and every resolved table a sentence", () => {
    for (const t of MEMBER_SCOPE) {
      if (t.scope === "member") expect(t.column, t.table).toBeTruthy();
      if (t.scope === "resolved") expect(t.reachedBy, t.table).toBeTruthy();
      expect(t.createdBy, t.table).toMatch(/\.sql$/);
    }
  });

  it("names the later-added tables, with the columns they actually have", () => {
    expect(scopeOf("conversation_entries")).toMatchObject({ scope: "member", column: "person_key" });
    expect(scopeOf("agent_notes")).toMatchObject({ scope: "member", column: "owner" });
    expect(scopeOf("memory_use")).toMatchObject({ scope: "member", column: "owner" });
    expect(scopeOf("memory_reads")).toMatchObject({ scope: "member", column: "owner" });
    expect(scopeOf("forget_ledger")).toMatchObject({ scope: "member", column: "owner" });
    expect(scopeOf("conversation_retention")).toMatchObject({ scope: "member", column: "owner" });
    expect(scopeOf("memory_proposals")).toMatchObject({ scope: "resolved" });
    expect(scopeOf("notion_sync_docs")).toMatchObject({ scope: "resolved" });
    expect(scopeOf("atlas_notes")).toMatchObject({ scope: "resolved" });
    expect(scopeOf("agent_conversations")).toMatchObject({ scope: "operational" });
    expect(scopeOf("keeper_credentials")).toMatchObject({ scope: "operational", createdBy: "services/box/sql/001_baseline.sql" });
  });

  it("reaches every member admission table by the canonical member id", () => {
    for (const table of ["member_invitations", "member_provider_identities", "member_sessions"]) {
      expect(scopeOf(table)).toMatchObject({ scope: "member", column: "member_id", idKind: "registry", createdBy: "services/box/sql/007_member_identity_sessions.sql" });
    }
  });

  it("exports and erases encrypted action content by its actor, retaining only replay suppression", () => {
    expect(scopeOf("personal_actions")).toMatchObject({scope:"member",column:"actor_member_id",idKind:"registry"});
    expect(scopeOf("personal_action_calls")).toMatchObject({scope:"operational"});
  });

  it("records the dream tables as created by the numbered schema migration", () => {
    for (const t of ["dream_observations", "dream_preferences"]) {
      expect(scopeOf(t), t).toMatchObject({ createdBy: "services/box/sql/026_dream_schema.sql" });
    }
  });

  // The inventory says what is true: two entries corrected, and a rule for new tables.

  it("does not claim a column that the schema does not have", () => {
    // voice_exemplar (sql/001_baseline.sql) has a mailbox column but no person column: nothing in
    // its CREATE TABLE names a person, which is why it is reached whole, not by a person id.
    const sql = readFileSync(join(__dirname, "..", "sql", "001_baseline.sql"), "utf8");
    const block = /CREATE TABLE voice_exemplar \([\s\S]*?\n\);/.exec(sql)?.[0] ?? "";
    expect(block).not.toBe("");
    expect(block).not.toMatch(/owner|user_id|person|principal/i);
    expect(scopeOf("voice_exemplar")).toMatchObject({ scope: "resolved", clearedWholeOnly: true });
  });

  it("classifies by what the code WRITES, not by what the column is called", () => {
    // These four are named `principal` but are written with CANONICAL_USER_ID — the register's id.
    // outreach-store.ts:61, telegram-rotation.ts:88+127+267, email-triage-store.ts:62; and
    // sql/001_baseline.sql backfilled three of them with the canonical id as default.
    for (const t of [
      "outreach_threads", "telegram_daily_log", "telegram_session_rotation", "email_triage_processed",
    ]) expect(scopeOf(t), t).toMatchObject({ idKind: "registry" });
  });

  // ── Owner addition 1: the rule for every table added from here on ────────────────────
  //
  // THE RULE, stated once here so a builder adding a migration finds it: a new table that holds
  // a person's data must name the person with the identity register's id — a column the
  // inventory marks `idKind: "registry"`. No new free-text owner key. No new legacy "principal"
  // spelling. No new person-holding table with no person column. No new free-text "actor"
  // column. The four lists below are today's exceptions, one per kind, frozen: each may only
  // SHRINK, and each test below fails the moment a table not on its list uses that kind (a new
  // exception nobody decided on) or a listed table no longer uses it (it was fixed —
  // remove it from the list in the same change).

  const help = (list: string) =>
    `name the person with \`users.id\` in a column the inventory marks \`idKind: "registry"\`, ` +
    `or, if this table genuinely cannot, add it to ${list} with a reason.`;

  const LEGACY_PRINCIPAL_TABLES = [
    "digest_requests", "workflow_jobs",
    "meeting_followup_sent", "agent_door_connections", "agent_door_claim_audit",
  ];   // `oauth_tokens` and `email_watch_cursors` are no longer on this list: they hold the
       // register's id. The remaining five are
       // door and job bookkeeping, not a person's own content; nothing has claimed them yet.

  const LEGACY_OWNER_KEY_TABLES = [
    "forget_ledger",
  ];   // The other formerly owner-keyed tables now hold the register's id. `forget_ledger` is the
       // one that stays: its `match_hash`
       // was derived FROM the owner string and can never be re-derived, so rewriting the column
       // would silently switch off every forget it holds. NEW ledger rows are
       // keyed on the register's id, and that is what will eventually empty this list.

  const FROZEN_ACTOR_TABLES = [
    "ratchet", "ratchet_audit", "voice_profile", "keeper_audit", "settings", "settings_audit",
  ];   // an erase replaces the name with `erased`, not a person id — not expected to shrink

  const LEGACY_COLUMNLESS_TABLES = [
    "memory_proposals", "voice_exemplar",
    "notion_sync_docs", "notion_sync_proposals", "notion_sync_fidelity",
    "atlas_notes", "atlas_proposals",
  ];   // `dream_observations` and `dream_preferences` carry an `owner` column and are no longer
       // on this list. `voice_exemplar`
       // stays: it has no person column and cannot be
       // reached by any join at all (its own columns in sql/001_baseline.sql have no candidate).

  it("no table outside the frozen list still uses a legacy principal spelling", () => {
    const principals = MEMBER_SCOPE.filter((t) => t.idKind === "principal").map((t) => t.table);
    expect(principals.sort(), help("LEGACY_PRINCIPAL_TABLES")).toEqual([...LEGACY_PRINCIPAL_TABLES].sort());
  });

  it("no table outside the frozen list still uses a free-text owner key", () => {
    const ownerKeys = MEMBER_SCOPE.filter((t) => t.idKind === "owner-key").map((t) => t.table);
    expect(ownerKeys.sort(), help("LEGACY_OWNER_KEY_TABLES")).toEqual([...LEGACY_OWNER_KEY_TABLES].sort());
  });

  it("no table outside the frozen list holds a person's data with no person column", () => {
    const columnless = MEMBER_SCOPE.filter((t) => t.scope === "resolved").map((t) => t.table);
    expect(columnless.sort(), help("LEGACY_COLUMNLESS_TABLES")).toEqual([...LEGACY_COLUMNLESS_TABLES].sort());
  });

  it("every member table that is NOT a frozen exception uses the register's id", () => {
    const offenders = MEMBER_SCOPE
      .filter((t) => t.scope === "member" && t.idKind !== "registry" && t.idKind !== "actor")
      .map((t) => t.table)
      .filter((t) => !LEGACY_PRINCIPAL_TABLES.includes(t) && !LEGACY_OWNER_KEY_TABLES.includes(t));
    expect(offenders, help("the matching frozen list")).toEqual([]);
  });

  it("no new actor column appears without a decision — the six are frozen (D6)", () => {
    const actors = MEMBER_SCOPE.filter((t) => t.idKind === "actor").map((t) => t.table);
    expect(actors.sort(), help("FROZEN_ACTOR_TABLES")).toEqual([...FROZEN_ACTOR_TABLES].sort());
  });

  it("the rule is written where a builder adding a table will read it", () => {
    const src = readFileSync(join(__dirname, "..", "lib", "member-scope.ts"), "utf8");
    expect(src).toMatch(/every new table that holds a person's data carries a person column of kind `registry`/i);
  });

  it("gives every resolved table either a real join or an honest admission, never both and never neither", () => {
    for (const t of MEMBER_SCOPE.filter((x) => x.scope === "resolved")) {
      expect(Boolean(t.reachedBy), t.table).toBe(true);
      if (t.clearedWholeOnly) expect(t.reachedBy, t.table).toMatch(/no person column|cannot be reached/i);
    }
  });
});
