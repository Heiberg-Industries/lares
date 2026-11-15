/**
 * agent/instructions/standing-facts.ts — what the owner has told the agent, once per conversation.
 *
 * A sibling of the persona: eve places this directory's entries in filename order
 * (`node_modules/eve/docs/instructions.mdx`). So this block lands in every conversation through
 * every door, and on the scheduled brief turns too.
 *
 * ONCE PER CONVERSATION, and why. This block used to be rebuilt on every single turn. eve merges
 * every system instruction into ONE system message with a single byte-exact cache breakpoint at
 * its end (`packages/agent-kit/src/clock.ts`'s header; unchanged in eve 1.0:
 * `dist/src/harness/model-call/request.js`, `mergeSystemInstructions`). A block whose bytes move
 * therefore re-bills the whole system prompt — persona, tool descriptions and memory together —
 * on every message. `aa-definition.ts` resolves the persona once per conversation for exactly
 * this reason, and its header names the reason it is a rule rather than a tuning choice.
 *
 * eve 1.0 runs this function before every model call. The block is kept in a memo keyed on the
 * session, so eve returns the saved text on every later call, in any process; the map below
 * gives the per-turn correction something to compare against in the process that built it.
 *
 * THE GUARANTEE THAT MOVED, STATED PLAINLY. A fact retired mid-conversation used to stop being
 * applied on the very NEXT turn, because the block was rebuilt every turn. It no longer is: the
 * block a session starts with is the block it keeps. Two things stand in for that — the tool
 * result of `remember` / `forget` stays in the conversation history for the rest of the session,
 * so the model has been told in the exchange itself; and a SECOND, per-turn block,
 * `standingFactsCorrectionBlock` below, lists only what changed since the block was built. It is
 * empty — and therefore absent, byte for byte — on an ordinary turn. eve 1.0 has no per-turn
 * group of its own, so the correction is emitted by `zz-cache-boundary.ts`, after the cache
 * marker, where it always was (that file's header has the ordering).
 *
 * BEST-EFFORT, ALWAYS. Unlike the clock, this resolver reads state — so it can fail for reasons
 * that have nothing to do with the agent: `DATABASE_URL` unset at build time, the box's Postgres
 * briefly unreachable, the migration not yet hand-applied. A throwing resolver fails the turn,
 * so a database hiccup would cost the owner the message they are in the middle of. It must not.
 * Every failure yields an EMPTY block — the agent starts that conversation without its memory,
 * which is exactly where it was before — and the failure is logged once, by `guarded`.
 *
 * A STALL IS A FAILURE TOO. `catch` covers a rejection; it does not cover a query
 * that never settles, which is what an unresponsive `db` container produces — and eve applies no
 * timeout of its own to a dynamic instruction. Unbounded, that is not "no memory this
 * conversation", it is "the owner's message got no reply". The read is bounded INSIDE the
 * provider by `withTimeout` so a late answer can never be cached as a block the model was never
 * shown, and `guarded` bounds the provider as a whole — the seam's own promise that no
 * implementation of it can cost a turn. See `STANDING_FACTS_TIMEOUT_MS` for the budget.
 *
 * NOTHING AT MODULE SCOPE THAT NEEDS A SECRET. `eve build` evaluates every module with no
 * secrets present, and `getPool` throws without `DATABASE_URL`; resolving the pool lazily
 * INSIDE the handler is what keeps the build green and the container bootable.
 *
 * THE CAP IS THE STORE'S. `listActiveFacts` defaults to `MAX_STANDING_FACTS` (40), newest first;
 * `buildFactsCore` then applies the character budget (`STANDING_FACTS_BUDGET_CHARS`). Neither is
 * restated here, so they can never disagree with the store.
 */
import { verifyPrivateConsoleSession } from "@lares/agent-kit/private-console-surface";
import { defineDynamic, defineInstructions } from "eve/instructions";

import { getPool } from "@lares/agent-kit/db";
import { guarded, type MemoryCoreProvider } from "@lares/agent-kit/memory-core";

import { withTimeout } from "../../lib/timeout.js";
import { configuredOwnerId, checkOwnerKeyAgreement } from "../../lib/identity-client.js";
import { notesForSession, type AgentNote } from "../../lib/agent-notes.js";
import { recordUse } from "../../lib/dream/store.js";
import { recordRead } from "../../lib/memory-reads.js";
import {
  STANDING_FACTS_TIMEOUT_MS,
  buildFactsCore,
  buildFactsCorrection,
  factsCoreFingerprint,
  listActiveFacts,
  type StandingFact,
} from "../../lib/standing-facts.js";

/**
 * What each session was built with. The markdown is what makes the block byte-stable for the
 * session; `facts` and `fingerprint` are what the turn-scoped correction below diffs against —
 * `fingerprint` for the cheap "did anything change" compare, `facts` to name what changed when it
 * did (a fact's text and category are not in the fingerprint, which deliberately carries none of
 * Owner's own words — see `factsCoreFingerprint`'s header).
 *
 * BOUNDED, because a long-lived process must not accumulate one entry per conversation forever.
 * Entries older than `SESSION_BLOCK_TTL_MS` are dropped on write. A session that outlives that
 * simply rebuilds — one cache miss, never a wrong answer — and an entry is at most a few hundred
 * bytes of the owner's own words, already in the prompt of the session it belongs to.
 */
const SESSION_BLOCK_TTL_MS = 6 * 60 * 60 * 1000;
const built = new Map<
  string,
  { markdown: string; fingerprint: string; facts: readonly StandingFact[]; at: number }
>();

function evictStale(now: number): void {
  for (const [id, entry] of built) {
    if (now - entry.at > SESSION_BLOCK_TTL_MS) built.delete(id);
  }
}

/**
 * Has this process already kicked off the owner-key/register agreement check? This
 * resolver's per-conversation block is the chosen hook — it is the first place in this
 * service that reliably gets a pool early (it already does the identical fire-and-forget
 * pattern for `recordUse`/`recordRead` below), and it runs on every door, including the
 * scheduled brief turns, so the check runs soon after boot without a dedicated boot-time
 * schedule of its own. Gated on this flag so it fires ONCE PER PROCESS, not once per session.
 */
let ownerKeyCheckStarted = false;

/**
 * The provider behind the seam. It holds every decision; the resolver below holds none — which
 * is what makes handing the same provider to eve's own memory slot, after the framework upgrade,
 * a change in one file.
 */
const provider: MemoryCoreProvider = {
  async forSession(sessionId: string): Promise<string> {
    // Fire-and-forget, never awaited: `checkOwnerKeyAgreement` never throws by its own
    // contract, and the `.catch` here is belt and braces against that guarantee ever regressing
    // — same posture as `recordUse`/`recordRead` below. A slow or hanging register must not cost
    // this (or any) turn, which is exactly why this is not inside `withTimeout` below: nothing
    // here is ever awaited by the code that returns the block.
    if (!ownerKeyCheckStarted) {
      ownerKeyCheckStarted = true;
      void checkOwnerKeyAgreement(getPool()).catch(() => {});
    }

    const cached = built.get(sessionId);
    if (cached) return cached.markdown;

    const facts = await withTimeout(
      // CANONICAL_USER_ID, not a resolved principal — every call site here does the same
      // (live principal→user resolution is future reader-path work, not done here). Brief turns run as the app principal, so a half-wired
      // resolution here would silently return no facts on the 08:00/20:00 briefs.
      listActiveFacts(getPool(), configuredOwnerId()),
      STANDING_FACTS_TIMEOUT_MS,
      "chief-of-staff: standing facts",
    );

    const core = buildFactsCore(facts);
    // Cached only on the way out of a SUCCESSFUL read: a block that timed out must leave no
    // entry behind, or the turn-scoped addendum would later diff against something the model
    // was never shown and report "nothing has changed" about a block that was never there.
    const now = Date.now();
    evictStale(now);
    built.set(sessionId, {
      markdown: core.markdown,
      fingerprint: factsCoreFingerprint(facts),
      facts,
      at: now,
    });

    // Record which ids the session block actually included — starts the usage clock
    // ADR-0018 rule 8's retirement will read. Mirrors `buildFactsCore`'s own filter/cut exactly
    // (owner-origin only, first `included` of them) rather than restating it. Fire-and-forget,
    // AFTER the instructions are already computed above, so a slow or failing write can never
    // cost the owner's first turn of the session — `recordUse` itself never throws, and the
    // `.catch` here is belt and braces against that guarantee ever regressing silently.
    const includedIds = facts
      .filter((f) => f.origin === "owner")
      .slice(0, core.included)
      .map((f) => String(f.id));
    void recordUse(getPool(), { kind: "standing_fact", refs: includedIds, owner: configuredOwnerId() }).catch(() => {});

    // Which of THIS session's shown facts answered which turn — `turnId: ""` because the
    // session block is shown on every turn of the session, not one. Same `includedIds` as
    // `recordUse` above: whichever ids the budget let into the block is the only honest answer to
    // "what did this session's block show", so it is computed once and read by both calls rather
    // than re-derived. Fire-and-forget, same posture as `recordUse`: `recordRead` never throws by
    // its own contract, and the `.catch` here is belt and braces against that ever regressing.
    void recordRead(getPool(), {
      sessionId,
      turnId: "",
      owner: configuredOwnerId(),
      kind: "standing_fact",
      refs: includedIds,
    }).catch(() => {});

    return core.markdown;
  },
};

const memoryCore = guarded(provider, {
  timeoutMs: STANDING_FACTS_TIMEOUT_MS,
  label: "chief-of-staff: standing facts",
});

/**
 * The per-turn half: re-reads the store and reports only what changed since the
 * session's block was built, or "" when nothing did.
 *
 * NO ENTRY ⇒ "", WITHOUT TOUCHING THE DATABASE. A turn whose session this process never built a
 * block for — after a restart, most plainly — has nothing to diff against; inventing a
 * correction against nothing would be a fabrication, and a process that has forgotten a session
 * has no business querying for one either.
 *
 * OTHERWISE, THE READ STAYS — ON PURPOSE. The cost this design removes is TOKENS: rebuilding and
 * re-billing the whole system prompt every turn. It does not remove the one indexed SELECT of at
 * most `MAX_STANDING_FACTS` short rows that `listActiveFacts` already was, and still is, bounded
 * by `STANDING_FACTS_TIMEOUT_MS`. Comparing the fingerprints is the cheap part — one string
 * compare, no rendering — and it is the ordinary-turn path; `buildFactsCorrection` only walks the
 * two lists when the fingerprints already disagree.
 *
 * FAIL SOFT, THE SAME POSTURE AS THE SESSION HALF. A failed or slow read yields "" via `guarded`,
 * never a throw, and is logged once — not once per turn, because `guarded` only fires on the
 * calls that actually reach it (an unknown session never does).
 *
 * NOTES JOIN THIS BLOCK TOO. `notesForSession` reads this session's OWN `agent_notes`
 * rows; `buildFactsCorrection` renders only the ones safe to reflect back (see its own header) —
 * a note stamped `third_party`/`synced` is kept in the table exactly as written, but never placed
 * in this block. The notes read is caught HERE, separately from the facts read above, and
 * defaults to `[]` on any failure — an installation that has not applied
 * `services/box/sql/001_baseline.sql` yet must not lose the fact-retraction guarantee this
 * block exists for just because the notes table is missing.
 */
/** Mirrors `SAFE_TO_SURFACE_NOTE_ORIGINS` in `lib/standing-facts.ts` exactly — that constant is
 *  private to its module, and widening that module's exports for one caller is not worth it, so the same three
 *  origins are named again here. Keep
 *  the two lists identical: this is what decides which note ids may be claimed as shown. */
const SAFE_NOTE_ORIGINS_FOR_READS: ReadonlySet<AgentNote["origin"]> = new Set(["owner", "agent", "system"]);

const correctionProvider: MemoryCoreProvider = {
  async forSession(sessionId: string): Promise<string> {
    const entry = built.get(sessionId);
    if (!entry) return "";

    const currentFacts = await withTimeout(
      listActiveFacts(getPool(), configuredOwnerId()),
      STANDING_FACTS_TIMEOUT_MS,
      "chief-of-staff: standing facts correction",
    );

    const notes = await withTimeout(
      notesForSession(getPool(), sessionId),
      STANDING_FACTS_TIMEOUT_MS,
      "chief-of-staff: standing facts correction notes",
    ).catch((): AgentNote[] => []);

    const markdown = buildFactsCorrection(entry.facts, currentFacts, notes);

    // Only the notes actually SHOWN — `buildFactsCorrection` itself drops a
    // third_party/synced note before rendering (see that function's header), and a record that
    // claimed an unshown note as read would be exactly the fabrication `recordRead`'s own
    // contract forbids. Fire-and-forget, after `markdown` is already computed, so a slow or
    // failing write can never delay or cost this turn.
    const safeNoteRefs = notes
      .filter((n) => SAFE_NOTE_ORIGINS_FOR_READS.has(n.origin))
      .map((n) => String(n.id));
    void recordRead(getPool(), {
      sessionId,
      turnId: "",
      owner: configuredOwnerId(),
      kind: "agent_note",
      refs: safeNoteRefs,
    }).catch(() => {});

    return markdown;
  },
};

const memoryCorrection = guarded(correctionProvider, {
  timeoutMs: STANDING_FACTS_TIMEOUT_MS,
  label: "chief-of-staff: standing facts correction",
});

/** What changed since this session's block was built; "" on an ordinary turn. Called once per
 *  turn by `zz-cache-boundary.ts`, which emits it after the cache marker. An empty result is not
 *  a placeholder: it adds zero bytes. */
export async function standingFactsCorrectionBlock(sessionId: string): Promise<string> {
  return memoryCorrection.forSession(sessionId);
}

export default defineDynamic(async (ctx) => {
  if (await ctx.memo(["private-console", ctx.turn?.id ?? null], () => verifyPrivateConsoleSession(ctx))) return null;
  const content = await ctx.memo(["standing-facts", ctx.session.id], () => memoryCore.forSession(ctx.session.id));
  return defineInstructions({ content });
});
