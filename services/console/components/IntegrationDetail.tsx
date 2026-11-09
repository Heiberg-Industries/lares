import type { ReactNode } from "react";
import Link from "next/link";
import { PageHeader } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import type { BoardRowDTO, ConnectionRowDTO } from "../lib/contracts";
import { STATUS_TEXT, type IntegrationCard } from "../lib/integrations-grid";
import { boardRowsFor, keptText, lastUseText } from "../lib/connection-words";
import { LogoTile } from "./LogoTile";
import { ServicePermissions } from "./ServicePermissions";

/** The top of every integration's page: its logo, name, one line and the status the grid shows. */
export function IntegrationHeader({ card, actions }: { card: IntegrationCard; actions?: ReactNode }) {
  return (
    <>
      <Link href="/integrations">← Integrations</Link>
      <div className="lares-actions">
        <LogoTile logo={card.logo} label={`${card.name} logo`} />
        <span className="lares-card-status" data-enabled={card.status === "enabled"}>{STATUS_TEXT[card.status]}</span>
      </div>
      <PageHeader title={card.name} description={card.line} actions={actions} />
    </>
  );
}

/** Which agents use a service, what each may do with it, when it was last used and where its key is
 *  kept. `board` null means the permission rows could not be read. */
export function IntegrationDetail({ card, rows, board }: { card: IntegrationCard; rows: ConnectionRowDTO[]; board: BoardRowDTO[] | null }) {
  const several = rows.length > 1;
  const permissions = board ? boardRowsFor(card.id, board) : [];
  return (
    <>
      <IntegrationHeader card={card} actions={card.id === "notion" ? <Button variant="outline" asChild><Link href="/meetings">Meetings</Link></Button> : undefined} />
      {rows.some((r) => r.usageUnavailable) && <p className="lares-muted" role="status">Usage unavailable. Recorded connection activity could not be read.</p>}
      {rows.map((r) => (
        <section key={r.instanceId} className="lares-surface lares-stack" aria-label={several ? r.label : undefined}>
          {several && <h2 className="lares-section-title">{r.label}</h2>}
          <div>
            <h3 className="lares-section-title">Which agents use it</h3>
            <p>{r.usedBy.length ? r.usedBy.join(", ") : "No agent has access yet."}</p>
          </div>
          <div>
            <h3 className="lares-section-title">Last use</h3>
            <p>{lastUseText(r)}</p>
          </div>
          <div>
            <h3 className="lares-section-title">Where its key is kept</h3>
            <p>{keptText(r.custody)}</p>
          </div>
          {r.declaredFor.length > 0 && (
            <div>
              <h3 className="lares-section-title">Built in for</h3>
              <p>{r.declaredFor.join(", ")}</p>
              <p className="lares-muted">This lists what Lares can use it for, not what runs here.</p>
            </div>
          )}
        </section>
      ))}
      {board === null ? (
        <p className="lares-muted" role="status">What agents may do with it could not be read. Reload the page to try again.</p>
      ) : permissions.length > 0 && (
        <section className="lares-stack">
          <h2 className="lares-section-title">What agents may do with it</h2>
          <ServicePermissions rows={permissions} />
        </section>
      )}
    </>
  );
}
