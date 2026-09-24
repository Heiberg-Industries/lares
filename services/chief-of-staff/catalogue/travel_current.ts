// Today's trip, as Marcel already resolved it (ORB-169). A pure read of his store through
// lib/travel-store.ts — the allowlist and the containment check live there, not in this
// description, so nothing a model asks for can widen what this returns.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { osloDate } from "../lib/recurrence.js";
import { DEFAULT_HORIZON_DAYS, currentTravel } from "../lib/travel-store.js";

export default defineTool({
  description:
    "What travel Bendik is on right now, from MARCEL's trip records — the travel concierge " +
    "who files his hotel, flight and car reservations from the confirmation mails. This is " +
    "the itinerary he already resolved, not your reconstruction of it: it knows the SPAN of " +
    "a stay, so a hotel booked for four nights is his bed on every one of them, not only on " +
    "the day it was booked.\n\n" +
    "Takes no arguments — it answers for today, plus any trip starting within the next week. " +
    "Returns the trip's dates and destination, where he sleeps (`lodging`), how he moves " +
    "(`transport`), and his own trip notes. An empty `trips` list means he is not travelling, " +
    "which is the normal case; if `unavailable` is set, Marcel's store could not be READ — " +
    "say that, and never report it as 'no travel'.\n\n" +
    "`other` holds reservations Marcel filed that are neither a bed nor a recognised leg — a " +
    "dinner, an activity, and TODAY also a train or a ferry, because his classifier has no " +
    "such category yet. So do not conclude from an empty `transport` that he is not moving: " +
    "check `other`, and describe what you find there as the reservation it says it is, never " +
    "as a confirmed journey with a platform.\n\n" +
    "READ-ONLY. These are Marcel's records and there is no way to change them from here. Do " +
    "NOT copy any of it into the Brain — Marcel owns this data, and a second copy is a second " +
    "version of the truth. Quote a booking's own summary line rather than paraphrasing it.",
  inputSchema: z.object({}),
  async execute() {
    // Oslo's day boundary, the fleet-wide convention — and the same clock Marcel resolves the
    // current trip on, so the two agents cannot disagree about which day it is (see
    // lib/travel-store.ts's header, point 5).
    //
    // The horizon is passed EXPLICITLY even though it is the default: the night-before hotel
    // — a stay on the 24th belonging to a trip starting the 25th — is the whole motivating
    // case, and it must be visible at the call site that this tool reaches past today.
    return currentTravel(osloDate(new Date()), { horizonDays: DEFAULT_HORIZON_DAYS });
  },
});
