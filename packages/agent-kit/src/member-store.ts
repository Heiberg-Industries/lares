/** Server-only storage primitives. Proof must come from a trusted admission adapter using a
 * maintained provider verifier. These functions do not validate provider tokens and must never
 * be exposed as model-facing tools. Member ids supplied here require authenticated admission.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { memberSchema, providerIdentitySchema, type Member, type ProviderIdentity } from './authority-contract.js';
import type { OrgRole } from './identity.js';

export interface VerifiedProviderProof { identity: ProviderIdentity; verifiedAt: Date }
export class MemberStoreError extends Error {
  constructor(public readonly code: 'denied' | 'invalid' | 'identity_conflict' | 'email_conflict') {
    super(`Member operation refused: ${code}`);
    this.name = 'MemberStoreError';
  }
}
type MemberRow = { id: string; org_id: string; org_role: OrgRole; status: Member['status']; automation_mode: Member['automationMode'] };
const columns = 'id, org_id, org_role, status, automation_mode';
function view(r: MemberRow): Member {
  return memberSchema.parse({ id: r.id, organisationId: r.org_id, role: r.org_role, status: r.status, automationMode: r.automation_mode });
}
function hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function token(): string { return randomBytes(32).toString('base64url'); }
function validToken(value: string): boolean { return /^[A-Za-z0-9_-]{43}$/.test(value); }
function proofIdentity(proof: VerifiedProviderProof): ProviderIdentity {
  if (!(proof.verifiedAt instanceof Date) || !Number.isFinite(proof.verifiedAt.getTime()) ||
      Date.now() - proof.verifiedAt.getTime() > 300_000 || proof.verifiedAt.getTime() > Date.now() + 30_000)
    throw new MemberStoreError('invalid');
  return providerIdentitySchema.parse(proof.identity);
}
function expiry(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()) || value.getTime() <= Date.now()) throw new MemberStoreError('invalid');
}

/** A locked lookup belongs inside the caller's transaction; a standalone lookup is only a snapshot. */
export async function currentMember(db: Pick<PoolClient, 'query'>, id: string, options: { lock?: 'share'|'update' } = {}): Promise<Member | undefined> {
  const lock=options.lock==='update'?' FOR UPDATE':options.lock==='share'?' FOR SHARE':'';
  const { rows } = await db.query<MemberRow>(`SELECT ${columns} FROM users WHERE id=$1 AND status='active' AND org_id IS NOT NULL${lock}`, [id]);
  return rows[0] && view(rows[0]);
}

/** The opaque session must still belong to the expected member after asynchronous work.
 * A shared lock belongs inside the protected mutation's transaction and holds both the
 * session and member current until commit; standalone reads provide only a snapshot. */
export async function currentSession(db: Pick<PoolClient, 'query'>, raw: string,
  expectedMemberId?: string, options: { lock?: 'share' } = {}): Promise<Member | undefined> {
  if (!validToken(raw)) return undefined;
  const { rows } = await db.query<MemberRow>(`SELECT ${columns.split(', ').map(c=>'u.'+c).join(', ')}
    FROM member_sessions s JOIN users u ON u.id=s.member_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND u.status='active' AND u.org_id IS NOT NULL${expectedMemberId === undefined ? '' : ' AND s.member_id=$2'}${options.lock === 'share' ? ' FOR SHARE OF s,u' : ''}`,
    expectedMemberId === undefined ? [hash(raw)] : [hash(raw), expectedMemberId]);
  return rows[0] && view(rows[0]);
}

export class PgMemberStore {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try { await db.query('BEGIN'); const result = await fn(db); await db.query('COMMIT'); return result; }
    catch (e) { await db.query('ROLLBACK'); throw e; }
    finally { db.release(); }
  }
  /** Use inside the same transaction as a protected mutation when atomic freshness is needed. */
  async currentMember(id: string): Promise<Member | undefined> {
    return currentMember(this.pool, id);
  }
  private async lockOrganisation(db: PoolClient, memberId: string): Promise<void> {
    const r = await db.query('SELECT o.id FROM orgs o JOIN users u ON u.org_id=o.id WHERE u.id=$1 FOR UPDATE OF o', [memberId]);
    if (!r.rowCount) throw new MemberStoreError('denied');
  }
  private async active(db: PoolClient, id: string): Promise<Member> {
    const { rows } = await db.query<MemberRow>(`SELECT ${columns} FROM users WHERE id=$1 AND status='active' AND org_id IS NOT NULL FOR UPDATE`, [id]);
    if (!rows[0]) throw new MemberStoreError('denied');
    return view(rows[0]);
  }
  private async authorized(db: PoolClient, actorId: string, targetId: string, ownerOnly = false): Promise<Member> {
    await this.lockOrganisation(db, actorId);
    const actor = await this.active(db, actorId);
    const { rows } = await db.query<MemberRow>(`SELECT ${columns} FROM users WHERE id=$1 FOR UPDATE`, [targetId]);
    const target = rows[0] && view(rows[0]);
    if (!target || target.organisationId !== actor.organisationId || (actor.role !== 'owner' && (ownerOnly || actorId !== targetId)))
      throw new MemberStoreError('denied');
    return target;
  }
  /** Owner-only directory metadata. Never returns identity proofs, token values or hashes. */
  async listMembers(actorId: string): Promise<{ member: Member; displayName: string; email: string | null }[]> {
    return this.transaction(async db => {
      await this.lockOrganisation(db, actorId);
      const actor = await this.active(db, actorId);
      if (actor.role !== 'owner') throw new MemberStoreError('denied');
      const { rows } = await db.query<MemberRow & { display_name: string; primary_email: string | null }>(
        `SELECT ${columns}, display_name, primary_email FROM users WHERE org_id=$1 ORDER BY created_at,id`, [actor.organisationId]);
      return rows.map(row => ({ member: view(row), displayName: row.display_name, email: row.primary_email }));
    });
  }
  async listInvitations(actorId: string): Promise<{ id: string; memberId: string; expiresAt: string }[]> {
    return this.transaction(async db => {
      await this.lockOrganisation(db, actorId);
      const actor = await this.active(db, actorId);
      if (actor.role !== 'owner') throw new MemberStoreError('denied');
      const { rows } = await db.query<{ id: string; member_id: string; expires_at: Date }>(
        `SELECT i.id,i.member_id,i.expires_at FROM member_invitations i JOIN users u ON u.id=i.member_id
         WHERE u.org_id=$1 AND u.status='invited' AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>clock_timestamp() ORDER BY i.created_at,i.id`, [actor.organisationId]);
      return rows.map(row => ({ id: row.id, memberId: row.member_id, expiresAt: row.expires_at.toISOString() }));
    });
  }
  async inviteMember(actorId: string, input: { displayName: string; email: string; role: OrgRole; expiresAt: Date }): Promise<{ member: Member; invitationId: string; token: string }> {
    expiry(input.expiresAt);
    const email = input.email.trim().toLowerCase();
    if (!z.email().safeParse(email).success || !input.displayName.trim() || !['owner','member','restricted'].includes(input.role)) throw new MemberStoreError('invalid');
    return this.transaction(async db => {
      await this.lockOrganisation(db, actorId);
      const actor = await this.active(db, actorId);
      if (actor.role !== 'owner') throw new MemberStoreError('denied');
      const id = randomUUID(), invitationId = randomUUID(), raw = token();
      let rows: MemberRow[];
      try { ({ rows } = await db.query<MemberRow>(`INSERT INTO users(id,org_id,org_role,status,display_name,primary_email) VALUES($1,$2,$3,'invited',$4,$5) RETURNING ${columns}`, [id, actor.organisationId, input.role, input.displayName.trim(), email])); }
      catch (e) { if ((e as {code?:string}).code === '23505') throw new MemberStoreError('email_conflict'); throw e; }
      await db.query('INSERT INTO member_invitations(id,member_id,token_hash,expires_at) VALUES($1,$2,$3,$4)', [invitationId,id,hash(raw),input.expiresAt]);
      return { member: view(rows[0]), invitationId, token: raw };
    });
  }
  private async bind(db: PoolClient, memberId: string, identity: ProviderIdentity): Promise<void> {
    const { rows } = await db.query<{member_id:string}>(`INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(issuer,subject,tenant_id) DO UPDATE SET member_id=member_provider_identities.member_id RETURNING member_id`, [memberId, identity.issuer,identity.subject,identity.tenantId ?? '']);
    if (rows[0].member_id !== memberId) throw new MemberStoreError('identity_conflict');
  }
  async acceptInvitation(raw: string, proof: VerifiedProviderProof): Promise<Member> {
    const identity = proofIdentity(proof);
    if (!validToken(raw)) throw new MemberStoreError('denied');
    return this.transaction(async db => {
      // Resolve only to choose the lock; all invitation conditions are rechecked after locking.
      const found = await db.query<{member_id:string}>('SELECT member_id FROM member_invitations WHERE token_hash=$1', [hash(raw)]);
      if (!found.rows[0]) throw new MemberStoreError('denied');
      await this.lockOrganisation(db, found.rows[0].member_id);
      const r = await db.query<{member_id:string}>(`UPDATE member_invitations SET used_at=clock_timestamp() WHERE token_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING member_id`, [hash(raw)]);
      if (!r.rows[0]) throw new MemberStoreError('denied');
      const id = r.rows[0].member_id;
      const u = await db.query<MemberRow>(`SELECT ${columns} FROM users WHERE id=$1 AND status='invited' FOR UPDATE`,[id]);
      if (!u.rows[0]) throw new MemberStoreError('denied');
      await this.bind(db,id,identity);
      const updated = await db.query<MemberRow>(`UPDATE users SET status='active' WHERE id=$1 RETURNING ${columns}`,[id]);
      return view(updated.rows[0]);
    });
  }
  async linkIdentity(actorId: string, targetId: string, proof: VerifiedProviderProof): Promise<void> {
    const identity = proofIdentity(proof);
    await this.transaction(async db => {
      const target = await this.authorized(db,actorId,targetId);
      if (target.status !== 'active') throw new MemberStoreError('denied');
      await this.bind(db,targetId,identity);
    });
  }
  async memberForIdentity(identity: ProviderIdentity): Promise<Member | undefined> {
    const p = providerIdentitySchema.parse(identity);
    const { rows } = await this.pool.query<MemberRow>(`SELECT ${columns.split(', ').map(c=>'u.'+c).join(', ')} FROM users u JOIN member_provider_identities p ON p.member_id=u.id WHERE p.issuer=$1 AND p.subject=$2 AND p.tenant_id=$3 AND u.status='active' AND u.org_id IS NOT NULL`,[p.issuer,p.subject,p.tenantId ?? '']);
    return rows[0] && view(rows[0]);
  }
  async createSession(proof: VerifiedProviderProof, expiresAt: Date): Promise<{ member: Member; sessionId: string; token: string }> {
    const p = proofIdentity(proof); expiry(expiresAt);
    return this.transaction(async db => {
      const r = await db.query<{member_id:string}>('SELECT member_id FROM member_provider_identities WHERE issuer=$1 AND subject=$2 AND tenant_id=$3',[p.issuer,p.subject,p.tenantId ?? '']);
      if (!r.rows[0]) throw new MemberStoreError('denied');
      const id = r.rows[0].member_id;
      await this.lockOrganisation(db,id);
      const member = await this.active(db,id), sessionId = randomUUID(), raw = token();
      await db.query('INSERT INTO member_sessions(id,member_id,token_hash,expires_at) VALUES($1,$2,$3,$4)',[sessionId,id,hash(raw),expiresAt]);
      return { member, sessionId, token: raw };
    });
  }
  async sessionMember(raw: string): Promise<Member | undefined> {
    return currentSession(this.pool, raw);
  }
  async revokeSession(raw: string): Promise<void> {
    if (validToken(raw)) await this.pool.query('UPDATE member_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE token_hash=$1',[hash(raw)]);
  }
  async signOutAll(actorId: string, targetId: string): Promise<void> {
    await this.transaction(async db => {
      await this.authorized(db,actorId,targetId);
      await db.query('UPDATE member_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE member_id=$1',[targetId]);
    });
  }
  async revokeInvitation(actorId: string, invitationId: string): Promise<void> {
    await this.transaction(async db => {
      const r = await db.query<{member_id:string}>('SELECT member_id FROM member_invitations WHERE id=$1',[invitationId]);
      if (!r.rows[0]) throw new MemberStoreError('denied');
      await this.authorized(db,actorId,r.rows[0].member_id,true);
      await db.query('UPDATE member_invitations SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1',[invitationId]);
    });
  }
}
