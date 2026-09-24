import Link from "next/link";
import { getCatalogue } from "../../../lib/signals";
import { JsonEditor } from "../../../components/JsonEditor";
import { saveCatalogue } from "../../actions/signals";
export const dynamic = "force-dynamic";
export default async function CataloguePage() {
  const r = await getCatalogue();
  return (
    <>
      <h1 className="mono" style={{ fontSize: 18 }}>Signals · Catalogue</h1>
      <p className="mono" style={{ fontSize: 12, marginTop: 4 }}><Link href="/signals">Recent</Link> · <Link href="/signals/rules">Routes</Link> · Catalogue</p>
      {"unavailable" in r ? <p className="mono" style={{ color: "var(--bad)", marginTop: 12 }}>Spine unavailable.</p> :
        <JsonEditor initial={r.catalogue} onSave={saveCatalogue}
          hint="One plain sentence per (source, type, key): what it means for a person and the next step. key '' is the fallback for that source+type. Your edits win over the seed." />}
    </>
  );
}
