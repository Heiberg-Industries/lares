import Link from "next/link";
import { requireMember, isConsoleOwner } from "../../lib/auth";
import { signOutEverywhere } from "../actions/members";
export const dynamic = "force-dynamic";
export default async function MembershipPage() {
  const member = await requireMember();
  return <main className="lares-page lares-stack" id="main-content">
    <h1>Your membership</h1>
    <p>Your membership is active. Your current role is {member.role}. New members begin with draft-and-ask automation.</p>
    <p>Shared console access is still being integrated. Your membership does not give access to other people's conversations, accounts or private files.</p>
    {isConsoleOwner(member) && <Link href="/">Open the owner console →</Link>}
    <form method="post" action="/api/auth/logout"><button type="submit">Sign out</button></form>
    <form action={signOutEverywhere}><button type="submit">Sign out everywhere</button></form>
  </main>;
}
