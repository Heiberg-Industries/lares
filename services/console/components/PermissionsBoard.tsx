import type { AgentDetailDTO } from "../lib/contracts";
import { AutonomyControl } from "./AutonomyControl";

/** What a row without a switch says. The approval check only reaches write-with-confirm tools; a
 *  plain write acts without asking and a read is allowed while granted. Shared with the
 *  Integrations page so the two pages say the same thing. */
export function NoControl({ scope }: { scope: string }) {
  return (
    <span style={{ color: "var(--mist)" }}>
      {scope === "write" ? "acts without asking — its definition grants a plain write" : "reads — allowed while granted"}
    </span>
  );
}

export function PermissionsBoard({ detail }: { detail: AgentDetailDTO }) {
  return (
    <div style={{ display: "flex", gap: 24 }}>
      {detail.capabilities.map((c) => (
        <div key={c.name} className="card" style={{ flex: 1, padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="mono" style={{ fontWeight: 600 }}>
              {c.name}
            </span>
            {c.scope === "write-with-confirm"
              ? <AutonomyControl agent={detail.name} capability={c.name} level={c.defaultLevel} />
              : <NoControl scope={c.scope} />}
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--mist)", margin: "4px 0 12px" }}>
            {c.scope}
          </div>
        </div>
      ))}
    </div>
  );
}
