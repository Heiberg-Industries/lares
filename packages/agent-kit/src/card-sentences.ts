/**
 * Every sentence a person is told about a card (an approval or a question) that is not the card's
 * own text. Written once for every door (ADR-0025): a door passes these on and never writes one.
 *
 * NO IMPORTS ON PURPOSE. The console's browser code reads this file, so it may not pull in
 * anything that needs a server.
 *
 * Each sentence is true in every case it is shown, which is why none of them names who may answer.
 */

/** Said privately to a person whose tap or answer was not accepted. True for an approval, a
 *  question, a stranger and a member alike: it says only what happened. */
export const CARD_REFUSED = "You cannot answer this request. Nothing was done.";

/** Said when the card has already been answered or closed. The answer that came too late is not
 *  used, and the sentence does not say anything else happened or did not happen. */
export const CARD_NO_LONGER_WAITING = "This request is no longer waiting, so this answer was not used.";

/** Said when a button is not one the door knows. */
export const CARD_UNRECOGNISED = "This button is not recognised, so nothing was done.";

/** Said when the card's record could not be read, so the answer was not sent on. */
export const CARD_UNCHECKED = "I could not check that request just now. Nothing was done. Try again in a moment.";

/** What a settled approval card says under its text. */
export const CARD_OUTCOME_TEXT = {
  approved: "✅ Approved",
  denied: "✖ Denied",
  /** Nobody decided: the request was withdrawn, interrupted, expired or otherwise closed. */
  notApproved: "✖ Not approved — this was closed without an answer.",
} as const;

/** Added under the outcome when the card was closed because the agent proposed a revised one. */
export const CARD_REVISED_TEXT = "Revised — see the new card";

/** What a settled card that is not an approval says (a question with buttons, a budget prompt). */
export const CARD_PROMPT_OUTCOME_TEXT = { answered: "Answered", closed: "No longer needed" } as const;

/** What a note about a shortened card is changed to once its request is decided. */
export const CARD_NOTE_CLOSED_TEXT = "The request above is closed.";

/** The name of web chat in a sentence. */
export const WEB_CHAT_NAME = "web chat";

/** The console page where a card raised on any door is shown whole and can be answered. It is not
 *  web chat (the Chat page holds its own conversations), so a sentence that sends a person there
 *  names this page. */
export const CONSOLE_WAITING_PAGE_NAME = "the Waiting on you page in the console";

/** A place a person can read and approve a card too long for the door it came on. */
export interface ShortenedCardPlace {
  /** In words that are true of that place, after "Open it in". */
  readonly where: string;
  /** Whether the sentence can give a page address for it. */
  readonly hasLink: boolean;
}

/**
 * Said under a card the door had to shorten: it offers no Approve, and says where the whole of it
 * can be read and approved. `places` are the doors that show a long card whole, best first (the
 * layer chooses them from its table). `link` is the page address of this request, given only when
 * one of the places has pages. Deny still works on a shortened card; that is the layer's rule, so
 * the sentence may say it.
 */
export function shortenedCardSentence(places: readonly ShortenedCardPlace[], link: string | null): string {
  const lead = "The request above is shortened, so it cannot be approved here.";
  if (places.length === 0) return `${lead} Deny still works here.`;
  const names = places.map((p) => p.where);
  const where = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  const page = link !== null && places.some((p) => p.hasLink) ? ` The page for this request: ${link}` : "";
  return `${lead} Open it in ${where}, where it shows in full, to approve it.${page}\nDeny still works here.`;
}
