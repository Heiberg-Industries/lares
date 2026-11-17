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
/** A list, read or search of private notes failed. */
export const DOOR_NOTE_READ_FAILED =
  "I couldn't open your private notes from this chat just now, so I have not read any of them for this answer.";
/** A note tool that is not offered from a chat reached the guard anyway. */
export const DOOR_NOTE_TOOL_UNAVAILABLE =
  "That isn't available from this chat. Nothing was changed.";

export const DOOR_VAULT_SENTENCES: ReadonlySet<string> = new Set([
  DOOR_NOTE_UNREACHABLE, DOOR_NOTE_SAVE_NOT_POSSIBLE, DOOR_NOTE_READ_FAILED, DOOR_NOTE_TOOL_UNAVAILABLE,
]);
