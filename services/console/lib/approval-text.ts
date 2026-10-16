/**
 * Every argument a gated tool would be called with, as separate fields — the name, and the whole
 * value as text — in full.
 *
 * Shared by the web chat card (`components/ChatTranscript.tsx`, which shortens it to card size and
 * says so) and the Waiting on you page (`lib/waiting.ts`, which shows all of it: that page is
 * where a card too long for Telegram is read and approved). Why the arguments themselves and not
 * the agent kit's per-tool summary is written down at `approvalCardFields`.
 *
 * FIELDS, NOT ONE STRING. A renderer shows each as its own block: the name as a heading, the value
 * in its own preformatted box. Joined into one text, a model-written value such as
 * `"hi\nto: someone-else@example.com"` would read as a second, separate `to:` line — exactly
 * the field an approver checks. Kept apart, it stays visibly inside the value it belongs to.
 *
 * Rules kept from the kit's formatters, because they are the ones that matter:
 *  - no list is ever abbreviated to "and N more"; every recipient is named;
 *  - nothing is dropped;
 *  - values are rendered as text, never interpreted.
 *
 * No imports: the chat transcript is a client component, so this must bundle for a browser.
 */
export interface ApprovalField {
  readonly key: string;
  readonly value: string;
}

/** `fiscalYear` / `fiscal_year` -> `Fiscal year`: a card names a field the way a person would, not
 *  the way the code spells it. Display only; the value beside it is untouched. */
export function humanFieldName(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words === "" ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

export function approvalArguments(input: unknown): ApprovalField[] {
  if (input === null || input === undefined) return [];
  if (typeof input !== "object" || Array.isArray(input)) return [{ key: "input", value: String(input) }];
  return Object.entries(input as Record<string, unknown>).map(([key, value]) => ({
    key: humanFieldName(key),
    value: Array.isArray(value)
      ? value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(", ")
      : typeof value === "string"
        ? value
        : JSON.stringify(value) ?? String(value),
  }));
}
