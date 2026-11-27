import { requirePage } from "../../lib/auth";
import { getRelearnStatus, getVoiceCards, listVoiceExamples } from "../../lib/voice";
import { VoiceCardEditor } from "../../components/VoiceCardEditor";
import { VoiceSettings } from "../../components/VoiceSettings";
import { ProposedCard } from "../../components/ProposedCard";
import { ExampleToggle } from "../../components/ExampleToggle";
import { RelearnButton } from "../../components/RelearnButton";
import { EmptyState, PageHeader, Page, Row, Rows } from "@lares/ui/patterns";
import { Badge } from "@lares/ui/primitives/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@lares/ui/primitives/card";

export const dynamic = "force-dynamic";

// One style card per mailbox. `default` is the shared fallback (and carries the learn
// settings); each enrolled mailbox has its own card, its own proposal and its own learn status.
// A mailbox whose card is still empty drafts with the default card until it has learned.
export default async function VoicePage() {
  await requirePage("admin");
  const [cards, examples] = await Promise.all([getVoiceCards(), listVoiceExamples()]);
  // The learn status is the whole job's, not the `default` card's: a run writes its status on the
  // mailbox's own row and its outcome in the job record, never on `default`.
  const relearn = await getRelearnStatus(cards);
  const def = cards[0]!;
  const mailboxes = cards.slice(1);
  return (
    <Page>
      <PageHeader
        title="Writing style"
        description="How your agents write email for you: one style per mailbox, and shared defaults."
      />
      <p className="lares-muted">
        One card per mailbox, because you write differently from each. A card is learned from that mailbox&apos;s Sent mail; your edits always win.
        A mailbox with an empty card uses the shared defaults below until it has learned.
      </p>

      <RelearnButton status={relearn} />

      {mailboxes.length === 0 && (
        <EmptyState title="No mailbox cards yet">Press Re-learn from Sent mail to create them.</EmptyState>
      )}
      {mailboxes.map((card) => (
        <Card key={card.id}>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>{card.id}</CardTitle>
            {card.learnStatus === "error" && <CardDescription>Learning from this mailbox failed last time{card.learnMessage ? `: ${card.learnMessage}` : "."}</CardDescription>}
            {card.learnStatus === "error" && <CardAction><Badge variant="error">Last learn failed</Badge></CardAction>}
            {card.learnStatus === "running" && <CardAction><Badge variant="info">Learning…</Badge></CardAction>}
          </CardHeader>
          <CardContent className="lares-stack">
            {card.proposed && <ProposedCard id={card.id} proposed={card.proposed} />}
            <VoiceCardEditor id={card.id} core={card.core} notesEn={card.notesEn} notesNo={card.notesNo} />
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>Shared defaults</CardTitle>
          <CardDescription>Used by any mailbox whose own card is empty.</CardDescription>
        </CardHeader>
        <CardContent className="lares-stack">
          {def.proposed && <ProposedCard id={def.id} proposed={def.proposed} />}
          <VoiceCardEditor id={def.id} core={def.core} notesEn={def.notesEn} notesNo={def.notesNo} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>Learn settings</CardTitle>
          <CardDescription>
            Limit how far back learning reads Sent mail and how many messages it checks per mailbox.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VoiceSettings lookbackDays={def.lookbackDays} cap={def.cap} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>Example emails ({examples.length})</CardTitle>
          <CardDescription>Untick an example to stop using it for your style. The email stays stored.</CardDescription>
        </CardHeader>
        {examples.length === 0 ? (
          <CardContent className="lares-muted">No examples yet. Press Re-learn from Sent mail above.</CardContent>
        ) : (
          <Rows label="Example emails">
            {examples.map((e) => (
              <Row
                key={e.id}
                title={e.snippet}
                description={`Language: ${e.lang}`}
                control={<ExampleToggle id={e.id} included={e.included} />}
              />
            ))}
          </Rows>
        )}
      </Card>
    </Page>
  );
}
