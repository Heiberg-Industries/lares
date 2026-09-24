/**
 * The obligation radar's resolve → read → explain pipeline, and the gather that composes it.
 *
 * ORB-209: extracted VERBATIM from `lib/brief-content.ts`, where it shipped as ORB-45 Task 10.
 * Nothing here was rewritten — the function bodies, the constants, the log strings and every
 * comment are the same bytes they were in `brief-content.ts`; only the imports are new. If this
 * file behaves differently from the file it came from, that is a bug in the move, not a design
 * decision.
 *
 * WHY IT MOVED. `brief-content.ts` had grown to ~2,300 lines holding five separable things (the
 * Gmail scan, the selection rule, the surfaces, this pipeline, and both brief renderers), and
 * this was the one piece with a clean seam: it consumes `Obligation`s and hands back
 * `Obligation`s, and nothing that renders a brief ever calls into it.
 *
 * AND WHY THE CYCLE HAD TO GO WITH IT. `brief-content.ts` imported `RESOLUTION_LOOKUP_TIMEOUT_MS`
 * from `obligation-resolution.ts` while `obligation-resolution.ts` imported `withTimeout` back
 * out of `brief-content.ts` — a genuine value-level ESM cycle. It was harmless under Vitest and
 * `tsc` only because neither binding is read at module-init time; one top-level use of either,
 * on either side, and `eve build`'s rollup would have turned it into a "Cannot access … before
 * initialization" crash at container boot. `withTimeout` now lives in `lib/timeout.ts` (a leaf
 * with no imports at all), so the cycle is gone rather than merely dormant.
 *
 * THE DEPENDENCY DIRECTION IS ONE-WAY, deliberately: this module reads `brief-content.ts`'s scan
 * and selection rule, and `brief-content.ts` reads nothing here. Keep it that way — the moment a
 * brief renderer needs something from this file, the shared piece belongs in a third module, not
 * in an import back the other way.
 */
import { INTENT_MAX_PER_PASS, intentReason, type Intent } from "./obligation-intent.js";
import { RESOLUTION_LOOKUP_TIMEOUT_MS, type Resolution } from "./obligation-resolution.js";
import { withTimeout } from "./timeout.js";
import {
  mapWithConcurrency,
  scanThreads,
  selectObligations,
  type GmailSourceDeps,
  type Obligation,
  type ThreadSnapshot,
} from "./brief-content.js";

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Gather — Gmail scan → candidates → dismissals applied → seen-state persisted. Both the
// evening and morning schedules, and the re-ping schedule, call this same composition (each on
// its own tick — Gmail is the source of truth; nothing about "which obligations are open" is
// cached between ticks). Ported from
// services/agent-runtime/lib/adapters/obligations/gather.ts, minus rank.ts (see module header).
// ═══════════════════════════════════════════════════════════════════════════════════════════

export interface GatherObligationsDeps {
  /** Every address he owns — never a constant. */
  myAddresses(): Promise<string[]>;
  gmail: GmailSourceDeps;
  /** Thread ids he has said "handled" on — never resurfaced. */
  dismissed(): Promise<Set<string>>;
  /** Persist what THIS pass saw as an open obligation. */
  upsertSeen(o: Obligation, now: Date): Promise<void>;
  /**
   * OPTIONAL Slack `ThreadSnapshot` source (ORB-149) — already constructed by the caller
   * (credentials resolved, `ownUserId`/clock supplied) so this file stays free of Slack
   * knowledge, exactly like `gmail` above. `undefined` is a real, supported state, not a
   * placeholder to fill in later: `evening-brief.ts` and `reping.ts` never pass one, by design
   * (D4 in docs/superpowers/specs/2026-08-24-orb-149-saga-reads-slack-design.md — proactive
   * delivery stays paused fleet-wide, and Slack obligations must reach the morning brief only).
   * Only `morning-brief.ts` supplies this.
   *
   * UNLIKE `gmail`, a failure here does NOT take down the whole gather — see the try/catch
   * below. A Slack outage, a revoked token, or a rate limit must never cost him his Gmail
   * obligations too.
   */
  slack?(): Promise<ThreadSnapshot[]>;

  /**
   * ORB-180 Workstream B — OPTIONAL sink for a snapshot the scan flagged as institutional
   * due-notice mail (`isDeadlineCandidate`). Called for every flagged snapshot BEFORE selection,
   * because selection is precisely what drops these threads: after it, the fact that the mail
   * existed is gone.
   *
   * BEST EFFORT, one `.catch` per call. The candidate table is where an OFFER is recorded — "do
   * you want this to be a deadline?" — and a dead table costs the brief one offer line. It must
   * never cost him the gather; the schedules that wire this hand back their whole obligation
   * list from the same call.
   *
   * `undefined` is a fully supported state: `evening-brief.ts` and `reping.ts` never pass one,
   * and the due notice is still off the radar without it — the exclusion is `selectObligations`'
   * job, not this dep's.
   */
  recordCandidate?(c: { threadId: string; subject: string; sender: string; seenAt: Date }): Promise<void>;

  // ─── ORB-45 Task 10 (B5) — resolve, then read, then explain ──────────────────────────────
  // EVERY dep below is optional, and that is the fail-open contract in the type system: a
  // schedule that wires none of them gets exactly the pre-Task-10 behaviour, and a stage whose
  // dep is missing is SKIPPED with the item kept. Nothing here may ever remove an obligation
  // from the radar by failing.

  /** thread id → `resolved_elsewhere_at` (`lib/obligations-store.ts`'s `resolvedThreads`).
   *  A MAP, not a set: a recorded resolution only counts while it is NEWER than their last
   *  message — see `dropResolved`. */
  resolved?(): Promise<ReadonlyMap<string, Date>>;
  /**
   * "Did he already answer them somewhere else?" — `lib/obligation-resolution.ts`'s
   * `resolveElsewhere`, wired by the schedule with the real lookups.
   *
   * Returns the WHOLE outcome rather than `Resolution | null` (which is what Task B5's brief
   * sketched) because `unreadable` is at its most load-bearing precisely when `resolution` is
   * null: "no answer found anywhere" and "no answer found, but the calendar could not be read"
   * are different claims, and only the second obliges the brief to say so.
   */
  resolve?(o: Obligation): Promise<ResolveOutcome>;
  /** Persist a hit (`lib/obligations-store.ts`'s `markResolved`). A throw here is logged and
   *  the item still dropped: the answer elsewhere is a fact, the write is bookkeeping. */
  markResolved?(o: Obligation, r: Resolution): Promise<void>;
  /**
   * The already-known verdict for this thread's CURRENT last message (Task B4's `cachedIntent`),
   * or null when nobody has read it yet.
   *
   * SPLIT FROM `classifyIntent` DELIBERATELY, and the split is the whole reason `INTENT_MAX_PER_PASS`
   * works. `INTENT_MAX_PER_PASS` bounds MODEL CALLS — money and latency — and a cache hit is
   * neither. Behind one combined dep, a cache hit consumed a cap slot, so on a radar holding more
   * than eight items the ninth-oldest could never be read on ANY pass: the eight ahead of it were
   * served from cache, spent the budget, and left it permanently "not yet read". Reading the cache
   * first, for free, is what lets the cap be spent on the items nobody has read yet.
   *
   * A throw is treated as a MISS (logged): the item joins the uncached queue and may be read, which
   * is the fail-open direction — a broken cache costs a model call, never a lost verdict.
   */
  cachedIntent?(o: Obligation): Promise<Intent | null>;
  /** One bounded model read of their last message (`lib/obligation-intent.ts`'s `classifyIntent`,
   *  plus the caller's own `recordIntent` write). Called at most `INTENT_MAX_PER_PASS` times per
   *  pass, on the OLDEST items no cache hit already answered. */
  classifyIntent?(o: Obligation): Promise<Intent>;
  /** Called ONCE per pass, only when at least one lookup could not be read, with the unique
   *  source names. The brief turns this into its "Sources behind that list" note — a silent
   *  lookup failure is exactly the shape of gap this fleet has paid for before. */
  onUnreadable?(sources: string[]): void;
}

/** What `resolve` hands back: the hit (or its absence) plus the sources that contributed
 *  nothing either way. Structurally `resolveElsewhere`'s own return value, so the schedules
 *  wire it with no adapter. */
export interface ResolveOutcome {
  resolution: Resolution | null;
  unreadable?: readonly string[];
}

/** The whole resolve+intent stage's budget, applied ONCE around both passes rather than
 *  per item. Additive to the schedules' existing gather budget (`OBLIGATION_TIMEOUT_MS` is
 *  raised by exactly this much where it is declared) — this stage may make the gather slower,
 *  never make it fail. On expiry every remaining candidate is KEPT. */
export const RESOLUTION_PASS_TIMEOUT_MS = 15_000;

/** In-flight resolutions (four metadata lookups each) and model reads. Matches the concurrency
 *  the task brief fixes for this pass; `INTENT_MAX_PER_PASS` caps the model reads themselves. */
const RESOLUTION_CONCURRENCY = 4;

/** He is still owed this, and we could not establish otherwise — a lookup threw, the model
 *  threw, or the stage ran out of budget. NEVER a reason to drop something. */
export const RESOLUTION_UNVERIFIED_REASON = "could not verify — kept on the radar";

/** Past `INTENT_MAX_PER_PASS`: nobody read their last message this pass, so nothing is known
 *  about it — which is not the same as knowing it needs him, and the line says so. */
export const INTENT_UNREAD_REASON = "not yet read — kept on the radar";

/**
 * Applies a recorded cross-channel resolution to a list of obligations.
 *
 * THE COMPARISON IS THE WHOLE POINT. A resolution is a statement about ONE moment: "he
 * answered them on 2026-08-11". If they wrote again on the 12th, that statement is stale and
 * the thread is owed again — dropping it on the mere PRESENCE of a resolution row would make a
 * single answered message silence a counterparty forever. Only `resolvedAt > lastMessageAt`
 * drops.
 *
 * Shared by `gatherOpenObligations`'s first step and `agent/schedules/reping.ts` (which applies
 * it before `assignSurfaces`, so a thread he has already handled can never buy an interrupt) —
 * one rule, one implementation, no chance of the two drifting.
 */
export function dropResolved(
  items: readonly Obligation[], resolved: ReadonlyMap<string, Date>,
): Obligation[] {
  if (resolved.size === 0) return [...items];
  return items.filter((o) => {
    const at = resolved.get(o.threadId);
    return !(at && at.getTime() > o.lastMessageAt.getTime());
  });
}

/**
 * Candidates → obligations, with dismissals applied. Gmail and (when supplied) Slack
 * `ThreadSnapshot`s are merged BEFORE `selectObligations` runs, so dismissals, the 48h/24h
 * gates and `upsertSeen` all apply to both sources identically — no source-specific branches
 * anywhere past this merge. Thread ids cannot collide across sources: Gmail's are hex thread
 * ids, Slack's are namespaced `slack:im:…` / `slack:channel:…` (see brief-content-slack.ts).
 *
 * THROWS on a Gmail source failure (a Gmail read, an unenrolled mailbox, a store write) — it
 * does not catch and does not degrade to `[]`. `[]` would read as "nobody is waiting on a
 * reply", a claim about his obligations that a query which threw has not earned. Callers turn
 * a throw into "unavailable" (never a rendered brief) and log it.
 *
 * A `deps.slack` FAILURE IS DIFFERENT: it is caught here, logged loudly (naming what failed),
 * and the gather continues with Gmail-only results — a Slack outage must never cost him his
 * Gmail obligations, let alone the whole brief.
 */
export async function gatherOpenObligations(deps: GatherObligationsDeps, now: Date): Promise<Obligation[]> {
  const mine = await deps.myAddresses();
  if (mine.length === 0) {
    throw new Error(
      "cannot tell which mail is his: the identity registry returned no addresses for the owner — " +
      "an empty registry would read as 'nobody is waiting on a reply'",
    );
  }
  const dismissed = await deps.dismissed();
  const { snapshots: gmailSnapshots } = await scanThreads(deps.gmail, mine);

  let slackSnapshots: ThreadSnapshot[] = [];
  if (deps.slack) {
    try {
      slackSnapshots = await deps.slack();
    } catch (err) {
      console.error(
        "gatherOpenObligations: Slack scan failed — continuing with Gmail obligations only",
        err,
      );
    }
  }

  const snapshots = [...gmailSnapshots, ...slackSnapshots];

  // ─── ORB-180 Workstream B: record the due notices BEFORE selection drops them ─────────────
  // Order is load-bearing. `selectObligations` below skips every `isDeadlineCandidate` snapshot,
  // which is the whole point of the rule — but it also means that after this line the mail has
  // left the pipeline entirely. Recorded here, the offer survives; recorded after, there would be
  // nothing left to record.
  //
  // One `.catch` PER CALL, not one around the batch: a single unwritable row must not take the
  // other candidates down with it, and none of them may take the gather down. `seenAt` is the
  // pass's clock (the house convention `upsertSeen` above already follows), and `upsertCandidate`
  // keeps the first sighting, so the stamp is stable across every later pass.
  if (deps.recordCandidate) {
    const record = deps.recordCandidate;
    await Promise.all(
      snapshots
        .filter((s) => s.isDeadlineCandidate)
        .map(async (s) => {
          // try/catch rather than `.catch()`: a dep that throws SYNCHRONOUSLY would sail past a
          // promise handler and out of the gather, which is the one thing this must never do.
          try {
            await record({ threadId: s.threadId, subject: s.subject, sender: s.counterpartyAddress, seenAt: now });
          } catch (err) {
            console.error(
              `gatherOpenObligations: could not record deadline candidate ${s.threadId} — ` +
              "the brief loses this one offer line, never the obligations",
              err,
            );
          }
        }),
    );
  }

  const candidates = selectObligations(
    snapshots.map((s) => (dismissed.has(s.threadId) ? { ...s, dismissedAt: now } : s)),
    now,
  );

  // ─── ORB-45 Task 10 (B5), step 1: apply what a PREVIOUS pass already established ──────────
  // Cheap, local, and it shrinks the list every later step (and every paid lookup) works on.
  // A read failure here is best-effort by construction: `deps.resolved` absent, or throwing,
  // means nothing is dropped — the radar keeps everything rather than going quiet.
  let resolvedAlready: ReadonlyMap<string, Date> = new Map();
  if (deps.resolved) {
    try {
      resolvedAlready = await deps.resolved();
    } catch (err) {
      console.error(
        "gatherOpenObligations: could not read recorded resolutions — every candidate stays on the radar",
        err,
      );
    }
  }
  const open = dropResolved(candidates, resolvedAlready);

  // ─── step 2: persist what THIS pass saw, BEFORE anything reads or writes against the row ──
  // This moved AHEAD of the resolve and intent passes (Task B5's brief listed it last) and the
  // ordering is load-bearing, not cosmetic: `markResolved` and `recordIntent` are both
  // UPDATE-only — they exist to write pointers onto a row `upsertSeen` alone knows how to
  // create. Run the other way round, both would silently update ZERO rows, every resolution
  // and every model read would be re-done from scratch on the next pass, and `resolved()` above
  // would stay empty forever while looking perfectly healthy.
  for (const c of open) await deps.upsertSeen(c, now);

  if (!deps.resolve && !deps.cachedIntent && !deps.classifyIntent) return open;

  // ─── steps 3 and 4, under ONE shared budget ──────────────────────────────────────────────
  // The budget wraps BOTH passes rather than each item, and blowing it must never cost the work
  // already done: `progress` is written AS the stage decides, so the timeout path can hand back
  // the verdicts it has and mark only the items nobody reached. This stage exists to shorten a
  // list — its failure mode is "the list stayed longer than it needed to", never "the brief said
  // nothing", and never "the eleven items it had already read came back unexplained".
  const progress: StageProgress = { keep: new Map(), dropped: new Set(), unreadable: new Set() };
  try {
    return await withTimeout(
      resolveAndExplain(open, deps, progress),
      RESOLUTION_PASS_TIMEOUT_MS,
      "gatherOpenObligations: cross-channel resolution + intent",
    );
  } catch (err) {
    // The message does NOT assert a timeout: the same catch also covers a throw from inside the
    // stage, and printing a cause nothing measured is how a real bug hides for a week. The
    // attached error says which of the two it was.
    const unreached = open.length - progress.keep.size - progress.dropped.size;
    console.error(
      `gatherOpenObligations: the resolve/intent stage did not complete (budget ${RESOLUTION_PASS_TIMEOUT_MS}ms) — ` +
      `${progress.keep.size} verdict(s) and ${progress.dropped.size} drop(s) already made are kept as they are; ` +
      `${unreached} candidate(s) nobody reached stay on the radar unverified`,
      err,
    );
    // An item POSITIVELY removed before the budget blew stays removed. Re-adding it would put a
    // thread he demonstrably answered — one this pass already recorded as resolved in the
    // database — back on his brief, which is the exact false report the whole stage exists to
    // stop, and it would arrive labelled "could not verify" as though nothing were known.
    return materialize(open, progress);
  } finally {
    // Guarded, and in a `finally`: this is a NOTIFICATION about the pass, and a throw from it
    // would replace whatever the pass had already produced — losing the entire obligations list
    // to a failed attempt to disclose that one lookup was unreadable. Absurd, and cheap to rule out.
    if (progress.unreadable.size > 0) {
      try {
        deps.onUnreadable?.([...progress.unreadable]);
      } catch (err) {
        console.error("gatherOpenObligations: onUnreadable threw — the obligations themselves are unaffected", err);
      }
    }
  }
}

/**
 * What the resolve/intent stage has decided SO FAR — written as it goes, precisely so a blown
 * budget can hand back a partial answer instead of throwing the whole pass away.
 *
 * `keep` and `dropped` are disjoint and both mean "decided". An id in NEITHER is one the stage
 * never reached, and only those become `RESOLUTION_UNVERIFIED_REASON` on the timeout path.
 */
interface StageProgress {
  /** thread id → the reason it stays (`undefined` = kept with nothing to say beyond "owed"). */
  keep: Map<string, string | undefined>;
  /** Thread ids POSITIVELY removed: resolved elsewhere, `closes_loop`, or `fyi`. */
  dropped: Set<string>;
  /** Resolution sources that could not be read, anywhere in this pass. */
  unreadable: Set<string>;
}

/**
 * `progress` → the obligations the brief renders, in `open`'s own order (most overdue first)
 * rather than the order the parallel passes happened to finish in.
 *
 * Used by BOTH the normal and the timeout path, so a partial answer is assembled by exactly the
 * same rule as a complete one — the only difference being how many ids are still undecided.
 */
function materialize(open: readonly Obligation[], progress: StageProgress): Obligation[] {
  return open
    .filter((o) => !progress.dropped.has(o.threadId))
    .map((o) => {
      if (!progress.keep.has(o.threadId)) return { ...o, reason: RESOLUTION_UNVERIFIED_REASON };
      const reason = progress.keep.get(o.threadId);
      return reason === undefined ? o : { ...o, reason };
    });
}

/**
 * The resolve pass then the intent pass, over the candidates that survived the recorded-
 * resolution drop. Returns the survivors in the input's own order (most overdue first), each
 * carrying the `reason` its brief line will render.
 *
 * Every path through this function that cannot establish something keeps the item. The three
 * ways an item leaves the list are all POSITIVE findings: a resolution hit ("he answered them
 * on 2026-08-11"), `closes_loop`, or `fyi`. Nothing leaves because a lookup broke.
 *
 * `progress` is written AS decisions are made rather than assembled at the end: the caller's
 * budget can cut this function off at any await, and what has already been decided must survive
 * that. Nothing here reads `progress` back — it is an outbox, not state.
 */
async function resolveAndExplain(
  open: readonly Obligation[],
  deps: GatherObligationsDeps,
  progress: StageProgress,
): Promise<Obligation[]> {
  // Step 3 — did he already answer them elsewhere?
  //
  // EVERY per-item decision is made INSIDE the mapper, not in a loop after it. `mapWithConcurrency`
  // is a barrier: one hung lookup means the whole pass never resolves, so a verdict reached in a
  // post-loop would be a verdict the budget can never collect. Recorded as each item finishes,
  // the eleven that answered are still eleven answers when the twelfth hangs.
  const resolveFn = deps.resolve;
  const survivors = (
    await mapWithConcurrency(open, RESOLUTION_CONCURRENCY, async (o): Promise<Obligation | null> => {
      if (!resolveFn) return o;
      let outcome: ResolveOutcome;
      try {
        outcome = await resolveFn(o);
      } catch (err) {
        console.error(`obligations: cross-channel check failed for ${o.threadId} — kept on the radar`, err);
        // It stays, saying so — and it does NOT go on to spend one of the pass's model reads: an
        // item we already cannot speak about is the wrong place to spend a bounded budget.
        progress.keep.set(o.threadId, RESOLUTION_UNVERIFIED_REASON);
        return null;
      }
      for (const source of outcome.unreadable ?? []) progress.unreadable.add(source);
      const resolution = outcome.resolution;
      if (!resolution) return o;

      console.log(`obligations: resolved elsewhere ${o.threadId} via ${resolution.via} — ${resolution.evidence}`);
      // Recorded as dropped BEFORE the write is awaited: the decision is already made, and the
      // budget may expire inside that await. The drop happens whether or not the write lands —
      // he HAS answered them; a failed write costs one repeated lookup next pass, not a brief
      // line about something already handled.
      progress.dropped.add(o.threadId);
      if (deps.markResolved) {
        // try/catch, not `.catch()`: a dep that throws SYNCHRONOUSLY never returns a promise for
        // `.catch` to attach to, and would escape the guard entirely and take down the pass.
        try {
          await deps.markResolved(o, resolution);
        } catch (err) {
          console.error(`obligations: failed to record the resolution of ${o.threadId} (it will be re-checked next pass)`, err);
        }
      }
      return null;
    })
  ).filter((o): o is Obligation => o !== null);

  // Step 4 — of what is left, does their last message actually still need him?
  await readIntents(survivors, deps, progress);

  return materialize(open, progress);
}

/**
 * The intent pass: cache first (free), then up to `INTENT_MAX_PER_PASS` model reads on the
 * OLDEST items no cache hit answered.
 *
 * THE CAP COUNTS MODEL CALLS, NOT ITEMS, and that distinction is load-bearing. Counting items
 * meant a radar of more than eight threads could never read the ninth: the eight ahead of it
 * were served from cache in microseconds, spent the whole budget, and left it permanently "not
 * yet read" on every pass forever. Serving the cache outside the cap is what makes the budget
 * mean "eight new reads a pass" instead of "eight rows a pass".
 */
async function readIntents(
  survivors: readonly Obligation[],
  deps: GatherObligationsDeps,
  progress: StageProgress,
): Promise<void> {
  const { cachedIntent, classifyIntent } = deps;
  if (!cachedIntent && !classifyIntent) {
    // Neither dep: the step is skipped and every survivor kept, with no reason. The brief renders
    // "on the radar", which is exactly what is known without the read.
    for (const o of survivors) progress.keep.set(o.threadId, undefined);
    return;
  }

  /** One verdict onto `progress` — the single place a `closes_loop`/`fyi` drop is decided, so a
   *  cached verdict and a fresh one can never be acted on differently. */
  const apply = (o: Obligation, intent: Intent): void => {
    if (intent === "closes_loop" || intent === "fyi") {
      // THE ONE LOG LINE THAT MATTERS when he asks "why wasn't X in my brief?". It is the only
      // record that an obligation was removed by a reading rather than by a fact — the acceptance
      // case is Angela's "sounds good, see you then" (slack:im:D0BHANJHNHJ:1786628505.953199),
      // which is a closed loop no structural rule could ever have told from an open one.
      console.log(`obligations: dropped ${o.threadId} — ${intent}`);
      progress.dropped.add(o.threadId);
      return;
    }
    progress.keep.set(o.threadId, intentReason(intent, { isRePing: o.isRePing }));
  };

  // SORTED EXPLICITLY, never inherited. `selectObligations` already returns most-overdue-first,
  // but a cap spent against an assumed ordering is a bug waiting for the day someone re-sorts
  // upstream — and the half that silently loses the budget is the oldest, i.e. the items he has
  // most stopped seeing. Ties break on the thread id so the same pass twice reads the same eight.
  const byAge = [...survivors].sort(
    (a, b) => b.ageHours - a.ageHours || a.threadId.localeCompare(b.threadId),
  );

  // The free pass. Each verdict is applied INSIDE its own callback, never batched into an array
  // and applied afterwards: `mapWithConcurrency` is a barrier, so a post-loop `forEach` is work
  // the stage budget can never collect — one slow Postgres read would have cost every OTHER
  // survivor the verdict that had already come back. Same reason the resolve pass writes from
  // inside its callback.
  //
  // And each read is BOUNDED, unlike before. The four channel lookups have carried a per-source
  // ceiling since Task B2; this one had none, so a wedged connection could pin the whole pass
  // against the 15s stage budget on a read that should take a millisecond. A timed-out or
  // throwing read is a MISS, never a verdict — a broken cache costs a model call, never an
  // item's explanation, and it can certainly never drop an obligation.
  const cacheAnswered = new Set<string>();
  if (cachedIntent) {
    await mapWithConcurrency(byAge, RESOLUTION_CONCURRENCY, async (o) => {
      let cached: Intent | null;
      try {
        cached = await withTimeout(
          // Lifted into a promise so a dep that throws SYNCHRONOUSLY lands in this catch rather
          // than escaping the guard — the same shape `resolveElsewhere`'s own `runLookup` uses.
          Promise.resolve().then(() => cachedIntent(o)),
          RESOLUTION_LOOKUP_TIMEOUT_MS,
          `obligations: cached verdict for ${o.threadId}`,
        );
      } catch (err) {
        console.error(`obligations: could not read the cached verdict for ${o.threadId} — re-reading if the budget allows`, err);
        return;   // not answered → falls through to the classify pass below
      }
      if (cached) {
        apply(o, cached);
        cacheAnswered.add(o.threadId);
      }
    });
  }

  // Derived from `byAge` rather than accumulated inside the callbacks: the callbacks finish in
  // whatever order Postgres makes, and the classify cap must be spent OLDEST-first. Filtering the
  // already-sorted list keeps that ordering by construction instead of re-deriving it.
  const uncached = byAge.filter((o) => !cacheAnswered.has(o.threadId));

  if (!classifyIntent) {
    // Cache wired but no reader: whatever the cache knew has been applied, and the rest is kept
    // with nothing to say — a skipped step, not a budget decision, so not "not yet read".
    for (const o of uncached) progress.keep.set(o.threadId, undefined);
    return;
  }

  for (const o of uncached.slice(INTENT_MAX_PER_PASS)) progress.keep.set(o.threadId, INTENT_UNREAD_REASON);

  await mapWithConcurrency(uncached.slice(0, INTENT_MAX_PER_PASS), RESOLUTION_CONCURRENCY, async (o) => {
    let intent: Intent;
    try {
      intent = await classifyIntent(o);
    } catch (err) {
      console.error(`obligations: could not read the last message of ${o.threadId} — kept on the radar`, err);
      progress.keep.set(o.threadId, RESOLUTION_UNVERIFIED_REASON);
      return;
    }
    apply(o, intent);
  });
}
