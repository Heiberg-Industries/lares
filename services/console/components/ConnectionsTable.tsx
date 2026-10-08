import type { ConnectionRowDTO } from "../lib/contracts";
import { StatePill } from "./StatePill";
import { AddAccountForm } from "./AddAccountForm";
import { RemoveAccountButton } from "./RemoveAccountButton";

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

export function ConnectionsTable({ rows }: { rows: ConnectionRowDTO[] }) {
  // The add-mailbox flow is address-first (the domain picks the client), so the form is
  // NOT tied to any one row — it used to render once per Google row, and a form sitting under
  // "google · zero7" would happily connect a owner.example address through the heiberg client.
  // One form beneath the table matches what it actually does. The per-mailbox Remove button
  // stays inside each row's expando — that action genuinely is row-specific.
  const hasConsoleCustody = rows.some((r) => r.custody === "console");
  const accountsUnavailable = rows.some((r) => r.accountsUnavailable);
  const usageUnavailable = rows.some((r) => r.usageUnavailable);
  const active = rows.filter((r) => r.status !== "unknown" || r.usedBy.length > 0 || r.accounts.length > 0);
  const other = rows.filter((r) => !active.includes(r));
  const cards = (items: ConnectionRowDTO[]) => (
    <div className="lares-connections">
      {items.map((r) => (
        <section className="lares-surface lares-surface-compact" key={`${r.connectionId}:${r.instanceId}`}>
          <h2 className="lares-section-title">{r.label}</h2>
          <StatePill state={r.status} />
          <p className="lares-muted">{r.detail}</p>
          <p className="lares-muted">Agent access: {r.usedBy.join(", ") || "none granted"}</p>
          <details>
            <summary>Connection details</summary>
            <p className="lares-muted">Credentials held by {r.custody}. Last use recorded here: {r.usageUnavailable ? "usage unavailable" : r.lastUsed ? ago(r.lastUsed) : "none"}.</p>
            {r.declaredFor.length > 0 && (
              <p className="lares-muted">Built-in consumers in the catalogue: {r.declaredFor.join(", ")}. This does not confirm they are running here.</p>
            )}
            {r.custody === "console" && r.accounts.map((a) => (
              <div key={a.email} className="lares-stack">
                <span>{a.email}</span>
                <span className="lares-muted">{a.scopeCount} scopes · connected {a.connectedAt}</span>
                <RemoveAccountButton email={a.email} />
              </div>
            ))}
          </details>
        </section>
      ))}
    </div>
  );
  return (
    <>
      {accountsUnavailable && <p className="lares-muted" role="status">Accounts unavailable. Stored mailboxes could not be read; configured clients and agent access are shown where known.</p>}
      {usageUnavailable && <p className="lares-muted" role="status">Usage unavailable. Recorded connection activity could not be read.</p>}
      {active.length > 0 ? cards(active) : <p className="lares-muted">No connected accounts or granted agent access recorded.</p>}
      {other.length > 0 && (
        <details className="lares-disclosure">
          <summary>Other connections in the catalogue ({other.length})</summary>
          <p className="lares-muted">These entries have no recorded use or agent access on this installation. Their status is unknown.</p>
          {cards(other)}
        </details>
      )}
      {hasConsoleCustody && <AddAccountForm />}
    </>
  );
}
