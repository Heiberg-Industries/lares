// tests/full-prompt-assembly.test.ts — Fix Wave B review fix (Critical).
//
// Per-piece tests (tests/trip-context.test.ts, tests/instructions-trip-context.test.ts) proved
// the DYNAMIC half (lib/trip-context.ts, agent/instructions/trip-context.ts) is correct on its
// own, and Task 10's own tests proved agent/instructions.md parses. Neither proved the two
// halves make sense TOGETHER — and they didn't: agent/instructions.md's own text told the model
// "The dynamic per-trip sections have no home anywhere in this wave" and "None of these exist
// in this build" for shopping_add/shopping_remove, sentences written when those claims were
// true, that Fix Wave B's own Findings 1 and 4 falsified without anyone updating the static
// file. A real turn would have assembled: a standing instruction saying "you can't see the
// itinerary," immediately followed by the itinerary itself in the dynamic section right after
// it (eve concatenates agent/instructions.md then agent/instructions/*.ts, per
// node_modules/eve/docs/instructions.mdx — root content first, then directory entries). No
// per-piece test could have caught that; only an assembled-together check can.
//
// This file reads the REAL agent/instructions.md off disk (not a fixture copy) so a future
// edit that reintroduces a stale "doesn't exist"/"not available" claim near a capability that
// actually exists gets caught here, not just at "does the file parse" or "is this section's
// text correct in isolation."
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { TripStore, type Trip } from "../lib/trip-store.js";
import { resolveTripContextMarkdown } from "../agent/instructions/trip-context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ORB-278 step 2, Task 5: the persona moved OUT of agent/instructions.md and into
// agent/persona.md, because eve reads a root agent/instructions.md AND agent/instructions/
// TOGETHER (node_modules/eve/docs/instructions.mdx) — leaving it there would have injected the
// whole persona twice once agent/instructions/aa-definition.ts started resolving it at session
// start. The ordering this file asserts is UNCHANGED: `aa-` sorts before `trip-context`, so the
// persona still reaches the model first and the trip context still follows it.
const INSTRUCTIONS_PATH = path.join(__dirname, "..", "agent", "persona.md");

function staticInstructions(): string {
  return fs.readFileSync(INSTRUCTIONS_PATH, "utf8");
}

/** Splits the static file into paragraphs (blank-line-separated) — the unit a stale claim and
 *  its surrounding context actually live in, matching how a reader (human or model) would
 *  encounter a self-contradiction: within the same block of prose, not merely "somewhere in a
 *  4000-word file." */
function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/);
}

/** Old, now-false claims the whole-branch review found: written when true (no dynamic trip
 *  context existed yet, shopping tools weren't ported yet), never updated once Fix Wave B's
 *  Findings 1 and 4 made them false. A regression guard against exactly this bug recurring —
 *  if either literal string ever reappears in agent/instructions.md, something reverted the
 *  fix or a future edit reintroduced the same class of mistake under the same wording. */
const KNOWN_STALE_CLAIMS = [
  /dynamic per-trip sections have no home anywhere in this wave/i,
  /not available to me in conversation right now/i,
  /none of these exist in this build/i,
];

/** Broader, pattern-based guard: any paragraph that talks about one of these capability topics
 *  must not ALSO contain a negation phrase claiming the capability is missing. Scoped to
 *  shopping/trip-context topics specifically — NOT a blanket "no negation anywhere" rule, since
 *  some negations are genuinely accurate and must stay (e.g. `house_location`'s "I have no way
 *  to look up the house's coordinates," which is still true — that tool really was never
 *  ported). This is the generalizable version of the two literal checks above: it would catch a
 *  DIFFERENTLY-WORDED stale claim about the same topics, not just the exact strings that
 *  actually shipped. */
const CAPABILITY_TOPICS = [/shopping_add|shopping_remove|handleliste/i, /dynamic per-trip|trip.?context|itinerary|reiseplan/i];
const NEGATION_MARKERS = [
  /\bnot available\b/i,
  /\bhave no home\b/i,
  /\bnone of these exist\b/i,
  /\bnot carried forward\b/i,
  /\bdoesn'?t exist\b/i,
  /\bdo not exist\b/i,
  /\bsimply not\b.{0,40}\bright now\b/i,
];

function seedTripStore(root: string): { store: TripStore; trip: Trip } {
  const store = new TripStore(root);
  store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1_000_000, trips: [] });
  const trip = store.createTrip({
    slug: "paris-2026",
    name: "Paris",
    start: "2026-07-21",
    end: "2026-07-28",
    timezone: "Europe/Paris",
    destination: { name: "Paris", lat: 48.8566, lon: 2.3522 },
  });
  store.linkChat(trip.slug, "-100123");
  return { store, trip: { ...trip, chatId: "-100123" } };
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-full-prompt-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("full prompt assembly — agent/persona.md + agent/instructions/trip-context.ts together", () => {
  it("the static file never contains the exact stale claims Fix Wave B's own review found", () => {
    const text = staticInstructions();
    for (const claim of KNOWN_STALE_CLAIMS) {
      expect(text).not.toMatch(claim);
    }
  });

  it("no paragraph both names a shopping/trip-context capability AND claims it's missing", () => {
    const text = staticInstructions();
    for (const paragraph of paragraphs(text)) {
      const mentionsTopic = CAPABILITY_TOPICS.some((topic) => topic.test(paragraph));
      if (!mentionsTopic) continue;
      for (const negation of NEGATION_MARKERS) {
        expect(
          negation.test(paragraph),
          `paragraph mentions a shopping/trip-context capability AND a negation marker (${negation}):\n\n${paragraph}`,
        ).toBe(false);
      }
    }
  });

  it("shopping_add/shopping_remove are named as real, callable tools in the static file", () => {
    const text = staticInstructions();
    expect(text).toContain("`shopping_add`");
    expect(text).toContain("`shopping_remove`");
  });

  it("assembled together (static then dynamic, matching eve's own root-then-directory order), the itinerary/bookings/shopping content the dynamic half supplies is never contradicted by a 'not available' claim in the static half", () => {
    const { store, trip } = seedTripStore(root);
    store.write(trip, "itinerary.md", "- 22/07: Louvre");
    store.write(trip, "bookings.md", "SK4705");
    store.write(trip, "shopping.md", "- solkrem");
    store.write(trip, "learned.md", "Pappa hater sopp.");

    const staticText = staticInstructions();
    const dynamicText = resolveTripContextMarkdown(store, trip, Date.now());
    // eve concatenates agent/instructions/*.ts entries in filename order
    // (node_modules/eve/docs/instructions.mdx), and `aa-definition` (the persona) sorts before
    // `trip-context` — so the persona is still first and the trip context still follows it.
    const fullPrompt = `${staticText}\n\n${dynamicText}`;

    // The dynamic half genuinely supplies the content...
    expect(fullPrompt).toContain("Louvre");
    expect(fullPrompt).toContain("SK4705");
    expect(fullPrompt).toContain("- solkrem");
    expect(fullPrompt).toContain("Pappa hater sopp.");

    // ...and the static half never tells the model it can't see any of it.
    for (const claim of KNOWN_STALE_CLAIMS) {
      expect(fullPrompt).not.toMatch(claim);
    }
  });
});
