/**
 * Twenty's SELECT field members — the single source of truth for every gated `twenty_*` write.
 *
 * READ FROM THE LIVE SCHEMA, not from a doc: `GET /rest/metadata/fields` against
 * the live CRM. They are **UPPERCASE**.
 *
 * WHY THIS FILE EXISTS. `twenty_comm_state` declared `state: z.string()`, so nothing
 * told the model what the members were and nothing checked its guess. Once it guessed
 * `email_sent`, Twenty rejected it, and the retry needed **a second 👍 from the owner for the
 * identical intent**. An approval gate is a scarce human-attention resource: a gated write that
 * can fail on a guessable formatting detail spends that attention on nothing, and trains the
 * habit of tapping twice without reading.
 *
 * WHY NOT THE RUNBOOK. The CRM comm-state-fields runbook documents these as
 * *lowercase* (`email_sent`, …), "verified by the owner from the live Twenty settings
 * UI". The live schema disagrees. Trusting that page is exactly what caused the double
 * approval above, so the values here come from the API and the runbook has been corrected to
 * point at this file.
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
 *    rather than as a failed write after the owner has already tapped.
 */
function twentyEnum<const T extends readonly [string, ...string[]]>(members: T) {
  return z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
    z.enum(members),
  );
}

export const commStateSchema = twentyEnum(COMM_STATES);
/** Opportunity steps are loaded from Twenty metadata at execution time. */
export const opportunityStageSchema = z.string().min(1);
/**
 * Opportunity.brand — Twenty's exact value for an existing track. Values are loaded from live
 * metadata at execution time; the gated executor validates the exact value before making a write.
 */
export const opportunityBrandSchema = z.string().min(1).describe("The exact value of an existing track in the connected Twenty CRM");
