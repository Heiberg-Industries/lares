import Link from "next/link";
import { PageHeader, Page, Row, Rows } from "@lares/ui/patterns";
import { Badge } from "@lares/ui/primitives/badge";
import { Button } from "@lares/ui/primitives/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import { memberAuditAddress, requireConsolePage, members } from "../../lib/auth";
import { InviteMember } from "../../components/InviteMember";
import { removeMember, revokeInvitation, signOutMember } from "../actions/members";
import { listInitialMemberBudgetStatus } from "../../lib/initial-member-budget";
import { cookies } from "next/headers";
import { InitialMemberBudgetSetup } from "../../components/InitialMemberBudgetSetup";
import { roleWords, STATUS_WORDS } from "../../lib/member-roles";
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
  return <Page>
    <PageHeader
      title="Members"
      description="Who can sign in to this installation, and the invitations that are still open."
      actions={<Button variant="outline" asChild><Link href="/your-membership">Your membership →</Link></Button>}
    />
    <p className="lares-muted">A person you invite can see their own membership page and sign out. The rest of this console stays open only to the owner who set up this installation. Being an owner never gives access to another person's private data.</p>
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>Members</CardTitle>
        <CardDescription>Each person, their role and what the role means.</CardDescription>
      </CardHeader>
      <Rows label="Members">{directory.map(({ member, displayName, email }) => {
        const role = roleWords(member.role);
        const status = STATUS_WORDS[member.status];
        return <Row key={member.id}
          title={<>{displayName} <Badge variant={status?.variant ?? "neutral"}>{status?.word ?? "Unknown status"}</Badge></>}
          description={<>{email} · <strong>{role.name}.</strong> {role.meaning}</>}
          control={<>
            {member.status === "active" && <form action={signOutMember}><input type="hidden" name="memberId" value={member.id} /><Button type="submit" variant="outline" size="sm">Sign out all sessions</Button></form>}
            {member.status !== "removed" && member.id !== actor.id && <form action={removeMember}><input type="hidden" name="memberId" value={member.id} /><Button type="submit" variant="destructive" size="sm">Remove member access</Button></form>}
          </>}
        />;
      })}</Rows>
    </Card>
    <InviteMember />
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>Open invitations</CardTitle>
      </CardHeader>
      {invitations.length ? <Rows label="Open invitations">{invitations.map(invite => <Row key={invite.id}
        title={directory.find(entry => entry.member.id === invite.memberId)?.displayName ?? "Invited person"}
        description={<>Expires {invite.expiresAt.slice(0, 16).replace("T", " ")} UTC</>}
        control={<form action={revokeInvitation}><input type="hidden" name="id" value={invite.id} /><Button type="submit" variant="outline" size="sm">Revoke invitation</Button></form>}
      />)}</Rows> : <CardContent><p className="lares-muted">No open invitations. An invitation you create appears here until it is used, revoked or 24 hours old.</p></CardContent>}
    </Card>
    <InitialMemberBudgetSetup members={directory.map(({member,displayName})=>({
      id:member.id,displayName,eligible:budgetByMember.get(member.id)?.eligible===true,
      setupComplete:budgetByMember.get(member.id)?.setupComplete===true,
    }))} unavailable={!budgetStatus.available}/>
  </Page>;
}
