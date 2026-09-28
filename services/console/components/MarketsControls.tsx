"use client";
/**
 * ORB-214 — the owner's two knobs on `/markets`: the refresh switch and the watchlist size.
 *
 * No `lib/markets.ts` import here — same reasoning as `DeadlineControls.tsx`'s header: that module
 * reaches the database, and a client component may not pull that in.
 */
import { useState, useTransition } from "react";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";
import { saveRefreshEnabled, saveWatchlistMax } from "../app/actions/markets";

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <span role="status" className={msg.ok ? "lares-form-success" : "lares-form-error"}>{msg.text}</span>;
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
    <div className="card lares-control-card">
      <label className="lares-checkbox-row">
        <input type="checkbox" checked={on} disabled={pending} onChange={(e) => toggle(e.target.checked)} />
        <span>Market refresh — {on ? "On" : "Off"}</span>
        <Msg msg={msg} />
      </label>
      <p className="lares-muted">
        When on, a nightly pass updates the watchlist and records new market observations. This setting never sends proactive alerts.
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
    <div className="card lares-control-card">
      <label className="lares-field-label">
        Watchlist size
        <Input className="lares-short-input" type="number" min={10} max={engineMax} step={1} value={n} onChange={(e) => setN(Number(e.target.value))} />
      </label>
      <p className="lares-muted">Maximum supported: {engineMax} markets.</p>
      <div className="lares-actions">
        <Button disabled={pending} onClick={submit}>{pending ? "Saving…" : "Save"}</Button>
        <Msg msg={msg} />
      </div>
    </div>
  );
}
