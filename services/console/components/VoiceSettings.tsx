"use client";
import { useState, useTransition } from "react";
import { saveSettings } from "../app/actions/voice";

// "nora" retired 2026-08-16 (ORB-75 — the loop is Saga's sales-outreach skill now). The learn
// key selects which gateway key voice-learn uses (GATEWAY_KEY_<UPPER(key)>, falling back to
// the shared one), so a retired surface here is a dead option, not a second voice profile —
// there is one profile, voice_profile.id = 'default'.
const KEYS = ["saga", "radar", "tyche"];
const inp = { border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 8px", fontFamily: "var(--font-mono)", fontSize: 12 } as const;

export function VoiceSettings(p: { modelEn: string; modelNo: string; learnKey: string; lookbackDays: number; cap: number }) {
  const [modelEn, setEn] = useState(p.modelEn);
  const [modelNo, setNo] = useState(p.modelNo);
  const [learnKey, setKey] = useState(p.learnKey);
  const [lookbackDays, setLb] = useState(p.lookbackDays);
  const [cap, setCap] = useState(p.cap);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState("");
  return (
    <div className="card" style={{ padding: 12, marginTop: 8, display: "grid", gap: 10, maxWidth: 520 }}>
      <label className="mono" style={{ fontSize: 12 }}>English model (blank = agent default) <input style={inp} value={modelEn} onChange={(e) => setEn(e.target.value)} placeholder="claude-opus-4-8" /></label>
      <label className="mono" style={{ fontSize: 12 }}>Norwegian model (blank = agent default) <input style={inp} value={modelNo} onChange={(e) => setNo(e.target.value)} placeholder="(e.g. a Norwegian-strong model)" /></label>
      <label className="mono" style={{ fontSize: 12 }}>Learn key <select style={inp} value={learnKey} onChange={(e) => setKey(e.target.value)}>{KEYS.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
      <label className="mono" style={{ fontSize: 12 }}>Lookback (days) <input style={inp} type="number" value={lookbackDays} onChange={(e) => setLb(Number(e.target.value))} /></label>
      <label className="mono" style={{ fontSize: 12 }}>Message cap <input style={inp} type="number" value={cap} onChange={(e) => setCap(Number(e.target.value))} /></label>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button disabled={pending} onClick={() => start(async () => { setMsg(""); try { await saveSettings({ modelEn, modelNo, learnKey, lookbackDays, cap }); setMsg("Saved"); } catch (e) { setMsg(String(e)); } })}
          style={{ border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 12px", background: "var(--signal)", color: "#fff", cursor: "pointer" }}>
          {pending ? "Saving…" : "Save settings"}
        </button>
        {msg && <span style={{ color: "var(--mist)", fontSize: 12 }}>{msg}</span>}
      </div>
    </div>
  );
}
