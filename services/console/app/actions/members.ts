"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { members, requireConsoleMember, requireMember, verify } from "../../lib/auth";
import { MemberStoreError } from "@lares/agent-kit/member-store";
import { ConsoleAdmissionUnavailableError } from "../../lib/admission-error";
import { consoleRedirect } from "../../lib/console-oidc";
import { keeper, KeeperRefusedError, KeeperUnavailableError } from "../../lib/keeper-client";

async function memberOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof MemberStoreError) throw new Error("The member change was refused. Refresh membership and try again.");
    throw new ConsoleAdmissionUnavailableError();
  }
}
export type InviteResult = { url?: string; error?: string };
export async function createInvitation(_previous: InviteResult, form: FormData): Promise<InviteResult> {
  const actor = await requireConsoleMember();
  const role = form.get("role");
  if (role !== "member" && role !== "restricted" && role !== "owner") return { error: "Choose a member role." };
  const displayName = form.get("displayName"), email = form.get("email");
  if (typeof displayName !== "string" || typeof email !== "string" || displayName.length > 200 || email.length > 254) return { error: "Enter a name and email address." };
  try {
    const invitation = await members.inviteMember(actor.id, { displayName, email, role, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    const url = new URL("/invite", consoleRedirect()); url.searchParams.set("token", invitation.token);
    revalidatePath("/members");
    return { url: url.href };
  } catch (error) {
    if (error instanceof MemberStoreError) return { error: "The invitation could not be created. Check the address or try again." };
    throw new ConsoleAdmissionUnavailableError();
  }
}
export async function revokeInvitation(form: FormData): Promise<void> {
  const actor = await requireConsoleMember();
  const id = form.get("id"); if (typeof id !== "string") throw new Error("Invalid invitation");
  await memberOperation(() => members.revokeInvitation(actor.id, id));
  revalidatePath("/members");
}
export async function removeMember(form: FormData): Promise<void> {
  const actor = await requireConsoleMember();
  const targetId = form.get("memberId"); if (typeof targetId !== "string") throw new Error("Invalid member");
  if (targetId === actor.id) throw new Error("The designated console owner cannot be removed here");
  const sessionToken = (await cookies()).get("lares_session")?.value;
  if (!sessionToken) throw new Error("Console sign-in expired. Refresh membership and try again.");
  const auditAddress = await verify(sessionToken);
  if (!auditAddress) throw new Error("Console sign-in expired. Refresh membership and try again.");
  try { await keeper("member.remove", { sessionToken, targetMemberId: targetId }, auditAddress); }
  catch (error) {
    if (error instanceof KeeperRefusedError) throw new Error("The member change was refused. Refresh membership and try again.");
    if (error instanceof KeeperUnavailableError && error.outcomeMayBeUnknown) throw new Error("Member removal outcome is unknown. Refresh membership before trying again.");
    if (error instanceof KeeperUnavailableError) throw new ConsoleAdmissionUnavailableError();
    throw new ConsoleAdmissionUnavailableError();
  }
  revalidatePath("/members");
}
export async function signOutMember(form: FormData): Promise<void> {
  const actor = await requireConsoleMember();
  const targetId = form.get("memberId"); if (typeof targetId !== "string") throw new Error("Invalid member");
  await memberOperation(() => members.signOutAll(actor.id, targetId));
  if (targetId === actor.id) { (await cookies()).delete("lares_session"); redirect("/sign-in?signed-out=1"); }
  revalidatePath("/members");
}
/** Every active member can revoke all their own sessions, even without console access. */
export async function signOutEverywhere(): Promise<void> {
  const actor = await requireMember();
  await memberOperation(() => members.signOutAll(actor.id, actor.id));
  (await cookies()).delete("lares_session");
  redirect("/sign-in?signed-out=1");
}
