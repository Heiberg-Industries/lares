"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AgentAvatar, PageHeader } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import * as Menu from "@lares/ui/primitives/dropdown-menu";
type ChatIdentity = {
  avatarVersion?: string;
  name: string;
  displayName: string;
  role: string;
};

import {readPersonalSendCard} from '../app/actions/accounts';
import type {PersonalSendCard} from '../lib/approval-text';
import { useEveAgent } from "eve/react";
import type { ClientSessionState } from "eve/client";
import {
  ChatTranscript,
  composerState,
  expiredRequestIds,
} from "./ChatTranscript";
import {
  chatSessionKey,
  readChatSession,
  saveChatSession,
} from "../lib/chat-session";

function tabStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The thin client half. All state and transport is eve's own `useEveAgent`; this
 * component only turns the hook's snapshot into the plain-style form the rest of the console uses,
 * and turns a submit into a `send`.
 *
 * `host` is a same-origin prefix, never an absolute address — `/api/chat/<name>` is the route
 * `services/console/app/api/chat/[name]/[...path]/route.ts` answers (`forwardChat`), so
 * this component never sees, holds, or sends the agent's own route password; the browser's only
 * credential is the console's own session cookie, exactly as every other page here.
 *
 * `prewarm` is left at its default (`false`): no session exists until the
 * first message is sent, so opening this page creates nothing.
 *
 * Answering an approval. `agent.respond([{ requestId, optionId }])` is eve's own call and
 * the only one that answers a card; the `requestId` comes from the card's own input request, NOT
 * from the tool call id (the two differ on the wire). Three rules live here rather
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
export function Chat({ name, memberId, agents = [] }: {
  name: string;
  memberId: string;
  agents?: ChatIdentity[];
}) {
  const storageKey = chatSessionKey(memberId, name);
  const [binding, setBinding] = useState<{
    key: string;
    session: ClientSessionState | null;
    generation: number;
  } | null>(null);
  useEffect(() => {
    const storage = tabStorage();
    setBinding({ key: storageKey, session: storage ? readChatSession(storage, storageKey) : null, generation: 0 });
  }, [storageKey]);
  if (binding?.key !== storageKey) return <p role="status">Opening chat…</p>;
  return <ChatSession
    key={`${storageKey}:${binding.generation}`}
    name={name}
    agents={agents}
    storageKey={storageKey}
    initialSession={binding.session}
    onFresh={() => {
      for (const key of [storageKey, `${storageKey}:draft`, `${storageKey}:scroll`]) {
        try { tabStorage()?.removeItem(key); } catch {}
      }
      setBinding({ key: storageKey, session: null, generation: binding.generation + 1 });
    }}
  />;
}

function ChatSession({
  name,
  agents,
  storageKey,
  initialSession,
  onFresh,
}: {
  agents: ChatIdentity[];
  name: string;
  storageKey: string;
  initialSession: ClientSessionState | null;
  onFresh(): void;
}) {
  const router = useRouter();
  const identity = agents.find((a) => a.name === name) ?? {
    name,
    displayName: name,
    role: "",
  };
  const failed = useRef(false);
  const agent = useEveAgent({
    host: `/api/chat/${name}`,
    initialSession: initialSession ?? undefined,
    resume: initialSession !== null,
    onSessionChange(session) {
      const storage = tabStorage();
      if (storage && !failed.current) saveChatSession(storage, storageKey, session);
    },
  });
  useEffect(() => {
    if (agent.status === 'error') failed.current = true;
    if (failed.current) for (const key of [storageKey, `${storageKey}:draft`, `${storageKey}:scroll`]) {
      try { tabStorage()?.removeItem(key); } catch {}
    }
  }, [agent.status, storageKey]);
  const [personalSendCards,setPersonalSendCards]=useState<Record<string,PersonalSendCard|null>>({});
  const fetchingCards=useRef(new Set<string>());
  useEffect(()=>{
    for(const message of agent.data.messages)for(const part of message.parts){
      if(part.type!=='dynamic-tool'||part.toolName!=='personal_mailbox_send')continue;
      const request=part.toolMetadata?.eve?.inputRequest;if(!request||fetchingCards.current.has(request.requestId))continue;
      fetchingCards.current.add(request.requestId);
      void readPersonalSendCard(request.requestId).then(card=>setPersonalSendCards(previous=>({...previous,[request.requestId]:card})),()=>setPersonalSendCards(previous=>({...previous,[request.requestId]:null})));
    }
  },[agent.data.messages]);
  const [text, updateText] = useState(() => {
    try {
      return tabStorage()?.getItem(`${storageKey}:draft`) ?? "";
    } catch {
      return "";
    }
  });
  function setText(value: string) {
    updateText(value);
    try {
      const storage = failed.current ? null : tabStorage();
      if (value) storage?.setItem(`${storageKey}:draft`, value);
      else storage?.removeItem(`${storageKey}:draft`);
    } catch {}
  }
  const [answering, setAnswering] = useState<string | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const restored = useRef(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  useEffect(() => {
    const element = transcript.current;
    if (!element || !agent.data.messages.length) return;
    if (!restored.current) {
      restored.current = true;
      let saved: string | null = null;
      try {
        saved = tabStorage()?.getItem(`${storageKey}:scroll`) ?? null;
      } catch {}
      if (saved !== null && Number.isFinite(Number(saved))) {
        element.scrollTop = Number(saved);
        follow.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        setAwayFromBottom(!follow.current);
        return;
      }
    }
    if (follow.current) element.scrollTop = element.scrollHeight;
  }, [agent.data.messages, agent.status, storageKey]);
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const unavailable = failed.current || agent.status === "error";
  const composer = unavailable ? { disabled: true, say: "Start a new conversation to continue." } : composerState(agent.status);
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
    <div className="lares-page lares-chat">
      <PageHeader
        title="Chat"
        description="Talk things through. Your agents are here."
      />
      <div className="lares-chat-top">
        <Menu.Root>
          <Menu.Trigger asChild>
            <button
              className="lares-chat-selector"
              aria-label={`Chat with ${identity.displayName}`}
            >
              <AgentAvatar
                role={identity.role}
                src={
                  identity.avatarVersion
                    ? `/api/agents/${encodeURIComponent(identity.name)}/avatar?v=${identity.avatarVersion}`
                    : undefined
                }
              />
              <span>
                <span className="lares-muted">Chat with</span>
                <strong>{identity.displayName}</strong>
              </span>
              <span aria-hidden="true">⌄</span>
            </button>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content
              className="lares-agent-menu"
              align="start"
              sideOffset={6}
            >
              {(agents.length ? agents : [identity]).map((a) => (
                <Menu.Item
                  key={a.name}
                  className="lares-agent-option"
                  onSelect={() =>
                    router.push(`/chat/${encodeURIComponent(a.name)}`)
                  }
                >
                  <AgentAvatar
                    role={a.role}
                    src={
                      a.avatarVersion
                        ? `/api/agents/${encodeURIComponent(a.name)}/avatar?v=${a.avatarVersion}`
                        : undefined
                    }
                  />
                  <span>
                    <strong>{a.displayName}</strong>
                    <span className="lares-muted">{a.role}</span>
                  </span>
                  {a.name === name && <span aria-label="Selected">✓</span>}
                </Menu.Item>
              ))}
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
        <Button
          variant="ghost"
          type="button"
          onClick={onFresh}
        >
          New conversation
        </Button>
      </div>
      <div
        className="lares-conversation"
        ref={transcript}
        role="log"
        aria-label="Conversation"
        onScroll={() => {
          const element = transcript.current;
          if (!element) return;
          follow.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            80;
          setAwayFromBottom(!follow.current);
          try {
            tabStorage()?.setItem(
              `${storageKey}:scroll`,
              String(element.scrollTop),
            );
          } catch {}
        }}
      >
        {agent.data.messages.length === 0 &&
        agent.status !== "error" &&
        agent.status !== "resuming" ? (
          <div className="lares-chat-intro">
            <AgentAvatar
              role={identity.role}
              src={
                identity.avatarVersion
                  ? `/api/agents/${encodeURIComponent(identity.name)}/avatar?v=${identity.avatarVersion}`
                  : undefined
              }
            />
            <span className="lares-muted">{identity.displayName}</span>
            <p>What would you like to work on?</p>
          </div>
        ) : (
          <ChatTranscript
            status={agent.status}
            messages={agent.data.messages}
            error={unavailable ? "This conversation is unavailable. Start a new conversation." : null}
            expired={expired}
            answering={answering}
            onAnswer={answer}
            personalSendCards={personalSendCards}
            agentName={identity.displayName}
          />
        )}
      </div>
      {awayFromBottom && (
        <Button
          variant="outline"
          onClick={() => {
            const element = transcript.current;
            if (element) element.scrollTop = element.scrollHeight;
            follow.current = true;
            setAwayFromBottom(false);
          }}
        >
          Jump to latest ↓
        </Button>
      )}
      {answerError ? (
        <p
          role="alert"
          className="mono"
          style={{ fontSize: 12, color: "var(--bad)", marginBottom: 8 }}
        >
          {answerError}
        </p>
      ) : null}

      {composer.say ? (
        <p
          className="mono"
          style={{ fontSize: 12, color: "var(--mist)", marginBottom: 8 }}
        >
          {composer.say}
        </p>
      ) : null}

      {agent.data.messages.length === 0 && (
        <div className="lares-suggestions">
          {["What needs my attention?", "Help me plan the week"].map(
            (suggestion) => (
              <Button
                key={suggestion}
                variant="outline"
                type="button"
                disabled={composer.disabled}
                onClick={() => setText(suggestion)}
              >
                {suggestion}
              </Button>
            ),
          )}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const value = text.trim();
          if (value.length === 0 || composer.disabled) return;
          setText("");
          void agent.send(value, isBusy ? { turnPolicy: "steer" } : undefined);
        }}
        className="lares-composer"
      >
        <textarea
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          disabled={composer.disabled}
          aria-label={`Message ${identity.displayName}`}
          placeholder={`Message ${identity.displayName}…`}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <Button
          type="submit"
          size="icon"
          aria-label="Send message"
          disabled={composer.disabled || !text.trim()}
        >
          ↑
        </Button>
      </form>
      <p className="lares-chat-hint">
        Enter to send · Shift + Enter for a new line
      </p>
    </div>
  );
}
