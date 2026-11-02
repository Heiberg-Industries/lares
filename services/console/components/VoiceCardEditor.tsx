"use client";
import { Field } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Textarea } from "@lares/ui/primitives/textarea";
import { useState, useTransition } from "react";
import { saveCard } from "../app/actions/voice";

export function VoiceCardEditor(p: { id: string; core: string; notesEn: string; notesNo: string }) {
  const [core, setCore] = useState(p.core);
  const [notesEn, setNotesEn] = useState(p.notesEn);
  const [notesNo, setNotesNo] = useState(p.notesNo);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState("");
  return (
    <div className="card lares-control-card lares-stack">
      <Field label="Core"><Textarea value={core} onChange={(e) => setCore(e.target.value)} /></Field>
      <Field label="English"><Textarea value={notesEn} onChange={(e) => setNotesEn(e.target.value)} /></Field>
      <Field label="Norsk"><Textarea value={notesNo} onChange={(e) => setNotesNo(e.target.value)} /></Field>
      <div className="lares-actions">
        <Button type="button" disabled={pending} onClick={() => start(async () => { setMsg(""); try { await saveCard({ id: p.id, core, notesEn, notesNo }); setMsg("Saved"); } catch (e) { setMsg(String(e)); } })}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {msg && <span className="lares-small lares-status-muted">{msg}</span>}
      </div>
    </div>
  );
}
