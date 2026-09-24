/**
 * Twenty's SELECT field members — the single source of truth for every gated `twenty_*` write.
 *
 * READ FROM THE LIVE SCHEMA, not from a doc: `GET /rest/metadata/fields` against
 * crm.owner.example on 2026-08-19. They are **UPPERCASE**.
 *
 * WHY THIS FILE EXISTS (ORB-120). `twenty_comm_state` declared `state: z.string()`, so nothing
 * told the model what the members were and nothing checked its guess. On 2026-08-18 it guessed
 * `email_sent`, Twenty rejected it, and the retry needed **a second 👍 from Bendik for the
 * identical intent**. An approval gate is a scarce human-attention resource: a gated write that
 * can fail on a guessable formatting detail spends that attention on nothing, and trains the
 * habit of tapping twice without reading.
 *
 * WHY NOT THE RUNBOOK. `docs/runbooks/twenty-comm-state-fields.md` documents these as
 * *lowercase* (`email_sent`, …), "verified 2026-06-24 by Bendik from the live Twenty settings
 * UI". The live schema disagrees. Trusting that page is exactly what caused ORB-120, so the
 * values here come from the API and the runbook has been corrected to point at this file.
 *
 * WHY A SHARED CONSTANT. Four gated write tools touch these three fields. Hand-copying an enum
 * into each one means four places to be wrong when Twenty's options change, and the failure
 * mode is a spent approval rather than a red test.
 */
import { z } from "zod";

/** Person.commState — the outreach state machine. */
export const COMM_STATES = [
  "NEVER_CONTACTED",
  "EMAIL_SENT",
  "REPLIED_POSITIVE",
  "REPLIED_NEGATIVE",
  "BOUNCED",
  "DO_NOT_CONTACT",
] as const;

/** Opportunity.stage — the pipeline. Orakel trials auto-enter at QUALIFIED. */
export const OPPORTUNITY_STAGES = [
  "NEW",
  "CONTACTED",
  "MEETING",
  "QUALIFIED",
  "PROPOSAL",
  "CUSTOMER",
  "LOST",
] as const;

/**
 * Opportunity.brand — the per-brand pipeline tag.
 *
 * NOTE the spellings: `HEIBERG_INDUSTRIES`, not `HEIBERG`. This list is deliberately NOT the
 * same as `COMMERCIAL_BRANDS` (`["zero7","orakel","heiberg"]`), which names ICP files on disk.
 * Uppercasing an ICP brand does not produce a valid Twenty brand, and it must not silently
 * seem to: `heiberg` → `HEIBERG` is rejected here, loudly, before a card is drawn.
 */
export const OPPORTUNITY_BRANDS = [
  "ZERO7",
  "ORAKEL",
  "HEIBERG_INDUSTRIES",
  "MURMUR",
  "TRAAD",
] as const;

/**
 * Case-insensitive on the way in, exact on the way out.
 *
 * Two properties, and both matter:
 *
 * 1. **The emitted JSON Schema still advertises the enum**, so the model *sees* the members in
 *    the tool definition instead of guessing — that is the root-cause fix. (Verified against
 *    zod 4.4.3: `z.toJSONSchema` on this wrapper yields `{type:"string",enum:[...]}` for both
 *    the input and output views.)
 * 2. **A wrong-case value is normalised rather than rejected**, so the realistic model slip
 *    (`email_sent`) succeeds on the FIRST approval instead of burning one. A wrong *value* is
 *    still rejected — as a tool-call validation error, which the model can correct on its own,
 *    rather than as a failed write after Bendik has already tapped.
 */
function twentyEnum<const T extends readonly [string, ...string[]]>(members: T) {
  return z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
    z.enum(members),
  );
}

export const commStateSchema = twentyEnum(COMM_STATES);
export const opportunityStageSchema = twentyEnum(OPPORTUNITY_STAGES);
export const opportunityBrandSchema = twentyEnum(OPPORTUNITY_BRANDS);
