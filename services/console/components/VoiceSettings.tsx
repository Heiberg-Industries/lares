"use client";
import { Field, Notice } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";
import { useState, useTransition } from "react";
import { saveSettings } from "../app/actions/voice";

export function VoiceSettings(p: { lookbackDays: number; cap: number }) {
  const [lookbackDays, setLb] = useState(p.lookbackDays);
  const [cap, setCap] = useState(p.cap);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState("");
  return (
    <div className="lares-stack">
      <Field label="How far back to read (days)"><Input className="lares-short-input" type="number" min={1} max={3650} value={lookbackDays} onChange={(e) => setLb(Number(e.target.value))} /></Field>
      <Field label="Most messages to read per mailbox"><Input className="lares-short-input" type="number" min={1} max={300} value={cap} onChange={(e) => setCap(Number(e.target.value))} /></Field>
      {msg && <Notice tone={msg === "Saved" ? "success" : "error"}>{msg}</Notice>}
      <div className="lares-actions">
        <Button type="button" variant="outline" disabled={pending} onClick={() => start(async () => { setMsg(""); try { await saveSettings({ lookbackDays, cap }); setMsg("Saved"); } catch (e) { setMsg(String(e)); } })}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}
