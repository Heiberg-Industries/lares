/**
 * Does this text look like a key or token rather than a name? Used wherever an owner types a NAME (a tool name, a
 * list of tool names) that a key could be pasted into by mistake. Generic by design: it names no vendor and knows no
 * key format, only the shape of a long random string.
 *
 * A name is refused when it is either
 *  - one long run of letters and digits with no separator at all, containing both a letter and a digit; or
 *  - a short word, a separator, then a long random tail of letters and digits (`word_<random>`).
 * Real tool names are made of words joined by separators, so they pass.
 */
const LONG_RUN = 24;
const LONG_TAIL = 20;

export function looksLikeSecret(value: string): boolean {
  const text = value.trim();
  const random = (run: string) => /^[A-Za-z0-9]+$/.test(run) && /[A-Za-z]/.test(run) && /[0-9]/.test(run);
  if (text.length >= LONG_RUN && random(text)) return true;
  const prefixed = /^([A-Za-z]{1,12})[_-](.+)$/.exec(text);
  return !!prefixed && prefixed[2]!.length >= LONG_TAIL && random(prefixed[2]!);
}

/** Plain words for the owner, naming the field rather than echoing what was typed. */
export const SECRET_AS_NAME_MESSAGE =
  "One of the tool names looks like a key or password, not a tool name. Keys never go in this field: paste a key in the Token field instead. Tool names are short words such as find_rate.";
