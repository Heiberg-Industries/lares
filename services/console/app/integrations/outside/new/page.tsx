import Link from "next/link";
import { Page, PageHeader } from "@lares/ui/patterns";
import { requireConsolePage } from "../../../../lib/auth";
import { AddConnectorForm } from "../../../../components/AddConnectorForm";

export const dynamic = "force-dynamic";

export default async function AddConnectorPage() {
  await requireConsolePage();
  return <Page width="narrow" className="lares-stack">
    <Link href="/integrations/outside">← Outside tools</Link>
    <PageHeader title="Add custom connector" description="Give it a name and the server's address. Lares looks at the server and tells you what it found." />
    <AddConnectorForm />
  </Page>;
}
