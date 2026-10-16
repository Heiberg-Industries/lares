"use client";
import { useRef, useState } from "react";
import type { OutsideToolDeclaration } from "@lares/agent-kit/definition";
import { Button } from "@lares/ui/primitives/button";
import { acceptOutsideDescriptions } from "../app/actions/definition";
import type { DescribedTool, OutsideToolEvidence, OutsideToolLock } from "../lib/outside-tools";

/** A declaration plus its display host, worked out on the server (the address check uses node-only code). */
export type OutsideToolView = OutsideToolDeclaration & { host?: string };

const short = (hash: string) => hash.slice(0, 12);
const schemaText = (schema: unknown) => JSON.stringify(schema ?? null, null, 2);
const same = (a: DescribedTool, b: DescribedTool) =>
  a.description === b.description && schemaText(a.inputSchema) === schemaText(b.inputSchema);

function keyLine(needsKey: boolean, keys: OutsideToolEvidence["keys"] | undefined, tool: string): string {
  if (!needsKey) return "Needs a key: no";
  if (!keys) return "Needs a key: yes";
  if (!keys.available) return "Needs a key: yes. Key status unavailable: the keeper could not be asked.";
  const present = keys.value[tool];
  if (present === true) return "Needs a key: yes. Key file in place.";
  if (present === false) return "Needs a key: yes. Key file missing: the agent cannot use this tool until the key is placed on the server.";
  return "Needs a key: yes. Key status unavailable: the keeper could not check the key file.";
}

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
    return <p role="status">Accepted. The agent uses this tool again from its next conversation.</p>;
  }
  return (
    <div className="lares-actions">
      <Button type="button" variant="outline" size="sm" disabled={state === "busy"} onClick={accept}>
        Accept new tool descriptions
      </Button>
      {error && <p role="alert">{error}</p>}
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
}: {
  agent: string;
  tools: OutsideToolView[];
  /** False when the agent has no outside access grant (or it is set to never), so the entries do nothing. */
  inEffect: boolean;
  /** Absent when it was not asked for; each half can be unavailable on its own. */
  evidence?: OutsideToolEvidence;
}) {
  if (tools.length === 0) return null;
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
        <p className="lares-muted" role="status">
          Description checks unavailable. The record of what each server said about its tools could not be read.
        </p>
      )}
      <ul className="lares-data-list">
        {tools.map((t) => {
          const lookups = t.tools.allow.filter((a) => t.tools.read.includes(a));
          const others = t.tools.allow.filter((a) => !t.tools.read.includes(a));
          const lock = locks?.available ? locks.value[t.name] : undefined;
          return (
            <li key={t.name}>
              <strong>{t.name}</strong>
              <p className="lares-muted">{t.description}</p>
              <p>Address: <span className="mono">{t.host ?? t.url}</span></p>
              <p>
                {t.trusted
                  ? "Trusted: lookups run without asking unless the agent has just read someone else's words. Changes always ask."
                  : "Not trusted: every call asks you first."}
              </p>
              <p>{keyLine(t.token, evidence?.keys, t.name)}</p>
              <p>
                Lookups it may use: {lookups.length ? lookups.join(", ") : "none"}
              </p>
              <p>
                Other tools it may use (these change things): {others.length ? others.join(", ") : "none"}
              </p>
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
