import Link from "next/link";
import { PgAccountStore } from "@lares/agent-kit/account-store";
import type { ConnectedAccountView } from "@lares/agent-kit/authority-contract";
import { Notice, Page, PageHeader, Row, Rows } from "@lares/ui/patterns";
import { Card } from "@lares/ui/primitives/card";
import { pool } from "../../lib/db";
import { requirePage, mayUse } from "../../lib/auth";
import { listAgentUses } from "../../lib/agent-mailbox";
import { listAgents } from "../../lib/agents";
import { agentNames } from "../../lib/connection-words";
import { buildAccountList } from "../../lib/your-accounts";
import { AccountList, AddAccount } from "../../components/AccountList";
import { RemoveAccountButton } from "../../components/RemoveAccountButton";
import { GOOGLE_CLIENT_MISSING } from "../../lib/account-errors";
import { googleOrgs, listGoogleAccounts } from "../../lib/accounts";
export const dynamic = "force-dynamic";
export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ added?: string; error?: string }> }) {
  const member = await requirePage("member");
  const params = await searchParams;
  let accounts: ConnectedAccountView[] = [], unavailable = false;
  let uses: { agent: string; accountId: string }[] = [];
  try { accounts = await new PgAccountStore(pool).list(member.id); } catch { unavailable = true; }
  try { uses = await listAgentUses(member); } catch { /* the rows still show without it */ }
  const agents = uses.length > 0 ? await listAgents() : [];
  const list = buildAccountList(accounts, uses).map(r => ({ ...r, usedBy: agentNames(r.usedBy, agents) }));
  // Mailboxes from the older way of connecting mail. Owner only; nothing shows if they cannot be read.
  const older = mayUse(member, "owner") ? await listGoogleAccounts().then(v => v.unavailable ? [] : v.accounts, () => []) : [];
  return <Page width="narrow" className="lares-stack">
    <PageHeader title="Your accounts" description="Accounts you connect stay yours. An agent works on one only when you choose it on that agent's page." actions={unavailable ? undefined : <AddAccount orgs={googleOrgs()} />} />
    {params.added && <Notice tone="success">Account connected.</Notice>}
    {params.error === GOOGLE_CLIENT_MISSING ? <Notice error>
      <p><strong>Google could not be connected yet.</strong></p>
      <p>Nothing was connected. Before anyone can connect a Google mailbox and calendar here, the person who looks after this installation has to add a second Google client. It is separate from the one used for signing in.</p>
      <p>The install guide shows them how, in section 8 ("Doors, outside tools and integrations"), under "E-mail": <a href="https://github.com/Heiberg-Industries/lares/blob/main/docs/install.md#8-doors-outside-tools-and-integrations" target="_blank" rel="noopener noreferrer">open the install guide</a>.</p>
    </Notice> : params.error && <Notice tone="error">The account could not be connected. Try again.</Notice>}
    {unavailable ? <Notice tone="error">Your accounts are unavailable. Try again later.</Notice> : <AccountList accounts={list} />}
    {older.length > 0 && <section className="lares-stack" aria-label="Older mailbox connections">
      <h2 className="lares-section-title">Older mailbox connections</h2>
      <p className="lares-muted">These came from an older way of connecting mail. Nothing uses them any more. You can remove them.</p>
      <Card><Rows label="Older mailbox connections">{older.map(a => <Row key={a.email} title={a.email} control={<RemoveAccountButton email={a.email} />} />)}</Rows></Card>
    </section>}
    <p className="lares-muted">More services come later. Shared tools for the whole installation are under {mayUse(member, "admin") ? <Link href="/integrations">Integrations</Link> : "Integrations"}.</p>
  </Page>;
}
