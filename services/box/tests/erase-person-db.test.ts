// services/box/tests/erase-person-db.test.ts — erase a person from every table that
// names them, or erase nothing.
//
// WHY THIS FILE IS THE PROOF AND NOT THE README. "Everything was erased" is the one claim in this
// system that cannot be checked by reading: the failure mode is a table nobody listed, reported as
// success. So the central test below does not name the tables it checks — it walks
// `lib/member-scope.ts` and the fixture's own seed list, and asserts that AFTER the erase not one
// row anywhere answers to ANY spelling the owner ever had, while every row belonging to the second
// fixture person is untouched. A member table added to the inventory later fails here the moment
// it lands.
//
// The fixture (tests/helpers/three-spellings.ts) applies every services/box/sql file (standing_facts
// and the dream schema included) to a disposable
// Postgres, and seeds two fictional people whose rows use all four id conventions. Nothing here
// ever touches a real installation.
//
// ONE THING THE FIXTURE DOES NOT SEED, and why this file seeds it itself: `memory_proposals` has
// no person column at all, so it has no `(table, column, value)` shape to add to the fixture's
// SEED_ROWS. The two rows it needs — a supersede proposal naming a standing fact of the owner's,
// and an `add` proposal that names no existing row at all — are written here, next to the
// assertion about them.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool,type PoolClient} from 'pg';
import {
  startThreeSpellingsDb,
  seedThreeSpellingsFinancial,
  FIXTURE_OWNER,
  FIXTURE_SECOND,
  FIXTURE_ROWS,
  type TestDb,
} from "./helpers/three-spellings.js";
import { MEMBER_SCOPE } from "../lib/member-scope.js";
import { resolvePerson, spellingsFor } from "../lib/person-identity.js";
import {runErase} from '../lib/run-erase.js';
import {HostFinancialJournal} from '../../keeper/lib/financial-journal.js';
import {provisionEngineDatabasePrivileges} from '../lib/database-privileges.js';
import {observeFinancialDatabase} from '../../keeper/lib/financial-continuity.js';
import {platformTestJournalLock,testJournalUid} from '../../keeper/tests/helpers/financial-journal.js';
import {
  erasePerson,
  renderEraseReport,
  eraseHandlingFor,
  ERASE_OUTSTANDING,
  type EraseReport,
} from "../lib/erase-person.js";

// A fresh container per test: three of these tests drop a table or delete a person, and a shared
// database would make the order of the file matter.
let db: TestDb;
let journal:HostFinancialJournal;
let financial:Pool|undefined;
let outsideCustody:Pool|undefined;
let custody:string;
let custodyParent:string;
let vaultRoot:string;
beforeEach(async () => {
  // Legacy rows have no provisioned storage. Owned-area refusal is tested separately.
  db = await startThreeSpellingsDb({vaultAreas:false,financial:false});
  custodyParent=mkdtempSync(join(realpathSync(tmpdir()),'erase-person-db-journal-'));custody=join(custodyParent,'custody');
  const preparation=HostFinancialJournal.prepareFresh(custody,await observeFinancialDatabase(db.pool),{ownershipUid:testJournalUid,lock:platformTestJournalLock});
  try{preparation.complete();}finally{preparation.close();}
  journal=HostFinancialJournal.openExisting(custody,{ownershipUid:testJournalUid,lock:platformTestJournalLock,requirePrepared:true});
  await seedThreeSpellingsFinancial(db.pool,journal);
  vaultRoot=mkdtempSync(join(tmpdir(),'erase-person-db-vault-'));mkdirSync(join(vaultRoot,'people'));
  writeFileSync(join(vaultRoot,'people/vera.md'),'---\nowner: fixture-owner\n---\nA disposable note.\n');
  execFileSync('git',['-C',vaultRoot,'init','-q']);execFileSync('git',['-C',vaultRoot,'config','user.name','Fixture Operator']);
  execFileSync('git',['-C',vaultRoot,'config','user.email','fixture@example.invalid']);execFileSync('git',['-C',vaultRoot,'add','-A']);
  execFileSync('git',['-C',vaultRoot,'commit','-q','-m','before erase']);
}, 180_000);
afterEach(async () => {
  await outsideCustody?.end();outsideCustody=undefined;
  await financial?.end();financial=undefined;
  journal?.close();
  await db.stop();
  if(custodyParent)rmSync(custodyParent,{recursive:true,force:true});
  if(vaultRoot)rmSync(vaultRoot,{recursive:true,force:true});
});

async function journaledErase(person:string,includeVault=false,pool:Pool=db.pool):Promise<EraseReport>{
  const result=await runErase({db:pool,person,vaults:includeVault?[vaultRoot]:[],apply:true,journal});
  return result.dbReport;
}

async function financialLogin(options?:string):Promise<Pool>{
  const operator=await db.pool.connect();
  try{
    await provisionEngineDatabasePrivileges(operator,{expectedDatabase:new URL(db.connectionString).pathname.slice(1),passwords:{
      application:Buffer.from('r5-app-test-password-0123456789abcd'),
      financial:Buffer.from('r5-financial-test-password-0123456789'),
      outsideCustody:Buffer.from('r5-outside-test-password-0123456789'),
    }});
  }finally{operator.release();}
  const connection=new URL(db.connectionString);connection.username='lares_financial';connection.password='r5-financial-test-password-0123456789';
  financial=new Pool({connectionString:connection.toString(),max:4,...(options?{options}:{})});
  return financial;
}

async function outsideCustodyLogin():Promise<Pool>{
  const connection=new URL(db.connectionString);connection.username='lares_outside_custody';connection.password='r5-outside-test-password-0123456789';
  outsideCustody=new Pool({connectionString:connection.toString(),max:2});
  return outsideCustody;
}

async function waitForLockWait(queryFragment:string):Promise<number>{
  for(let attempt=0;attempt<100;attempt++){
    const result=await db.pool.query<{pid:number}>(`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND usename='lares_financial' AND state='active'
        AND wait_event_type='Lock' AND query LIKE $1`,[`%${queryFragment}%`]);
    if(result.rows[0])return result.rows[0].pid;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error(`Timed out waiting for the financial session to block on ${queryFragment}`);
}

async function seedR5Members(input:{orgA?:string;orgB?:string}={}):Promise<void>{
  const orgA=input.orgA??'r5-org-a',orgB=input.orgB??orgA;
  if(!await db.pool.query("SELECT 1 FROM orgs WHERE id=$1",[orgA]).then(result=>result.rowCount))await db.pool.query("INSERT INTO orgs(id,display_name) VALUES($1,'R5 A')",[orgA]);
  if(orgB!==orgA)await db.pool.query("INSERT INTO orgs(id,display_name) VALUES($1,'R5 B')",[orgB]);
  await db.pool.query(`INSERT INTO users(id,display_name,org_id,org_role,status) VALUES
    ('r5-a','R5 A',$1,'owner','active'),('r5-b','R5 B',$2,'member','active'),('r5-c','R5 C',$1,'owner','active')`,[orgA,orgB]);
}

async function seedR5Agent(agent:string,owner:string,org:string):Promise<void>{
  await db.pool.query("INSERT INTO agent_definitions(name,definition,hash) VALUES($1,'{\"grants\":[]}'::jsonb,repeat('a',64))",[agent]);
  await db.pool.query("INSERT INTO agent_access(agent_name,owner_member_id,organisation_id) VALUES($1,$2,$3)",[agent,owner,org]);
}

async function seedR5Custody(input:{owner:string;resource:string;id:string;state?:'active'|'revoked';withRevision?:boolean}):Promise<void>{
  const state=input.state??'active',withRevision=input.withRevision??true;
  await db.pool.query(`INSERT INTO outside_custody_accounts(account_id,owner_member_id,resource_id,generation,active_revision,candidate_revision,consent_generation,state)
    VALUES($1,$2,$3,1,$4,NULL,1,$5)`,[input.id,input.owner,input.resource,state==='active'&&withRevision?1:null,state]);
  if(!withRevision)return;
  const operationId=`${input.id.slice(0,8)}-1111-4111-8111-${input.id.slice(-12)}`;
  await db.pool.query(`INSERT INTO outside_custody_revisions(account_id,owner_member_id,credential_revision,generation,consent_generation,operation_id,nonce,ciphertext)
    VALUES($1,$2,1,1,1,$3,$4,$5)`,[input.id,input.owner,operationId,Buffer.alloc(12,7),Buffer.alloc(24,9)]);
  await db.pool.query(`INSERT INTO outside_custody_operations(operation_id,account_id,owner_member_id,operation_kind,request_hash,expected_generation,result_generation,credential_revision,outcome)
    VALUES($1,$2,$3,'stage',$4,0,1,1,'staged')`,[operationId,input.id,input.owner,Buffer.alloc(32,5)]);
}

async function fixtureCustodySnapshot():Promise<{
  accounts:Record<string,unknown>[];
  revisions:Record<string,unknown>[];
  operations:Record<string,unknown>[];
}>{
  const owners=[FIXTURE_OWNER,FIXTURE_SECOND];
  const [accounts,revisions,operations]=await Promise.all([
    db.pool.query<Record<string,unknown>>(`SELECT * FROM outside_custody_accounts
      WHERE owner_member_id=ANY($1::text[]) ORDER BY account_id`,[owners]),
    db.pool.query<Record<string,unknown>>(`SELECT * FROM outside_custody_revisions
      WHERE owner_member_id=ANY($1::text[]) ORDER BY account_id,credential_revision`,[owners]),
    db.pool.query<Record<string,unknown>>(`SELECT * FROM outside_custody_operations
      WHERE owner_member_id=ANY($1::text[]) ORDER BY operation_id`,[owners]),
  ]);
  return {accounts:accounts.rows,revisions:revisions.rows,operations:operations.rows};
}

async function addVaultNote(owner:string,name:string):Promise<string>{
  const path=join(vaultRoot,'people',name);
  writeFileSync(path,`---\nowner: ${owner}\n---\nA disposable R5 note.\n`);
  execFileSync('git',['-C',vaultRoot,'add',join('people',name)]);
  execFileSync('git',['-C',vaultRoot,'commit','-q','-m',`add ${name}`]);
  return path;
}

/** A supersede proposal that can only be reached through an id resolved before its owning row
 *  goes, and an `add` proposal that names no existing row at all. */
async function seedMemoryProposals(): Promise<void> {
  const { rows } = await db.pool.query<{ id: string }>(
    "SELECT id::text AS id FROM standing_facts WHERE user_id = $1",
    [FIXTURE_OWNER],
  );
  expect(rows.length).toBeGreaterThan(0);
  await db.pool.query(
    `INSERT INTO memory_proposals (action, existing_id, existing_text, proposed_text, origin, source)
     VALUES ('supersede', $1, 'Fixture said something', 'Fixture says something else', 'owner', 'dream')`,
    [rows[0]!.id],
  );
  await db.pool.query(
    `INSERT INTO memory_proposals
       (action, existing_id, existing_text, proposed_text, origin, source, ref, kind)
     VALUES ('add', '', '', 'An inference nobody has confirmed', 'agent', 'dream',
             'identity-fixturehash', 'preference')`,
  );
}

describe("erase-person — the database half", () => {
  it("deletes every member row for that person, under every spelling, and nobody else's", async () => {
    const owner = await resolvePerson(db.pool, FIXTURE_OWNER);
    const second = await resolvePerson(db.pool, FIXTURE_SECOND);

    const report = await journaledErase(FIXTURE_OWNER);
    expect(report.refusals).toEqual([]);
    expect(report.deleted.length).toBeGreaterThan(0);

    // Every member table in the inventory, walked against the schema itself.
    for (const entry of MEMBER_SCOPE.filter((t) => t.scope === "member")) {
      const spellings = spellingsFor(owner, entry.idKind!);
      const { rows } = await db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${entry.table} WHERE ${entry.column} = ANY($1::text[])`,
        [spellings],
      );
      if (entry.idKind === "actor") {
        // D6: an audit row is kept; only the name goes.
        expect(rows[0]!.n, `${entry.table} still names the erased person`).toBe(0);
        const still = await db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${entry.table} WHERE ${entry.column} = 'erased'`,
        );
        expect(still.rows[0]!.n, `${entry.table} lost the audit row instead of the name`)
          .toBeGreaterThan(0);
      } else {
        expect(rows[0]!.n, `${entry.table} still holds a row of the erased person's`).toBe(0);
      }
    }

    // And the second fixture person is untouched, everywhere the fixture put a row of theirs.
    const secondSpellings = new Set(second.spellings);
    for (const seeded of FIXTURE_ROWS.filter((r) => secondSpellings.has(r.value))) {
      const { rows } = await db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${seeded.table} WHERE ${seeded.column} = $1`,
        [seeded.value],
      );
      expect(rows[0]!.n, `${seeded.table} lost the other person's row`).toBeGreaterThan(0);
    }
  }, 240_000);

  it("reaches memory_proposals through the ids it resolved, before those ids are deleted", async () => {
    await seedMemoryProposals();

    const report = await journaledErase(FIXTURE_OWNER);
    expect(report.refusals).toEqual([]);

    const supersedes = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memory_proposals WHERE action <> 'add'",
    );
    expect(supersedes.rows[0]!.n).toBe(0);

    // The `add` row names no existing row and no person: it is NOT deleted, it is stated.
    const adds = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memory_proposals WHERE action = 'add'",
    );
    expect(adds.rows[0]!.n).toBe(1);
    expect(report.outstanding.join("\n")).toMatch(/inference the agent suggested/i);
  }, 240_000);

  it("a dry run writes nothing, counts everything, and issues only read-only statements", async () => {
    const statements: string[] = [];
    const realQuery = db.pool.query.bind(db.pool);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.pool as any).query = (text: any, values?: any) => {
      if (typeof text === "string") statements.push(text);
      return realQuery(text, values);
    };

    let report: EraseReport;
    try {
      report = await erasePerson(db.pool, { person: FIXTURE_OWNER, dryRun: true });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db.pool as any).query = realQuery;
    }

    expect(report.dryRun).toBe(true);
    expect(report.refusals).toEqual([]);
    expect(report.planned.reduce((n, p) => n + p.rows, 0)).toBeGreaterThan(0);
    expect(report.deleted).toEqual([]);

    const notReadOnly = statements.filter((s) => !/^\s*(SELECT|WITH)\b/i.test(s));
    expect(notReadOnly, "a dry run issued a statement that is not a plain read").toEqual([]);

    const left = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM conversation_entries WHERE person_key = $1",
      [FIXTURE_OWNER],
    );
    expect(left.rows[0]!.n).toBeGreaterThan(0);
  }, 240_000);

  it("refuses entirely rather than erasing part of a person", async () => {
    await db.pool.query("DROP TABLE memory_reads");

    const report = await journaledErase(FIXTURE_OWNER);
    expect(report.refusals.join("\n")).toContain("memory_reads");
    expect(report.refusals.join("\n")).toContain("001_baseline.sql");
    expect(report.deleted).toEqual([]);

    const left = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM conversation_entries WHERE person_key = $1",
      [FIXTURE_OWNER],
    );
    expect(left.rows[0]!.n).toBeGreaterThan(0);
    const facts = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM standing_facts WHERE user_id = $1",
      [FIXTURE_OWNER],
    );
    expect(facts.rows[0]!.n).toBeGreaterThan(0);
  }, 240_000);

  it("refuses a name nobody answers to, and anyone who is not a member of this installation", async () => {
    const unknown = await journaledErase("nobody-at-all");
    expect(unknown.refusals.length).toBe(1);
    expect(unknown.refusals[0]).toMatch(/nobody in the identity register/i);
    expect(unknown.deleted).toEqual([]);

    // A third party a note is merely ABOUT is not a member.
    await db.pool.query(
      `INSERT INTO standing_facts (fact, category, source_turn, user_id, origin)
       VALUES ('A note about someone else', 'preference', 'fixture-turn-3', 'a-third-party', 'owner')`,
    );
    const stranger = await journaledErase("a-third-party");
    expect(stranger.refusals.length).toBe(1);
    expect(stranger.deleted).toEqual([]);
    const still = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM standing_facts WHERE user_id = 'a-third-party'",
    );
    expect(still.rows[0]!.n).toBe(1);
  }, 240_000);

  it("leaves the voice corpus alone while somebody else is still a member, and says so", async () => {
    await db.pool.query(
      `INSERT INTO voice_exemplar (id, lang, text, vector)
       VALUES ('fixture-exemplar-1', 'en', 'a sentence in the voice we learned', '[]'::jsonb)`,
    );

    const shared = await journaledErase(FIXTURE_OWNER);
    expect(shared.refusals).toEqual([]);
    const kept = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM voice_exemplar");
    expect(kept.rows[0]!.n).toBe(1);
    expect(shared.outstanding.join("\n")).toMatch(/learned writing voice/i);

    // Leave exactly one member. (The fixture's schema files seed one installation row of their
    // own besides the two fixture people; this removes whoever is left without naming anybody.)
    await db.pool.query("DELETE FROM users WHERE id <> $1", [FIXTURE_SECOND]);

    // Now the person being erased is the only one left: the corpus is theirs, and goes.
    const alone = await journaledErase(FIXTURE_SECOND);
    expect(alone.refusals).toEqual([]);
    expect(alone.wasOnlyMember).toBe(true);
    const gone = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM voice_exemplar");
    expect(gone.rows[0]!.n).toBe(0);
    expect(renderEraseReport(alone)).toMatch(/no member/i);
  }, 240_000);

  it("knows what to do with every member and resolved table in the inventory", () => {
    const unhandled = MEMBER_SCOPE.filter(
      (t) => (t.scope === "member" || t.scope === "resolved") && eraseHandlingFor(t) === null,
    ).map((t) => t.table);
    expect(
      unhandled,
      "these inventory tables have neither a general path, nor an entry in erase-person.ts's " +
        "handling map, nor a line in what the report states it did not reach",
    ).toEqual([]);
  });

  it("states what it did not reach, every time, including on a clean run", () => {
    const clean: EraseReport = {
      person: FIXTURE_OWNER,
      dryRun: false,
      planned: [],
      deleted: [],
      outstanding: [...ERASE_OUTSTANDING],
      refusals: [],
    };
    const md = renderEraseReport(clean);
    expect(md).toMatch(/still open/i); // eve's own session rows
    expect(md).toMatch(/git history/i);
    expect(md).toMatch(/backup/i);
  });

  it("is written for a person to read: no column names, no jargon", async () => {
    const report = await erasePerson(db.pool, { person: FIXTURE_OWNER, dryRun: true });
    const md = renderEraseReport(report);
    for (const jargon of ["idKind", "person_key", "user_id", "grantor_user_id", "updated_by", "= ANY"]) {
      expect(md, `the report says "${jargon}" at a person who does not read code`).not.toContain(
        jargon,
      );
    }
  }, 240_000);
});

describe("erase-person — the sync-state pass", () => {
  it("clears the sync row for every path the vault pass removed", async () => {
    await db.pool.query(
      `INSERT INTO notion_sync_docs (vault_path, notion_page_id, target, direction)
       VALUES ('people/vera.md', 'p1', 'docs', 'two_way')`,
    );
    await db.pool.query("INSERT INTO atlas_notes (note_path) VALUES ('people/vera.md')");

    const report = await journaledErase(FIXTURE_OWNER,true);
    expect(report.refusals).toEqual([]);

    expect((await db.pool.query("SELECT 1 FROM notion_sync_docs")).rows).toHaveLength(0);
    expect((await db.pool.query("SELECT 1 FROM atlas_notes")).rows).toHaveLength(0);
  }, 240_000);

  it("leaves another file's sync row alone", async () => {
    await db.pool.query(
      `INSERT INTO notion_sync_docs (vault_path, notion_page_id, target, direction)
       VALUES ('people/other.md', 'p2', 'docs', 'two_way')`,
    );
    await db.pool.query("INSERT INTO atlas_notes (note_path) VALUES ('people/other.md')");

    const report = await journaledErase(FIXTURE_OWNER,true);
    expect(report.refusals).toEqual([]);

    expect((await db.pool.query("SELECT 1 FROM notion_sync_docs")).rows).toHaveLength(1);
    expect((await db.pool.query("SELECT 1 FROM atlas_notes")).rows).toHaveLength(1);
  }, 240_000);

  it("clears the proposals holding that path's proposed body", async () => {
    await db.pool.query(
      `INSERT INTO notion_sync_proposals (vault_path, notion_page_id, proposed_body, base_md_hash, notion_hash)
       VALUES ('people/vera.md', 'p1', 'a proposed body', 'hash-a', 'hash-b')`,
    );
    await db.pool.query(
      `INSERT INTO atlas_proposals (note_path, proposed_note, base_body_hash, sources_hash)
       VALUES ('people/vera.md', 'a proposed note', 'hash-a', 'hash-b')`,
    );

    const report = await journaledErase(FIXTURE_OWNER,true);
    expect(report.refusals).toEqual([]);

    expect((await db.pool.query("SELECT 1 FROM notion_sync_proposals")).rows).toHaveLength(0);
    expect((await db.pool.query("SELECT 1 FROM atlas_proposals")).rows).toHaveLength(0);
  }, 240_000);

  it("warns that the sync run watermark now points at a commit this erase moved past", async () => {
    const r = await journaledErase(FIXTURE_OWNER,true);
    expect(r.outstanding.join(" ")).toMatch(/notion_sync_run/);
  }, 240_000);

  it("without paths, leaves the sync tables untouched and still names them in outstanding", async () => {
    await db.pool.query(
      `INSERT INTO notion_sync_docs (vault_path, notion_page_id, target, direction)
       VALUES ('people/vera.md', 'p1', 'docs', 'two_way')`,
    );
    await db.pool.query("INSERT INTO atlas_notes (note_path) VALUES ('people/vera.md')");

    const report = await journaledErase(FIXTURE_OWNER);
    expect(report.refusals).toEqual([]);

    expect((await db.pool.query("SELECT 1 FROM notion_sync_docs")).rows).toHaveLength(1);
    expect((await db.pool.query("SELECT 1 FROM atlas_notes")).rows).toHaveLength(1);
    expect(report.outstanding.join(" ")).toMatch(/Notion/);
    expect(report.outstanding.join(" ")).not.toMatch(/notion_sync_run/);
  }, 240_000);

  it("renders the sync-state rows in the same report sections as everything else", async () => {
    await db.pool.query(
      `INSERT INTO notion_sync_docs (vault_path, notion_page_id, target, direction)
       VALUES ('people/vera.md', 'p1', 'docs', 'two_way')`,
    );
    const report = await erasePerson(db.pool, {
      person: FIXTURE_OWNER,
      dryRun: true,
      paths: ["people/vera.md"],
    });
    const md = renderEraseReport(report);
    expect(md).toContain("notion_sync_docs");
    for (const jargon of ["idKind", "vault_path", "note_path", "= ANY"]) {
      expect(md, `the report says "${jargon}" at a person who does not read code`).not.toContain(
        jargon,
      );
    }
  }, 240_000);
});

describe("erase-person — outside custody owner cascades", () => {
  it("erases only B custody on A's shared agent while retaining A and C", async () => {
    await seedR5Members();
    await seedR5Agent('r5-agent-a','r5-a','r5-org-a');
    await seedR5Custody({owner:'r5-a',resource:'r5-agent-a',id:'10000000-0000-4000-8000-000000000001'});
    await seedR5Custody({owner:'r5-b',resource:'r5-agent-a',id:'10000000-0000-4000-8000-000000000002'});
    const fixtureBefore=await fixtureCustodySnapshot();
    const finance=await financialLogin();

    const report=await journaledErase('r5-b',false,finance);
    expect(report.refusals).toEqual([]);
    expect(report.deleted.filter(row=>row.table.startsWith('outside_custody_'))).toEqual([
      expect.objectContaining({table:'outside_custody_accounts',rows:1}),
      expect.objectContaining({table:'outside_custody_revisions',rows:1}),
      expect.objectContaining({table:'outside_custody_operations',rows:1}),
    ]);
    expect((await db.pool.query("SELECT owner_member_id,resource_id FROM outside_custody_accounts ORDER BY owner_member_id,account_id")).rows)
      .toEqual([
        {owner_member_id:FIXTURE_OWNER,resource_id:'fixture-shared-0'},
        {owner_member_id:FIXTURE_SECOND,resource_id:'fixture-shared-1'},
        {owner_member_id:'r5-a',resource_id:'r5-agent-a'},
      ]);
    expect(await fixtureCustodySnapshot()).toEqual(fixtureBefore);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM outside_custody_revisions WHERE owner_member_id='r5-a'")).rows[0]!.n).toBe(1);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM outside_custody_operations WHERE owner_member_id='r5-a'")).rows[0]!.n).toBe(1);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM users WHERE id IN ('r5-a','r5-c')")).rows[0]!.n).toBe(2);
  },240_000);

  it("allows A's own custody on both its own and a surviving agent to cascade with A", async () => {
    await seedR5Members();
    await seedR5Agent('r5-agent-a','r5-a','r5-org-a');
    await seedR5Agent('r5-agent-b','r5-b','r5-org-a');
    await seedR5Custody({owner:'r5-a',resource:'r5-agent-a',id:'20000000-0000-4000-8000-000000000001'});
    await seedR5Custody({owner:'r5-a',resource:'r5-agent-b',id:'20000000-0000-4000-8000-000000000002'});
    await seedR5Custody({owner:'r5-b',resource:'r5-agent-b',id:'20000000-0000-4000-8000-000000000003'});
    const fixtureBefore=await fixtureCustodySnapshot();
    const finance=await financialLogin();

    const report=await journaledErase('r5-a',false,finance);
    expect(report.refusals).toEqual([]);
    expect(report.deleted.filter(row=>row.table.startsWith('outside_custody_')).map(row=>[row.table,row.rows]))
      .toEqual([['outside_custody_accounts',2],['outside_custody_revisions',2],['outside_custody_operations',2]]);
    expect((await db.pool.query("SELECT owner_member_id,resource_id FROM outside_custody_accounts ORDER BY owner_member_id,account_id")).rows)
      .toEqual([
        {owner_member_id:FIXTURE_OWNER,resource_id:'fixture-shared-0'},
        {owner_member_id:FIXTURE_SECOND,resource_id:'fixture-shared-1'},
        {owner_member_id:'r5-b',resource_id:'r5-agent-b'},
      ]);
    expect(await fixtureCustodySnapshot()).toEqual(fixtureBefore);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM outside_custody_revisions WHERE owner_member_id='r5-b'")).rows[0]!.n).toBe(1);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM outside_custody_operations WHERE owner_member_id='r5-b'")).rows[0]!.n).toBe(1);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM users WHERE id IN ('r5-b','r5-c')")).rows[0]!.n).toBe(2);
  },240_000);

  it("refuses a revoked cross-organisation foreign account before touching vault files", async () => {
    await seedR5Members({orgB:'r5-org-b'});
    await seedR5Agent('r5-agent-a','r5-a','r5-org-a');
    await seedR5Custody({owner:'r5-b',resource:'r5-agent-a',id:'30000000-0000-4000-8000-000000000001',state:'revoked',withRevision:false});
    const fixtureBefore=await fixtureCustodySnapshot();
    const note=await addVaultNote('r5-a','r5-a.md');
    const before=readFileSync(note,'utf8');
    const finance=await financialLogin();

    const result=await runErase({db:finance,person:'r5-a',vaults:[vaultRoot],apply:true,journal});
    expect(result.dbReport.refusals.join('\n')).toMatch(/another member still holds outside credentials/i);
    expect(result.vaults).toEqual([]);
    expect(readFileSync(note,'utf8')).toBe(before);
    expect((await db.pool.query("SELECT owner_member_id,resource_id,state FROM outside_custody_accounts ORDER BY owner_member_id,account_id")).rows)
      .toEqual([
        {owner_member_id:FIXTURE_OWNER,resource_id:'fixture-shared-0',state:'active'},
        {owner_member_id:FIXTURE_SECOND,resource_id:'fixture-shared-1',state:'active'},
        {owner_member_id:'r5-b',resource_id:'r5-agent-a',state:'revoked'},
      ]);
    expect(await fixtureCustodySnapshot()).toEqual(fixtureBefore);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM users WHERE id IN ('r5-a','r5-b','r5-c')")).rows[0]!.n).toBe(3);
  },240_000);

  it("refuses unsupported transaction isolation before any vault file is removed", async () => {
    await seedR5Members();
    const finance=await financialLogin('-c default_transaction_isolation=repeatable\\ read');
    const connection=await finance.connect();
    try{
      expect((await connection.query<{default_transaction_isolation:string}>('SHOW default_transaction_isolation')).rows[0]?.default_transaction_isolation).toBe('repeatable read');
      await connection.query('BEGIN');
      expect((await connection.query<{transaction_isolation:string}>('SHOW transaction_isolation')).rows[0]?.transaction_isolation).toBe('repeatable read');
      await connection.query('ROLLBACK');
    }finally{connection.release();}
    const note=await addVaultNote('r5-a','r5-isolation.md');
    const before=readFileSync(note,'utf8');

    const result=await runErase({db:finance,person:'r5-a',vaults:[vaultRoot],apply:true,journal});
    expect(result.transactionOutcome).toBe('rollback-acknowledged');
    expect(result.dbReport.refusals).toHaveLength(1);
    expect(result.dbReport.refusals[0]).toMatch(/transaction was rolled back/i);
    expect(result.dbReport.deleted).toEqual([]);
    expect(result.vaults).toEqual([]);
    expect(readFileSync(note,'utf8')).toBe(before);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM users WHERE id='r5-a'")).rows[0]!.n).toBe(1);
  },240_000);

  it("refuses a missing custody FK before touching vault files", async () => {
    await seedR5Members();
    const note=await addVaultNote('r5-a','r5-schema-drift.md');
    const before=readFileSync(note,'utf8');
    const finance=await financialLogin();
    await db.pool.query('ALTER TABLE outside_custody_accounts DROP CONSTRAINT outside_custody_accounts_resource_id_fkey');

    const result=await runErase({db:finance,person:'r5-a',vaults:[vaultRoot],apply:true,journal});
    expect(result.dbReport.refusals.join('\n')).toMatch(/expected enforced database shape/i);
    expect(result.vaults).toEqual([]);
    expect(readFileSync(note,'utf8')).toBe(before);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM users WHERE id='r5-a'")).rows[0]!.n).toBe(1);
  },240_000);

  it("refuses a custody FK with the wrong delete action before touching vault files", async () => {
    await seedR5Members();
    const note=await addVaultNote('r5-a','r5-fk-action.md');
    const before=readFileSync(note,'utf8');
    const finance=await financialLogin();
    await db.pool.query('ALTER TABLE outside_custody_accounts DROP CONSTRAINT outside_custody_accounts_resource_id_fkey');
    await db.pool.query(`ALTER TABLE outside_custody_accounts ADD CONSTRAINT outside_custody_accounts_resource_id_fkey
      FOREIGN KEY(resource_id) REFERENCES agent_access(agent_name) ON DELETE NO ACTION`);

    const result=await runErase({db:finance,person:'r5-a',vaults:[vaultRoot],apply:true,journal});
    expect(result.dbReport.refusals.join('\n')).toMatch(/expected enforced database shape/i);
    expect(result.vaults).toEqual([]);
    expect(readFileSync(note,'utf8')).toBe(before);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM users WHERE id='r5-a'")).rows[0]!.n).toBe(1);
  },240_000);

  it("refuses disabled custody RI triggers before touching vault files", async () => {
    await seedR5Members();
    const note=await addVaultNote('r5-a','r5-ri-disabled.md');
    const before=readFileSync(note,'utf8');
    const finance=await financialLogin();
    await db.pool.query('ALTER TABLE outside_custody_accounts DISABLE TRIGGER ALL');
    try{
      const result=await runErase({db:finance,person:'r5-a',vaults:[vaultRoot],apply:true,journal});
      expect(result.dbReport.refusals.join('\n')).toMatch(/expected enforced database shape/i);
      expect(result.vaults).toEqual([]);
      expect(readFileSync(note,'utf8')).toBe(before);
      expect((await db.pool.query("SELECT count(*)::int AS n FROM users WHERE id='r5-a'")).rows[0]!.n).toBe(1);
    }finally{
      await db.pool.query('ALTER TABLE outside_custody_accounts ENABLE TRIGGER ALL');
    }
  },240_000);

  it("treats NULL custody ownership as foreign and refuses before touching vault files", async () => {
    await seedR5Members();
    await seedR5Agent('r5-agent-a','r5-a','r5-org-a');
    const finance=await financialLogin();
    await db.pool.query('ALTER TABLE outside_custody_accounts ALTER COLUMN owner_member_id DROP NOT NULL');
    await db.pool.query(`INSERT INTO outside_custody_accounts(account_id,owner_member_id,resource_id,generation,active_revision,candidate_revision,consent_generation,state)
      VALUES('60000000-0000-4000-8000-000000000001',NULL,'r5-agent-a',1,NULL,NULL,1,'revoked')`);
    const note=await addVaultNote('r5-a','r5-null-owner.md');
    const before=readFileSync(note,'utf8');

    const result=await runErase({db:finance,person:'r5-a',vaults:[vaultRoot],apply:true,journal});
    expect(result.dbReport.refusals.join('\n')).toMatch(/another member still holds outside credentials/i);
    expect(result.vaults).toEqual([]);
    expect(readFileSync(note,'utf8')).toBe(before);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM outside_custody_accounts WHERE owner_member_id IS NULL")).rows[0]!.n).toBe(1);
  },240_000);

  it("waits for an in-flight foreign account insert, then refuses before files", async () => {
    await seedR5Members();
    await seedR5Agent('r5-agent-a','r5-a','r5-org-a');
    const finance=await financialLogin();
    const outside=await outsideCustodyLogin();
    const clients:{insert?:PoolClient}={};
    let erasing:Promise<Awaited<ReturnType<typeof runErase>>>|undefined;
    try{
      const insert=await outside.connect();clients.insert=insert;
      await insert.query('BEGIN');
      await insert.query(`INSERT INTO outside_custody_accounts(account_id,owner_member_id,resource_id,generation,active_revision,candidate_revision,consent_generation,state)
        VALUES('50000000-0000-4000-8000-000000000001','r5-b','r5-agent-a',1,NULL,NULL,1,'revoked')`);
      const note=await addVaultNote('r5-a','r5-insert-race.md');
      const before=readFileSync(note,'utf8');
      erasing=runErase({db:finance,person:'r5-a',vaults:[vaultRoot],apply:true,journal});
      await waitForLockWait('SELECT agent_name FROM agent_access');
      await insert.query('COMMIT');
      const result=await erasing;
      expect(result.dbReport.refusals.join('\n')).toMatch(/another member still holds outside credentials/i);
      expect(result.vaults).toEqual([]);
      expect(readFileSync(note,'utf8')).toBe(before);
      expect((await db.pool.query("SELECT count(*)::int AS n FROM outside_custody_accounts WHERE owner_member_id='r5-b'")).rows[0]!.n).toBe(1);
    }finally{
      await clients.insert?.query('ROLLBACK').catch(()=>undefined);
      clients.insert?.release();
      await erasing?.catch(()=>undefined);
    }
  },240_000);

  it("holds the agent exclusion before a later foreign insert and lets the FK reject it after erase", async () => {
    await seedR5Members();
    await seedR5Agent('r5-agent-a','r5-a','r5-org-a');
    const finance=await financialLogin();
    const outside=await outsideCustodyLogin();
    const connections:{blocker?:PoolClient;insert?:PoolClient}={};
    let erasing:Promise<Awaited<ReturnType<typeof runErase>>>|undefined;
    let pending:Promise<{code:string|null}>|undefined;
    let committed=false;
    try{
      const blocker=await db.pool.connect();connections.blocker=blocker;
      const insert=await outside.connect();connections.insert=insert;
      await blocker.query('BEGIN');
      await blocker.query("SELECT agent_name FROM agent_access WHERE agent_name='r5-agent-a' FOR UPDATE");
      const note=await addVaultNote('r5-a','r5-after-lock-race.md');
      erasing=runErase({db:finance,person:'r5-a',vaults:[vaultRoot],apply:true,journal});
      const eraserPid=await waitForLockWait('SELECT agent_name FROM agent_access');
      const insertPid=(await insert.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      pending=insert.query(`INSERT INTO outside_custody_accounts(account_id,owner_member_id,resource_id,generation,active_revision,candidate_revision,consent_generation,state)
        VALUES('50000000-0000-4000-8000-000000000002','r5-b','r5-agent-a',1,NULL,NULL,1,'revoked')`)
        .then(()=>({code:null as string|null}),(error:unknown)=>({code:(error as {code?:string}).code??'unknown'}));
      let queued=false;
      for(let attempt=0;attempt<100;attempt++){
        const state=(await db.pool.query<{wait_event_type:string|null;blocking:number[]}>(`SELECT a.wait_event_type,pg_blocking_pids(a.pid) AS blocking
          FROM pg_stat_activity a WHERE a.pid=$1`,[insertPid])).rows[0];
        if(state?.wait_event_type==='Lock'&&state.blocking.includes(eraserPid)){queued=true;break;}
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(queued,'the FK insert did not queue behind the erasure agent lock').toBe(true);
      await blocker.query('COMMIT');
      const result=await erasing;
      expect(result.dbReport.refusals).toEqual([]);
      expect(result.transactionOutcome).toBe('commit-acknowledged');
      expect(existsSync(note)).toBe(false);
      expect(await pending).toEqual({code:'23503'});
      expect((await db.pool.query("SELECT count(*)::int AS n FROM outside_custody_accounts WHERE owner_member_id='r5-b'")).rows[0]!.n).toBe(0);
      committed=true;
    }finally{
      if(!committed)await connections.blocker?.query('ROLLBACK').catch(()=>undefined);
      await connections.insert?.query('ROLLBACK').catch(()=>undefined);
      await erasing?.catch(()=>undefined);
      await pending;
      connections.blocker?.release();connections.insert?.release();
    }
  },240_000);
});
