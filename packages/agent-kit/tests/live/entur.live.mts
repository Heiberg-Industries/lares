/**
 * tests/live/entur.live.mts — the LIVE sweep for the Entur geocoder guard (ORB-168).
 *
 * NOT part of `pnpm test`, and deliberately so: it calls the real api.entur.io. Run it by hand
 * whenever you touch `resolvePlace`, `geocoderUnderstood`, or anything they lean on:
 *
 *     npx tsx packages/agent-kit/tests/live/entur.live.mts
 *
 * WHY THIS FILE EXISTS AT ALL. Entur's geocoder does not answer "no match" for a foreign place —
 * it answers with a fuzzy NORWEGIAN one carrying country_a "NOR". Marcel routes on that field.
 * The bug shipped three times, on 858, 860 and 288 green tests, because every fixture encoded the
 * assumption that a foreign query comes back foreign. Each leak was found by a sweep like this
 * one and by nothing else — and for four rounds the sweep lived in a scratchpad and was rebuilt
 * from scratch each time. See docs/solutions/2026-08-25-entur-geocoder-is-norway-biased.md and
 * the "Third-party APIs" section of the root CLAUDE.md.
 *
 * IT MUST COVER BOTH DIRECTIONS. Every round that fixed the leak broke the over-rejection or the
 * reverse; only a sweep carrying both sets catches that. An over-rejection is a real Norwegian
 * journey Bendik cannot ask about, and it surfaces as "not found", which reads like the place
 * does not exist.
 *
 * Exit code is 0 only when there are no over-rejections and no undisclosed leaks. The three
 * accepted residuals are listed explicitly and reported separately — never folded into a pass.
 */
import { makeEntur, EnturPlaceNotFoundError } from "../../src/entur-client.js";

const entur = makeEntur({ fetch: globalThis.fetch });

/** Real Norwegian places that MUST resolve. Includes the shapes each fix round broke:
 *  an alias (Gardermoen -> Oslo lufthavn), definite-form variation (Majorstua -> Majorstuen),
 *  the single-word Oslo metro set, an all-generic name (Sentrum), and a POI-only island. */
const MUST_RESOLVE = [
  "Oslo S", "Tønsberg stasjon", "Tonsberg stasjon", "Storgaten 32, Tønsberg",
  "Storgata 32, Tønsberg", "Bergen stasjon", "Trondheim S", "Gardermoen", "Lillehammer",
  "Kristiansand", "Ålesund", "Færder", "Oslo Bussterminal", "Majorstua", "Frognerseter",
  "Majorstuen", "Scandic Fornebu", "Thon Hotel Opera", "Radisson Blu Plaza Oslo", "Youngstorget",
  "Nøtterøy", "Sentrum", "Bussterminalen", "Flyplassen", "Torp lufthavn", "Nationaltheatret",
  "Skøyen", "Lysaker", "Drammen stasjon", "Stavanger", "Sandvika", "Ski stasjon", "Holmenkollen",
  "Voss", "Åndalsnes", "Røros", "Hamar", "Bislett", "Storo", "Tøyen", "Vestli", "Jernbanetorget",
  "Oslo sentralstasjon",
];

/** Foreign queries that must NOT come back as a Norwegian place. notFound is a pass — the caller
 *  routes to Google. "Grand Central Terminal" is the production incident that forced the rollback;
 *  the three "Central Station" forms are the corroboration leak round 2 introduced. */
const MUST_NOT_BE_NOR = [
  "Gare du Nord, Paris", "Eiffel Tower", "Paris", "Madrid Atocha", "Shibuya Station, Tokyo",
  "Grand Central Terminal, New York", "Grand Central Terminal", "Central Station Amsterdam",
  "Amsterdam Central Station", "Central Station Berlin", "Central Station", "Amsterdam", "Tokyo",
  "Colosseum, Rome", "Times Square, New York", "JFK Airport", "London", "Nice", "Rome",
  "Son brygge", "Milano", "Napoli", "Capri", "Toscana",
];

/** Foreign stops Entur genuinely knows. Non-NOR is the right answer — the caller sends these to
 *  Google. Note they carry real NSR: ids: the register covers international rail and coach, which
 *  a fixture comment once denied as "measured" fact. */
const MUST_BE_FOREIGN = ["Berlin Hauptbahnhof", "Göteborg C", "Stockholm Central", "København H"];

/** Known, accepted, documented. Reported separately so a pass is never quietly a leak. */
const RESIDUALS = new Set(["Hotel", "Malaga", "Sentralstasjonen"]);

let over = 0;
let leaks = 0;

console.log("--- MUST RESOLVE (Norwegian) ---");
for (const q of MUST_RESOLVE) {
  try {
    const p = await entur.resolvePlace(q);
    console.log(`  ok           ${q} -> ${p.name} [${p.locality ?? "-"}/${p.countryA}]`);
  } catch (e) {
    over++;
    console.log(`  OVER-REJECT  ${q} -> ${(e as Error).message.slice(0, 100)}`);
  }
}

console.log("\n--- MUST NOT resolve to a Norwegian place ---");
for (const q of MUST_NOT_BE_NOR) {
  try {
    const p = await entur.resolvePlace(q);
    if (p.countryA === "NOR") {
      leaks++;
      console.log(`  LEAK         ${q} -> ${p.name} [${p.locality ?? "-"}/NOR]`);
    } else {
      console.log(`  ok           ${q} -> ${p.name} [${p.countryA}] (foreign -> Google)`);
    }
  } catch (e) {
    if (e instanceof EnturPlaceNotFoundError) console.log(`  ok           ${q} -> notFound -> Google`);
    else { leaks++; console.log(`  UNEXPECTED   ${q} -> ${(e as Error).name}`); }
  }
}

console.log("\n--- MUST resolve as FOREIGN (non-NOR is correct) ---");
for (const q of MUST_BE_FOREIGN) {
  try {
    const p = await entur.resolvePlace(q);
    if (p.countryA === "NOR") { leaks++; console.log(`  LEAK         ${q} -> ${p.name} [NOR]`); }
    else console.log(`  ok           ${q} -> ${p.name} [${p.countryA}] id=${p.id}`);
  } catch {
    console.log(`  note         ${q} -> notFound (acceptable: routes to Google)`);
  }
}

console.log("\n--- ACCEPTED RESIDUALS (documented; a change here is news either way) ---");
for (const q of RESIDUALS) {
  try {
    const p = await entur.resolvePlace(q);
    console.log(`  residual     ${q} -> ${p.name} [${p.locality ?? "-"}/${p.countryA}]`);
  } catch {
    console.log(`  residual     ${q} -> notFound`);
  }
}

console.log(`\n=== over-rejections=${over}  leaks=${leaks} ===`);
if (over > 0 || leaks > 0) {
  console.log("FAIL — see docs/solutions/2026-08-25-entur-geocoder-is-norway-biased.md before adding another clause.");
  process.exit(1);
}
console.log("ALL GOOD (residuals above are known and accepted)");
