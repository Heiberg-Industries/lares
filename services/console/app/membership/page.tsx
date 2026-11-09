import { Page, PageHeader } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import Link from "next/link";
import { requireMember, isConsoleOwner } from "../../lib/auth";
import { signOutEverywhere } from "../actions/members";
import { OutsideDiscoverySection } from "../../components/OutsideDiscoverySection";
import { PrivateMetadataDeviceSection } from "../../components/PrivateMetadataDeviceSection";
export const dynamic = "force-dynamic";
export default async function MembershipPage() {
  const member = await requireMember();
  return <Page width="narrow" className="lares-stack">
    <PageHeader title="Your membership" />
    <p>Your membership is active. Your current role is {member.role}. New members begin with draft-and-ask automation.</p>
    <p>Private chat is available with agents you have permission to use. Your membership does not give access to other people's conversations, accounts or private files.</p>
    <p><Link href="/accounts">Your accounts</Link> is where you connect Google or Microsoft and see which agents use them.</p>
    <OutsideDiscoverySection memberId={member.id} />
    <PrivateMetadataDeviceSection />
    <Link href="/chat">Open private chat →</Link>
    {isConsoleOwner(member) && <Link href="/">Open the owner console →</Link>}
    <div className="lares-actions">
      <form method="post" action="/api/auth/logout"><Button type="submit" variant="outline">Sign out</Button></form>
      <form action={signOutEverywhere}><Button type="submit" variant="outline">Sign out everywhere</Button></form>
    </div>
  </Page>;
}
