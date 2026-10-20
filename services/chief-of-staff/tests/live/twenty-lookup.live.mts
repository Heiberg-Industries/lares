/**
 * tests/live/twenty-lookup.live.mts — the LIVE check for how the CRM people lookup filters.
 *
 * Per the root AGENTS.md's third-party rule — "a fixture is what we believe an API does; only a live
 * call is what it does." `tests/tools-twenty.test.ts` proves the query shapes against a fake server;
 * it cannot tell us what THIS Twenty does with them. This checks, read-only:
 *
 *   1. `ilike` with the one-character wildcard `_` through the REST filter (does `gl_ck` find
 *      both "Gluck" and "Glück"?), by running the lookup's own queries for each sample term;
 *   2. whether a filter on ADDITIONAL emails (`emails.additionalEmails[ilike]`) is accepted. The
 *      lookup leaves additional emails out until this shows it works; if it prints
 *      "additional emails filter: ACCEPTED", a follow-up change can add it;
 *   3. the hits (record id and name, ranked as the tool ranks them) for up to three sample terms.
 *
 * It prints person names for the terms you pass, so run it only where you can see the output
 * privately. NOT part of `pnpm test`: it needs the CRM key, which exists only where the chief of
 * staff runs. Run it there, by hand, passing the sample terms on the command line (a name with an
 * accent, a name with an extra middle name, an email address):
 *
 *   cat services/chief-of-staff/tests/live/twenty-lookup.live.mts | \
 *     ssh <user>@<server-address> 'docker exec -i <chief-of-staff-container> sh -c \
 *       "cat > /app/services/chief-of-staff/node_modules/.cache/twenty-lookup.live.mts"'
 *   ssh <user>@<server-address> 'docker exec <chief-of-staff-container> sh -c \
 *     "cd /app/services/chief-of-staff && \
 *      export \$(tr \"\\0\" \"\\n\" < /proc/1/environ | grep -E \"^(TWENTY_|EGRESS_PROXY_URL)\" | xargs) && \
 *      /app/node_modules/.bin/tsx node_modules/.cache/twenty-lookup.live.mts \"First Middle Last\" \"Müller\" \"someone@example.com\""'
 *   ssh <user>@<server-address> 'docker exec <chief-of-staff-container> rm -f /app/services/chief-of-staff/node_modules/.cache/twenty-lookup.live.mts'
 *
 * Read-only: GET requests only (a few per sample term, plus one for the additional-emails filter).
 */
import { twentyGet } from "../../lib/twenty-client.js";
import { buildLookupQueries, twentyLookup } from "../../catalogue/twenty_lookup.js";

const terms = process.argv.slice(2).slice(0, 3);
if (terms.length === 0) {
  console.error('usage: twenty-lookup.live.mts "<name>" ["<name with accent>" ["<email>"]]');
  process.exit(2);
}

for (const term of terms) {
  console.log(`\n== term: ${JSON.stringify(term)}`);
  for (const q of buildLookupQueries(term)) {
    try {
      const body = await twentyGet<{ data?: Record<string, unknown[]> }>(q.path);
      const rows = Object.values(body?.data ?? {})[0] ?? [];
      console.log(`  ${decodeURIComponent(q.path)} -> ${rows.length} rows`);
    } catch (err) {
      console.log(`  ${decodeURIComponent(q.path)} -> FAILED: ${(err as Error).message}`);
    }
  }
  const result = await twentyLookup(term);
  console.log(`  ranked hits (${result.people.length}):`);
  for (const p of result.people) console.log(`    ${p.id}  ${p.name}`);
}

console.log("\n== additional emails filter");
try {
  const path = `/people?filter=${encodeURIComponent("emails.additionalEmails[ilike]:%@%")}&limit=1`;
  const body = await twentyGet<{ data?: { people?: unknown[] } }>(path);
  console.log(`additional emails filter: ACCEPTED (${body?.data?.people?.length ?? 0} rows)`);
} catch (err) {
  console.log(`additional emails filter: REJECTED (${(err as Error).message})`);
}
