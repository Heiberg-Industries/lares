import type { AgentDetailDTO } from "../lib/contracts";
import { AutonomyControl } from "./AutonomyControl";

/** What a row without a switch says. The approval check only reaches write-with-confirm tools; a
 *  plain write acts without asking and a read is allowed while granted. Shared with the
 *  Integrations page so the two pages say the same thing. */
export function NoControl({ scope }: { scope: string }) {
  return (
    <span className="lares-status-muted">
      {scope === "write" ? "acts without asking — its definition grants a plain write" : "reads — allowed while granted"}
    </span>
  );
}

export function PermissionsBoard({ detail }: { detail: AgentDetailDTO }) {
  return (
    <div className="lares-connections">
      {detail.capabilities.map((c) => (
        <div key={c.name} className="lares-surface lares-surface-compact">
          <div className="lares-section-heading">
            <span className="mono">
              {c.name}
            </span>
            {c.scope === "write-with-confirm"
              ? <AutonomyControl agent={detail.name} capability={c.name} level={c.defaultLevel} />
              : <NoControl scope={c.scope} />}
          </div>
          <div className="mono lares-small lares-status-muted">
            {c.scope}
          </div>
        </div>
      ))}
    </div>
  );
}
