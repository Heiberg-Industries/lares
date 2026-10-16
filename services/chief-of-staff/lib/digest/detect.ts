export type Inbound =
  | { kind: "link"; url: string; label?: string }
  | { kind: "conversation" };

/**
 * A message is a LINK capture only when it is *dominated* by a single URL: the trimmed text
 * is a URL, optionally preceded by a few words of label. A URL embedded in a sentence/question
 * (anything after the URL, or punctuation like '?') is conversation — we never hijack a turn.
 */
export function classifyInbound(text: string): Inbound {
  const t = text.trim();
  const urls = t.match(/\bhttps?:\/\/[^\s]+/gi) ?? [];
  if (urls.length !== 1) return { kind: "conversation" };
  const url = urls[0].replace(/[)\].,;!?]+$/, ""); // strip trailing punctuation
  const idx = t.indexOf(url);
  const before = t.slice(0, idx).trim();
  const after = t.slice(idx + url.length).trim();
  if (after.length > 0) return { kind: "conversation" };       // text AFTER the url → conversation
  if (before.length === 0) return { kind: "link", url };
  if (before.split(/\s+/).length <= 4 && !/[?]/.test(before)) return { kind: "link", url, label: before };
  return { kind: "conversation" };                              // long/qualified prefix → conversation
}
