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
import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  COMM_STATES,
  commStateSchema,
  opportunityStageSchema,
  opportunityBrandSchema,
} from "../lib/twenty-enums.js";

describe("Twenty enum members match the live schema", () => {
  // Read from GET /rest/metadata/fields against the live CRM. If Twenty's
  // options change, this is the test that should fail — not a gated write at 👍 time.
  it("commState", () => {
    expect([...COMM_STATES]).toEqual([
      "NEVER_CONTACTED", "EMAIL_SENT", "REPLIED_POSITIVE", "REPLIED_NEGATIVE", "BOUNCED", "DO_NOT_CONTACT",
    ]);
  });

  it("commState members are UPPERCASE — the runbook's lowercase spelling is what caused", () => {
    for (const m of COMM_STATES) {
      expect(m).toBe(m.toUpperCase());
    }
  });
});

describe("commState normalization and exact dynamic metadata values", () => {
  it("THE CASE: lowercase email_sent normalises to EMAIL_SENT", () => {
    const r = commStateSchema.safeParse("email_sent");
    expect(r.success).toBe(true);
    expect(r.data).toBe("EMAIL_SENT");
  });

  it("commState normalizes case and whitespace", () => {
    expect(commStateSchema.parse("  Replied_Positive  ")).toBe("REPLIED_POSITIVE");
  });

  it("keeps dynamic track and step values exact for live metadata validation", () => {
    expect(opportunityStageSchema.parse(" custom-step ")).toBe(" custom-step ");
    expect(opportunityBrandSchema.parse(" alpha ")).toBe(" alpha ");
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

  it("accepts only nonempty values for dynamic metadata enums", () => {
    expect(opportunityStageSchema.safeParse("").success).toBe(false);
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
