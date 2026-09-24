// services/box/tests/oauth-principal-rename.test.ts — W5I-s8 (owner ruling D4).
//
// WHAT THIS FILE IS PROVING. `sql/085_oauth_principal_is_the_register_id.sql` renames the
// `principal` of the owner's live Google token rows, by hand, over SSH. The owner reversed a
// recommendation to freeze those rows, accepting that the worst case is signing in to Google
// again — so the burden here is to show that the worst case is not reached by the rename itself.
// Four promises, each checked against the real schema on a disposable copy
// (tests/helpers/three-spellings.ts):
//
//   1. THE TOKEN STILL DECRYPTS. A token stored under the old spelling decrypts, under the new
//      principal, with the same key, to the same plaintext — and its stored ciphertext bytes are
//      byte-for-byte what they were. That is the whole D4 argument, tested rather than reasoned:
//      the principal is a lookup key, not key material (crypto.ts takes its key straight from
//      TOKEN_ENC_KEY, the IV rides in the blob, and `setAAD` is called nowhere in the repo).
//   2. NO TOKEN IS LOST. A value the register cannot resolve is left and reported. A rename that
//      would collide with a row the canonical id already holds for the same mailbox is refused
//      for THAT row only — it is left, reported, and its neighbours still move. Nothing is
//      deleted, nothing is inserted, and the other fixture person is untouched.
//   3. THE ROLLBACK IS REAL. The statements in the file's header are extracted from the file and
//      run: forward → back → forward, ending where the first forward run left off.
//   4. THE DRY RUN CANNOT ROT. The SELECT the owner is told to paste into psql before applying
//      anything is read out of the migration file itself and executed, before and after.
//
// AND THE SUPPLIER THAT CANNOT BE FIXED BY SQL: three environment values still name the
// principal, and a deployment that applies 085 without moving them finds zero rows and reports
// "no account connected". The last two tests pin the two halves of the answer to that — the
// console's default is no longer a legacy literal, and a lookup that finds nothing says so once,
// naming the principal it looked under.
//
// The fixture seeds `oauth_tokens` and `email_watch_cursors` the way a box looks AFTER this
// migration (the register's id), because that is what the inventory now says they hold; the
// before-picture is planted here, in `beforeAll`, exactly as tests/owner-key-normalised.test.ts
// plants it for 083. The fixture database also carries the one live installation's own seeded
// rows (014/028/029). Nothing here asserts on them, and nothing here special-cases them by name.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  startThreeSpellingsDb,
  FIXTURE_OWNER,
  FIXTURE_SECOND,
  type TestDb,
} from "./helpers/three-spellings.js";
import { MEMBER_SCOPE } from "../lib/member-scope.js";
import {
  storeToken,
  listDecryptedRefreshTokens,
  getDecryptedRefreshToken,
  resetOAuthPrincipalWarningForTests,
} from "../lib/oauth-tokens.js";
import { decryptSecret } from "../lib/crypto.js";

const SQL = join(__dirname, "..", "sql");
const MIGRATION = readFileSync(join(SQL, "085_oauth_principal_is_the_register_id.sql"), "utf8");

/** A 64-hex AES key, used only inside this disposable container. */
const KEY = "a".repeat(64);

// The spellings the fixture registers as aliases of FIXTURE_OWNER / FIXTURE_SECOND, and one
// value nobody in the register has ever answered to.
const LEGACY = "U_fixture";
const LEGACY_CASE = "U_FIXTURE";
const LEGACY_SECOND = "U_fixture2";
const STRANGER = "a-service-account";

// The mailbox used for the collision case: the canonical id already holds a row for it, so the
// legacy row that would become a duplicate must be left exactly where it is.
const CLASH_MAILBOX = "clash@fixture.test";
const REAL_TOKEN_MAILBOX = "token@fixture.test";
const REAL_TOKEN_SECRET = "rt-secret-123";

interface Finding {
  table_name: string | null;
  column_name: string | null;
  value: string | null;
  row_count: string | null;
  finding: string;
}
interface DryRunRow {
  table_name: string;
  value: string;
  row_count: string;
  what_085_would_do: string;
}
interface TokenRow {
  id: string;
  principal: string;
  provider: string;
  email_address: string;
  refresh_token_enc: string;
}

let db: TestDb;
let dryRunBefore: DryRunRow[];
let report: Finding[];
let rowsBefore: TokenRow[];
let countsBefore: Record<string, number>;

/** The migration's own result set: the last statement is the findings SELECT. */
async function applyMigration(): Promise<Finding[]> {
  const result = await db.pool.query(MIGRATION);
  const results = Array.isArray(result) ? result : [result];
  const findings = results.find((r) => r.fields?.some((f: { name: string }) => f.name === "finding"));
  if (!findings) throw new Error("085 returned no findings result set");
  return findings.rows as Finding[];
}

/** A block of SQL read out of the migration file's own header, between two markers — the thing
 *  a human is told to paste. Reading it from the file is what stops it drifting from the file. */
function headerSql(marker: string): string {
  const body = MIGRATION.split(`-- ${marker} — BEGIN`)[1]?.split(`-- ${marker} — END`)[0];
  if (!body) throw new Error(`085 no longer carries a ${marker} block between its markers`);
  return body
    .split("\n")
    .filter((line) => line.startsWith("--"))
    .map((line) => line.replace(/^--\s?/, ""))
    .join("\n");
}

async function runDryRun(): Promise<DryRunRow[]> {
  const { rows } = await db.pool.query<DryRunRow>(headerSql("DRY RUN SELECT"));
  return rows;
}

async function tokenRows(): Promise<TokenRow[]> {
  const { rows } = await db.pool.query<TokenRow>(
    `SELECT id::text AS id, principal, provider, email_address, refresh_token_enc
       FROM oauth_tokens ORDER BY id`,
  );
  return rows;
}

async function rowCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of ["oauth_tokens", "email_watch_cursors", "user_aliases"]) {
    const { rows } = await db.pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
    out[table] = Number(rows[0].n);
  }
  return out;
}

/** Every (principal, provider, mailbox) the token table holds — the state this migration is
 *  allowed to touch, in one comparable shape. */
async function tokenShape(): Promise<string[]> {
  return (await tokenRows()).map((r) => `${r.principal}|${r.provider}|${r.email_address}`).sort();
}

beforeAll(async () => {
  db = await startThreeSpellingsDb();

  // ── Plant the situation the live box is in, before 085 ───────────────────────────────────
  // The fixture seeds these two tables post-085 (the register's id); put the legacy spellings
  // back, using the case-divergent alias for the watcher's cursor the way a long-lived box
  // accumulates one.
  await db.pool.query(`UPDATE oauth_tokens SET principal = $1 WHERE principal = $2`, [LEGACY, FIXTURE_OWNER]);
  await db.pool.query(`UPDATE oauth_tokens SET principal = $1 WHERE principal = $2`, [LEGACY_SECOND, FIXTURE_SECOND]);
  await db.pool.query(`UPDATE email_watch_cursors SET principal = $1 WHERE principal = $2`, [LEGACY_CASE, FIXTURE_OWNER]);

  // A REAL encrypted token under the old spelling — the one this whole slice is about.
  await storeToken(db.pool, KEY, {
    principal: LEGACY, provider: "google", orgId: "fixture-org",
    emailAddress: REAL_TOKEN_MAILBOX, scopes: ["gmail.send"], refreshToken: REAL_TOKEN_SECRET,
  });

  // The collision: the canonical id ALREADY holds a row for a mailbox the legacy spelling also
  // holds. Renaming the legacy row would make the two identical on (principal, provider,
  // email_address) — so it must be left, reported, and never deleted.
  await storeToken(db.pool, KEY, {
    principal: FIXTURE_OWNER, provider: "google", orgId: "fixture-org",
    emailAddress: CLASH_MAILBOX, scopes: [], refreshToken: "rt-canonical",
  });
  await storeToken(db.pool, KEY, {
    principal: LEGACY, provider: "google", orgId: "fixture-org",
    emailAddress: CLASH_MAILBOX, scopes: [], refreshToken: "rt-legacy",
  });

  // A value nobody in the register answers to.
  await storeToken(db.pool, KEY, {
    principal: STRANGER, provider: "google", orgId: "fixture-org",
    emailAddress: "stranger@fixture.test", scopes: [], refreshToken: "rt-stranger",
  });

  // The enrolment alias system the header's rollback reads: exactly ONE per person.
  await db.pool.query(
    `INSERT INTO user_aliases (system, alias, user_id) VALUES ('google', $1, $2), ('google', $3, $4)`,
    [LEGACY, FIXTURE_OWNER, LEGACY_SECOND, FIXTURE_SECOND],
  );

  rowsBefore = await tokenRows();
  countsBefore = await rowCounts();
  dryRunBefore = await runDryRun();
  report = await applyMigration();
}, 240_000);

afterAll(async () => {
  await db.stop();
});

describe("box 085 — the Google token rows are named by the register", () => {
  it("the token still decrypts to the same secret after the rename — the whole D4 argument", async () => {
    // Nothing answers to the old spelling any more…
    const gone = await db.pool.query(
      `SELECT 1 FROM oauth_tokens WHERE principal = $1 AND email_address = $2`,
      [LEGACY, REAL_TOKEN_MAILBOX],
    );
    expect(gone.rowCount).toBe(0);

    // …and the same stored bytes, the same key and the NEW principal give the same plaintext.
    // (Decrypted here row by row rather than through `listDecryptedRefreshTokens`, because the
    // fixture's own seeded rows carry a placeholder string in `refresh_token_enc` that was never
    // ciphertext — a whole-principal list would try to decrypt that too.)
    const { rows } = await db.pool.query<{ refresh_token_enc: string }>(
      `SELECT refresh_token_enc FROM oauth_tokens WHERE principal = $1 AND email_address = $2`,
      [FIXTURE_OWNER, REAL_TOKEN_MAILBOX],
    );
    expect(rows).toHaveLength(1);
    expect(decryptSecret(rows[0].refresh_token_enc, KEY)).toBe(REAL_TOKEN_SECRET);

    // And through the store's own read path, under the new principal.
    expect((await getDecryptedRefreshToken(db.pool, KEY, FIXTURE_OWNER, "google"))?.token)
      .toBe("rt-canonical");
  });

  it("does not touch one ciphertext byte — every row's blob is what it was", async () => {
    const before = new Map(rowsBefore.map((r) => [r.id, r.refresh_token_enc]));
    const after = await tokenRows();
    expect(after).toHaveLength(rowsBefore.length);
    for (const r of after) {
      expect(before.has(r.id), `row ${r.id} is new — 085 must not insert`).toBe(true);
      expect(r.refresh_token_enc, `row ${r.id} was re-encrypted`).toBe(before.get(r.id));
    }
  });

  it("renames only spellings the register resolves to exactly one person", async () => {
    const shape = await tokenShape();
    expect(shape).toContain(`${FIXTURE_OWNER}|google|${REAL_TOKEN_MAILBOX}`);
    expect(shape).toContain(`${FIXTURE_OWNER}|google|owner@fixture.test`);
    expect(shape).toContain(`${FIXTURE_SECOND}|google|second@fixture.test`);
  });

  it("leaves a value the register does not know ALONE, and reports it", async () => {
    const { rows } = await db.pool.query(`SELECT 1 FROM oauth_tokens WHERE principal = $1`, [STRANGER]);
    expect(rows).toHaveLength(1);
    const finding = report.find((r) => r.table_name === "oauth_tokens" && r.value === STRANGER);
    expect(finding, JSON.stringify(report, null, 2)).toBeDefined();
    expect(finding!.finding).toMatch(/^LEFT ALONE - nobody in the identity register answers/);
    expect(Number(finding!.row_count)).toBe(1);
  });

  it("refuses the ONE rename that would collide, keeps both rows, and reports it", async () => {
    const shape = await tokenShape();
    expect(shape).toContain(`${FIXTURE_OWNER}|google|${CLASH_MAILBOX}`); // the row that was there
    expect(shape).toContain(`${LEGACY}|google|${CLASH_MAILBOX}`);        // the row that could not move
    // Both secrets are still readable — the point of refusing rather than overwriting.
    expect((await getDecryptedRefreshToken(db.pool, KEY, LEGACY, "google"))?.token).toBe("rt-legacy");
    const finding = report.find((r) => r.table_name === "oauth_tokens" && r.value === LEGACY);
    expect(finding, JSON.stringify(report, null, 2)).toBeDefined();
    expect(finding!.finding).toMatch(/^LEFT ALONE - renaming this would collide/);
    expect(finding!.finding).toContain(FIXTURE_OWNER);
  });

  it("renames the email watcher's cursors in the same transaction", async () => {
    const { rows } = await db.pool.query<{ principal: string }>(
      `SELECT principal FROM email_watch_cursors WHERE watcher = 'fixture-watcher'`,
    );
    expect(rows.map((r) => r.principal)).toEqual([FIXTURE_OWNER]);
  });

  it("deletes nothing and inserts nothing", async () => {
    expect(await rowCounts()).toEqual(countsBefore);
  });

  it("keeps the alias rows, so a missed row is still findable and the rename is reversible", async () => {
    const { rows } = await db.pool.query<{ alias: string }>(
      `SELECT alias FROM user_aliases WHERE user_id = $1 ORDER BY alias`,
      [FIXTURE_OWNER],
    );
    expect(rows.map((r) => r.alias)).toEqual(expect.arrayContaining([LEGACY, LEGACY_CASE]));
  });

  it("touches nobody else's rows — the second fixture person keeps exactly one token", async () => {
    const { rows } = await db.pool.query<{ email_address: string }>(
      `SELECT email_address FROM oauth_tokens WHERE principal = $1`,
      [FIXTURE_SECOND],
    );
    expect(rows.map((r) => r.email_address)).toEqual(["second@fixture.test"]);
  });

  it("the dry run in the header predicted exactly this, and predicts nothing more afterwards", async () => {
    const wouldChange = dryRunBefore.filter((r) => r.what_085_would_do.startsWith("WOULD BECOME"));
    expect(wouldChange.map((r) => r.table_name).sort()).toEqual(
      expect.arrayContaining(["email_watch_cursors", "oauth_tokens"]),
    );
    expect(wouldChange.some((r) => r.value === LEGACY && r.what_085_would_do === `WOULD BECOME ${FIXTURE_OWNER}`)).toBe(true);

    const strangerBefore = dryRunBefore.find((r) => r.value === STRANGER);
    expect(strangerBefore?.what_085_would_do).toMatch(/^LEFT ALONE/);
    const clashBefore = dryRunBefore.find(
      (r) => r.value === LEGACY && r.what_085_would_do.startsWith("LEFT ALONE"),
    );
    expect(clashBefore?.what_085_would_do).toContain(FIXTURE_OWNER);

    const after = await runDryRun();
    expect(after.filter((r) => r.what_085_would_do.startsWith("WOULD BECOME"))).toEqual([]);
  });

  it("re-runs without error and changes nothing the second time", async () => {
    const before = await tokenShape();
    await applyMigration();
    expect(await tokenShape()).toEqual(before);
  });

  it("the rollback in the header really puts the old spelling back, and forward works again", async () => {
    const afterForward = await tokenShape();

    await db.pool.query(headerSql("ROLLBACK"));
    const rolledBack = await tokenShape();
    expect(rolledBack).toContain(`${LEGACY}|google|${REAL_TOKEN_MAILBOX}`);
    expect(rolledBack).toContain(`${LEGACY_SECOND}|google|second@fixture.test`);
    // The watcher's cursor comes back under the alias registered in the named system — which is
    // why the header tells the operator to name the system the spelling actually lives under.
    const { rows } = await db.pool.query<{ principal: string }>(
      `SELECT principal FROM email_watch_cursors WHERE watcher = 'fixture-watcher'`,
    );
    expect(rows.map((r) => r.principal)).toEqual([LEGACY]);

    await applyMigration();
    expect(await tokenShape()).toEqual(afterForward);
  });

  it("the inventory now calls both tables `registry`, and nothing was lost from it", () => {
    for (const table of ["oauth_tokens", "email_watch_cursors"]) {
      expect(MEMBER_SCOPE.find((t) => t.table === table), table).toMatchObject({
        scope: "member",
        column: "principal",
        idKind: "registry",
      });
    }
  });

  it("the console no longer defaults to the legacy spelling", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "console", "lib", "accounts.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/U_bendik/i);
    expect(src).toMatch(/ownerId\(\)/);
  });

  it("says ONCE, loudly, which principal it looked under when no token is found", async () => {
    resetOAuthPrincipalWarningForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await getDecryptedRefreshToken(db.pool, KEY, LEGACY_CASE, "google")).toBeNull();
      expect(await listDecryptedRefreshTokens(db.pool, KEY, LEGACY_CASE, "google")).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const said = String(warn.mock.calls[0][0]);
      expect(said).toContain(LEGACY_CASE);
      expect(said).toContain("085");
      expect(said).toContain("GOOGLE_PRINCIPAL_ID");
    } finally {
      warn.mockRestore();
      resetOAuthPrincipalWarningForTests();
    }
  });
});
