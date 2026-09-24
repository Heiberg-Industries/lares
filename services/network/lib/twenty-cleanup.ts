/**
 * Twenty junk-people classifier.
 *
 * Twenty's email + calendar integration auto-creates a Person for every address
 * it sees in the connected mailbox — including newsletters, order receipts, and
 * no-reply senders. This module finds those so they can be removed, with a
 * deliberately conservative ("very safe") gate:
 *
 *   delete only when ALL hold:
 *     - the address looks transactional (no-reply / newsletter / order / …)
 *       OR comes from a known newsletter/ESP sending domain
 *     - it was auto-created by Twenty's mailbox/calendar sync (source EMAIL/CALENDAR)
 *     - it is NOT the point of contact on any deal, and has NO note or task
 *     - it has NO curation signal: no LinkedIn, no phone, no lares Pulse match,
 *       and was never linked from the local network db (lares push/link)
 *
 * Anything failing one of those is held — never guessed. The CLI prints the full
 * delete list for review and only removes on --apply.
 *
 * The email-shape check (isJunkEmail + its regexes) lives in @lares/junk, shared
 * with the agent-runtime radar's contact classifier (ADR-0007 Task 5). Re-exported
 * here so `../lib/twenty-cleanup.js` stays this module's stable import path.
 */

import { isJunkEmail } from "@lares/junk";

export { isJunkEmail } from "@lares/junk";

/** The minimal person shape the classifier needs (built from the raw Twenty record). */
export type CleanupPerson = {
  id: string;
  firstName: string;
  lastName: string;
  primaryEmail: string | null;
  /** createdBy.source — "EMAIL" / "CALENDAR" / "API" / "MANUAL" / "IMPORT" / … */
  source: string | null;
  hasLinkedin: boolean;
  hasPhone: boolean;
  /** lares Pulse band is set → matched to a real local relationship */
  hasPulse: boolean;
};

export type JunkContext = {
  oppPersonIds: Set<string>;
  notePersonIds: Set<string>;
  taskPersonIds: Set<string>;
  /** Twenty person ids that the local network db links to (lares push/link). */
  laresLinkedIds: Set<string>;
};

export type JunkPerson = { id: string; email: string; name: string };
export type JunkClassification = { junk: JunkPerson[]; protectedByRelationship: number };

export function classifyJunkPeople(people: CleanupPerson[], ctx: JunkContext): JunkClassification {
  const junk: JunkPerson[] = [];
  let protectedByRelationship = 0;

  for (const person of people) {
    if (!isJunkEmail(person.primaryEmail)) continue;
    const autoSynced = person.source === "EMAIL" || person.source === "CALENDAR";
    if (!autoSynced) continue; // deliberately added → never auto-delete

    const hasRelationship =
      ctx.oppPersonIds.has(person.id) || ctx.notePersonIds.has(person.id) || ctx.taskPersonIds.has(person.id);
    const curated =
      person.hasLinkedin || person.hasPhone || person.hasPulse || ctx.laresLinkedIds.has(person.id);

    if (hasRelationship || curated) {
      protectedByRelationship += 1;
      continue;
    }

    junk.push({
      id: person.id,
      email: person.primaryEmail ?? "",
      name: `${person.firstName} ${person.lastName}`.trim(),
    });
  }

  return { junk, protectedByRelationship };
}
