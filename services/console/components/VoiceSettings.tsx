"use client";
import { Field } from "@lares/ui/patterns";
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
    <div className="card lares-control-card lares-stack">
      <Field label="Lookback (days)"><Input className="lares-short-input" type="number" min={1} max={3650} value={lookbackDays} onChange={(e) => setLb(Number(e.target.value))} /></Field>
      <Field label="Message cap"><Input className="lares-short-input" type="number" min={1} max={300} value={cap} onChange={(e) => setCap(Number(e.target.value))} /></Field>
      <div className="lares-actions">
        <Button type="button" disabled={pending} onClick={() => start(async () => { setMsg(""); try { await saveSettings({ lookbackDays, cap }); setMsg("Saved"); } catch (e) { setMsg(String(e)); } })}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
        {msg && <span className="lares-small lares-status-muted">{msg}</span>}
      </div>
    </div>
  );
}
