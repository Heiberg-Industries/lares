"use client";
/**
 *  — "when do the agents speak", offered as its own section on `/proactivity`, after
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
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";
import { useState, useTransition } from "react";
import { saveScheduleHours } from "../app/actions/proactivity";
import type { SaveResult } from "../app/actions/proactivity";
import { SINGLE_SLOT } from "../lib/schedule-hours";
import { scheduleExplanation } from "../lib/schedule-labels";

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
      <td className="mono lares-small">
        {row.label}
        {row.isDefault && <span className="lares-status-muted"> · default</span>}
        {scheduleExplanation(row.schedule) && (
          <div className="lares-status-muted">{scheduleExplanation(row.schedule)}</div>
        )}
      </td>
      <td>
        <Input
          className="lares-short-input"
          type="text"
          inputMode="numeric"
          value={text}
          disabled={pending}
          onChange={(e) => setText(e.target.value)}
          aria-label={`${row.label} hour${single ? "" : "s"}`}
        />
      </td>
      <td className="lares-small lares-status-muted">
        {single ? "one hour, 0–23" : "up to 6 hours, comma-separated"}
      </td>
      <td>
        <div className="lares-actions">
          <Button type="button" disabled={pending} onClick={submit}>{pending ? "Saving…" : "Save"}</Button>
          {msg && (
            <span className={msg.ok ? "lares-form-success" : "lares-form-error"}>{msg.text}</span>
          )}
        </div>
      </td>
    </tr>
  );
}

export function ScheduleHoursControl({ rows, unavailable }: ScheduleHoursProps) {
  if (unavailable) {
    return (
      <p className="mono lares-operational-note lares-status-error">
        Schedule hours couldn&apos;t be read. If this installation has not applied
        sql/001_baseline.sql yet, apply it on the server and reload this page; otherwise
        the database is not answering.
      </p>
    );
  }

  return (
    <div className="lares-table-scroll"><table className="card lares-operational-table">
      <thead><tr><th>Schedule</th><th>Hour(s)</th><th /><th /></tr></thead>
      <tbody>
        {rows.map((r) => <ScheduleRow key={r.schedule} row={r} />)}
      </tbody>
    </table></div>
  );
}
