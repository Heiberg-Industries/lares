// services/atlas/lib/fingerprint.ts
// The two hashes that decide whether anything actually changed.
import { createHash } from "node:crypto";
import type { ResolvedSource } from "./resolve.js";
import { formatSourceRef } from "./sources.js";

/**
 * The fingerprint of everything a note is derived from, in declared order.
 *
 * It THROWS on a list containing an unresolved source, and that refusal is the point. If an
 * unreadable source silently contributed nothing, the hash would differ from last run's,
 * a proposal would be raised, and its draft would be written from a source set with a hole
 * in it — "I could not read it" laundered into "there is nothing to say". Callers must
 * check `verdictFor` FIRST and skip the note; there is no way to ask this function for a
 * best-effort answer, deliberately.
 */
export function sourcesHash(resolved: ResolvedSource[]): string {
  const h = createHash("sha256");
  // The entry count goes in first, then each entry contributes its locator and content
  // LENGTH-PREFIXED (byte count, then a non-digit delimiter, then exactly that many bytes).
  // This is what actually makes the encoding injective — the guarantee is about CONTENT,
  // not about locators. A fixed separator alone (e.g. a bare NUL between locator and
  // content) is not enough: content that happens to CONTAIN that separator followed by
  // something shaped like a locator can re-slice the byte stream into a different
  // (locator, content) partition that hashes identically to a genuinely different source
  // list. A length prefix cannot be spoofed this way, because reading it never searches for
  // a delimiter inside the data — it consumes an exact, pre-declared number of bytes.
  h.update(String(resolved.length)).update("\0");
  for (const r of resolved) {
    if (r.outcome !== "found" || r.content === undefined) {
      throw new Error(
        `atlas: refusing to fingerprint a source set containing ${formatSourceRef(r.ref)}, which ` +
        `did not resolve (${r.outcome}). Check verdictFor before hashing.`,
      );
    }
    // The locator is hashed alongside the bytes so a RENAME registers as a change even when
    // the content is identical — the note's canonical_sources list moved, and that is a
    // fact about the note.
    const locator = formatSourceRef(r.ref);
    h.update(String(Buffer.byteLength(locator, "utf8"))).update(":").update(locator);
    h.update(String(Buffer.byteLength(r.content, "utf8"))).update(":").update(r.content);
  }
  return h.digest("hex");
}

/**
 * The note's prose, hashed after collapsing trailing blank lines at the END of the file to
 * one — the one kind of whitespace churn an editor introduces without anyone touching the
 * prose (a stray blank line added on save). Nothing else is folded: per-line trailing
 * whitespace is deliberately left alone, because two trailing spaces is a markdown hard line
 * break (`<br>`), not noise — and this hash is what a stale-approval check compares against,
 * so an edit it can't see is an edit that gets approved by accident. Stripping it would also
 * reach into fenced code blocks, where trailing whitespace can be part of the example.
 */
export function bodyHash(body: string): string {
  const normalised = body.replace(/\n+$/, "\n");
  return createHash("sha256").update(normalised).digest("hex");
}
