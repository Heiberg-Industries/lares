"use client";
import { useState, useTransition } from "react";
import { requestRelearn } from "../app/actions/voice";

export function RelearnButton(p: { status: string; message: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState("");
  const busy = pending || p.status === "running";
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <button disabled={busy} onClick={() => start(async () => { setMsg(""); try { await requestRelearn(); setMsg("Requested — learning runs shortly."); } catch (e) { setMsg(String(e)); } })}
        style={{ border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 12px", background: "var(--card)", color: "var(--ink)", cursor: busy ? "default" : "pointer" }}>
        {busy ? "Learning…" : "Re-learn from Sent mail"}
      </button>
      {p.status === "error" && <span style={{ color: "var(--bad)", fontSize: 12 }} title={p.message}>last run failed</span>}
      {msg && <span style={{ color: "var(--mist)", fontSize: 12 }}>{msg}</span>}
    </span>
  );
}
