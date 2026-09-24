/**
 * A tripwire for ADR-0018 ("Agents learn by adding; consolidation proposes, never edits in
 * place; third-party content never becomes memory"), rule 4. Until W4C-s2 the dream-cycle
 * promoter (`lib/dream/promote.ts`) promoted a low-confidence observation once it RECURRED, with
 * no regard for where the observation's text came from. The gate it now calls
 * (`@lares/agent-kit/learning`) counts recurrence only across owner-originated observations, and
 * never promotes a third-party-, synced- or system-origin observation at all, at any recurrence.
 *
 * THE ATTACK THIS STANDS FOR ("prompt laundering", `docs/research/2026-09-18-prelaunch/
 * 10-practitioner-sweep.md`, citing IronCore Labs 2026-08-26): an attacker sends the SAME email
 * three times. Each pass through the dream cycle extracts the same low-confidence observation.
 * The promoter never asked who said it — only whether it has been seen before — so on the second
 * occurrence "recurring" was true and the observation was promoted into long-term memory. Every
 * later process that reads preferences then trusts a fact planted by a third party, laundered
 * through nightly consolidation into something that reads as learned about the owner.
 *
 * HISTORY, kept because it is the point of the file. When this test was written, `Observation`
 * (`lib/dream/reflect.ts`) had NO origin field — ADR-0018's rule 1 precondition, not yet built —
 * so test B could not literally mark an observation `third_party` and put the third-party nature
 * in its text and subject instead, the most realistic stand-in that type allowed. W4C-s1 added
 * the field, computed by code from the turns an observation cites, and test B now says
 * `origin: "third_party"` outright.
 *
 * Test A is the safe case throughout: a single observation the owner made once is held, never
 * promoted. It stayed green across the change.
 *
 * Test B is the unsafe case ADR-0018 exists to close, and it was `it.fails` (vitest passes an
 * `it.fails` test only while its body FAILS) from the day it was written until **W4C-s2,
 * 2026-09-19**, when the promotion gate moved into `@lares/agent-kit/learning` and stopped
 * trusting confidence and bare recurrence. On that change the body started passing, vitest
 * reported the `it.fails` as a failure — the flip this file was built to signal — and `.fails`
 * was deleted in the same commit. It has been an ordinary assertion ever since: the three
 * identical third-party observations are rejected `not-owner-origin`, and nothing is promoted.
 * Do not delete the test itself; that would delete the guard this whole file exists to be.
 */
import { describe, it, expect } from "vitest";

import { makePromoter, PROMOTE_CONFIDENCE, type PromoterStore } from "../lib/dream/promote.js";
import { normalizeObservationText, type PreferenceRow, type PreferenceInput } from "../lib/dream/store.js";
import type { Observation } from "../lib/dream/reflect.js";
import type { Origin } from "@lares/agent-kit/origin";

/** An in-memory `PromoterStore` — the same structural-fake convention `dream-cycle.test.ts`'s
 *  `fakeBrain` uses (a plain in-memory object, no real Postgres; see that file's own header
 *  comment). Close enough to `lib/dream/store.ts`'s real `makeDreamStore()` to exercise the real
 *  recurrence (`ownerRecurrenceCount`/`record`) and contradiction (`activePreferences`/
 *  `supersede`) logic rather than stubbing it away — including the part that matters here: the
 *  count is per ORIGIN, so a repetition by somebody else raises nobody's total. */
function fakeStore(): PromoterStore & { preferences: PreferenceRow[] } {
  const recorded: Array<{ norm: string; origin: Origin }> = [];
  const preferences: PreferenceRow[] = [];
  let nextId = 0;

  return {
    preferences,
    async record(obs: Observation, _source: string | undefined, origin: Origin): Promise<void> {
      recorded.push({ norm: normalizeObservationText(obs.text), origin });
    },
    async addPreference(pref: PreferenceInput): Promise<PreferenceRow> {
      const now = new Date().toISOString();
      const row: PreferenceRow = {
        id: `pref-${++nextId}`,
        text: pref.text,
        kind: pref.kind,
        subject: pref.subject,
        confidence: pref.confidence,
        source: pref.source ?? null,
        origin: pref.origin,
        valid_from: now,
        valid_to: null,
        superseded_by: null,
        created_at: now,
      };
      preferences.push(row);
      return row;
    },
    async activePreferences(): Promise<PreferenceRow[]> {
      return preferences.filter((p) => p.valid_to === null);
    },
    async supersede(id: string, byId: string): Promise<void> {
      const row = preferences.find((p) => p.id === id);
      if (row) {
        row.valid_to = new Date().toISOString();
        row.superseded_by = byId;
      }
    },
    async ownerRecurrenceCount(text: string): Promise<number> {
      const norm = normalizeObservationText(text);
      return recorded.filter((r) => r.norm === norm && r.origin === "owner").length;
    },
  };
}

describe("dream-cycle promotion baseline (ADR-0018 tripwire)", () => {
  it("a low-confidence observation seen once is held, not promoted", async () => {
    const store = fakeStore();
    const promoter = makePromoter({ store });

    const obs: Observation = {
      text: "the owner wants the quarterly board update moved up a week",
      kind: "decision",
      subject: "board update timing",
      confidence: PROMOTE_CONFIDENCE - 0.2,
      evidenceRefs: ["2026-09-18T09:00:00.000Z"],
      // The owner's own words, said once. Held — which is now true at ANY confidence, not just
      // a low one; `tests/learning-promote.test.ts` pins the 0.99 case.
      origin: "owner",
    };

    const result = await promoter.run([obs]);

    expect(result.promoted).toEqual([]);
    expect(result.held.map((o) => o.text)).toEqual([obs.text]);
  });

  // See this file's header comment for what this proves and when it stopped being `.fails`.
  it(
    "a low-confidence observation lifted from a third party's email is NOT promoted merely because it recurs",
    async () => {
      const store = fakeStore();
      const promoter = makePromoter({ store });

      // The same text three times, standing in for the same phishing email sent three times.
      // Since W4C-s1 the observation can say so itself — `origin` is computed by code from the
      // turns it cites — so the third-party nature is now in the field the gate reads, not only
      // in the wording (see header comment).
      const text =
        "An email from billing@vendor-example.com says the owner agreed to switch the company " +
        "to annual prepay";
      const subject = "third-party email: vendor-example.com billing claim";
      const makeObs = (at: string): Observation => ({
        text,
        kind: "fact",
        subject,
        confidence: PROMOTE_CONFIDENCE - 0.3,
        evidenceRefs: [at],
        origin: "third_party",
      });

      const observations = [
        makeObs("2026-09-16T08:00:00.000Z"),
        makeObs("2026-09-17T08:00:00.000Z"),
        makeObs("2026-09-18T08:00:00.000Z"),
      ];

      const result = await promoter.run(observations);

      // Until W4C-s2 this line failed: the second occurrence promoted on recurrence alone.
      // That failure is what this test was built to pin — see the header comment.
      expect(result.promoted).toEqual([]);
      // And the run can say WHY, in a value a report can count rather than prose it has to
      // parse (ADR-0018 rule 6).
      expect(result.rejected.map((r) => r.reason)).toEqual([
        "not-owner-origin",
        "not-owner-origin",
        "not-owner-origin",
      ]);
    },
  );
});
