import { requirePage } from "../../lib/auth";
import { Notice, PageHeader, Page } from "@lares/ui/patterns";
import { Card, CardDescription, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import {
  daysUntil,
  dueColor,
  getDeadlinesView,
  standingDateLabel,
  readStatutoryCalendar,
} from "../../lib/deadlines";
import {
  homeTz,
  ownerDayIn,
  resolveConsoleOwnerClock,
} from "../../lib/proactivity";
import {
  AddForm,
  CandidateRow,
  LadderSwitch,
  MintForm,
  OpenRow,
} from "../../components/DeadlineControls";
import type {
  CandidateDTO,
  MintRule,
  OpenDeadlineRow,
} from "../../components/DeadlineControls";

export const dynamic = "force-dynamic";

/**
 *  — the owner's surface for the standing deadline calendar: what is open and when it is due,
 * the mail-scanner's unresolved candidates, the last 20 closed rows, adding a one-off deadline,
 * the reminders switch, and adding a confirmed year of fixed legal deadlines from the mirror.
 */

export default async function DeadlinesPage() {
  await requirePage("admin");
  const now = new Date();
  const view = await getDeadlinesView();
  const clock = resolveConsoleOwnerClock(now, { homeTz: homeTz() });
  const today = ownerDayIn(now, clock.tz);

  const openRows: OpenDeadlineRow[] = view.open.map((d) => {
    const days = daysUntil(d.dueDate, now, clock.tz);
    return {
      id: d.id,
      entity: d.entity,
      title: d.title,
      dueDate: d.dueDate,
      days,
      colorToken: dueColor(days),
      source: d.source,
      rung: d.rung,
      consequence: d.consequence,
      vendor: d.vendor,
      amount: d.amount,
      currency: d.currency,
    };
  });

  const calendar = readStatutoryCalendar();
  const mintRules: MintRule[] = (calendar?.rules ?? []).map((r) => ({
    key: r.key,
    title: r.title,
    standingDate: standingDateLabel(r.month, r.day),
    recurrence: r.recurrence,
    consequence: r.consequence,
    month: r.month,
    day: r.day,
    yearOffset: r.yearOffset,
  }));

  const candidates: CandidateDTO[] = view.candidates.map((c) => ({
    threadId: c.threadId,
    subject: c.subject,
    sender: c.sender,
    seenAtLabel: c.seenAt.toISOString().slice(0, 10),
    surfaced: c.surfacedAt !== null,
  }));

  return (
    <Page>
      <PageHeader
        title="Deadlines"
        description="What is due, and what needs a little preparation."
      />
      <p className="lares-note">
        The standing calendar for statutory, accounting, contract and
        subscription deadlines. Nothing here calls an authority — every date is
        confirmed by a human, not fetched.
      </p>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>Open</CardTitle>
          <CardDescription>
            {today}, your clock. Done closes a completed deadline; Dismiss closes one that no longer applies. Both ask for a reason before saving.
          </CardDescription>
        </CardHeader>
        <div className="lares-table-scroll"><table>
          <thead>
            <tr>
              <th>Entity</th>
              <th>Title</th>
              <th>Due</th>
              <th>Days</th>
              <th>Source</th>
              <th>Reminder step</th>
              <th>Consequence</th>
              <th>Vendor / amount</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {openRows.length === 0 && (
              <tr>
                <td colSpan={9} className="lares-status-muted">
                  Nothing open.
                </td>
              </tr>
            )}
            {openRows.map((row) => (
              <OpenRow key={row.id} row={row} />
            ))}
          </tbody>
        </table></div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>Candidates</CardTitle>
          <CardDescription>
            Deadlines the mail scanner has spotted but not yet turned into a row.
          </CardDescription>
        </CardHeader>
        <div className="lares-table-scroll"><table>
          <thead>
            <tr>
              <th>Subject</th>
              <th>Sender</th>
              <th>Seen</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {candidates.length === 0 && (
              <tr>
                <td colSpan={5} className="lares-status-muted">
                  No unresolved candidates.
                </td>
              </tr>
            )}
            {candidates.map((c) => (
              <CandidateRow key={c.threadId} candidate={c} />
            ))}
          </tbody>
        </table></div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>Closed, last 20</CardTitle>
          <CardDescription>{view.closed.length} shown</CardDescription>
        </CardHeader>
        <div className="lares-table-scroll"><table>
          <thead>
            <tr>
              <th>Entity</th>
              <th>Title</th>
              <th>Due</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Resolved</th>
            </tr>
          </thead>
          <tbody>
            {view.closed.length === 0 && (
              <tr>
                <td colSpan={6} className="lares-status-muted">
                  Nothing closed yet.
                </td>
              </tr>
            )}
            {view.closed.map((d) => (
              <tr key={d.id}>
                <td className="mono lares-small">
                  {d.entity}
                </td>
                <td className="lares-small">{d.title}</td>
                <td className="mono lares-small">
                  {d.dueDate}
                </td>
                <td className={`mono lares-small ${d.status === "done" ? "lares-status-success" : "lares-status-muted"}`}>
                  {d.status}
                </td>
                <td className="lares-small lares-status-muted">
                  {d.statusReason ?? "—"}
                </td>
                <td className="mono lares-small lares-status-muted">
                  {d.resolvedAt ? d.resolvedAt.toISOString().slice(0, 10) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Card>

      <details className="lares-disclosure">
        <summary>Add a deadline</summary>
        <AddForm />
      </details>
      <details className="lares-disclosure">
        <summary>Reminders and the year&apos;s legal deadlines</summary>
        <div className="lares-stack">
          <section className="lares-stack">
            <h2 className="lares-section-title">Reminders</h2>
            <LadderSwitch enabled={view.ladderEnabled} />
          </section>
          <section className="lares-stack">
            <h2 className="lares-section-title">Add the year&apos;s legal deadlines</h2>
            <p className="lares-note">
              Creates the fixed legal deadlines for one year, from the calendar set up for this installation. It adds
              only the dates still ahead of today — a date already past is greyed here and skipped; add it by hand if
              it is genuinely still owed.
            </p>
            {calendar === null ? (
              <Notice>
                No statutory calendar is set up for this installation, so there are no fixed legal deadlines to add.
                Add deadlines one at a time above.
              </Notice>
            ) : (
              <MintForm
                rules={mintRules}
                jurisdiction={calendar.jurisdiction}
                defaultYear={Number(today.slice(0, 4))}
                today={today}
              />
            )}
          </section>
        </div>
      </details>
    </Page>
  );
}
