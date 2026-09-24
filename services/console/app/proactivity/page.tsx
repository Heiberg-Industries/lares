import {
  AGENTS, ENGINE, agentLabel, doorLabel, effectiveDnd, effectiveQuietWindow, effectiveSettings,
  foldTodayByDoor, formatInOwnerTz, getProactivityView, reasonLabel, rowFor,
} from "../../lib/proactivity";
import type { TodayRowDTO } from "../../lib/proactivity";
import { CeilingSection, DndSection, QuietSection } from "../../components/ProactivityControls";
import type { DndScope, QuietScope } from "../../components/ProactivityControls";
import { BriefLanguageControl } from "../../components/BriefLanguageControl";
import { readBriefLanguage } from "../../lib/brief-settings";
import { ScheduleHoursControl } from "../../components/ScheduleHoursControl";
import { readScheduleHoursSettings } from "../../lib/schedule-settings";

export const dynamic = "force-dynamic";

/**
 * ORB-193 — the owner's surface for the proactivity gate.
 *
 * One page for four questions: may an agent speak at all (do not disturb), when is it too late
 * (quiet hours, on the owner's clock), how often at most (the ceilings), and what actually happened
 * (today's ledger and the last 50 decisions). The ledger is the part that makes the rest
 * trustworthy: a suppression nobody can see is indistinguishable from an agent that broke.
 */
const label = { fontSize: 14 } as const;
const lede = { color: "var(--mist)", fontSize: 12, marginTop: 4 } as const;

function Reasons({ rows }: { rows: TodayRowDTO[] }) {
  const total = rows.reduce((n, r) => n + r.count, 0);
  if (total === 0) return <span style={{ color: "var(--mist)" }}>—</span>;
  return (
    <>
      <span className="mono">{total}</span>
      <span style={{ color: "var(--mist)" }}>
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
    ...AGENTS.map((a) => {
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
    <>
      <h1 className="mono" style={{ fontSize: 18 }}>Proactivity</h1>
      <p style={lede}>
        When the agents may start a conversation with you, how often, and what they decided today.
        Every proactive message in the fleet passes this one gate — a message held back is recorded, never lost.
      </p>

      {view.errors.length > 0 && (
        <div className="card" style={{ padding: 12, marginTop: 12, borderColor: "var(--bad)" }}>
          {view.errors.map((e) => <p key={e} className="mono" style={{ color: "var(--bad)", fontSize: 12, margin: 0 }}>{e}</p>)}
        </div>
      )}

      <h2 className="mono" style={{ ...label, marginTop: 24 }}>Do not disturb</h2>
      <p style={lede}>Stops agents from starting anything. Reminders you set yourself are stopped too — this is the switch that means silence.</p>
      <DndSection scopes={dndScopes} />

      <h2 className="mono" style={{ ...label, marginTop: 24 }}>Quiet hours</h2>
      <p style={lede}>
        Owner clock: <span className="mono">{clock.tz}</span> via <span className="mono">{clock.source}</span> ({clock.detail}).
        Home timezone <span className="mono">{view.homeTz}</span> (set by <span className="mono">OWNER_HOME_TZ</span> on the box).
        A trip in Marcel&apos;s trip store outranks both — that source is visible on the box, not from here, because the console
        does not mount it.
      </p>
      <BriefLanguageControl language={briefLanguage.language} unavailable={briefLanguage.unavailable} />
      <p style={lede}>
        Movable, not removable: the window may sit anywhere but must stay at least {ENGINE.quietMinHours} h long.
        Default {ENGINE.quietStart}–{ENGINE.quietEnd}. A reminder you set yourself still arrives inside quiet hours;
        anything the world caused waits until the window ends.
      </p>
      <QuietSection scopes={quietScopes} />
      {view.doors.length === 1 && (
        <p style={lede}>Only the shared setting exists so far — a chat or channel appears here once an agent has spoken through it.</p>
      )}

      <h2 className="mono" style={{ ...label, marginTop: 24 }}>When the agents speak</h2>
      <p style={lede}>
        Hours are on your clock (<span className="mono">{clock.tz}</span>). A change here takes
        effect within about five minutes and applies from the next slot — never the one already on
        its way. Moving a brief&apos;s hour after today&apos;s has already gone out does not send a
        second one; effective values are shown below, and a schedule with no row of its own is
        marked as default.
      </p>
      <ScheduleHoursControl rows={scheduleHours.rows} unavailable={scheduleHours.unavailable} />

      <h2 className="mono" style={{ ...label, marginTop: 24 }}>Ceilings</h2>
      <p style={lede}>The most you can be interrupted in one day. Lower them freely; the engine maximum is the highest they can go.</p>
      <CeilingSection values={globalCeilings} engine={ENGINE} />

      <h2 className="mono" style={{ ...label, marginTop: 24 }}>Today <span style={{ color: "var(--mist)", fontSize: 12 }}>({view.todayDay}, your clock)</span></h2>
      <table className="card" style={{ marginTop: 8 }}>
        <thead><tr><th>Door</th><th>Sent</th><th>Held back</th><th>Waiting</th></tr></thead>
        <tbody>
          {today.length === 0 && (
            <tr><td colSpan={4} style={{ color: "var(--mist)" }}>Nothing yet today.</td></tr>
          )}
          {today.map((d) => (
            <tr key={d.door}>
              <td className="mono" style={{ fontSize: 12 }}>{doorLabel(d.door)}</td>
              <td className="mono">{d.sent}</td>
              <td style={{ fontSize: 12 }}><Reasons rows={d.suppressed} /></td>
              <td style={{ fontSize: 12 }}><Reasons rows={d.deferred} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={lede}>Held back = dropped for good. Waiting = deferred, and reconsidered when the window or the day opens.</p>

      <h2 className="mono" style={{ ...label, marginTop: 24 }}>
        Last 50 decisions <span style={{ color: "var(--mist)", fontSize: 12 }}>({view.recent.length} recorded)</span>
      </h2>
      <table className="card" style={{ marginTop: 8 }}>
        <thead><tr><th>Time</th><th>Agent</th><th>Door</th><th>Class</th><th>Item</th><th>Status</th><th>Reason</th></tr></thead>
        <tbody>
          {view.recent.length === 0 && (
            <tr><td colSpan={7} style={{ color: "var(--mist)" }}>The ledger is empty — no agent has initiated anything yet.</td></tr>
          )}
          {view.recent.map((r) => (
            <tr key={r.id}>
              <td className="mono" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{formatInOwnerTz(r.decidedAt, clock.tz)}</td>
              <td className="mono" style={{ fontSize: 12 }}>{r.agent}</td>
              <td className="mono" style={{ fontSize: 12 }}>{doorLabel(r.door)}</td>
              <td className="mono" style={{ fontSize: 12, color: "var(--mist)" }}>{r.cls}</td>
              <td className="mono" style={{ fontSize: 12, color: "var(--mist)" }}>{r.itemKey}</td>
              <td className="mono" style={{ fontSize: 12, color: r.status === "sent" ? "var(--ok)" : r.status === "suppressed" ? "var(--bad)" : "var(--warn)" }}>{r.status}</td>
              <td style={{ fontSize: 12, color: "var(--mist)" }}>
                {reasonLabel(r.reason)}
                {r.untilAt !== null && <> · until {formatInOwnerTz(r.untilAt, clock.tz)}</>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
