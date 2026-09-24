/**
 * Composing a meeting follow-up (ORB-156) — pure. No I/O, no model call, no vendor import.
 *
 * Pure for the same reason notion-sync's attendees.ts is: the rules about what may reach an
 * external's inbox are the part that must be provable without a network. Three of them are
 * load-bearing and all three are enforced here rather than hoped for in a prompt:
 *
 *  1. The raw transcript never appears. It is never read, so it cannot leak.
 *  2. Notion's footnote anchors are stripped. They are deep links into a page externals
 *     cannot open, and a recap full of dead links reads as carelessness.
 *  3. No Notion link at all (spec Q5). The page's own content contains the transcript, so a
 *     shareable link would publish it — the one thing this feature may not do.
 */
import { createHash } from "node:crypto";

import { contractClauses, labeledContext, type Lang } from "@lares/compose-contract";

/**
 * Notion renders a summary bullet's transcript citations as `[^<url>]`, sometimes several per
 * line. Anchored on the `[^http` opening specifically — a generic `\[\^[^\]]*\]` would also
 * eat a legitimate markdown footnote reference someone wrote by hand.
 */
const FOOTNOTE_ANCHOR = /\s*\[\^https?:\/\/[^\]]*\]/g;

export function stripFootnoteAnchors(text: string): string {
  return text.replace(FOOTNOTE_ANCHOR, "").replace(/[ \t]{2,}/g, " ").trim();
}

/** Notion's `Action Items` property is one string with `<br>` between items. */
export function parseActionItems(raw: string): string[] {
  return raw
    .split(/<br\s*\/?>/i)
    .map((line) => stripFootnoteAnchors(line).replace(/^[-*–—]\s*/, "").trim())
    .filter((line) => line !== "");
}

// The name-capture group excludes `<`/`>` so a second bracketed address in the same segment
// (e.g. "Weird <a@x.co> <b@x.co>") can't be swallowed into the name by backtracking — the
// whole segment fails to match instead, and DROPS per the rule above, rather than silently
// keeping the second address while losing the first.
const ATTENDEE = /^\s*([^<>]+?)\s*<([^<>@\s]+@[^<>@\s]+)>\s*$/;

/**
 * Reads the `Name <email>, …` string ORB-155 writes into `Attendees`.
 *
 * An entry that does not match is DROPPED, never half-parsed into a guessed address: a
 * missing recipient is visible on the approval card and a human notices, whereas an invented
 * one puts mail in a stranger's inbox.
 */
export function parseAttendees(raw: string): Array<{ name: string; email: string }> {
  return raw
    .split(",")
    .map((part) => ATTENDEE.exec(part))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[1]!.trim(), email: m[2]!.trim() }));
}

/**
 * One-off follow-ups keep only the SHARED action items (2026-09-08). A one-off intro with an
 * external got the member's full internal action list — "Amalie's fund/PE-partner work",
 * "publisere intern kode" — which reads as his side of the room, not a shared recap. Rule: an
 * item that names only the member (any of `names.self`, on word boundaries, case-insensitive) and
 * none of the recipients is theirs alone and is dropped; an item naming a recipient, or nobody,
 * is shared. Recurring series are NOT filtered — the caller decides; the list is the team's record.
 */
export function filterActionItemsForExternals(items: readonly string[], names: { self: readonly string[]; recipients: readonly string[] }): string[] {
  const mentions = (text: string, name: string): boolean => {
    const n = name.trim();
    if (n === "") return false;
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Unicode-aware word boundaries: a letter on either side means we are inside another word.
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
  };
  return items.filter((item) => {
    const namesSelf = names.self.some((n) => mentions(item, n));
    const namesRecipient = names.recipients.some((n) => mentions(item, n));
    return !(namesSelf && !namesRecipient);
  });
}

export interface FollowupInput {
  title: string;
  whenIso: string;
  /** The page's structured `<meeting-notes><summary>` markdown — NOT the `Summary` property. */
  summaryBlock: string;
  actionItems: string[];
  recipients: string[];
  lang: Lang;
  voiceBlock: string;
}

export interface FollowupDraft {
  subject: string;
  bodyText: string;
}

export function buildFollowupPrompt(input: FollowupInput): string {
  const rules = [
    input.lang === "no"
      ? "Skriv på norsk. Hele e-posten, inkludert emnefeltet."
      : "Write in English. The whole email, including the subject line.",
    "Write as Bendik, to people who were in the meeting with him. Not a report to a stranger.",
    "Two to four sentences of recap, then the action items as a short list. Do NOT write any closing line or sign-off (no \"Mvh\", no name) — the closing is appended automatically after your text. End with your final action item or recap sentence.",
    "Keep every action item listed below. Do not filter them per recipient — the list is already the shared record.",
    "NEVER include a Notion link, a Notion URL, or any reference to Notion. The page holds the " +
      "raw transcript and must not be pointed at.",
    "Never quote the transcript and never attribute a quote to anyone.",
  ].join("\n- ");

  return [
    contractClauses({ lang: input.lang, noCommitments: true, absentBlocks: true }),
    input.voiceBlock,
    labeledContext([
      { label: "Meeting", content: `${input.title} — ${input.whenIso}` },
      { label: "Recipients", content: input.recipients.join(", ") },
      { label: "Summary", content: stripFootnoteAnchors(input.summaryBlock) },
      { label: "Action items", content: input.actionItems.map((a) => `- ${a}`).join("\n") },
    ]),
    `Rules:\n- ${rules}`,
    "Return the email as JSON: {\"subject\": \"…\", \"bodyText\": \"…\"}. No other text.",
  ].join("\n\n");
}

/**
 * ORB-176 — the evidence the follow-up's language SHOULD come from.
 *
 * The founding failure: `detectCounterpartLanguage({ text: row.summaryBlock })` read the
 * meeting note itself — and Notion translates notes, so the Connor follow-up came out in
 * Norwegian for a counterpart every prior email spoke English with. A transcript is evidence
 * of what Notion rendered, never of what the counterpart speaks.
 *
 * This gathers REAL correspondence: Bendik's own prior mail to the recipients (what language
 * he already writes them in is the single best predictor of what he wants written now).
 * Best-effort and bounded — at most `cap` messages across the recipient list, first hits win,
 * every failure degrades to "" so the caller falls back to exactly the old behaviour. Returns
 * the joined bodies, or "" when nothing was found.
 */
export async function priorCorrespondenceText(
  gmail: {
    search(query: string, max: number): Promise<string[]>;
    read(id: string): Promise<{ bodyText?: string } | null>;
  },
  recipients: readonly string[],
  cap = 2,
): Promise<string> {
  const bodies: string[] = [];
  for (const addr of recipients) {
    if (bodies.length >= cap) break;
    try {
      const ids = await gmail.search(`to:${addr} from:me newer_than:180d`, cap - bodies.length);
      for (const id of ids) {
        const msg = await gmail.read(id);
        const body = msg?.bodyText?.trim();
        if (body) bodies.push(body);
        if (bodies.length >= cap) break;
      }
    } catch (err) {
      // Degrade to the transcript, but say so — a silent degrade here re-creates the exact
      // wrong-language failure this function exists to prevent, invisibly.
      console.warn(`meeting-followup: prior-correspondence lookup failed for ${addr} — language will fall back to the meeting note`, err);
    }
  }
  return bodies.join("\n\n");
}

/**
 * Identity of the page's `<meeting-notes><summary>` block AT THIS MOMENT (LAR-28) — the exact
 * text `FollowupInput.summaryBlock` above is composed from, never the `Summary` PROPERTY and
 * never a diff of the `Status` property (`agent/schedules/meeting-followup.ts`'s own module
 * header already explains why this feature does not property-diff).
 *
 * This is the ONE exception to that rule, and it is deliberate: a `denied` or still-`queued`
 * follow-up's claim becomes reclaimable again ONLY when this hash, recomputed from the LIVE page
 * on a later tick, no longer matches the one stored at the last attempt
 * (`lib/meeting-followup-store.ts`'s `claimMeeting`) — which is exactly "Bendik corrected the
 * page", the one signal this feature previously had no way to see. It is not property-diffing:
 * nothing here inspects `Status` or any other Notion property, and an unchanged page (the common
 * case, every five minutes, for as long as a card sits unanswered) still costs nothing beyond the
 * hash comparison already required to read the page at all.
 *
 * Trimmed before hashing so trailing whitespace Notion's markdown renderer adds or removes
 * cannot look like a real edit — the same normalisation `extractSummaryBlock` above already
 * applies to its own return value, repeated here defensively since a hash's whole job is to be
 * exact.
 */
export function hashSummaryBlock(summaryBlock: string): string {
  return createHash("sha256").update(summaryBlock.trim()).digest("hex");
}

/** Stable key for separately-booked standing meetings. Date words in Notion titles are dropped. */
export function derivedSeriesKey(title: string, startsAt: string | undefined): string {
  if (title.trim() === "" || !startsAt) return "";
  const folded: Record<string, string> = { "ø": "o", "æ": "ae", "å": "a", "đ": "d", "ð": "d", "þ": "th", "ß": "ss", "ł": "l" };
  const normalised = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[\u00f8\u00e6\u00e5\u0111\u00f0\u00fe\u00df\u0142]/g, (c) => folded[c]!)
    .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter((word) => !/^\d+$/.test(word)).join(" ");
  const date = startsAt.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (normalised === "" || !date) return "";
  const weekday = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(`${date[1]}-${date[2]}-${date[3]}T00:00:00`).getDay()]!;
  return `title:${normalised}:${weekday}`;
}
