"use client";
/**
 * "Where messages go" - one row per kind of message the agent starts on its own, one column per
 * door. In each cell the owner numbers the doors in the order they should be tried: 1st, then (if
 * wanted) 2nd and 3rd as backups. Nothing is lost when a door is not connected: the message tries
 * the next one and finally web chat, which always exists.
 *
 * Rows nobody has saved yet are pre-filled with what happens today (the "today" marker), so the
 * owner sees the real behaviour before changing it. Saving writes every row.
 *
 * CLIENT component: imports only the database-free `lib/delivery.ts`, never the server modules.
 */
import { useState, useTransition } from "react";
import { saveDelivery } from "../app/actions/delivery";
import {
  DELIVERY_DOORS, DOOR_LABEL, deliveryFromGrid, doorsFromRanks, gridFrom, ordinal, ranksOf,
  type DeliveryDoor, type DeliveryKind, type DeliveryMap, type Ranks,
} from "../lib/delivery";

export interface DeliveryGridProps {
  agent: string;
  delivery: DeliveryMap | undefined;
  /** Which chat doors are switched on for this agent. Web chat is always available. */
  connected: Record<"slack" | "telegram", boolean>;
  /** The last message of a kind that did not go where asked, e.g. "Morning brief went to web chat: Telegram is not connected". */
  notes?: Partial<Record<DeliveryKind, string>>;
}

const sel = {
  border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 8px",
  fontFamily: "var(--font-mono)", fontSize: 12, background: "var(--card)", color: "var(--ink)",
} as const;
const btn = {
  border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 12px",
  background: "var(--signal)", color: "#fff", cursor: "pointer", fontSize: 12,
} as const;

export function DeliveryGrid({ agent, delivery, connected, notes = {} }: DeliveryGridProps) {
  const initial = gridFrom(delivery);
  const [ranks, setRanks] = useState<Record<string, Ranks>>(
    Object.fromEntries(initial.map((r) => [r.kind, ranksOf(r.doors)])),
  );
  const [saved, setSaved] = useState(initial.every((r) => !r.fromToday));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const doorOn = (d: DeliveryDoor) => d === "web" || connected[d];

  function submit() {
    setMsg(null);
    const rows: { kind: DeliveryKind; doors: DeliveryDoor[] }[] = [];
    for (const row of initial) {
      const checked = doorsFromRanks(row.label, ranks[row.kind]!);
      if (!checked.ok) { setMsg({ ok: false, text: checked.message }); return; }
      rows.push({ kind: row.kind, doors: checked.doors });
    }
    start(async () => {
      try {
        const r = await saveDelivery({ name: agent, delivery: deliveryFromGrid(rows) });
        if (r.ok) setSaved(true);
        setMsg(r.ok ? { ok: true, text: "Saved. It applies the next time each message is sent." } : { ok: false, text: r.message });
      } catch (e) {
        setMsg({ ok: false, text: String(e instanceof Error ? e.message : e) });
      }
    });
  }

  return (
    <div>
      <p className="lares-muted">
        Number the doors in the order each message should try them. If a door is not connected, the
        message tries the next one, and web chat is always the last resort - so nothing is dropped.
        {!saved && " Rows marked “today” show where the message goes now; saving makes the choice explicit."}
      </p>
      <table className="card" style={{ marginTop: 8 }} aria-label="Where messages go">
        <thead>
          <tr>
            <th>Message</th>
            {DELIVERY_DOORS.map((d) => (
              <th key={d}>{DOOR_LABEL[d]}{doorOn(d) ? "" : " (not connected)"}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {initial.map((row) => (
            <tr key={row.kind}>
              <td className="mono" style={{ fontSize: 12 }}>
                {row.label}
                {row.fromToday && !saved && <span style={{ color: "var(--mist)" }}> · today</span>}
                {notes[row.kind] && <div style={{ color: "var(--mist)" }}>{notes[row.kind]}</div>}
              </td>
              {DELIVERY_DOORS.map((door) => (
                <td key={door}>
                  <select
                    style={sel}
                    value={ranks[row.kind]![door]}
                    disabled={pending}
                    aria-label={`${row.label} via ${DOOR_LABEL[door]}`}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setSaved(false);
                      setRanks((all) => ({ ...all, [row.kind]: { ...all[row.kind]!, [door]: next } }));
                    }}
                  >
                    <option value={0}>not used</option>
                    {[1, 2, 3].map((n) => <option key={n} value={n}>{ordinal(n)}</option>)}
                  </select>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <button style={btn} disabled={pending} onClick={submit}>{pending ? "Saving…" : "Save"}</button>
        {msg && (
          <span role={msg.ok ? "status" : "alert"} className="mono" style={{ fontSize: 12, color: msg.ok ? "var(--ok)" : "var(--bad)" }}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
