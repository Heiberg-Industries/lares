/** Replies include the sender, other To recipients and Cc only when an owner alias is
 * visible in To/Cc. Otherwise the draft stays private to the sender. Own addresses and
 * malformed entries are removed; comparisons are case-insensitive and de-duplicated. */
/** A single mailbox, lower-cased; malformed or multi-address entries return empty. */
export function bareAddress(entry: string): string {
  if (/[\r\n]/.test(entry)) return "";
  const m = /^(?:[^<>]*)<([^<>\s]+@[^<>\s]+)>$/.exec(entry.trim());
  const address = (m ? m[1]! : entry).trim().toLowerCase();
  return /^[^\s<>@,;:]+@[^\s<>@,;:]+\.[^\s<>@,;:]+$/.test(address) ? address : "";
}

export type OwnerRecipientPosition = "to" | "cc" | "bcc_or_list";

export function ownerRecipientPosition(
  original: { to: readonly string[]; cc: readonly string[] }, self: readonly string[],
): OwnerRecipientPosition {
  const mine = new Set(self.map(bareAddress).filter(Boolean));
  if (original.to.some((entry) => mine.has(bareAddress(entry)))) return "to";
  if (original.cc.some((entry) => mine.has(bareAddress(entry)))) return "cc";
  return "bcc_or_list";
}

/** Display names only: do not expose other recipients' addresses to classification. */
export function otherToNames(original: { to: readonly string[] }, self: readonly string[]): string[] {
  const mine = new Set(self.map(bareAddress).filter(Boolean));
  return original.to.flatMap((entry) => {
    if (!bareAddress(entry) || mine.has(bareAddress(entry))) return [];
    const match = /^([^<>]+)<[^<>]+>$/.exec(entry.trim());
    const name = match?.[1]?.trim().replace(/^"(.*)"$/, "$1");
    return name && !name.includes("@") ? [name] : [];
  });
}

export const PRIVATE_REPLY_NOTE = "Private sender-only draft: your address was absent from To/Cc, so replying to everyone could reveal that you received this message.";

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
  const privateReply = ownerRecipientPosition(original, self) === "bcc_or_list";
  const to = take(privateReply ? [original.from] : [original.from, ...original.to]);
  const cc = privateReply ? [] : take(original.cc);
  return { to, cc };
}
