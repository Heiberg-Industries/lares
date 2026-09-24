/**
 * Email triage — the actual behavior port (ORB-76), from
 * services/agent-runtime/lib/workflows/email-triage.ts. Given one inbound message on the
 * mailbox it arrived on: classify it (needs_reply | fyi | automated), and for needs_reply,
 * draft a voice-matched reply on that SAME mailbox (autonomous-with-audit — no 👍, matching
 * today's behavior exactly; reversible, since it's a draft, never a send) and ping Slack.
 *
 * Ported behavior, simplified where noted:
 *  - calendar-notice guard FIRST, before classifySender even runs — Google generates
 *    "Accepted: …" from the real attendee's address, so classifySender cannot catch it and
 *    an instruction-only guard is not enough (the model may weigh it against everything
 *    else in the message).
 *  - deterministic sender pre-filter (classifySender) before any model call.
 *  - per-thread draft dedup (hasDraftForThread) so a second inbound message on an
 *    already-drafted thread does not draft again.
 *  - voice-matched draft (voice.ts/voice-store.ts, ORB-75's shared port), real Gmail
 *    signature appended, proper In-Reply-To/References threading.
 *  - context gathering SIMPLIFIED from the old workflow: CRM lookup (twentyLookup) and
 *    calendar busy windows are included (both best-effort — a failed read never blocks the
 *    draft); network-history and Brain-notes lookups are NOT ported for this v1 (lower
 *    value for a one-shot triage reply, and neither has a ready eve-saga equivalent to call
 *    without its own scoping pass) — flagged here rather than silently dropped.
 *  - booking-link injection dropped, per the approved plan (no eve-saga config for it yet).
 */
import { classifySender } from "@lares/junk";
import { gatewayComplete } from "./llm-complete.js";
import { detectLanguage, buildVoiceBlock, pickModel } from "./voice.js";
import { buildReplyPrompt } from "./reply-prompt.js";
import { replyRecipients } from "./reply-recipients.js";
import { labeledContext } from "@lares/compose-contract";
import { twentyLookup } from "../catalogue/twenty_lookup.js";
import { detectProposedWindow, type ProposedWindow } from "./proposed-time.js";
import type { VoiceAccess } from "./voice-store.js";
import type { MailMessage, GmailClient, ThreadMessage } from "./google.js";

/** The address inside "Name <email>", lowercased — same three-line helper as
 *  outreach-reply-detect.ts's addressOf, not worth a shared import (ORB-92). */
function addressOf(header: string): string {
  const m = /<([^>]+)>/.exec(header);
  return (m?.[1] ?? header).trim().toLowerCase();
}

/** ORB-176 — how each context block fared for one draft: read and non-empty, read but empty,
 *  the read threw (soft-failed through `tryOrNull`), or never attempted. Recorded on the
 *  drafted result and in one log line, so a draft judged thin can be traced to its cause —
 *  before this, an empty CRM record and an unreachable CRM looked identical. */
export type ContextStatus = "ok" | "empty" | "failed" | "skipped";

export type TriageResult =
  | { outcome: "automated"; reason: "calendar-notice" | "automated-sender" | "model"; from: string; subject: string }
  | { outcome: "fyi"; from: string; subject: string }
  | { outcome: "drafted"; from: string; subject: string; account: string; context?: Record<string, ContextStatus>;
      /** The Gmail draft just created (sql/034 remembers it so its recipients can be changed later). */
      draftId?: string; threadId?: string }
  | { outcome: "draft-pending"; from: string; subject: string; account: string };

export interface EmailTriageDeps {
  gmail: GmailClient;
  voice: VoiceAccess;
  /** The member's own addresses (identity-registry email aliases + the enrolled mailboxes) —
   *  removed from a reply's recipients. Defaults to the account alone (lib/reply-recipients.ts). */
  selfEmails?: readonly string[];
  /** Bounded person-360 text for the counterpart (`renderDossier(d, { bounded: true })` is the
   *  caller's job — ORB-147 Task 3 only consumes the rendered text). Optional so every
   *  existing caller/test keeps constructing deps unchanged; best-effort. Text is passed
   *  through verbatim, including any "COULD NOT READ" markers — a gap in OUR reading is not
   *  an absence in the world. */
  dossier?: (email: string) => Promise<string | null>;
  /** Busy blocks for a window. Called ONLY when the inbound message proposes a time
   *  (`detectProposedWindow`) — otherwise the calendar is never touched. Best-effort. */
  freeBusy?: (o: { timeMin: string; timeMax: string }) => Promise<Array<{ start: string; end: string }>>;
  /** What `freeBusy` actually checks, e.g. "owner@owner.example's primary calendar" — threaded
   *  into `renderBusyBlock`'s rendered text (ORB-147 review, Important finding 2). Optional so
   *  every existing caller/test keeps constructing deps unchanged; when omitted the rendered
   *  text falls back to the generic "availability" wording it always had. The live wiring's
   *  `freeBusy` resolves exactly ONE calendar of the TWO enrolled Google accounts (the
   *  env-pinned `CALENDAR_PRIMARY_EMAIL`, `lib/google.ts`'s `resolveCalendarApi`) — without
   *  this label, "no conflicts" reads as a universal claim when it is really a claim about one
   *  calendar out of two. */
  calendarLabel?: string;
  /** Injected clock, default `() => new Date()`. eve injects no ambient clock into agents —
   *  every computed date is a guess without one (see proposed-time.ts's header) — so no bare
   *  `new Date()` appears in the logic below. */
  now?: () => Date;
}

/**
 * Splits a "Subject: <s>\n\n<body>" completion into its parts. ORB-92: anchored to the START
 * of the output — the old unanchored regex would happily match a "Subject:" line buried
 * inside a quoted original (the model echoing back context despite being told not to),
 * discarding everything before it and mixing the quoted subject into what should have been
 * the real reply. Anchoring means a draft that doesn't lead with "Subject:" falls straight to
 * the fallback instead of guessing at a match further in. The fallback itself is now useful
 * rather than a dead-end: `fallbackSubject` (the ORIGINAL email's subject, when the caller has
 * it) becomes "Re: <original>" instead of the opaque "(no subject)", and the whole completion
 * is kept as the body rather than silently discarded.
 */
export function splitDraft(draft: string, fallbackSubject?: string): { subject: string; body: string } {
  const m = /^Subject:\s*(.*?)\r?\n\r?\n([\s\S]*)$/i.exec(draft.trim());
  if (m) return { subject: m[1]!.trim(), body: m[2]!.trim() };
  const subject = fallbackSubject ? `Re: ${fallbackSubject.replace(/^Re:\s*/i, "").trim()}` : "(no subject)";
  return { subject, body: draft.trim() };
}

/** True if `account` (the mailbox owner) already sent a message on this thread strictly
 *  after `sentAfter` — Bendik replied manually already, most likely while this schedule was
 *  down. A backfill/outage replay must not re-draft (or re-notify about) a thread that's
 *  already handled (ORB-92). */
export function hasHumanReplyAfter(messages: ThreadMessage[], account: string, sentAfter: string): boolean {
  const mine = account.toLowerCase();
  const after = Date.parse(sentAfter);
  return messages.some((m) => addressOf(m.from) === mine && Date.parse(m.sentAt) > after);
}

/** Best-effort: a failed/denied context read must not abort the draft — but it must be SEEN
 *  (ORB-176): the caller passes `onFail`, which marks the block failed and logs the reason. */
async function tryOrNull<T>(fn: () => Promise<T>, onFail?: (err: unknown) => void): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    onFail?.(err);
    return null;
  }
}

/** A short excerpt for the sent-history block — enough to recognize the message, not a
 *  full re-quote. */
function excerpt(text: string, max = 200): string {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Total-character ceiling on the rendered thread block. Email bodies routinely re-quote the
// whole prior thread, so an uncapped block grows roughly quadratically with thread length —
// this file already lives in the shadow of the August cost leak
// (docs/solutions/2026-08-15-api-cost-leak-proposal-retry-loop.md), and "always in full" in
// the plan was about not date-slicing the thread, not about accepting unbounded billed input.
// 8000 chars (~2000 tokens) is generously above BODY_CHARS_FOR_CLASSIFY (6000, digest/types.ts)
// and DEFAULT_MAX_CHARS (1500, dream/context.ts) — it covers the large majority of real threads
// in full while still being a real ceiling, not a nominal one.
const THREAD_BLOCK_MAX_CHARS = 8000;

/** The rest of the thread, oldest-first, excluding the message being replied to. Keeps the
 *  NEWEST messages — the most relevant to a reply — dropping the oldest ones once the total
 *  exceeds THREAD_BLOCK_MAX_CHARS, and always keeps at least the single newest message even
 *  if it alone exceeds the cap. A dropped run is never silent: the empty-vs-missing doctrine
 *  (absentBlockClause, @lares/compose-contract) applies to truncation too — the model must be
 *  told something was cut, not handed a partial thread that reads as the whole one. */
function renderThreadContext(thread: ThreadMessage[], currentId: string): string {
  const sorted = [...thread]
    .filter((m) => m.id !== currentId)
    .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));

  const kept: string[] = [];
  let total = 0;
  let droppedCount = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const m = sorted[i]!;
    const rendered = `${m.sentAt} — ${m.from}: ${m.subject}\n${m.bodyText}`;
    if (total + rendered.length > THREAD_BLOCK_MAX_CHARS && kept.length > 0) {
      droppedCount = i + 1;
      break;
    }
    kept.unshift(rendered);
    total += rendered.length;
  }

  const marker = droppedCount > 0 ? [`…${droppedCount} earlier message(s) omitted`] : [];
  return [...marker, ...kept].join("\n\n");
}

/** What the account sent this counterpart in the last 30 days — subject/date/short excerpt,
 *  so the drafter can see an artefact it already delivered instead of promising it again
 *  (ORB-147 Task 3 — the Stefan case). Excludes messages already in the CURRENT thread — the
 *  thread block above already carries those in full, so repeating them here is duplicate
 *  content that only spends tokens. */
function renderSentHistory(msgs: MailMessage[]): string {
  return msgs.map((m) => `${m.sentAt} — "${m.subject}": ${excerpt(m.bodyText)}`).join("\n");
}

/** The returned busy blocks for the detected window.
 *
 *  `busy === null` means the read never happened at all — no window was proposed, no
 *  `freeBusy` dep was wired, or the fetch failed — and renders as "", the correct rendering
 *  for a claim that was never earned (same empty-vs-missing doctrine as absentBlockClause,
 *  @lares/compose-contract:140-152).
 *
 *  `busy` as an EMPTY ARRAY is a different thing entirely: the read succeeded and found no
 *  conflicts. Collapsing that into the same "" as the null case was the bug — the one fact
 *  this fetch exists to establish (conflict vs. no conflict) would only ever reach the prompt
 *  on the conflict half, so a successful clear check looked byte-identical to a fetch that
 *  never ran (the ORB-119 shape: a fetched fact and a failure rendering the same way).
 *
 *  `calendarLabel` (ORB-147 review, Important finding 2) names what was actually checked —
 *  the live wiring only ever reads ONE calendar of the TWO Google accounts enrolled, and
 *  "Checked availability" without it reads as a claim about all of them. Falls back to the
 *  old generic wording when omitted, so a caller/test with no label keeps working unchanged. */
function renderBusyBlock(
  busy: Array<{ start: string; end: string }> | null,
  window: ProposedWindow | null,
  calendarLabel?: string,
): string {
  if (busy === null) return "";
  const checked = calendarLabel ? `${calendarLabel} for` : "availability for";
  if (busy.length === 0) return window ? `Checked ${checked} ${window.label}: no conflicts.` : "";
  const lines = busy.map((b) => `Busy: ${b.start} – ${b.end}`);
  return window ? `Checked ${checked} ${window.label}:\n${lines.join("\n")}` : lines.join("\n");
}

export async function triageOneMessage(
  deps: EmailTriageDeps,
  account: string,
  msg: MailMessage,
  thread: ThreadMessage[] = [],
): Promise<TriageResult> {
  const { from, subject, bodyText: body, threadId, isCalendarNotice, messageId: origMessageId, references: origReferences } = msg;

  // Calendar-notice guard FIRST — see module header.
  if (isCalendarNotice) return { outcome: "automated", reason: "calendar-notice", from, subject };

  // Deterministic sender pre-filter — closes the "drafted a reply to a newsletter" incident.
  if (classifySender(from) === "automated") return { outcome: "automated", reason: "automated-sender", from, subject };

  const raw = (await gatewayComplete(
    `Classify this inbound email as one of: needs_reply | fyi | automated.\n` +
    `"automated" = newsletters, no-reply, receipts, notifications. "fyi" = a human message that needs no reply. ` +
    `"needs_reply" = a human who expects a response.\n` +
    `Answer with ONLY that one word — no explanation.\n\n` +
    `From: ${from}\nSubject: ${subject}\n\n${body}`,
    { maxOutputTokens: 16 },
  )).toLowerCase();
  const matched = raw.match(/needs_reply|automated|fyi/);
  const triage = matched ? matched[0] : "fyi";
  if (triage !== "needs_reply") {
    return triage === "automated" ? { outcome: "automated", reason: "model", from, subject } : { outcome: "fyi", from, subject };
  }

  // Per-thread dedup FIRST — a second inbound message on an already-drafted thread advances
  // as draft-pending (still worth a reminder ping) rather than drafting again.
  if (await deps.gmail.hasDraftForThread(threadId)) {
    return { outcome: "draft-pending", from, subject, account };
  }

  const lang = detectLanguage(body || subject);
  const references = [origReferences, origMessageId].filter(Boolean).join(" ").trim();
  const addr = addressOf(from);
  const clockNow = (deps.now ?? (() => new Date()))();
  // Conservative by design (see proposed-time.ts's header) — a miss costs nothing, so the
  // calendar is genuinely never touched unless this actually finds a proposed time.
  const proposedWindow = detectProposedWindow(body, clockNow);

  // Independent, best-effort context fetches — none depends on another's result, so they run
  // concurrently (ORB-92 efficiency finding: these used to be sequential awaits). Each is
  // best-effort: a hiccup on any one must never fail the draft. ORB-147 Task 3 adds
  // sent-history, dossier, and free/busy to the original four — still exactly one billed
  // model call per message (these are tool reads, not gatewayComplete calls); the thread
  // block itself costs no fetch at all (rendered synchronously below from the `thread` param
  // already in hand).
  // ORB-176 — every soft failure is named, once, with its reason, and the block is marked
  // `failed` in the context report below. Silent `null`s made a thin draft undiagnosable.
  const failed = new Set<string>();
  const failing = (label: string) => (err: unknown) => {
    failed.add(label);
    console.error(`email-triage: context "${label}" failed for ${msg.id} — ${err instanceof Error ? err.message : String(err)}`);
  };
  const [profile, examples, sig, crm, sentHistoryMsgs, dossierText, busy] = await Promise.all([
    tryOrNull(() => deps.voice.getProfile(), failing("Voice profile")),
    // NOT tryOrNull: an unreachable corpus and an empty one both yield [] here, and for six
    // weeks that silence hid a 401 on every embedding call (ORB-119). The draft still
    // proceeds without examples — they are grounding, not a dependency — but the reason is
    // logged rather than swallowed.
    deps.voice.retrieve(`reply to: ${body}`, 3, lang).catch((err: unknown) => {
      failed.add("Voice examples");
      console.error(`email-triage: voice examples unavailable for ${account} — drafting from the card alone`, err);
      return [] as string[];
    }),
    tryOrNull(() => deps.gmail.getSignature(account), failing("Signature")),
    // twentyLookup needs the bare address — `from` is the raw "Name <email>" header, and a
    // CRM email-equality match against the whole header string never matches anything,
    // leaving grounding silently empty in every draft (ORB-92).
    tryOrNull(() => twentyLookup(addr), failing("CRM record")),
    // Small cap (3), 30-day window — enough to catch a recently-sent artefact without turning
    // into a full mailbox scan. Excludes the CURRENT thread — that's already rendered in full
    // by the thread block above, so a match there would just duplicate content and tokens.
    tryOrNull(async () => {
      const ids = await deps.gmail.search(`to:${addr} from:me newer_than:30d`, 3);
      const msgs = await Promise.all(ids.map((id) => deps.gmail.read(id)));
      return msgs.filter((m): m is MailMessage => m !== null && m.threadId !== threadId);
    }, failing("Sent history (last 30 days)")),
    deps.dossier ? tryOrNull(() => deps.dossier!(addr), failing("Person")) : Promise.resolve(null),
    // The calendar is touched ONLY when a window was actually detected AND a freeBusy fetch
    // is wired — never speculatively.
    proposedWindow && deps.freeBusy ? tryOrNull(() => deps.freeBusy!(proposedWindow), failing("Calendar")) : Promise.resolve(null),
  ]);
  const voiceBlock = buildVoiceBlock(profile, lang);
  const model = pickModel(profile, lang, undefined);
  const signatureHtml = sig ?? "";

  const asJson = (v: unknown): string => (v == null ? "" : JSON.stringify(v));
  const contextBlocks = labeledContext([
    { label: "CRM record", content: asJson(crm) },
    { label: "Thread so far", content: renderThreadContext(thread, msg.id) },
    { label: "Sent history (last 30 days)", content: sentHistoryMsgs ? renderSentHistory(sentHistoryMsgs) : "" },
    // ORB-147 review, Important finding 1: renderDossier is authored as a tool result for
    // Saga-the-conversationalist talking to Bendik — even the RESOLVED branch this text is
    // gated to still carries clauses like "mention this in one clause so he knows a choice
    // was made" and "say so in those terms" that are instructions to a DIFFERENT assistant,
    // not facts about the counterpart. The note is the mitigation; cleaning render.ts's own
    // clauses is a follow-up (a drafting-mode option on renderDossier), out of scope here.
    {
      label: "Person",
      content: dossierText ?? "",
      note: "internal notes written for a different assistant, not for this reply — never quote it, and never name the CRM, its sources, or any tool to the counterpart; take only the plain facts as background",
    },
    // ORB-147 review, Important finding 2: the live wiring's freeBusy checks exactly ONE
    // calendar of the TWO Google accounts enrolled, and only when a time was actually
    // detected in the inbound message — a detector that is itself loose enough to fire on a
    // past reference ("jeg sendte den på mandag"). The note scopes the claim on both axes so
    // an unsolicited or over-generalized availability claim never reaches the counterpart.
    {
      label: "Calendar",
      content: renderBusyBlock(busy, proposedWindow, deps.calendarLabel),
      note: "one calendar of two enrolled accounts, checked only because a time was proposed — never volunteer availability nobody asked about",
    },
  ]);

  // ORB-176 — the context report. Judged on what actually reached the prompt: a block that
  // rendered to nothing is `empty` even when its read succeeded, and a CRM answer with nobody
  // in it is `empty`, not `ok`. `skipped` is a block that was never attempted (no dossier
  // wired, no proposed time) — a different fact from `empty`, and the one most often mistaken
  // for it. Returned on the result and logged as ONE line, reasons already logged above.
  const status = (label: string, attempted: boolean, hasContent: boolean): ContextStatus =>
    failed.has(label) ? "failed" : !attempted ? "skipped" : hasContent ? "ok" : "empty";
  const crmPeople = (crm as { people?: unknown[]; companies?: unknown[] } | null)?.people?.length ?? 0;
  const crmCompanies = (crm as { people?: unknown[]; companies?: unknown[] } | null)?.companies?.length ?? 0;
  const context: Record<string, ContextStatus> = {
    "CRM record": status("CRM record", true, crmPeople + crmCompanies > 0),
    "Thread so far": status("Thread so far", true, renderThreadContext(thread, msg.id).trim() !== ""),
    "Sent history (last 30 days)": status("Sent history (last 30 days)", true, (sentHistoryMsgs?.length ?? 0) > 0),
    Person: status("Person", deps.dossier !== undefined, (dossierText ?? "").trim() !== ""),
    Calendar: status("Calendar", Boolean(proposedWindow && deps.freeBusy), renderBusyBlock(busy, proposedWindow, deps.calendarLabel).trim() !== ""),
    "Voice profile": status("Voice profile", true, profile !== null),
    "Voice examples": status("Voice examples", true, examples.length > 0),
  };
  console.info(
    `email-triage: context for ${msg.id} (${addr}): ${Object.entries(context).map(([k, v]) => `${k}=${v}`).join(", ")}`,
  );

  const closing = signatureHtml
    ? `Do NOT write any closing line or sign-off (no "Mvh", no name) — the mailbox signature is appended automatically after your text. End with your final sentence.`
    : `End with a short, warm closing and your first name only (e.g. "Mvh, Bendik" or "Best, Bendik"). Do NOT invent a phone number, links, or a full signature block.`;

  // ORB-176: the one reply prompt both drafters share (lib/reply-prompt.ts) — examples first,
  // no brevity rule, contract verbatim, exact return-format line.
  const draft = await gatewayComplete(
    buildReplyPrompt({
      account, lang, voiceBlock, examples, contextBlocks: contextBlocks ?? "", closing,
      original: { from, subject, body },
    }),
    { model, purpose: "writer" },
  );
  const { subject: replySubject, body: replyBody } = splitDraft(draft, subject);

  // 2026-09-08: everyone on the original — sender first, other To recipients, Cc kept — minus
  // the member's own addresses. Bendik edits the list in Gmail or by telling Saga.
  const recipients = replyRecipients(msg, deps.selfEmails ?? [account]);
  const created = await deps.gmail.draft({
    account, from: account, to: recipients.to, cc: recipients.cc, subject: replySubject, bodyText: replyBody, threadId,
    ...(origMessageId ? { inReplyTo: origMessageId } : {}),
    ...(references ? { references } : {}),
    ...(signatureHtml ? { signatureHtml } : {}),
  });

  return { outcome: "drafted", from, subject: replySubject, account, context , draftId: created.gmailDraftId, threadId: created.gmailThreadId || threadId };
}

/** Sends the informational Slack ping for a completed triage — matches the old workflow's
 *  wording, split out so the schedule can call it after recordOutcome. */
export function notifyTextFor(result: TriageResult): string | null {
  if (result.outcome === "drafted") {
    return `✍️ Drafted a reply to ${result.from} re "${result.subject}" in ${result.account} — review in Gmail.`;
  }
  if (result.outcome === "draft-pending") {
    return `✍️ Draft already pending for ${result.from} re "${result.subject}" in ${result.account} — review in Gmail.`;
  }
  return null;
}
