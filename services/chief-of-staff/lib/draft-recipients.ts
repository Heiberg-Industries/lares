/**
 * Changing who an EXISTING Gmail draft goes to (2026-09-08). Bendik: recipients must be editable
 * "both via Gmail AND by telling Saga". Gmail already works — it is a normal draft. Telling Saga
 * means rewriting the draft's raw RFC 822 message IN PLACE: only the To/Cc header lines above the
 * first blank line change, so the body, the HTML alternative and the appended signature survive
 * byte for byte. Pure: no I/O. The tool (agent/tools/gmail_draft_recipients.ts) reads the raw,
 * calls these, and writes the raw back with drafts.update.
 */
import { bareAddress } from "./reply-recipients.js";
import { parseAddressHeader } from "./google.js";

export interface Recipients { to: string[]; cc: string[] }

const CRLF = "\r\n";

/** Split a raw message into its header block and the rest (from the first blank line on).
 *  Accepts CRLF or bare LF line endings; returns the separator actually used. */
function splitRaw(raw: string): { headerLines: string[]; rest: string; eol: string } {
  const eol = raw.includes(CRLF) ? CRLF : "\n";
  const sep = eol + eol;
  const idx = raw.indexOf(sep);
  const headerBlock = idx === -1 ? raw : raw.slice(0, idx);
  const rest = idx === -1 ? "" : raw.slice(idx);
  // Unfold: a line starting with whitespace continues the previous header (RFC 5322 §2.2.3).
  const lines: string[] = [];
  for (const line of headerBlock.split(eol)) {
    if (/^[ \t]/.test(line) && lines.length > 0) lines[lines.length - 1] += " " + line.trim();
    else lines.push(line);
  }
  return { headerLines: lines, rest, eol };
}

function headerValue(lines: readonly string[], name: string): string | undefined {
  const re = new RegExp(`^${name}:\\s*(.*)$`, "i");
  for (const l of lines) {
    const m = re.exec(l);
    if (m) return m[1]!;
  }
  return undefined;
}

/** The draft's current To and Cc, unfolded and split. */
export function currentRecipients(raw: string): Recipients {
  const { headerLines } = splitRaw(raw);
  return {
    to: parseAddressHeader(headerValue(headerLines, "To") ?? ""),
    cc: parseAddressHeader(headerValue(headerLines, "Cc") ?? ""),
  };
}

/**
 * Rewrite the To and Cc headers, leaving every other header line and the whole body untouched.
 * To keeps its position; Cc is written directly after To (added when missing, dropped when empty).
 */
export function rewriteRecipientHeaders(raw: string, next: Recipients): string {
  const { headerLines, rest, eol } = splitRaw(raw);
  const out: string[] = [];
  let toWritten = false;
  for (const line of headerLines) {
    if (/^To:/i.test(line)) {
      out.push(`To: ${next.to.join(", ")}`);
      if (next.cc.length > 0) out.push(`Cc: ${next.cc.join(", ")}`);
      toWritten = true;
      continue;
    }
    if (/^Cc:/i.test(line)) continue; // rewritten beside To (or dropped)
    out.push(line);
  }
  if (!toWritten) {
    out.push(`To: ${next.to.join(", ")}`);
    if (next.cc.length > 0) out.push(`Cc: ${next.cc.join(", ")}`);
  }
  return out.join(eol) + rest;
}

/**
 * Apply "add these, remove those". Adds go to To unless the address is already present anywhere;
 * removes match the bare address, case-insensitively, across To and Cc. A change that would leave
 * nobody in To is refused with a readable reason — a draft with no recipient is not a draft.
 */
export function applyRecipientChanges(current: Recipients, change: { add?: readonly string[]; remove?: readonly string[] }): Recipients {
  const removed = new Set((change.remove ?? []).map(bareAddress));
  const keep = (e: string) => !removed.has(bareAddress(e));
  const to = current.to.filter(keep);
  const cc = current.cc.filter(keep);
  const present = new Set([...to, ...cc].map(bareAddress));
  for (const e of change.add ?? []) {
    const addr = bareAddress(e);
    if (addr === "" || present.has(addr)) continue;
    present.add(addr);
    to.push(e.trim());
  }
  if (to.length === 0) throw new Error("that change would leave nobody left in To — a draft needs at least one recipient");
  return { to, cc };
}
