// Everything Saga holds about one person, in one call — CRM, relationship warmth, mail,
// meetings, transcripts, and company, fanned out over every source and reported per-source
// (found/empty/failed/not-applicable — see lib/person/types.ts).
//
// Ported from `services/agent-runtime/lib/adapters/hands/person.ts` (Task 8): description and
// schema copied verbatim; the fan-out/merge/render logic lives in `lib/person/` (ported
// verbatim) and `lib/person-sources.ts` (the eve-saga-specific rewiring). Read-only, no
// approval gate — matches the old hand.
//
// W3A-s5 (beyond the slice's own file list — found auditing the catalogue for the register-
// completeness test, tests/origin-taint-reads.test.ts). `lib/person-sources.ts`'s `mail` source
// is `googleClients().gmail().search`/`.read` — the exact same primitive `gmail_read.ts`/
// `gmail_search.ts` taint — and `lib/person/render.ts:35` renders each mail item's `subject`
// verbatim into the dossier text this tool returns. That is third-party prose by the same rule
// those two tools taint on, reached through a different call site, so it taints identically:
// `third_party` whenever the mail source found anything. Not a new design — the same primitive,
// applied where the audit found it missing.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { taintTurn, turnKeyFrom } from "@lares/agent-kit/origin-taint";
import { gatherPerson } from "../lib/person/gather.js";
import { renderDossier } from "../lib/person/render.js";
import { eveSagaPersonWiring, makePersonSources } from "../lib/person-sources.js";

// Constructed once, at module scope: `makePersonSources` does no I/O itself — it only closes
// over function references (lib/google.ts, lib/twenty-client.ts, etc. each already read their
// own secrets/env lazily per call, never at construction) — matching the laziness discipline
// documented in lib/google.ts.
const sources = makePersonSources(eveSagaPersonWiring());

export default defineTool({
  description:
    "Everything you hold about one person, in one call: CRM state, relationship warmth, mail, " +
    "meetings, what they actually said in meeting transcripts, and their company. Pass `email` " +
    "when you have it — it is exact; `name` otherwise. Use this for ANY question about a person " +
    "('what's the deal with Lars', 'who is this', 'should I chase them') instead of calling " +
    "twenty/network/gmail/calendar/brain separately.\n" +
    "Read the result carefully: it names the LAST ENGAGEMENT and splits everything into NEW SINCE " +
    "and EARLIER — lead with what is new, and only give the full history when there is little else. " +
    "It also lists every source it consulted, and the time windows it searched — 'nothing found' " +
    "always means nothing in that window, never nothing ever. A source marked COULD NOT READ is a " +
    "gap in your reading, NOT an absence in the world — say that, never 'nothing found'. A source " +
    "marked 'not searchable this way' is a third thing again: that question cannot be put to it in " +
    "this form, which is neither a failure nor an absence. If it comes back AMBIGUOUS, ask him which " +
    "person he means; never pick one.\n" +
    "A partial `name` works — 'Lars' finds the record for 'Lars Eriksen' when he is the only match. " +
    "The result then says MATCHED LOOSELY, and you must pass that on in a clause so he can correct you.\n" +
    "When Bendik tells you two addresses belong to the SAME person (someone who changed jobs), pass " +
    "BOTH in `emails` and you get one combined view across both mailboxes.",
  inputSchema: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    emails: z.array(z.string()).optional(),
  }),
  async execute({ name, email, emails }, ctx) {
    // Fanning out on an empty query would return "unknown" for a question nobody asked.
    if (!name && !email && !(emails && emails.length)) throw new Error("person_lookup needs a name or email");
    const dossier = await gatherPerson(
      { ...(name ? { name } : {}), ...(email ? { email } : {}), ...(emails && emails.length ? { emails } : {}) },
      sources,
    );
    if (dossier.sources.mail.status === "found") {
      const k = turnKeyFrom(ctx);
      if (k) taintTurn(k, "third_party");
    }
    return renderDossier(dossier);
  },
});
