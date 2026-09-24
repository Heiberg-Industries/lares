import { getVoiceCards, listVoiceExamples } from "../../lib/voice";
import { VoiceCardEditor } from "../../components/VoiceCardEditor";
import { VoiceSettings } from "../../components/VoiceSettings";
import { ProposedCard } from "../../components/ProposedCard";
import { ExampleToggle } from "../../components/ExampleToggle";
import { RelearnButton } from "../../components/RelearnButton";

export const dynamic = "force-dynamic";

// ORB-176: one voice card per mailbox. `default` is the shared fallback (and carries the learn
// settings); each enrolled mailbox has its own card, its own proposal and its own learn status.
// A mailbox whose card is still empty drafts with the default card until it has learned.
export default async function VoicePage() {
  const [cards, examples] = await Promise.all([getVoiceCards(), listVoiceExamples()]);
  const def = cards[0]!;
  const mailboxes = cards.slice(1);
  return (
    <>
      <h1 className="mono" style={{ fontSize: 18 }}>Email voice</h1>
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
        One card per mailbox — you write differently from each. Learned from that mailbox&apos;s Sent mail; your edits always win.
        A mailbox with an empty card uses the shared defaults below until it has learned.
      </p>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16 }}>
        <RelearnButton status={def.learnStatus} message={def.learnMessage} />
      </div>

      {mailboxes.length === 0 && (
        <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 16 }}>No mailbox cards yet — they appear after the first learn run.</p>
      )}
      {mailboxes.map((card) => (
        <section key={card.id} style={{ marginTop: 24 }}>
          <h2 className="mono" style={{ fontSize: 14 }}>
            {card.id}
            {card.learnStatus === "error" && <span style={{ color: "var(--bad)", fontSize: 12, marginLeft: 8 }} title={card.learnMessage}>last learn failed</span>}
            {card.learnStatus === "running" && <span style={{ color: "var(--mist)", fontSize: 12, marginLeft: 8 }}>learning…</span>}
          </h2>
          {card.proposed && <ProposedCard id={card.id} proposed={card.proposed} />}
          <VoiceCardEditor id={card.id} core={card.core} english={card.english} norsk={card.norsk} />
        </section>
      ))}

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>Shared defaults</h2>
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>Used by any mailbox whose own card is empty.</p>
      {def.proposed && <ProposedCard id={def.id} proposed={def.proposed} />}
      <VoiceCardEditor id={def.id} core={def.core} english={def.english} norsk={def.norsk} />

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>Learn settings</h2>
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
        Model alias overrides — leave empty to use the <span className="mono">writer</span> purpose, which the gateway maps to a model.
      </p>
      <VoiceSettings
        modelEn={def.modelEn} modelNo={def.modelNo} learnKey={def.learnKey}
        lookbackDays={def.lookbackDays} cap={def.cap}
      />

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>Example emails ({examples.length})</h2>
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>Untick to drop one from voice matching (it stays stored).</p>
      <table className="card" style={{ marginTop: 8 }}>
        <thead><tr><th>Lang</th><th>Snippet</th><th>In voice</th></tr></thead>
        <tbody>
          {examples.length === 0 && <tr><td colSpan={3} style={{ color: "var(--mist)" }}>No examples yet — press &quot;Re-learn from Sent mail&quot;.</td></tr>}
          {examples.map((e) => (
            <tr key={e.id}>
              <td className="mono">{e.lang}</td>
              <td style={{ color: "var(--mist)" }}>{e.snippet}</td>
              <td><ExampleToggle id={e.id} included={e.included} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
