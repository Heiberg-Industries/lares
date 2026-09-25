"use client";

import { useEffect, useState } from "react";
import { useEveAgent } from "eve/react";
import type { ClientSessionState } from "eve/client";
import { ChatTranscript, composerState, expiredRequestIds } from "./ChatTranscript";
import { chatSessionKey, readChatSession, saveChatSession } from "../lib/chat-session";

function tabStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * W8B-s3 — the thin client half. All state and transport is eve's own `useEveAgent`; this
 * component only turns the hook's snapshot into the plain-style form the rest of the console uses,
 * and turns a submit into a `send`.
 *
 * `host` is a same-origin prefix, never an absolute address — `/api/chat/<name>` is the route
 * `services/console/app/api/chat/[name]/[...path]/route.ts` answers (W8B-s2's `forwardChat`), so
 * this component never sees, holds, or sends the agent's own route password; the browser's only
 * credential is the console's own session cookie, exactly as every other page here.
 *
 * `prewarm` is left at its default (`false`, per owner decision B2): no session exists until the
 * first message is sent, so opening this page creates nothing.
 *
 * W8B-s5 — answering an approval. `agent.respond([{ requestId, optionId }])` is eve's own call and
 * the only one that answers a card; the `requestId` comes from the card's own input request, NOT
 * from the tool call id (W8B-s4 measured the difference on the wire). Three rules live here rather
 * than in the transcript, because they are about time and the transcript is pure:
 *
 *  - ONE answer per click. `answering` holds the request id while the POST is in flight; every
 *    button in the transcript is disabled while it is set, so a double click is one answer.
 *  - ONE request at a time. `respond` takes an array, and eve's own contract is that it rejects
 *    while a turn is in flight; sending a single element keeps the answer, the card and any
 *    refusal in one-to-one correspondence.
 *  - A card older than 24 hours shows its age instead of a button, because the agent would refuse
 *    it anyway (`StaleApprovalError`) and a button that cannot work is worse than a sentence.
 *    `Date.now()` is read HERE, at render, and handed down as a set.
 */
export function Chat({ name, owner }: { name: string; owner: string }) {
  const storageKey = chatSessionKey(owner, name);
  const [binding, setBinding] = useState<{ key: string; session: ClientSessionState | null } | null>(null);

  // The server and first browser render agree. Read tab storage only after hydration; a changed
  // agent or owner gets a new binding before its Eve hook can mount under the wrong host.
  useEffect(() => {
    const storage = tabStorage();
    setBinding({ key: storageKey, session: storage ? readChatSession(storage, storageKey) : null });
  }, [storageKey]);

  if (binding?.key !== storageKey) return <p role="status">Opening chat…</p>;
  return <ChatSession key={storageKey} name={name} storageKey={storageKey} initialSession={binding.session} />;
}

function ChatSession({ name, storageKey, initialSession }: {
  name: string;
  storageKey: string;
  initialSession: ClientSessionState | null;
}) {
  const agent = useEveAgent({
    host: `/api/chat/${name}`,
    initialSession: initialSession ?? undefined,
    resume: initialSession !== null,
    onSessionChange(session) {
      const storage = tabStorage();
      if (storage) saveChatSession(storage, storageKey, session);
    },
  });
  const [text, setText] = useState("");
  const [answering, setAnswering] = useState<string | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const composer = composerState(agent.status);
  const expired = expiredRequestIds(agent.events, Date.now());

  const answer = (requestId: string, optionId: string) => {
    // The guard is belt to the transcript's braces: its buttons are already disabled while an
    // answer is in flight, and this makes a stray call from anywhere else a no-op too.
    if (answering !== null) return;
    setAnswering(requestId);
    setAnswerError(null);
    void agent
      .respond([{ requestId, optionId }])
      .catch((error: unknown) => {
        // In our own words. eve's refusal can name a session id and a turn; what the owner needs
        // to know is that nothing happened and the card is still there.
        setAnswerError(
          `Your answer did not reach the agent, so nothing has been done: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => setAnswering(null));
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h1 className="mono" style={{ fontSize: 18 }}>Chat — {name}</h1>
        <button
          type="button"
          onClick={() => {
            setText("");
            setAnswerError(null);
            // `reset()` detaches the session and clears the projected messages, so a card that
            // belonged to the session just left cannot be answered from here: it is no longer
            // rendered at all.
            agent.reset();
          }}
          className="mono"
          style={{ padding: "4px 12px", border: "1px solid var(--rule)", borderRadius: 4, background: "var(--card)", color: "var(--ink)", fontSize: 13, cursor: "pointer" }}
        >
          New chat
        </button>
      </div>

      <div className="card" style={{ padding: 16, minHeight: 240, marginBottom: 12 }}>
        <ChatTranscript
          status={agent.status}
          messages={agent.data.messages}
          error={agent.error?.message ?? null}
          expired={expired}
          answering={answering}
          onAnswer={answer}
        />
      </div>

      {answerError ? (
        <p role="alert" className="mono" style={{ fontSize: 12, color: "var(--bad)", marginBottom: 8 }}>
          {answerError}
        </p>
      ) : null}

      {composer.say ? (
        <p className="mono" style={{ fontSize: 12, color: "var(--mist)", marginBottom: 8 }}>
          {composer.say}
        </p>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const value = text.trim();
          if (value.length === 0 || composer.disabled) return;
          setText("");
          void agent.send(value, isBusy ? { turnPolicy: "steer" } : undefined);
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          disabled={composer.disabled}
          placeholder="Say something…"
          className="mono"
          style={{ flex: 1, padding: "8px 10px", border: "1px solid var(--rule)", borderRadius: 4, background: "var(--card)", color: "var(--ink)", fontSize: 13 }}
        />
        <button
          type="submit"
          disabled={composer.disabled}
          className="mono"
          style={{ padding: "8px 16px", border: "1px solid var(--rule)", borderRadius: 4, background: "var(--signal)", color: "#fff", fontSize: 13, cursor: composer.disabled ? "not-allowed" : "pointer" }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
