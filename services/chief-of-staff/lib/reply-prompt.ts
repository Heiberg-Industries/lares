/**
 * The ONE reply prompt both drafters use — email-triage (inbound replies) and
 * outreach-reply-triage (replies to Bendik's own outreach). ORB-176, 2026-09-08.
 *
 * Written for a thinking writer (the `writer` purpose — Fable 5.1 via the gateway since
 * ORB-225). What changed and why:
 *
 *  - **No brevity rule.** "Write a brief, warm, specific reply" produced 130–650 tokens of text
 *    on 2026-09-07 and read as thin next to the same person's real mail. Length now comes from
 *    the examples — Bendik's own sent mail from THIS mailbox — not from an adjective.
 *  - **Examples first, guide second.** His sent mail is the strongest evidence of how he writes;
 *    the distilled bullet list (`voiceBlock`) is a summary of it and must not outrank it. On a
 *    thinking model a prescriptive list written for an earlier model tends to lower quality.
 *  - **The compose contract stays verbatim** (language, no invented commitments) — shared law
 *    across every drafter in the fleet.
 *  - **The return-format line stays exact** — `splitDraft` parses it.
 *
 * Pure: no I/O, no model call. Both drafters gather their own context and pass it in.
 */
import { contractClauses, type Lang } from "@lares/compose-contract";

export interface ReplyPromptInput {
  /** The mailbox the reply is sent from. */
  account: string;
  lang: Lang;
  /** `buildVoiceBlock(...)` output — "" when there is no card. */
  voiceBlock: string;
  /** Bendik's own sent emails from this mailbox, nearest first. */
  examples: readonly string[];
  /** Labelled context blocks (CRM record, thread so far, dossier…) — "" when none. */
  contextBlocks: string;
  /** The closing rule the caller owns (signature appended vs. first-name sign-off). */
  closing: string;
  original: { from: string; subject: string; body: string };
  /** Caller-specific rules, verbatim (e.g. outreach: never invent a phone number). */
  extraRules?: readonly string[];
}

export const REPLY_FORMAT_LINE =
  'Return ONLY the reply in exactly: "Subject: <subject>\\n\\n<body>" — no commentary, no placeholders like "[Name]".';

export function buildReplyPrompt(i: ReplyPromptInput): string {
  const examples =
    i.examples.length > 0
      ? `Emails Bendik actually sent from this mailbox. Match their length, register and warmth — not their words:\n${i.examples.join("\n---\n")}`
      : "";
  const context = i.contextBlocks.trim() !== "" ? `Context — use only what helps, never invent a fact:\n${i.contextBlocks.trim()}` : "";
  return [
    `Write Bendik's reply to the email below, sent from ${i.account}.`,
    contractClauses({ lang: i.lang, noCommitments: true }),
    examples,
    i.voiceBlock,
    context,
    ...(i.extraRules ?? []),
    i.closing,
    `Original — From: ${i.original.from}\nSubject: ${i.original.subject}\n\n${i.original.body}`,
    REPLY_FORMAT_LINE,
  ]
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .join("\n\n");
}
