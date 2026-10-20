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

import { crmBrandIds } from "./crm-brands.js";

/** Person.commState — the outreach state machine. */
export const COMM_STATES = [
  "NEVER_CONTACTED",
  "EMAIL_SENT",
  "REPLIED_POSITIVE",
  "REPLIED_NEGATIVE",
  "BOUNCED",
  "DO_NOT_CONTACT",
] as const;

/** Opportunity.stage — the pipeline. A trial that starts on its own can enter at QUALIFIED. */
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
export const opportunityStageSchema = twentyEnum(OPPORTUNITY_STAGES);
/**
 * Opportunity.brand — the per-brand pipeline tag. The members are installation data
 * (`CRM_BRANDS`, lib/crm-brands.ts), so unlike the two enums above they cannot be baked into the
 * emitted JSON Schema: that is built when the image is, long before any installation exists.
 * The value is upper-cased on the way in and checked against the configured brands at parse
 * time, so a wrong brand is still a tool-call validation error the model can correct before a
 * card is drawn. With no brands configured the value is passed through for the CRM to judge.
 */
export const opportunityBrandSchema = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
  z
    .string()
    .min(1)
    .describe("The brand this opportunity belongs to, as configured for this installation's CRM")
    .superRefine((value, ctx) => {
      const ids = crmBrandIds();
      if (ids.length > 0 && !ids.includes(value)) {
        ctx.addIssue({ code: "custom", message: `brand must be one of: ${ids.join(", ")}` });
      }
    }),
);
