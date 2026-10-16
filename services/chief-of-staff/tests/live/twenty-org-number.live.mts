/**
 * tests/live/twenty-org-number.live.mts — the LIVE sweep for the ONE Twenty company field
 * `catalogue/twenty_company_for_person.ts` believes holds the organisation number.
 *
 * Per the root AGENTS.md's third-party rule — "a fixture is what we believe an API does; only a live
 * call is what it does." `tests/tools-twenty.test.ts` proves the reading with shaped fixtures; it
 * cannot tell us which field THIS CRM keeps the number in. Twenty has no standard org-number field:
 * each workspace adds its own, so the installation names it in `TWENTY_ORG_NUMBER_FIELD` (default
 * `orgNumber`). Both directions matter:
 *
 *   - a field that is not there reads as "no org number" for every company, silently;
 *   - a field of an unexpected type (an object, a list) also reads as none.
 *
 * So this reads a handful of companies and prints, per company, only its record id, whether the
 * configured field is present, its type, and which other field names mention "org". It prints no
 * company name or value. NOT part of `pnpm test`: it needs the CRM key, which exists only where the
 * chief of staff runs. Run it there, by hand, whenever the field or its reading changes:
 *
 *   cat services/chief-of-staff/tests/live/twenty-org-number.live.mts | \
 *     ssh <user>@<server-address> 'docker exec -i <chief-of-staff-container> sh -c \
 *       "cat > /app/services/chief-of-staff/node_modules/.cache/twenty-org-number.live.mts"'
 *   ssh <user>@<server-address> 'docker exec <chief-of-staff-container> sh -c \
 *     "cd /app/services/chief-of-staff && \
 *      export \$(tr \"\\0\" \"\\n\" < /proc/1/environ | grep -E \"^(TWENTY_|EGRESS_PROXY_URL)\" | xargs) && \
 *      /app/node_modules/.bin/tsx node_modules/.cache/twenty-org-number.live.mts"'
 *   ssh <user>@<server-address> 'docker exec <chief-of-staff-container> rm -f /app/services/chief-of-staff/node_modules/.cache/twenty-org-number.live.mts'
 *
 * Read-only: one GET of up to five companies.
 */
import { twentyGet } from "../../lib/twenty-client.js";
import { orgNumberField } from "../../catalogue/twenty_company_for_person.js";

const field = orgNumberField();
const body = await twentyGet<{ data?: { companies?: Array<Record<string, unknown>> } }>("/companies?limit=5");
const companies = body?.data?.companies ?? [];

console.log(`configured field: ${field} (TWENTY_ORG_NUMBER_FIELD ${process.env["TWENTY_ORG_NUMBER_FIELD"] ? "set" : "unset, default"})`);
console.log(`companies read  : ${companies.length}`);
for (const c of companies) {
  const value = c[field];
  const present = field in c;
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const orgLike = Object.keys(c).filter((k) => /org/i.test(k) && k !== field);
  console.log(`- ${String(c["id"])}: present=${present} type=${kind} filled=${kind === "string" ? value !== "" : kind === "number"} other org-like fields=[${orgLike.join(", ")}]`);
}
