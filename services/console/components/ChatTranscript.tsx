import type { EveInteractionPart, EveMessage, EveMessagePart, EveToolPart, Interaction, UseEveAgentStatus } from "eve/react";
import { Button } from "@lares/ui/primitives/button";
import { SafeMarkdown } from "./SafeMarkdown";
import { approvalArguments,personalSendCardFields,type PersonalSendCard, type ApprovalField } from "../lib/approval-text";

/**
 * The transcript is a PURE function of its props: given the same `messages`, `status`,
 * `error`, `expired` and `answering`, it always renders the same markup, with nothing read from
 * the network, the DOM, or time. That is what makes it testable with `renderToStaticMarkup` and no
 * browser (tests/chat-transcript.test.tsx), and it is also the whole of this page's safety story:
 * the owner's own messages, tool names and every field of an approval card are plain text children
 * of a JSX element, which React escapes on render. An AGENT's reply is formatted (bold, lists,
 * links, code) by `SafeMarkdown`, which builds React elements from a fixed allow-list and never
 * parses raw HTML: there is still no `dangerouslySetInnerHTML`, `<script>` or `<img onerror=...>`
 * in a reply is shown as characters, and a link is only an anchor for `http:`, `https:` or
 * `mailto:` addresses (anything else is shown as written; bare addresses are not auto-linked). A
 * model's output (which may be quoting a hostile mail) therefore cannot inject markup or a
 * look-alike link. The same holds for every field of an approval card below: a card renders a
 * tool's PROPOSED arguments, which are model-written, so they are rendered as text, never as
 * Markdown, and nothing else.
 *
 * EVERY PART KIND HAS ITS OWN BRANCH (`renderPart`), and none is passed through as it arrived:
 *  - `text`: the owner's words as plain text, the agent's through `SafeMarkdown`;
 *  - `reasoning`: not shown;
 *  - `file`: a name and a type, as text — never a link, never the file;
 *  - `tool`: an approval card, a question, or one line naming the tool and how it ended — never
 *    its output;
 *  - `interaction` (something the agent asks that no tool call carries): the question as text;
 *  - anything a later framework adds: a labelled placeholder.
 *
 * A pending approval is a real card with real buttons, because the only other doors that can
 * answer one are Slack and Telegram, and a fresh installation has neither.
 * What the card must SHOW is the whole of its value: it is the last thing a person reads before an
 * irreversible action, and a card that hides a recipient invites a faster tap. See
 * `approvalCardFields` for exactly what is shown, and why it is not `detailsForApproval`.
 */

export interface ChatTranscriptProps {
  readonly messages: readonly EveMessage[];
  /** The framework's own word for outstanding work: `idle`, `busy` or `resuming`. A failure is
   *  not a status: the caller says it in `error`. */
  readonly status: UseEveAgentStatus;
  /** The words to show when the conversation has failed, in the console's own language; absent or
   *  null when it has not. */
  readonly error?: string | null;
  /** True when the conversation itself is over (ended by an update, or otherwise). `error` then
   *  carries the plain sentence, and no card keeps a button: nothing can answer it any more. */
  readonly ended?: boolean;
  /** Interaction ids whose card is older than the approval lifetime. Computed by the caller from
   *  the event stream's own timestamps (`expiredInteractionIds`), so this component stays free of
   *  a clock. */
  readonly expired?: ReadonlySet<string>;
  /** The one interaction id an answer is in flight for, if any. Every button is disabled while it
   *  is set, which is what makes a double click send one answer. */
  readonly answering?: string | null;
  /** Called with the answer the owner chose. Absent (the default) renders each card with its state
   *  and NO live buttons — which is what a transcript rendered anywhere that cannot send an answer
   *  should do. */
  readonly onAnswer?: (interactionId: string, optionId: AnswerOption) => void;
  /** The agent's display name, shown above its replies. Falls back to "Agent" when absent. */
  readonly agentName?: string;
  /** The trusted review of a personal mail, by the interaction id of its card. */
  readonly personalSendCards?:Readonly<Record<string,PersonalSendCard|null>>;
  /** Set when the agent itself cannot be reached (it is not running): these words replace the
   *  "could not be reopened / unavailable" lines, which would wrongly suggest a new chat helps. */
  readonly notRunning?: string | null;
}

const UNSUPPORTED_PART = "— something this page cannot show yet —";

/** The two answers a card has, by the framework's own option ids (`APPROVE_OPTION_ID` and
 *  `DENY_OPTION_ID` in `eve/events`). Written out here so this module stays free of a runtime
 *  import; `tests/chat-transcript.test.tsx` checks the two against the framework's. */
export const APPROVE = "approve";
export const DENY = "deny";
export type AnswerOption = typeof APPROVE | typeof DENY;

/** 24 hours, the same lifetime `APPROVAL_TTL_MS` enforces on the agent side
 *  (`packages/agent-kit/src/approval-ledger.ts`). MIRRORED rather than imported, for the
 *  same reason every other mirror in this console exists: that module opens a database pool and
 *  cannot be bundled for a browser. `tests/engine-drift.test.ts` fails if the two disagree. */
export const APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Longest a rendered card body may run before it is cut. A card that hid part of what is being
 *  authorised has to admit it, in the same words the Slack and Telegram cards use
 *  (`shortenedNotice` in `packages/agent-kit/src/approval-summary.ts`). */
const CARD_MAX = 2800;

/** The fields within {@link CARD_MAX} characters of value, the last one cut where the room ends
 *  (and later ones left out), and — when anything was cut — the sentence that says how much. */
function shortened(fields: readonly ApprovalField[]): { fields: ApprovalField[]; notice: string | null } {
  const total = fields.reduce((n, f) => n + f.value.length, 0);
  if (total <= CARD_MAX) return { fields: [...fields], notice: null };
  let room = Math.max(0, CARD_MAX - 80);
  const kept: ApprovalField[] = [];
  for (const field of fields) {
    if (room <= 0) break;
    if (field.value.length <= room) {
      kept.push(field);
      room -= field.value.length;
    } else {
      kept.push({ key: field.key, value: `${field.value.slice(0, room).trimEnd()}…` });
      room = 0;
    }
  }
  const shown = kept.reduce((n, f) => n + f.value.replace(/…$/, "").length, 0);
  return { fields: kept, notice: `— shortened — ${total - shown} characters are not shown.` };
}

/**
 * Every argument the tool would be called with, one field per line, as plain text.
 *
 * WHY THIS IS NOT `detailsForApproval`. The plan named
 * `detailsForApproval(action.toolName, action.input)` from `@lares/agent-kit/approval-summary`.
 * That module CANNOT be bundled for a browser: it imports `./clock.js` → `./owner-clock.js`, which
 * imports `node:fs` and `node:path`, and `next build` fails on it —
 * `UnhandledSchemeError: Reading from "node:path" is not handled by plugins`, measured in this
 * worktree, not assumed. The two honest alternatives were a console-side mirror of the kit's
 * per-tool DETAILS registry, or this: render the arguments themselves.
 *
 * This is the stronger of the two, and not only because a mirror drifts. `detailsForApproval` has
 * an entry for five tools; for the other sixteen gated tools it returns nothing at all, and a web
 * card built on it would show those sixteen a title and no arguments whatsoever. Rendering
 * the call's `input` shows a SUPERSET of what the Slack and Telegram cards show — every recipient,
 * every guest, the whole draft, and every other field — for every tool, including ones written
 * after this file. The input is on the wire in full, so nothing had to be
 * added to the proxy's allow-lists to get it here.
 *
 * Rules kept from the kit's formatters, because they are the ones that matter:
 *  - no list is ever abbreviated to "and N more"; every recipient is named;
 *  - nothing is dropped for brevity — a long card is cut at the END and says how much is missing;
 *  - values are rendered as text, never interpreted.
 *
 * Each argument is its own field (name, then the value in its own box), never one joined text —
 * see `lib/approval-text.ts`. The full, unshortened fields are `approvalArguments`, which the
 * Waiting on you page shows whole.
 */
export function approvalCardFields(input: unknown): { fields: ApprovalField[]; notice: string | null } {
  return shortened(approvalArguments(input));
}

type ToolPart = EveToolPart;

/**
 * The approval a tool call is waiting on, or was. The framework puts the latest approval or
 * question about a call on that call's own part, as `interaction`
 * (`eve/dist/src/client/message-types.d.ts`); its `interactionId` is what an answer names, and it
 * is NOT the call id.
 */
function approvalOf(part: ToolPart): Interaction | undefined {
  return part.interaction?.request.kind === "approval" ? part.interaction : undefined;
}

/** The question an agent asked, for showing as text rather than as a running tool: on a tool
 *  call's own part, or as a part of its own. Its choices are named only while it is still open.
 *  A question whose record is gone falls back to the `ask_question` tool's own input. */
export function questionOf(part: ToolPart | EveInteractionPart): { prompt: string; choices: string[] } | undefined {
  const asked = part.type === "interaction" ? part : part.interaction;
  if (asked?.request.kind === "question") {
    return { prompt: asked.request.prompt, choices: asked.status === "open" ? (asked.request.options ?? []).map((option) => option.label) : [] };
  }
  if (part.type !== "tool" || part.name !== "ask_question") return undefined;
  const input = part.input as { prompt?: unknown; question?: unknown } | null | undefined;
  const prompt = typeof input?.question === "string" ? input.question : input?.prompt;
  return typeof prompt === "string" ? { prompt, choices: [] } : undefined;
}

/**
 * Interaction ids whose card is past {@link APPROVAL_LIFETIME_MS}, read from the session stream's
 * own `interaction.opened` events and the time of the line each was recorded in. Pure: `now` is a
 * parameter and the events are the ones eve already delivered.
 *
 * A card older than the lifetime is DEAD on the agent side — `assertApprovedCall` refuses it with
 * `StaleApprovalError` whether or not the browser still shows a button. Showing that state instead
 * of a button is the difference between "nothing happened" and "I clicked and nothing happened".
 */
export function expiredInteractionIds(events: readonly unknown[], now: number): Set<string> {
  const out = new Set<string>();
  for (const event of events) {
    // `agent.events` is the authoritative server stream, so in practice every entry is an object —
    // but this runs on whatever came down a socket, and a card that crashes the transcript would
    // take every OTHER card on the page with it.
    if (event === null || typeof event !== "object") continue;
    const e = event as { type?: unknown; data?: { interactionId?: unknown } | null; meta?: { at?: unknown } };
    if (e.type !== "interaction.opened" || typeof e.data?.interactionId !== "string") continue;
    const at = typeof e.meta?.at === "string" ? Date.parse(e.meta.at) : NaN;
    if (Number.isNaN(at) || now - at <= APPROVAL_LIFETIME_MS) continue;
    out.add(e.data.interactionId);
  }
  return out;
}

/**
 * What a card says instead of buttons, or null while it is still waiting for an answer. Pure and
 * exported so the wording is pinned by a test rather than by reading the JSX.
 *
 * Whether a person decided is read from the approval's own `outcome`, never from how the call
 * went: `accepted` and `declined` are a decision, and every other ending — withdrawn because a
 * message was sent instead, interrupted because the turn was stopped, expired, and any a later
 * framework adds — means nobody decided. Those cards are no longer active, and say so; they are
 * never shown as approved and never as still waiting.
 */
export function settledSay(part: ToolPart): string | null {
  const approval = approvalOf(part);
  if (!approval) return null;
  if (approval.status === "open") {
    return approval.answer === undefined ? null : "You have answered this. Waiting for the agent.";
  }
  if (approval.outcome === "accepted") {
    switch (part.state) {
      case "completed":
        return "You approved this, and it ran.";
      case "failed":
        return "This was approved, and it failed.";
      case "rejected":
        return "This was approved, and then refused. Nothing ran.";
      case "cancelled":
        return "This was approved, and stopped before it finished.";
      default:
        return "You approved this. The agent is carrying it out.";
    }
  }
  if (approval.outcome === "declined") return "You denied this. Nothing ran.";
  return "This card is no longer active. Nothing was approved.";
}

function ApprovalCard({
  part,
  approval,
  expired,
  ended,
  answering,
  onAnswer,
  personalCard,
}: {
  personalCard?:PersonalSendCard|null;
  part: ToolPart;
  approval: Interaction;
  expired: boolean;
  ended: boolean;
  answering: string | null;
  onAnswer?: (interactionId: string, optionId: AnswerOption) => void;
}) {
  const settled = settledSay(part);
  // A live button only when the card is still open, has not expired, nothing else is in flight,
  // and this transcript was given somewhere to send the answer. Every one of those is a reason a
  // button would do nothing, and a button that does nothing is worse than a sentence.
  const personal=part.name==='personal_mailbox_send';
  const live = settled === null && !expired && !ended && onAnswer !== undefined && answering === null;
  const body = personal?{fields:personalCard?personalSendCardFields(personalCard):[],notice:personalCard?null:'Full mail review is unavailable. You can deny this proposal.'}:approvalCardFields(part.input);
  // Only the two answers a card has. An option a later framework adds is not offered: this page
  // could not say what pressing it would do.
  const options = (approval.request.options ?? []).filter((option): option is typeof option & { id: AnswerOption } => option.id === APPROVE || option.id === DENY);
  return (
    <div className="lares-approval">
      <p className="mono lares-approval-eyebrow">Needs your approval</p>
      <p className="lares-approval-prompt">{approval.request.prompt}</p>
      {body.fields.map((field, i) => (
        <div key={i} className="lares-approval-field">
          <p className="mono lares-approval-key">{field.key}</p>
          <pre className="mono lares-approval-value">{field.value}</pre>
        </div>
      ))}
      {body.notice === null ? null : (
        <p className="mono lares-approval-note lares-approval-gap">{body.notice}</p>
      )}
      {settled !== null ? (
        <p className="mono lares-approval-note">{settled}</p>
      ) : ended ? (
        <p className="mono lares-approval-note">This card is no longer active. Nothing was approved.</p>
      ) : expired ? (
        <p className="mono lares-approval-note">
          This card is more than 24 hours old, so it can no longer be answered. Ask again to get a fresh one.
        </p>
      ) : (
        <div className="lares-actions">
          {options.map((option) => {
            // A personal mail may be approved only with its trusted review on the card; denying
            // it needs no review.
            const usable = live && (!personal || !!personalCard || option.id === DENY);
            return (
              <Button
                key={option.id}
                type="button"
                variant={option.id === APPROVE ? "default" : "outline"}
                disabled={!usable}
                onClick={usable && onAnswer ? () => onAnswer(approval.interactionId, option.id) : undefined}
              >
                {option.label}
              </Button>
            );
          })}
          {answering === approval.interactionId ? (
            <span className="mono lares-approval-note">Sending your answer…</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

interface CardState {
  personalSendCards?:Readonly<Record<string,PersonalSendCard|null>>;
  readonly expired: ReadonlySet<string>;
  readonly ended: boolean;
  readonly answering: string | null;
  readonly onAnswer?: (interactionId: string, optionId: AnswerOption) => void;
}

/** How one tool line ends. A state a later framework adds claims nothing. */
function toolOutcome(state: ToolPart["state"]): string {
  switch (state) {
    case "completed":
      return " completed";
    case "failed":
      return " failed";
    // A call that was refused (by the owner or by the agent's own checks): finished, nothing ran.
    case "rejected":
      return " was refused";
    case "cancelled":
      return " was stopped";
    case "streaming":
    case "requested":
    case "approval":
    case "running":
    case "blocked":
      return " is running…";
    default:
      return "";
  }
}

function renderQuestion(question: { prompt: string; choices: string[] }, key: number | string) {
  // The agent's own words, so plain text like an approval card, and answered in the box below.
  return (
    <div key={key}>
      <p className="whitespace-pre-wrap break-words">{question.prompt}</p>
      {question.choices.length > 0 ? <p className="mono lares-tool-line break-words">You can reply: {question.choices.join(", ")}</p> : null}
    </div>
  );
}

function renderPart(part: EveMessagePart, index: number, cards: CardState, role: EveMessage["role"]) {
  // The framework gives a streaming reply's text a stable id; a part without one keeps its place.
  const key = "id" in part && typeof part.id === "string" ? part.id : index;
  switch (part.type) {
    case "text":
      // The owner's own words stay plain text. An agent's reply is formatted by SafeMarkdown, which
      // builds a fixed set of elements and never interprets raw HTML (see its header).
      if (role === "user") {
        return (
          <span key={key} className="lares-user-text">
            {part.text}
          </span>
        );
      }
      return <SafeMarkdown key={key} text={part.text} />;
    // Streamed model reasoning is not owner-facing here; skipped silently rather than shown as an
    // unsupported placeholder.
    case "reasoning":
      return null;
    // Something a person attached. Named, as text: never a link to it, never its contents.
    case "file":
      return (
        <p key={key} className="mono lares-tool-line break-words">
          Attachment: {typeof part.filename === "string" && part.filename !== "" ? part.filename : "a file"} ({part.mediaType})
        </p>
      );
    case "tool": {
      const approval = approvalOf(part);
      if (approval !== undefined) {
        return (
          <ApprovalCard
            key={key}
            part={part}
            approval={approval}
            expired={cards.expired.has(approval.interactionId)}
            ended={cards.ended}
            answering={cards.answering}
            onAnswer={cards.onAnswer}
            personalCard={cards.personalSendCards?.[approval.interactionId]}
          />
        );
      }
      const question = questionOf(part);
      if (question !== undefined) return renderQuestion(question, key);
      // The tool's own name and how it ended. Never its output, and never its label: a label can
      // come from what the tool returned.
      return (
        <p key={key} className="mono lares-tool-line">
          {part.name}{toolOutcome(part.state)}
        </p>
      );
    }
    // Something the agent asks that no tool call carries. A question is shown as its words and is
    // answered in the box below. A sign-in or a spending prompt is shown as its words only: this
    // page offers no button for one, and never turns its address into a link.
    case "interaction": {
      const question = questionOf(part);
      if (question !== undefined) return renderQuestion(question, key);
      return (
        <div key={key}>
          <p className="whitespace-pre-wrap break-words">{part.request.prompt}</p>
          {part.status === "open" ? <p className="mono lares-tool-line">This page cannot answer this request.</p> : null}
        </div>
      );
    }
    default:
      return (
        <p key={key} className="mono lares-tool-line lares-tool-line-large">
          {UNSUPPORTED_PART}
        </p>
      );
  }
}

function TranscriptMessage({ message, cards, agentName }: { message: EveMessage; cards: CardState; agentName?: string }) {
  const who = message.role === "user" ? "You" : agentName || "Agent";
  return (
    <article className={`lares-message ${message.role === "user" ? "lares-message-user" : "lares-message-agent"}`}>
      <div className="mono lares-message-who">{who}</div>
      <div>{message.parts.map((part, i) => renderPart(part, i, cards, message.role))}</div>
      {message.role === "user" && message.metadata?.status === "failed" ? (
        <p className="mono lares-tool-line">This message was not sent.</p>
      ) : null}
    </article>
  );
}

const NONE: ReadonlySet<string> = new Set();

export function ChatTranscript({ messages, status, error = null, ended = false, expired = NONE, answering = null, onAnswer, agentName,personalSendCards, notRunning = null }: ChatTranscriptProps) {
  const cards: CardState = { expired, ended, answering,personalSendCards, ...(onAnswer === undefined ? {} : { onAnswer }) };
  const failed = error !== null && error !== "";
  // With nothing to show: a reconnect in progress, the reason there is nothing, or an invitation.
  // An ended conversation says its one sentence once, in the alert below.
  const empty = status === "resuming"
    ? "Reconnecting to this conversation…"
    : failed
      ? notRunning ?? (ended ? null : "This conversation could not be reopened. Start a new chat to continue.")
      : "Say something to start.";
  return (
    <div>
      {messages.length === 0 ? (
        empty === null ? null : <p className="lares-status-muted">{empty}</p>
      ) : (
        messages.map((message) => <TranscriptMessage key={message.id} message={message} cards={cards} {...(agentName === undefined ? {} : { agentName })} />)
      )}
      {failed && !(messages.length === 0 && notRunning) ? (
        <p role="alert" className="lares-status-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** What the composer may do right now. Pure, so the rule is testable without a browser. */
export function composerState(status: UseEveAgentStatus): { disabled: boolean; say: string } {
  switch (status) {
    // Catching up on a saved conversation: nothing may be sent or answered until it has.
    case "resuming":
      return { disabled: true, say: "Reconnecting to the agent…" };
    // A message sent while the agent works joins the turn it is in, and redirects it.
    case "busy":
      return { disabled: false, say: "The agent is still working — sending now redirects what it is doing." };
    case "idle":
    default:
      return { disabled: false, say: "" };
  }
}
