"use client";
import { Button } from "@lares/ui/primitives/button";
import { useTransition } from "react";
import { acceptProposed, dismissProposed } from "../app/actions/voice";
import type { VoiceProposed } from "../lib/contracts";

export function ProposedCard(p: { id: string; proposed: VoiceProposed }) {
  const [pending, start] = useTransition();
  return (
    <div className="card lares-control-card">
      <div className="mono lares-small lares-status-warning">
        Proposed from your Sent mail ({p.proposed.sampleSize} emails, {p.proposed.learnedAt.slice(0, 10)})
      </div>
      <pre className="lares-pre lares-small lares-row-actions">{`Core\n${p.proposed.core}\n\nEnglish\n${p.proposed.notes_en}\n\nNorsk\n${p.proposed.notes_no}`}</pre>
      <div className="lares-actions lares-row-actions">
        <Button type="button" disabled={pending} onClick={() => start(() => acceptProposed({ id: p.id }))}>Accept</Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => start(() => dismissProposed({ id: p.id }))}>Dismiss</Button>
      </div>
    </div>
  );
}
