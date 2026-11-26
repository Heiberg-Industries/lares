import { Notice, Page, PageHeader, Row, Rows } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Card } from "@lares/ui/primitives/card";
import Link from "next/link";
import { requireMember, isConsoleOwner } from "../../lib/auth";
import { signOutEverywhere } from "../actions/members";
import { OutsideDiscoverySection } from "../../components/OutsideDiscoverySection";
import { PrivateMetadataDeviceSection } from "../../components/PrivateMetadataDeviceSection";
export const dynamic = "force-dynamic";

/** What each stored role means, in a sentence. An unknown role is said plainly rather than shown as its stored word. */
const ROLE_WORDS: Record<string, string> = {
  owner: "You are an owner.",
  member: "You are a member.",
  restricted: "You are a member with limited access.",
};

export default async function MembershipPage() {
  const member = await requireMember();
  return <Page width="narrow" className="lares-stack">
    <PageHeader title="Your membership" />
    <Notice tone="success">Your membership is active. {ROLE_WORDS[member.role] ?? "Your kind of membership could not be read."}</Notice>
    <Card>
      <Rows label="What your membership gives you">
        <Row title="Private chat" description="Private chat is available with agents you have permission to use. Your membership does not give access to other people's conversations, accounts or private files."
          control={<Button variant="outline" size="sm" asChild><Link href="/chat">Open private chat</Link></Button>} />
        <Row title="Your accounts" description="Where you connect Google or Microsoft and see which agents use them."
          control={<Button variant="outline" size="sm" asChild><Link href="/your-accounts">Your accounts</Link></Button>} />
        <Row title="How agents act for a new member" description="For a new member, agents prepare a draft and ask before they do anything." />
        {isConsoleOwner(member) && <Row title="Owner console" description="Everything the owner of this installation manages."
          control={<Button variant="outline" size="sm" asChild><Link href="/">Open the owner console</Link></Button>} />}
      </Rows>
    </Card>
    <OutsideDiscoverySection memberId={member.id} />
    <PrivateMetadataDeviceSection />
    <div className="lares-actions">
      <form method="post" action="/api/auth/logout"><Button type="submit" variant="outline">Sign out</Button></form>
      <form action={signOutEverywhere}><Button type="submit" variant="outline">Sign out everywhere</Button></form>
    </div>
  </Page>;
}
