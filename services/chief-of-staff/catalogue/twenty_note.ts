// Propose a CRM note on a person. GATED WRITE — requires Bendik to tap Approve on the card on every call.
//
// Ported from `services/agent-runtime/lib/adapters/twenty-client.ts`'s `createNote` +
// `resolvePersonId`: create the Note, then — only when `target` resolves to exactly one
// person — link it via `/noteTargets`. An ambiguous or unresolved target leaves the note
// unlinked rather than risk attaching it to the wrong person.
//
// The person-resolution step is deliberately best-effort (matches the old client): the note
// itself is already written by the time it runs, so a lookup hiccup there must never make
// this tool look like it failed — it just leaves the note unlinked. That is a narrower,
// intentional exception to the "never swallow TwentyUnavailableError" rule elsewhere in this
// wave (see twenty_lookup.ts): the primary write already succeeded before this step starts.
//
// `createTwentyNote` below is the reusable core (create + best-effort link), exported so
// `meeting_followup_send.ts` can call it directly to log a touchpoint without going through
// this tool's own approval (ORB-156 follow-up-note wiring) — see that file's own
// comment for why. This tool's `execute()` is just that core plus the approval check; the
// core's own behaviour, and this tool's observable behaviour, are both unchanged by the split.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { twentyGet, twentyPost } from "../lib/twenty-client.js";
import { assertApproval } from "../lib/approvals.js";
import { buildLookupQueries } from "./twenty_lookup.js";
import { approvalFor } from "../lib/board.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Twenty wraps create responses under data.<verb> — pull the first object with a string id. */
function extractId(res: unknown): string | undefined {
  const data = (res as { data?: Record<string, unknown> })?.data;
  if (data && typeof data === "object") {
    for (const v of Object.values(data)) {
      if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") {
        return (v as { id: string }).id;
      }
    }
  }
  return undefined;
}

/**
 * Resolve a free-text target to a single person id, or undefined if 0/ambiguous. `swallowErrors`
 * (default true, matching this function's original behaviour) folds a lookup failure into
 * "didn't resolve" — correct for the default best-effort LINKING use (the note already
 * exists; a lookup hiccup must not surface as this tool failing). `requireResolvedPerson`
 * below passes `false`: there, "Twenty is down" and "this person genuinely isn't in the CRM"
 * must stay distinguishable — the first is an infrastructure failure the caller needs to see
 * and alert on, the second is a normal, silent skip.
 */
async function resolvePersonId(target: string, opts?: { swallowErrors?: boolean }): Promise<string | undefined> {
  const swallowErrors = opts?.swallowErrors ?? true;
  if (UUID_RE.test(target)) return target;
  const seen = new Set<string>();
  for (const q of buildLookupQueries(target)) {
    if (q.kind === "company-name") continue;
    try {
      const body = await twentyGet<{ data?: { people?: any[] } }>(q.path);
      for (const p of body?.data?.people ?? []) if (p?.id) seen.add(p.id);
    } catch (err) {
      if (!swallowErrors) throw err;
      // Best-effort linking only — see file header.
    }
  }
  return seen.size === 1 ? [...seen][0] : undefined;
}

export interface CreateTwentyNoteInput {
  target: string;
  body: string;
  title?: string;
  /**
   * When true, resolve `target` to a person FIRST and skip creating the note entirely if it
   * does not resolve to exactly one match — rather than this function's default behaviour of
   * creating the note unlinked. Defaults to false/unset, which is BYTE-IDENTICAL to this
   * function's original body: this tool's own gated `execute()` never sets it, because a
   * human who asked for a note should still get one, linked or not.
   *
   * The follow-up send (`meeting_followup_send.ts`) sets this true (security-review fix,
   * ORB-156): an unlinked note there carries a full sent email body with no way to ever find
   * it again — every send to a recipient not yet in Twenty would silently accrete one, on
   * every send, forever. That is worse than no note. The follow-up send logs the skip itself.
   */
  requireResolvedPerson?: boolean;
}

/**
 * The core behaviour, extracted so it has exactly one implementation with two callers: this
 * tool's gated `execute()` below, and `meeting_followup_send.ts`'s post-send logging. Carries
 * no approval check of its own — each caller is responsible for deciding whether one is
 * needed (this tool always does; the follow-up send treats the human's approval on the email itself
 * as covering the note, per that file's header comment). Returns `null` only in the
 * `requireResolvedPerson` case, when nothing was created.
 */
export async function createTwentyNote(
  { target, body, title, requireResolvedPerson }: CreateTwentyNoteInput,
): Promise<{ id: string } | null> {
  const trimmedBody = body.trim();
  if (!trimmedBody) throw new Error("Twenty note: empty body");
  const noteTitle = (title ?? "").trim() || trimmedBody.slice(0, 60) || "Note from Saga";
  const trimmedTarget = target.trim();

  if (requireResolvedPerson) {
    // swallowErrors: false — a lookup failure here must propagate (Twenty being down is not
    // the same fact as "this recipient isn't in the CRM") so the caller's own containment
    // sees it as a real failure rather than a silent, indistinguishable skip.
    const personId = trimmedTarget ? await resolvePersonId(trimmedTarget, { swallowErrors: false }) : undefined;
    if (!personId) return null;
    const noteRes = await twentyPost<unknown>("/notes", { title: noteTitle, bodyV2: { markdown: trimmedBody } });
    const noteId = extractId(noteRes);
    if (!noteId) throw new Error("Twenty note: no id in create response");
    await twentyPost("/noteTargets", { noteId, targetPersonId: personId });
    return { id: noteId };
  }

  // Original, untouched body — `twenty_note`'s own `execute()` always takes this path.
  const noteRes = await twentyPost<unknown>("/notes", { title: noteTitle, bodyV2: { markdown: trimmedBody } });
  const noteId = extractId(noteRes);
  if (!noteId) throw new Error("Twenty note: no id in create response");

  const personId = trimmedTarget ? await resolvePersonId(trimmedTarget) : undefined;
  if (personId) await twentyPost("/noteTargets", { noteId, targetPersonId: personId });

  return { id: noteId };
}

export default defineTool({
  description:
    "Propose a CRM note on a person (requires Bendik to tap Approve on the card). `target` = person id from " +
    "lookup (or a name); `body` = the note text.",
  inputSchema: z.object({ target: z.string(), body: z.string(), title: z.string().optional() }),
  approval: approvalFor("twenty_note"),
  async execute(input, ctx) {
    await assertApproval(ctx, "twenty_note", input);
    const { target, body, title } = input;
    return createTwentyNote({ target, body, title });
  },
});
