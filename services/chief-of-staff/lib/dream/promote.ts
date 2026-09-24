/**
 * Dream-cycle promoter — this role's ADAPTER over the shared gate.
 *
 * The rule itself lives in `@lares/agent-kit/learning` (`makeLearningPromoter`), so that every
 * role that learns runs the same gate and a fix lands once: a safety rule with two
 * implementations has one of them wrong. Read that module's header for what the gate does and
 * why — in one line, it promotes only what the OWNER said, only once they have said it
 * `PROMOTE_MIN_OWNER_RECURRENCE` times, and never applies a change that would replace
 * something the owner stated.
 *
 * Everything in this file is translation: this service's `Observation` and `PreferenceRow`
 * shapes in, the kit's role-free shapes out, and the exported names
 * (`makePromoter`, `PromoterStore`, `PromoterResult`) unchanged so no caller had to move.
 *
 * ONE THING HERE IS NOT TRANSLATION (W4C-s5): `proposeSupersede`. The gate hands a change it
 * refuses to apply — one that would replace something the OWNER stated — to this route, which
 * RECORDS it in `memory_proposals` for the owner to answer. Recording is all it does. Nothing
 * in this file, and nothing the nightly run can reach, ever closes a standing preference on
 * the strength of a proposal; only `lib/memory-proposal-apply.ts` does, and only the approval
 * tool calls that.
 *
 * IT FAILS SOFT, THREE WAYS, because a dream run must never die on the queue:
 *   - the table is not on this installation yet (Postgres 42P01) — the night carries on and
 *     one plain warning names the file to apply;
 *   - the same change is already waiting (the unique partial index) — not an error at all: a
 *     second night proposing what the first night proposed is the system working;
 *   - the queue is already full — a run that has stopped being answered must not turn into a
 *     hundred rows nobody will ever read.
 * In every case the observation was already rejected `supersede-awaits-owner` by the gate, so
 * nothing is applied and the report already says the change is waiting on the owner.
 */

import {
  makeLearningPromoter,
  PROMOTE_MIN_OWNER_RECURRENCE,
  type LearnableObservation,
  type LearningStore,
  type Rejection,
} from "@lares/agent-kit/learning";
import { getPool } from "@lares/agent-kit/db";
import type { Origin } from "@lares/agent-kit/origin";
import type { Pool } from "pg";

import { getOpenMemoryProposals, insertMemoryProposal } from "../proposals-store.js";
import type { Observation } from "./reflect.js";
import type { PreferenceRow, PreferenceInput } from "./store.js";
import { deriveRef } from "./surface.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * @deprecated Decides nothing since W4C-s2. The model's own confidence stopped being a
 * promotion signal (ADR-0018 rule 4 — "agents grade their own work generously"); it is still
 * recorded on the row, and this constant is kept only so no caller breaks in this wave.
 * Wave 9's sweep removes it.
 */
export const PROMOTE_CONFIDENCE = 0.8;

/**
 * How many memory proposals may be waiting for the owner at once. Ten, and it is a ceiling on
 * the whole queue, not per subject: the per-row guard (`memory_proposals_open_idx`) already
 * stops the same change being queued twice, but nothing stopped a run that has gone unanswered
 * for a month from putting a different change in front of the owner every night. A queue past
 * this length is not a backlog to work through, it is a signal that the owner is not answering
 * — and the safe response to that is to stop adding to it, never to start applying.
 */
export const MEMORY_PROPOSAL_OPEN_CAP = 10;

/** Why a change the gate refused to apply did not become a row the owner can answer. Values,
 *  not prose, so the report and a test count the same thing. `recorded` is the ordinary case. */
export type ProposeOutcome =
  | "recorded"
  | "already-waiting"
  | "queue-full"
  | "not-installed"
  | "no-standing-row";

/**
 * Why an inference the gate held for the owner did not become a row they can answer (W5X-s4).
 * A separate set from `ProposeOutcome` because an `add` closes nothing, so `no-standing-row`
 * cannot arise — and because it has one of its own: an observation that is not the agent's
 * own inference is not an add candidate at all (see `makeProposeAdd`).
 *
 * `already-waiting` covers BOTH "this question is in the queue" and "this question has already
 * been answered". From the run's side they are one thing — the owner has it, or has had it,
 * and tonight is not the night to ask again.
 */
export type ProposeAddOutcome =
  | "recorded"
  | "already-waiting"
  | "queue-full"
  | "not-installed"
  | "not-agent-origin";

export { PROMOTE_MIN_OWNER_RECURRENCE };
export type { Rejection, RejectionReason } from "@lares/agent-kit/learning";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Structural subset of ReturnType<typeof makeDreamStore> needed by the promoter — this
 *  service's row types, where the kit states the same methods generically. */
export interface PromoterStore {
  /** Distinct prior OWNER-origin observations with this normalised text, including the one
   *  just recorded. Replaced `seenSimilar`, which counted anybody's repetitions. */
  ownerRecurrenceCount(text: string): Promise<number>;
  record(obs: Observation, source: string | undefined, origin: Origin): Promise<unknown>;
  addPreference(pref: PreferenceInput): Promise<PreferenceRow>;
  activePreferences(): Promise<PreferenceRow[]>;
  supersede(id: string, byId: string): Promise<void>;
}

export interface PromoterResult {
  promoted: PreferenceRow[];
  superseded: { oldId: string; byId: string }[];
  held: Observation[];
  needsConfirm: Observation[];
  /** Everything that will never be promoted, with a machine-readable reason and a sentence
   *  (ADR-0018 rule 6). The dream report renders these; W4C-s6 owns that half. */
  rejected: Rejection[];
  /** Changes filed for the owner to answer, by proposal id. Empty when nothing was filed —
   *  including when this installation has not applied the migration for the queue. */
  proposed: Array<{ id: number; existingId: string }>;
}

// ─── Recording a change the owner has to answer ───────────────────────────────

/** Postgres' "relation does not exist" — this installation has not applied
 *  `services/box/sql/072_memory_proposals.sql` yet. Same shape `lib/turn-capture.ts` and
 *  `lib/dream/log-reader.ts` already check. */
function isMissingTableError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42P01";
}

/** Postgres' unique-violation — here, only ever `memory_proposals_open_idx` or
 *  `memory_proposals_add_open_idx`: a proposal for this standing row, or this ref, is already
 *  open. Not an error; see this file's header. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

/**
 * The two shapes a box that has 072 but NOT `services/box/sql/074_memory_proposal_add.sql`
 * answers an `add` with: `23514` (the row breaks a CHECK — 072's `action` check does not know
 * the word 'add', and its origin check admits only 'owner') and `42703` (there is no `ref` or
 * `kind` column to write). Both mean the same thing operationally — this installation cannot
 * hold a confirmation yet — so both read as `not-installed` and the confirmation is HELD, never
 * applied and never lost: a later night re-derives the same observation and gets the same ref.
 */
function isNotMigratedError(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return code === "23514" || code === "42703";
}

let warnedMissingTable = false;
let warnedAddNotInstalled = false;

/** The run that proposed a row, as both routes stamp it: the date, never a persona name. */
function runSource(): string {
  return `dream-cycle-${new Date().toISOString().slice(0, 10)}`;
}

/**
 * The route the gate hands an unattended supersede of an owner-stated preference to. Records
 * the change and nothing else — but returns the new row's id on success (W5X-s6), so the
 * promoter and, from there, the dream note can name what it filed for the owner. `null` on
 * every other outcome: nothing was recorded, so there is no id to carry.
 *
 * The existing row's own TEXT is read here rather than taken from the caller, because that text
 * is what the owner will be shown as "what you told me" — it has to be the row, not the run's
 * idea of the row. If the row is no longer standing there is nothing to propose replacing.
 */
export function makeProposeSupersede(
  db: Pool,
  opts: { cap?: number; onOutcome?: (outcome: ProposeOutcome, existingId: string) => void } = {},
): (existingId: string, obs: Observation) => Promise<number | null> {
  const cap = opts.cap ?? MEMORY_PROPOSAL_OPEN_CAP;
  return async (existingId, obs) => {
    const say = (outcome: ProposeOutcome): null => {
      opts.onOutcome?.(outcome, existingId);
      return null;
    };
    try {
      const open = await getOpenMemoryProposals(db);
      if (open.length >= cap) {
        console.warn(
          `dream: ${open.length} memory changes are already waiting for the owner (the limit is ` +
            `${cap}), so this one was not added to the queue. Nothing was changed.`,
        );
        return say("queue-full");
      }

      const existing = await db.query<{ text: string; subject: string }>(
        `SELECT text, subject FROM dream_preferences WHERE id::text = $1 AND valid_to IS NULL`,
        [existingId],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        return say("no-standing-row");
      }

      const id = await insertMemoryProposal(db, {
        action: "supersede",
        existingId,
        existingText: row.text,
        proposedText: obs.text,
        subject: obs.subject || row.subject,
        // The gate reaches this route only for an owner-origin observation, and the table's own
        // CHECK repeats that. Stated, never inferred by a later reader.
        origin: "owner",
        source: runSource(),
        // A supersede closes an existing row; the add-only dedup key and kind are not this
        // proposal's business.
        ref: "",
        kind: "",
      });
      opts.onOutcome?.("recorded", existingId);
      return id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        // The same change is already waiting from an earlier night. Nothing to do and nothing
        // to warn about.
        return say("already-waiting");
      }
      if (isMissingTableError(err)) {
        if (!warnedMissingTable) {
          warnedMissingTable = true;
          console.warn(
            "dream: this installation has no memory_proposals table, so a change to a standing " +
              "preference could not be put to the owner and was left unapplied. Apply " +
              "services/box/sql/072_memory_proposals.sql to switch the queue on.",
          );
        }
        return say("not-installed");
      }
      throw err;
    }
  };
}

/**
 * The route an observation the gate will NOT apply — the agent's own inference — takes instead
 * of being shouted at the owner in a message nothing can answer (W5X-s4, ADR-0018 rule 4).
 *
 * It records an `add` proposal and nothing else. The row is `agent`-origin, because that is
 * what it is; only the owner's tap turns it into a standing preference, and only
 * `lib/memory-proposal-apply.ts` writes that, stamped `owner` (W5X-s3).
 *
 * THREE GUARDS, in this order, and the order is the design:
 *
 *   1. ONLY THE AGENT'S OWN INFERENCE. `needsConfirm` can also carry an OWNER-origin
 *      persona-level remark (the gate's identity-shift branch), and 074's CHECK admits only
 *      `agent` on an add — filing an owner's words under `origin = 'agent'` would be exactly
 *      the origin laundering the whole memory design exists to prevent. Anything else is
 *      refused here, before any SQL runs. Somebody else's words never even reach this route:
 *      the gate rejects them `not-owner-origin` first.
 *   2. NOT ALREADY SEEN — checked against `ref` in EVERY state, not just the open ones.
 *      `memory_proposals_add_open_idx` only stops a second row while the first is pending or
 *      approved; once the owner has REJECTED one, the index would happily let tonight's run
 *      ask the same question again, and the sentence they were shown when they rejected it
 *      ("not raised again unless something new is observed",
 *      `memoryRejectConsequence`) would be a lie. So a ref this installation has ever filed is
 *      never filed again; "something new" means different words or a different subject, which
 *      is a different `deriveRef`. This check comes BEFORE the cap so that a long-unanswered
 *      queue reports the honest reason rather than blaming a question already asked.
 *   3. THE WHOLE-QUEUE CAP, counted across supersede, retire and add together
 *      (`getOpenMemoryProposals` is action-blind), because the owner reads one queue, not
 *      three. Past the cap nothing is filed; the caller counts what it could not file.
 *
 * It fails soft the same three ways `makeProposeSupersede` does, plus one more: a box carrying
 * 072 but not 074 raises a CHECK or undefined-column error, which reads as `not-installed`.
 * The confirmation is then HELD — the owner hears nothing that night, which is silence rather
 * than a wrong answer, so the warning names the file to apply.
 *
 * ORDER OF DEPLOY: apply `services/box/sql/074_memory_proposal_add.sql` to the box BEFORE the
 * image carrying this code runs. The dream's own capped notice is gone with this change, so
 * until 074 is applied nothing tells the owner about an inference at all.
 */
export function makeProposeAdd(
  db: Pool,
  opts: { cap?: number; onOutcome?: (outcome: ProposeAddOutcome, ref: string) => void } = {},
): (obs: Observation) => Promise<number | null> {
  const cap = opts.cap ?? MEMORY_PROPOSAL_OPEN_CAP;
  return async (obs) => {
    const ref = deriveRef(obs);
    const say = (outcome: ProposeAddOutcome): null => {
      opts.onOutcome?.(outcome, ref);
      return null;
    };

    // Guard 1 — see the header. Deliberately before the try: this is not a database condition.
    if (obs.origin !== "agent") return say("not-agent-origin");

    try {
      // Guard 2 — every state, not just the open ones.
      const seen = await db.query<{ id: string }>(
        `SELECT id FROM memory_proposals WHERE action = 'add' AND ref = $1 LIMIT 1`,
        [ref],
      );
      if (seen.rows.length > 0) return say("already-waiting");

      // Guard 3 — one queue, one ceiling.
      const open = await getOpenMemoryProposals(db);
      if (open.length >= cap) {
        console.warn(
          `dream: ${open.length} memory changes are already waiting for the owner (the limit is ` +
            `${cap}), so this observation was not put to them. Nothing was changed, and it can ` +
            `be asked again once the queue is shorter.`,
        );
        return say("queue-full");
      }

      const id = await insertMemoryProposal(db, {
        action: "add",
        // An add closes nothing: no existing row, no existing text. 074's CHECK repeats it.
        existingId: "",
        existingText: "",
        proposedText: obs.text,
        subject: obs.subject,
        // What it IS. The owner's tap is what makes the resulting preference theirs, and that
        // stamp is written by the apply pass, not here.
        origin: "agent",
        source: runSource(),
        ref,
        // Carried, never re-derived at apply time from text a model wrote.
        kind: obs.kind,
      });
      opts.onOutcome?.("recorded", ref);
      return id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Guard 2 lost a race with itself (two runs at once). The question is already asked.
        return say("already-waiting");
      }
      if (isMissingTableError(err) || isNotMigratedError(err)) {
        if (!warnedAddNotInstalled) {
          warnedAddNotInstalled = true;
          console.warn(
            "dream: this installation cannot hold an observation for the owner to confirm, so " +
              "the observation was left unasked and nothing was changed. Apply " +
              "services/box/sql/074_memory_proposal_add.sql (and 072_memory_proposals.sql " +
              "before it) to switch confirmations on.",
          );
        }
        return say("not-installed");
      }
      throw err;
    }
  };
}

/** Test seam only — the once-per-process warnings above would otherwise make the second test
 *  that exercises a missing-table path assert on a warning that never comes. */
export function resetProposeWarningForTests(): void {
  warnedMissingTable = false;
  warnedAddNotInstalled = false;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function makePromoter(deps: {
  store: PromoterStore;
  isIdentityShift?: (obs: Observation) => boolean;
  /** The do-not-learn list (W4C-s3): the kit carries the rule, this role carries the wording. */
  doNotLearn?: (obs: Observation) => boolean;
  /** Where a supersede of an owner-origin preference goes instead of being applied (W4C-s5).
   *  Defaults to recording it in `memory_proposals` for the owner to answer; pass one to point
   *  it somewhere else, or to watch what it did. Either way the change is never applied here.
   *  Returns the filed proposal's id when one is recorded (W5X-s6); a fake still returning
   *  `Promise<void>` keeps working — nothing is counted as filed for it. */
  proposeSupersede?: (existingId: string, obs: Observation) => Promise<number | null | void>;
}) {
  // Resolved LAZILY, inside the call: `getPool()` needs a DATABASE_URL, and this factory is
  // built in unit tests that have none and never reach this branch.
  const proposeSupersede =
    deps.proposeSupersede ??
    ((existingId: string, obs: Observation) => makeProposeSupersede(getPool())(existingId, obs));
  // Every cast here is a widening the runtime already guarantees: the kit only ever hands back
  // the objects this service handed in.
  const gate = makeLearningPromoter({
    store: deps.store as unknown as LearningStore,
    ...(deps.isIdentityShift
      ? { isIdentityShift: (o: LearnableObservation) => deps.isIdentityShift!(o as Observation) }
      : {}),
    ...(deps.doNotLearn
      ? { doNotLearn: (o: LearnableObservation) => deps.doNotLearn!(o as Observation) }
      : {}),
    proposeSupersede: (id: string, o: LearnableObservation) =>
      proposeSupersede(id, o as Observation),
  });

  return {
    /**
     * `opts.origin` is gone on purpose. It used to let a caller label a whole run's worth of
     * observations with one class; the gate now reads the class each observation computed for
     * itself from the turns it cites (`reflect.ts`'s `originForObservation`), and an
     * observation that arrives without a readable one is treated as `third_party`. A run-level
     * label can no longer promote it.
     */
    async run(observations: Observation[], opts?: { source?: string }): Promise<PromoterResult> {
      const r = await gate.run(observations, opts);
      return {
        promoted: r.promoted as PreferenceRow[],
        superseded: r.superseded,
        held: r.held as Observation[],
        needsConfirm: r.needsConfirm as Observation[],
        rejected: r.rejected,
        proposed: r.proposed,
      };
    },
  };
}
