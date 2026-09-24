import Link from "next/link";
import { getRules, getConsumers } from "../../../lib/signals";
import { JsonEditor } from "../../../components/JsonEditor";
import { ConsumerSwitches } from "../../../components/ConsumerSwitches";
import { saveRules, saveConsumers } from "../../actions/signals";
export const dynamic = "force-dynamic";
export default async function RulesPage() {
  // ORB-240: the switches sit ABOVE the rules rather than on their own page, because they are the
  // same question — where does a signal go — asked one level up. Fetched independently so a spine
  // that answers one and not the other still renders what it can.
  const [r, c] = await Promise.all([getRules(), getConsumers()]);
  return (
    <>
      <h1 className="mono" style={{ fontSize: 18 }}>Signals · Routes</h1>
      <p className="mono" style={{ fontSize: 12, marginTop: 4 }}><Link href="/signals">Recent</Link> · Routes · <Link href="/signals/catalogue">Catalogue</Link></p>
      {"unavailable" in c ? <p className="mono" style={{ color: "var(--bad)", marginTop: 12 }}>Delivery switches unavailable.</p> :
        <ConsumerSwitches initial={c.consumers} onSave={saveConsumers} />}
      {"unavailable" in r ? <p className="mono" style={{ color: "var(--bad)", marginTop: 12 }}>Spine unavailable.</p> :
        <JsonEditor initial={r.rules} onSave={saveRules}
          hint="Ordered list; first match wins. Fields project / severity / type / source / kind are optional matchers (absent = any). destinations = Slack channel ids (fan-out). allowTarget lets a report choose its own channel. Save replaces the whole list." />}
    </>
  );
}
