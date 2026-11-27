import type { ReactNode } from "react";
import Link from "next/link";
import { Notice, PageHeader, Row, Rows } from "@lares/ui/patterns";
import { Badge } from "@lares/ui/primitives/badge";
import { Card, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import type { BoardRowDTO, ConnectionRowDTO } from "../lib/contracts";
import { STATUS_BADGE, STATUS_TEXT, type IntegrationCard } from "../lib/integrations-grid";
import { boardRowsFor, keptText, lastUseText } from "../lib/connection-words";
import { ServicePermissions } from "./ServicePermissions";

/** Plain names for the built-in services a connection can be declared for; an unknown id is shown as is. */
const BUILT_IN_NAMES: Record<string, string> = { "notion-sync": "Notion sync" };
const builtInName = (id: string) => BUILT_IN_NAMES[id] ?? id;

/** The top of every integration's page: its name, one line and the status the list shows. */
export function IntegrationHeader({ card, actions }: { card: IntegrationCard; actions?: ReactNode }) {
  return (
    <>
      <Link href="/integrations">← Integrations</Link>
      <PageHeader title={card.name} description={card.line} actions={<>
        <Badge variant={STATUS_BADGE[card.status]}>{STATUS_TEXT[card.status]}</Badge>
        {actions}
      </>} />
    </>
  );
}

/** Which agents use a service, what each may do with it, when it was last used and where its key is
 *  kept. `board` null means the permission rows could not be read. */
export function IntegrationDetail({ card, rows, board, owner }: { card: IntegrationCard; rows: ConnectionRowDTO[]; board: BoardRowDTO[] | null;
  /** True for the owner, who alone changes how freely an agent acts. */
  owner: boolean }) {
  const several = rows.length > 1;
  const permissions = board ? boardRowsFor(card.id, board) : [];
  return (
    <>
      <IntegrationHeader card={card} />
      {rows.some((r) => r.usageUnavailable) && <Notice tone="needs-you">Usage unavailable. Recorded connection activity could not be read.</Notice>}
      {rows.map((r) => (
        <Card key={r.instanceId} role={several ? "group" : undefined} aria-label={several ? r.label : undefined}>
          {several && <CardHeader><CardTitle role="heading" aria-level={2}>{r.label}</CardTitle></CardHeader>}
          <Rows>
            <Row title="Which agents use it" description={r.usedBy.length ? r.usedBy.join(", ") : "No agent has access yet."} />
            <Row title="Last use" description={lastUseText(r)} />
            <Row title="Where its key is kept" description={keptText(r.custody)} />
            {r.declaredFor.length > 0 && (
              <Row title="Built in for" description={<>{r.declaredFor.map(builtInName).join(", ")}. This lists what Lares can use it for, not what runs here.</>} />
            )}
          </Rows>
        </Card>
      ))}
      {board === null ? (
        <Notice tone="needs-you">What agents may do with it could not be read. Reload the page to try again.</Notice>
      ) : permissions.length > 0 && (
        <section className="lares-stack">
          <h2 className="lares-section-title">What agents may do with it</h2>
          <ServicePermissions rows={permissions} canChange={owner} />
        </section>
      )}
    </>
  );
}
