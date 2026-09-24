/**
 * One-tap proposal resolution on Telegram — the old runtime's `np:a:`/`ap:r:` inline
 * buttons, restored (Bendik, 2026-08-16 flip day: the announce-then-gate flow asked him to
 * approve twice; the old door was one tap).
 *
 * Three deliberate properties:
 *
 * 1. **The announcement is deterministic text, not an agent turn.** No billed model call
 *    per announcement, byte-stable wording, and each proposal gets ITS OWN message so its
 *    buttons are unambiguous. The consequence sentence is quoted from
 *    `lib/proposals-store.ts`'s single source of truth, same as every other surface.
 *
 * 2. **A button tap is IDENTITY-VERIFIED, unlike eve's HITL cards.** eve resumes HITL taps
 *    with `auth: null`, but a custom `callback_query` carries `from.id`, and eve's Telegram
 *    channel hands non-HITL callbacks to the authored `onCallbackQuery` — so this path
 *    checks the actual tapper against the Telegram allowlist (`lib/principals.ts`),
 *    fail-closed. That makes the direct resolve here STRONGER than the gated-tool card it
 *    replaces for this surface. The gated `*_resolve_proposal` tools remain for
 *    conversational resolutions ("approve that one from yesterday").
 *
 * 3. **A tap resolves at most once.** `resolveProposal`/`resolveAtlasProposal` are atomic
 *    (they throw when the row is no longer open), so a double-tap or a tap on a
 *    conversationally-resolved proposal answers "already resolved" and changes nothing.
 */
import {
  type ProposalRow,
  type AtlasUnannouncedRow,
  type MemoryProposalRow,
  type ProposalAction,
  approveConsequence,
  rejectConsequence,
  atlasApproveConsequence,
  atlasRejectConsequence,
  memoryApproveConsequence,
  memoryRejectConsequence,
} from "./proposals-store.js";
import { isAllowedPrincipalId } from "./principals.js";
import { escapeTelegramHtml } from "@lares/agent-kit/telegram-markdown";

export type ProposalLane = "np" | "ap";

export interface ProposalCallback {
  lane: ProposalLane;
  action: ProposalAction;
  id: number;
}

/** The old runtime's exact callback convention: `np:a:61`, `ap:r:7`. */
const CALLBACK_RE = /^(np|ap):(a|r):(\d+)$/;

export function proposalCallbackData(lane: ProposalLane, action: ProposalAction, id: number): string {
  return `${lane}:${action === "approve" ? "a" : "r"}:${id}`;
}

export function parseProposalCallback(data: string | undefined): ProposalCallback | undefined {
  if (!data) return undefined;
  const m = CALLBACK_RE.exec(data);
  if (!m) return undefined;
  return {
    lane: m[1] as ProposalLane,
    action: m[2] === "a" ? "approve" : "reject",
    id: Number(m[3]),
  };
}

export interface Announcement {
  text: string;
  parseMode: "HTML";
  /** Telegram `reply_markup` — one row, Approve then Reject. */
  replyMarkup: Readonly<Record<string, unknown>>;
}

const PREVIEW_CHARACTER_LIMIT = 2_500;

function cappedPreview(preview: string): string {
  const lines = preview.split("\n");
  if (escapeTelegramHtml(preview).length <= PREVIEW_CHARACTER_LIMIT) return preview;

  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const addedLength = escapeTelegramHtml(line).length + (kept.length === 0 ? 0 : 1);
    if (length + addedLength > PREVIEW_CHARACTER_LIMIT) break;
    kept.push(line);
    length += addedLength;
  }

  const omitted = lines.length - kept.length;
  return `${kept.join("\n")}\n… (${omitted} more ${omitted === 1 ? "line" : "lines"})`;
}

function previewSection(label: string, preview: string): string[] {
  return preview.trim().length === 0
    ? ["Preview: no preview stored for this proposal."]
    : [`${label}:`, cappedPreview(preview)];
}

function buttons(lane: ProposalLane, id: number): Readonly<Record<string, unknown>> {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: proposalCallbackData(lane, "approve", id) },
        { text: "✖️ Reject", callback_data: proposalCallbackData(lane, "reject", id) },
      ],
    ],
  };
}

export function buildNotionAnnouncement(row: ProposalRow): Announcement {
  const what =
    row.kind === "create"
      ? `NEW FILE: ${row.vaultPath}`
      : `edit to ${row.vaultPath}`;
  const preview = row.kind === "create" && row.diffPreview.trim().length === 0
    ? previewSection("Proposed file content", row.proposedBody)
    : previewSection(row.kind === "create" ? "Proposed file content" : "Diff", row.diffPreview);
  return {
    text: escapeTelegramHtml([
      `Notion proposal #${row.id} — ${what}.`,
      "",
      ...preview,
      "",
      `Approve → ${approveConsequence(row)}.`,
      `Reject → ${rejectConsequence(row)}.`,
    ].join("\n")),
    parseMode: "HTML",
    replyMarkup: buttons("np", row.id),
  };
}

export function buildAtlasAnnouncement(row: AtlasUnannouncedRow): Announcement {
  const brand = row.brand ? ` (${row.brand})` : "";
  return {
    text: escapeTelegramHtml([
      `Atlas proposal #${row.id} — re-derived narrative for ${row.notePath}${brand}.`,
      "",
      ...previewSection("Diff", row.diffPreview),
      "",
      `Approve → ${atlasApproveConsequence()}.`,
      `Reject → ${atlasRejectConsequence()}.`,
    ].join("\n")),
    parseMode: "HTML",
    replyMarkup: buttons("ap", row.id),
  };
}

/**
 * The memory lane's announcement — DELIBERATELY WITHOUT BUTTONS (W4C-s5).
 *
 * The two lanes above resolve on a tap, because a tap is enough: approving a Notion or Atlas
 * proposal hands the row to a sync engine that applies it on its own tick. A memory proposal has
 * no such engine. The only thing that applies one is `catalogue/memory_resolve_proposal.ts`,
 * which re-reads the row inside the transaction that writes and refuses if the preference has
 * moved since. A ✅ button here would set the row to `approved` and leave it there forever — an
 * owner who answered a question that never took effect, which is worse than one more message.
 *
 * So this message CARRIES THE WHOLE DECISION instead: for a supersede or retire, what is
 * standing now and what would replace it; for an `add`, what the agent noticed on its own —
 * plus both consequence sentences either way, every word of it read off the stored row. The
 * owner replies in words, the agent calls the gated tool, and the card is the last step.
 *
 * Role-neutral: "the owner", never a name.
 */
export function buildMemoryAnnouncement(row: MemoryProposalRow): Announcement {
  // `add` is a THIRD kind of proposal, not a variant of the other two: there is no standing row
  // to replace, so it must not read as one — no "Standing now", no "replace". It is the agent's
  // own inference, held for the owner's confirmation before it becomes anything (ADR-0018 rule
  // 4), so the framing says that plainly instead of the supersede/retire wording.
  const introLines =
    row.action === "add"
      ? [
          "Something I worked out for myself while reviewing our conversations. I am not allowed",
          "to keep it on my own, so nothing has happened yet.",
        ]
      : [
          "A nightly run believes something the owner told me has changed. It is not allowed to",
          "replace that on its own, so nothing has happened yet.",
        ];
  const what =
    row.action === "add"
      ? [`I noticed: ${row.proposedText}`]
      : row.action === "supersede"
        ? [
            `Standing now: ${row.existingText}`,
            `Would become: ${row.proposedText}`,
          ]
        : [`Standing now: ${row.existingText}`, "Would stop applying, with nothing in its place."];
  return {
    text: escapeTelegramHtml(
      [
        `Memory change #${row.id}${row.subject ? ` — ${row.subject}` : ""}.`,
        "",
        ...introLines,
        "",
        ...what,
        "",
        `Approve → ${memoryApproveConsequence(row)}.`,
        `Reject → ${memoryRejectConsequence(row)}.`,
        "",
        "Reply with approve or reject and I will put the card up.",
      ].join("\n"),
    ),
    parseMode: "HTML",
    // No inline keyboard: see this function's header. An empty keyboard is what Telegram reads
    // as "no buttons", and keeps the Announcement shape the door already takes.
    replyMarkup: { inline_keyboard: [] },
  };
}

// ─── Callback handling ──────────────────────────────────────────────────────────────────

/** The slice of eve's normalized TelegramCallbackQuery this handler needs (`from.id` and
 *  chat/message ids arrive as strings from eve's inbound normalization; numbers are
 *  accepted too so tests and raw payloads both fit). */
export interface ProposalCallbackQuery {
  id: string;
  from?: { id: string | number };
  data?: string;
  message?: { messageId: string | number; chat: { id: string | number } };
}

export interface ProposalCallbackDeps {
  /** Atomic resolves — throw when the proposal is not open. */
  resolveNotion(id: number, action: ProposalAction): Promise<void>;
  resolveAtlas(id: number, action: ProposalAction): Promise<void>;
  /** `answerCallbackQuery` — clears the client spinner, shows `text` as a toast. */
  answer(callbackQueryId: string, text: string): Promise<void>;
  /** Strip the buttons off the announcement so a resolved proposal cannot be re-tapped. */
  removeButtons(chatId: string | number, messageId: string | number): Promise<void>;
  /** Permanent outcome line, sent into the chat under the announcement. */
  confirm(chatId: string | number, text: string): Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export type ProposalCallbackOutcome =
  | "not-a-proposal-callback"
  | "refused-unknown-tapper"
  | "resolved"
  | "already-resolved";

/**
 * Handles one callback query. Returns what happened so the channel's `onCallbackQuery` can
 * fall through to a default answer for non-proposal callbacks.
 */
export async function handleProposalCallback(
  query: ProposalCallbackQuery,
  deps: ProposalCallbackDeps,
): Promise<ProposalCallbackOutcome> {
  const parsed = parseProposalCallback(query.data);
  if (!parsed) return "not-a-proposal-callback";

  // THE identity check this surface exists for: the tapper, not the session, and
  // fail-closed — an absent from.id refuses like a wrong one.
  const tapper = query.from?.id !== undefined ? String(query.from.id) : undefined;
  if (!isAllowedPrincipalId("telegram", tapper, deps.env ?? process.env)) {
    await deps.answer(query.id, "Not allowed.");
    return "refused-unknown-tapper";
  }

  const resolve = parsed.lane === "np" ? deps.resolveNotion : deps.resolveAtlas;
  const label = `${parsed.lane === "np" ? "Notion" : "Atlas"} proposal #${parsed.id}`;
  try {
    await resolve(parsed.id, parsed.action);
  } catch {
    // resolveProposal's atomicity: not open any more (double-tap, or resolved
    // conversationally through the gated tool in the meantime).
    await deps.answer(query.id, `${label} was already resolved.`);
    return "already-resolved";
  }

  const verb = parsed.action === "approve" ? "✅ Approved" : "✖️ Rejected";
  await deps.answer(query.id, `${verb}.`);
  if (query.message) {
    // Best-effort cosmetics — the resolve above is the real state change; a failure to
    // strip buttons or post the outcome line must not throw back into the channel.
    await deps.removeButtons(query.message.chat.id, query.message.messageId).catch(() => {});
    await deps.confirm(query.message.chat.id, `${verb}: ${label}.`).catch(() => {});
  }
  return "resolved";
}
