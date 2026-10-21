import Link from "next/link";
import { PageHeader } from "@lares/ui/patterns";
import { requireConsolePage, members } from "../../lib/auth";
import { InviteMember } from "../../components/InviteMember";
import { removeMember, revokeInvitation, signOutMember } from "../actions/members";
export const dynamic = "force-dynamic";
export default async function MembersPage() {
  const actor = await requireConsolePage();
  const [directory, invitations] = await Promise.all([members.listMembers(actor.id), members.listInvitations(actor.id)]);
  return <div className="lares-page lares-stack">
    <PageHeader title="Members" description="Manage sign-in invitations and current membership." />
    <p>Invited members can view their own membership and sign out. Shared console screens remain limited to the designated existing owner while resource access is being integrated. An owner role does not grant access to another person's private data.</p>
    <Link href="/membership">Your membership →</Link>
    <InviteMember />
    <section className="lares-surface"><h2 className="lares-section-title">Member records</h2>
      <ul className="lares-data-list">{directory.map(({ member, displayName, email }) => <li key={member.id}>
        <strong>{displayName}</strong> · {email} · {member.role} · {member.status}
        {member.status === "active" && <form action={signOutMember}><input type="hidden" name="memberId" value={member.id} /><button type="submit">Sign out all sessions</button></form>}
        {member.status !== "removed" && member.id !== actor.id && <form action={removeMember}><input type="hidden" name="memberId" value={member.id} /><button type="submit">Remove member access</button></form>}
      </li>)}</ul>
    </section>
    <section className="lares-surface"><h2 className="lares-section-title">Open invitations</h2>
      {invitations.length ? <ul className="lares-data-list">{invitations.map(invite => <li key={invite.id}>
        {directory.find(entry => entry.member.id === invite.memberId)?.displayName} · Expires {invite.expiresAt}
        <form action={revokeInvitation}><input type="hidden" name="id" value={invite.id} /><button type="submit">Revoke invitation</button></form>
      </li>)}</ul> : <p>No open invitations.</p>}
    </section>
  </div>;
}
