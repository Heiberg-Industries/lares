/**
 * Junk-contact classifier for the commercial radar.
 *
 * Twenty's email + calendar integration auto-creates a Person for every address it sees in
 * the connected mailbox — including booking confirmations, generic inboxes, and no-reply
 * senders. These pass a `!doNotContact`-only filter on recency alone, surfacing as
 * "Reservation", "Office", "Hello Charlottenburg", "Contact", etc.
 *
 * Ported verbatim from `services/agent-runtime/lib/commercial/junk.ts`. The email-shape
 * check (`isJunkEmail`) lives in the shared `@lares/junk` workspace package (ADR-0007), the
 * same dependency `services/network` and `services/agent-runtime` already use — eve-saga
 * picks up the same package rather than re-deriving the regexes.
 *
 * Pure, no I/O. Deliberately conservative: junk ONLY when ALL hold —
 *   1. the email looks transactional/generic, OR the email is missing AND the display name
 *      itself is a generic single-word or "hello "/"hei "-prefixed name
 *   2. the record was auto-synced (source EMAIL/CALENDAR), or source is null AND the email
 *      is junky (null-with-junk-email — sync source not always recorded)
 *   3. no curation signal: no LinkedIn, no phone
 *
 * A curated person (has a phone or LinkedIn, or was added MANUALly) is never junk, even if
 * their name or email looks generic.
 */
import { isJunkEmail } from "@lares/junk";
import type { TwentyPerson } from "../twenty-people.js";

const JUNK_NAME_WORD =
  /^(reservation|resepsjon|office|contact|kontakt|info|booking|reception|resepsjonist|support|admin|team|sales|salg|hr|newsletter|nyhetsbrev)$/i;
const JUNK_NAME_GREETING = /^(hello|hei)\s+/i;

function isJunkName(name: string | null | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (JUNK_NAME_WORD.test(trimmed)) return true;
  if (JUNK_NAME_GREETING.test(trimmed)) return true;
  return false;
}

/** The subset of TwentyPerson fields the classifier reads. */
export type JunkCandidate = Pick<TwentyPerson, "name" | "email" | "source" | "hasLinkedin" | "hasPhone">;

export function isJunkContact(p: JunkCandidate): boolean {
  const emailJunky = isJunkEmail(p.email);

  // Condition 1: junky email, OR (no email AND the name alone is a generic placeholder).
  const looksJunk = emailJunky || (!p.email && isJunkName(p.name));
  if (!looksJunk) return false;

  // Condition 2: auto-synced source, or unknown source with a junky email.
  const autoSynced = p.source === "EMAIL" || p.source === "CALENDAR";
  const nullSourceJunkEmail = p.source === null && emailJunky;
  if (!autoSynced && !nullSourceJunkEmail) return false;

  // Condition 3: no curation signal.
  const curated = p.hasLinkedin || p.hasPhone;
  if (curated) return false;

  return true;
}
