/**
 * THE CLOSED LIST of sentences a person (through the model) can read when a private-note request
 * from a chat door is refused or fails. No imports on purpose. Beside `approval-reply-sentence.ts`.
 *
 * Every sentence must be literally true in every case it can be shown, and says what was NOT done.
 * Nothing from Keeper, the database or the file system is ever copied into a door's reply: the door
 * path throws one of these and nothing else (`tests/door-vault-turn.test.ts` holds that).
 */

/** The write is refused before any card, because the agent cannot reach the private notes right now. */
export const DOOR_NOTE_UNREACHABLE =
  "I can't reach your private notes from this chat right now. Nothing was saved, and I did not ask you to approve anything. Please try again in a few minutes.";
/** The write is refused before any card, because it is not possible from this chat. */
export const DOOR_NOTE_SAVE_NOT_POSSIBLE =
  "Saving to your private notes isn't possible from this chat. Nothing was saved, and I did not ask you to approve anything.";
/** One list, read or search of private notes failed (claims nothing about why, or about any other call). */
export const DOOR_NOTE_READ_FAILED =
  "I couldn't get that from your private notes in this chat, so I have not used it in my answer.";
/** A note tool that is not offered from a chat reached the guard anyway. */
export const DOOR_NOTE_TOOL_UNAVAILABLE =
  "That isn't available from this chat. Nothing was changed.";

/** The title is taken: the tool saves new notes only (the same words web chat shows). */
export const DOOR_NOTE_TITLE_TAKEN =
  "A private note with this title already exists. Choose another title: this tool saves new notes only.";
/** AFTER an approved card, the save did not happen. Never says why (nothing from Keeper is copied). */
export const DOOR_NOTE_SAVE_FAILED =
  "You approved saving this note, but it was not saved: the save could not be completed when it ran. Nothing was changed. If you still want it, ask me again and approve the new card.";
/** AFTER an approved card, the approval had run out or been used already. */
export const DOOR_NOTE_APPROVAL_EXPIRED =
  "You approved saving this note, but that approval had expired or was already used, so nothing was saved. Ask me again to get a new card.";
/** AFTER an approved card that the chat cut short (the owner's rule: a cut card is not approved here). */
export const DOOR_NOTE_CARD_SHORTENED =
  "You approved saving this note, but the request you were shown was cut short, so nothing was saved. Ask me to save a shorter note, or to split it into parts.";
/** AFTER an approved card whose record does not say it was shown in full. */
export const DOOR_NOTE_CARD_UNCONFIRMED =
  "You approved saving this note, but I could not confirm that the request was shown to you in full, so nothing was saved. Ask me again to get a new card.";

export const DOOR_VAULT_SENTENCES: ReadonlySet<string> = new Set([
  DOOR_NOTE_UNREACHABLE, DOOR_NOTE_SAVE_NOT_POSSIBLE, DOOR_NOTE_READ_FAILED, DOOR_NOTE_TOOL_UNAVAILABLE,
  DOOR_NOTE_TITLE_TAKEN, DOOR_NOTE_SAVE_FAILED, DOOR_NOTE_APPROVAL_EXPIRED, DOOR_NOTE_CARD_SHORTENED, DOOR_NOTE_CARD_UNCONFIRMED,
]);
