import { requireConsolePage } from "../../lib/auth";
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
import { Notice, PageHeader, Page } from "@lares/ui/patterns";
import { Badge } from "@lares/ui/primitives/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lares/ui/primitives/card";

export const dynamic = "force-dynamic";

/**
 *  — the owner's surface for the proactivity gate.
 *
 * One page for four questions: may an agent speak at all (do not disturb), when is it too late
 * (quiet hours, on the owner's clock), how often at most (the limits), and what actually happened
 * (today's ledger and the last 50 decisions). The ledger is the part that makes the rest
 * trustworthy: a suppression nobody can see is indistinguishable from an agent that broke.
 */
/** What the gate decided, in the same words as the columns of today's table. */
const DECISION: Record<string, { word: string; variant: "success" | "error" | "warning" }> = {
  sent: { word: "Sent", variant: "success" },
  suppressed: { word: "Held back", variant: "error" },
  deferred: { word: "Waiting", variant: "warning" },
};

function Reasons({ rows }: { rows: TodayRowDTO[] }) {
  const total = rows.reduce((n, r) => n + r.count, 0);
  if (total === 0) return <span className="lares-muted">—</span>;
  return (
    <>
      <span className="mono">{total}</span>
      <span className="lares-muted">
        {" "}({rows.map((r) => `${r.count} ${reasonLabel(r.reason) || "no reason recorded"}`).join(", ")})
      </span>
    </>
  );
}

export default async function ProactivityPage() {
  await requireConsolePage();
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
    <Page>
      <PageHeader
        title="Quiet hours and delivery"
        description="When the agents may start a conversation with you, how often, and what they decided today."
      />
      <p className="lares-muted">
        Every message an agent starts on its own passes the rules on this page. A message that is not sent is still recorded here, so you can see why.
      </p>

      {view.errors.length > 0 && (
        <Notice error>
          {view.errors.map((e) => <p key={e}>{e}</p>)}
        </Notice>
      )}

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>Do not disturb</CardTitle>
          <CardDescription>Stops agents from starting anything. Reminders you set yourself are stopped too: this is the switch that means silence. A change applies as soon as you flip the switch.</CardDescription>
        </CardHeader>
        <DndSection scopes={dndScopes} />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>Quiet hours</CardTitle>
          <CardDescription>
            You can move quiet hours anywhere in the day, but not remove them: they must stay at least {ENGINE.quietMinHours} hours long.
            Unless you change them they run from {ENGINE.quietStart} to {ENGINE.quietEnd}. A reminder you set yourself still arrives inside quiet hours;
            anything the world caused waits until they end.
          </CardDescription>
        </CardHeader>
        <CardContent className="lares-stack">
          <p className="lares-muted">
            Owner clock: <span className="mono">{clock.tz}</span> via <span className="mono">{clock.source}</span> ({clock.detail}).
            Home timezone <span className="mono">{view.homeTz}</span> (set by <span className="mono">OWNER_HOME_TZ</span> on the box).
          </p>
          <BriefLanguageControl language={briefLanguage.language} unavailable={briefLanguage.unavailable} />
        </CardContent>
        <QuietSection scopes={quietScopes} />
        {view.doors.length === 1 && (
          <CardContent>
            <p className="lares-muted">Only the shared setting exists so far. A chat or channel appears here once an agent has spoken through it.</p>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>When the agents speak</CardTitle>
          <CardDescription>
            Hours are on your clock (<span className="mono">{clock.tz}</span>). A change here is
            picked up within about five minutes. A brief goes out only at the start of its hour, so a
            change applies from the next full hour after that, never the one already on its way. Moving a brief&apos;s hour after today&apos;s has already gone out does not send a
            second one. The hours in use are shown below, and a schedule you have not changed is
            marked as default.
          </CardDescription>
        </CardHeader>
        <ScheduleHoursControl rows={scheduleHours.rows} unavailable={scheduleHours.unavailable} />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>Limits</CardTitle>
          <CardDescription>The most you can be interrupted in one day. Lower them freely; each has a highest number it can be set to.</CardDescription>
        </CardHeader>
        <CeilingSection values={globalCeilings} engine={ENGINE} />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>Today</CardTitle>
          <CardDescription>
            {view.todayDay}, your clock. Held back means the message was dropped and will not be sent later. Waiting means it was put off, and is looked at again when quiet hours end or a new day starts.
          </CardDescription>
        </CardHeader>
        <div className="lares-table-scroll"><table>
          <thead><tr><th>Door</th><th>Sent</th><th>Held back</th><th>Waiting</th></tr></thead>
          <tbody>
            {today.length === 0 && (
              <tr><td colSpan={4} className="lares-muted">Nothing yet today.</td></tr>
            )}
            {today.map((d) => (
              <tr key={d.door}>
                <td>{doorLabel(d.door)}</td>
                <td className="mono">{d.sent}</td>
                <td><Reasons rows={d.suppressed} /></td>
                <td><Reasons rows={d.deferred} /></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>Last 50 decisions</CardTitle>
          <CardDescription>({view.recent.length} recorded)</CardDescription>
        </CardHeader>
        <div className="lares-table-scroll"><table>
          <thead><tr><th>Time</th><th>Agent</th><th>Door</th><th>Kind</th><th>About</th><th>Decision</th><th>Reason</th></tr></thead>
          <tbody>
            {view.recent.length === 0 && (
              <tr><td colSpan={7} className="lares-muted">Nothing recorded yet: no agent has started a conversation on its own.</td></tr>
            )}
            {view.recent.map((r) => {
              const decision = DECISION[r.status];
              return (
                <tr key={r.id}>
                  <td className="mono"><time dateTime={r.decidedAt.toISOString()}>{formatInOwnerTz(r.decidedAt, clock.tz)}</time></td>
                  <td>{r.agent}</td>
                  <td>{doorLabel(r.door)}</td>
                  <td className="lares-muted">{r.cls}</td>
                  <td className="mono lares-muted">{r.itemKey}</td>
                  <td>{decision ? <Badge variant={decision.variant}>{decision.word}</Badge> : <Badge>{r.status}</Badge>}</td>
                  <td className="lares-muted">
                    {reasonLabel(r.reason)}
                    {r.fallbackNote && <>{r.reason ? " · " : ""}{r.fallbackNote}</>}
                    {r.untilAt !== null && <> · until {formatInOwnerTz(r.untilAt, clock.tz)}</>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </Card>
    </Page>
  );
}
