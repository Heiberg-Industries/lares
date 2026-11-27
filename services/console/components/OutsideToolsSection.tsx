"use client";
import { useRef, useState } from "react";
import type { OutsideToolDeclaration } from "@lares/agent-kit/definition";
import { Notice, RunStatus, StatusBadge, ToolList, ToolRow } from "@lares/ui/patterns";
import { connectorReach, reachTone, reachWords, type ConnectionApplication } from "../lib/outside-connector-words";
import { Button } from "@lares/ui/primitives/button";
import { acceptOutsideDescriptions } from "../app/actions/definition";
import type { DescribedTool, OutsideToolEvidence, OutsideToolLock } from "../lib/outside-tools";
import { DANGER_BADGE, keyLine } from "../lib/outside-tools-words";

/** A declaration plus its display host, worked out on the server (the address check uses node-only code). */
export type OutsideToolView = OutsideToolDeclaration & { host?: string };

const short = (hash: string) => hash.slice(0, 12);
const schemaText = (schema: unknown) => JSON.stringify(schema ?? null, null, 2);
const same = (a: DescribedTool, b: DescribedTool) =>
  a.description === b.description && schemaText(a.inputSchema) === schemaText(b.inputSchema);

function Described({ label, tool }: { label: string; tool: DescribedTool }) {
  return (
    <div>
      <p>{label}: {tool.description || "(no description)"}</p>
      <details>
        <summary>Input schema</summary>
        <pre className="mono">{schemaText(tool.inputSchema)}</pre>
      </details>
    </div>
  );
}

/** The new descriptions, next to the ones the fingerprint was taken from when those were kept. */
function DescriptionsReview({ lock }: { lock: OutsideToolLock }) {
  if (lock.seenTools === null) {
    return (
      <p className="lares-muted">
        The new descriptions are too long to show here. Read them on the server itself before accepting.
      </p>
    );
  }
  const before = lock.pinTools;
  const names = [...new Set([...(before ?? []).map((t) => t.name), ...lock.seenTools.map((t) => t.name)])].sort();
  return (
    <>
      {before === null && (
        <p className="lares-muted">The earlier descriptions were not kept, so only the new ones are shown.</p>
      )}
      <ul className="lares-data-list" aria-label="New tool descriptions">
        {names.map((name) => {
          const old = before?.find((t) => t.name === name);
          const now = lock.seenTools!.find((t) => t.name === name);
          const status = before === null ? null : !old ? "new" : !now ? "no longer offered" : same(old, now) ? "unchanged" : "changed";
          return (
            <li key={name}>
              <strong>{name}</strong>
              {status && <span className="lares-muted"> · {status}</span>}
              {old && status !== "unchanged" && <Described label="Before" tool={old} />}
              {now && <Described label="Now" tool={now} />}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function AcceptDescriptions({ agent, tool, lock }: { agent: string; tool: string; lock: OutsideToolLock }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  async function accept() {
    if (inFlight.current) return;
    inFlight.current = true;
    setState("busy");
    setError("");
    try {
      const r = await acceptOutsideDescriptions({ name: agent, tool, expectedHash: lock.seenHash });
      if (r.ok) setState("done");
      else {
        setState("idle");
        setError(r.error.outcomeMayBeUnknown
          ? `${r.error.message} Reload to check whether it was accepted before trying again.`
          : r.error.message);
      }
    } catch {
      setState("idle");
      setError("Could not confirm the change. Reload to check whether it was accepted before trying again.");
    } finally {
      inFlight.current = false;
    }
  }
  if (state === "done") {
    return <Notice tone="success">Accepted. The agent uses this tool again from its next conversation.</Notice>;
  }
  return (
    <div className="lares-stack">
      <div className="lares-actions">
        <Button type="button" variant="outline" size="sm" disabled={state === "busy"} onClick={accept}>
          Accept new tool descriptions
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

/** The agent's outside tool servers, read from its saved definition, with what the keeper and the
 *  descriptions check can add. Entries are changed in the definition, not here; the one change made
 *  here is accepting new tool descriptions after review. Hidden when the definition declares none. */
export function OutsideToolsSection({
  agent,
  tools,
  inEffect,
  evidence,
  dangerLive,
  applied,
}: {
  agent: string;
  tools: OutsideToolView[];
  /** False when the agent has no outside access grant (or it is set to never), so the entries do nothing. */
  inEffect: boolean;
  /** Absent when it was not asked for; each half can be unavailable on its own. */
  evidence?: OutsideToolEvidence;
  /** Per connection, the danger-zone tools whose fingerprint still matches the stored description. Absent: none shown as live. */
  dangerLive?: Record<string, string[]>;
  /** Per connection, whether it reached this agent (the keeper's read). Absent: not read, so no badge is shown;
   *  null: it could not be read. */
  applied?: Record<string, ConnectionApplication> | null;
}) {
  if (tools.length === 0) return null;
  const reachOf = (name: string) => connectorReach(name, [{ agent, displayName: "this agent" }], applied ? { [agent]: applied } : null);
  const locks = evidence?.locks;
  return (
    <section className="lares-surface" aria-label="Outside tools">
      <h2 className="lares-section-title">Outside tools</h2>
      <p className="lares-muted">
        Servers this agent can reach for extra tools. Read-only here; change them in the saved definition.
      </p>
      {!inEffect && (
        <p className="lares-muted">
          Switched off for now: this agent has no outside access, or it is set to never.
        </p>
      )}
      {locks && !locks.available && (
        <Notice tone="needs-you">
          Description checks unavailable. The record of what each server said about its tools could not be read.
        </Notice>
      )}
      <ul className="lares-data-list">
        {tools.map((t) => {
          const lock = locks?.available ? locks.value[t.name] : undefined;
          return (
            <li key={t.name}>
              <strong>{t.name}</strong>
              {applied !== undefined && (() => {
                const reach = reachOf(t.name);
                return <>
                  {" "}<StatusBadge tone={reachTone(reach)}>{reachWords(reach)}</StatusBadge>
                  {(reach.state === "waiting" || reach.state === "failed") && <RunStatus label={`Whether ${t.name} reached this agent`} state={reach.state} why={reach.why} />}
                </>;
              })()}
              <p className="lares-muted">{t.description}</p>
              <p>Address: <span className="mono">{t.host ?? t.url}</span></p>
              <p>
                {(t.tools.trusted ?? []).length
                  ? `Run without asking: ${(t.tools.trusted ?? []).map(g => `${g.tool} (switched on ${g.at.slice(0, 10)})`).join(", ")}. These skip the card unless the agent has just read someone else's words. Every other tool asks first, and a changed description ends this for that tool.`
                  : (dangerLive?.[t.name] ?? []).length > 0 ? "Every other call asks you first." : "Every call asks you first."}
                {(dangerLive?.[t.name] ?? []).length > 0 && ` ${(dangerLive?.[t.name] ?? []).length === 1 ? "One tool that changes something is marked in red and runs without asking" : `${(dangerLive?.[t.name] ?? []).length} tools that change something are marked in red and run without asking`}.`}
              </p>
              <p>{keyLine(t.token, evidence?.keys, t.name)}</p>
              {t.tools.allow.length > 0 ? (
                <ToolList label={`Tools ${t.name} may use`}>
                  {t.tools.allow.map(a => <ToolRow key={a} name={a} kind={t.tools.read.includes(a) ? "read" : "change"}
                    control={(dangerLive?.[t.name] ?? []).includes(a) ? <StatusBadge tone="error">{DANGER_BADGE}</StatusBadge> : undefined} />)}
                </ToolList>
              ) : <p className="lares-muted">No tools allowed.</p>}
              {lock && (
                <div role="group" aria-label={`${t.name} locked`}>
                  <p>
                    <strong>Locked: its tool descriptions changed.</strong> The agent does not use this tool
                    until you accept the new descriptions.
                  </p>
                  <p className="lares-muted">
                    Fingerprint accepted: <span className="mono">{short(lock.pinHash)}</span>. Server now sends:{" "}
                    <span className="mono">{short(lock.seenHash)}</span>, first seen{" "}
                    <time dateTime={lock.seenAt}>{lock.seenAt.replace("T", " ").slice(0, 16)} UTC</time>.
                  </p>
                  <DescriptionsReview lock={lock} />
                  <AcceptDescriptions agent={agent} tool={t.name} lock={lock} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
