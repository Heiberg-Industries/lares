import { Fragment } from "react";
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
      <table className="card" style={{ marginTop: 8 }}>
        <thead>
          <tr><th>Connection</th><th>Custody</th><th>Status</th><th>Last used</th><th>Used by</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={`${r.connectionId}:${r.instanceId}`}>
              <tr>
                <td className="mono">{r.label}</td>
                <td style={{ color: "var(--mist)" }}>{r.custody}</td>
                <td>
                  <StatePill state={r.status} />{" "}
                  <span style={{ color: "var(--mist)" }}>{r.detail}</span>
                </td>
                <td style={{ color: "var(--mist)" }}>{r.lastUsed ? ago(r.lastUsed) : "—"}</td>
                <td style={{ color: "var(--mist)" }}>{r.usedBy.join(", ") || "—"}</td>
              </tr>
              {r.custody === "console" && r.accounts.length > 0 && (
                <tr>
                  <td colSpan={5} style={{ paddingLeft: 24 }}>
                    {r.accounts.map((a) => (
                      <div key={a.email} className="mono" style={{ fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}>
                        <span>{a.email}</span>
                        <span style={{ color: "var(--mist)" }}>· {a.scopeCount} scopes · connected {a.connectedAt}</span>
                        <RemoveAccountButton email={a.email} />
                      </div>
                    ))}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {hasConsoleCustody && <AddAccountForm />}
    </>
  );
}
