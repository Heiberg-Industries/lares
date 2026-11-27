"use client";
/**
 * The Reviews page's list and detail: every item the agents are waiting on the owner for,
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
import { useKeepFresh } from "../lib/use-keep-fresh";
import { Badge } from "@lares/ui/primitives/badge";
import { Button } from "@lares/ui/primitives/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import { Col, EmptyState, Notice, Row, Rows, RunStatus } from "@lares/ui/patterns";
import type { DecideResult, Unreadable, UnreadableKind, WaitingBody, WaitingItem } from "../lib/waiting";

export interface WaitingListProps {
  readonly items: readonly WaitingItem[];
  /** Agents that could not be read, with why. */
  readonly unreadable: readonly Unreadable[];
  /** Kind-specific key from a link (`?request=<id>` on a Telegram card) to open first. */
  readonly selectedRef?: string;
  readonly now: number;
  readonly onDecide: (input: { id: string; actionId: string }) => Promise<DecideResult>;
  /** Reads again what came of an answer that came back `unconfirmed`. Without it the page does not follow up. */
  readonly onCheck?: (input: { id: string }) => Promise<DecideResult>;
  /** Said instead of the usual words when nothing is listed. For a person who is not the owner. */
  readonly emptyNote?: string;
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

function Body({ part }: { part: WaitingBody }) {
  const label = part.label ? <p className="lares-eyebrow">{part.label}</p> : null;
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
      <pre className="lares-pre">{part.format === "text" ? part.text : part.markdown}</pre>
    </section>
  );
}

interface Decided {
  readonly item: WaitingItem;
  readonly result: DecideResult;
  /** When the answer was sent, on this browser's clock: the follow-up stops after `CONFIRM_FOLLOW_MS`. */
  readonly at: number;
}

/** How long the page keeps checking an answer the agent has not confirmed. */
export const CONFIRM_FOLLOW_MS = 10 * 60_000;

/** Still to be confirmed, and still worth asking about. */
export function following(d: Decided | undefined, now: number): boolean {
  return Boolean(d && d.result.ok && d.result.unconfirmed && now - d.at < CONFIRM_FOLLOW_MS);
}

export function WaitingList({ items, unreadable, selectedRef, now, onDecide, onCheck, emptyNote }: WaitingListProps) {
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

  // An answer the agent has not confirmed yet is asked about again every few seconds, until it is
  // confirmed, the action failed, or ten minutes have passed (ADR 0031). Sends nothing.
  const open = Object.values(decided).filter((d) => following(d, Date.now()));
  useKeepFresh(Boolean(onCheck) && open.length > 0, async () => {
    if (!onCheck) return;
    for (const d of open) {
      let result: DecideResult;
      try { result = await onCheck({ id: d.item.id }); } catch { continue; }
      setDecided((all) => (all[d.item.id] ? { ...all, [d.item.id]: { ...all[d.item.id]!, result } } : all));
    }
  });

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
        setDecided((d) => ({ ...d, [item.id]: { item, result, at: Date.now() } }));
      } else {
        setFailure((f) => ({ ...f, [item.id]: result }));
      }
      setBusy(null);
    });
  }

  const meta = (item: WaitingItem) => `${labelOf(item)} · ${item.agent} · ${item.channel} · ${age(item.createdAt, now)}`;
  const outcome = selected ? decided[selected.id]?.result : undefined;
  const followed = selected ? decided[selected.id] : undefined;

  return (
    <>
      {unreadableGroups(unreadable).map((group) => (
        <Notice error key={group.reason}>
          Could not read what {group.agents.join(", ")} {group.agents.length === 1 ? "is" : "are"} waiting on: {group.agents.length === 1 ? "it" : "they"}{" "}
          {group.reason}. This list may be incomplete. Reload this page to try again.
        </Notice>
      ))}
      {shown.length === 0 ? (
        <EmptyState title="Nothing is waiting on you">
          {emptyNote ?? "When an agent asks for your approval, or Notion or the shared notes propose a change, it shows up here."}
        </EmptyState>
      ) : (
        <>
          <Col span={4}>
            <section aria-label="Waiting items">
              <Card>
                <Rows>
                  {shown.map((item) => {
                    const done = decided[item.id];
                    return (
                      <Row
                        key={item.id}
                        title={item.title}
                        description={meta(item)}
                        control={
                          <>
                            {done ? <Badge variant={done.result.ok ? "success" : "neutral"}>Decided</Badge> : null}
                            {item.id === selected?.id ? (
                              <Badge variant="accent" aria-current="true">Showing</Badge>
                            ) : (
                              <Button type="button" variant="outline" size="sm" onClick={() => setSelectedId(item.id)} aria-label={`Show ${item.title}`}>
                                Show
                              </Button>
                            )}
                          </>
                        }
                      />
                    );
                  })}
                </Rows>
              </Card>
            </section>
          </Col>
          {selected ? (
            <Col span={8}>
              <article aria-label="Selected item">
                <Card>
                  <CardHeader>
                    <CardTitle role="heading" aria-level={2}>{selected.title}</CardTitle>
                    <CardDescription>{meta(selected)}</CardDescription>
                  </CardHeader>
                  <CardContent className="lares-stack">
                    {selected.body.map((part, i) => (
                      <Body key={i} part={part} />
                    ))}
                    {outcome && outcome.ok && outcome.unconfirmed ? (
                      // Approved and being carried out reads as running; an answer not yet taken up, as waiting.
                      following(followed, Date.now()) && onCheck
                        ? <RunStatus label="Your answer" state={outcome.outcome === "approved" ? "running" : "waiting"} why={outcome.message} />
                        : <RunStatus label="Your answer" state={outcome.outcome === "approved" ? "running" : "waiting"} why={`${outcome.message} It has not confirmed it after ten minutes; its reply, when it comes, appears in the conversation this came from.`} />
                    ) : outcome ? (
                      <Notice tone={outcome.ok ? "success" : outcome.reason === "action-failed" ? "error" : "info"}>{outcome.message}</Notice>
                    ) : (
                      <>
                        {selected.note ? <p className="lares-muted">{selected.note}</p> : null}
                        <div className="lares-actions">
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
                        </div>
                        {busy === selected.id ? <Notice tone="working">Sending your answer…</Notice> : null}
                        {failure[selected.id] ? <Notice error>{failure[selected.id]!.message}</Notice> : null}
                      </>
                    )}
                  </CardContent>
                </Card>
              </article>
            </Col>
          ) : null}
        </>
      )}
    </>
  );
}
