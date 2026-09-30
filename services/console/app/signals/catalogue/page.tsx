import Link from "next/link";
import { getCatalogue } from "../../../lib/signals";
import { JsonEditor } from "../../../components/JsonEditor";
import { saveCatalogue } from "../../actions/signals";
import { PageHeader } from "@lares/ui/patterns";
export const dynamic = "force-dynamic";
export default async function CataloguePage() {
  const r = await getCatalogue();
  return (
    <div className="lares-page lares-operational">
      <PageHeader title="Signal catalogue" description="Plain-language meanings and next steps for signal types." />
      <nav className="lares-operational-nav" aria-label="Signals sections"><Link href="/signals">Recent</Link><Link href="/signals/rules">Routes</Link><span aria-current="page">Catalogue</span></nav>
      {"unavailable" in r ? <p className="lares-operational-error" role="alert">The catalogue could not be loaded. Check the Signals service, then reload.</p> :
        <JsonEditor initial={r.catalogue} onSave={saveCatalogue}
          hint="One plain sentence per (source, type, key): what it means for a person and the next step. key '' is the fallback for that source+type. Your edits win over the seed." />}
    </div>
  );
}
