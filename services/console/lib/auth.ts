/** Node-only admission. An opaque cookie is authority only after a current database lookup.
 * `verify` retains the legacy transport/audit ADDRESS contract, after stable-id admission.
 * Email is never used to find, link or authorise a member. Do not import this in Edge code.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PgMemberStore } from "@lares/agent-kit/member-store";
import type { Member } from "@lares/agent-kit/authority-contract";
import { z } from "zod";
import { pool } from "./db";
import { ConsoleAdmissionUnavailableError } from "./admission-error";

export const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
export const members = new PgMemberStore(pool);
export function isConsoleOwner(member: Member): boolean {
  const designated = process.env.AGENT_OWNER_USER_ID?.trim();
  return !!designated && member.id === designated && member.role === "owner" && member.status === "active";
}
export async function sessionMember(raw: string | undefined): Promise<Member | null> {
  if (!raw) return null;
  try { return await members.sessionMember(raw) ?? null; } catch { throw new ConsoleAdmissionUnavailableError(); }
}
export async function signedInMember(): Promise<Member | null> {
  return sessionMember((await cookies()).get("lares_session")?.value);
}
export async function requireMember(): Promise<Member> {
  const member = await signedInMember();
  if (!member) redirect("/sign-in");
  return member;
}
/** Every existing console screen reads installation-wide data. Keep it to the designated
 * existing owner until its individual data/resource policy is integrated and tested. */
export async function requireConsolePage(): Promise<Member> {
  const member = await requireMember();
  if (!isConsoleOwner(member)) redirect("/membership");
  return member;
}
export async function requireConsoleMember(): Promise<Member> {
  const member = await signedInMember();
  if (!member || !isConsoleOwner(member)) throw new Error("Console owner admission required");
  return member;
}
/** Legacy keeper and channel contracts take an address. Obtain it only from the current
 * admitted database member, never a provider email, request field or allow-list. */
export async function verify(raw: string | undefined): Promise<string | null> {
  const member = await sessionMember(raw);
  if (!member || !isConsoleOwner(member)) return null;
  try {
    const { rows } = await pool.query<{ primary_email: string | null }>(
      "SELECT primary_email FROM users WHERE id=$1 AND status='active' AND org_role='owner'", [member.id]);
    const address = rows[0]?.primary_email;
    return address && /^[^\s,;]+@[^\s,;]+$/.test(address) && address.length <= 254 ? address : null;
  } catch { throw new ConsoleAdmissionUnavailableError(); }
}
/** Audit-only address for a member action after stable-ID session admission. It is never
 * authority: Keeper independently rechecks the cookie session and resource grant. */
export async function memberAuditAddress(memberId:string):Promise<string|null>{
  try{
    const {rows}=await pool.query<{primary_email:string|null}>(
      "SELECT primary_email FROM users WHERE id=$1 AND status='active'",[memberId]);
    const address=rows[0]?.primary_email;
    return address&&z.string().email().max(254).safeParse(address).success?address:null;
  }catch{throw new ConsoleAdmissionUnavailableError();}
}
