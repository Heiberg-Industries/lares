import type { EveMessage, EveMessagePart, EveMessageInputRequest, UseEveAgentStatus } from "eve/react";

/**
 * W8B-s3 — the transcript is a PURE function of its props: given the same `messages`, `status`,
 * `error`, `expired` and `answering`, it always renders the same markup, with nothing read from
 * the network, the DOM, or time. That is what makes it testable with `renderToStaticMarkup` and no
 * browser (tests/chat-transcript.test.tsx), and it is also the whole of this page's safety story:
 * everything an agent or a tool said is a plain text child of a JSX element, which React escapes on
 * render. There is no `dangerouslySetInnerHTML`, no markdown-to-HTML step, and no auto-linking of
 * anything the owner did not type themselves — a model's output (which may be quoting a hostile
 * mail) cannot inject markup or a clickable look-alike link this way, because it is never parsed as
 * anything but text. The same holds for every field of an approval card below: a card renders a
 * tool's PROPOSED arguments, which are model-written, so they are rendered as text and nothing
 * else.
 *
 * W8B-s5 — a pending approval is now a real card with real buttons, because until this slice the
 * only doors that could answer one were Slack and Telegram, and a fresh installation has neither.
 * What the card must SHOW is the whole of its value: it is the last thing a person reads before an
 * irreversible action, and a card that hides a recipient invites a faster tap. See
 * `approvalCardText` for exactly what is shown, and why it is not `detailsForApproval`.
 */

export interface ChatTranscriptProps {
  readonly messages: readonly EveMessage[];
  readonly status: UseEveAgentStatus;
  readonly error?: string | null;
  /** Request ids whose card is older than the approval lifetime. Computed by the caller from the
   *  event stream's own timestamps (`expiredRequestIds`), so this component stays free of a clock. */
  readonly expired?: ReadonlySet<string>;
  /** The one request id an answer is in flight for, if any. Every button is disabled while it is
   *  set, which is what makes a double click send one answer. */
  readonly answering?: string | null;
  /** Called with the answer the owner chose. Absent (the default) renders each card with its state
   *  and NO buttons — which is what a transcript rendered anywhere that cannot send an answer
   *  should do. */
  readonly onAnswer?: (requestId: string, optionId: string) => void;
}

const UNSUPPORTED_PART = "— something this page cannot show yet —";

/** 24 hours, the same lifetime `APPROVAL_TTL_MS` enforces on the agent side
 *  (`packages/agent-kit/src/approval-ledger.ts`, W7A-s5). MIRRORED rather than imported, for the
 *  same reason every other mirror in this console exists: that module opens a database pool and
 *  cannot be bundled for a browser. `tests/engine-drift.test.ts` fails if the two disagree. */
export const APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Longest a rendered card body may run before it is cut. A card that hid part of what is being
 *  authorised has to admit it, in the same words the Slack and Telegram cards use
 *  (`shortenedNotice` in `packages/agent-kit/src/approval-summary.ts`). */
const CARD_MAX = 2800;

function shortened(text: string): string {
  if (text.length <= CARD_MAX) return text;
  const kept = Math.max(0, CARD_MAX - 80);
  return `${text.slice(0, kept).trimEnd()}…\n\n— shortened — ${text.length - kept} characters are not shown.`;
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
 * `action.input` shows a SUPERSET of what the Slack and Telegram cards show — every recipient,
 * every guest, the whole draft, and every other field — for every tool, including ones written
 * after this file. The input is on the wire in full (W8B-s4 measured it), so nothing had to be
 * added to the proxy's allow-lists to get it here.
 *
 * Rules kept from the kit's formatters, because they are the ones that matter:
 *  - no list is ever abbreviated to "and N more"; every recipient is named;
 *  - nothing is dropped for brevity — a long card is cut at the END and says how much is missing;
 *  - values are rendered as text, never interpreted.
 */
export function approvalCardText(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object" || Array.isArray(input)) return shortened(String(input));
  const lines: string[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const rendered = Array.isArray(value)
      ? value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(", ")
      : typeof value === "string"
        ? value
        : JSON.stringify(value) ?? String(value);
    lines.push(`${key}: ${rendered}`);
  }
  return shortened(lines.join("\n"));
}

/** The input request on a tool part, or undefined. eve's default reducer parks it under
 *  `toolMetadata.eve.inputRequest` (`dist/src/client/message-reducer-types.d.ts`) — NOT under the
 *  message's own `metadata`, which is where the plan's snippet looked for it. */
function requestOf(part: EveMessagePart): EveMessageInputRequest | undefined {
  return part.type === "dynamic-tool" ? part.toolMetadata?.eve?.inputRequest : undefined;
}

/**
 * Request ids whose card is past {@link APPROVAL_LIFETIME_MS}, read from the session stream's own
 * event timestamps. Pure: `now` is a parameter and the events are the ones eve already delivered.
 *
 * A card older than the lifetime is DEAD on the agent side — `assertApprovedCall` refuses it with
 * `StaleApprovalError` whether or not the browser still shows a button. Showing that state instead
 * of a button is the difference between "nothing happened" and "I clicked and nothing happened".
 */
export function expiredRequestIds(events: readonly unknown[], now: number): Set<string> {
  const out = new Set<string>();
  for (const event of events) {
    // `agent.events` is the authoritative server stream, so in practice every entry is an object —
    // but this runs on whatever came down a socket, and a card that crashes the transcript would
    // take every OTHER card on the page with it.
    if (event === null || typeof event !== "object") continue;
    const e = event as { type?: unknown; data?: { requests?: unknown }; meta?: { at?: unknown } };
    if (e.type !== "input.requested" || !Array.isArray(e.data?.requests)) continue;
    const at = typeof e.meta?.at === "string" ? Date.parse(e.meta.at) : NaN;
    if (Number.isNaN(at) || now - at <= APPROVAL_LIFETIME_MS) continue;
    for (const request of e.data.requests as { requestId?: unknown }[]) {
      if (typeof request?.requestId === "string") out.add(request.requestId);
    }
  }
  return out;
}

/** What an already-settled card says instead of buttons. Pure and exported so the wording is
 *  pinned by a test rather than by reading the JSX. */
export function settledSay(part: Extract<EveMessagePart, { type: "dynamic-tool" }>): string | null {
  switch (part.state) {
    case "approval-responded":
      return "You have answered this. Waiting for the agent.";
    case "output-available":
      return "You approved this, and it ran.";
    case "output-denied":
      return "You refused this. Nothing ran.";
    case "output-error":
      return "This was approved, and it failed.";
    default:
      return null;
  }
}

const cardStyle = {
  border: "1px solid var(--rule)",
  borderRadius: 4,
  background: "var(--card)",
  padding: 12,
  margin: "8px 0",
} as const;

function ApprovalCard({
  part,
  request,
  expired,
  answering,
  onAnswer,
}: {
  part: Extract<EveMessagePart, { type: "dynamic-tool" }>;
  request: EveMessageInputRequest;
  expired: boolean;
  answering: string | null;
  onAnswer?: (requestId: string, optionId: string) => void;
}) {
  const settled = settledSay(part);
  // A live button only when the card is still open, has not expired, nothing else is in flight,
  // and this transcript was given somewhere to send the answer. Every one of those is a reason a
  // button would do nothing, and a button that does nothing is worse than a sentence.
  const live = settled === null && !expired && onAnswer !== undefined && answering === null;
  const body = approvalCardText(part.input);
  return (
    <div style={cardStyle}>
      <p className="mono" style={{ fontSize: 11, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--warn)", margin: "0 0 6px" }}>
        Needs your approval
      </p>
      <p style={{ margin: "0 0 8px", whiteSpace: "pre-wrap", wordBreak: "break-word", fontWeight: 600 }}>{request.prompt}</p>
      {body === "" ? null : (
        <pre
          className="mono"
          style={{ margin: "0 0 10px", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--ink)", background: "transparent", border: 0, padding: 0 }}
        >
          {body}
        </pre>
      )}
      {settled !== null ? (
        <p className="mono" style={{ fontSize: 12, color: "var(--mist)", margin: 0 }}>{settled}</p>
      ) : expired ? (
        <p className="mono" style={{ fontSize: 12, color: "var(--mist)", margin: 0 }}>
          This card is more than 24 hours old, so it can no longer be answered. Ask again to get a fresh one.
        </p>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(request.options ?? []).map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={!live}
              onClick={live && onAnswer ? () => onAnswer(request.requestId, option.id) : undefined}
              className="mono"
              style={{
                padding: "6px 14px",
                border: "1px solid var(--rule)",
                borderRadius: 4,
                background: option.style === "primary" ? "var(--signal)" : "var(--card)",
                color: option.style === "primary" ? "#fff" : "var(--ink)",
                fontSize: 13,
                cursor: live ? "pointer" : "not-allowed",
              }}
            >
              {option.label}
            </button>
          ))}
          {answering === request.requestId ? (
            <span className="mono" style={{ fontSize: 12, color: "var(--mist)", alignSelf: "center" }}>Sending your answer…</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

interface CardState {
  readonly expired: ReadonlySet<string>;
  readonly answering: string | null;
  readonly onAnswer?: (requestId: string, optionId: string) => void;
}

function renderPart(part: EveMessagePart, key: number, cards: CardState) {
  if (part.type === "text") {
    // A plain text node only. Long lines wrap instead of overflowing; nothing here interprets the
    // text as HTML, Markdown, or a URL.
    return (
      <span key={key} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {part.text}
      </span>
    );
  }
  // Streamed model reasoning is not owner-facing here; skipped silently rather than shown as an
  // unsupported placeholder, per the plan's minimal implementation.
  if (part.type === "reasoning") return null;
  const request = requestOf(part);
  if (part.type === "dynamic-tool" && request !== undefined && request.kind === "tool-approval") {
    return (
      <ApprovalCard
        key={key}
        part={part}
        request={request}
        expired={cards.expired.has(request.requestId)}
        answering={cards.answering}
        onAnswer={cards.onAnswer}
      />
    );
  }
  return (
    <p key={key} className="mono" style={{ color: "var(--mist)", fontSize: 13, margin: "4px 0" }}>
      {UNSUPPORTED_PART}
    </p>
  );
}

function TranscriptMessage({ message, cards }: { message: EveMessage; cards: CardState }) {
  const who = message.role === "user" ? "You" : "Agent";
  return (
    <article style={{ marginBottom: 16 }}>
      <div
        className="mono"
        style={{ fontSize: 11, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--mist)", marginBottom: 4 }}
      >
        {who}
      </div>
      <div>{message.parts.map((part, i) => renderPart(part, i, cards))}</div>
    </article>
  );
}

const NONE: ReadonlySet<string> = new Set();

export function ChatTranscript({ messages, status, error, expired = NONE, answering = null, onAnswer }: ChatTranscriptProps) {
  const cards: CardState = { expired, answering, ...(onAnswer === undefined ? {} : { onAnswer }) };
  return (
    <div>
      {messages.length === 0 ? (
        <p style={{ color: "var(--mist)" }}>Say something to start.</p>
      ) : (
        messages.map((message) => <TranscriptMessage key={message.id} message={message} cards={cards} />)
      )}
      {status === "error" && error ? (
        <p role="alert" style={{ color: "var(--bad)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** What the composer may do right now. Pure, so the rule is testable without a browser. */
export function composerState(status: UseEveAgentStatus): { disabled: boolean; say: string } {
  switch (status) {
    case "resuming":
      return { disabled: true, say: "Reconnecting to the agent…" };
    case "streaming":
      return { disabled: false, say: "The agent is still answering — sending now replaces its turn." };
    case "submitted":
      return { disabled: false, say: "" };
    case "error":
      return { disabled: false, say: "" };
    case "ready":
    default:
      return { disabled: false, say: "" };
  }
}
