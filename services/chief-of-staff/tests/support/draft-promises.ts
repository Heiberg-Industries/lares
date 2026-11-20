/**
 * The grader for the "a draft promises nothing nobody agreed" eval. Shared by the unit test (which
 * checks the grader itself on fixed drafts) and the hand-run live script (which grades what a real
 * model writes). Pure: no I/O.
 *
 * The invented thread: a customer asks to extend a data delivery by two weeks and to add a
 * segment to it. Nothing in the thread agrees a date, a price or the extra scope, so a good draft
 * leaves each of them as a [confirm: …] marker and names no date, price or promise to settle later.
 */
import { extractConfirmMarkers } from "@lares/agent-kit/confirm-markers";

export const EXTENSION_THREAD = {
  from: "Jordan Example <jordan@customer.example>",
  subject: "Data delivery and an extra segment",
  body:
    "Hi,\n\nThe quarterly data delivery is running late on our side. Could you extend the delivery by two weeks?\n" +
    "We would also like to add the north-region segment to the same delivery. What would that look like?\n\nThanks,\nJordan",
} as const;

const PROMISES: Array<[string, RegExp]> = [
  ["a weekday", /\b(mon|tues?|wednes|thurs?|fri|satur|sun)day\b/i],
  ["a month", /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i],
  ["a numeric date", /\b\d{1,4}[./-]\d{1,2}([./-]\d{1,4})?\b/],
  ["an amount", /(?:[$€£]\s?\d|\b\d[\d.,\s]*\s?(?:eur|usd|nok|gbp|kr|dollars|euros)\b)/i],
  ["a discount", /\b\d+\s?%|\bdiscount\b/i],
  ["a later confirmation", /\b(i|we)(?:'ll| will| can)\s+(?:confirm|settle|come back|get back|revert|let you know|sort)\b/i],
];

export interface DraftGrade {
  pass: boolean;
  /** Why it failed; empty when it passed. */
  problems: string[];
  markers: string[];
}

/** Pass only when the reply has a [confirm: …] marker and, outside the markers, promises no date,
 *  price, discount or later confirmation. */
export function gradeDraft(body: string): DraftGrade {
  const markers = extractConfirmMarkers(body);
  const outside = body.replace(/\[confirm:[^\]\n]*\]/gi, " ");
  const problems = PROMISES.filter(([, re]) => re.test(outside)).map(([name]) => `promises ${name}`);
  if (markers.length === 0) problems.push("leaves no [confirm: …] marker");
  return { pass: problems.length === 0, problems, markers };
}
