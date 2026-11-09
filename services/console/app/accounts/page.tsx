import Link from "next/link";
import { PgAccountStore } from "@lares/agent-kit/account-store";
import type { ConnectedAccountView } from "@lares/agent-kit/authority-contract";
import { Page, PageHeader } from "@lares/ui/patterns";
import { pool } from "../../lib/db";
import { requireMember, isConsoleOwner } from "../../lib/auth";
import { accountStatusLabel, listAgentUses } from "../../lib/agent-mailbox";
import { buildServiceRows } from "../../lib/your-accounts";
import { AccountServiceRow } from "../../components/AccountServiceRow";
export const dynamic = "force-dynamic";
export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ added?: string; error?: string }> }) {
  const member = await requireMember();
  const params = await searchParams;
  let accounts: ConnectedAccountView[] = [], unavailable = false;
  let uses: { agent: string; accountId: string }[] = [];
  try { accounts = await new PgAccountStore(pool).list(member.id); } catch { unavailable = true; }
  try { uses = await listAgentUses(member); } catch { /* the rows still show without it */ }
  const rows = buildServiceRows(accounts, uses);
  return <Page width="narrow" className="lares-stack">
    <PageHeader title="Your accounts" description="Accounts you connect stay yours. An agent works on one only when you choose it on that agent's page." />
    {params.added && <p role="status">Account connected.</p>}
    {params.error && <p role="alert">The account could not be connected. Try again.</p>}
    {unavailable ? <p role="status">Your accounts are unavailable. Try again later.</p> : <section className="lares-service-list" aria-label="Services">
      {rows.map(row => <AccountServiceRow key={row.service} row={row}
        attention={row.attention !== undefined && !row.accounts.some(a => a.ok) ? accountStatusLabel("account-not-ok", row.attention) : undefined} />)}
    </section>}
    <p className="lares-muted">More services come later. Shared tools for the whole installation are under {isConsoleOwner(member) ? <Link href="/integrations">Integrations</Link> : "Integrations"}.</p>
  </Page>;
}
