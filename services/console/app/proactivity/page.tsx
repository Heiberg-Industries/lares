import {
  ENGINE, agentLabel, doorLabel, effectiveDnd, effectiveQuietWindow, effectiveSettings,
  foldTodayByDoor, formatInOwnerTz, getProactivityView, reasonLabel, rowFor,
} from "../../lib/proactivity";
import type { TodayRowDTO } from "../../lib/proactivity";
import { CeilingSection, DndSection, QuietSection } from "../../components/ProactivityControls";
import type { DndScope, QuietScope } from "../../components/ProactivityControls";
import { BriefLanguageControl } from "../../components/BriefLanguageControl";
import { readBriefLanguage } from "../../lib/brief-settings";
import { ScheduleHoursControl } from "../../components/ScheduleHoursControl";
import { readScheduleHoursSettings } from "../../lib/schedule-settings";
import { PageHeader } from "@lares/ui/patterns";

export const dynamic = "force-dynamic";

/**
 * ORB-193 — the owner's surface for the proactivity gate.
 *
 * One page for four questions: may an agent speak at all (do not disturb), when is it too late
 * (quiet hours, on the owner's clock), how often at most (the ceilings), and what actually happened
 * (today's ledger and the last 50 decisions). The ledger is the part that makes the rest
 * trustworthy: a suppression nobody can see is indistinguishable from an agent that broke.
 */
function Reasons({ rows }: { rows: TodayRowDTO[] }) {
  const total = rows.reduce((n, r) => n + r.count, 0);
  if (total === 0) return <span className="lares-status-muted">—</span>;
  return (
    <>
      <span className="mono">{total}</span>
      <span className="lares-status-muted">
        {" "}({rows.map((r) => `${r.count} ${reasonLabel(r.reason) || "no reason recorded"}`).join(", ")})
      </span>
    </>
  );
}

export default async function ProactivityPage() {
  const view = await getProactivityView();
  const { settings, clock } = view;
  const briefLanguage = await readBriefLanguage(view.owner);
  const scheduleHours = await readScheduleHoursSettings(view.owner);

  const globalRow = rowFor(settings, "*", "*");
  const dndScopes: DndScope[] = [
    { agent: "*", label: "Every agent", dnd: globalRow?.dnd === true, effective: globalRow?.dnd === true },
    ...view.agents.map((a) => {
      const own = rowFor(settings, a, "*")?.dnd === true;
      return { agent: a, label: agentLabel(a), dnd: own, effective: effectiveDnd(globalRow?.dnd === true, own) };
    }),
  ];

  // The EFFECTIVE window per door, not the stored one. A row written by hand in SQL can hold a
  // window the kit throws away on read (under 8 h) or a cell that is not HH:MM at all; `readSettings`
  // has already put both through the kit's own rules, and `note` is what says so out loud.
  const quietScopes: QuietScope[] = view.doors.map((door) => {
    const row = rowFor(settings, "*", door);
    const quiet = row?.effective.quiet ?? effectiveQuietWindow(null, null);
    return {
      door, label: doorLabel(door),
      quietStart: quiet.quietStart, quietEnd: quiet.quietEnd,
      isDefault: quiet.isDefault, note: quiet.note,
    };
  });

  // Same re-validation for the three ceilings: what the engine enforces, annotated when the stored
  // row says something else ("stored 50 — the engine uses 10").
  const globalCeilings = globalRow?.effective
    ?? effectiveSettings({
      quietStart: null, quietEnd: null,
      eventPerDoorPerDay: null, escalationPerDoorPerDay: null, perOwnerPerDay: null,
    });

  const today = foldTodayByDoor(view.today);

  return (
    <div className="lares-page lares-operational">
      <PageHeader title="Proactivity" description="When agents may speak, and what the gate decided." />
      <p className="lares-muted lares-operational-intro">
        When the agents may start a conversation with you, how often, and what they decided today.
        Every proactive message in the fleet passes this one gate — a message held back is recorded, never lost.
      </p>

      {view.errors.length > 0 && (
        <div className="card lares-operational-error" role="alert">
          {view.errors.map((e) => <p key={e}>{e}</p>)}
        </div>
      )}

      <h2>Do not disturb</h2>
      <p className="lares-muted lares-operational-note">Stops agents from starting anything. Reminders you set yourself are stopped too — this is the switch that means silence.</p>
      <DndSection scopes={dndScopes} />

      <h2>Quiet hours</h2>
      <p className="lares-muted lares-operational-note">
        Owner clock: <span className="mono">{clock.tz}</span> via <span className="mono">{clock.source}</span> ({clock.detail}).
        Home timezone <span className="mono">{view.homeTz}</span> (set by <span className="mono">OWNER_HOME_TZ</span> on the box).
        {view.agents.includes("marcel") && " A trip in Marcel's trip store can outrank both; that source is visible on the box, not here."}
      </p>
      <BriefLanguageControl language={briefLanguage.language} unavailable={briefLanguage.unavailable} />
      <p className="lares-muted lares-operational-note">
        Movable, not removable: the window may sit anywhere but must stay at least {ENGINE.quietMinHours} h long.
        Default {ENGINE.quietStart}–{ENGINE.quietEnd}. A reminder you set yourself still arrives inside quiet hours;
        anything the world caused waits until the window ends.
      </p>
      <QuietSection scopes={quietScopes} />
      {view.doors.length === 1 && (
        <p className="lares-muted lares-operational-note">Only the shared setting exists so far — a chat or channel appears here once an agent has spoken through it.</p>
      )}

      <h2>When the agents speak</h2>
      <p className="lares-muted lares-operational-note">
        Hours are on your clock (<span className="mono">{clock.tz}</span>). A change here takes
        effect within about five minutes and applies from the next slot — never the one already on
        its way. Moving a brief&apos;s hour after today&apos;s has already gone out does not send a
        second one; effective values are shown below, and a schedule with no row of its own is
        marked as default.
      </p>
      <ScheduleHoursControl rows={scheduleHours.rows} unavailable={scheduleHours.unavailable} />

      <h2>Ceilings</h2>
      <p className="lares-muted lares-operational-note">The most you can be interrupted in one day. Lower them freely; the engine maximum is the highest they can go.</p>
      <CeilingSection values={globalCeilings} engine={ENGINE} />

      <h2>Today <span className="lares-section-count">({view.todayDay}, your clock)</span></h2>
      <div className="lares-table-scroll"><table className="card lares-operational-table">
        <thead><tr><th>Door</th><th>Sent</th><th>Held back</th><th>Waiting</th></tr></thead>
        <tbody>
          {today.length === 0 && (
            <tr><td colSpan={4} className="lares-status-muted">Nothing yet today.</td></tr>
          )}
          {today.map((d) => (
            <tr key={d.door}>
              <td className="mono">{doorLabel(d.door)}</td>
              <td className="mono">{d.sent}</td>
              <td><Reasons rows={d.suppressed} /></td>
              <td><Reasons rows={d.deferred} /></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <p className="lares-muted lares-operational-note">Held back = dropped for good. Waiting = deferred, and reconsidered when the window or the day opens.</p>

      <h2>
        Last 50 decisions <span className="lares-section-count">({view.recent.length} recorded)</span>
      </h2>
      <div className="lares-table-scroll"><table className="card lares-operational-table">
        <thead><tr><th>Time</th><th>Agent</th><th>Door</th><th>Class</th><th>Item</th><th>Status</th><th>Reason</th></tr></thead>
        <tbody>
          {view.recent.length === 0 && (
            <tr><td colSpan={7} className="lares-status-muted">The ledger is empty — no agent has initiated anything yet.</td></tr>
          )}
          {view.recent.map((r) => (
            <tr key={r.id}>
              <td className="mono lares-operational-nowrap">{formatInOwnerTz(r.decidedAt, clock.tz)}</td>
              <td className="mono">{r.agent}</td>
              <td className="mono">{doorLabel(r.door)}</td>
              <td className="mono lares-status-muted">{r.cls}</td>
              <td className="mono lares-status-muted">{r.itemKey}</td>
              <td className={`mono ${r.status === "sent" ? "lares-status-success" : r.status === "suppressed" ? "lares-status-error" : "lares-status-warning"}`}>{r.status}</td>
              <td className="lares-status-muted">
                {reasonLabel(r.reason)}
                {r.untilAt !== null && <> · until {formatInOwnerTz(r.untilAt, clock.tz)}</>}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}
