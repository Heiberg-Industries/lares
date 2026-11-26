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
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import { Row, Rows } from "@lares/ui/patterns";
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

  const when = (m: InboxMessage) => <time dateTime={m.createdAt}>{m.createdAt.replace("T", " ").slice(0, 16)} UTC</time>;
  const reply = (m: InboxMessage) => (
    <Button variant="ghost" size="sm" asChild><Link href={`/chat/${encodeURIComponent(agent)}?reply=${m.id}`}>Reply</Link></Button>
  );

  return (
    <Card role="region" aria-label="Messages waiting in web chat">
      {messages.length > 0 && (
        <>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              {messages.length === 1 ? "1 message for you" : `${messages.length} messages for you`}
            </CardTitle>
            {messages.length > 1 && (
              <CardAction>
                <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => read()}>Mark all as read</Button>
              </CardAction>
            )}
          </CardHeader>
          <Rows>
            {messages.map((m) => (
              <Row
                key={m.id}
                title={m.title}
                description={when(m)}
                control={<>
                  {reply(m)}
                  <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => read(m.id)}>Mark as read</Button>
                </>}
              >
                <p className="lares-pre">{m.body}</p>
              </Row>
            ))}
          </Rows>
        </>
      )}
      {earlier.length > 0 && (
        <CardContent>
          <details>
            <summary>Earlier messages ({earlier.length})</summary>
            <Rows>
              {earlier.map((m) => (
                <Row key={m.id} title={m.title} description={when(m)} control={reply(m)}>
                  <p className="lares-pre">{m.body}</p>
                </Row>
              ))}
            </Rows>
          </details>
        </CardContent>
      )}
    </Card>
  );
}
