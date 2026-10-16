/**
 * The promotion gate — ADR-0018 rules 2 and 4 (`docs/decisions/0018-learning-and-dreaming.md`).
 *
 * One implementation, in the kit, because more than one role learns and a safety rule with two
 * implementations has one of them wrong. It knows nothing about any role service: it takes a
 * `LearningStore` and a list of `LearnableObservation`s and answers what may be applied.
 *
 * WHAT CHANGED, AND WHY IT MATTERS. Until this module the rule was
 * `confidence >= 0.8 || recurring`:
 *
 *   - `confidence` is the MODEL's own estimate of its own work. Nothing decides on it now
 *     (ADR-0018 rule 4). It is still recorded, so a later reader can see what the model claimed.
 *   - `recurring` asked only whether the same sentence had been seen before — never who said it.
 *     Anyone who can send the agent an email could therefore write a standing preference by
 *     sending the same message twice ("prompt laundering"; three emails were enough in the
 *     August 2026 report this ADR cites). Recurrence now counts ONLY distinct owner-origin
 *     sightings, and a `third_party`, `synced` or `system` observation is not a candidate at
 *     all, at any confidence, at any recurrence.
 *
 * FAIL CLOSED, in three places:
 *   1. An observation whose class is missing or unreadable is treated as `third_party` — not as
 *      the run's, not as the caller's, and never as the owner's.
 *   2. An unattended run may only ADD. Replacing a preference the OWNER stands behind is handed
 *      to `proposeSupersede` for the owner to approve; with no proposal route wired it is simply
 *      refused. In both cases nothing is inserted and nothing is closed, so a proposal can never
 *      leave a half-applied change behind.
 *   3. Only a row the AGENT itself wrote is superseded unattended (owner decision C1). Any other
 *      class on the standing row — including one this code cannot read — takes the proposal
 *      branch, because a row the agent did not write is not the agent's to close.
 */

import { isOrigin, type Origin } from "../origin.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** How many DISTINCT owner-origin observations of the same normalised text must exist before
 *  anything is promoted. Two, not three: the owner saying the same thing twice on different
 *  days is the signal; three is a year of waiting for a preference. */
export const PROMOTE_MIN_OWNER_RECURRENCE = 2;

/** The default identity/persona-level heuristic. An observation about how the agent itself
 *  should be is never promoted to a preference — it is offered to the owner instead
 *  (ADR-0018 rule 7's existing first cut). Deliberately carries NO persona name: the engine is
 *  role-neutral, and a role that wants its own wording passes `isIdentityShift`. */
const IDENTITY_KEYWORDS = [
  "persona",
  "your tone",
  "how you ",
  "your role",
  "your identity",
];

// ─── Types ────────────────────────────────────────────────────────────────────

/** Why an observation was not promoted. Every value is a sentence the report can print, and
 *  the set is closed so the report cannot invent one. */
export type RejectionReason =
  | "not-owner-origin"      // third_party, synced or system — never a candidate, ever
  | "agent-inference"       // the agent's own inference: held for confirmation, never auto
  | "below-recurrence"      // owner-origin, but said once so far
  | "already-held"          // same subject, same text, already standing
  | "supersede-awaits-owner" // would replace what the owner stated: the owner decides, not the run
  | "do-not-learn";         // W4C-s3's list

export interface Rejection {
  observation: LearnableObservation;
  reason: RejectionReason;
  /** One plain sentence, for the dream report and the console. Role-neutral. */
  say: string;
}

/** The promoter's view of an observation — deliberately NOT chief-of-staff's `Observation`,
 *  so the kit does not depend on a role service and the travel role can present its own. */
export interface LearnableObservation {
  text: string;
  kind: string;
  subject: string;
  confidence: number;
  origin: Origin;
  evidenceRefs: readonly string[];
}

export interface LearningStore {
  /** Distinct prior OWNER-origin observations with this normalised text. Rows written before
   *  the origin column existed are stamped `agent` by `ensureDreamTables`'s backfill default
   *  and are therefore excluded by construction — unknown, not trusted (ADR-0018 rule 4). */
  ownerRecurrenceCount(text: string): Promise<number>;
  record(obs: LearnableObservation, source: string | undefined, origin: Origin): Promise<unknown>;
  addPreference(pref: {
    text: string; kind: string; subject: string; confidence: number;
    source?: string | null; origin: Origin;
  }): Promise<{ id: string; subject: string; text: string; origin: Origin }>;
  activePreferences(): Promise<ReadonlyArray<{ id: string; subject: string; text: string; origin: Origin }>>;
  /** Close an existing row and link it. Called ONLY for a row the agent itself wrote; a row
   *  the owner stands behind goes to `proposeSupersede` instead (W4C-s5). */
  supersede(id: string, byId: string): Promise<void>;
}

export interface PromoterResult {
  promoted: Array<{ id: string; subject: string; text: string; origin: Origin }>;
  superseded: Array<{ oldId: string; byId: string }>;
  /** Owner-origin, seen once so far — a genuine "not yet", distinct from a rejection. */
  held: LearnableObservation[];
  /** Agent-origin, or persona-level: offered to the owner, never applied. */
  needsConfirm: LearnableObservation[];
  /** Everything that will never be promoted, with the reason. New in wave 4. */
  rejected: Rejection[];
  /** Changes filed for the owner to answer, by proposal id. Empty when nothing was filed —
   *  including when this installation has not applied the migration for the queue. */
  proposed: Array<{ id: number; existingId: string }>;
}

// ─── The sentences ────────────────────────────────────────────────────────────

/** One sentence per reason, so the report and the console read the same words and neither
 *  writes its own. Machine-readable `reason` is what a caller counts; `say` is what a person
 *  reads. */
const SAY: Record<RejectionReason, string> = {
  "not-owner-origin":
    "This came from somebody else — an email, a web page or a synced document — so it never " +
    "becomes a standing preference, however often it repeats.",
  "agent-inference":
    "This is the agent's own inference rather than something the owner said, so it is offered " +
    "for confirmation instead of applied.",
  "below-recurrence":
    `The owner has said this once so far; it waits until they have said it ${PROMOTE_MIN_OWNER_RECURRENCE} ` +
    "times, or until they write it down themselves.",
  "already-held":
    "The same wording on the same subject is already standing, so there is nothing to add.",
  "supersede-awaits-owner":
    "Applying this would replace something the owner stated, so nothing was changed — it is " +
    "waiting for the owner to approve replacing what they told me.",
  "do-not-learn":
    "This is on the do-not-learn list — a passing failure, a one-off task or a claim about a " +
    "broken tool, none of which should harden into a standing preference.",
};

// ─── Factory ──────────────────────────────────────────────────────────────────

function defaultIsIdentityShift(obs: LearnableObservation): boolean {
  const haystack = (obs.text + " " + obs.subject).toLowerCase();
  return IDENTITY_KEYWORDS.some((kw) => haystack.includes(kw));
}

/** The class an observation is treated as. An unreadable or absent value is `third_party`:
 *  a write that cannot say where it came from came from nowhere the owner can vouch for. */
function classOf(obs: LearnableObservation): Origin {
  return isOrigin(obs.origin) ? obs.origin : "third_party";
}

export function makeLearningPromoter(deps: {
  store: LearningStore;
  isIdentityShift?: (obs: LearnableObservation) => boolean;
  /** W4C-s3's list, injected so the kit carries the rule and the role carries the wording. */
  doNotLearn?: (obs: LearnableObservation) => boolean;
  /** W4C-s5 injects this; absent, an unattended supersede of an owner-origin row is REFUSED
   *  and reported, never silently applied. Fail closed. Returns the filed proposal's id when
   *  one route records one (W5X-s6); a caller still returning `Promise<void>` type-checks —
   *  `void` is not itself a candidate id, so nothing is recorded for it. */
  proposeSupersede?: (existingId: string, obs: LearnableObservation) => Promise<number | null | void>;
}): { run(observations: readonly LearnableObservation[], opts?: { source?: string }): Promise<PromoterResult> } {
  const { store, doNotLearn, proposeSupersede } = deps;
  const isIdentityShift = deps.isIdentityShift ?? defaultIsIdentityShift;

  return {
    async run(observations, opts): Promise<PromoterResult> {
      const result: PromoterResult = {
        promoted: [], superseded: [], held: [], needsConfirm: [], rejected: [], proposed: [],
      };
      const reject = (observation: LearnableObservation, reason: RejectionReason): void => {
        result.rejected.push({ observation, reason, say: SAY[reason] });
      };

      for (const obs of observations) {
        const origin = classOf(obs);

        // Everything is RECORDED, including what will never be promoted: the run has to be able
        // to say what it saw and rejected (ADR-0018 rule 6), and the row carries the class it
        // was actually given, so nothing can be counted later as if the owner had said it.
        await store.record(obs, opts?.source, origin);

        // 1. The do-not-learn list, before anything else.
        if (doNotLearn?.(obs)) {
          reject(obs, "do-not-learn");
          continue;
        }

        // 2. Count AFTER recording, the reverse of the pre-wave-4 order (which checked
        //    recurrence first, so the first sighting never counted itself). The count is
        //    therefore "owner-origin sightings including this one", which is the number
        //    PROMOTE_MIN_OWNER_RECURRENCE is written against.
        const ownerSightings = await store.ownerRecurrenceCount(obs.text);

        // 3. Somebody else's words, a synced document or the machine's own output: not a
        //    candidate, and no branch below can reach it.
        if (origin !== "owner" && origin !== "agent") {
          reject(obs, "not-owner-origin");
          continue;
        }

        // 4. The agent's own inference is offered, never applied. It is BOTH `needsConfirm`
        //    (what the owner is asked about) and a rejection (so the report's counts add up).
        if (origin === "agent") {
          result.needsConfirm.push(obs);
          reject(obs, "agent-inference");
          continue;
        }

        // 5. Persona-level: how the agent should be is not a preference row (ADR-0018 rule 7).
        if (isIdentityShift(obs)) {
          result.needsConfirm.push(obs);
          continue;
        }

        // 6. Said once so far — a genuine "not yet", not a refusal.
        if (ownerSightings < PROMOTE_MIN_OWNER_RECURRENCE) {
          result.held.push(obs);
          reject(obs, "below-recurrence");
          continue;
        }

        // 7. Contradiction, keyed by subject.
        const active = await store.activePreferences();
        const normSubject = obs.subject.trim().toLowerCase();
        const existing = active.find((p) => p.subject.trim().toLowerCase() === normSubject);

        if (!existing) {
          result.promoted.push(await addFrom(obs, origin));
          continue;
        }

        if (existing.text.trim().toLowerCase() === obs.text.trim().toLowerCase()) {
          result.held.push(obs);
          reject(obs, "already-held");
          continue;
        }

        if (existing.origin !== "agent") {
          // A row the agent did not write: the owner's, or one whose class this code cannot
          // read. Either way it is not the run's to close. The proposal is the ONLY thing that
          // happens here — no new row is inserted, so there is no half-applied state a later
          // approval or rejection would have to unpick.
          if (proposeSupersede) {
            const pid = await proposeSupersede(existing.id, obs);
            if (typeof pid === "number") result.proposed.push({ id: pid, existingId: existing.id });
          }
          reject(obs, "supersede-awaits-owner");
          continue;
        }

        // The agent superseding its own earlier guess — add the new row, close the old one and
        // link them. Still an ADD in ADR-0018 rule 2's sense: nothing is edited or deleted.
        const newPref = await addFrom(obs, origin);
        await store.supersede(existing.id, newPref.id);
        result.superseded.push({ oldId: existing.id, byId: newPref.id });
        result.promoted.push(newPref);
      }

      return result;

      async function addFrom(obs: LearnableObservation, origin: Origin) {
        return store.addPreference({
          text: obs.text,
          kind: obs.kind,
          subject: obs.subject,
          // Recorded, never decisive: see this file's header.
          confidence: obs.confidence,
          source: opts?.source ?? null,
          // The class this code computed, never one the observation asked for — and by the
          // branches above it can only ever be `owner` when we get here.
          origin,
        });
      }
    },
  };
}
