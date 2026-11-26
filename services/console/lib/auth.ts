/** Node-only admission. An opaque cookie is authority only after a current database lookup.
 * `mayUse` is the one place that decides who may use what. `actingAddress` keeps the transport and
 * audit ADDRESS contract, after stable-id admission. Email is never used to find, link or
 * authorise a member. Do not import this in Edge code.
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
/** The three levels of the console. Every page, action and route names the level it needs.
 *  owner  - the installation's named owner (AGENT_OWNER_USER_ID), with the owner role, active.
 *  admin  - an active person whose role is admin. The owner sets it on Members.
 *  member - any other signed-in, active person. A role this code does not know is a member. */
export type ConsoleLevel = "owner" | "admin" | "member";
const NEEDS: Record<ConsoleLevel, number> = { member: 0, admin: 1, owner: 2 };
/** THE check: may this person use a page, action or route of this level? Everything below, and
 * every page, action and route, asks this one function; none decides by itself. It fails closed:
 * nobody signed in, an inactive person or a missing owner id is refused, a level it does not know
 * is read as owner, and a role it does not know holds no more than member. */
export function mayUse(member: Member | null | undefined, level: ConsoleLevel): member is Member {
  if (!member || member.status !== "active") return false;
  const designated = process.env.AGENT_OWNER_USER_ID?.trim();
  const holds = !!designated && member.id === designated && member.role === "owner" ? NEEDS.owner
    : member.role === "admin" ? NEEDS.admin : NEEDS.member;
  return holds >= (Object.hasOwn(NEEDS, level) ? NEEDS[level] : NEEDS.owner);
}
/** The level a person holds, for choosing what to show (the menu, where sign-in lands). It is
 * never a gate: a page, action or route asks mayUse through one of the guards below. */
export function consoleLevel(member: Member | null | undefined): ConsoleLevel | null {
  return mayUse(member, "owner") ? "owner" : mayUse(member, "admin") ? "admin" : mayUse(member, "member") ? "member" : null;
}
export async function sessionMember(raw: string | undefined): Promise<Member | null> {
  if (!raw) return null;
  try { return await members.sessionMember(raw) ?? null; } catch { throw new ConsoleAdmissionUnavailableError(); }
}
export async function signedInMember(): Promise<Member | null> {
  return sessionMember((await cookies()).get("lares_session")?.value);
}
/** Where someone is sent who opens a page above their level by its address. The page says why. */
export const REFUSED_PAGE = "/your-membership?refused=1";
/** For a page. Signed out: to sign-in. Signed in below the level: to Your membership, which says
 * why. The page's data is never read for them. */
export async function requirePage(level: ConsoleLevel): Promise<Member> {
  const member = await signedInMember();
  if (!member) redirect("/sign-in");
  if (!mayUse(member, level)) redirect(REFUSED_PAGE);
  return member;
}
/** For an action or a route that needs the person. Throws for anyone below the level. */
export async function requireAction(level: ConsoleLevel): Promise<Member> {
  const member = await signedInMember();
  if (!member || !mayUse(member, level)) throw new Error(`Console ${Object.hasOwn(NEEDS, level) ? level : "owner"} admission required`);
  return member;
}
/** For an action or a route that records who did it. Returns the signed-in person's OWN address
 * when they hold the level, otherwise null. It is never the owner's address for someone else: an
 * admin's action is recorded as the admin. Keeper and channel contracts take an address; it comes
 * only from the current admitted database member, never a provider email or a request field. */
export async function actingAddress(level: ConsoleLevel): Promise<string | null> {
  const member = await signedInMember();
  if (!member || !mayUse(member, level)) return null;
  try {
    const { rows } = await pool.query<{ primary_email: string | null }>(
      "SELECT primary_email FROM users WHERE id=$1 AND status='active' AND org_role=$2", [member.id, member.role]);
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
