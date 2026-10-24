import { PgAccountStore } from "@lares/agent-kit/account-store";
import { pool } from "../../lib/db";
import { AddAccountForm, PersonalConsentPowerSelect } from "../../components/AddAccountForm";
import { RemoveAccountButton } from "../../components/RemoveAccountButton";
import type { ConnectedAccountView } from "@lares/agent-kit/authority-contract";
import Link from "next/link";
import { requireMember, isConsoleOwner } from "../../lib/auth";
import { signOutEverywhere } from "../actions/members";
import { OutsideDiscoverySection } from "../../components/OutsideDiscoverySection";
export const dynamic = "force-dynamic";
export default async function MembershipPage({ searchParams }: { searchParams: Promise<{ added?: string; error?: string }> }) {
  const member = await requireMember();
  const params = await searchParams;
  let accounts: ConnectedAccountView[] = [], unavailable = false;
  try { accounts = await new PgAccountStore(pool).list(member.id); } catch { unavailable = true; }
  return <div className="lares-page lares-stack">
    <h1>Your membership</h1>
    <p>Your membership is active. Your current role is {member.role}. New members begin with draft-and-ask automation.</p>
    <p>Private chat is available with agents you have permission to use. Your membership does not give access to other people's conversations, accounts or private files.</p>
    <section className="lares-stack" aria-label="Your personal accounts">
      <h2>Your personal accounts</h2>
      {params.added && <p role="status">Account consent saved. Available agent tools determine which account reads can be used.</p>}
      {params.error && <p role="alert">Account consent could not be saved. Start again here.</p>}
      <p>Consent is stored for your own account. Private chat can use the available personal mailbox and calendar read tools. Disconnecting stops Lares account access; revoke the provider grant in your Google or Microsoft account settings if needed.</p>
      <p>Provider permission alone does not enable agent writes. Sending will also require this agent's personal mailbox permission set to write-with-confirm and your approval of the exact message. Mail sending is not yet available.</p>
      <p>Read is selected by default. Google or Microsoft may retain permissions you granted earlier; selecting read does not revoke those broader provider permissions.</p>
      {unavailable ? <p role="status">Personal accounts unavailable. Try again later.</p> : accounts.length ? accounts.map(account => <div key={account.id} className="lares-surface lares-stack">
        <strong>{account.providerAccount.label}</strong><span>{account.status}</span>
        {(account.connectorId === "google" || account.connectorId === "microsoft") && <form method="post" action={`/api/accounts/${account.connectorId}/start`}>
          <input type="hidden" name="intent" value="reconnect" />
          <input type="hidden" name="accountId" value={account.id} />
          <input type="hidden" name="generation" value={account.generation} />
          <PersonalConsentPowerSelect />
          <button type="submit">Reconnect {account.connectorId === "google" ? "Google" : "Microsoft"} account</button>
        </form>}
        {account.status !== "revoked" && <RemoveAccountButton email={account.providerAccount.label} accountId={account.id} generation={account.generation} />}
      </div>) : <p>No personal accounts connected.</p>}
      {!unavailable && <><AddAccountForm /><form method="post" action="/api/accounts/microsoft/start">
        <input type="hidden" name="intent" value="new" />
        <PersonalConsentPowerSelect />
        <button type="submit">Connect Microsoft work account</button>
        <p>Your own work mailbox and primary calendar only. The installation needs a separate Microsoft data client; tenant administrator consent may be required. Personal Outlook and shared mailboxes are unavailable.</p>
      </form></>}
    </section>
    <OutsideDiscoverySection />
    <Link href="/chat">Open private chat →</Link>
    {isConsoleOwner(member) && <Link href="/">Open the owner console →</Link>}
    <form method="post" action="/api/auth/logout"><button type="submit">Sign out</button></form>
    <form action={signOutEverywhere}><button type="submit">Sign out everywhere</button></form>
  </div>;
}
