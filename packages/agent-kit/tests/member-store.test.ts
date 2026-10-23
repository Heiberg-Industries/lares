import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgMemberStore, currentMember, type VerifiedProviderProof } from '../src/member-store.js';
import { quiet } from './helpers/quiet-pool.js';
const migration = readFileSync(new URL('../../../services/box/sql/007_member_identity_sessions.sql',import.meta.url),'utf8');
const tomorrow = () => new Date(Date.now()+86_400_000);
const proof = (subject: string, tenantId?: string): VerifiedProviderProof => ({ identity: { issuer:'https://identity.example.invalid', subject, ...(tenantId ? {tenantId} : {}) }, verifiedAt: new Date() });
const schema = `CREATE TABLE orgs(id text PRIMARY KEY,display_name text NOT NULL);
 CREATE TABLE org_member_policy(user_id text PRIMARY KEY,allowed_capabilities text[],may_create_agents boolean NOT NULL DEFAULT true,spend_cap_usd_month numeric);
 CREATE TABLE users(id text PRIMARY KEY,display_name text NOT NULL,primary_email text,org_id text REFERENCES orgs(id),org_role text NOT NULL DEFAULT 'member',created_at timestamptz NOT NULL DEFAULT now());`;
let db: Pool, store: PgMemberStore, stop: () => Promise<void>;
beforeAll(async () => {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db=quiet(new Pool({connectionString:container.getConnectionUri()})); store=new PgMemberStore(db);
  stop=async()=>{await db.end(); await container.stop();};
},120_000);
afterAll(async()=>{await stop?.();});
beforeEach(async()=> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.query(schema);
  await db.query("INSERT INTO orgs VALUES('org','Example'),('other','Other'); INSERT INTO users(id,display_name,primary_email,org_id,org_role) VALUES('owner','Owner','owner@example.invalid','org','owner'),('second','Second','second@example.invalid','org','member'),('outsider','Other','other@example.invalid','other','owner');");
  await db.query(migration);
});
async function invite(email='invite@example.invalid', role: 'owner'|'member'|'restricted'='member') {
  return store.inviteMember('owner',{displayName:'Invited member',email,role,expiresAt:tomorrow()});
}
describe('member storage on disposable PostgreSQL',()=> {
  it('opens one locked first-owner window, rechecks proof age after the lock and closes it atomically',async()=> {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await db.query(schema);
    await db.query("INSERT INTO orgs VALUES('org','Example'); INSERT INTO users(id,display_name,primary_email,org_id,org_role) VALUES('owner','Owner','owner@example.invalid','org','owner'); INSERT INTO org_member_policy(user_id) VALUES('owner');");
    await db.query(migration);
    expect(await store.firstOwnerBootstrapEligible('owner','org')).toBe(true);
    const blocker=await db.connect(); await blocker.query('BEGIN'); await blocker.query("SELECT id FROM orgs WHERE id='org' FOR UPDATE");
    const now=Date.now(); const staleAfterWait=store.bootstrapFirstOwnerIdentity('owner','org',{...proof('late'),verifiedAt:new Date(now)});
    await new Promise(resolve=>setTimeout(resolve,50));
    const clock=vi.spyOn(Date,'now').mockReturnValue(now+300_001);
    await blocker.query('COMMIT'); blocker.release();
    try { await expect(staleAfterWait).rejects.toMatchObject({code:'invalid'}); }
    finally { clock.mockRestore(); }
    await expect(store.bootstrapFirstOwnerIdentity('owner','org',proof('first'))).resolves.toBeUndefined();
    expect(await store.firstOwnerBootstrapEligible('owner','org')).toBe(false);
    await expect(store.bootstrapFirstOwnerIdentity('owner','org',proof('second'))).rejects.toMatchObject({code:'denied'});
    expect((await db.query("SELECT member_id,subject FROM member_provider_identities")).rows).toEqual([{member_id:'owner',subject:'first'}]);
  });
  it('admits exactly one competing first-owner proof and only its identity can sign in',async()=> {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await db.query(schema);
    await db.query("INSERT INTO orgs VALUES('org','Example'); INSERT INTO users(id,display_name,primary_email,org_id,org_role) VALUES('owner','Owner','owner@example.invalid','org','owner'); INSERT INTO org_member_policy(user_id) VALUES('owner');");
    await db.query(migration);
    expect(await store.firstOwnerBootstrapEligible('owner','org')).toBe(true);

    const proofs=[proof('competing-owner-a'),proof('competing-owner-b')];
    const results=await Promise.allSettled(proofs.map(candidate=>store.bootstrapFirstOwnerIdentity('owner','org',candidate)));
    const winners=results.flatMap((result,index)=>result.status==='fulfilled'?[index]:[]);
    const denied=results.filter((result)=>result.status==='rejected');
    expect(winners).toHaveLength(1);
    expect(denied).toHaveLength(1);
    if (denied[0]?.status==='rejected') expect(denied[0].reason).toMatchObject({code:'denied'});

    const winnerProof=proofs[winners[0]!];
    const loserProof=proofs[winners[0]===0?1:0]!;
    expect((await db.query('SELECT member_id,issuer,subject,tenant_id FROM member_provider_identities')).rows).toEqual([{
      member_id:'owner',issuer:'https://identity.example.invalid',subject:winnerProof!.identity.subject,tenant_id:''
    }]);
    await expect(store.createSession(loserProof,tomorrow())).rejects.toMatchObject({code:'denied'});

    const nextSignIn=await store.createSession(winnerProof!,tomorrow());
    expect(nextSignIn.member).toMatchObject({id:'owner',organisationId:'org',role:'owner',status:'active'});
    expect(await store.sessionMember(nextSignIn.token)).toMatchObject({id:'owner',organisationId:'org',role:'owner',status:'active'});
  });
  it('refuses first-owner bootstrap if any extra member, organisation, invitation, identity or session exists',async()=> {
    const fresh=async()=> {
      await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await db.query(schema);
      await db.query("INSERT INTO orgs VALUES('org','Example'); INSERT INTO users(id,display_name,primary_email,org_id,org_role) VALUES('owner','Owner','owner@example.invalid','org','owner'); INSERT INTO org_member_policy(user_id) VALUES('owner');");
      await db.query(migration);
    };
    await fresh(); await db.query("INSERT INTO users(id,display_name,org_id,org_role) VALUES('second','Second','org','member')");
    expect(await store.firstOwnerBootstrapEligible('owner','org')).toBe(false);
    await fresh(); await db.query("INSERT INTO orgs VALUES('other','Other')");
    expect(await store.firstOwnerBootstrapEligible('owner','org')).toBe(false);
    await fresh(); await db.query("INSERT INTO member_invitations(id,member_id,token_hash,expires_at) VALUES('invite','owner',repeat('a',64),now()+interval '1 hour')");
    expect(await store.firstOwnerBootstrapEligible('owner','org')).toBe(false);
    await fresh(); await db.query("INSERT INTO member_provider_identities(member_id,issuer,subject) VALUES('owner','https://identity.example.invalid','existing')");
    expect(await store.firstOwnerBootstrapEligible('owner','org')).toBe(false);
    await fresh(); await db.query("INSERT INTO member_sessions(id,member_id,token_hash,expires_at) VALUES('session','owner',repeat('b',64),now()+interval '1 hour')");
    expect(await store.firstOwnerBootstrapEligible('owner','org')).toBe(false);
  });
  it('lists same-organisation directory and pending invitations only for current owners, without credentials',async()=> {
    const invitation=await invite();
    const directory=await store.listMembers('owner');
    expect(directory.map(entry=>entry.member.id)).toEqual(expect.arrayContaining(['owner','second',invitation.member.id]));
    expect(directory.some(entry=>entry.member.id==='outsider')).toBe(false);
    const pending=await store.listInvitations('owner');
    expect(pending).toEqual([{id:invitation.invitationId,memberId:invitation.member.id,expiresAt:expect.any(String)}]);
    const metadata=JSON.stringify({directory,pending});
    expect(metadata).not.toContain(invitation.token);
    expect(metadata).not.toContain('token_hash');
    await expect(store.listMembers('second')).rejects.toThrow('denied');
    await expect(store.listInvitations('second')).rejects.toThrow('denied');
    expect((await store.listMembers('outsider')).map(entry=>entry.member.id)).toEqual(['outsider']);
    await store.revokeInvitation('owner',invitation.invitationId);
    expect(await store.listInvitations('owner')).toEqual([]);
    await db.query("UPDATE users SET status='removed' WHERE id='second'");
    await expect(store.listMembers('second')).rejects.toThrow('denied');
  });
  it('preserves existing ids/data and refuses inactive members after repeated migration',async()=> {
    const invitation=await invite();
    await db.query("UPDATE users SET status='removed' WHERE id='second'");
    await db.query(migration);
    expect(await store.currentMember('owner')).toEqual({id:'owner',organisationId:'org',role:'owner',status:'active',automationMode:'draft-and-ask'});
    expect(await store.currentMember('second')).toBeUndefined();
    expect(await store.currentMember(invitation.member.id)).toBeUndefined();
    expect((await db.query("SELECT display_name,primary_email,status FROM users WHERE id='second'")).rows[0]).toEqual({display_name:'Second',primary_email:'second@example.invalid',status:'removed'});
  });
  it('admits an invitation once and never uses email as provider identity',async()=> {
    const invitation=await invite();
    expect(invitation.token).toMatch(/^[\w-]{43}$/);
    const member=await store.acceptInvitation(invitation.token,proof('new-subject'));
    expect(member.id).toBe(invitation.member.id);
    expect(member.status).toBe('active');
    await expect(store.acceptInvitation(invitation.token,proof('other'))).rejects.toThrow('denied');
    expect(await store.memberForIdentity(proof('invite@example.invalid').identity)).toBeUndefined();
    expect(await store.memberForIdentity(proof('new-subject').identity)).toEqual(member);
    const hashes=(await db.query('SELECT token_hash FROM member_invitations')).rows;
    expect(hashes[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(hashes)).not.toContain(invitation.token);
  });
  it('refuses expired/revoked invitations and rolls back failed identity acceptance',async()=> {
    const expired=await invite('expired@example.invalid');
    await db.query("UPDATE member_invitations SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",[expired.invitationId]);
    await expect(store.acceptInvitation(expired.token,proof('expired'))).rejects.toThrow('denied');
    const revoked=await invite('revoked@example.invalid');
    await store.revokeInvitation('owner',revoked.invitationId);
    await expect(store.acceptInvitation(revoked.token,proof('revoked'))).rejects.toThrow('denied');
    await store.linkIdentity('owner','owner',proof('taken'));
    const conflict=await invite('conflict@example.invalid');
    await expect(store.acceptInvitation(conflict.token,proof('taken'))).rejects.toThrow('identity_conflict');
    expect((await db.query('SELECT used_at FROM member_invitations WHERE id=$1',[conflict.invitationId])).rows[0].used_at).toBeNull();
    expect((await store.acceptInvitation(conflict.token,proof('available'))).status).toBe('active');
  });
  it('serializes concurrent invitation acceptance and provider identity linking',async()=> {
    const invitation=await invite();
    const accepts=await Promise.allSettled([store.acceptInvitation(invitation.token,proof('new')),store.acceptInvitation(invitation.token,proof('new'))]);
    expect(accepts.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const links=await Promise.allSettled([store.linkIdentity('owner','owner',proof('shared')),store.linkIdentity('outsider','outsider',proof('shared'))]);
    expect(links.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((await db.query("SELECT count(*)::int AS n FROM member_provider_identities WHERE subject='shared'")).rows[0].n).toBe(1);
    await store.linkIdentity('owner','owner',proof('tenant-subject','tenant-one'));
    await store.linkIdentity('outsider','outsider',proof('tenant-subject','tenant-two'));
  });
  it('requires explicit active self/owner linking and denies cross-organisation actors',async()=> {
    await expect(store.linkIdentity('second','owner',proof('bad'))).rejects.toThrow('denied');
    await expect(store.linkIdentity('outsider','owner',proof('bad'))).rejects.toThrow('denied');
    await store.linkIdentity('second','second',proof('second'));
    await store.linkIdentity('owner','owner',proof('owner'));
    expect(await store.memberForIdentity(proof('second').identity)).toMatchObject({id:'second'});
    await expect(store.createSession(proof('unknown'),tomorrow())).rejects.toThrow('denied');
    await expect(store.linkIdentity('owner','owner',{...proof('old'),verifiedAt:new Date(0)})).rejects.toThrow('invalid');
  });
  it('never conflates exact provider subjects, tenants or issuers during lookup/session creation',async()=> {
    await store.linkIdentity('owner','owner',proof('owner','tenant'));
    for (const distinct of [proof(' owner ','tenant'),proof('owner',' tenant '),{...proof('owner','tenant'),identity:{...proof('owner','tenant').identity,issuer:' https://identity.example.invalid '}}]) {
      expect(await store.memberForIdentity(distinct.identity)).toBeUndefined();
      await expect(store.createSession(distinct,tomorrow())).rejects.toThrow('denied');
    }
    await store.linkIdentity('second','second',proof(' owner ','tenant'));
    await store.linkIdentity('outsider','outsider',proof('owner',' tenant '));
    expect(await store.memberForIdentity(proof('owner','tenant').identity)).toMatchObject({id:'owner'});
    expect(await store.memberForIdentity(proof(' owner ','tenant').identity)).toMatchObject({id:'second'});
    expect(await store.memberForIdentity(proof('owner',' tenant ').identity)).toMatchObject({id:'outsider'});
    const second=await store.createSession(proof(' owner ','tenant'),tomorrow());
    const other=await store.createSession(proof('owner',' tenant '),tomorrow());
    expect(await store.sessionMember(second.token)).toMatchObject({id:'second'});
    expect(await store.sessionMember(other.token)).toMatchObject({id:'outsider'});
  });
  it('keeps two members sessions distinct, secret-free and individually revocable',async()=> {
    await store.linkIdentity('owner','owner',proof('owner'));
    await store.linkIdentity('second','second',proof('second'));
    const a=await store.createSession(proof('owner'),tomorrow()), b=await store.createSession(proof('second'),tomorrow());
    expect(await store.sessionMember(a.token)).toMatchObject({id:'owner'});
    expect(await store.sessionMember(b.token)).toMatchObject({id:'second'});
    expect(await store.sessionMember(a.token+'x')).toBeUndefined();
    const status=await store.sessionMember(a.token);
    expect(Object.keys(status!).sort()).toEqual(['automationMode','id','organisationId','role','status']);
    expect(JSON.stringify((await db.query('SELECT * FROM member_sessions')).rows)).not.toContain(a.token);
    await store.revokeSession(a.token);
    expect(await store.sessionMember(a.token)).toBeUndefined();
    expect(await store.sessionMember(b.token)).toMatchObject({id:'second'});
    await db.query("UPDATE member_sessions SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",[b.sessionId]);
    expect(await store.sessionMember(b.token)).toBeUndefined();
  });
  it('signs out all and removal revokes sessions and invitations without deleting data',async()=> {
    await store.linkIdentity('second','second',proof('second'));
    const a=await store.createSession(proof('second'),tomorrow()), b=await store.createSession(proof('second'),tomorrow());
    await expect(store.signOutAll('outsider','second')).rejects.toThrow('denied');
    await store.signOutAll('second','second');
    expect(await store.sessionMember(a.token)).toBeUndefined(); expect(await store.sessionMember(b.token)).toBeUndefined();
    const c=await store.createSession(proof('second'),tomorrow());
    await db.query("UPDATE users SET status='removed' WHERE id='second'");
    expect(await store.sessionMember(c.token)).toBeUndefined();
    expect(await store.memberForIdentity(proof('second').identity)).toBeUndefined();
    await expect(store.createSession(proof('second'),tomorrow())).rejects.toThrow('denied');
    const invitation=await invite(); await db.query("UPDATE users SET status='removed' WHERE id=$1",[invitation.member.id]);
    await expect(store.acceptInvitation(invitation.token,proof('removed'))).rejects.toThrow('denied');
    expect((await db.query('SELECT count(*)::int AS n FROM member_provider_identities WHERE member_id=$1',['second'])).rows[0].n).toBe(1);
  });
  it('preserves the last active owner through API and concurrent direct updates',async()=> {
    await expect(db.query("UPDATE users SET status='removed' WHERE id='owner'")).rejects.toThrow('last active owner');
    await expect(db.query("DELETE FROM users WHERE id='owner'")).rejects.toThrow('last active owner');
    await expect(db.query("UPDATE users SET org_role='member' WHERE id='owner'")).rejects.toThrow('last active owner');
    await expect(db.query("UPDATE users SET org_id='other' WHERE id='owner'")).rejects.toThrow('last active owner');
    await expect(db.query("UPDATE users SET org_id=NULL WHERE id='owner'")).rejects.toThrow('last active owner');
    // Legacy bootstrap may first create an owner without an organisation, then assign it.
    await db.query("INSERT INTO users(id,display_name,org_role) VALUES('bootstrap','Bootstrap','owner')");
    await db.query("UPDATE users SET org_id='org' WHERE id='bootstrap'");
    await db.query("DELETE FROM users WHERE id='bootstrap'");
    await db.query("UPDATE users SET org_role='owner' WHERE id='second'");
    const results=await Promise.allSettled([db.query("UPDATE users SET status='removed' WHERE id='owner'"),db.query("UPDATE users SET status='removed' WHERE id='second'")]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((await db.query("SELECT count(*)::int AS n FROM users WHERE org_id='org' AND status='active' AND org_role='owner'")).rows[0].n).toBe(1);
  });
  it('shares an active-member row lock with a protected downstream mutation',async()=> {
    const client=await db.connect(); await client.query('BEGIN');
    try {
      expect(await currentMember(client,'second',{lock:'share'})).toMatchObject({id:'second'});
      const other=await db.connect();
      try {
        await other.query('BEGIN'); await other.query("SET LOCAL lock_timeout='100ms'");
        await expect(other.query("UPDATE users SET status='removed' WHERE id='second'")).rejects.toMatchObject({code:'55P03'});
        await other.query('ROLLBACK');
      } finally { other.release(); }
    } finally {await client.query('ROLLBACK'); client.release();}
    await db.query("UPDATE users SET status='removed' WHERE id='second'");
    expect(await currentMember(db,'second',{lock:'share'})).toBeUndefined();
  });
  it('prevents session issuance after removal and acceptance after invitation revocation',async()=> {
    await store.linkIdentity('second','second',proof('second'));
    await db.query("UPDATE users SET status='removed' WHERE id='second'");
    await expect(store.createSession(proof('second'),tomorrow())).rejects.toThrow('denied');
    expect(await store.currentMember('second')).toBeUndefined();
    const invitation=await invite();
    const actions=await Promise.allSettled([store.acceptInvitation(invitation.token,proof('invited')),store.revokeInvitation('owner',invitation.invitationId)]);
    expect(actions[1].status).toBe('fulfilled');
    await expect(store.acceptInvitation(invitation.token,proof('invited'))).rejects.toThrow('denied');
    const row=(await db.query('SELECT used_at,revoked_at FROM member_invitations WHERE id=$1',[invitation.invitationId])).rows[0];
    expect(row.revoked_at).not.toBeNull();
  });
  it('refuses unassigned legacy users and ownerless organisations without changing rows',async()=> {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await db.query(schema);
    await db.query("INSERT INTO users(id,display_name) VALUES('legacy','Legacy')");
    const client=await db.connect();
    try {
      await expect(client.query(migration)).rejects.toThrow('explicit organisation'); await client.query('ROLLBACK');
      await client.query("INSERT INTO orgs VALUES('org','Example'); UPDATE users SET org_id='org'");
      await expect(client.query(migration)).rejects.toThrow('active owner'); await client.query('ROLLBACK');
      expect((await client.query('SELECT id,org_id FROM users')).rows).toEqual([{id:'legacy',org_id:'org'}]);
      await client.query("UPDATE users SET org_role='owner'"); await client.query(migration);
      expect(await store.currentMember('legacy')).toMatchObject({id:'legacy',status:'active'});
    } finally {client.release();}
  });
  it('refuses duplicate-email invitations and migration ambiguity atomically',async()=> {
    await expect(invite(' OWNER@example.invalid ')).rejects.toThrow('email_conflict');
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await db.query(schema);
    await db.query("INSERT INTO orgs VALUES('org','Example'); INSERT INTO users(id,display_name,primary_email,org_id,org_role) VALUES('a','A','same@example.invalid','org','owner'),('b','B',' SAME@example.invalid ','org','member');");
    const client=await db.connect();
    try { await expect(client.query(migration)).rejects.toThrow('duplicate emails'); await client.query('ROLLBACK'); } finally {client.release();}
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(2);
    expect((await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='users' AND column_name='status'")).rows[0].n).toBe(0);
  });
});
