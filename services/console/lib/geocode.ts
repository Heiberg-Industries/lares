// services/console/lib/geocode.ts — import-time coordinate + place-id resolution.
//
// THE LADDER (ORB-117). Each rung only runs for what the rung above could not do:
//
//   0. A pin the upload or the store already carries — free, and never touched.
//   1. Decode the saved URL's feature id as an S2 cell (`@lares/taste/s2`) — offline, exact
//      arithmetic, no key, always succeeds for a Takeout row. Typically neighbourhood-accurate,
//      sometimes kilometres stale. Its job is to turn rung 2 from a fuzzy global name search into
//      a local one.
//   2. Places Text Search biased by that point, accepted only on an EXACT name match that also
//      lands near the decoded point. Yields the real pin, the `formattedAddress`, and — the
//      durable prize — Google's `place_id`, which every supported API accepts forever after.
//   3. No accepted match → keep the decoded point, flagged `approx`. Never coordinate-less.
//
// WHY THE OLD COMMENT HERE WAS HALF RIGHT. It said the feature id "is NOT a Places place id", and
// that is true — Places (New) and Geocoding both reject it. What it missed is that the id is not
// opaque either: its first half is an S2 cell id and decodes offline. That single fact is what
// retires the manual browser ritual to a last-resort ops tool.
//
// THE STRICT ACCEPT RULE STAYS, and now has a second half. A wrong pin is worse than no pin — it
// would put Marcel's "du er 200 m unna" on the wrong building — so a result must slug-match the
// saved name exactly AND sit within `SANITY_RADIUS_M` of the decoded cell. The second half is not
// theoretical: measured against Bendik's store on 2026-08-17, 51 of 928 pins produced by a name
// search were a same-named place on another continent (The Bird in "Berlin" pinned in San
// Francisco, Pompette in "CPH" pinned in Brisbane). Every one of those would have been caught by
// this rule.
import { metresBetween, featureIdToLatLon, type LatLon } from "@lares/taste/s2";
import { slugify, type PlaceEntry } from "@lares/taste";

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

/** Only the fields we use. A narrower mask is a cheaper SKU as well as less data. */
const FIELD_MASK = "places.id,places.location,places.displayName,places.formattedAddress";

/**
 * How far an accepted match may sit from the decoded cell. Deliberately generous: the bias is a
 * suggestion to Google, not a boundary (the 2026-07-21 locationBias-drift lesson), and the cell
 * itself is stamped at feature creation and never moved afterwards.
 *
 * Calibrated, not guessed. Across the 928 pinned entries in the store, the decoded cell sits
 * within 5 km of the confirmed pin for 79% of them and beyond 50 km for ~1% once the 51 known-bad
 * pins are set aside. So 50 km rejects about one true match in a hundred — which then lands on
 * rung 3 with a real pin anyway — while rejecting every wrong-continent match outright.
 */
const SANITY_RADIUS_M = 50_000;

export interface GeocodeDeps {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Where to bias a search for an entry whose URL carries no feature id — a hand-pasted place, a
   * shortlink. The importer passes the list's own centroid (ORB-116): most saved lists are one
   * city, so the places already in it locate the ones that are not locatable on their own.
   */
  fallbackBias?: LatLon;
  /**
   * Hard ceiling on billed searches for one call. An import of a 900-row export should not be
   * able to become a surprise invoice because a header changed shape — the 2026-08-14 lesson.
   * Everything above the cap is reported as unresolved rather than silently skipped.
   */
  maxSearches?: number;
}

export interface GeocodeOutcome {
  entries: PlaceEntry[];
  /** How many gained a CONFIRMED pin from an accepted match. */
  resolved: number;
  /** Names that fell back to the decoded cell and are flagged `approx`, with WHY the exact match
   *  failed. A count alone would hide the interesting case — "traff «X» 900 km unna" is how a
   *  wrong-continent namesake announces itself. */
  approximate: Array<{ name: string; reason: string }>;
  /** Names left with no pin at all, with why — surfaced in the import summary. */
  unresolved: Array<{ name: string; reason: string }>;
  /** Billed searches actually made. */
  searches: number;
}

interface SearchTextResponse {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
  }>;
}

interface Hit {
  lat: number;
  lon: number;
  displayName: string;
  placeId: string;
  address?: string;
}

/**
 * One Text Search, biased by a point when we have one.
 *
 * `maxResultCount` is 5 rather than 1 deliberately: with a bias, the exact-name match is often not
 * the first result (a chain's flagship outranks the local one), and taking five costs the same
 * single billed search. The acceptance rule below still decides which — if any — is allowed.
 */
async function searchOne(
  name: string,
  bias: LatLon | undefined,
  city: string,
  deps: GeocodeDeps,
): Promise<Hit[]> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const res = await doFetch(SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": deps.apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({
      // With a bias point the city string adds nothing and can actively mislead (a list named for
      // one city holding a place in the next one over), so it is only used when there is no bias.
      textQuery: bias || !city ? name : `${name}, ${city}`,
      maxResultCount: 5,
      ...(bias
        ? {
            locationBias: {
              circle: { center: { latitude: bias.lat, longitude: bias.lon }, radius: SANITY_RADIUS_M },
            },
          }
        : {}),
    }),
  });
  if (!res.ok) throw new Error(`places searchText ${res.status}`);

  const body = (await res.json()) as SearchTextResponse;
  const hits: Hit[] = [];
  for (const place of body.places ?? []) {
    const lat = place.location?.latitude;
    const lon = place.location?.longitude;
    const displayName = place.displayName?.text;
    const placeId = place.id;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    if (typeof displayName !== "string" || typeof placeId !== "string") continue;
    hits.push({ lat, lon, displayName, placeId, ...(place.formattedAddress ? { address: place.formattedAddress } : {}) });
  }
  return hits;
}

/** The first hit that passes BOTH halves of the accept rule, or a reason it found none. */
function accept(
  entry: PlaceEntry,
  hits: Hit[],
  bias: LatLon | undefined,
): { hit: Hit } | { reason: string } {
  if (hits.length === 0) return { reason: "ingen treff" };
  const wanted = slugify(entry.name);
  const named = hits.filter((h) => slugify(h.displayName) === wanted);
  if (named.length === 0) {
    return { reason: `traff «${hits[0]!.displayName}» — ikke samme navn` };
  }
  if (!bias) return { hit: named[0]! };
  const near = named
    .map((h) => ({ h, d: metresBetween({ lat: h.lat, lon: h.lon }, bias) }))
    .sort((a, b) => a.d - b.d);
  if (near[0]!.d > SANITY_RADIUS_M) {
    return { reason: `traff «${named[0]!.displayName}» ${Math.round(near[0]!.d / 1000)} km unna — feil sted` };
  }
  return { hit: near[0]!.h };
}

/** The point the saved URL's own feature id decodes to, if it carries one. */
export function decodedPin(entry: PlaceEntry): LatLon | undefined {
  const match = entry.url?.match(/!1s(0x[0-9a-f]+)/i);
  return featureIdToLatLon(match?.[1]);
}

/**
 * Fills in coordinates — and, far more valuably, place ids — for entries that have no pin.
 *
 * Entries that already carry one are passed through untouched and cost nothing, which is what
 * bounds the price of a re-upload: the store's pin is applied by `diffList` before this runs, so
 * only genuinely new places are ever searched.
 *
 * Never throws for one bad lookup: a failed search leaves that entry on rung 3 (or as it was) and
 * adds a line to `unresolved`. An import must not die because Google rate-limited row 40 of 200.
 */
export async function resolveMissingCoordinates(
  entries: readonly PlaceEntry[],
  city: string,
  deps: GeocodeDeps,
): Promise<GeocodeOutcome> {
  const out: PlaceEntry[] = [];
  const unresolved: Array<{ name: string; reason: string }> = [];
  const approximate: Array<{ name: string; reason: string }> = [];
  const cap = deps.maxSearches ?? Number.POSITIVE_INFINITY;
  let resolved = 0;
  let searches = 0;

  for (const entry of entries) {
    if (entry.lat !== undefined && entry.lon !== undefined) {
      out.push(entry);
      continue;
    }

    const bias = decodedPin(entry) ?? deps.fallbackBias;

    // Rung 3 is prepared BEFORE rung 2 is attempted, so every failure path below — no hits, wrong
    // name, wrong place, a thrown fetch, a hit cap — still ends with a pin whenever the URL had a
    // feature id in it. "Never coordinate-less" must not depend on the happy path.
    // Only a pin decoded from the entry's OWN link may stand in for it. A list centroid is fine
    // for pointing a search at the right city and useless as a position — it is where the other
    // places are, not where this one is.
    const ownPin = decodedPin(entry);
    const fallback: PlaceEntry = ownPin ? { ...entry, lat: ownPin.lat, lon: ownPin.lon, approx: true } : entry;
    const settle = (reason: string): void => {
      out.push(fallback);
      (ownPin ? approximate : unresolved).push({ name: entry.name, reason });
    };

    if (searches >= cap) {
      settle(`oppslagsgrensen (${cap}) nådd`);
      continue;
    }

    try {
      searches++;
      const verdict = accept(entry, await searchOne(entry.name, bias, city, deps), bias);
      if ("reason" in verdict) {
        settle(verdict.reason);
        continue;
      }
      out.push({
        ...entry,
        lat: verdict.hit.lat,
        lon: verdict.hit.lon,
        placeId: verdict.hit.placeId,
        ...(verdict.hit.address ? { address: verdict.hit.address } : {}),
      });
      resolved++;
    } catch (err) {
      settle(err instanceof Error ? err.message : String(err));
    }
  }

  return { entries: out, resolved, approximate, unresolved, searches };
}

/** The console only geocodes when a key is actually configured; without one, an import still
 *  succeeds — and, since ORB-117, still pins everything it can offline. */
export function placesApiKey(): string | undefined {
  const inline = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (inline) return inline;
  const file = process.env.GOOGLE_PLACES_API_KEY_FILE;
  if (!file) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const value = (require("node:fs") as typeof import("node:fs")).readFileSync(file, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The offline half of the ladder, for an import with no Places key configured.
 *
 * Rungs 1 and 3 need no key and no network, so "no key" should mean "no exact matches", not "no
 * pins at all" — which is what it meant before ORB-117.
 */
export function pinFromFeatureIdOnly(entries: readonly PlaceEntry[]): GeocodeOutcome {
  const out: PlaceEntry[] = [];
  const unresolved: Array<{ name: string; reason: string }> = [];
  const approximate: Array<{ name: string; reason: string }> = [];

  for (const entry of entries) {
    if (entry.lat !== undefined && entry.lon !== undefined) {
      out.push(entry);
      continue;
    }
    const bias = decodedPin(entry);
    if (!bias) {
      out.push(entry);
      unresolved.push({ name: entry.name, reason: "ingen posisjon i lenken" });
      continue;
    }
    out.push({ ...entry, lat: bias.lat, lon: bias.lon, approx: true });
    approximate.push({ name: entry.name, reason: "ingen Places-nøkkel konfigurert" });
  }

  return { entries: out, resolved: 0, approximate, unresolved, searches: 0 };
}
