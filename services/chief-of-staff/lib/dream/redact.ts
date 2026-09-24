// GDPR PII scrub — deterministic backstop against third-party contact identifiers
// leaking into the dream store / Brain. Conservative: dropping a learning is
// acceptable; leaking PII is not.
//
// This is a DETERMINISTIC BACKSTOP that catches literal + common-obfuscated
// contact identifiers (e.g. "john dot smith at gmail dot com"). The reflector
// prompt remains the primary control. Worded/unicode obfuscation forms not
// covered by the patterns below may still pass through.

import type { Observation } from "./reflect.js";

// email address: user@domain.tld
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/;

// obfuscated email: word <at-token> word <dot-token> tld-word
// covers: "at" / "(at)" / "[at]" combined with "." / "(dot)" / "[dot]" / "dot"
const OBFUSCATED_EMAIL_RE =
  /[a-z0-9._-]+\s*(?:@|\(at\)|\[at\]|\s+at\s+)\s*[a-z0-9.-]+\s*(?:\.|\(dot\)|\[dot\]|\s+dot\s+)\s*[a-z]{2,}/;

// phone number: a run of digits with optional +, spaces, dashes, parens, ≥8 digits total
const PHONE_RE = /\+?\d[\d ()\-]{6,}\d/;

// social @handle (not part of an email — email already covered by EMAIL_RE)
// matches @handle at start or after whitespace, minimum 2 chars
const HANDLE_RE = /(^|\s)@[A-Za-z0-9_]{2,}/;

type DropReason = "email" | "phone" | "handle";

function detectPII(text: string): DropReason | null {
  // Normalize to lowercase for obfuscated-pattern matching; keep original for
  // the other regexes which are already case-insensitive or case-irrelevant.
  const lower = text.toLowerCase();

  if (EMAIL_RE.test(text)) return "email";
  if (OBFUSCATED_EMAIL_RE.test(lower)) return "email";
  if (PHONE_RE.test(text)) return "phone";
  if (HANDLE_RE.test(text)) return "handle";
  return null;
}

export function scrubObservations(observations: Observation[]): {
  kept: Observation[];
  dropped: { observation: Observation; reason: string }[];
} {
  const kept: Observation[] = [];
  const dropped: { observation: Observation; reason: string }[] = [];

  for (const obs of observations) {
    const haystack = obs.subject ? `${obs.text} ${obs.subject}` : obs.text;
    const reason = detectPII(haystack);
    if (reason) {
      dropped.push({ observation: obs, reason });
      continue;
    }
    kept.push(obs);
  }

  return { kept, dropped };
}
