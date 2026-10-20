/**
 * The ONE reply prompt both drafters use — email-triage (inbound replies) and
 * outreach-reply-triage (replies to the owner's own outreach).
 *
 * Written for a thinking writer (the `writer` purpose — Fable 5.1 via the gateway since
 * ). What changed and why:
 *
 *  - **No brevity rule.** "Write a brief, warm, specific reply" produced 130–650 tokens of text
 *    and read as thin next to the same person's real mail. Length now comes from
 *    the examples — the owner's own sent mail from THIS mailbox — not from an adjective.
 *  - **Examples first, guide second.** The owner's sent mail is the strongest evidence of how the owner writes;
 *    the distilled bullet list (`voiceBlock`) is a summary of it and must not outrank it. On a
 *    thinking model a prescriptive list written for an earlier model tends to lower quality.
 *  - **The compose contract stays verbatim** (language, no invented commitments) — shared law
 *    across every drafter in the fleet.
 *  - **The return-format line stays exact** — `splitDraft` parses it.
 *
 * Pure: no I/O, no model call. Both drafters gather their own context and pass it in.
 */
import { contractClauses, labeledContext, type Lang } from "@lares/compose-contract";

export interface ReplyExample {
  text: string;
  toThisPerson: boolean;
}

/** Each example sits in its own tag so one email cannot run into the next. The owner's text is
 *  owner-side, so these stay OUTSIDE the outside-text block; a stray example tag is dropped. */
function exampleGroup(heading: string, items: readonly ReplyExample[]): string {
  if (items.length === 0) return "";
  const body = items.map((e) => `<example>\n${e.text.replace(/<\/?example>/gi, "").trim()}\n</example>`).join("\n");
  return `${heading}\n${body}`;
}

export interface ReplyPromptInput {
  /** The mailbox the reply is sent from. */
  account: string;
  lang: Lang;
  /** `buildVoiceBlock(...)` output — "" when there is no card. */
  voiceBlock: string;
  /** The owner's own sent emails, best first. `toThisPerson` marks mail the owner wrote to the
   *  very person being answered; the rest are topic-nearest mail from the same mailbox. */
  examples: readonly ReplyExample[];
  /** Labelled context blocks (CRM record, thread so far, dossier…) — "" when none. */
  contextBlocks: string;
  /** The closing rule the caller owns (signature appended vs. first-name sign-off). */
  closing: string;
  /** The owner's display name; absent reads as "the owner". */
  ownerName?: string | null;
  original: { from: string; subject: string; body: string };
  /** Caller-specific rules, verbatim (e.g. outreach: never invent a phone number). */
  extraRules?: readonly string[];
}

export const REPLY_FORMAT_LINE =
  'Return ONLY the reply in exactly: "Subject: <subject>\\n\\n<body>" — no commentary, no placeholders like "[Name]".';

export function buildReplyPrompt(i: ReplyPromptInput): string {
  const who = i.ownerName?.trim() || "the owner";
  const match = "Match their length, register and warmth — not their words:";
  const examples = [
    exampleGroup(`Emails ${who} sent to this same person. ${match}`, i.examples.filter((e) => e.toThisPerson)),
    exampleGroup(`Other emails ${who} sent from this mailbox. ${match}`, i.examples.filter((e) => !e.toThisPerson)),
  ]
    .filter((g) => g !== "")
    .join("\n\n");
  const context = i.contextBlocks.trim() !== "" ? `Context — use only what helps, never invent a fact:\n${i.contextBlocks.trim()}` : "";
  return [
    `Write ${who}'s reply to the email below, sent from ${i.account}.`,
    contractClauses({ lang: i.lang, noCommitments: true }),
    examples,
    i.voiceBlock,
    context,
    ...(i.extraRules ?? []),
    i.closing,
    // The mail is somebody else's text: only ever inside a flagged block, never in prose.
    // No blank line inside the block, so the flag sits directly on what it covers.
    labeledContext([
      { label: "Original email", content: `From: ${i.original.from}\nSubject: ${i.original.subject}\n${i.original.body}`, thirdParty: true },
    ]),
    REPLY_FORMAT_LINE,
  ]
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .join("\n\n");
}
