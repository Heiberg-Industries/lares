/**
 * ORB-120 — a guessable formatting detail must never spend an approval.
 *
 * The live failure: the model called `twenty_comm_state` with `state: "email_sent"`, Twenty
 * rejected it, and the retry with `"EMAIL_SENT"` needed a SECOND 👍 for the identical intent.
 * The cause was `state: z.string()` — nothing advertised the members and nothing checked.
 *
 * These tests pin the two properties that fix it, plus the enum values themselves against the
 * live schema they were read from.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  COMM_STATES,
  OPPORTUNITY_STAGES,
  OPPORTUNITY_BRANDS,
  commStateSchema,
  opportunityStageSchema,
  opportunityBrandSchema,
} from "../lib/twenty-enums.js";

describe("Twenty enum members match the live schema", () => {
  // Read from GET /rest/metadata/fields against crm.owner.example on 2026-08-19. If Twenty's
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

  it("opportunity brand — HEIBERG_INDUSTRIES, not HEIBERG", () => {
    expect([...OPPORTUNITY_BRANDS]).toEqual([
      "ZERO7", "ORAKEL", "HEIBERG_INDUSTRIES", "MURMUR", "TRAAD",
    ]);
  });

  it("every member is UPPERCASE — the runbook's lowercase spelling is what caused ORB-120", () => {
    for (const m of [...COMM_STATES, ...OPPORTUNITY_STAGES, ...OPPORTUNITY_BRANDS]) {
      expect(m).toBe(m.toUpperCase());
    }
  });
});

describe("case tolerance — the realistic model slip succeeds on the FIRST approval", () => {
  it("THE ORB-120 CASE: lowercase email_sent normalises to EMAIL_SENT", () => {
    const r = commStateSchema.safeParse("email_sent");
    expect(r.success).toBe(true);
    expect(r.data).toBe("EMAIL_SENT");
  });

  it("mixed case and surrounding whitespace normalise too", () => {
    expect(commStateSchema.parse("  Replied_Positive  ")).toBe("REPLIED_POSITIVE");
    expect(opportunityStageSchema.parse("qualified")).toBe("QUALIFIED");
    expect(opportunityBrandSchema.parse("zero7")).toBe("ZERO7");
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

  it("uppercasing an ICP brand does NOT smuggle in an invalid Twenty brand", () => {
    // COMMERCIAL_BRANDS is ["zero7","orakel","heiberg"] — ICP filenames on disk. "heiberg"
    // uppercases to "HEIBERG", which Twenty does not accept (it is HEIBERG_INDUSTRIES). The
    // normalisation must not make that look valid.
    expect(opportunityBrandSchema.safeParse("heiberg").success).toBe(false);
    expect(opportunityBrandSchema.parse("HEIBERG_INDUSTRIES")).toBe("HEIBERG_INDUSTRIES");
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
    brand: opportunityBrandSchema,
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
