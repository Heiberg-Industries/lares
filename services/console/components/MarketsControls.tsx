"use client";
/**
 * ORB-214 — the owner's two knobs on `/markets`: the refresh switch and the watchlist size.
 *
 * No `lib/markets.ts` import here — same reasoning as `DeadlineControls.tsx`'s header: that module
 * reaches the database, and a client component may not pull that in.
 */
import { useState, useTransition } from "react";
import { saveRefreshEnabled, saveWatchlistMax } from "../app/actions/markets";

const inp = {
  border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 8px",
  fontFamily: "var(--font-mono)", fontSize: 12, background: "var(--card)", color: "var(--ink)",
} as const;

const btn = {
  border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 12px",
  background: "var(--signal)", color: "#fff", cursor: "pointer", fontSize: 12,
} as const;

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <span className="mono" style={{ fontSize: 12, color: msg.ok ? "var(--ok)" : "var(--bad)" }}>{msg.text}</span>;
}

export function RefreshSwitch({ enabled }: { enabled: boolean }) {
  const [on, setOn] = useState(enabled);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function toggle(next: boolean) {
    const prev = on;
    setOn(next);
    setMsg(null);
    start(async () => {
      const r = await saveRefreshEnabled({ enabled: next }).catch((e) => ({ ok: false as const, message: String(e instanceof Error ? e.message : e) }));
      if (r.ok) setMsg({ ok: true, text: next ? "on" : "off" });
      else { setOn(prev); setMsg({ ok: false, text: r.message }); }
    });
  }

  return (
    <div className="card" style={{ padding: 12, marginTop: 8, maxWidth: 720 }}>
      <label className="mono" style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "baseline" }}>
        <input type="checkbox" checked={on} disabled={pending} onChange={(e) => toggle(e.target.checked)} />
        <span>Market refresh{on ? " — ON" : ""}</span>
        <Msg msg={msg} />
      </label>
      <p style={{ color: "var(--mist)", fontSize: 12, margin: "2px 0 0" }}>
        On = the nightly watchlist discovery and edge-recording pass runs. Proactive alerts stay off
        either way — this switch never sends anything, it only refreshes what <span className="mono">market-edge</span> can answer.
      </p>
    </div>
  );
}

export function WatchlistSizeControl({ value, engineMax }: { value: number; engineMax: number }) {
  const [n, setN] = useState(value);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, save] = useTransition();

  function submit() {
    setMsg(null);
    save(async () => {
      const r = await saveWatchlistMax({ value: n }).catch((e) => ({ ok: false as const, message: String(e instanceof Error ? e.message : e) }));
      setMsg(r.ok ? { ok: true, text: "saved" } : { ok: false, text: r.message });
    });
  }

  return (
    <div className="card" style={{ padding: 12, marginTop: 8, maxWidth: 720 }}>
      <label className="mono" style={{ fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}>
        <input style={{ ...inp, width: 80 }} type="number" min={10} max={engineMax} step={1} value={n} onChange={(e) => setN(Number(e.target.value))} />
        <span>Watchlist size</span>
        <span style={{ color: "var(--mist)" }}>engine max {engineMax}</span>
      </label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
        <button style={btn} disabled={pending} onClick={submit}>{pending ? "Saving…" : "Save"}</button>
        <Msg msg={msg} />
      </div>
    </div>
  );
}
