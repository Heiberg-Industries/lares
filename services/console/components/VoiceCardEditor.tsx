"use client";
import { useState, useTransition } from "react";
import { saveCard } from "../app/actions/voice";

const ta = { width: "100%", minHeight: 90, border: "1px solid var(--rule)", borderRadius: 4, padding: 8, fontFamily: "var(--font-sans)", fontSize: 13 } as const;

export function VoiceCardEditor(p: { id: string; core: string; english: string; norsk: string }) {
  const [core, setCore] = useState(p.core);
  const [english, setEnglish] = useState(p.english);
  const [norsk, setNorsk] = useState(p.norsk);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState("");
  return (
    <div className="card" style={{ padding: 12, marginTop: 8, display: "grid", gap: 10 }}>
      <label className="mono" style={{ fontSize: 12 }}>Core<textarea style={ta} value={core} onChange={(e) => setCore(e.target.value)} /></label>
      <label className="mono" style={{ fontSize: 12 }}>English<textarea style={ta} value={english} onChange={(e) => setEnglish(e.target.value)} /></label>
      <label className="mono" style={{ fontSize: 12 }}>Norsk<textarea style={ta} value={norsk} onChange={(e) => setNorsk(e.target.value)} /></label>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button disabled={pending} onClick={() => start(async () => { setMsg(""); try { await saveCard({ id: p.id, core, english, norsk }); setMsg("Saved"); } catch (e) { setMsg(String(e)); } })}
          style={{ border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 12px", background: "var(--signal)", color: "#fff", cursor: "pointer" }}>
          {pending ? "Saving…" : "Save"}
        </button>
        {msg && <span style={{ color: "var(--mist)", fontSize: 12 }}>{msg}</span>}
      </div>
    </div>
  );
}
