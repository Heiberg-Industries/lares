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
  return (
    <>
      <div className="lares-connections">
        {rows.map((r) => (
          <section
            className="lares-surface"
            key={`${r.connectionId}:${r.instanceId}`}
          >
            <h2 className="lares-section-title">{r.label}</h2>
            <StatePill state={r.status} />
            <p className="lares-muted">{r.detail}</p>
            <p className="lares-muted">
              Used by {r.usedBy.join(", ") || "no agents yet"}
            </p>
            <details>
              <summary>Connection details</summary>
              <p className="lares-muted">
                Credentials held by {r.custody}. Last used:{" "}
                {r.lastUsed ? ago(r.lastUsed) : "not recorded"}.
              </p>
              {r.custody === "console" &&
                r.accounts.map((a) => (
                  <div key={a.email} className="lares-stack">
                    <span>{a.email}</span>
                    <span className="lares-muted">
                      {a.scopeCount} scopes · connected {a.connectedAt}
                    </span>
                    <RemoveAccountButton email={a.email} />
                  </div>
                ))}
            </details>
          </section>
        ))}
      </div>
      {hasConsoleCustody && <AddAccountForm />}
    </>
  );
}
