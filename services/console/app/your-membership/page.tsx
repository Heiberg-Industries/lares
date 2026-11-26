import { Notice, Page, PageHeader, Row, Rows } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Card } from "@lares/ui/primitives/card";
import Link from "next/link";
import { requirePage, consoleLevel } from "../../lib/auth";
import { signOutEverywhere } from "../actions/members";
import { OutsideDiscoverySection } from "../../components/OutsideDiscoverySection";
import { PrivateMetadataDeviceSection } from "../../components/PrivateMetadataDeviceSection";
export const dynamic = "force-dynamic";

/** What each stored role means, in a sentence. An unknown role is said plainly rather than shown as its stored word. */
const ROLE_WORDS: Record<string, string> = {
  owner: "You are an owner.",
  admin: "You are an admin.",
  member: "You are a member.",
  restricted: "You are a member with limited access.",
};

export default async function MembershipPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const member = await requirePage("member");
  const level = consoleLevel(member);
  // Set by lib/auth.ts when someone opens a page above their level by its address.
  const refused = (await searchParams).refused !== undefined;
  return <Page width="narrow" className="lares-stack">
    <PageHeader title="Your membership" />
    {refused && <Notice tone="needs-you">You were brought here because the page you opened is not allowed for your role. {level === "admin" ? "Creating and editing agents, members and roles, backups and the general settings are for the owner of this installation." : "It is for the owner of this installation, or a person the owner made an admin."}</Notice>}
    <Notice tone="success">Your membership is active. {ROLE_WORDS[member.role] ?? "Your kind of membership could not be read."}</Notice>
    <Card>
      <Rows label="What your membership gives you">
        <Row title="Private chat" description="Private chat is available with agents you have permission to use. Your membership does not give access to other people's conversations, accounts or private files."
          control={<Button variant="outline" size="sm" asChild><Link href="/chat">Open private chat</Link></Button>} />
        <Row title="Your accounts" description="Where you connect Google or Microsoft and see which agents use them."
          control={<Button variant="outline" size="sm" asChild><Link href="/your-accounts">Your accounts</Link></Button>} />
        <Row title="How agents act for a new member" description="For a new member, agents prepare a draft and ask before they do anything." />
        {level === "owner" && <Row title="Owner console" description="Everything the owner of this installation manages."
          control={<Button variant="outline" size="sm" asChild><Link href="/">Open the owner console</Link></Button>} />}
        {level === "admin" && <Row title="Console" description="The shared pages you may use as an admin: the agents, connections, tools, activity, quiet hours and alert routing. Creating and editing agents, members and roles, backups and the general settings stay with the owner."
          control={<Button variant="outline" size="sm" asChild><Link href="/">Open the console</Link></Button>} />}
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
