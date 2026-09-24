// services/console/lib/meeting-series.ts — ORB-156 Task 11.
//
// The list of meeting series Saga is allowed to send follow-ups for WITHOUT asking first
// (ratchet rows at level "autonomous" for agent="saga", capability="meeting_followup"), named
// so a human can act on the list rather than stare at a Google Calendar recurring-event id.
import { PgRatchet } from "@lares/agent-kit/ratchet-store";
import { pool } from "./db";

export interface SeriesNameInputs {
  /** The calendar's own title for this recurring series, when the Console could resolve it. */
  calendarTitle: string | null;
  /** The most recent human-readable recipient list logged for this series, or "" if none. */
  lastRecipients: string;
}

/**
 * Resolve a series id to a name a human can act on, in order: calendar title → most recent
 * recipients → the raw id. Never an empty string — an empty label next to a revoke button is
 * the worst possible outcome (a coin-flip revoke).
 */
export function nameSeries(seriesKey: string, inputs: SeriesNameInputs): string {
  if (inputs.calendarTitle) return inputs.calendarTitle;
  if (inputs.lastRecipients) return inputs.lastRecipients;
  return seriesKey;
}

export interface AutoSendSeriesDTO {
  seriesKey: string;
  name: string;
  updatedBy: string;
  updatedAt: Date;
}

/**
 * Every meeting series currently switched to autonomous follow-up sends, newest-switched first.
 *
 * calendarTitle is always null here: the Console cannot reach Google Calendar and must not gain
 * a Google dependency just to label this list — the recipients-then-id fallback in nameSeries
 * is what keeps the page usable without one. A future task that wires calendar read access can
 * fill calendarTitle in without changing this loader's shape.
 */
export async function listAutoSendSeries(): Promise<AutoSendSeriesDTO[]> {
  const ratchet = new PgRatchet(pool);
  const rows = await ratchet.listAtLevel("saga", "meeting_followup", "autonomous");

  return Promise.all(
    rows.map(async (row) => {
      const { rows: sent } = await pool.query<{ recipients: string }>(
        `SELECT recipients FROM meeting_followup_sent
          WHERE series_key = $1 AND outcome = 'sent'
          ORDER BY processed_at DESC LIMIT 1`,
        [row.action],
      );
      const lastRecipients = sent[0]?.recipients ?? "";
      return {
        seriesKey: row.action,
        name: nameSeries(row.action, { calendarTitle: null, lastRecipients }),
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt,
      };
    }),
  );
}
