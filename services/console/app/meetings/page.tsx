import { requirePage } from "../../lib/auth";
import { listAutoSendSeries } from "../../lib/meeting-series";
import { getMeetingsSourceView } from "../../lib/meetings-source";
import { getMeetingsLookupView } from "../../lib/clipping";
import { getCredentialView } from "../../lib/credentials";
import { getFollowupStatus } from "../../lib/meeting-followup-status";
import { listAgents } from "../../lib/agents";
import { notionAgents } from "../../lib/notion-agents";
import { MeetingSeriesRow } from "../../components/MeetingSeriesRow";
import { MeetingsSourceControl, type NotionConnected } from "../../components/MeetingsSourceControl";
import { KeepPageFresh } from "../../components/KeepPageFresh";
import { EmptyState, Notice, PageHeader, Page, Rows, RunStatus } from "@lares/ui/patterns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lares/ui/primitives/card";

export const dynamic = "force-dynamic";

/** Meetings: where the meeting notes come from, then the follow-ups an agent writes from them. */
export default async function MeetingsPage() {
  await requirePage("admin");
  const [source, lookup, credential, status, series, agents, chiefs] = await Promise.all([
    getMeetingsSourceView(), getMeetingsLookupView(), getCredentialView(), getFollowupStatus(), listAutoSendSeries(), listAgents(),
    notionAgents().catch(() => null),
  ]);
  // The lookup is answered by a chief of staff's "Clipping requests" schedule: say so when none has it on.
  const requestsOff = chiefs && chiefs.length > 0 && !chiefs.some((c) => c.answersRequests) ? chiefs : null;
  // Only the owner can read the key's state; for anyone else nothing is claimed about it.
  const notion: NotionConnected = credential.kind !== "status" ? "unknown"
    : credential.status.activeRevision && credential.status.state === "applied" ? "connected" : "not-connected";
  const names = Object.fromEntries(agents.map((a) => [a.name, a.displayName]));

  return (
    <Page className="lares-stack">
      <PageHeader title="Meetings" description="Where your meeting notes come from, and the follow-up emails an agent writes from them." />

      <MeetingsSourceControl view={source} initialLookup={lookup} notion={notion} names={names} requestsOff={requestsOff} />

      <Card role="region" aria-labelledby="followups-heading">
        <CardHeader>
          <CardTitle id="followups-heading" role="heading" aria-level={2}>Follow-ups</CardTitle>
          <CardDescription>
            After a meeting, an agent drafts a follow-up email from its notes and asks you before sending. For the recurring meetings below, it may send without asking.
          </CardDescription>
        </CardHeader>
        <CardContent className="lares-stack">
          {status === "unavailable"
            ? <Notice tone="needs-you">What the follow-ups last did could not be read. Reload the page to try again.</Notice>
            : status
              ? <><RunStatus label="Meeting follow-ups" state={status.state} when={status.when} why={status.why} fix={status.fix} /><KeepPageFresh active={status.active} /></>
              : <p className="lares-muted">The follow-ups have not run yet. They check the meeting notes every five minutes.</p>}
          <p className="lares-muted">
            Revoking a series doesn&apos;t delete its history. The follow-up goes back to needing your
            approval, the same as before it was switched on.
          </p>
          {series.length === 0 ? (
            <EmptyState title="No meeting series sends follow-ups on its own">
              Ask your agent to switch one on.
            </EmptyState>
          ) : (
            <Rows label="Meeting series that send follow-ups on their own">
              {series.map((s) => (
                <MeetingSeriesRow
                  key={`${s.agent}/${s.seriesKey}`}
                  agent={s.agent}
                  seriesKey={s.seriesKey}
                  name={s.name}
                  updatedBy={s.updatedBy}
                  updatedAt={s.updatedAt.toISOString().slice(0, 10)}
                />
              ))}
            </Rows>
          )}
        </CardContent>
      </Card>
    </Page>
  );
}
