// The one-time move of mailbox voices onto members (lib/voice-mapping.ts, bin/voice-mapping.ts) and
// migration 037, against a disposable Postgres with every services/box/sql file applied in order.
// Every value is fictional (example.invalid addresses, made-up ids).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { quiet } from "./helpers/quiet-pool.js";
import {
  applyVoiceMapping, dryRunVoiceMapping, parseMapArgument, renderVoiceMappingReport,
  VoiceMappingUsageError, type VoiceMappingPlan,
} from "../lib/voice-mapping.js";
import { main } from "../bin/voice-mapping.js";

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");
const files = readdirSync(sqlDir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
const BEFORE_037 = files.filter((f) => f < "037");
const MIGRATION_037 = readFileSync(join(sqlDir, "037_person_voice_profiles.sql"), "utf8");

let container: StartedPostgreSqlContainer;
let admin: Pool;
let pool: Pool;
let dbIndex = 0;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  admin = quiet(new Pool({ connectionString: container.getConnectionUri(), max: 2 }));
}, 180_000);
afterAll(async () => { await pool?.end(); await admin?.end(); await container?.stop(); });

/** A new empty database with the migrations before 037 applied; `with037` applies 037 too. */
async function freshDb(with037 = true): Promise<Pool> {
  await pool?.end();
  const name = `voice_${++dbIndex}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${name}`;
  pool = quiet(new Pool({ connectionString: url.toString(), max: 4 }));
  for (const f of BEFORE_037) await pool.query(readFileSync(join(sqlDir, f), "utf8"));
  if (with037) await pool.query(MIGRATION_037);
  return pool;
}

/** Owner and one member; the chief-of-staff agent belongs to the owner. */
async function seedPeople(db: Pool): Promise<void> {
  // The baseline seeds every schedule's heartbeat at install time; this fixture installed "an hour ago".
  await db.query(`UPDATE heartbeat SET updated_at = now() - interval '1 hour'`);
  await db.query(`INSERT INTO orgs (id, display_name) VALUES ('org-a', 'Example organisation')`);
  await db.query(`INSERT INTO users (id, display_name, org_id, org_role, status) VALUES
    ('owner-1', 'Owner', 'org-a', 'owner', 'active'), ('member-2', 'Member', 'org-a', 'member', 'active')`);
  await db.query(`INSERT INTO agent_definitions (name, definition, hash, status) VALUES ('chief-of-staff', '{}', 'fixture', 'valid')`);
  await db.query(`INSERT INTO agent_access (agent_name, owner_member_id, organisation_id) VALUES ('chief-of-staff', 'owner-1', 'org-a')`);
}

let tokenSeq = 0;
/** A connected account; with an address, also its stored Google credential. */
async function account(db: Pool, id: string, member: string, address: string | null, connector = "google"): Promise<void> {
  await db.query(`INSERT INTO connected_accounts (id, owner_member_id, connector_id, provider_issuer, provider_subject, provider_label, status)
    VALUES ($1, $2, $3, 'https://accounts.example', $1, 'Example account', 'ok')`, [id, member, connector]);
  if (address === null) return;
  const token = `00000000-0000-4000-8000-${String(++tokenSeq).padStart(12, "0")}`;
  await db.query(`INSERT INTO oauth_tokens (id, principal, provider, org_id, email_address, refresh_token_enc)
    VALUES ($1, $2, $3, 'example-org', $4, 'not-a-token')`, [token, member, connector, address]);
  await db.query(`INSERT INTO connected_account_credentials (account_id, owner_member_id, connector_id, account_generation, oauth_token_id)
    VALUES ($1, $2, $3, 0, $4)`, [id, member, connector, token]);
}

async function card(db: Pool, id: string, fields: Record<string, unknown> = {}): Promise<void> {
  const cols = ["id", ...Object.keys(fields)];
  const vals = [id, ...Object.values(fields)];
  await db.query(`INSERT INTO voice_profile (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
    ON CONFLICT (id) DO UPDATE SET ${cols.slice(1).map((c) => `${c} = EXCLUDED.${c}`).join(", ") || "id = EXCLUDED.id"}`, vals);
}

async function example(db: Pool, mailbox: string, id: string, lang = "en", included = true): Promise<void> {
  await db.query(`INSERT INTO voice_exemplar (id, mailbox, lang, text, vector, source_message_id, included)
    VALUES ($1, $2, $3, $4, '[0.1, 0.2]'::jsonb, $1, $5)`, [id, mailbox, lang, `Example text ${id}`, included]);
}

/** The fixture the brief names: mapped, ambiguous, conflicting-ready, blank, excluded, legacy, running, proposed. */
async function seedVoices(db: Pool): Promise<void> {
  await seedPeople(db);
  await account(db, "acct-owner", "owner-1", "owner@example.invalid");
  await account(db, "acct-member", "member-2", "member@example.invalid");
  await account(db, "acct-shared-1", "owner-1", "shared@example.invalid");
  await account(db, "acct-shared-2", "member-2", "shared@example.invalid");
  await account(db, "acct-case", "member-2", "Case@example.invalid");
  await account(db, "acct-nocred", "owner-1", null);
  await account(db, "acct-spare", "member-2", "spare@example.invalid");
  await card(db, "default", { core: "Owner core.", notes_en: "Owner English.", notes_no: "Eier norsk.", model_en: "model-en-example", model_no: "model-no-example" });
  await card(db, "owner@example.invalid", { core: "Owner mailbox core.", notes_en: "Sign off Best.", learn_status: "running",
    proposed: JSON.stringify({ core: "Proposed", notes_en: "", notes_no: "" }) });
  await card(db, "member@example.invalid", {}); // blank: today it borrows the default card
  await card(db, "shared@example.invalid", { core: "Shared." });
  await card(db, "case@example.invalid", { core: "Case." });
  await card(db, "gone@example.invalid", { core: "Gone.", model_en: "own-model" });
  await example(db, "owner@example.invalid", "o1");
  await example(db, "owner@example.invalid", "o2");
  await example(db, "owner@example.invalid", "o3", "no", false);
  await example(db, "member@example.invalid", "m1");
  await example(db, "gone@example.invalid", "g1");
  await example(db, "legacy:blended", "l1");
  await example(db, "legacy:blended", "l2", "no", false);
}

const decision = (plan: VoiceMappingPlan, mailbox: string) => plan.mailboxes.find((m) => m.mailbox === mailbox)!.decision;
const rows = async (db: Pool, sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

describe("migration 037", () => {
  it("applies to an empty database after every earlier file, re-applies as a no-op, and only adds", async () => {
    const db = await freshDb();
    await db.query(MIGRATION_037);
    const cols = await rows(db, `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND (table_name = 'person_voice_profiles'
        OR (table_name IN ('voice_profile', 'voice_exemplar') AND column_name IN ('owner_member_id', 'connected_account_id', 'mapped_at')))`);
    expect(cols.filter((c) => c.table_name === "person_voice_profiles")).toHaveLength(12);
    expect(cols.filter((c) => c.table_name !== "person_voice_profiles")).toHaveLength(5);
    // The seeded default card is still there and still unlinked.
    expect(await rows(db, `SELECT id, owner_member_id FROM voice_profile`)).toEqual([{ id: "default", owner_member_id: null }]);
    await db.query(`UPDATE voice_profile SET learn_status = 'interrupted' WHERE id = 'default'`);
    await expect(db.query(`UPDATE voice_profile SET learn_status = 'paused' WHERE id = 'default'`)).rejects.toThrow();
  }, 120_000);

  it("leaves existing rows exactly as they were on a database that already has voices", async () => {
    const db = await freshDb(false);
    await seedVoices(db);
    const snapshot = async () => ({
      p: await rows(db, `SELECT id, core, notes_en, notes_no, model_en, model_no, learn_status, proposed, updated_at FROM voice_profile ORDER BY id`),
      e: await rows(db, `SELECT mailbox, id, lang, text, vector, included, created_at FROM voice_exemplar ORDER BY mailbox, id`),
    });
    const before = await snapshot();
    await db.query(MIGRATION_037);
    expect(await snapshot()).toEqual(before);
    expect(await rows(db, `SELECT count(*)::int AS n FROM voice_profile WHERE owner_member_id IS NOT NULL OR connected_account_id IS NOT NULL`)).toEqual([{ n: 0 }]);
    expect(await rows(db, `SELECT count(*)::int AS n FROM person_voice_profiles`)).toEqual([{ n: 0 }]);
  }, 120_000);

  it("keeps a card held, not lost, when its account is removed, and one account has one mailbox card", async () => {
    const db = await freshDb();
    await seedPeople(db);
    await account(db, "acct-a", "member-2", "a@example.invalid");
    await card(db, "a@example.invalid", { core: "A.", owner_member_id: "member-2", connected_account_id: "acct-a" });
    await expect(card(db, "b@example.invalid", { owner_member_id: "member-2", connected_account_id: "acct-a" })).rejects.toThrow();
    await expect(card(db, "c@example.invalid", { owner_member_id: "owner-1", connected_account_id: "acct-a" })).rejects.toThrow(); // another member's account
    await expect(db.query(`UPDATE voice_profile SET connected_account_id = 'acct-a', owner_member_id = 'member-2' WHERE id = 'default'`)).rejects.toThrow();
    await db.query(`DELETE FROM connected_accounts WHERE id = 'acct-a'`);
    expect(await rows(db, `SELECT owner_member_id, connected_account_id, core FROM voice_profile WHERE id = 'a@example.invalid'`))
      .toEqual([{ owner_member_id: "member-2", connected_account_id: null, core: "A." }]);
    // Removing the member removes their linked card (and, by the same key, their profile).
    await db.query(`INSERT INTO person_voice_profiles (owner_member_id, created_from) VALUES ('member-2', 'console')`);
    await db.query(`DELETE FROM users WHERE id = 'member-2'`);
    expect(await rows(db, `SELECT id FROM voice_profile WHERE id = 'a@example.invalid'`)).toEqual([]);
    expect(await rows(db, `SELECT owner_member_id FROM person_voice_profiles`)).toEqual([]);
  }, 120_000);
});

describe("the mapping report and apply", () => {
  beforeEach(async () => { await seedVoices(await freshDb()); }, 120_000);

  it("reports every case in plain words and changes nothing", async () => {
    const before = await rows(pool, `SELECT * FROM voice_profile ORDER BY id`);
    const plan = await dryRunVoiceMapping(pool);
    expect(decision(plan, "owner@example.invalid")).toMatchObject({ kind: "linked", memberId: "owner-1", accountId: "acct-owner", how: "address" });
    expect(decision(plan, "member@example.invalid")).toMatchObject({ kind: "linked", memberId: "member-2", accountId: "acct-member" });
    expect(decision(plan, "shared@example.invalid")).toMatchObject({ kind: "held", reason: expect.stringMatching(/^2 connected accounts have exactly this address/) });
    expect(decision(plan, "case@example.invalid")).toMatchObject({ kind: "held", reason: expect.stringMatching(/only when capital and small letters are treated as the same \(account acct-case\)/) });
    expect(decision(plan, "gone@example.invalid")).toMatchObject({ kind: "held", reason: expect.stringMatching(/^No connected account in Lares has this address/) });
    expect(plan.mailboxes.map((m) => m.mailbox)).not.toContain("legacy:blended");
    expect(plan.counts).toMatchObject({ cards: 6, mailboxCards: 5, examples: 7, legacyBlended: 2, unlinkedCards: 5, unlinkedExamples: 5, profiles: 0 });
    expect(plan.defaultCard).toMatchObject({ copyTo: "owner-1" });
    expect(plan.running).toEqual(["owner@example.invalid"]);
    expect(plan.blocking).toEqual([]);
    const owner = plan.mailboxes.find((m) => m.mailbox === "owner@example.invalid")!;
    expect(owner.toLink).toEqual({ card: true, examples: 3 });
    expect(owner.examples).toEqual([{ lang: "en", included: 2, excluded: 0 }, { lang: "no", included: 0, excluded: 1 }]);
    expect(owner.voices[0]!.line).toMatch(/^English: its own card, unchanged/);
    // The blank member card borrows the owner's default card today; with profiles it would not.
    const member = plan.mailboxes.find((m) => m.mailbox === "member@example.invalid")!;
    expect(member.voices[0]!.line).toBe("English: today the shared default card; once agents read person profiles, no voice (member-2 has no profile text): different text.");

    const text = renderVoiceMappingReport(plan, "dry-run");
    expect(text).toContain("This is a report only. Nothing was changed.");
    expect(text).toContain("Not linked to an account yet: 5 mailbox cards and 5 examples (old blended examples not counted).");
    expect(text).toContain("Held, not linked: No connected account in Lares has this address.");
    expect(text).toContain("A learned card is waiting for review. It stays waiting.");
    expect(text).toContain("A learn is marked as running. It would be marked interrupted and is not restarted.");
    expect(text).toContain("Its card names its own model choices.");
    expect(text).toContain("2 mailboxes linked or to be linked, 3 held, 0 problems.");
    expect(await rows(pool, `SELECT * FROM voice_profile ORDER BY id`)).toEqual(before);
    expect(await rows(pool, `SELECT count(*)::int AS n FROM person_voice_profiles`)).toEqual([{ n: 0 }]);
  });

  it("applies: links the matched mailboxes, copies the default card, marks the running learn interrupted, and keeps everything else", async () => {
    const outcome = await applyVoiceMapping(pool);
    expect(outcome).toMatchObject({ kind: "applied", linkedCards: 2, linkedExamples: 4, profileCreated: true, interrupted: 1 });
    expect(await rows(pool, `SELECT id, owner_member_id, connected_account_id, learn_status, proposed IS NOT NULL AS proposed FROM voice_profile ORDER BY id`)).toEqual([
      { id: "case@example.invalid", owner_member_id: null, connected_account_id: null, learn_status: "idle", proposed: false },
      { id: "default", owner_member_id: null, connected_account_id: null, learn_status: "idle", proposed: false },
      { id: "gone@example.invalid", owner_member_id: null, connected_account_id: null, learn_status: "idle", proposed: false },
      { id: "member@example.invalid", owner_member_id: "member-2", connected_account_id: "acct-member", learn_status: "idle", proposed: false },
      { id: "owner@example.invalid", owner_member_id: "owner-1", connected_account_id: "acct-owner", learn_status: "interrupted", proposed: true },
      { id: "shared@example.invalid", owner_member_id: null, connected_account_id: null, learn_status: "idle", proposed: false },
    ]);
    expect(await rows(pool, `SELECT mailbox, id, included, owner_member_id FROM voice_exemplar ORDER BY mailbox, id`)).toEqual([
      { mailbox: "gone@example.invalid", id: "g1", included: true, owner_member_id: null },
      { mailbox: "legacy:blended", id: "l1", included: true, owner_member_id: null },
      { mailbox: "legacy:blended", id: "l2", included: false, owner_member_id: null },
      { mailbox: "member@example.invalid", id: "m1", included: true, owner_member_id: "member-2" },
      { mailbox: "owner@example.invalid", id: "o1", included: true, owner_member_id: "owner-1" },
      { mailbox: "owner@example.invalid", id: "o2", included: true, owner_member_id: "owner-1" },
      { mailbox: "owner@example.invalid", id: "o3", included: false, owner_member_id: "owner-1" },
    ]);
    expect(await rows(pool, `SELECT owner_member_id, revision, core, notes_en, notes_no, model_en, model_no, created_from, avoid FROM person_voice_profiles`)).toEqual([
      { owner_member_id: "owner-1", revision: 1, core: "Owner core.", notes_en: "Owner English.", notes_no: "Eier norsk.", model_en: "model-en-example", model_no: "model-no-example", created_from: "mapping", avoid: [] },
    ]);
    if (outcome.kind === "applied") expect(renderVoiceMappingReport(outcome.plan, "applied")).toContain("Done. The changes below were made together, in one go, and checked afterwards.");
  });

  it("is safe to run again, and links examples learned since", async () => {
    await applyVoiceMapping(pool);
    expect(await applyVoiceMapping(pool)).toMatchObject({ kind: "applied", linkedCards: 0, linkedExamples: 0, profileCreated: false, interrupted: 0 });
    await example(pool, "owner@example.invalid", "o4");
    const plan = await dryRunVoiceMapping(pool);
    expect(decision(plan, "owner@example.invalid")).toMatchObject({ kind: "linked", how: "before" });
    expect(plan.counts.unlinkedExamples).toBe(2); // o4, and the held mailbox gone@example.invalid
    expect(plan.defaultCard.line).toBe("owner-1 already has a profile. It is left as it is; the shared default card is not copied again.");
    expect(await applyVoiceMapping(pool)).toMatchObject({ kind: "applied", linkedExamples: 1 });
    expect(await rows(pool, `SELECT owner_member_id FROM voice_exemplar WHERE id = 'o4'`)).toEqual([{ owner_member_id: "owner-1" }]);
  });

  it("links a held mailbox the owner names with --map, and refuses an account that cannot be a mailbox", async () => {
    let plan = await dryRunVoiceMapping(pool, { maps: [{ mailbox: "shared@example.invalid", accountId: "acct-shared-2" }, { mailbox: "gone@example.invalid", accountId: "acct-spare" }] });
    expect(decision(plan, "shared@example.invalid")).toMatchObject({ kind: "linked", memberId: "member-2", accountId: "acct-shared-2", how: "map" });
    expect(decision(plan, "gone@example.invalid")).toMatchObject({ kind: "linked", how: "map",
      note: "The account's stored Google address is spare@example.invalid, not gone@example.invalid; it is linked because you asked." });
    expect(plan.blocking).toEqual([]);

    plan = await dryRunVoiceMapping(pool, { maps: [{ mailbox: "gone@example.invalid", accountId: "acct-nocred" }] });
    expect(plan.blocking).toEqual(["gone@example.invalid: You asked to link it to account acct-nocred, but that account has no Google sign-in stored in Lares, so it cannot be a mailbox."]);
    plan = await dryRunVoiceMapping(pool, { maps: [{ mailbox: "gone@example.invalid", accountId: "acct-missing" }] });
    expect(plan.blocking).toEqual(["gone@example.invalid: You asked to link it to account acct-missing, but Lares has no connected account with that id."]);

    // Two mailboxes on one account: both are problems, and --apply is refused with nothing changed.
    const outcome = await applyVoiceMapping(pool, { maps: [{ mailbox: "gone@example.invalid", accountId: "acct-member" }] });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(decision(outcome.plan, "member@example.invalid")).toMatchObject({ kind: "conflict", reason: "It and gone@example.invalid would both be linked to account acct-member. One account has one mailbox card." });
      expect(renderVoiceMappingReport(outcome.plan, "refused")).toContain("Nothing was changed. --apply was refused");
    }
    expect(await rows(pool, `SELECT count(*)::int AS n FROM voice_profile WHERE owner_member_id IS NOT NULL`)).toEqual([{ n: 0 }]);
    expect(await rows(pool, `SELECT learn_status FROM voice_profile WHERE id = 'owner@example.invalid'`)).toEqual([{ learn_status: "running" }]);

    await expect(dryRunVoiceMapping(pool, { maps: [{ mailbox: "nobody@example.invalid", accountId: "acct-member" }] })).rejects.toBeInstanceOf(VoiceMappingUsageError);
    expect(() => parseMapArgument("no-equals-sign")).toThrow(VoiceMappingUsageError);
    expect(parseMapArgument("a=b@example.invalid=acct-1")).toEqual({ mailbox: "a=b@example.invalid", accountId: "acct-1" });
  });

  it("does not move a linked mailbox", async () => {
    await applyVoiceMapping(pool);
    const plan = await dryRunVoiceMapping(pool, { maps: [{ mailbox: "owner@example.invalid", accountId: "acct-spare" }] });
    expect(plan.blocking).toEqual(["owner@example.invalid: You asked to link it to account acct-spare, but it is already linked to account acct-owner. This command does not move a linked mailbox."]);
  });

  it("gives the default card to the one active owner, holds it otherwise, and takes --default-owner for the held case", async () => {
    // The learn settings name an agent nobody has: that no longer matters (nothing keeps that column current).
    await pool.query(`UPDATE voice_profile SET learn_key = 'missing-agent' WHERE id = 'default'`);
    let plan = await dryRunVoiceMapping(pool);
    expect(plan.defaultCard).toEqual({ present: true, copyTo: "owner-1",
      line: "The shared default card (its text and its English and Norwegian model choices) is copied into a new profile for the installation owner, owner-1." });

    await pool.query(`INSERT INTO orgs (id, display_name) VALUES ('org-b', 'Second organisation')`);
    await pool.query(`INSERT INTO users (id, display_name, org_id, org_role, status) VALUES ('owner-b', 'Second owner', 'org-b', 'owner', 'active')`);
    plan = await dryRunVoiceMapping(pool);
    expect(plan.defaultCard).toEqual({ present: true, copyTo: null,
      line: "Held: there are 2 active installation owners (owner-1, owner-b), so it is not clear whose the shared default card is. To give it to one of them, add --default-owner <member id>." });
    // With the default card held, a mailbox whose card is blank has no common card to fall back on.
    expect(plan.mailboxes.find((m) => m.mailbox === "member@example.invalid")!.voices[0]!.line).toMatch(/different text/);
    expect(plan.blocking).toEqual([]);

    plan = await dryRunVoiceMapping(pool, { defaultOwner: "member-2" });
    expect(plan.defaultCard.line).toBe("Held: you named member-2 with --default-owner, but member-2 is not an active member with the owner role.");
    expect(plan.blocking).toEqual(["--default-owner: member-2 is not an active member with the owner role, so the shared default card cannot be given to them."]);
    expect((await applyVoiceMapping(pool, { defaultOwner: "nobody" })).kind).toBe("refused");
    expect(await rows(pool, `SELECT count(*)::int AS n FROM person_voice_profiles`)).toEqual([{ n: 0 }]);

    const outcome = await applyVoiceMapping(pool, { defaultOwner: "owner-b" });
    expect(outcome).toMatchObject({ kind: "applied", profileCreated: true });
    if (outcome.kind === "applied") expect(outcome.plan.defaultCard.line).toBe("The shared default card (its text and its English and Norwegian model choices) is copied into a new profile for the installation owner you named with --default-owner, owner-b.");
    expect(await rows(pool, `SELECT owner_member_id, core FROM person_voice_profiles`)).toEqual([{ owner_member_id: "owner-b", core: "Owner core." }]);

  });

  it("holds the default card when there is no active owner", async () => {
    await pool.query(`ALTER TABLE users DISABLE TRIGGER USER`);
    await pool.query(`UPDATE users SET status = 'removed' WHERE id = 'owner-1'`);
    await pool.query(`ALTER TABLE users ENABLE TRIGGER USER`);
    const plan = await dryRunVoiceMapping(pool);
    expect(plan.defaultCard.line).toBe("Held: no active installation owner was found, so the shared default card was not given to anyone.");
  });

  it("marks a running learn interrupted even while the agent's schedule is checking in, and says why that is safe", async () => {
    await pool.query(`INSERT INTO heartbeat (agent, updated_at) VALUES ('chief-of-staff/voice-learn/tick', now())
      ON CONFLICT (agent) DO UPDATE SET updated_at = now()`);
    const plan = await dryRunVoiceMapping(pool);
    expect(plan.blocking).toEqual([]);
    expect(renderVoiceMappingReport(plan, "dry-run")).toContain("An agent's voice-learning schedule checked in during the last five minutes. It does that every minute while the agent runs, so a learn marked as running may really be in progress, or may be left over from a learn that was cut off (for example by a restart). Marking it interrupted is safe either way: a learn that is really in progress writes its own status again when it finishes or fails.");
    expect(await applyVoiceMapping(pool)).toMatchObject({ kind: "applied", interrupted: 1 });
    expect(await rows(pool, `SELECT learn_status FROM voice_profile WHERE id = 'owner@example.invalid'`)).toEqual([{ learn_status: "interrupted" }]);
  });

  it("matches by address only Google accounts, and never treats a mailbox named default as a mailbox", async () => {
    await account(pool, "acct-other", "member-2", "gone@example.invalid", "other-provider");
    await example(pool, "default", "d1");
    const plan = await dryRunVoiceMapping(pool);
    expect(decision(plan, "gone@example.invalid")).toMatchObject({ kind: "held", reason: expect.stringMatching(/^No connected account in Lares has this address/) });
    expect(plan.mailboxes.map((m) => m.mailbox)).not.toContain("default");
    expect((await applyVoiceMapping(pool)).kind).toBe("applied");
    expect(await rows(pool, `SELECT owner_member_id FROM voice_exemplar WHERE mailbox = 'default'`)).toEqual([{ owner_member_id: null }]);
  });

  it("undoes everything when the check after the changes does not match", async () => {
    // A stand-in for anything else changing a row during the run: it edits the text as the link is written.
    await pool.query(`CREATE FUNCTION voice_tamper() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.text := NEW.text || ' (changed)'; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER voice_tamper BEFORE UPDATE ON voice_exemplar FOR EACH ROW EXECUTE FUNCTION voice_tamper()`);
    const outcome = await applyVoiceMapping(pool);
    expect(outcome).toEqual({ kind: "failed", reason: "The check after the changes did not match (the writing examples changed in a way this command does not make), so they were all undone." });
    expect(await rows(pool, `SELECT count(*)::int AS n FROM voice_exemplar WHERE owner_member_id IS NOT NULL OR text LIKE '%(changed)'`)).toEqual([{ n: 0 }]);
    expect(await rows(pool, `SELECT count(*)::int AS n FROM person_voice_profiles`)).toEqual([{ n: 0 }]);
    expect(await rows(pool, `SELECT learn_status FROM voice_profile WHERE id = 'owner@example.invalid'`)).toEqual([{ learn_status: "running" }]);
  });
});

describe("a run that collides with another write", () => {
  it("says to run the same command again", async () => {
    const collision = Object.assign(new Error("could not serialize access due to concurrent update"), { code: "40001" });
    const fakePool = { connect: async () => ({ query: async (sql: string) => { if (sql.startsWith("BEGIN")) throw collision; return { rows: [] }; }, release: () => undefined }) } as unknown as Pool;
    expect(await applyVoiceMapping(fakePool)).toEqual({ kind: "failed",
      reason: "The database stopped the run (could not serialize access due to concurrent update), so nothing was changed. Something else wrote to the voice data at the same moment; run the same command again." });
  });
});

describe("the command", () => {
  const run = async (argv: string[], db?: Pool) => {
    const out: string[] = [], error: string[] = [];
    const code = await main(argv, { db, out: (s) => out.push(s), error: (s) => error.push(s) });
    return { code, out: out.join("\n"), error: error.join("\n") };
  };

  it("refuses bad usage before touching the database", async () => {
    expect(await run(["--surprise"])).toMatchObject({ code: 64, error: "voices map: I do not know the option --surprise. Nothing was changed." });
    expect((await run(["--map"])).code).toBe(64);
    expect((await run(["--map", "nothing"])).code).toBe(64);
    expect(await run(["--default-owner"])).toMatchObject({ code: 64, error: "voices map: --default-owner needs a member id. Nothing was changed." });
    expect(await run(["--default-owner", "a", "--default-owner", "b"])).toMatchObject({ code: 64, error: "voices map: --default-owner can name only one member. Nothing was changed." });
    expect((await run(["--help"])).out).toContain("lares voices map [--apply]");
  });

  it("says plainly when the update that adds profiles has not been applied", async () => {
    const db = await freshDb(false);
    expect(await run([], db)).toEqual({ code: 78, out: "", error: "voices map: This database does not have person voice profiles yet: the update that adds them (037_person_voice_profiles.sql) has not been applied. Update Lares first. Nothing was changed." });
  }, 120_000);

  it("reports by default, applies with --apply, and returns 78 when refused", async () => {
    await seedVoices(await freshDb());
    const report = await run([], pool);
    expect(report.code).toBe(0);
    expect(report.out).toContain("This is a report only. Nothing was changed.");
    expect((await run(["--map", "nobody@example.invalid=acct-1"], pool))).toMatchObject({ code: 64,
      error: "voices map: --map names nobody@example.invalid, but no voice card or examples are filed under that mailbox. Nothing was changed." });
    expect((await run(["--apply", "--map", "gone@example.invalid=acct-member"], pool)).code).toBe(78);
    const applied = await run(["--apply"], pool);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain("Done.");
  }, 120_000);
});
