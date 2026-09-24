"use client";
/**
 * LAR-17-s5 — "when do the agents speak", offered as its own section on `/proactivity`, after
 * "Quiet hours".
 *
 * A new file, deliberately: this writes `schedule_settings`, a table the three proactivity knobs
 * (`ProactivityControls.tsx`) and the brief-language knob (`BriefLanguageControl.tsx`) never touch,
 * and it is owner-scoped rather than door-scoped. Styled the same plain way as both of those — inline
 * styles, no UI library, no new global CSS.
 *
 * THE TRAP THIS FILE MUST NOT REPEAT (both of the files above name it): this is a CLIENT component,
 * so every value it imports lands in the browser bundle. `lib/schedule-settings.ts` reaches `pg`
 * through `./db`, and a client import of it breaks `next build` ("Can't resolve 'fs' / 'net' / 'tls'")
 * in a way neither vitest nor tsc can see. So the mirrored constants and the validator come from
 * `lib/schedule-hours.ts` — a database-free module — never from `lib/schedule-settings.ts`. The
 * row's current values arrive as a prop, read server-side.
 */
import { useState, useTransition } from "react";
import { saveScheduleHours } from "../app/actions/proactivity";
import type { SaveResult } from "../app/actions/proactivity";
import { SINGLE_SLOT } from "../lib/schedule-hours";

export interface ScheduleHoursRow {
  schedule: string;
  label: string;
  hours: number[];
  isDefault: boolean;
}

export interface ScheduleHoursProps {
  rows: ScheduleHoursRow[];
  /** Set when `schedule_settings` could not be read (including a table that does not exist yet). */
  unavailable?: boolean;
}

const inp = {
  border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 8px",
  fontFamily: "var(--font-mono)", fontSize: 12, background: "var(--card)", color: "var(--ink)",
} as const;

const btn = {
  border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 12px",
  background: "var(--signal)", color: "#fff", cursor: "pointer", fontSize: 12,
} as const;

/** "8" or "9, 13, 17" — how a schedule's hours are shown and typed. */
const hoursText = (hours: number[]): string => hours.join(", ");

/**
 * "9, 13, 17" (or "9" / "9,13,17") → `[9, 13, 17]`. Purely mechanical — every actual rule (whole
 * hours, ascending, at most one for a single-slot schedule) is `saveScheduleHours`'s own
 * `validateHours`, run server-side, so a malformed entry here is refused there rather than
 * silently coerced. A blank segment (a trailing comma) is dropped rather than becoming a `NaN`
 * that would otherwise print as a confusing "null is not a whole hour" refusal.
 */
function parseHours(text: string): number[] {
  return text
    .split(/[,\s]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s));
}

function ScheduleRow({ row }: { row: ScheduleHoursRow }) {
  const [text, setText] = useState(hoursText(row.hours));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const single = SINGLE_SLOT.has(row.schedule);

  function submit() {
    setMsg(null);
    start(async () => {
      let r: SaveResult;
      try { r = await saveScheduleHours({ schedule: row.schedule, hours: parseHours(text) }); }
      catch (e) { r = { ok: false, message: String(e instanceof Error ? e.message : e) }; }
      setMsg(r.ok ? { ok: true, text: "saved" } : { ok: false, text: r.message });
    });
  }

  return (
    <tr>
      <td className="mono" style={{ fontSize: 12 }}>
        {row.label}
        {row.isDefault && <span style={{ color: "var(--mist)" }}> · default</span>}
      </td>
      <td>
        <input
          style={{ ...inp, width: single ? 48 : 120 }}
          type="text"
          inputMode="numeric"
          value={text}
          disabled={pending}
          onChange={(e) => setText(e.target.value)}
          aria-label={`${row.label} hour${single ? "" : "s"}`}
        />
      </td>
      <td style={{ color: "var(--mist)", fontSize: 12 }}>
        {single ? "one hour, 0–23" : "up to 6 hours, comma-separated"}
      </td>
      <td>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button style={btn} disabled={pending} onClick={submit}>{pending ? "Saving…" : "Save"}</button>
          {msg && (
            <span className="mono" style={{ fontSize: 12, color: msg.ok ? "var(--ok)" : "var(--bad)" }}>{msg.text}</span>
          )}
        </div>
      </td>
    </tr>
  );
}

export function ScheduleHoursControl({ rows, unavailable }: ScheduleHoursProps) {
  if (unavailable) {
    return (
      <p className="mono" style={{ marginTop: 8, color: "var(--bad)", fontSize: 12 }}>
        Schedule hours couldn&apos;t be read. If this installation has not applied
        sql/065_schedule_settings.sql yet, apply it on the server and reload this page; otherwise
        the database is not answering.
      </p>
    );
  }

  return (
    <table className="card" style={{ marginTop: 8 }}>
      <thead><tr><th>Schedule</th><th>Hour(s)</th><th /><th /></tr></thead>
      <tbody>
        {rows.map((r) => <ScheduleRow key={r.schedule} row={r} />)}
      </tbody>
    </table>
  );
}
