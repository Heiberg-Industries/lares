import Link from "next/link";
import { getRules, getConsumers } from "../../../lib/signals";
import { JsonEditor } from "../../../components/JsonEditor";
import { ConsumerSwitches } from "../../../components/ConsumerSwitches";
import { saveRules, saveConsumers } from "../../actions/signals";
import { PageHeader } from "@lares/ui/patterns";
export const dynamic = "force-dynamic";
export default async function RulesPage() {
  // ORB-240: the switches sit ABOVE the rules rather than on their own page, because they are the
  // same question — where does a signal go — asked one level up. Fetched independently so a spine
  // that answers one and not the other still renders what it can.
  const [r, c] = await Promise.all([getRules(), getConsumers()]);
  return (
    <div className="lares-page lares-operational">
      <PageHeader title="Signal routes" description="Delivery switches and ordered routing rules." />
      <nav className="lares-operational-nav" aria-label="Signals sections"><Link href="/signals">Recent</Link><span aria-current="page">Routes</span><Link href="/signals/catalogue">Catalogue</Link></nav>
      {"unavailable" in c ? <p className="lares-operational-error" role="alert">Delivery switches could not be loaded. Check the Signals service, then reload.</p> :
        <ConsumerSwitches initial={c.consumers} onSave={saveConsumers} />}
      {"unavailable" in r ? <p className="lares-operational-error" role="alert">Routing rules could not be loaded. Check the Signals service, then reload.</p> :
        <JsonEditor initial={r.rules} onSave={saveRules}
          hint="Ordered list; first match wins. Fields project / severity / type / source / kind are optional matchers (absent = any). destinations = Slack channel ids (fan-out). allowTarget lets a report choose its own channel. Save replaces the whole list." />}
    </div>
  );
}
