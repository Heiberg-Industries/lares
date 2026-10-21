/** Replies include the sender, other To recipients and Cc only when an owner alias is
 * visible in To/Cc. Otherwise the draft stays private to the sender. Own addresses and
 * malformed entries are removed; comparisons are case-insensitive and de-duplicated. */
/** Parse exactly one mailbox. Unquoted display names cannot contain address separators;
 * quoted display names may contain commas. Never pass an unvalidated raw header through. */
function singleMailbox(entry: string): { address: string; formatted: string } | null {
  if (/[\x00-\x1f\x7f]/.test(entry)) return null;
  const text = entry.trim();
  const named = /^("(?:[^"\\]|\\.)*"|[^"<>,@;:]*)\s*<([^<>\s]+)>$/.exec(text);
  const address = (named ? named[2]! : text).trim().toLowerCase();
  if (!/^[^\s<>@,;:"\\]+@[^\s<>@,;:"\\]+\.[^\s<>@,;:"\\]+$/.test(address)) return null;
  const name = named?.[1]?.trim();
  return { address, formatted: name ? `${name} <${address}>` : address };
}

/** A single mailbox, lower-cased; malformed or multi-address entries return empty. */
export function bareAddress(entry: string): string {
  return singleMailbox(entry)?.address ?? "";
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
      const mailbox = singleMailbox(e);
      if (!mailbox || mine.has(mailbox.address) || seen.has(mailbox.address)) continue;
      seen.add(mailbox.address);
      out.push(mailbox.formatted);
    }
    return out;
  };
  const privateReply = ownerRecipientPosition(original, self) === "bcc_or_list";
  const to = take(privateReply ? [original.from] : [original.from, ...original.to]);
  const cc = privateReply ? [] : take(original.cc);
  return { to, cc };
}
