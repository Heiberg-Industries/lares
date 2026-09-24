"use client";
import { useTransition } from "react";
import { acceptProposed, dismissProposed } from "../app/actions/voice";
import type { VoiceProposed } from "../lib/contracts";

export function ProposedCard(p: { id: string; proposed: VoiceProposed }) {
  const [pending, start] = useTransition();
  return (
    <div className="card" style={{ padding: 12, marginTop: 16, borderColor: "var(--signal)" }}>
      <div className="mono" style={{ fontSize: 12, color: "var(--signal)" }}>
        Proposed from your Sent mail ({p.proposed.sampleSize} emails, {p.proposed.learnedAt.slice(0, 10)})
      </div>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, marginTop: 8 }}>{`Core\n${p.proposed.core}\n\nEnglish\n${p.proposed.english}\n\nNorsk\n${p.proposed.norsk}`}</pre>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button disabled={pending} onClick={() => start(() => acceptProposed({ id: p.id }))}
          style={{ border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 12px", background: "var(--signal)", color: "#fff", cursor: "pointer" }}>Accept</button>
        <button disabled={pending} onClick={() => start(() => dismissProposed({ id: p.id }))}
          style={{ border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 12px", background: "var(--card)", color: "var(--ink)", cursor: "pointer" }}>Dismiss</button>
      </div>
    </div>
  );
}
