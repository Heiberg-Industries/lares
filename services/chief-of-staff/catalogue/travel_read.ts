// One file of one trip from Marcel's store (ORB-169), for when the structured view from
// travel_current is not enough — the raw confirmation text, a cancellation policy, his own
// notes. The three readable names are the allowlist in lib/travel-store.ts; asking for
// anything else is refused there, not filtered out here.
//
// W3A-s5 (beyond the slice's own file list — found auditing the catalogue for the register-
// completeness test, tests/origin-taint-reads.test.ts). `trip.md` and `itinerary.md` are the
// owner's/Marcel's own notes and plan; `bookings.md` is different — lib/travel-store.ts's own
// header calls it "every filed reservation with the confirmation's own wording", and this
// file's tool description tells the model to "quote the booking's own words". That is a
// vendor's third-party text, filed once and read back here, so reading `bookings.md`
// specifically taints the turn `third_party`
// (docs/specs/2026-09-18-origin-model-design.md, "The in-turn taint rule"); the other two files
// do not.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { taintTurn, turnKeyFrom } from "@lares/agent-kit/origin-taint";
import { READABLE_TRIP_FILES, readTripFile } from "../lib/travel-store.js";

export default defineTool({
  description:
    "Read one file of one of MARCEL's trips, by the trip's slug (get slugs from " +
    "travel_current). Exactly three files are readable:\n" +
    "- `trip.md` — the trip's own notes\n" +
    "- `itinerary.md` — the day-by-day plan; usually EMPTY, which is normal, not an error\n" +
    "- `bookings.md` — every filed reservation with the confirmation's own wording\n\n" +
    "Everything else in Marcel's store is family-private and refused: his learned notes, the " +
    "family group chat and shopping list, his voice overlay. Do not try to reach them by " +
    "another path — you will get the same refusal, and there is no version of that request " +
    "that succeeds.\n\n" +
    "READ-ONLY. These are Marcel's records; you cannot change them and must NOT copy them " +
    "into the Brain. When you cite a cancellation or change policy, quote the booking's own " +
    "words — a paraphrase is how a wrong 'yes, you can move that' gets said.",
  inputSchema: z.object({
    slug: z.string().describe('The trip\'s slug, e.g. "the-big-apple" — from travel_current'),
    file: z.enum(READABLE_TRIP_FILES).describe("Which of the three readable files to return"),
  }),
  async execute({ slug, file }, ctx) {
    const result = readTripFile(slug, file);
    if (file === "bookings.md") {
      const k = turnKeyFrom(ctx);
      if (k) taintTurn(k, "third_party");
    }
    return result;
  },
});
