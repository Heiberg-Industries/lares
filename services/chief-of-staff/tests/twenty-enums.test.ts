/**
 * — a guessable formatting detail must never spend an approval.
 *
 * The live failure: the model called `twenty_comm_state` with `state: "email_sent"`, Twenty
 * rejected it, and the retry with `"EMAIL_SENT"` needed a SECOND 👍 for the identical intent.
 * The cause was `state: z.string()` — nothing advertised the members and nothing checked.
 *
 * These tests pin the two properties that fix it, plus the enum values themselves against the
 * live schema they were read from.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";

import {
  COMM_STATES,
  OPPORTUNITY_STAGES,
  commStateSchema,
  opportunityStageSchema,
  opportunityBrandSchema,
} from "../lib/twenty-enums.js";

// The brand list is installation data: a made-up one, set for these tests only.
let savedBrands: string | undefined;
beforeEach(() => {
  savedBrands = process.env["CRM_BRANDS"];
  process.env["CRM_BRANDS"] = JSON.stringify([{ id: "ALPHA", description: "first" }, { id: "BETA_CO", description: "second" }]);
});
afterEach(() => {
  if (savedBrands === undefined) delete process.env["CRM_BRANDS"];
  else process.env["CRM_BRANDS"] = savedBrands;
});

describe("Twenty enum members match the live schema", () => {
  // Read from GET /rest/metadata/fields against the live CRM. If Twenty's
  // options change, this is the test that should fail — not a gated write at 👍 time.
  it("commState", () => {
    expect([...COMM_STATES]).toEqual([
      "NEVER_CONTACTED", "EMAIL_SENT", "REPLIED_POSITIVE", "REPLIED_NEGATIVE", "BOUNCED", "DO_NOT_CONTACT",
    ]);
  });

  it("opportunity stage", () => {
    expect([...OPPORTUNITY_STAGES]).toEqual([
      "NEW", "CONTACTED", "MEETING", "QUALIFIED", "PROPOSAL", "CUSTOMER", "LOST",
    ]);
  });

  it("every member is UPPERCASE — the runbook's lowercase spelling is what caused", () => {
    for (const m of [...COMM_STATES, ...OPPORTUNITY_STAGES]) {
      expect(m).toBe(m.toUpperCase());
    }
  });
});

describe("case tolerance — the realistic model slip succeeds on the FIRST approval", () => {
  it("THE CASE: lowercase email_sent normalises to EMAIL_SENT", () => {
    const r = commStateSchema.safeParse("email_sent");
    expect(r.success).toBe(true);
    expect(r.data).toBe("EMAIL_SENT");
  });

  it("mixed case and surrounding whitespace normalise too", () => {
    expect(commStateSchema.parse("  Replied_Positive  ")).toBe("REPLIED_POSITIVE");
    expect(opportunityStageSchema.parse("qualified")).toBe("QUALIFIED");
    expect(opportunityBrandSchema.parse(" alpha ")).toBe("ALPHA");
  });

  it("the value that reaches the write is the normalised one, never the raw guess", () => {
    // This is the property the approval card and the PATCH body both depend on.
    expect(commStateSchema.parse("bounced")).toBe("BOUNCED");
  });
});

describe("a wrong VALUE is still rejected — before a card, not after a tap", () => {
  it("rejects a state that is not a member", () => {
    expect(commStateSchema.safeParse("replied_maybe").success).toBe(false);
    expect(commStateSchema.safeParse("").success).toBe(false);
  });

  it("rejects a stage that is not a member", () => {
    expect(opportunityStageSchema.safeParse("won").success).toBe(false);
  });

  it("a brand outside the configured list is rejected, naming the choices", () => {
    const r = opportunityBrandSchema.safeParse("gamma");
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("brand must be one of: ALPHA, BETA_CO");
    expect(opportunityBrandSchema.parse("beta_co")).toBe("BETA_CO");
  });

  it("with no brands configured the value is passed through for the CRM to judge", () => {
    delete process.env["CRM_BRANDS"];
    expect(opportunityBrandSchema.parse("gamma")).toBe("GAMMA");
    expect(opportunityBrandSchema.safeParse("").success).toBe(false);
  });

  it("rejects a non-string without throwing", () => {
    expect(commStateSchema.safeParse(42).success).toBe(false);
    expect(commStateSchema.safeParse(null).success).toBe(false);
  });
});

describe("the model can SEE the members — the root-cause fix", () => {
  // The original defect was not only the missing validation: `z.string()` told the model
  // nothing, so it had to guess. The emitted JSON Schema must still carry the enum through the
  // normalising wrapper, or the guess comes back.
  const schemas = {
    commState: commStateSchema,
    stage: opportunityStageSchema,
  };

  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name} advertises its enum in the emitted JSON Schema (input view)`, () => {
      const js = z.toJSONSchema(schema, { io: "input" }) as { type?: string; enum?: string[] };
      expect(js.type).toBe("string");
      expect(js.enum).toBeDefined();
      expect(js.enum!.length).toBeGreaterThan(1);
      for (const m of js.enum!) expect(m).toBe(m.toUpperCase());
    });

    it(`${name} advertises its enum in the emitted JSON Schema (output view)`, () => {
      const js = z.toJSONSchema(schema) as { enum?: string[] };
      expect(js.enum).toBeDefined();
    });
  }
});

describe("nullable/optional still behaves — expectedPrevious's CAS semantics survive", () => {
  const s = commStateSchema.nullable().optional();

  it("an explicit null still asserts must-currently-be-unset", () => {
    const r = s.safeParse(null);
    expect(r.success).toBe(true);
    expect(r.data).toBeNull();
  });

  it("omitted stays undefined — no assertion, just set it", () => {
    const r = s.safeParse(undefined);
    expect(r.success).toBe(true);
    expect(r.data).toBeUndefined();
  });

  it("a lowercase assertion normalises — otherwise it would ALWAYS mismatch the stored value and silently skip", () => {
    expect(s.parse("email_sent")).toBe("EMAIL_SENT");
  });
});
