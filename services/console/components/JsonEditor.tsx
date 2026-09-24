"use client";
import { useState } from "react";

/** Plain textarea + Save. The spine validates; its message is shown verbatim. Unstyled on purpose (working agreement 2026-08-31). */
export function JsonEditor({ initial, onSave, hint }: { initial: unknown; onSave(json: string): Promise<void>; hint: string }) {
  const [text, setText] = useState(JSON.stringify(initial, null, 2));
  const [msg, setMsg] = useState("");
  async function save() {
    setMsg("saving…");
    try { JSON.parse(text); await onSave(text); setMsg("saved"); }
    catch (e) { setMsg(String(e instanceof Error ? e.message : e)); }
  }
  return (
    <div style={{ marginTop: 12 }}>
      <p style={{ color: "var(--mist)", fontSize: 12 }}>{hint}</p>
      <textarea className="mono" value={text} onChange={(e) => setText(e.target.value)} rows={28}
        style={{ width: "100%", fontSize: 12, border: "1px solid var(--rule)", padding: 8 }} />
      <div style={{ marginTop: 8, display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={save}>Save</button>
        <span className="mono" style={{ fontSize: 12, color: msg === "saved" ? "var(--good, #2a7)" : "var(--bad)" }}>{msg}</span>
      </div>
    </div>
  );
}
