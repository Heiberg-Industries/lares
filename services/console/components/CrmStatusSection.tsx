import {
  deriveState,
  needsHuman,
  buildCopyPrompt,
  type CrmChannelDTO,
  type CrmChannelState,
  type CrmStatusDTO,
} from "../lib/crm-status";
import { StatePill } from "./StatePill";
import { CopyPromptButton } from "./CopyPromptButton";

/**
 * "HH:MM UTC" straight out of the ISO string, not via a formatter. Nothing in this system
 * enforces UTC except that the service produces `at` with `toISOString()` and the console
 * prints it verbatim — `toLocaleTimeString()` (or anything locale/timezone-sensitive) would
 * render server-local time under a "UTC" label, a false statement strictly worse than the raw
 * ISO string it replaces. A malformed `at` shows itself rather than being dressed up as a time.
 */
function asOfUtc(iso: string): string {
  const isIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(iso);
  return isIso ? `${iso.slice(11, 16)} UTC` : iso;
}

function ago(iso: string, now: number): string {
  const mins = Math.round((now - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

/**
 * Every APPLICABLE raw fact, so the headline never suppresses evidence.
 *
 * The "switched off" line states two possibilities rather than asserting one: no column records
 * WHO disabled sync — the guard logs to syslog, not to Postgres — so the page must not claim the
 * guard did it.
 */
function details(c: CrmChannelDTO, state: CrmChannelState): string[] {
  const out: string[] = [];
  if (state === "paused") {
    out.push(
      "sync is switched off — the guard does this after ~45 min of sustained failure, or you did it by hand",
    );
  }
  if (c.authFailedAt) out.push(`the Google token failed auth at ${c.authFailedAt}`);
  const twenty = [`Twenty says ${c.syncStatus}`];
  if (c.syncStage) twenty.push(`stage ${c.syncStage}`);
  if (c.throttleFailureCount > 0) twenty.push(`${c.throttleFailureCount} throttle failures`);
  if (c.throttleRetryAfter) twenty.push(`retry after ${c.throttleRetryAfter}`);
  out.push(twenty.join(" · "));
  if (needsHuman(state)) {
    out.push("Resuming is a manual step on ops-1 — fix the cause first.");
  }
  return out;
}

export function CrmStatusSection({ status }: { status: CrmStatusDTO }) {
  // One clock for the whole render, so two rows never disagree about "now".
  const now = new Date();
  return (
    <>
      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
        CRM mailbox sync
        {!status.unavailable && status.at && (
          <span style={{ color: "var(--mist)", fontWeight: 400 }}>
            {"  "}as of {asOfUtc(status.at)}
          </span>
        )}
      </h2>
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
        Read-only. The console can see this; it cannot change it.
      </p>

      {status.unavailable ? (
        // Never an empty table — that reads as "no problems".
        <p className="mono" style={{ marginTop: 8, color: "var(--bad)" }}>
          Status unavailable — could not reach the CRM status endpoint.
        </p>
      ) : status.channels.length === 0 ? (
        <p className="mono" style={{ marginTop: 8, color: "var(--mist)" }}>
          The CRM has no mailboxes configured.
        </p>
      ) : (
        <div className="card" style={{ marginTop: 8 }}>
          {status.channels.map((c) => {
            const state = deriveState(c, now);
            return (
              <div key={c.handle} style={{ padding: "8px 0" }}>
                <div className="mono" style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 12 }}>
                  <StatePill state={state} />
                  <span>{c.handle}</span>
                  {/* Shown on EVERY row, healthy or not: a mailbox can read ACTIVE while not
                      having synced for hours, and the age is the only visible sign. Deliberately
                      NOT painted red past a threshold — we do not yet know what normal cadence
                      looks like, and a guessed threshold either cries wolf nightly or stays
                      silent through a real outage. Revisit with a week of observed behaviour. */}
                  <span style={{ color: "var(--mist)" }}>
                    last synced {c.syncedAt ? ago(c.syncedAt, now.getTime()) : "never"}
                  </span>
                </div>
                <div style={{ paddingLeft: 24, marginTop: 2 }}>
                  {details(c, state).map((d) => (
                    <div key={d} style={{ color: "var(--mist)", fontSize: 11 }}>{d}</div>
                  ))}
                  {needsHuman(state) && <CopyPromptButton prompt={buildCopyPrompt(c, state)} />}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
