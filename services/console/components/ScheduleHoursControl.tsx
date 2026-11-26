"use client";
/**
 *  — "when do the agents speak", offered as its own section on `/quiet-hours-and-delivery`, after
 * "Quiet hours".
 *
 * A new file, deliberately: this writes `schedule_settings`, a table the three proactivity knobs
 * (`ProactivityControls.tsx`) and the brief-language knob (`BriefLanguageControl.tsx`) never touch,
 * and it is owner-scoped rather than door-scoped. Built from the same shared parts as both of those.
 *
 * THE TRAP THIS FILE MUST NOT REPEAT (both of the files above name it): this is a CLIENT component,
 * so every value it imports lands in the browser bundle. `lib/schedule-settings.ts` reaches `pg`
 * through `./db`, and a client import of it breaks `next build` ("Can't resolve 'fs' / 'net' / 'tls'")
 * in a way neither vitest nor tsc can see. So the mirrored constants and the validator come from
 * `lib/schedule-hours.ts` — a database-free module — never from `lib/schedule-settings.ts`. The
 * row's current values arrive as a prop, read server-side.
 */
import { Notice, Row, Rows } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { CardContent } from "@lares/ui/primitives/card";
import { Input } from "@lares/ui/primitives/input";
import { ListEditor } from "@lares/ui/primitives/list-editor";
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

/** One box per hour. A schedule with a single hour has one box and no Add. */
export const hourBoxes = (hours: number[]): string[] => hours.map((hour) => String(hour));

/**
 * The boxes → `[9, 13, 17]`. The boxes are joined with commas and read exactly as the one text field
 * was ("9, 13, 17", "9" or "9,13,17"), so the saved value is the same. Purely mechanical — every
 * actual rule (whole hours, ascending, at most one for a single-slot schedule) is `saveScheduleHours`'s
 * own `validateHours`, run server-side, so a malformed entry here is refused there rather than
 * silently coerced. An empty box is dropped rather than becoming a `NaN` that would otherwise print
 * as a confusing "null is not a whole hour" refusal.
 */
export function parseHours(boxes: string[]): number[] {
  return boxes
    .join(", ")
    .split(/[,\s]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s));
}

function ScheduleRow({ row }: { row: ScheduleHoursRow }) {
  const [boxes, setBoxes] = useState(hourBoxes(row.hours));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const single = SINGLE_SLOT.has(row.schedule);
  const explanation = scheduleExplanation(row.schedule);

  function submit() {
    setMsg(null);
    start(async () => {
      let r: SaveResult;
      try { r = await saveScheduleHours({ schedule: row.schedule, hours: parseHours(boxes) }); }
      catch (e) { r = { ok: false, message: String(e instanceof Error ? e.message : e) }; }
      setMsg(r.ok ? { ok: true, text: "Saved." } : { ok: false, text: r.message });
    });
  }

  return (
    <Row
      title={<>{row.label}{row.isDefault && <span className="lares-muted"> · default</span>}</>}
      description={<>{explanation ? `${explanation} ` : ""}{single ? "One hour, 0 to 23." : "Up to 6 hours, 0 to 23, one in each box."}</>}
    >
      <div className="lares-stack">
        {single ? (
          <Input
            className="lares-short-input"
            type="text"
            inputMode="numeric"
            value={boxes[0] ?? ""}
            disabled={pending}
            onChange={(e) => setBoxes([e.target.value])}
            aria-label={`${row.label} hour`}
          />
        ) : (
          <ListEditor label={`${row.label} hour`} addLabel="Add an hour" size="short" inputMode="numeric" values={boxes} disabled={pending} onChange={setBoxes} />
        )}
        <Button type="button" variant="outline" disabled={pending} onClick={submit}>{pending ? "Saving…" : "Save"}</Button>
        {msg && <Notice tone={msg.ok ? "success" : "error"}>{msg.text}</Notice>}
      </div>
    </Row>
  );
}

export function ScheduleHoursControl({ rows, unavailable }: ScheduleHoursProps) {
  if (unavailable) {
    return (
      <CardContent className="lares-stack">
        <Notice error>
          Schedule hours couldn&apos;t be read. If this installation has not applied
          sql/001_baseline.sql yet, apply it on the server and reload this page; otherwise
          the database is not answering.
        </Notice>
      </CardContent>
    );
  }

  return (
    <Rows label="When the agents speak">
      {rows.map((r) => <ScheduleRow key={r.schedule} row={r} />)}
    </Rows>
  );
}
