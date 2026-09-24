import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  heldBackLine,
  deadlinesBlock,
  deadlinesClause,
  DEADLINE_LINES_MAX,
  type CandidateLine,
  type DeadlineLine,
} from "../lib/brief-content.js";
import { BRIEF_STRINGS } from "../lib/brief-strings.js";
import { BRIEF_LANGUAGES } from "../lib/brief-settings.js";

/**
 * LAR-16-s2 — pins the SIX Norwegian structural places `lib/brief-content.ts` used to hard-code
 * (`heldBackLine`, `dueLabel`, `candidateRow`, the "+N flere frister" tail, the block label
 * "Frister", `deadlinesClause`) to TODAY's exact `nb` wording, copied verbatim from the source
 * before any of this ticket's edits (see `git show b6f17bd:services/chief-of-staff/lib/brief-content.ts`).
 * The owner's own brief is Norwegian; not one byte of it may change.
 *
 * The second half is a source guard: none of the five literals that used to be scattered through
 * `lib/brief-content.ts` may reappear there outside a comment — the wording now lives ONLY in
 * `lib/brief-strings.ts`.
 */

function deadlineLine(overrides: Partial<DeadlineLine> = {}): DeadlineLine {
  return {
    id: "d1",
    entity: "Heiberg Industries AS",
    title: "MVA-melding, 3. termin",
    dueDate: "2026-09-08",
    daysToDue: 0,
    consequence: "Tvangsmulkt per dag og forsinkelsesrenter",
    source: "statutory",
    ...overrides,
  };
}

function candidateLine(overrides: Partial<CandidateLine> = {}): CandidateLine {
  return {
    threadId: "t1",
    subject: "MVA-melding 3. termin forfaller 31.08",
    sender: "post@fiken.no",
    ...overrides,
  };
}

describe("nb output is byte-identical to today's brief (LAR-16-s2)", () => {
  it("heldBackLine — the exact sentence, plural and singular", () => {
    expect(
      heldBackLine(
        [
          { door: "slack:U0ABC", count: 3 },
          { door: "telegram:123456", count: 1 },
        ],
        "nb",
      ),
    ).toBe("Holdt tilbake siden forrige brief: 3 meldinger på Slack, 1 på Telegram (tak nådd eller stille timer).");

    expect(heldBackLine([{ door: "telegram:1", count: 1 }], "nb")).toBe(
      "Holdt tilbake siden forrige brief: 1 melding på Telegram (tak nådd eller stille timer).",
    );
  });

  it("dueLabel (via deadlinesBlock) — due today, due tomorrow, overdue (singular/plural), and further out", () => {
    expect(deadlinesBlock([deadlineLine()], [], "nb")).toContain(
      "- SISTE FRIST — i dag: MVA-melding, 3. termin (Heiberg Industries AS) — Tvangsmulkt per dag og forsinkelsesrenter [id d1]",
    );
    expect(deadlinesBlock([deadlineLine({ daysToDue: 1 })], [], "nb")).toContain(
      "- SISTE FRIST — i morgen: MVA-melding, 3. termin",
    );
    expect(deadlinesBlock([deadlineLine({ daysToDue: -1 })], [], "nb")).toContain(
      "- Forfalt for 1 dag siden: ",
    );
    expect(
      deadlinesBlock(
        [deadlineLine({ id: "d2", entity: "Vol de Nuit AS", title: "Aksjonærregisteroppgaven", daysToDue: -2, consequence: "Gebyr" })],
        [],
        "nb",
      ),
    ).toContain("- Forfalt for 2 dager siden: Aksjonærregisteroppgaven (Vol de Nuit AS) — Gebyr [id d2]");
    expect(
      deadlinesBlock(
        [deadlineLine({ id: "d3", title: "Skattemelding for AS", daysToDue: 8, dueDate: "2026-09-16", consequence: null })],
        [],
        "nb",
      ),
    ).toContain("- Om 8 dager (2026-09-16): Skattemelding for AS (Heiberg Industries AS) [id d3]");
  });

  it("candidateRow — the exact sentence, both tool calls, both threads", () => {
    const block = deadlinesBlock([], [candidateLine()], "nb");
    expect(block).toContain(
      '- Mulig frist fra e-post: "MVA-melding 3. termin forfaller 31.08" fra post@fiken.no — ' +
        "legg til (deadline_add fromThreadId t1) eller ignorer (deadline_dismiss candidateThreadId t1) [thread t1]",
    );
  });

  it('the "+N flere frister" tail — exact wording, every hidden row counted', () => {
    const rows = Array.from({ length: DEADLINE_LINES_MAX + 5 }, (_, i) => deadlineLine({ id: `d${i}`, daysToDue: i }));
    expect(deadlinesBlock(rows, [], "nb")).toContain("- +5 flere frister — se konsollen");
  });

  it('the block label — "## Frister"', () => {
    expect(deadlinesBlock([deadlineLine()], [], "nb")).toContain("## Frister");
  });

  it("deadlinesClause — the exact one-sentence instruction", () => {
    expect(deadlinesClause([deadlineLine()], [], "nb")).toEqual([
      "Frister er institusjonelle forfall; gjengi dem som sin egen liste, aldri blandet inn i svar-listen.",
      "",
    ]);
  });
});

describe("en output is a plain, natural translation", () => {
  it("heldBackLine", () => {
    expect(heldBackLine([{ door: "telegram:1", count: 1 }], "en")).toBe(
      "Held back since the last brief: 1 message on Telegram (ceiling reached or quiet hours).",
    );
  });

  it("deadlinesBlock — heading, due labels, tool names unchanged", () => {
    const block = deadlinesBlock([deadlineLine()], [candidateLine()], "en");
    expect(block).toContain("## Deadlines");
    expect(block).toContain("DUE TODAY:");
    // Tool names are code, not prose — identical in every language.
    expect(block).toContain("deadline_add fromThreadId t1");
    expect(block).toContain("deadline_dismiss candidateThreadId t1");
  });

  it("deadlinesClause", () => {
    expect(deadlinesClause([deadlineLine()], [], "en")).toEqual([
      "Deadlines are institutional obligations; render them as their own list, never mixed into the reply list.",
      "",
    ]);
  });

  // LAR-22-s3 — vendor/amount/currency are pure data (no translated words), so the same
  // rendering shows up in "en" as in "nb"; this proves it is not accidentally wired only into
  // the nb path.
  it("a renewal row's vendor and amount render the same in en as in nb", () => {
    const block = deadlinesBlock(
      [deadlineLine({ consequence: null, source: "renewal", vendor: "Domeneshop", amount: 199, currency: "NOK" })],
      [],
      "en",
    );
    expect(block).toContain("DUE TODAY: MVA-melding, 3. termin (Heiberg Industries AS) — Domeneshop, 199 NOK [id d1]");
  });
});

describe("BRIEF_STRINGS is exhaustive over BRIEF_LANGUAGES", () => {
  it("has an entry for every supported language", () => {
    for (const lang of BRIEF_LANGUAGES) {
      expect(BRIEF_STRINGS[lang]).toBeDefined();
    }
  });

  it("tool names inside candidateRow are identical across every language", () => {
    for (const lang of BRIEF_LANGUAGES) {
      const row = BRIEF_STRINGS[lang].deadlines.candidateRow("s", "sender", "t1");
      expect(row).toContain("deadline_add fromThreadId t1");
      expect(row).toContain("deadline_dismiss candidateThreadId t1");
    }
  });
});

describe("no Norwegian literal survives outside a comment in lib/brief-content.ts (LAR-16-s2)", () => {
  const source = readFileSync(join(import.meta.dirname, "../lib/brief-content.ts"), "utf8");

  /** Strips block comments (incl. JSDoc) and line comments — good enough for a source file with
   *  no `//`-bearing string literals, which this one has none of. */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  const code = stripComments(source);

  it.each(["SISTE FRIST", "Holdt tilbake", "Mulig frist", "flere frister", 'label: "Frister"'])(
    "%s no longer appears outside a comment",
    (needle) => {
      expect(code).not.toContain(needle);
    },
  );
});

describe("no timezone literal survives outside a comment in lib/brief-content.ts (LAR-16-s4)", () => {
  const source = readFileSync(join(import.meta.dirname, "../lib/brief-content.ts"), "utf8");

  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it('"Europe/Oslo" appears only in comments — every clock read now takes a tz parameter', () => {
    expect(stripComments(source)).not.toContain("Europe/Oslo");
  });

  it("(sanity) the literal still exists SOMEWHERE in the file, as a comment — this guard is not vacuous", () => {
    expect(source).toContain("Europe/Oslo");
  });
});
