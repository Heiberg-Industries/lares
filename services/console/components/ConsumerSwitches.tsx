"use client";
import { useState } from "react";
import type { ConsumerRow } from "../lib/signals";

/**
 * ORB-240. The spine's two delivery kill switches.
 *
 * They existed in the database from the first migration, with `selfRegisterConsumers` creating
 * them on every boot "so the future console lists them as toggles" — and had no surface at all, so
 * turning off automatic ticket filing meant opening the database by hand. Console first: every knob
 * gets a surface, and every switch says in words what it does, because "linear: off" tells an owner
 * nothing about whether their alerts still arrive.
 *
 * Unstyled, like JsonEditor — working agreement 2026-08-31.
 */
const WHAT: Record<ConsumerRow["name"], string> = {
  slack: "Off = no cards, replies or green edits are posted anywhere. Signals are still recorded and still shown on Recent, and Linear still files. For muting an incident — reach for a rule below to fix one bad channel.",
  linear: "Off = no new tickets are filed. Signals are still recorded and still posted to Slack. Issues already open are untouched.",
};

export function ConsumerSwitches({ initial, onSave }: {
  initial: ConsumerRow[];
  onSave(consumers: ConsumerRow[]): Promise<void>;
}) {
  const [rows, setRows] = useState(initial);
  const [msg, setMsg] = useState("");
  async function toggle(name: ConsumerRow["name"], enabled: boolean) {
    const next = rows.map((r) => (r.name === name ? { ...r, enabled } : r));
    setRows(next);
    setMsg("saving…");
    try { await onSave(next); setMsg(`saved — ${name} is ${enabled ? "on" : "OFF"}`); }
    catch (e) {
      // Put the switch back: a checkbox that stays flipped after a failed save is a lie about
      // production, and this is the one page where that costs someone their alerts.
      setRows(rows);
      setMsg(String(e instanceof Error ? e.message : e));
    }
  }
  return (
    <div style={{ marginTop: 12, borderBottom: "1px solid var(--rule)", paddingBottom: 12 }}>
      {rows.map((r) => (
        <div key={r.name} style={{ marginBottom: 8 }}>
          <label className="mono" style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "baseline" }}>
            <input type="checkbox" checked={r.enabled} onChange={(e) => void toggle(r.name, e.target.checked)} />
            <span>{r.name}{r.enabled ? "" : " — OFF"}</span>
          </label>
          <p style={{ color: "var(--mist)", fontSize: 12, margin: "2px 0 0 24px" }}>{WHAT[r.name]}</p>
        </div>
      ))}
      <span className="mono" style={{ fontSize: 12, color: msg.startsWith("saved") ? "var(--good, #2a7)" : "var(--bad)" }}>{msg}</span>
    </div>
  );
}
