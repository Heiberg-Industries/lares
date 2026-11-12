"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AgentAvatar, PageHeader } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Textarea } from "@lares/ui/primitives/textarea";
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
import { session as sessionOf } from "eve/events";
import {
  ChatTranscript,
  composerState,
  expiredInteractionIds,
  type AnswerOption,
} from "./ChatTranscript";
import { agentNotRunning, notRunningSay } from "../lib/agent-reachability";
import { conversationTooLongOf, limitReplyOf } from "../lib/limit-reply";
import {
  chatSessionKey,
  CONSOLE_REFUSAL_HEADER,
  ENDED_SAY,
  endedConversation,
  readChatSession,
  saveChatSession,
  type EndedConversation,
} from "../lib/chat-session";

function tabStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** The proxy's own refusals are plain text in the console's own words, and carry the proxy's own
 *  mark (`refuse` in `lib/chat-proxy.ts`). Anything else a failed request carries — plain text
 *  included — was written by the agent or its framework and is never shown: an agent cannot set
 *  the mark, because the proxy does not relay that header. Returns the proxy's sentence, or null. */
function proxySentence(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const { body, headers } = error as { body?: unknown; headers?: Record<string, unknown> };
  if (headers?.[CONSOLE_REFUSAL_HEADER] !== "1") return null;
  const type = headers["content-type"];
  if (typeof body !== "string" || typeof type !== "string" || !type.startsWith("text/plain")) return null;
  return body.length > 0 && body.length <= 200 ? body : null;
}

/**
 * The thin client half. All state and transport is eve's own `useEveAgent`; this
 * component only turns the hook's snapshot into the plain-style form the rest of the console uses,
 * and turns a submit into a `send`.
 *
 * `baseUrl` is a same-origin prefix, never an absolute address — `/api/chat/<name>` is the route
 * `services/console/app/api/chat/[name]/[...path]/route.ts` answers (`forwardChat`), so
 * this component never sees, holds, or sends the agent's own route password; the browser's only
 * credential is the console's own session cookie, exactly as every other page here.
 *
 * `prewarm` is left at its default (`false`): no session exists until the
 * first message is sent, so opening this page creates nothing.
 *
 * What the hook reports. `status` is outstanding work only (`idle`, `busy`, `resuming`); a
 * failure is `error`, beside it. `messages` is the conversation, `events` the session's own
 * record, `session` the state to save for a reload — saved whole and handed back unchanged
 * (`lib/chat-session.ts`).
 *
 * A message sent while the agent works joins the turn it is in; that is the framework's default,
 * so no option is passed with it and the request stays `{ message }`.
 *
 * An ENDED conversation. Every framework upgrade ends the conversations that were open, so this is
 * an ordinary event, not a fault. A send or an answer into one is refused by the agent with a
 * stable code; `endedConversation` reads it and the page says one plain sentence and offers a new
 * conversation. Nothing is retried, and the framework's own error text is never shown.
 *
 * Answering an approval. `agent.respond([{ interactionId, optionId }])` is eve's own call and
 * the only one that answers a card; the `interactionId` comes from the card's own request, NOT
 * from the tool call id (the two differ on the wire), and `optionId` is `"approve"` or `"deny"`.
 * Three rules live here rather than in the transcript, because they are about time and the
 * transcript is pure:
 *
 *  - ONE answer per click. `answering` holds the interaction id while the POST is in flight; every
 *    button in the transcript is disabled while it is set, so a double click is one answer.
 *  - ONE request at a time. `respond` takes an array; sending a single element keeps the answer,
 *    the card and any refusal in one-to-one correspondence.
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
  const preserveFailedDraft = useRef(false);
  const firstSendInFlight = useRef(false);
  const mounted = useRef(false);
  const lifetime = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lifetime.current++;
    };
  }, []);
  const agent = useEveAgent({
    baseUrl: `/api/chat/${name}`,
    initialSession: initialSession ?? undefined,
    resume: initialSession !== null,
    onSessionChange(session) {
      const storage = tabStorage();
      if (storage && !failed.current) saveChatSession(storage, storageKey, session);
    },
  });
  const hasError = agent.error !== undefined;
  // Set when an answer was refused because the conversation is over; `agent.error` says the same
  // for a message, and for a saved conversation that cannot be reopened.
  const [endedByAnswer, setEndedByAnswer] = useState<EndedConversation | null>(null);
  // Over, and why: the agent refused with an "ended" code, or the conversation's own record shows
  // it has ended. Either way nothing more can be sent into it.
  const recorded = sessionOf(agent.view);
  const ended: EndedConversation | null =
    endedConversation(agent.error) ?? endedByAnswer ?? (recorded.status === "ended" ? endedConversation(recorded.error) ?? "ended" : null);
  // A model call refused for a spending limit is not a broken conversation: the sentence is shown,
  // the session and the draft stay, and the member can write again (a new month resets the limit).
  const limitReply = hasError && ended === null ? limitReplyOf(agent.events) : null;
  const broken = ended !== null || (hasError && limitReply === null);
  // A conversation that has grown too long is broken (every later turn would fail the same way),
  // but its own sentence says why and how to go on, in place of "This conversation is unavailable."
  const tooLong = broken && ended === null ? conversationTooLongOf(agent.events) : null;
  useEffect(() => {
    if (broken) failed.current = true;
    if (failed.current) for (const key of [storageKey, `${storageKey}:draft`, `${storageKey}:scroll`]) {
      if (preserveFailedDraft.current && key === `${storageKey}:draft`) continue;
      try { tabStorage()?.removeItem(key); } catch {}
    }
  }, [broken, storageKey]);
  const [personalSendCards,setPersonalSendCards]=useState<Record<string,PersonalSendCard|null>>({});
  const fetchingCards=useRef(new Set<string>());
  useEffect(()=>{
    for(const message of agent.messages)for(const part of message.parts){
      if(part.type!=='tool'||part.name!=='personal_mailbox_send')continue;
      // Keyed on the card's interaction id: the id the agent recorded for the proposal, and the
      // one an answer names.
      const card=part.interaction?.request.kind==='approval'?part.interaction:undefined;
      if(!card||fetchingCards.current.has(card.interactionId))continue;
      const id=card.interactionId;
      fetchingCards.current.add(id);
      void readPersonalSendCard(id).then(found=>setPersonalSendCards(previous=>({...previous,[id]:found})),()=>setPersonalSendCards(previous=>({...previous,[id]:null})));
    }
  },[agent.messages]);
  const [text, updateText] = useState(() => {
    try {
      return tabStorage()?.getItem(`${storageKey}:draft`) ?? "";
    } catch {
      return "";
    }
  });
  const [preparingFirstSession, setPreparingFirstSession] = useState(false);
  const currentDraft = useRef(text);
  const draftRevision = useRef(0);
  function setText(value: string) {
    draftRevision.current++;
    currentDraft.current = value;
    updateText(value);
    try {
      const storage = failed.current ? null : tabStorage();
      if (value) storage?.setItem(`${storageKey}:draft`, value);
      else storage?.removeItem(`${storageKey}:draft`);
    } catch {}
  }
  function restoreUnsentDraft(value: string, submittedRevision: number) {
    // A newer keystroke wins. The caller also checks the mounted ChatSession lifetime, since
    // a replacement conversation can reuse this same member-and-agent storage key.
    if (currentDraft.current !== "" || draftRevision.current !== submittedRevision) return;
    draftRevision.current++;
    currentDraft.current = value;
    updateText(value);
    try {
      tabStorage()?.setItem(`${storageKey}:draft`, value);
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
    if (!element || !agent.messages.length) return;
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
  }, [agent.messages, agent.status, storageKey]);
  const unavailable = failed.current || broken;
  // Asked once when a conversation fails, never on a timer: is the agent itself down?
  const [notRunning, setNotRunning] = useState(false);
  useEffect(() => {
    if (!unavailable) return;
    let current = true;
    void agentNotRunning(name).then((down) => { if (current) setNotRunning(down); });
    return () => { current = false; };
  }, [unavailable, name]);
  // An ended conversation is not the agent being down: its own sentence wins.
  // So is one that grew too long: the agent answered, and a new conversation is the way on.
  const notRunningText = unavailable && ended === null && tooLong === null && notRunning ? notRunningSay(identity.displayName, name) : null;
  // The one sentence a failed conversation shows. Ours, always: never the framework's error text.
  const unavailableSay = ended !== null
    ? ENDED_SAY[ended]
    : tooLong ?? notRunningText ?? "This conversation is unavailable. Start a new conversation.";
  const composer = unavailable
    ? { disabled: true, say: ended !== null ? "" : notRunningText ?? "Start a new conversation to continue." }
    : composerState(agent.status);
  const expired = expiredInteractionIds(agent.events, Date.now());

  const answer = (interactionId: string, optionId: AnswerOption) => {
    // The guard is belt to the transcript's braces: its buttons are already disabled while an
    // answer is in flight, and this makes a stray call from anywhere else a no-op too.
    if (answering !== null || unavailable) return;
    setAnswering(interactionId);
    setAnswerError(null);
    void agent
      .respond([{ interactionId, optionId }])
      .catch((error: unknown) => {
        // The conversation is over: say that, once, and offer a new one. Nothing is retried.
        const over = endedConversation(error);
        if (over !== null) {
          setEndedByAnswer(over);
          return;
        }
        // In our own words. eve's refusal can name a session id and a turn; what the owner needs
        // to know is that nothing happened and the card is still there. Only a sentence this
        // console's own proxy wrote is repeated.
        const why = proxySentence(error);
        setAnswerError(`Your answer did not reach the agent, so nothing has been done${why === null ? "." : `: ${why}`}`);
      })
      .finally(() => setAnswering(null));
  };

  async function sendMessage(
    value: string,
    submittedRevision?: number,
    onSendEntered?: () => void,
  ) {
    const submittedLifetime = lifetime.current;
    const isCurrentSession = () => mounted.current && lifetime.current === submittedLifetime;
    if (!isCurrentSession()) return;
    // Create an empty, already-bound session on the first send. The actual message then uses
    // the session route, which lets the server sign its exact bytes against that binding.
    if (!agent.session) {
      preserveFailedDraft.current = true;
      try {
        await agent.prewarm();
      } catch {
        if (!isCurrentSession()) return;
        // No message was submitted. Eve exposes the failed creation through its hook error;
        // preserve the unsent text for this chat without overwriting newer typing.
        if (submittedRevision !== undefined) restoreUnsentDraft(value, submittedRevision);
        return;
      }
      if (!isCurrentSession()) return;
      preserveFailedDraft.current = false;
    }
    if (!isCurrentSession()) return;
    try {
      const sending = agent.send(value);
      onSendEntered?.();
      await sending;
    } catch {
      // A send may already have been accepted. Eve owns the visible error state (a refusal
      // because the conversation is over arrives there too, and is worded above); never replay
      // a message here or tell the user that it was not dispatched.
    }
  }

  return (
    <div>
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
        {agent.messages.length === 0 &&
        !unavailable &&
        !hasError &&
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
            messages={agent.messages}
            error={limitReply ?? (unavailable ? unavailableSay : null)}
            ended={ended !== null}
            notRunning={notRunningText}
            expired={expired}
            answering={answering}
            {...(unavailable ? {} : { onAnswer: answer })}
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
        <p role="alert" className="mono lares-chat-note lares-status-error">
          {answerError}
        </p>
      ) : null}

      {composer.say ? (
        <p className="mono lares-chat-note lares-status-muted">
          {composer.say}
        </p>
      ) : null}
      {/* A conversation that is over or broken is not retried: the way on is a new one. An agent
          that is not running is the one case where a new conversation would not help. */}
      {unavailable && notRunningText === null ? (
        <Button type="button" onClick={onFresh}>
          Start a new conversation
        </Button>
      ) : null}
      {preparingFirstSession ? (
        <p role="status" className="mono lares-chat-note lares-status-muted">
          Preparing your conversation. Your draft is saved.
        </p>
      ) : null}

      {agent.messages.length === 0 && (
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
          if (value.length === 0 || composer.disabled || firstSendInFlight.current) return;
          const needsFirstSession = !agent.session;
          const submittedLifetime = lifetime.current;
          if (needsFirstSession) {
            firstSendInFlight.current = true;
            setPreparingFirstSession(true);
          }
          setText("");
          const submittedRevision = draftRevision.current;
          const releasePreparation = () => {
            if (!needsFirstSession || !mounted.current || lifetime.current !== submittedLifetime) return;
            firstSendInFlight.current = false;
            setPreparingFirstSession(false);
          };
          void sendMessage(
            value,
            submittedRevision,
            releasePreparation,
          ).finally(releasePreparation);
        }}
        className="lares-composer"
      >
        <Textarea
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
