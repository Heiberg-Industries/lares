import Link from "next/link";
import type { DeclaredOutside, OutsideToolEvidence } from "../lib/outside-tools";
import { keyLine } from "../lib/outside-tools-words";

/** Read only: which agents use outside tool servers, and what the key and descriptions checks know.
 *  `declared` null means the definitions could not be read. Changes happen on each agent's own page. */
export function OutsideToolsOverview({ declared, evidence }: { declared: DeclaredOutside[] | null; evidence: Record<string, OutsideToolEvidence> }) {
  if (declared === null) return <p className="lares-muted" role="status">Outside tools could not be read. Reload the page to try again.</p>;
  if (declared.length === 0) return <p className="lares-muted">No agent uses outside tools yet. Open an agent and choose Outside tools to add some.</p>;
  return (
    <ul className="lares-data-list">
      {declared.map((a) => {
        const ev = evidence[a.agent];
        return (
          <li key={a.agent} className="lares-stack">
            <strong>{a.displayName}</strong>
            {a.servers.map((s) => {
              const locked = ev?.locks.available && ev.locks.value[s.name] !== undefined;
              return (
                <div key={s.name}>
                  <p><span className="mono">{s.name}</span>{s.tools.length > 0 && <span className="lares-muted"> · {s.tools.join(", ")}</span>}</p>
                  <p className="lares-muted">{keyLine(s.needsKey, ev?.keys, s.name)}</p>
                  {locked && <p><strong>Locked: its tool descriptions changed.</strong> Check them on the agent&apos;s page before it runs again.</p>}
                </div>
              );
            })}
            {ev && !ev.locks.available && <p className="lares-muted" role="status">Description checks unavailable. The record of what each server said about its tools could not be read.</p>}
            <Link href={`/agents/${encodeURIComponent(a.agent)}/outside-tools`}>Change on the agent&apos;s page →</Link>
          </li>
        );
      })}
    </ul>
  );
}
