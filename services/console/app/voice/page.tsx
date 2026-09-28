import { getVoiceCards, listVoiceExamples } from "../../lib/voice";
import { VoiceCardEditor } from "../../components/VoiceCardEditor";
import { VoiceSettings } from "../../components/VoiceSettings";
import { ProposedCard } from "../../components/ProposedCard";
import { ExampleToggle } from "../../components/ExampleToggle";
import { RelearnButton } from "../../components/RelearnButton";
import { PageHeader } from "@lares/ui/patterns";

export const dynamic = "force-dynamic";

// ORB-176: one voice card per mailbox. `default` is the shared fallback (and carries the learn
// settings); each enrolled mailbox has its own card, its own proposal and its own learn status.
// A mailbox whose card is still empty drafts with the default card until it has learned.
export default async function VoicePage() {
  const [cards, examples] = await Promise.all([getVoiceCards(), listVoiceExamples()]);
  const def = cards[0]!;
  const mailboxes = cards.slice(1);
  return (
    <div className="lares-page lares-operational">
      <PageHeader title="Email writing style" description="Mailbox-specific style and shared defaults." />
      <p className="lares-muted lares-operational-intro">
        One card per mailbox — you write differently from each. Learned from that mailbox&apos;s Sent mail; your edits always win.
        A mailbox with an empty card uses the shared defaults below until it has learned.
      </p>

      <div className="lares-operational-actions">
        <RelearnButton status={def.learnStatus} message={def.learnMessage} />
      </div>

      {mailboxes.length === 0 && (
        <p className="lares-operational-empty">No mailbox cards yet. Run a Sent mail learning pass to create them.</p>
      )}
      {mailboxes.map((card) => (
        <section key={card.id} className="lares-operational-section">
          <h2>
            {card.id}
            {card.learnStatus === "error" && <span className="lares-operational-meta lares-status-error" title={card.learnMessage}> · Last learn failed</span>}
            {card.learnStatus === "running" && <span className="lares-operational-meta lares-status-muted"> · Learning…</span>}
          </h2>
          {card.proposed && <ProposedCard id={card.id} proposed={card.proposed} />}
          <VoiceCardEditor id={card.id} core={card.core} english={card.english} norsk={card.norsk} />
        </section>
      ))}

      <h2>Shared defaults</h2>
      <p className="lares-muted lares-operational-note">Used by any mailbox whose own card is empty.</p>
      {def.proposed && <ProposedCard id={def.id} proposed={def.proposed} />}
      <VoiceCardEditor id={def.id} core={def.core} english={def.english} norsk={def.norsk} />

      <h2>Learn settings</h2>
      <p className="lares-muted lares-operational-note">
        Limit how far back learning reads Sent mail and how many messages it checks per mailbox.
      </p>
      <VoiceSettings
        lookbackDays={def.lookbackDays} cap={def.cap}
      />

      <h2>Example emails ({examples.length})</h2>
      <p className="lares-muted lares-operational-note">Untick to exclude an example from style matching. The email stays stored.</p>
      <div className="lares-table-scroll"><table className="card lares-operational-table">
        <thead><tr><th>Lang</th><th>Snippet</th><th>In voice</th></tr></thead>
        <tbody>
          {examples.length === 0 && <tr><td colSpan={3} className="lares-status-muted">No examples yet. Run a Sent mail learning pass above.</td></tr>}
          {examples.map((e) => (
            <tr key={e.id}>
              <td className="mono">{e.lang}</td>
              <td className="lares-status-muted">{e.snippet}</td>
              <td><ExampleToggle id={e.id} included={e.included} /></td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}
