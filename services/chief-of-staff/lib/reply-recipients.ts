/**
 * Who a reply goes to (2026-09-08). Bendik: "she only adds one recipient on multi-recipient
 * emails — that must default to all recipients on the email and I decide if I want to remove or
 * add." So a reply defaults to EVERYONE on the original: the sender first, then the other To
 * recipients; the original Cc stays Cc. The member's own addresses are removed — they come from
 * the identity registry's email aliases (plus the mailbox itself), never a literal, so the same
 * code serves the next member. Compared by bare address, case-insensitive, de-duplicated; Cc never
 * repeats a To. Pure: no I/O.
 */

/** `"Name <a@b>"` → `a@b`; a bare address is returned lower-cased and trimmed. */
export function bareAddress(entry: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(entry);
  return (m ? m[1]! : entry).trim().toLowerCase();
}

export interface ReplyRecipients { to: string[]; cc: string[] }

export function replyRecipients(
  original: { from: string; to: readonly string[]; cc: readonly string[] },
  self: readonly string[],
): ReplyRecipients {
  const mine = new Set(self.map(bareAddress));
  const seen = new Set<string>();
  const take = (entries: readonly string[]): string[] => {
    const out: string[] = [];
    for (const e of entries) {
      const addr = bareAddress(e);
      if (addr === "" || mine.has(addr) || seen.has(addr)) continue;
      seen.add(addr);
      out.push(e.trim());
    }
    return out;
  };
  const to = take([original.from, ...original.to]);
  const cc = take(original.cc);
  return { to, cc };
}
