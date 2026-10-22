// services/box/tests/run-erase.test.ts — the vault pass and the database pass, wired
// together in the one order that keeps both halves' promises.
//
// WHY A REAL POSTGRES AND A REAL GIT REPOSITORY TOGETHER. The two things this wiring can get
// wrong are exactly the things a mock would agree with: a vault file removed before the database
// erase turns out to refuse, and a "database touched" that is really "database untouched because
// the vault pass never got that far". So every test here runs the shared three-spellings fixture
// (a disposable Postgres with the real schema) against a real `git init` in a throwaway directory,
// the same combination erase-person-vault.test.ts and erase-person-db.test.ts each use alone.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {Pool} from 'pg';

import { startThreeSpellingsDb, seedThreeSpellingsFinancial, FIXTURE_OWNER, FIXTURE_SECOND, type TestDb } from "./helpers/three-spellings.js";
import { runErase, renderRunEraseReport } from "../lib/run-erase.js";
import {erasePerson,withPersonErasureClient} from '../lib/erase-person.js';
import {HostFinancialJournal} from '../../keeper/lib/financial-journal.js';
import {JournalBudgetFinancialWriter} from '../../keeper/lib/budget-financial-writer.js';
import {consoleSourceTransaction,noteBudgetFinancialChange,type SourcePool} from '@lares/agent-kit/console-source-transaction';
import * as sourceTransactions from '@lares/agent-kit/console-source-transaction';
import {observeFinancialDatabase} from '../../keeper/lib/financial-continuity.js';
import {runJournaledPersonErasure} from '../../keeper/lib/person-erasure.js';
import {platformTestJournalLock,testJournalUid} from '../../keeper/tests/helpers/financial-journal.js';
import {addUnboundNativeCredential,createNativeTestCustody} from '../../keeper/tests/helpers/native-cleanup.js';
import type {BudgetNativeCustodyStore} from '../../keeper/lib/budget-native-custody.js';

let db: TestDb;
let vaultRoot: string;
let journal:HostFinancialJournal;
let nativeCustody:BudgetNativeCustodyStore|undefined;
let custodyRoot:string;
let custodyParent:string;

function write(relPath: string, body: string): void {
  const abs = join(vaultRoot, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", vaultRoot, ...args], { encoding: "utf8" });
}

async function journalFinancialSetup(work:(source:import('@lares/agent-kit/console-source-transaction').SourceDatabase)=>Promise<void>):Promise<void>{
  const writer=new JournalBudgetFinancialWriter(journal);
  await writer.run('provision',boundary=>consoleSourceTransaction(db.pool as unknown as SourcePool,work,boundary));
}

beforeEach(async () => {
  // Legacy rows have no provisioned storage. Owned-area refusal is tested separately.
  db = await startThreeSpellingsDb({vaultAreas:false,financial:false});
  custodyParent=mkdtempSync(join(realpathSync(tmpdir()),"run-erase-journal-"));custodyRoot=join(custodyParent,'custody');
  const preparation=HostFinancialJournal.prepareFresh(custodyRoot,await observeFinancialDatabase(db.pool),{ownershipUid:testJournalUid,lock:platformTestJournalLock});
  try{preparation.complete();}finally{preparation.close();}
  journal=HostFinancialJournal.openExisting(custodyRoot,{ownershipUid:testJournalUid,lock:platformTestJournalLock,requirePrepared:true});
  await seedThreeSpellingsFinancial(db.pool,journal);

  vaultRoot = mkdtempSync(join(tmpdir(), "run-erase-vault-"));
  write("people/vera.md", "---\nowner: fixture-owner\nscope: private\n---\n\nA note.\n");
  git("init", "-q");
  git("config", "user.name", "Fixture Operator");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "the vault as it stood");
}, 180_000);

afterEach(async () => {
  try{nativeCustody?.close();}catch{}nativeCustody=undefined;
  journal?.close();
  if(custodyParent)rmSync(custodyParent, { recursive: true, force: true });
  await db.stop();
  if(vaultRoot)rmSync(vaultRoot, { recursive: true, force: true });
});

describe("runErase — the order of operations", () => {
  it('refuses a post-COMMIT competing change before issuing a financial receipt',async()=>{
    const writer=new JournalBudgetFinancialWriter(journal),original=sourceTransactions.sourceTransactionBoundary;
    const account=(await db.pool.query("SELECT id,policy_generation::text FROM budget_accounts WHERE kind='member' ORDER BY id LIMIT 1")).rows[0];
    if(!account)throw new Error('Financial race fixture unavailable');
    vi.spyOn(sourceTransactions,'sourceTransactionBoundary').mockImplementation((hooks,operationId)=>original({
      ...hooks,
      afterCommitObservation:async(owned,activeOperationId)=>{
        await db.pool.query('UPDATE budget_accounts SET policy_generation=policy_generation+1 WHERE id=$1',[account.id]);
        return hooks.afterCommitObservation?.(owned,activeOperationId);
      },
    },operationId));
    await expect(writer.runWithReceipt('member-remove',boundary=>consoleSourceTransaction(db.pool as unknown as SourcePool,async source=>{
      await source.query('UPDATE budget_accounts SET policy_generation=policy_generation+1 WHERE id=$1',[account.id]);
      noteBudgetFinancialChange(source,'budget_accounts',account.id);return 'changed';
    },boundary))).rejects.toThrow(/could not be confirmed/i);
    const after=(await db.pool.query('SELECT policy_generation::text FROM budget_accounts WHERE id=$1',[account.id])).rows[0];
    expect(BigInt(after.policy_generation)).toBe(BigInt(account.policy_generation)+2n);
    const history=readFileSync(join(custodyRoot,'journal.jsonl'),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line).record);
    const attempted=[...history].reverse().find((record:any)=>record.kind==='proposal');
    expect(attempted).toBeDefined();
    expect(history.some(record=>record.kind==='observation'&&record.operationId===attempted.operationId)).toBe(false);
    expect(history.at(-1)?.kind).toBe('freeze');
    await expect(journal.operation('member-remove',async()=>undefined)).rejects.toThrow(/closed/i);
  },240_000);

  it('refuses database apply without an active journal-owned source transaction',async()=>{
    await expect(erasePerson(db.pool,{person:FIXTURE_OWNER,dryRun:false})).rejects.toThrow(/journal-owned source transaction/i);
    const client=await db.pool.connect();
    try{
      await client.query('BEGIN');
      await expect(withPersonErasureClient(client,FIXTURE_OWNER,{},async()=>erasePerson(client,{person:FIXTURE_OWNER,dryRun:false})))
        .rejects.toThrow(/journal-owned source transaction/i);
      await client.query('ROLLBACK');
    }finally{client.release();}
    expect((await db.pool.query('SELECT 1 FROM users WHERE id=$1',[FIXTURE_OWNER])).rowCount).toBe(1);
  },240_000);

  it('does not lend an active erasure owner to a different checked-out client',async()=>{
    await expect(runJournaledPersonErasure(db.pool,journal,async(_source,financial)=>{
      const other=await db.pool.connect();
      try{await expect(withPersonErasureClient(other,FIXTURE_OWNER,financial.owner,async()=>undefined)).rejects.toThrow(/journal-owned source transaction/i);}
      finally{other.release();}
      throw new Error('stop after owner-binding proof');
    })).rejects.toThrow('stop after owner-binding proof');
    expect((await db.pool.query('SELECT 1 FROM users WHERE id=$1',[FIXTURE_OWNER])).rowCount).toBe(1);
  },240_000);

  it('expires a prepared financial closure when its journal operation ends',async()=>{
    let stale:unknown;
    await expect(runJournaledPersonErasure(db.pool,journal,async(source,financial)=>{
      stale=await financial.prepare(source,FIXTURE_OWNER);
      throw new Error('end first operation after capturing closure');
    })).rejects.toThrow('end first operation after capturing closure');
    journal.close();
    journal=HostFinancialJournal.openExisting(custodyRoot,{ownershipUid:testJournalUid,lock:platformTestJournalLock,requirePrepared:true});
    await expect(runJournaledPersonErasure(db.pool,journal,async(source,financial)=>financial.finalize(source,stale as never)))
      .rejects.toThrow('Financial erasure preflight refused');
    expect((await db.pool.query('SELECT 1 FROM users WHERE id=$1',[FIXTURE_OWNER])).rowCount).toBe(1);
  },240_000);

  it("requires prepared custody even when there are no budget accounts",async()=>{
    await db.stop();db=await startThreeSpellingsDb({vaultAreas:false,financial:false});
    expect((await db.pool.query("SELECT count(*)::int AS n FROM budget_accounts")).rows[0].n).toBe(0);
    const before=(await db.pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n;
    const result=await runErase({db:db.pool,person:FIXTURE_OWNER,vaults:[vaultRoot],apply:true});
    expect(result.dbReport.refusals.join(" ")).toMatch(/prepared financial custody/i);
    expect(existsSync(join(vaultRoot,"people/vera.md"))).toBe(true);
    expect(git("rev-parse","HEAD")).not.toBe("");
    expect((await db.pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n).toBe(before);
  },240_000);

  it("refuses the exact last active owner before a vault byte or Git head changes",async()=>{
    await db.pool.query("INSERT INTO orgs(id,display_name) VALUES('owner-proof','Owner proof')");
    await db.pool.query("UPDATE users SET org_id='owner-proof',org_role=CASE WHEN id=$1 THEN 'owner' ELSE 'member' END WHERE id IN ($1,$2)",[FIXTURE_OWNER,'fixture-second']);
    const before=readFileSync(join(vaultRoot,"people/vera.md")),head=git("rev-parse","HEAD");
    const result=await runErase({db:db.pool,person:FIXTURE_OWNER,vaults:[vaultRoot],apply:true,journal});
    expect(result.dbReport.refusals.join(" ")).toMatch(/last active organisation owner/i);
    expect(readFileSync(join(vaultRoot,"people/vera.md")).equals(before)).toBe(true);expect(git("rev-parse","HEAD")).toBe(head);
    expect((await db.pool.query("SELECT 1 FROM users WHERE id=$1",[FIXTURE_OWNER])).rowCount).toBe(1);
  },240_000);

  it("retires a financial account with one generation increment and records only secret-free tombstones",async()=>{
    const member="a2222222-2222-4222-8222-222222222222";
    await journalFinancialSetup(async source=>{
      await source.query("UPDATE budget_accounts SET state='retired',reason='member_removed' WHERE id=$1",[member]);
      noteBudgetFinancialChange(source,'budget_accounts',member);
    });
    await journalFinancialSetup(async source=>{
      await source.query("UPDATE budget_accounts SET policy_generation=9 WHERE id=$1",[member]);
      noteBudgetFinancialChange(source,'budget_accounts',member);
    });
    const beforeWindow=(await db.pool.query("SELECT id,opening_liability::text,opening_cap::text FROM budget_windows WHERE account_id=$1 ORDER BY id",[member])).rows;
    nativeCustody=createNativeTestCustody(join(custodyParent,'native'));
    const operationId=await addUnboundNativeCredential(nativeCustody,member,'a1111111-1111-4111-8111-111111111111');
    let removalReceipt:import('../../keeper/lib/financial-journal.js').CommittedFinancialReceipt|undefined;
    const removalWriter=new JournalBudgetFinancialWriter(journal);
    await nativeCustody.withGate(async gate=>{await removalWriter.runWithReceipt('member-remove',boundary=>consoleSourceTransaction(db.pool as unknown as SourcePool,async source=>{
      for(const table of ['budget_accounts','budget_gateway_bindings','budget_attempts'] as const){
        const rows=await source.query(`SELECT id FROM ${table} WHERE live_member_id=$1`,[FIXTURE_OWNER]);
        for(const row of rows.rows)noteBudgetFinancialChange(source,table,row.id);
      }
      await source.query("UPDATE users SET status='removed' WHERE id=$1",[FIXTURE_OWNER]);return true;
    },boundary),receipt=>{removalReceipt=receipt;gate.recordRevocation(operationId,receipt);return undefined;}).then(result=>{removalReceipt=result.receipt;});gate.removePlaintext(operationId);});
    if(!removalReceipt)throw new Error('Prepared member-removal receipt fixture failed');
    const result=await runErase({db:db.pool,person:FIXTURE_OWNER,vaults:[],apply:true,journal,nativeCustody});
    expect(result.dbReport.refusals).toEqual([]);
    expect(result.nativeCleanup).toEqual({status:'pending',remaining:1});
    await nativeCustody.withGate(async gate=>{
      const inventory=gate.inventory();
      expect(inventory.users.some(user=>user.kind==='user')).toBe(false);
      expect(inventory.users.some(user=>user.kind==='erased-user')).toBe(true);
      expect(inventory.operations[0]).toMatchObject({kind:'cleanup',operationCommitment:expect.any(String),keyFingerprint:expect.any(String),phase:'revoke-pending',plaintext:'removed',nativeDeletion:'unverified'});
      expect(JSON.stringify(inventory)).not.toContain(member);
      expect(JSON.stringify(inventory)).not.toContain(operationId);
    });
    const after=(await db.pool.query("SELECT state,reason,policy_generation::text,live_member_id,organisation_id FROM budget_accounts WHERE id=$1",[member])).rows[0];
    expect(after).toEqual({state:'retired',reason:'member_erased',policy_generation:'11',live_member_id:null,organisation_id:null});
    const binding=(await db.pool.query("SELECT state,live_member_id,agent,key_fingerprint FROM budget_gateway_bindings WHERE member_account_id=$1",[member])).rows[0];
    expect(binding).toEqual({state:'revoked',live_member_id:null,agent:null,key_fingerprint:null});
    const attempt=(await db.pool.query("SELECT state,live_member_id,authority_reference FROM budget_attempts WHERE member_account_id=$1",[member])).rows[0];
    expect(attempt).toEqual({state:'retired',live_member_id:null,authority_reference:null});
    expect((await db.pool.query("SELECT id,opening_liability::text,opening_cap::text FROM budget_windows WHERE account_id=$1 ORDER BY id",[member])).rows).toEqual(beforeWindow);
    const journalText=readFileSync(join(custodyRoot,'journal.jsonl'),'utf8');
    expect(journalText).not.toContain(FIXTURE_OWNER);expect(journalText).not.toContain('fixture-private');expect(journalText).not.toContain('fixture-epoch');
    expect(journalText).toContain('tombstone');expect(journalText).toContain('member_erased');expect(journalText).toContain('d'.repeat(64));expect(journalText).toContain('e'.repeat(64));
    const activeMember='a7777777-7777-4777-8777-777777777777';
    await journalFinancialSetup(async source=>{
      await source.query(`INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,live_member_id,
      canonical_suppression_hash,provider_suppression_hashes,state,reason,policy_generation)
      VALUES($1,'fixture-installation','member','a1111111-1111-4111-8111-111111111111','fixture-second',repeat('f',64),ARRAY[repeat('1',64)],'open','approved',4)`,[activeMember]);
      noteBudgetFinancialChange(source,'budget_accounts',activeMember);
    });
    const activeResult=await runErase({db:db.pool,person:FIXTURE_SECOND,vaults:[],apply:true,journal});
    expect(activeResult.dbReport.refusals).toEqual([]);
    expect((await db.pool.query("SELECT state,reason,policy_generation::text,live_member_id FROM budget_accounts WHERE id=$1",[activeMember])).rows[0])
      .toEqual({state:'retired',reason:'member_erased',policy_generation:'5',live_member_id:null});
  },240_000);

  it("refuses more than 128 active target bindings before file or Git changes",async()=>{
    for(const [first,last] of [[1,64],[65,129]] as const)await journalFinancialSetup(async source=>{
      const inserted=await source.query(`INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,
      endpoint_hash,credential_generation,key_fingerprint,agent,incarnation,purpose_alias,profile_hash,maximum_liability,state)
      SELECT ('f0000000-0000-4000-8000-'||lpad(to_hex(i),12,'0'))::uuid,
        'a1111111-1111-4111-8111-111111111111','a2222222-2222-4222-8222-222222222222','fixture-owner',
        repeat('a',64),0,repeat('b',64),'fixture-agent','88888888-8888-4888-8888-888888888888','proof-'||i,repeat('c',64),0.1,'active'
      FROM generate_series($1::int,$2::int) i RETURNING id`,[first,last]);
      for(const row of inserted.rows)noteBudgetFinancialChange(source,'budget_gateway_bindings',row.id);
    });
    const before=readFileSync(join(vaultRoot,'people/vera.md')),head=git('rev-parse','HEAD');
    const result=await runErase({db:db.pool,person:FIXTURE_OWNER,vaults:[vaultRoot],apply:true,journal});
    expect(result.dbReport.refusals.join(' ')).toMatch(/rolled back/i);
    expect(result.vaults).toEqual([]);
    expect(readFileSync(join(vaultRoot,'people/vera.md')).equals(before)).toBe(true);
    expect(git('rev-parse','HEAD')).toBe(head);
    expect((await db.pool.query("SELECT 1 FROM users WHERE id=$1",[FIXTURE_OWNER])).rowCount).toBe(1);
  },240_000);

  it('preserves and redacts more than 128 already-revoked historical bindings',async()=>{
    for(const [first,last] of [[1,64],[65,129]] as const)await journalFinancialSetup(async source=>{
      const inserted=await source.query(`INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,
      endpoint_hash,credential_generation,profile_hash,maximum_liability,state)
      SELECT ('f3000000-0000-4000-8000-'||lpad(to_hex(i),12,'0'))::uuid,
        'a1111111-1111-4111-8111-111111111111','a2222222-2222-4222-8222-222222222222',$1,
      repeat('a',64),0,repeat('c',64),0.1,'revoked' FROM generate_series($2::int,$3::int) i RETURNING id`,[FIXTURE_OWNER,first,last]);
      for(const row of inserted.rows)noteBudgetFinancialChange(source,'budget_gateway_bindings',row.id);
    });
    const result=await runErase({db:db.pool,person:FIXTURE_OWNER,vaults:[],apply:true,journal});
    expect(result.dbReport.refusals).toEqual([]);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM budget_gateway_bindings WHERE member_account_id='a2222222-2222-4222-8222-222222222222' AND state='revoked' AND live_member_id IS NULL")).rows[0].n).toBe(130);
  },240_000);

  it("refuses the exact journal frame byte limit before vault or Git changes",async()=>{
    for(const [first,last] of [[1,16],[17,32],[33,48],[49,64],[65,80],[81,96],[97,105]] as const)await journalFinancialSetup(async source=>{
      const inserted=await source.query(`INSERT INTO budget_attempts(id,invocation_hash,ticket_hash,installation_account_id,member_account_id,binding_id,live_member_id,
      installation_window_id,member_window_id,endpoint_hash,credential_generation,installation_policy_generation,member_policy_generation,
      endpoint_generation,recovery_epoch,request_hash,authority_hash,profile_hash,reserved_amount,installation_cap_snapshot,member_cap_snapshot,
      created_at,expires_at)
      SELECT ('f2000000-0000-4000-8000-'||lpad(to_hex(i),12,'0'))::uuid,md5(i::text)||md5('proof-'||i::text),md5('ticket-'||i::text)||md5(i::text),
        'a1111111-1111-4111-8111-111111111111','a2222222-2222-4222-8222-222222222222','a4444444-4444-4444-8444-444444444444',$1,
        'a6666666-6666-4666-8666-666666666666','a3333333-3333-4333-8333-333333333333',repeat('a',64),0,0,0,0,'fixture-epoch',
        repeat('1',64),repeat('2',64),repeat('c',64),0.1,1,1,t,t+interval '30 seconds'
      FROM generate_series($2::int,$3::int) i CROSS JOIN (SELECT clock_timestamp() AS t) c RETURNING id`,[FIXTURE_OWNER,first,last]);
      for(const row of inserted.rows)noteBudgetFinancialChange(source,'budget_attempts',row.id);
    });
    expect((await db.pool.query("SELECT count(*)::int AS n FROM budget_attempts WHERE live_member_id=$1 AND state='prepared'",[FIXTURE_OWNER])).rows[0].n).toBe(106);
    const before=readFileSync(join(vaultRoot,'people/vera.md')),head=git('rev-parse','HEAD');
    const result=await runErase({db:db.pool,person:FIXTURE_OWNER,vaults:[vaultRoot],apply:true,journal});
    expect(result.dbReport.refusals.join(' ')).toMatch(/journal record limit/i);
    expect(result.vaults).toEqual([]);
    expect(readFileSync(join(vaultRoot,'people/vera.md')).equals(before)).toBe(true);
    expect(git('rev-parse','HEAD')).toBe(head);
    expect((await db.pool.query('SELECT 1 FROM users WHERE id=$1',[FIXTURE_OWNER])).rowCount).toBe(1);
  },240_000);

  it("refuses owned area metadata before either preview or apply touches files or rows", async () => {
    await db.pool.query("INSERT INTO orgs(id,display_name) VALUES('vault-proof','Vault proof')");
    await db.pool.query("UPDATE users SET org_id='vault-proof',org_role='owner' WHERE id IN ('fixture-owner','fixture-second')");
    await db.pool.query("INSERT INTO vault_backing_stores(id,organisation_id,kind) VALUES('proof-backing','vault-proof','git')");
    await db.pool.query(`INSERT INTO vault_areas(id,organisation_id,kind,owner_member_id,backing_store_id,relative_path)
      VALUES('proof-area','vault-proof','private','fixture-owner','proof-backing','private/fixture')`);
    const before=readFileSync(join(vaultRoot,"people/vera.md"));
    const head=git("rev-parse","HEAD");
    for(const apply of [false,true]){
      const result=await runErase({db:db.pool,person:FIXTURE_OWNER,vaults:[vaultRoot],apply,...(apply?{journal}:{})});
      expect(result.dbReport.refusals.join(" ")).toMatch(/backing storage.*reconciled/);
      expect(result.dbReport.deleted).toEqual([]);expect(result.vaults).toEqual([]);
      expect(readFileSync(join(vaultRoot,"people/vera.md")).equals(before)).toBe(true);
      expect(git("rev-parse","HEAD")).toBe(head);
      expect((await db.pool.query("SELECT 1 FROM users WHERE id=$1",[FIXTURE_OWNER])).rowCount).toBe(1);
      expect((await db.pool.query("SELECT 1 FROM standing_facts WHERE user_id=$1",[FIXTURE_OWNER])).rowCount).toBeGreaterThan(0);
      expect((await db.pool.query("SELECT status FROM vault_areas WHERE id='proof-area'")).rows[0].status).toBe('active');
    }
  },240_000);

  it("a database refusal leaves the vault byte-identical", async () => {
    await db.pool.query("DROP TABLE memory_reads");
    const before = readFileSync(join(vaultRoot, "people/vera.md"));

    const result = await runErase({
      db: db.pool,
      person: FIXTURE_OWNER,
      vaults: [vaultRoot],
      apply: true,
      journal,
    });

    expect(result.dbReport.refusals.join(" ")).toContain("memory_reads");
    expect(result.vaults).toEqual([]);
    expect(existsSync(join(vaultRoot, "people/vera.md"))).toBe(true);
    expect(readFileSync(join(vaultRoot, "people/vera.md")).equals(before)).toBe(true);
  }, 240_000);

  it("removes the vault file, then clears its sync-state row, in one --apply run", async () => {
    await db.pool.query(
      `INSERT INTO notion_sync_docs (vault_path, notion_page_id, target, direction)
       VALUES ('people/vera.md', 'p1', 'docs', 'two_way')`,
    );

    const result = await runErase({
      db: db.pool,
      person: FIXTURE_OWNER,
      vaults: [vaultRoot],
      apply: true,
      journal,
    });

    expect(result.dbReport.refusals).toEqual([]);
    expect(existsSync(join(vaultRoot, "people/vera.md"))).toBe(false);
    expect(result.vaults[0]!.removed).toEqual(["people/vera.md"]);
    expect((await db.pool.query("SELECT 1 FROM notion_sync_docs")).rows).toHaveLength(0);
  }, 240_000);

  it("a vault pass that throws stops before the database is touched", async () => {
    write("projects/unrelated.md", "---\nowner: fixture-second\n---\nstaged by somebody else\n");
    git("add", "projects/unrelated.md");

    const before = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM standing_facts WHERE user_id = $1",
      [FIXTURE_OWNER],
    );
    expect(before.rows[0]!.n).toBeGreaterThan(0);

    const result = await runErase({
      db: db.pool,
      person: FIXTURE_OWNER,
      vaults: [vaultRoot],
      apply: true,
      journal,
    });

    expect(result.vaultError).toMatch(/staged/i);
    expect(result.vaults).toEqual([]);

    const after = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM standing_facts WHERE user_id = $1",
      [FIXTURE_OWNER],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(existsSync(join(vaultRoot, "people/vera.md"))).toBe(true);
  }, 240_000);

  it("reports files removed in the current vault when its erase commit fails",async()=>{
    const hook=join(vaultRoot,'.git','hooks','pre-commit');
    writeFileSync(hook,'#!/bin/sh\nexit 1\n');chmodSync(hook,0o700);
    const result=await runErase({db:db.pool,person:FIXTURE_OWNER,vaults:[vaultRoot],apply:true,journal});
    expect(result.vaultError).toMatch(/hook|exit code|failed/i);
    expect(result.vaults[0]?.removed).toEqual(['people/vera.md']);
    expect(result.vaults[0]?.commit).toBe(null);
    expect(renderRunEraseReport(result)).toContain('people/vera.md');
    expect(existsSync(join(vaultRoot,'people/vera.md'))).toBe(false);
    expect(git('diff','--cached','--name-only')).toContain('people/vera.md');
    expect((await db.pool.query('SELECT 1 FROM users WHERE id=$1',[FIXTURE_OWNER])).rowCount).toBe(1);
    expect(renderRunEraseReport(result)).toMatch(/review the vault and database state/i);
  },240_000);

  it("reports a lost database commit acknowledgement as unknown and keeps vault evidence",async()=>{
    let lost=false;
    const uncertainPool={connect:async()=>{
      const client=await db.pool.connect();
      return {query:async(sql:any,values?:unknown[])=>{
        const result=await client.query(sql,values);
        const statement=typeof sql==='string'?sql:sql.text;
        if(!lost&&/^\s*COMMIT\b/i.test(statement)){lost=true;throw new Error('synthetic lost COMMIT acknowledgement');}
        return result;
      },release:client.release.bind(client)};
    }} as unknown as Pool;
    const result=await runErase({db:uncertainPool,person:FIXTURE_OWNER,vaults:[vaultRoot],apply:true,journal});
    expect(result.transactionOutcome).toBe('unknown');
    expect(result.vaults[0]?.removed).toEqual(['people/vera.md']);
    expect(renderRunEraseReport(result)).toMatch(/database outcome is unknown/i);
    expect(renderRunEraseReport(result)).toContain('people/vera.md');
    expect(existsSync(join(vaultRoot,'people/vera.md'))).toBe(false);
    expect((await db.pool.query('SELECT 1 FROM users WHERE id=$1',[FIXTURE_OWNER])).rowCount).toBe(0);
    await expect(journal.operation('erase-person',async()=>undefined)).rejects.toThrow(/closed or busy/i);
  },240_000);

  it("reports an acknowledged database commit when the journal terminal write fails",async()=>{
    journal.committed=()=>{throw new Error('synthetic journal terminal failure');};
    const result=await runErase({db:db.pool,person:FIXTURE_OWNER,vaults:[vaultRoot],apply:true,journal});
    expect(result.transactionOutcome).toBe('commit-acknowledged');
    expect(result.journalWarning).toMatch(/commit was acknowledged/i);
    expect(renderRunEraseReport(result)).toMatch(/final journal record could not be confirmed/i);
    expect(existsSync(join(vaultRoot,'people/vera.md'))).toBe(false);
    expect((await db.pool.query('SELECT 1 FROM users WHERE id=$1',[FIXTURE_OWNER])).rowCount).toBe(0);
  },240_000);

  it("two vaults, the second one fails: the first one's removal is reported, never dropped, and the database is untouched", async () => {
    const second = mkdtempSync(join(tmpdir(), "run-erase-vault2-"));
    const g2 = (...args: string[]): string =>
      execFileSync("git", ["-C", second, ...args], { encoding: "utf8" });
    try {
      mkdirSync(join(second, "people"), { recursive: true });
      writeFileSync(join(second, "people/vera.md"), "---\nowner: fixture-owner\n---\n\nAnother note.\n");
      g2("init", "-q");
      g2("config", "user.name", "Fixture Operator");
      g2("config", "user.email", "fixture@example.invalid");
      g2("config", "commit.gpgsign", "false");
      g2("add", "-A");
      g2("commit", "-q", "-m", "the second vault as it stood");
      writeFileSync(join(second, "staged.md"), "---\nowner: fixture-second\n---\nstaged by somebody else\n");
      g2("add", "staged.md");

      const result = await runErase({
        db: db.pool,
        person: FIXTURE_OWNER,
        vaults: [vaultRoot, second],
        apply: true,
        journal,
      });

      expect(result.vaultError).toMatch(/staged/i);
      expect(result.vaults.map((v) => v.vaultRoot)).toEqual([vaultRoot]);
      expect(result.vaults[0]!.commit).not.toBe(null);
      const md = renderRunEraseReport(result);
      expect(md).toContain(vaultRoot);
      expect(md).toMatch(/already been removed/i);
      expect(md).toMatch(/review the vault and database state/i);

      const after = await db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM standing_facts WHERE user_id = $1",
        [FIXTURE_OWNER],
      );
      expect(after.rows[0]!.n).toBeGreaterThan(0);
      expect(existsSync(join(second, "people/vera.md"))).toBe(true);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  }, 240_000);

  it("no --vault given: a real run still erases the database, and says the vault was not looked at", async () => {
    const result = await runErase({ db: db.pool, person: FIXTURE_OWNER, vaults: [], apply: true,journal });
    expect(result.dbReport.refusals).toEqual([]);
    expect(result.noVaultGiven).toBe(true);
    expect(renderRunEraseReport(result)).toMatch(/vault was not looked at/i);
  }, 240_000);

  it("without --apply, nothing is written anywhere, and the report says so for both halves", async () => {
    const journalBefore=readFileSync(join(custodyRoot,'journal.jsonl'));
    const head=git('rev-parse','HEAD');
    const result = await runErase({
      db: db.pool,
      person: FIXTURE_OWNER,
      vaults: [vaultRoot],
      apply: false,
    });
    expect(existsSync(join(vaultRoot, "people/vera.md"))).toBe(true);
    expect(readFileSync(join(custodyRoot,'journal.jsonl'))).toEqual(journalBefore);
    expect(git('rev-parse','HEAD')).toBe(head);
    expect(result.dbReport.dryRun).toBe(true);
    const md = renderRunEraseReport(result);
    expect(md).toMatch(/practice run/i);
    expect(md).toContain("people/vera.md");
  }, 240_000);

  it("names the push command per vault, and never runs it", async () => {
    const result = await runErase({
      db: db.pool,
      person: FIXTURE_OWNER,
      vaults: [vaultRoot],
      apply: true,
      journal,
    });
    expect(git("log", "--oneline", "-1")).toContain("erase: 1 file(s) for one person");

    const md = renderRunEraseReport(result);
    expect(md).toContain(`git -C ${vaultRoot} push`);
  }, 240_000);
});
