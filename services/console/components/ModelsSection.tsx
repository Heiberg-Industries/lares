import Link from "next/link";
import { Notice, StatusBadge } from "@lares/ui/patterns";
import type { GatewayStatus } from "@lares/agent-kit/gateway-status";
import type { GatewayStatusView } from "../lib/gateway-status";

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const PURPOSE = { brain: "Brain", writer: "Writer", utility: "Utility", gate: "Gate", embed: "Embed" } as const;
const PURPOSE_STATE = {
  served: "Served", "served-target-hidden": "Served, model not shown by the gateway",
  "not-served": "Not served by this gateway", unknown: "Unknown",
} as const;

function reachability(s: GatewayStatus): { tone: "success" | "attention" | "error" | "quiet"; text: string } {
  switch (s.reachability) {
    case "reachable": return { tone: "success", text: `Reachable at ${when(s.checkedAt)}.` };
    case "not-ready": return { tone: "attention", text: `Running but not ready (its key database is not connected). Checked ${when(s.checkedAt)}.` };
    case "readiness-unreadable": return { tone: "attention", text: `Running, but its readiness answer could not be read. Checked ${when(s.checkedAt)}.` };
    case "unreachable": return { tone: "error", text: `Not reachable at ${when(s.checkedAt)}.` };
    case "not-configured": return { tone: "quiet", text: "No gateway configured." };
  }
}
const DETAILS: Record<Exclude<GatewayStatus["details"]["state"], "ok">, string> = {
  refused: "Details refused by the gateway.",
  invalid: "Details unreadable.",
  unavailable: "Details unavailable: the gateway did not answer.",
  "key-unreadable": "Details unavailable: Lares could not read its gateway key.",
  "not-managed": "Managed outside Lares. Model details are not checked.",
  "aliases-unknown": "Details unavailable: Lares could not read its own alias settings.",
};
const WHOLE = {
  "keeper-unavailable": "Gateway status unavailable: Lares's server helper did not answer.",
  refused: "Gateway status unavailable: the server helper refused the request.",
  invalid: "Gateway status could not be read: the answer was not in the expected form.",
  "sign-in-required": "Sign in to see the model gateway.",
} as const;

/** Read-only. Rendering makes one status read; "Check again" is a plain reload link. Nothing here
 * calls a model or changes anything. */
export function ModelsSection({ view }: { view: GatewayStatusView }) {
  return (
    <section className="lares-surface">
      <h2 className="lares-section-title">Models</h2>
      <p className="lares-muted">Where Lares sends its model requests, and whether the gateway is answering. This page changes nothing.</p>
      {view.kind !== "status" ? <Notice error>{WHOLE[view.kind]}</Notice> : <Body status={view.status} usage={view.usage} />}
      <p className="lares-muted">Provider not tested: testing sends a paid request.</p>
      <Link href="/settings">Check again</Link>
    </section>
  );
}

function Body({ status, usage }: { status: GatewayStatus; usage: Record<string, string[]> | null }) {
  const r = reachability(status);
  return (
    <>
      <div className="lares-setting-row">
        <div>
          Gateway address
          <p>{status.mode === "managed" ? "Run by Lares on this server." : status.mode === "external" ? "Run elsewhere; managed outside Lares." : "Not set."}</p>
        </div>
        <span className="mono">{status.endpoint ?? "None"}</span>
      </div>
      <div className="lares-setting-row">
        <div>Is it answering?<p>{r.text}</p></div>
        <StatusBadge tone={status.reachability === "readiness-unreadable" ? "quiet" : r.tone}>{status.reachability === "reachable" ? "Reachable" : status.reachability === "unreachable" ? "Not reachable" : status.reachability === "not-configured" ? "Not configured" : status.reachability === "readiness-unreadable" ? "Readiness unclear" : "Not ready"}</StatusBadge>
      </div>
      {status.details.state !== "ok" && <Notice error={status.details.state === "refused" || status.details.state === "invalid"}>{DETAILS[status.details.state]}</Notice>}
      {status.purposes.map(p => (
        <div className="lares-setting-row" key={p.purpose}>
          <div>
            {PURPOSE[p.purpose]} <span className="mono">{p.alias}</span>
            <p>
              {PURPOSE_STATE[p.state]}{p.target ? `: ${p.target.provider} · ${p.target.model}` : ""}
              {" "}
              {usage === null ? "Agents using it: unavailable."
                : usage[p.alias]?.length ? `Agents using it: ${usage[p.alias]!.join(", ")}.` : "No agent uses it."}
            </p>
          </div>
        </div>
      ))}
      {status.details.state === "ok" && status.details.others.length > 0 && (
        <p className="lares-muted">Other models on this gateway: <span className="mono">{status.details.others.join(", ")}</span>{status.details.othersTotal > status.details.others.length ? ` and ${status.details.othersTotal - status.details.others.length} more` : ""}</p>
      )}
    </>
  );
}
