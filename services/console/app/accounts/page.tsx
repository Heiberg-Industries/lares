import Link from "next/link";
import { PgAccountStore } from "@lares/agent-kit/account-store";
import type { ConnectedAccountView } from "@lares/agent-kit/authority-contract";
import { Page, PageHeader } from "@lares/ui/patterns";
import { pool } from "../../lib/db";
import { requireMember, isConsoleOwner } from "../../lib/auth";
import { listAgentUses } from "../../lib/agent-mailbox";
import { listAgents } from "../../lib/agents";
import { agentNames } from "../../lib/connection-words";
import { buildServiceRows } from "../../lib/your-accounts";
import { AccountServiceRow } from "../../components/AccountServiceRow";
import { RemoveAccountButton } from "../../components/RemoveAccountButton";
import { listGoogleAccounts } from "../../lib/accounts";
export const dynamic = "force-dynamic";
export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ added?: string; error?: string }> }) {
  const member = await requireMember();
  const params = await searchParams;
  let accounts: ConnectedAccountView[] = [], unavailable = false;
  let uses: { agent: string; accountId: string }[] = [];
  try { accounts = await new PgAccountStore(pool).list(member.id); } catch { unavailable = true; }
  try { uses = await listAgentUses(member); } catch { /* the rows still show without it */ }
  const agents = uses.length > 0 ? await listAgents() : [];
  const rows = buildServiceRows(accounts, uses).map(r => ({ ...r, usedBy: agentNames(r.usedBy, agents) }));
  // Mailboxes from the older way of connecting mail. Owner only; nothing shows if they cannot be read.
  const older = isConsoleOwner(member) ? await listGoogleAccounts().then(v => v.unavailable ? [] : v.accounts, () => []) : [];
  return <Page width="narrow" className="lares-stack">
    <PageHeader title="Your accounts" description="Accounts you connect stay yours. An agent works on one only when you choose it on that agent's page." />
    {params.added && <p role="status">Account connected.</p>}
    {params.error && <p role="alert">The account could not be connected. Try again.</p>}
    {unavailable ? <p role="status">Your accounts are unavailable. Try again later.</p> : <section className="lares-service-list" aria-label="Services">
      {rows.map(row => <AccountServiceRow key={row.service} row={row} attention={row.attention} />)}
    </section>}
    {older.length > 0 && <section className="lares-stack" aria-label="Older mailbox connections">
      <h2 className="lares-section-title">Older mailbox connections</h2>
      <p className="lares-muted">These came from an older way of connecting mail. Nothing uses them any more. You can remove them.</p>
      {older.map(a => <div key={a.email} className="lares-actions"><span>{a.email}</span><RemoveAccountButton email={a.email} /></div>)}
    </section>}
    <p className="lares-muted">More services come later. Shared tools for the whole installation are under {isConsoleOwner(member) ? <Link href="/integrations">Integrations</Link> : "Integrations"}.</p>
  </Page>;
}
