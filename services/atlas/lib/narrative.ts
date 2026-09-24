// services/atlas/lib/narrative.ts
// The gated half: what to SAY about a change, and the decision to ask.
//
// Everything here is defensive in one direction. The failure that matters is not "the
// proposal was slightly wrong" — Bendik reads it and taps 👎. It is a proposal that QUIETLY
// REMOVES something, because that reads as an improvement and gets approved. So: an
// unhealthy source set never reaches the model; an empty drafted section is refused
// outright; and an identical draft never becomes a question.
import type { AtlasProposalInput } from "@lares/agent-box";
import { type ParsedNote } from "./frontmatter.js";
import { bodyHash, sourcesHash } from "./fingerprint.js";
import { verdictFor, type ResolvedSource } from "./resolve.js";

/** The six drafted headings, in SCHEMA.md's order. `## Canonical links` is NOT drafted. */
export const SECTIONS = [
  "## What it is",
  "## Positioning / wedge",
  "## Target",
  "## Stage / current state",
  "## Load-bearing strategy calls",
  "## Brand voice",
] as const;

export interface Draft { sections: Record<string, string> }

export interface DraftModel {
  draft(req: { brand: string; currentBody: string; sources: ResolvedSource[] }): Promise<Draft>;
}

/**
 * Rebuilds the body with the drafted sections replaced IN PLACE, leaving everything the
 * model was not asked about — `## Canonical links`, and anything a human added — exactly
 * where it was. A renderer that emitted the whole body from the draft would delete those
 * silently on every approve.
 *
 * Heading positions come from a LINE-anchored scan, not a raw `indexOf` over the whole
 * body: `indexOf` would treat a drafted heading string as "found" the moment it appears
 * ANYWHERE — inside another section's prose, or on a line inside a fenced code block that
 * merely LOOKS like a heading — and either misplace the boundary or truncate a section
 * early, leaking stale prose into the next one's slot. Anchoring to whole-line equality,
 * and skipping fenced code blocks entirely, closes both.
 *
 * FENCE TRACKING IS NOT TRUSTED FOR SAFETY, and neither is VERIFYING it after the fact —
 * both have been tried and both were wrong. A parity check (even count of fence-looking
 * lines = "trustworthy") missed two unpaired markers totalling an even count. An output
 * invariant checking "every heading TEXT that exists somewhere is visible somewhere" is a
 * SET-of-texts check, not a per-occurrence one: it is fooled the moment a hidden heading's
 * text also happens to appear a second time, visibly, elsewhere in the same note — and it
 * separately refuses FOREVER on totally safe input, because any well-formed, correctly
 * PAIRED fence containing a `## `-looking line trips the same check the instant that line's
 * text isn't ALSO duplicated unfenced (fence-blind sees it as "existing"; fence-aware
 * correctly never counts it, and the two scans disagreeing was read as danger rather than
 * business as usual).
 *
 * The fix does not decide, and does not verify — it BOUNDS. Each drafted span's end
 * (`next`, below) is the MINIMUM of two independently-computed boundaries: the next heading
 * the fence-AWARE scan sees, and the next heading a fence-BLIND scan sees (literally every
 * line starting with "## ", no exceptions — this can only ever find MORE headings than
 * exist as real section boundaries, never fewer). A drafted span can only swallow a heading
 * by extending PAST it; bounding by the smaller of the two means no heading visible to
 * EITHER scan can ever be absorbed, regardless of what confused the fence-aware one. Bad
 * fence tracking can no longer delete anything, full stop — there is nothing left for a
 * THIRD heuristic to get wrong, because there is no longer a decision being made about
 * whether the fence tracking can be trusted.
 *
 * The cost is bounded and is a QUALITY cost only, never a safety one: when a genuinely
 * fenced block inside a drafted section contains a `## `-looking line, the replacement now
 * stops early at it, and the fenced remainder — stale, undrafted — stays in place rather
 * than being cleanly replaced. That is visible in the diff preview Bendik reads, and it
 * loses nothing.
 *
 * The one thing left to check, cheaply, on the finished output: every heading actually
 * spliced in must appear there EXACTLY once, as its own line. This catches a heading that
 * ends up duplicated (an old, undrafted occurrence surviving alongside a freshly-drafted
 * one of the same text — the two-occurrences-of-one-heading case the min-bound intentionally
 * leaves alone, since deciding WHICH occurrence a human meant is not this function's call to
 * make). If it fails, this reports the refusal explicitly — see `RenderResult` — rather than
 * sentinelling with `currentBody`: a caller that only ever sees `currentBody` back cannot
 * tell "nothing changed" apart from "we refused to risk it", and `decideNote` used to take
 * the former branch and report an outright FALSE reason ("the draft is identical to the
 * note as it stands") for what was actually a refusal. The two are different facts about
 * the note and must read differently. A line is still logged naming the note, so the
 * refusal is visible even to a caller that only looks at stderr.
 *
 * Both heading scans tolerate 0-3 LEADING SPACES before `## ` — the CommonMark-legal range
 * for an ATX heading (4+ spaces makes it an indented code block instead, not a heading at
 * all). Without this, an indented heading is invisible to BOTH scans, which is the one gap
 * in the min-bound's guarantee as stated: "no heading visible to either scan can be
 * absorbed" has an implicit "that isn't itself invisible to detection", which this closes.
 */
export interface RenderOk { readonly ok: true; readonly body: string }
export interface RenderRefused { readonly ok: false; readonly reason: string }
export type RenderResult = RenderOk | RenderRefused;

export function renderBody(
  draft: Draft, currentBody: string, noteLabel = "(unlabeled note)",
): RenderResult {
  const lines = currentBody.split("\n");
  const isFenceLine = (line: string): boolean => /^(```|~~~)/.test(line.trimStart());
  const fenceTrackingIsTrustworthy = lines.filter(isFenceLine).length % 2 === 0;
  // 0-3 leading spaces, captured heading text WITHOUT the indentation — so an indented
  // occurrence of a SECTIONS heading still matches its canonical (unindented) form.
  const HEADING_RE = /^ {0,3}(## .*)$/;

  const fenceAwareHeadings: { text: string; at: number }[] = [];
  const fenceBlindHeadings: { text: string; at: number }[] = [];
  let offset = 0;
  let inFence = false;
  for (const line of lines) {
    const headingMatch = line.match(HEADING_RE);
    if (fenceTrackingIsTrustworthy && isFenceLine(line)) {
      inFence = !inFence;
    } else if (!inFence && headingMatch) {
      fenceAwareHeadings.push({ text: headingMatch[1]!, at: offset });
    }
    // Fence-BLIND: every "## " line counts, unconditionally — this is the upper bound on
    // how far a drafted span is ever allowed to reach, and it cannot be fooled by fence
    // tracking because it does not do any.
    if (headingMatch) fenceBlindHeadings.push({ text: headingMatch[1]!, at: offset });
    offset += line.length + 1; // +1 for the "\n" split() consumed
  }

  // A heading may appear more than once in malformed input (SCHEMA.md notes never
  // duplicate one) — the FIRST occurrence FENCE-AWARE DETECTION SEES is the one drafted
  // content replaces, deterministically.
  const marks = SECTIONS
    .map((h) => fenceAwareHeadings.find((m) => m.text === h))
    .filter((m): m is { text: string; at: number } => m !== undefined)
    .sort((a, b) => a.at - b.at);
  if (marks.length === 0) return { ok: true, body: currentBody };

  let out = "";
  let cursor = 0;
  const splicedHeadings: string[] = [];
  for (const { text: h, at } of marks) {
    const section = draft.sections[h];
    // The draft doesn't cover a heading the body actually has: nothing to splice in, so
    // that span is left exactly as it was rather than guessed at.
    if (section === undefined) continue;

    const nextAware = fenceAwareHeadings.find((m) => m.at > at)?.at ?? currentBody.length;
    const nextBlind = fenceBlindHeadings.find((m) => m.at > at)?.at ?? currentBody.length;
    const next = Math.min(nextAware, nextBlind);
    out += currentBody.slice(cursor, at);
    // ONE convention, no sniffing: a drafted value is the section's BODY, heading not
    // included — exactly what draft-model.ts's prompt asks the model for (that prompt IS
    // the contract). The heading is always put back explicitly. An earlier version tried
    // to tolerate "maybe it already starts with the heading" via `startsWith`, which is an
    // unanchored prefix test: prose that opens with a LONGER heading of its own (a model
    // writing "## Target audience" as the first line of its "## Target" answer) reads as
    // "already heading-inclusive" and the real "## Target" line silently never gets
    // written — the model's own wording gets to decide whether a required heading exists.
    //
    // A value that repeats the EXACT heading as its own leading line is the one case worth
    // de-duplicating rather than refusing over: strip it before prepending, so the common
    // "the model echoed the heading verbatim" case still renders cleanly. If stripping would
    // leave nothing behind (the section WAS just the heading), leave it un-stripped instead
    // of manufacturing an empty section — the exactly-once check below then catches the
    // resulting duplicate and refuses, which is the honest outcome for a degenerate reply.
    let body = section.trim();
    if (body !== h && body.startsWith(`${h}\n`)) {
      const withoutHeading = body.slice(h.length + 1).trimStart();
      if (withoutHeading !== "") body = withoutHeading;
    }
    out += `${h}\n\n${body}\n\n`;
    splicedHeadings.push(h);
    cursor = next;
  }
  out += currentBody.slice(cursor);

  // The one remaining sanity check: every heading this function actually spliced in must
  // appear in the candidate output EXACTLY once, as its own line. Checked directly on the
  // built string — independent of whatever internal bookkeeping produced it.
  const outLines = out.split("\n");
  for (const h of splicedHeadings) {
    if (outLines.filter((l) => l === h).length !== 1) {
      const reason = `"${h}" did not end up appearing exactly once in the candidate render`;
      console.error(
        `atlas: renderBody refused to rewrite ${noteLabel} — ${reason}. Leaving the note ` +
        "unchanged this tick rather than propose a note with a missing or duplicated " +
        "section heading.",
      );
      return { ok: false, reason };
    }
  }

  return { ok: true, body: out };
}

/** A compact, line-level before/after. Persisted at propose time — the DM shows this. */
export function diffPreview(before: string, after: string, maxLines = 60): string {
  const b = before.split("\n");
  const a = after.split("\n");
  const lines: string[] = [];
  for (let i = 0; i < Math.max(b.length, a.length); i++) {
    if (b[i] === a[i]) continue;
    if (b[i] !== undefined) lines.push(`- ${b[i]}`);
    if (a[i] !== undefined) lines.push(`+ ${a[i]}`);
  }
  if (lines.length <= maxLines) return lines.join("\n");
  return `${lines.slice(0, maxLines).join("\n")}\n… (${lines.length - maxLines} more lines truncated)`;
}

export interface DriftDecision {
  action: "skip" | "propose";
  /** Always populated — a skip that cannot say why is indistinguishable from a bug. */
  reason: string;
  proposal?: AtlasProposalInput;
}

export interface DecideNoteArgs {
  notePath: string;
  note: ParsedNote;
  raw: string;
  sources: ResolvedSource[];
  accountedSourcesHash: string | null;
  openProposalPaths: ReadonlySet<string>;
  model: DraftModel;
}

export async function decideNote(args: DecideNoteArgs): Promise<DriftDecision> {
  if (args.sources.length === 0) {
    return { action: "skip", reason: "no canonical sources declared — nothing to derive from" };
  }

  // Health FIRST, before any hashing: sourcesHash refuses an unhealthy set by design, and
  // the caller must get a sentence rather than an exception.
  const verdict = verdictFor(args.sources);
  if (verdict.outcome !== "ok") {
    return { action: "skip", reason: verdict.reason! };
  }

  const hash = sourcesHash(args.sources);
  if (hash === args.accountedSourcesHash) {
    return { action: "skip", reason: "sources unchanged since this note last accounted for them" };
  }

  // One open claim per note. Stacking a second would mean whichever applied later either
  // overwrote the other's work or was refused as stale.
  if (args.openProposalPaths.has(args.notePath)) {
    return { action: "skip", reason: `a proposal is already open for ${args.notePath}` };
  }

  const draft = await args.model.draft({
    brand: String(args.note.frontmatter["brand"] ?? args.notePath),
    currentBody: args.note.body,
    sources: args.sources,
  });

  for (const heading of SECTIONS) {
    const text = draft.sections[heading];
    if (text === undefined || text.trim() === "") {
      return {
        action: "skip",
        reason: `the draft came back with an empty section (${heading}) — refusing to propose ` +
          "removing prose. SCHEMA.md's rule is `—`, never nothing.",
      };
    }
  }

  // A refusal is a DIFFERENT fact from "the draft turned out identical" and must read
  // differently: reporting the identical-draft reason for a refusal (as an earlier version
  // did, by sentinelling with `currentBody` and letting the bodyHash comparison below treat
  // it as a no-op) is an outright false statement about what happened, and Task 9 surfaces
  // this reason directly to Bendik.
  const rendered = renderBody(draft, args.note.body, args.notePath);
  if (!rendered.ok) {
    return { action: "skip", reason: `could not safely rewrite ${args.notePath}: ${rendered.reason}` };
  }
  const newBody = rendered.body;
  if (bodyHash(newBody) === bodyHash(args.note.body)) {
    return { action: "skip", reason: "the draft is identical to the note as it stands" };
  }

  // The frontmatter is carried over untouched: this proposal is about PROSE. Mechanical
  // fields are the other pass's business, and a proposal that also moved them would make a
  // 👎 mean two different things.
  //
  // The split point is the LENGTH of the already-parsed body, not a re-search for the
  // fence: `note.body` is defined by `parseNote` as everything after the closing fence
  // line, and is therefore always an exact SUFFIX of `raw` — so `raw.length -
  // note.body.length` locates the boundary correctly no matter how many blank lines
  // surround the fence. The earlier approach of re-finding it via
  // `raw.indexOf("\n---\n")` duplicated logic `parseNote` already resolved, using a
  // pattern a markdown horizontal rule in the BODY can also produce — a source of drift
  // between what parseNote decided and what this function assumed, for no benefit.
  if (!args.raw.endsWith(args.note.body)) {
    throw new Error(
      `atlas: the raw file and its parsed body have diverged for ${args.notePath} — refusing ` +
      "to splice a proposal from mismatched inputs",
    );
  }
  const proposedNote = args.raw.slice(0, args.raw.length - args.note.body.length) + newBody;

  return {
    action: "propose",
    reason: "canonical sources changed",
    proposal: {
      notePath: args.notePath,
      proposedNote,
      baseBodyHash: bodyHash(args.note.body),
      sourcesHash: hash,
      diffPreview: diffPreview(args.note.body, newBody),
    },
  };
}
