"use client";
import { Notice } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { useTransition } from "react";
import { acceptProposed, dismissProposed } from "../app/actions/voice";
import type { VoiceProposed } from "../lib/contracts";

export function ProposedCard(p: { id: string; proposed: VoiceProposed }) {
  const [pending, start] = useTransition();
  return (
    <Notice tone="needs-you">
      <div className="lares-stack">
      <p>
        Proposed from your Sent mail ({p.proposed.sampleSize} emails, {p.proposed.learnedAt.slice(0, 10)})
      </p>
      <pre className="lares-pre lares-small">{`Core\n${p.proposed.core}\n\nEnglish\n${p.proposed.notes_en}\n\nNorsk\n${p.proposed.notes_no}`}</pre>
      <div className="lares-actions">
        <Button type="button" disabled={pending} onClick={() => start(() => acceptProposed({ id: p.id }))}>Accept</Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => start(() => dismissProposed({ id: p.id }))}>Dismiss</Button>
      </div>
      </div>
    </Notice>
  );
}
