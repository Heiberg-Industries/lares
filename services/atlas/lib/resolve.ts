// services/atlas/lib/resolve.ts
// THE distinction this service turns on: `missing` and `failed` are different facts.
//
//   found   — we read it. This is what a note may be derived from.
//   missing — it is genuinely not there (HTTP 404, absent file). Real information about
//             the world, and something a human should look at.
//   failed  — we could not find out (network unreachable, proxy denial, timeout, auth,
//             5xx). NOT information about the world. It tells us only about ourselves.
//
// Collapsing the last two is the ORB-51 defect class — the box's firewall drops an
// outbound call and the caller reads the silence as "not found". Here that would mean
// drafting a note with its content removed and offering it as an improvement. So: an
// unhealthy source of EITHER kind blocks drafting entirely, and the two are reported
// differently because they send a human to different places.
import type { SourceRef, StorePrefix } from "./sources.js";
import { formatSourceRef, STORE_PREFIXES } from "./sources.js";

export type SourceOutcome = "found" | "missing" | "failed";

export interface ResolvedSource {
  ref: SourceRef;
  outcome: SourceOutcome;
  /** Present only when outcome === "found". Never "" standing in for "could not read". */
  content?: string;
  /** Present when outcome !== "found" — the sentence a human reads. */
  reason?: string;
}

export interface SourceReader {
  /** Distinct per store. The composition root asserts all four are present and different. */
  readonly id: string;
  read(ref: SourceRef): Promise<ResolvedSource>;
}

export type ReaderMap = Record<StorePrefix, SourceReader>;

/**
 * A reader that THROWS is `failed`, never `missing`. A reader is allowed to throw for
 * anything it did not anticipate, and "anything I did not anticipate" is precisely the
 * class that must not be read as "the file is gone".
 */
export async function resolveAll(refs: SourceRef[], readers: ReaderMap): Promise<ResolvedSource[]> {
  for (const p of STORE_PREFIXES) {
    if (readers[p] === undefined) {
      throw new Error(`atlas: no reader wired for "${p}:" — refusing to resolve with a partial reader map`);
    }
  }
  const out: ResolvedSource[] = [];
  for (const ref of refs) {
    try {
      out.push(await readers[ref.prefix]!.read(ref));
    } catch (e) {
      out.push({ ref, outcome: "failed", reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

export interface ResolveVerdict {
  outcome: "ok" | "sources_failed" | "sources_missing";
  reason: string | null;
}

function list(rs: ResolvedSource[]): string {
  return rs.map((r) => `${formatSourceRef(r.ref)} (${r.reason ?? "no reason given"})`).join("; ");
}

/**
 * `failed` outranks `missing` deliberately: a failed read may be HIDING a file that is
 * perfectly present, so reporting "missing" first would send a human hunting for a deletion
 * that never happened. Fix the reachability, then find out what is actually there.
 */
export function verdictFor(resolved: ResolvedSource[]): ResolveVerdict {
  const failed = resolved.filter((r) => r.outcome === "failed");
  if (failed.length > 0) {
    return { outcome: "sources_failed", reason: `could not read ${list(failed)}` };
  }
  const missing = resolved.filter((r) => r.outcome === "missing");
  if (missing.length > 0) {
    return { outcome: "sources_missing", reason: `canonical source gone: ${list(missing)}` };
  }
  return { outcome: "ok", reason: null };
}
