"use client";
import { useState, useTransition } from "react";
import { saveSettings } from "../app/actions/voice";

const inp = { border: "1px solid var(--rule)", borderRadius: 10, padding: "8px 10px", fontFamily: "var(--font-mono)", fontSize: 12 } as const;

export function VoiceSettings(p: { lookbackDays: number; cap: number }) {
  const [lookbackDays, setLb] = useState(p.lookbackDays);
  const [cap, setCap] = useState(p.cap);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState("");
  return (
    <div className="card" style={{ padding: 12, marginTop: 8, display: "grid", gap: 10, maxWidth: 520 }}>
      <label className="mono" style={{ fontSize: 12 }}>Lookback (days) <input style={inp} type="number" min={1} max={3650} value={lookbackDays} onChange={(e) => setLb(Number(e.target.value))} /></label>
      <label className="mono" style={{ fontSize: 12 }}>Message cap <input style={inp} type="number" min={1} max={300} value={cap} onChange={(e) => setCap(Number(e.target.value))} /></label>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button disabled={pending} onClick={() => start(async () => { setMsg(""); try { await saveSettings({ lookbackDays, cap }); setMsg("Saved"); } catch (e) { setMsg(String(e)); } })}
          style={{ border: "1px solid var(--rule)", borderRadius: 10, padding: "8px 12px", background: "var(--signal)", color: "#fff", cursor: "pointer" }}>
          {pending ? "Saving…" : "Save settings"}
        </button>
        {msg && <span style={{ color: "var(--mist)", fontSize: 12 }}>{msg}</span>}
      </div>
    </div>
  );
}
