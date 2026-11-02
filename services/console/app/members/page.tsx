import Link from "next/link";
import { PageHeader, Page } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { memberAuditAddress, requireConsolePage, members } from "../../lib/auth";
import { InviteMember } from "../../components/InviteMember";
import { removeMember, revokeInvitation, signOutMember } from "../actions/members";
import { listInitialMemberBudgetStatus } from "../../lib/initial-member-budget";
import { cookies } from "next/headers";
import { InitialMemberBudgetSetup } from "../../components/InitialMemberBudgetSetup";
export const dynamic = "force-dynamic";
export default async function MembersPage() {
  const actor = await requireConsolePage();
  const sessionToken=(await cookies()).get("lares_session")?.value??"";
  const auditActor=await memberAuditAddress(actor.id);
  const [directory, invitations, budgetStatus] = await Promise.all([
    members.listMembers(actor.id),members.listInvitations(actor.id),
    auditActor?listInitialMemberBudgetStatus(sessionToken,auditActor):{available:false as const,members:[] as []},
  ]);
  const budgetByMember=new Map(budgetStatus.members.map(status=>[status.memberId,status]));
  return <Page className="lares-stack">
    <PageHeader title="Members" description="Manage sign-in invitations and current membership." />
    <p>Invited members can view their own membership and sign out. Shared console screens remain limited to the designated existing owner while resource access is being integrated. An owner role does not grant access to another person's private data.</p>
    <Link href="/membership">Your membership →</Link>
    <InviteMember />
    <InitialMemberBudgetSetup members={directory.map(({member,displayName})=>({
      id:member.id,displayName,eligible:budgetByMember.get(member.id)?.eligible===true,
      setupComplete:budgetByMember.get(member.id)?.setupComplete===true,
    }))} unavailable={!budgetStatus.available}/>
    <section className="lares-surface"><h2 className="lares-section-title">Member records</h2>
      <ul className="lares-data-list">{directory.map(({ member, displayName, email }) => <li key={member.id}>
        <strong>{displayName}</strong> · {email} · {member.role} · {member.status}
        <div className="lares-actions lares-row-actions">
          {member.status === "active" && <form action={signOutMember}><input type="hidden" name="memberId" value={member.id} /><Button type="submit" variant="outline">Sign out all sessions</Button></form>}
          {member.status !== "removed" && member.id !== actor.id && <form action={removeMember}><input type="hidden" name="memberId" value={member.id} /><Button type="submit" variant="destructive">Remove member access</Button></form>}
        </div>
      </li>)}</ul>
    </section>
    <section className="lares-surface"><h2 className="lares-section-title">Open invitations</h2>
      {invitations.length ? <ul className="lares-data-list">{invitations.map(invite => <li key={invite.id}>
        {directory.find(entry => entry.member.id === invite.memberId)?.displayName} · Expires {invite.expiresAt}
        <form action={revokeInvitation} className="lares-row-actions"><input type="hidden" name="id" value={invite.id} /><Button type="submit" variant="outline">Revoke invitation</Button></form>
      </li>)}</ul> : <p>No open invitations.</p>}
    </section>
  </Page>;
}
