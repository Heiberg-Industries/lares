import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { rungText } from "../agent/schedules/deadlines.js";
import type { DeadlineRow } from "../lib/deadlines-store.js";
import type { LadderStep } from "@lares/agent-kit/deadlines";

/**
 * LAR-68 — pins the deadline ladder's fixed sentences (`agent/schedules/deadlines.ts`'s
 * `rungText`) to TODAY's exact Norwegian wording, copied verbatim from the source before this
 * ticket's edits (see `git show 4c9a142:services/chief-of-staff/agent/schedules/deadlines.ts`).
 * Same shape as `tests/brief-language.test.ts` (LAR-16-s2): a pin proves the current behaviour
 * BEFORE the refactor, then gets re-pointed at `lang: "nb"` after — see the second describe block.
 *
 * Every rung and every branch `rungText` has: rung 1 with/without a consequence, rung 2
 * with/without a consequence, the rung-3 stop from a row never raised (singular/plural days
 * late), and the rung-3 stop with a raise count (singular/plural times).
 */

function deadline(overrides: Partial<DeadlineRow> = {}): DeadlineRow {
  return {
    id: "d1",
    owner: "bendik",
    entity: "Heiberg Industries AS",
    title: "Aksjonærregisteroppgaven",
    source: "statutory",
    dueDate: "2026-06-18",
    recurrence: "yearly",
    consequence: "Tvangsmulkt fra Skatteetaten løper per dag",
    evidenceRule: "owner confirms",
    status: "open",
    statusReason: null,
    resolvedAt: null,
    rung: 0,
    rungMovedAt: null,
    ruleKey: "aksjonaerregister",
    createdBy: "seed",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    vendor: null,
    amount: null,
    currency: null,
    ...overrides,
  };
}

const step = (rung: 1 | 2 | 3): LadderStep => ({ rung, finalStop: rung === 3 });

// LAR-68 — re-pointed at `lang: "nb"` after the change (was a bare 3-arg call against the
// untouched source; see the git history of this file for that pass, which was run and PASSED
// against 4c9a142 before any production code moved). Every assertion below is byte-for-byte
// identical to that pass — nb is untouched by this ticket.
describe("rungText — nb is byte-identical to today's wording", () => {
  it("rung 1, with a consequence", () => {
    expect(rungText(deadline(), step(1), 1, "nb")).toBe(
      "Frist i morgen: Aksjonærregisteroppgaven (Heiberg Industries AS) — Tvangsmulkt fra " +
        "Skatteetaten løper per dag. Si «ferdig» eller «avvis» når den er håndtert.",
    );
  });

  it("rung 1, no consequence — the clause drops rather than printing an empty dash", () => {
    expect(rungText(deadline({ consequence: null }), step(1), 1, "nb")).toBe(
      "Frist i morgen: Aksjonærregisteroppgaven (Heiberg Industries AS). " +
        "Si «ferdig» eller «avvis» når den er håndtert.",
    );
  });

  it("rung 2, with a consequence", () => {
    expect(rungText(deadline({ rung: 1 }), step(2), 0, "nb")).toBe(
      "SISTE FRIST i dag: Aksjonærregisteroppgaven (Heiberg Industries AS) — Tvangsmulkt fra " +
        "Skatteetaten løper per dag.",
    );
  });

  it("rung 2, no consequence", () => {
    expect(rungText(deadline({ rung: 1, consequence: null }), step(2), 0, "nb")).toBe(
      "SISTE FRIST i dag: Aksjonærregisteroppgaven (Heiberg Industries AS).",
    );
  });

  it("rung 3 from rung 0 (never raised) — plural days late", () => {
    expect(rungText(deadline({ rung: 0 }), step(3), -4, "nb")).toBe(
      "«Aksjonærregisteroppgaven» (Heiberg Industries AS) forfalt 4 dager siden uten at jeg " +
        "fikk sagt fra. Jeg stopper her — si fra om du vil ha den tilbake.",
    );
  });

  it("rung 3 from rung 0 — singular day late", () => {
    expect(rungText(deadline({ rung: 0 }), step(3), -1, "nb")).toBe(
      "«Aksjonærregisteroppgaven» (Heiberg Industries AS) forfalt 1 dag siden uten at jeg " +
        "fikk sagt fra. Jeg stopper her — si fra om du vil ha den tilbake.",
    );
  });

  it("rung 3 counts the rungs actually raised, then stops — plural", () => {
    expect(rungText(deadline({ rung: 2 }), step(3), -1, "nb")).toBe(
      "Jeg har tatt opp «Aksjonærregisteroppgaven» 3 ganger og stopper nå. " +
        "Si fra om du vil ha den tilbake.",
    );
  });

  it("rung 3 that slept through rung 2 — says 2, not 3 (never catches a rung up)", () => {
    expect(rungText(deadline({ rung: 1 }), step(3), -1, "nb")).toBe(
      "Jeg har tatt opp «Aksjonærregisteroppgaven» 2 ganger og stopper nå. " +
        "Si fra om du vil ha den tilbake.",
    );
  });

  it("rung 3 from rung 0, zero days late (stopped the same day it fell due)", () => {
    expect(rungText(deadline({ rung: 0 }), step(3), 0, "nb")).toBe(
      "«Aksjonærregisteroppgaven» (Heiberg Industries AS) forfalt 0 dager siden uten at jeg " +
        "fikk sagt fra. Jeg stopper her — si fra om du vil ha den tilbake.",
    );
  });
});

describe("rungText — en is a plain, natural translation", () => {
  it("rung 1, with a consequence", () => {
    expect(rungText(deadline(), step(1), 1, "en")).toBe(
      "Due tomorrow: Aksjonærregisteroppgaven (Heiberg Industries AS) — Tvangsmulkt fra " +
        "Skatteetaten løper per dag. Say \"done\" or \"dismiss\" once it's handled.",
    );
  });

  it("rung 1, no consequence", () => {
    expect(rungText(deadline({ consequence: null }), step(1), 1, "en")).toBe(
      "Due tomorrow: Aksjonærregisteroppgaven (Heiberg Industries AS). " +
        "Say \"done\" or \"dismiss\" once it's handled.",
    );
  });

  it("rung 2", () => {
    expect(rungText(deadline({ rung: 1 }), step(2), 0, "en")).toBe(
      "FINAL DEADLINE today: Aksjonærregisteroppgaven (Heiberg Industries AS) — Tvangsmulkt fra " +
        "Skatteetaten løper per dag.",
    );
  });

  it("rung 3 from rung 0 (never raised)", () => {
    expect(rungText(deadline({ rung: 0 }), step(3), -1, "en")).toBe(
      "\"Aksjonærregisteroppgaven\" (Heiberg Industries AS) was due 1 day ago and I never got the " +
        "chance to flag it. Stopping here — let me know if you want it back.",
    );
  });

  it("rung 3 counting the raises", () => {
    expect(rungText(deadline({ rung: 2 }), step(3), -1, "en")).toBe(
      "I've raised \"Aksjonærregisteroppgaven\" 3 times and I'm stopping now. " +
        "Let me know if you want it back.",
    );
  });
});

describe("no Norwegian literal survives outside a comment in agent/schedules/deadlines.ts (LAR-68)", () => {
  const source = readFileSync(join(import.meta.dirname, "../agent/schedules/deadlines.ts"), "utf8");

  /** Strips block comments (incl. JSDoc) and line comments — same approach as
   *  `tests/brief-language.test.ts`'s own guard for `lib/brief-content.ts`. */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  const code = stripComments(source);

  it.each([
    "Frist i morgen",
    "SISTE FRIST",
    "Si «ferdig»",
    "forfalt",
    "Jeg har tatt opp",
    "Jeg stopper her",
    "si fra om du vil ha den tilbake",
  ])("%s no longer appears outside a comment", (needle) => {
    expect(code).not.toContain(needle);
  });
});

