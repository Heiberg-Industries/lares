import {
  daysUntil, dueColor, getDeadlinesView, standingDateLabel, STATUTORY_RULES_MIRROR,
} from "../../lib/deadlines";
import { homeTz, ownerDayIn, resolveConsoleOwnerClock } from "../../lib/proactivity";
import {
  AddForm, CandidateRow, LadderSwitch, MintForm, OpenRow,
} from "../../components/DeadlineControls";
import type { CandidateDTO, MintRule, OpenDeadlineRow } from "../../components/DeadlineControls";

export const dynamic = "force-dynamic";

/**
 * ORB-180 — the owner's surface for the standing deadline calendar: the escalation ladder switch,
 * what is open and when it is due, adding a one-off deadline, minting a confirmed statutory year
 * from the mirror, the mail-scanner's unresolved candidates, and the last 20 closed rows.
 */
const lede = { color: "var(--mist)", fontSize: 12, marginTop: 4 } as const;

export default async function DeadlinesPage() {
  const now = new Date();
  const view = await getDeadlinesView();
  const clock = resolveConsoleOwnerClock(now, { homeTz: homeTz() });
  const today = ownerDayIn(now, clock.tz);

  const openRows: OpenDeadlineRow[] = view.open.map((d) => {
    const days = daysUntil(d.dueDate, now, clock.tz);
    return {
      id: d.id, entity: d.entity, title: d.title, dueDate: d.dueDate, days,
      colorToken: dueColor(days), source: d.source, rung: d.rung, consequence: d.consequence,
      vendor: d.vendor, amount: d.amount, currency: d.currency,
    };
  });

  const mintRules: MintRule[] = STATUTORY_RULES_MIRROR.map((r) => ({
    key: r.key, title: r.title, standingDate: standingDateLabel(r.month, r.day),
    recurrence: r.recurrence, consequence: r.consequence,
    month: r.month, day: r.day, yearOffset: r.yearOffset,
  }));

  const candidates: CandidateDTO[] = view.candidates.map((c) => ({
    threadId: c.threadId, subject: c.subject, sender: c.sender,
    seenAtLabel: c.seenAt.toISOString().slice(0, 10), surfaced: c.surfacedAt !== null,
  }));

  return (
    <>
      <h1 className="mono" style={{ fontSize: 18 }}>Deadlines</h1>
      <p style={lede}>
        The standing calendar for statutory, accounting, contract and subscription deadlines.
        Nothing here calls an authority — every date is confirmed by a human, not fetched.
      </p>

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>Ladder</h2>
      <p style={lede}>
        {view.ladderEnabled
          ? "The escalation ladder is on: a day-before nudge, a due-day nudge for statutory rows, and a final stop the day after."
          : "OFF: the brief still lists deadlines; nothing is sent on its own."}
      </p>
      <LadderSwitch enabled={view.ladderEnabled} />

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
        Open <span style={{ color: "var(--mist)", fontSize: 12 }}>({today}, your clock)</span>
      </h2>
      <table className="card" style={{ marginTop: 8 }}>
        <thead>
          <tr><th>Entity</th><th>Title</th><th>Due</th><th>Days</th><th>Source</th><th>Rung</th><th>Consequence</th><th>Vendor / amount</th><th></th></tr>
        </thead>
        <tbody>
          {openRows.length === 0 && (
            <tr><td colSpan={9} style={{ color: "var(--mist)" }}>Nothing open.</td></tr>
          )}
          {openRows.map((row) => <OpenRow key={row.id} row={row} />)}
        </tbody>
      </table>

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>Add</h2>
      <AddForm />

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>Mint a statutory year</h2>
      <p style={lede}>
        A mint adds only the terms still ahead of today — a date already past is greyed here and
        skipped; add it by hand if it is genuinely still owed.
      </p>
      <MintForm rules={mintRules} defaultYear={Number(today.slice(0, 4))} today={today} />

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>Candidates</h2>
      <p style={lede}>Deadlines the mail scanner has spotted but not yet turned into a row.</p>
      <table className="card" style={{ marginTop: 8 }}>
        <thead><tr><th>Subject</th><th>Sender</th><th>Seen</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {candidates.length === 0 && (
            <tr><td colSpan={5} style={{ color: "var(--mist)" }}>No unresolved candidates.</td></tr>
          )}
          {candidates.map((c) => <CandidateRow key={c.threadId} candidate={c} />)}
        </tbody>
      </table>

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
        Closed, last 20 <span style={{ color: "var(--mist)", fontSize: 12 }}>({view.closed.length} shown)</span>
      </h2>
      <table className="card" style={{ marginTop: 8 }}>
        <thead><tr><th>Entity</th><th>Title</th><th>Due</th><th>Status</th><th>Reason</th><th>Resolved</th></tr></thead>
        <tbody>
          {view.closed.length === 0 && (
            <tr><td colSpan={6} style={{ color: "var(--mist)" }}>Nothing closed yet.</td></tr>
          )}
          {view.closed.map((d) => (
            <tr key={d.id}>
              <td className="mono" style={{ fontSize: 12 }}>{d.entity}</td>
              <td style={{ fontSize: 13 }}>{d.title}</td>
              <td className="mono" style={{ fontSize: 12 }}>{d.dueDate}</td>
              <td className="mono" style={{ fontSize: 12, color: d.status === "done" ? "var(--ok)" : "var(--mist)" }}>{d.status}</td>
              <td style={{ fontSize: 12, color: "var(--mist)" }}>{d.statusReason ?? "—"}</td>
              <td className="mono" style={{ fontSize: 12, color: "var(--mist)" }}>
                {d.resolvedAt ? d.resolvedAt.toISOString().slice(0, 10) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
