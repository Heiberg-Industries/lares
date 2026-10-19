"use client";
/**
 * The Waiting on you page's list and detail: every item the agents are waiting on the owner for,
 * one selected at a time, with its whole body and the actions its kind allows.
 *
 * Kind-agnostic on purpose (`lib/waiting.ts` explains the item): nothing here knows what an
 * approval is. It renders a title, an agent, a channel, an age, a body of text, markdown or an
 * attachment, an optional note, and buttons — and says what came back when one is pressed.
 *
 * Everything an agent wrote is rendered as a plain text child, which React escapes: a body may
 * quote a hostile mail, and must not become markup or a clickable look-alike link. Markdown is
 * shown as its source text for the same reason, until a kind that needs it brings a safe renderer.
 * An attachment links only to a same-origin path.
 */
import { useState, useTransition } from "react";
import { Button } from "@lares/ui/primitives/button";
import { EmptyState, Notice, StatusBadge } from "@lares/ui/patterns";
import type { DecideResult, Unreadable, UnreadableKind, WaitingBody, WaitingItem } from "../lib/waiting";

export interface WaitingListProps {
  readonly items: readonly WaitingItem[];
  /** Agents that could not be read, with why. */
  readonly unreadable: readonly Unreadable[];
  /** Kind-specific key from a link (`?request=<id>` on a Telegram card) to open first. */
  readonly selectedRef?: string;
  readonly now: number;
  readonly onDecide: (input: { id: string; actionId: string }) => Promise<DecideResult>;
}

const REASON: Record<UnreadableKind, string> = {
  timeout: "did not answer in time",
  refused: "refused the console's request",
  unreachable: "could not be reached",
  "not-found": "returned an error",
  error: "returned an error",
};

/** Agents grouped by the owner-language reason, in a fixed order; an agent is named once. */
function unreadableGroups(unreadable: readonly Unreadable[]): { reason: string; agents: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const { agent, kind } of unreadable) {
    const list = groups.get(REASON[kind]) ?? [];
    if (!list.includes(agent)) list.push(agent);
    groups.set(REASON[kind], list);
  }
  return [...groups].map(([reason, agents]) => ({ reason, agents }));
}

const KIND_LABEL: Record<WaitingItem["kind"], string> = { approval: "Approval", proposal: "Proposal" };
const labelOf = (item: WaitingItem): string => item.kindLabel ?? KIND_LABEL[item.kind];

/** "just now", "12 minutes ago", "3 hours ago", "2 days ago". Pure; `now` is a prop. */
export function age(createdAt: string | null, now: number): string {
  const at = createdAt === null ? NaN : Date.parse(createdAt);
  if (Number.isNaN(at)) return "time unknown";
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

const preStyle = {
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  font: "inherit",
  background: "transparent",
  border: 0,
  padding: 0,
} as const;

function Body({ part }: { part: WaitingBody }) {
  const label = part.label ? (
    <p className="mono lares-muted" style={{ fontSize: 11, letterSpacing: ".04em", textTransform: "uppercase", margin: "0 0 6px" }}>
      {part.label}
    </p>
  ) : null;
  if (part.format === "attachment") {
    const safe = part.href.startsWith("/") && !part.href.startsWith("//");
    return (
      <section>
        {label}
        {safe ? <a href={part.href} download={part.name}>{part.name}</a> : <span>{part.name}</span>}{" "}
        <span className="lares-muted">({part.mediaType})</span>
      </section>
    );
  }
  return (
    <section>
      {label}
      <pre style={preStyle}>{part.format === "text" ? part.text : part.markdown}</pre>
    </section>
  );
}

interface Decided {
  readonly item: WaitingItem;
  readonly result: DecideResult;
}

export function WaitingList({ items, unreadable, selectedRef, now, onDecide }: WaitingListProps) {
  // A decided item drops out of the server's list on the next render; it stays here, with what came
  // back, until the page is reloaded — so the owner sees the result instead of a vanishing row.
  const [decided, setDecided] = useState<Record<string, Decided>>({});
  const [failure, setFailure] = useState<Record<string, DecideResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();
  const shown: WaitingItem[] = [...items.filter((i) => !(i.id in decided)), ...Object.values(decided).map((d) => d.item)];
  const initial = shown.find((i) => i.ref === selectedRef)?.id ?? shown[0]?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(initial);
  const selected = shown.find((i) => i.id === selectedId) ?? shown[0];

  function act(item: WaitingItem, actionId: string) {
    if (busy !== null) return;
    setBusy(item.id);
    start(async () => {
      let result: DecideResult;
      try {
        result = await onDecide({ id: item.id, actionId });
      } catch {
        result = { ok: false, reason: "unavailable", message: "The console could not send your answer. Reload the page and try again." };
      }
      // Done when it succeeded, was already decided, has gone, or was accepted and then failed:
      // there is nothing left to press. Otherwise the buttons stay, with the reason beside them.
      if (result.ok || result.reason === "decided-elsewhere" || result.reason === "gone" || result.reason === "action-failed") {
        setDecided((d) => ({ ...d, [item.id]: { item, result } }));
      } else {
        setFailure((f) => ({ ...f, [item.id]: result }));
      }
      setBusy(null);
    });
  }

  return (
    <div className="lares-stack">
      {unreadableGroups(unreadable).map((group) => (
        <Notice error key={group.reason}>
          Could not read what {group.agents.join(", ")} {group.agents.length === 1 ? "is" : "are"} waiting on: {group.agents.length === 1 ? "it" : "they"}{" "}
          {group.reason}. This list may be incomplete.
        </Notice>
      ))}
      {shown.length === 0 ? (
        <EmptyState title="Nothing is waiting on you">
          When an agent asks for your approval, or Notion or the shared notes propose a change, it shows up here.
        </EmptyState>
      ) : (
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", alignItems: "start" }}>
          <section className="lares-surface" aria-label="Waiting items">
            <ul className="lares-data-list" style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {shown.map((item) => {
                const done = decided[item.id];
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(item.id)}
                      aria-current={item.id === selected?.id ? "true" : undefined}
                      style={{ all: "unset", cursor: "pointer", display: "block", width: "100%", fontWeight: item.id === selected?.id ? 600 : 400 }}
                    >
                      <span style={{ display: "block", wordBreak: "break-word" }}>{item.title}</span>
                      <span className="lares-muted" style={{ fontSize: 13 }}>
                        {labelOf(item)} · {item.agent} · {item.channel} · {age(item.createdAt, now)}
                      </span>{" "}
                      {done ? <StatusBadge tone={done.result.ok ? "success" : "quiet"}>Decided</StatusBadge> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
          {selected ? (
            <article className="lares-surface lares-stack" aria-label="Selected item">
              <header>
                <p className="mono lares-muted" style={{ fontSize: 11, letterSpacing: ".04em", textTransform: "uppercase", margin: "0 0 6px" }}>
                  {labelOf(selected)} · {selected.agent} · {selected.channel} · {age(selected.createdAt, now)}
                </p>
                <h2 className="lares-section-title" style={{ wordBreak: "break-word" }}>{selected.title}</h2>
              </header>
              {selected.body.map((part, i) => (
                <Body key={i} part={part} />
              ))}
              {decided[selected.id] ? (
                <p
                  role="status"
                  className={
                    decided[selected.id]!.result.ok
                      ? "lares-form-success"
                      : (decided[selected.id]!.result as { reason?: string }).reason === "action-failed"
                        ? "lares-form-error"
                        : "lares-muted"
                  }
                >
                  {decided[selected.id]!.result.message}
                </p>
              ) : (
                <>
                  {selected.note ? <p className="lares-muted">{selected.note}</p> : null}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    {selected.actions.map((action) => (
                      <Button
                        key={action.id}
                        type="button"
                        variant={action.tone === "primary" ? "default" : "outline"}
                        disabled={busy !== null}
                        onClick={() => act(selected, action.id)}
                      >
                        {action.label}
                      </Button>
                    ))}
                    {busy === selected.id ? <span className="lares-muted">Sending your answer…</span> : null}
                  </div>
                  {failure[selected.id] ? (
                    <p role="alert" className="lares-form-error">{failure[selected.id]!.message}</p>
                  ) : null}
                </>
              )}
            </article>
          ) : null}
        </div>
      )}
    </div>
  );
}
