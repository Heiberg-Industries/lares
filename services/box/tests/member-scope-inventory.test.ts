// LAR-21-s4 / W5B-s5 — a test that no new table can forget it holds member data.
//
// This is a repository test, not runtime code — it reads services/box/sql straight off disk
// every time it runs (styled after tests/migration-numbering.test.ts), so it keeps catching a
// missing inventory entry as new migrations land, rather than only pinning what is true today.
//
// ONE DEVIATION FROM THE PLAN'S LITERAL TEXT: the third assertion below reads
// `expect(t.createdBy, t.table).toMatch(/\.sql$|\(runtime DDL\)$/)` rather than a bare
// `/\.sql$/`. `dream_observations` and `dream_preferences` are not created by any `.sql` file at
// all (lib/member-scope.ts explains why: they are runtime DDL in
// services/chief-of-staff/lib/dream/store.ts), and the plan's own fourth test below requires
// exactly that literal `createdBy` string for both of them. A bare `/\.sql$/` here would make
// this file self-contradictory — no `createdBy` value could satisfy both assertions at once. The
// loosened regex keeps the spirit (createdBy names where to check the claim) while admitting the
// one documented exception the plan itself calls for.
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
      expect(t.createdBy, t.table).toMatch(/\.sql$|\(runtime DDL\)$/);
    }
  });

  it("names the tables wave 4 and wave 5 added, with the columns they actually have", () => {
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
  });

  it("records the tables that are NOT created by a numbered migration, so nobody thinks they are covered", () => {
    for (const t of ["dream_observations", "dream_preferences"]) {
      expect(scopeOf(t), t).toMatchObject({ createdBy: "services/chief-of-staff/lib/dream/store.ts (runtime DDL)" });
    }
  });

  // W5I-s3 — the inventory says what is true: two entries corrected, and a rule for new tables.

  it("does not claim a column that the schema does not have", () => {
    // voice_exemplar's CREATE TABLE (sql/013_voice.sql:27-36) is
    // (id, lang, text, vector, source_message_id, included, created_at) — no mailbox, no person.
    const sql = readFileSync(join(__dirname, "..", "sql", "013_voice.sql"), "utf8");
    expect(sql).not.toMatch(/mailbox/i);
    expect(scopeOf("voice_exemplar")).toMatchObject({ scope: "resolved", clearedWholeOnly: true });
    expect(scopeOf("voice_exemplar")!.reachedBy).not.toMatch(/mailbox/i);
  });

  it("classifies by what the code WRITES, not by what the column is called", () => {
    // These four are named `principal` but are written with CANONICAL_USER_ID — the register's id.
    // outreach-store.ts:61, telegram-rotation.ts:88+127+267, email-triage-store.ts:62; and
    // sql/023_schema_principal_scoping.sql backfilled three of them with the canonical id as default.
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
  // exception nobody decided on) or a listed table no longer uses it (a later slice fixed it —
  // remove it from the list in the same change).

  const help = (list: string) =>
    `name the person with \`users.id\` in a column the inventory marks \`idKind: "registry"\`, ` +
    `or, if this table genuinely cannot, add it to ${list} with a reason.`;

  const LEGACY_PRINCIPAL_TABLES = [
    "digest_requests", "workflow_jobs",
    "meeting_followup_sent", "agent_door_connections", "agent_door_claim_audit",
  ];   // W5I-s8 (box 085, ruling D4) took `oauth_tokens` and `email_watch_cursors` off this list
       // in the same commit as the migration that renamed their values. The remaining five are
       // door and job bookkeeping, not a person's own content; nothing has claimed them yet.

  const LEGACY_OWNER_KEY_TABLES = [
    "forget_ledger",
  ];   // W5I-s4 (box 083) took the other fifteen off this list in the same commit as the
       // migration that rewrote them. `forget_ledger` is the one that stays: its `match_hash`
       // was derived FROM the owner string and can never be re-derived, so rewriting the column
       // would silently switch off every forget it holds (box 083's header states this, and
       // tests/owner-key-normalised.test.ts pins that the migration does not touch it). W5I-s7
       // keys NEW ledger rows on the register's id and is the slice that empties this list.

  const FROZEN_ACTOR_TABLES = [
    "ratchet", "ratchet_audit", "voice_profile", "keeper_audit", "settings", "settings_audit",
  ];   // decision D6: an erase replaces the name with `erased`, not a person id — not expected to shrink

  const LEGACY_COLUMNLESS_TABLES = [
    "memory_proposals", "voice_exemplar",
    "notion_sync_docs", "notion_sync_proposals", "notion_sync_fidelity",
    "atlas_notes", "atlas_proposals",
  ];   // W5I-s6 (box 084) gave `dream_observations` and `dream_preferences` an `owner` column and
       // took them off this list, both in the same commit as the migration. `voice_exemplar`
       // stays: per the corrected inventory (W5I-s3) it has no person column and cannot be
       // reached by any join at all (sql/013_voice.sql:27-36's own columns have no candidate) —
       // box 084 does not touch it.

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

  it("every member table that is NOT a frozen exception uses the register's id (decision D3)", () => {
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
