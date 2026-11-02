"use client";
/**
 * Messages an agent left for the owner in web chat, shown above the chat. Unread ones are listed
 * with a "Reply" (opens a chat starting from the message) and "Mark as read".
 *
 * Nothing is pushed: web chat cannot be written into by an agent. The list is read on page open
 * (server-rendered, passed in as `initial`) and re-read every half minute while the page is visible,
 * and straight away when the tab becomes visible again.
 */
import { Button } from "@lares/ui/primitives/button";
import Link from "next/link";
import { useCallback, useEffect, useState, useTransition } from "react";
import { markRead } from "../app/actions/inbox";
import type { InboxMessage } from "../lib/web-inbox";

export const INBOX_POLL_MS = 30_000;

export function InboxPanel({ agent, initial, earlier = [] }: { agent: string; initial: InboxMessage[]; earlier?: InboxMessage[] }) {
  const [messages, setMessages] = useState(initial);
  const [pending, start] = useTransition();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/inbox?agent=${encodeURIComponent(agent)}`, { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { messages?: InboxMessage[] };
      if (Array.isArray(body.messages)) setMessages(body.messages);
    } catch {
      /* offline or signed out: keep what is shown */
    }
  }, [agent]);

  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(tick, INBOX_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [refresh]);

  if (messages.length === 0 && earlier.length === 0) return null;

  const read = (id?: number) => start(async () => {
    await markRead({ agent, ...(id === undefined ? {} : { id }) });
    await refresh();
  });

  return (
    <section aria-label="Messages waiting in web chat" className="lares-surface">
      {messages.length > 0 && (
        <>
          <h2 className="lares-section-title">
            {messages.length === 1 ? "1 message for you" : `${messages.length} messages for you`}
          </h2>
          <ul className="lares-data-list">
            {messages.map((m) => (
              <li key={m.id}>
                <strong>{m.title}</strong>{" "}
                <time className="lares-muted" dateTime={m.createdAt}>{m.createdAt.replace("T", " ").slice(0, 16)} UTC</time>
                <p className="lares-pre lares-row-actions">{m.body}</p>
                <Link href={`/chat/${encodeURIComponent(agent)}?reply=${m.id}`}>Reply</Link>{" · "}
                <Button type="button" variant="outline" disabled={pending} onClick={() => read(m.id)}>Mark as read</Button>
              </li>
            ))}
          </ul>
          {messages.length > 1 && (
            <Button type="button" variant="outline" disabled={pending} onClick={() => read()}>Mark all as read</Button>
          )}
        </>
      )}
      {earlier.length > 0 && (
        <details className="lares-inset-disclosure">
          <summary>Earlier messages ({earlier.length})</summary>
          <ul className="lares-data-list">
            {earlier.map((m) => (
              <li key={m.id}>
                <strong>{m.title}</strong>{" "}
                <time className="lares-muted" dateTime={m.createdAt}>{m.createdAt.replace("T", " ").slice(0, 16)} UTC</time>
                <p className="lares-pre lares-row-actions">{m.body}</p>
                <Link href={`/chat/${encodeURIComponent(agent)}?reply=${m.id}`}>Reply</Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
