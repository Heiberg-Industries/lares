/**
 * Entur — Norwegian public-transport journey planning (ORB-168). No API key is required, only a
 * client-identification header (`ET-Client-Name`); confirmed live against the real API on
 * 2026-08-25 (geocoder + `trip` GraphQL query, including `arriveBy`, which this file confirmed
 * by a live introspection + live call rather than trusting the ticket's guess at its name).
 *
 * POSTURE mirrors orakel-client.ts: a typed `Unavailable` error for anything that is not a real
 * answer, a second typed error for "the geocoder legitimately found nothing" (a genuine 200, not
 * an outage), nothing read at module scope, and a client built from injected config. Here `fetch`
 * itself is injected too (not just credentials) — Entur needs no secret, so the only thing left to
 * inject for testability is the transport, which is what lets the test suite run entirely off
 * recorded fixtures with zero live network.
 *
 * THE SECOND TRAP, found on the deployed system after ORB-168 shipped: the geocoder is
 * NORWAY-BIASED and does not answer "no match" for a foreign place — it answers a fuzzy
 * NORWEGIAN one carrying `country_a: "NOR"`. Measured live on 2026-08-25 from inside
 * agent-box-eve-marcel-1: "Gare du Nord, Paris" → `{ name: "Olav Duuns gate", layer: "address",
 * country_a: "NOR", id: "KVE:TopographicPlace:1820-Olav Duuns gate" }`. "Eiffel Tower" correctly
 * returned zero features and "Berlin Hauptbahnhof" correctly returned `country_a: "DEU"`, so the
 * behaviour is inconsistent rather than uniformly wrong — which is why it survived a suite whose
 * foreign-place fixtures all assumed the well-behaved shapes. `country_a` is exactly what
 * eve-marcel's Norway detection keys off, so that one guess sent a PARIS journey to Entur's
 * planner instead of Google. There is no confidence or match_type to lean on (the geocoder runs
 * Photon; both are null on the live responses), so `resolvePlace` judges whether the geocoder
 * UNDERSTOOD the question — a whole word in common between the query and the result set, read
 * across the returned features rather than off the one that is returned — and treats a guess as
 * NOT RESOLVED: the same `EnturPlaceNotFoundError` a zero-feature response already raises, so
 * every caller's existing not-found handling applies unchanged. `geocoderUnderstood` carries the
 * rule and the two live cases ("Gardermoen" → "Oslo lufthavn", a correct alias that must survive;
 * "Paris" → "Parisbudalsveien", noise that must not) that shape it.
 *
 * THE TRAP THIS FILE EXISTS TO CLOSE: `POST /journey-planner/v3/graphql` with a wrong or guessed
 * place id returns `{"data":{"trip":{"tripPatterns":[]}}}` at HTTP 200 — indistinguishable from a
 * real "no journeys today" answer by status code alone. `plan()` therefore never accepts raw text
 * for `from`/`to`; only a place already resolved by `resolvePlace()` (its `id`, or a `{lat,lon}`
 * pair) is accepted, so an empty `tripPatterns` coming back from `plan()` is always a real answer.
 */

const GEOCODER_URL = "https://api.entur.io/geocoder/v1/autocomplete";
const JOURNEY_PLANNER_URL = "https://api.entur.io/journey-planner/v3/graphql";

/** Defined in exactly one place — the ticket's own requirement. The extension's `transit` config
 *  key (Task 2, `extension/extension.ts`) may override it via `EnturClientConfig.clientName`. */
const DEFAULT_CLIENT_NAME = "lares";

/** How long ONE Entur request may take before it is aborted and reported as unavailable.
 *  Matches `services/travel/lib/transit.ts`'s `AbortSignal.timeout(8000)` on the Google
 *  client it sits beside, so the two providers behave the same way under a dead hop.
 *
 *  This bound is not optional politeness. Every caller here is sealed behind the shared squid
 *  container and reaches Entur through `createTelegramFetch()`'s undici `ProxyAgent`, whose
 *  headers timeout is MINUTES long: a hop that accepts the connection and then says nothing
 *  would hang a live Telegram or Slack turn until undici gave up. Aborting does not weaken the
 *  typed-unavailable posture — an aborted fetch throws, `resolvePlace`/`plan` wrap that into
 *  `EnturUnavailableError` exactly as they wrap a refused connection, so the caller gets the
 *  same "Entur was unreachable" it would have got, in seconds instead of minutes. */
const DEFAULT_TIMEOUT_MS = 8000;

/** Thrown on a network failure, a non-2xx status, a GraphQL `errors` array, or a malformed body —
 *  for both the geocoder and the journey planner. The message always says Entur was unreachable;
 *  it must never be read as "there are no departures" (that is a real 200, see `plan`). */
export class EnturUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EnturUnavailableError";
  }
}

/** No usable place for this text — a genuine 200 answer ("no such place"), never to be confused
 *  with an outage. `plan()` must never be handed raw text for this reason; a caller that failed
 *  to resolve a place gets this error, not an empty itinerary list.
 *
 *  TWO responses produce it, deliberately the SAME outcome: zero features, and a feature whose
 *  name bears no relation to what was asked (the Norway-biased guess described in the module
 *  header). `rejected` carries the name that was thrown away in the second case — diagnostics
 *  only, so a box log says "Paris → Olav Duuns gate, discarded" instead of a bare miss; no
 *  caller branches on it, and every caller's not-found path stays exactly as it was. */
export class EnturPlaceNotFoundError extends Error {
  constructor(
    readonly query: string,
    /** The unrelated name the geocoder offered, when that is why this was raised. */
    readonly rejected?: string,
  ) {
    super(
      rejected === undefined
        ? `Entur: no place found for "${query}"`
        : `Entur: no place found for "${query}" (the geocoder offered "${rejected}", which is unrelated)`,
    );
    this.name = "EnturPlaceNotFoundError";
  }
}

export interface ResolvedPlace {
  /** The geocoder's `properties.id` for the chosen feature, but ONLY when it is `NSR:…`-prefixed
   *  (a stop/venue) — the journey planner's `place` argument does not understand any other id
   *  scheme (verified live: an address's non-`NSR:` id round-tripped into `plan({from:{id}}})`
   *  silently produced `tripPatterns: []` at HTTP 200 — the exact trap this file exists to
   *  close). For anything else (an address, or any result without an `NSR:` id) this is `null`,
   *  which is enforced here rather than left to a comment: `PlaceInput`'s `id` branch requires a
   *  plain `string`, so `{ id: place.id }` on a null id is a TypeScript compile error, not a
   *  runtime surprise — `lat`/`lon` (always present) is the only path left for those places. */
  id: string | null;
  name: string;
  locality: string | null;
  county: string | null;
  /** ISO 3166-1 alpha-3, e.g. "NOR" — what Task 3's Norway detection keys off. */
  countryA: string | null;
  lat: number;
  lon: number;
}

/** A place already resolved by `resolvePlace`, or a raw coordinate pair — never raw user text.
 *  The `id` branch takes a plain `string`, never `string | null`, on purpose: `ResolvedPlace.id`
 *  is nullable specifically so a non-`NSR:` result (`id: null`) cannot be spread into this branch
 *  without a compile error, forcing the caller onto `{ lat, lon }` instead. */
export type PlaceInput = { readonly id: string } | { readonly lat: number; readonly lon: number };

export interface PlanLeg {
  mode: string;
  linePublicCode: string | null;
  lineName: string | null;
  fromPlaceName: string | null;
  toPlaceName: string | null;
  /** `fromEstimatedCall.quay.publicCode` — often null (no quay assignment); always optional. */
  platform: string | null;
  aimedDepartureTime: string | null;
  expectedDepartureTime: string | null;
  /** `expectedDepartureTime − aimedDepartureTime`, in seconds; positive = running late. This IS
   *  the real-time delay — computed here so no caller ever subtracts timestamps itself. Null
   *  when either timestamp is missing. */
  delaySeconds: number | null;
}

export interface TripPattern {
  expectedStartTime: string;
  expectedEndTime: string;
  /** seconds */
  duration: number;
  legs: PlanLeg[];
}

export interface PlanArgs {
  from: PlaceInput;
  to: PlaceInput;
  /** ISO-8601 with offset. */
  dateTime: string;
  /** `true` = "arrive by `dateTime`"; omitted/`false` = "depart after `dateTime`". Confirmed as
   *  the `trip` query's exact argument name via live introspection (`Query.trip.args`) and a live
   *  call on 2026-08-25 — not taken from the plan. */
  arriveBy?: boolean;
  numTripPatterns?: number;
}

export interface EnturClientConfig {
  /** Defaults to `DEFAULT_CLIENT_NAME`. */
  clientName?: string;
  /** Injected so the test suite never touches the network. */
  fetch: typeof fetch;
  /** Per-request bound, defaulting to `DEFAULT_TIMEOUT_MS`. Configuration rather than a magic
   *  number so a mount site on a slow path can raise it — and so a test can drop it to
   *  milliseconds and prove the abort really fires. */
  timeoutMs?: number;
}

/** Per-call transport options. A caller that runs several requests under ONE overall budget
 *  (eve-marcel's `transit_directions` geocodes two endpoints under a single deadline) passes its
 *  own signal here; it is combined with this client's per-request timeout, so whichever fires
 *  first wins and neither can be defeated by the other. */
export interface EnturCallOptions {
  signal?: AbortSignal;
}

function locationOf(place: PlaceInput): Record<string, unknown> {
  if ("id" in place) return { place: place.id };
  return { coordinates: { latitude: place.lat, longitude: place.lon } };
}

const TRIP_QUERY = `
  query Trip($from: Location!, $to: Location!, $dateTime: DateTime, $arriveBy: Boolean, $numTripPatterns: Int) {
    trip(from: $from, to: $to, dateTime: $dateTime, arriveBy: $arriveBy, numTripPatterns: $numTripPatterns) {
      tripPatterns {
        expectedStartTime
        expectedEndTime
        duration
        legs {
          mode
          line { publicCode name }
          fromEstimatedCall { quay { publicCode } aimedDepartureTime expectedDepartureTime }
          fromPlace { name }
          toPlace { name }
        }
      }
    }
  }
`;

/** Case-folded, punctuation-free, diacritic-free tokens, with pure house numbers dropped.
 *
 *  ø and æ are mapped explicitly because neither decomposes under NFD (unlike å, ö, é), and a
 *  keyboard without them is a real way to type a real Norwegian station: measured live,
 *  "Tonsberg stasjon" returns the correct "Tønsberg" results, so folding is what stops the guard
 *  turning a real journey into a not-found. House numbers are dropped because "32" is in every
 *  street in the country and is therefore no evidence at all about WHICH street this is. */
function placeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ø/gu, "o")
    .replace(/æ/gu, "ae")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0 && !/^\d+$/u.test(token));
}

/** Place-type words: they say WHAT a place is, never WHICH place it is. A word from this list
 *  cannot, on its own, establish that an answer is the place that was asked for.
 *
 *  Measured, not fastidious. Live, "Central Station Amsterdam" returned `Oslo S` — because Oslo
 *  also holds "Comfort Hotel Xpress Central Station", which carries `central` and `station` and
 *  sat close enough to corroborate. "Son brygge" returned "Søndre brygge" in Asker, 40 km away,
 *  on the strength of `brygge` alone. Oslo is the biggest locality and the densest in
 *  foreign-named businesses, so this degeneracy is routine there rather than exotic.
 *
 *  The list is applied only when the query has something better to offer — see `evidenceWords`. */
const GENERIC_PLACE_WORDS = new Set([
  "station", "stasjon", "stasjonen", "sentralstasjon", "sentralstasjonen", "central",
  "centralstation", "rutebilstasjon", "rutebilstasjonen", "busstasjon", "busstasjonen",
  "bussterminal", "terminal", "terminalen",
  "lufthavn", "lufthavnen", "airport", "flyplass", "flyplassen",
  "brygge", "brygga", "kai", "kaia", "ferjekai", "fergekai",
  "hotel", "hotell", "sentrum", "senter", "senteret",
  "gate", "gata", "gaten", "vei", "veien", "vegen", "plass", "plassen", "torg", "torget",
]);

/** Norwegian definite and genitive endings, longest first so "-ene" is tried before "-en". */
const NOUN_SUFFIXES = ["ene", "en", "et", "a", "s"] as const;

/** Below this, stripping an ending destroys the word rather than inflecting it: "Skien" minus
 *  "-en" is "Ski", a different town 100 km away, and "Bergen" minus "-en" is "Berg". */
const MIN_STEM_LENGTH = 5;

function stem(word: string): string {
  for (const suffix of NOUN_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= MIN_STEM_LENGTH) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/** The same Norwegian word in a different definite/genitive form. "Majorstua" is arguably the
 *  commoner written form of "Majorstuen", Oslo's busiest metro interchange, and "Frognerseter"
 *  of "Frognerseteren"; both resolve correctly in Entur and both were being rejected.
 *
 *  Allowed ONLY against a stop-place, and never for corroboration. That gate is what keeps it
 *  from re-opening the bug: "London" against the Oslo street "Doktor Londons vei" IS a genuine
 *  `-s` relation, and is rejected only because that street is not a stop. */
function sameNorwegianWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [sa, sb] = [stem(a), stem(b)];
  return sa === sb || sa === b || a === sb;
}

/** As much of a geocoder feature as the guard and the result construction need. */
type GeoFeature = { properties?: Record<string, unknown>; geometry?: { coordinates?: unknown } };

function textProp(feature: GeoFeature | undefined, key: string): string | null {
  const value = feature?.properties?.[key];
  return typeof value === "string" ? value : null;
}

/** THE ID SCHEMES, inferred from live responses and load-bearing in two places (the inflection
 *  tolerance, which applies only to a stop; and the namesake rule, which applies only to a point
 *  of interest). Entur documents no contract for these prefixes, so this is observation:
 *
 *    NSR:  the National Stop Register — a stop place, quay or group. Includes FOREIGN stations:
 *          Göteborg C is NSR:StopPlace:374 [SWE]. An `NSR:` id is the only kind the journey
 *          planner accepts as a `place`.
 *    OSM:  an OpenStreetMap point of interest — a café, a dentist, a hotel, a school.
 *    KVE:  a cadastral street or street address ("Doktor Londons vei", "Youngstorget").
 *    <digits>: a plain address point ("Storgaten 32" is 201107464).
 *
 *  IF ENTUR ADDS A FIFTH SCHEME it will simply be neither a stop nor a point of interest: the
 *  inflection tolerance and the namesake rule both stop applying to it, silently and with no test
 *  failing. That is the safe direction (the guard gets stricter, never looser), but it is the
 *  thing to re-check first if a whole class of place stops resolving. */
const STOP_PLACE_ID = "NSR:";
const POINT_OF_INTEREST_ID = "OSM:";

function idOf(feature: GeoFeature | undefined): string {
  return textProp(feature, "id") ?? "";
}

function nameTokens(feature: GeoFeature | undefined): string[] {
  return placeTokens(textProp(feature, "name") ?? "");
}

function localityTokens(feature: GeoFeature | undefined): string[] {
  return placeTokens(textProp(feature, "locality") ?? "");
}

/** Does this feature's NAME carry one of the words the question offered as evidence? Names only:
 *  a locality is where a thing is, not which thing it is, and counting it when corroborating
 *  would be circular — being near the answer is already half of what is being asked. */
function carriesEvidence(feature: GeoFeature, evidence: readonly string[]): boolean {
  const words = nameTokens(feature);
  return evidence.some((word) => words.includes(word));
}

/** GeoJSON [lon, lat], or null when the feature carries no usable point. */
function pointOf(feature: GeoFeature | undefined): [number, number] | null {
  const c = feature?.geometry?.coordinates;
  if (!Array.isArray(c) || c.length < 2) return null;
  const [lon, lat] = [Number(c[0]), Number(c[1])];
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

/** How far a corroborating result may sit from the answer it corroborates. Consulted only in the
 *  ALIAS case — where the answer's own name does not carry the question's words — and aliases are
 *  co-located by nature: Oslo lufthavn to Gardermoen næringspark is ~3 km, Svalbard lufthavn to
 *  Longyearbyen ~5 km. The noise it must exclude sits at 150-200 km (Lillestrøm to Risør,
 *  Trondheim to Tynset). Nothing observed falls between 25 and 150 km. */
const CORROBORATION_RADIUS_KM = 25;

/** Great-circle kilometres. Corroboration is by DISTANCE rather than by matching the `locality`
 *  string, because that string is unreliable in both directions: `Svalbard lufthavn`
 *  (NSR:StopPlace:764) carries NO locality at all — which silently rejected "Longyearbyen" before
 *  anything could corroborate it — and the nine real `Longyearbyen …` results beside it are
 *  labelled `Karlsøy`, a municipality 800 km away. Coordinates are always present and always mean
 *  what they say. */
function kmBetween(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Every other result within the corroboration radius of this one. */
function neighboursOf(chosen: GeoFeature, features: GeoFeature[]): GeoFeature[] {
  const here = pointOf(chosen);
  if (here === null) return [];
  return features.filter((f) => {
    if (f === chosen) return false;
    const there = pointOf(f);
    return there !== null && kmBetween(here, there) <= CORROBORATION_RADIUS_KM;
  });
}

/** How many neighbours must carry the word before a point of interest counts as standing in a
 *  place that is NAMED that. One is not enough and that is measured: "Toscana" (Lillehammer) has
 *  exactly one nearby friend, "Cafe Toscana" in Øyer, and two Italian restaurants 13 km apart do
 *  not make a Norwegian district called Toscana. "Nøtterøy" has nine. */
const MIN_LOCAL_NAME_NEIGHBOURS = 2;

/** Is the answer a Norwegian BUSINESS that happens to be named after the place asked for?
 *
 *  This is the last leak class, and it only ever arises for an `OSM:` point of interest — a café,
 *  a dentist, a hotel. Live, all of these were `country_a: "NOR"`: "Amsterdam" → `Cafe Amsterdam`
 *  (Oslo), "Tokyo" → `Fra Bangkok til Tokyo` (Frogn), "Colosseum, Rome" → `Colosseum Tannlege`
 *  (Molde), "Milano" → `Milano` (Brønnøy), "Napoli" → `Napoli` (Fauske), "Capri" → `Capri`
 *  (Bjørnafjorden), "Toscana" → `Toscana` (Lillehammer). Asked for trains from Milano to Napoli,
 *  Entur would happily plan Brønnøy → Fauske.
 *
 *  Refusing points of interest wholesale is far too blunt: `Scandic Fornebu`, `Thon Hotel Opera`,
 *  `Radisson Blu Plaza Hotel, Oslo` are all OSM, and so is every single result for `Nøtterøy`, a
 *  real island of 21 000 people with no stop-place of its own. So a point of interest is fine in
 *  either of two situations, and a namesake in neither:
 *
 *    1. IT ADDS NOTHING BUT IS NOT A BARE ECHO. Every word of its name is one the question used,
 *       the municipality it sits in, or a place-type word — `Radisson Blu Plaza Hotel, Oslo`
 *       answering "Radisson Blu Plaza Oslo" adds only `hotel`. But when the question was a SINGLE
 *       bare word and the name is exactly that word, adding nothing proves nothing: that is
 *       precisely `Milano` → `Milano`. Two words already make the coincidence vanish, which is
 *       why `Scandic Fornebu` never reaches the harder test.
 *
 *    2. IT IS A LOCAL PLACE-NAME. At least `MIN_LOCAL_NAME_NEIGHBOURS` results within the radius
 *       carry the same word, AND nothing in the question is unaccounted for anywhere in that
 *       neighbourhood. `Nøtterøy` has nine neighbours; `Colosseum, Rome` has one, and would fail
 *       on `rome` in any case.
 *
 *  An all-generic question ("Flyplassen") is exempt from the bare-echo test: it is not a place
 *  name at all, so it cannot be a namesake of one, and it is already confined to self-support. */
function chosenIsANamesakeBusiness(
  asked: readonly string[],
  evidence: readonly string[],
  allGeneric: boolean,
  chosen: GeoFeature,
  neighbours: GeoFeature[],
): boolean {
  if (!idOf(chosen).startsWith(POINT_OF_INTEREST_ID)) return false;
  const names = nameTokens(chosen);
  const where = localityTokens(chosen);
  const addsNothing = names.every(
    (word) => asked.includes(word) || where.includes(word) || GENERIC_PLACE_WORDS.has(word),
  );
  const bareEcho =
    !allGeneric && evidence.length === 1 && names.length > 0 && names.every((w) => evidence.includes(w));
  if (addsNothing && !bareEcho) return false;

  const corroborating = neighbours.filter((f) => carriesEvidence(f, evidence));
  if (corroborating.length < MIN_LOCAL_NAME_NEIGHBOURS) return true;
  const neighbourhood = new Set([...names, ...where, ...neighbours.flatMap(nameTokens)]);
  return !evidence.every((word) => neighbourhood.has(word));
}

/** Did the geocoder UNDERSTAND the question, or is it guessing?
 *
 *  This is the whole Norway-bias guard. It is a judgement about the RESULT SET, not about the
 *  single feature returned, because the live failures pull in opposite directions and only the
 *  set separates them:
 *
 *    "Gardermoen" → the top answer is "Oslo lufthavn", which shares no word with the question.
 *      It is nevertheless CORRECT: Gardermoen is Oslo Airport, the geocoder knows the alias and
 *      ranked it first on purpose, and five siblings named "Gardermoen …" sit a few kilometres
 *      away. Rejecting it makes a real, frequently-flown journey unaskable; returning a matching
 *      sibling instead ("Gardermoen næringspark") would depart from a business park.
 *
 *    "Paris" → "Parisbudalsveien" (Åmot), "Parisdalen" (Ullensvang), "Bella Paris" (Bergen):
 *      substring noise across unrelated municipalities, all NOR. No comprehension.
 *
 *  So the answer stands when the feature ACTUALLY BEING RETURNED carries a distinctive word from
 *  the question (or, for a stop, the same word in another Norwegian form), or when a result
 *  carrying one sits within `CORROBORATION_RADIUS_KM` of it.
 *
 *  Four constraints on that, each of them a leak this guard has already had:
 *    • The evidence must be DISTINCTIVE. `central`/`station`/`brygge` describe a kind of place,
 *      and letting them corroborate turned "Central Station Amsterdam" into `Oslo S`.
 *    • An ALL-GENERIC question gets self-support only, never corroboration. Otherwise "Central
 *      Station" alone still reached `Oslo S`, via a hotel of that name a street away — and
 *      "how long from the hotel to Central Station?" in New York plans Bergen → Oslo.
 *    • It is the RETURNED feature that must be supported, never merely the top of the list. Live
 *      "Nice" matched "Nice To Meet UUU" (Lillestrøm) while the venue preference RETURNED "Nipe",
 *      a bus stop in Risør 200 km off.
 *    • Corroboration never gets the inflection tolerance. Åmot holds both "Parisbudalsveien" and
 *      "Vestre Parisbudalsvei"; anything looser lets that pair corroborate "Paris" into itself. */
function geocoderUnderstood(query: string, features: GeoFeature[], chosen: GeoFeature): boolean {
  const asked = placeTokens(query);
  if (asked.length === 0) return true; // nothing to compare — absence of evidence, not a mismatch

  const distinctive = asked.filter((word) => !GENERIC_PLACE_WORDS.has(word));
  // A question made of nothing but place-type words ("Sentrum", "Bussterminalen") has only those
  // to offer, and refusing every such question would be a worse error than the one the list
  // exists to prevent — but they buy self-support only, never a neighbour's word.
  const allGeneric = distinctive.length === 0;
  const evidence = allGeneric ? [...asked] : distinctive;

  const neighbours = neighboursOf(chosen, features);
  if (chosenIsANamesakeBusiness(asked, evidence, allGeneric, chosen, neighbours)) return false;

  const answered = [...nameTokens(chosen), ...localityTokens(chosen)];
  if (evidence.some((word) => answered.includes(word))) return true;
  if (idOf(chosen).startsWith(STOP_PLACE_ID)) {
    const stopWords = nameTokens(chosen);
    if (evidence.some((word) => stopWords.some((other) => sameNorwegianWord(word, other)))) return true;
  }

  // A question that names no place at all gets SELF-support only: no neighbour may carry it.
  // "Central Station" reached `Oslo S` through a hotel of that name a street away, and "how long
  // from the hotel to Central Station?" asked in New York then plans Bergen → Oslo.
  //
  // It stops there deliberately. Also demanding that the answer add no word of its own would
  // close the last of this class ("Hotel" → `Hotel Edvard Grieg`, Bergen) — it was written, and
  // it broke "Sentrum" within the hour, because the venue preference had moved on to
  // `Sentrum fergeleie` and `fergeleie` was not in the place-type list. A rule whose correctness
  // depends on a word list keeping pace with every Norwegian compound Entur can rank first is a
  // rule that fails silently in the expensive direction. Self-support, and no more.
  if (allGeneric) return false;

  return neighbours.some((f) => carriesEvidence(f, evidence));
}

/** Builds `resolvePlace`/`plan` bound to injected config. Mirrors `makeOrakelClient`'s posture:
 *  zero dependency on eve or `process.env`, so it is unit-testable against a plain fake `fetch`. */
export function makeEntur(config: EnturClientConfig) {
  const clientName = config.clientName ?? DEFAULT_CLIENT_NAME;
  const doFetch = config.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = { "ET-Client-Name": clientName };

  /** This request's own deadline, combined with the caller's budget when it brought one. */
  const signalFor = (caller: AbortSignal | undefined): AbortSignal => {
    const own = AbortSignal.timeout(timeoutMs);
    return caller ? AbortSignal.any([own, caller]) : own;
  };

  /** GET the geocoder for `text`, returning the top feature (venue preferred when present, else
   *  the top overall result — an unconditional `layers=venue` would stop addresses resolving). */
  async function resolvePlace(text: string, opts?: EnturCallOptions): Promise<ResolvedPlace> {
    const url = `${GEOCODER_URL}?text=${encodeURIComponent(text)}&size=10&lang=no`;
    let res: Response;
    try {
      res = await doFetch(url, { headers, signal: signalFor(opts?.signal) });
    } catch (err) {
      throw new EnturUnavailableError(
        `Entur was unreachable: geocoder request failed: ${(err as Error).message}`,
        err,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new EnturUnavailableError(`Entur was unreachable: geocoder → ${res.status} ${body.slice(0, 160)}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new EnturUnavailableError("Entur was unreachable: malformed geocoder response", err);
    }
    const features = (json as { features?: unknown })?.features;
    if (!Array.isArray(features) || features.length === 0) {
      throw new EnturPlaceNotFoundError(text);
    }
    const isVenue = (f: unknown): boolean =>
      !!f &&
      typeof f === "object" &&
      (f as { properties?: { layer?: unknown } }).properties?.layer === "venue";
    const candidates = features as GeoFeature[];
    const top = (candidates.find(isVenue) ?? candidates[0]) as GeoFeature;
    const props = top?.properties ?? {};
    const coords = top?.geometry?.coordinates;
    const rawId = props["id"];
    if (typeof rawId !== "string" || !Array.isArray(coords) || coords.length < 2) {
      throw new EnturUnavailableError("Entur was unreachable: malformed geocoder feature");
    }
    const name = typeof props["name"] === "string" ? (props["name"] as string) : text;
    const locality = typeof props["locality"] === "string" ? (props["locality"] as string) : null;
    // The Norway-bias guard (module header, and `geocoderUnderstood` for the rule). A guess that
    // has nothing to do with the question is not a resolution, and it must fail the SAME way an
    // empty response does — eve-marcel then falls through to Google, which abroad is the only
    // provider there is, and `agent-kit__transit_plan` returns its `notFound`.
    if (!geocoderUnderstood(text, candidates, top)) {
      throw new EnturPlaceNotFoundError(text, name);
    }
    // Only an NSR: id is a place the journey planner understands via `place:` — see
    // ResolvedPlace.id's doc for why anything else surfaces as null instead.
    return {
      id: rawId.startsWith("NSR:") ? rawId : null,
      name,
      locality,
      county: typeof props["county"] === "string" ? (props["county"] as string) : null,
      countryA: typeof props["country_a"] === "string" ? (props["country_a"] as string) : null,
      // GeoJSON order is [lon, lat].
      lon: Number(coords[0]),
      lat: Number(coords[1]),
    };
  }

  /** POST the `trip` GraphQL query and return normalised itineraries. An empty list is only ever
   *  returned for a real 200 — see the module header for why `from`/`to` must already be
   *  resolved places, never raw text. */
  async function plan(args: PlanArgs, opts?: EnturCallOptions): Promise<TripPattern[]> {
    const variables = {
      from: locationOf(args.from),
      to: locationOf(args.to),
      dateTime: args.dateTime,
      arriveBy: args.arriveBy,
      numTripPatterns: args.numTripPatterns ?? 3,
    };
    let res: Response;
    try {
      res = await doFetch(JOURNEY_PLANNER_URL, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ query: TRIP_QUERY, variables }),
        signal: signalFor(opts?.signal),
      });
    } catch (err) {
      throw new EnturUnavailableError(
        `Entur was unreachable: journey planner request failed: ${(err as Error).message}`,
        err,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new EnturUnavailableError(`Entur was unreachable: journey planner → ${res.status} ${body.slice(0, 160)}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new EnturUnavailableError("Entur was unreachable: malformed journey planner response", err);
    }
    const body = json as { errors?: unknown[]; data?: { trip?: { tripPatterns?: unknown[] } } };
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const first = body.errors[0] as { message?: unknown };
      const msg = typeof first?.message === "string" ? first.message : "GraphQL error";
      throw new EnturUnavailableError(`Entur was unreachable: journey planner returned an error: ${msg}`);
    }
    const patterns = body.data?.trip?.tripPatterns;
    if (!Array.isArray(patterns)) {
      throw new EnturUnavailableError(
        "Entur was unreachable: malformed journey planner response (no tripPatterns)",
      );
    }
    return patterns.map(normalisePattern);
  }

  return { resolvePlace, plan };
}

function normalisePattern(raw: unknown): TripPattern {
  const p = raw as {
    expectedStartTime?: unknown;
    expectedEndTime?: unknown;
    duration?: unknown;
    legs?: unknown[];
  };
  return {
    expectedStartTime: typeof p.expectedStartTime === "string" ? p.expectedStartTime : "",
    expectedEndTime: typeof p.expectedEndTime === "string" ? p.expectedEndTime : "",
    duration: typeof p.duration === "number" ? p.duration : 0,
    legs: Array.isArray(p.legs) ? p.legs.map(normaliseLeg) : [],
  };
}

function normaliseLeg(raw: unknown): PlanLeg {
  const l = raw as {
    mode?: unknown;
    line?: { publicCode?: unknown; name?: unknown } | null;
    fromEstimatedCall?: {
      quay?: { publicCode?: unknown } | null;
      aimedDepartureTime?: unknown;
      expectedDepartureTime?: unknown;
    } | null;
    fromPlace?: { name?: unknown } | null;
    toPlace?: { name?: unknown } | null;
  };
  const aimed =
    typeof l.fromEstimatedCall?.aimedDepartureTime === "string" ? l.fromEstimatedCall.aimedDepartureTime : null;
  const expected =
    typeof l.fromEstimatedCall?.expectedDepartureTime === "string"
      ? l.fromEstimatedCall.expectedDepartureTime
      : null;
  const delaySeconds =
    aimed && expected ? Math.round((new Date(expected).getTime() - new Date(aimed).getTime()) / 1000) : null;
  const platform = l.fromEstimatedCall?.quay?.publicCode;
  return {
    mode: typeof l.mode === "string" ? l.mode : "unknown",
    linePublicCode: typeof l.line?.publicCode === "string" ? l.line.publicCode : null,
    lineName: typeof l.line?.name === "string" ? l.line.name : null,
    fromPlaceName: typeof l.fromPlace?.name === "string" ? l.fromPlace.name : null,
    toPlaceName: typeof l.toPlace?.name === "string" ? l.toPlace.name : null,
    platform: typeof platform === "string" ? platform : null,
    aimedDepartureTime: aimed,
    expectedDepartureTime: expected,
    delaySeconds,
  };
}
