// services/console/lib/city-lookup.ts — a coordinate → the city and country it is in, offline.
//
// WHY OFFLINE (ORB-116). Bendik should not have to type "Copenhagen / Denmark" onto each of 26
// uploaded lists, and paying a reverse-geocoding call per place to learn something a bundled table
// already knows would be both slower and billable. `data/cities.json` is GeoNames' cities5000 —
// 64k populated places with their coordinates, country, and population — under CC BY 4.0. One
// data file, no runtime dependency, no network.
//
// WHY THE RULE IS NOT "NEAREST". Tried first, and it is wrong in a way that only shows up on real
// data: the nearest populated place to a restaurant in Brooklyn is "West Village", to one in
// Copenhagen "Indre By", to one in Paris "Folie Méricourt". Those are neighbourhoods, and a `city`
// field full of neighbourhoods is worse than an empty one — it cannot group a list, which is the
// entire job. What Bendik means by "which city is this in" is the CITY that contains the point.
//
// So: among sizeable cities close enough to plausibly contain the point, take the LARGEST, and
// only fall back to plain nearest when there is no such city. That gets New York rather than
// Manhattan, London rather than Islington, Paris rather than the 11th arrondissement — while
// still getting Chamonix-Mont-Blanc and Zermatt right, which is what the fallback is for.
//
// Measured against Bendik's store: 87% of 928 pinned places land on their list's modal city, and
// essentially all of the rest are either genuinely multi-town lists (an alpine list spanning
// Chamonix, Zermatt and Courmayeur) or entries whose pin was wrong in the first place.
import cities from "../data/cities.json";

/** Population, in thousands, at or above which a place is treated as a city that CONTAINS things
 *  rather than a place that merely sits near them. */
const CITY_POP_K = 100;

/** How far such a city may be and still be said to contain the point. Generous — a metropolitan
 *  area is genuinely tens of kilometres across, and the largest-wins rule keeps the answer stable
 *  well before this bites. */
const CONTAINS_KM = 50;

interface CityRow extends Array<unknown> {
  0: string; // name
  1: number; // lat
  2: number; // lon
  3: string; // ISO 3166-1 alpha-2
  4: number; // population, thousands
}

const ROWS = cities.cities as unknown as CityRow[];
const COUNTRIES = cities.countries as Record<string, string>;

export interface PlaceName {
  city: string;
  country: string;
}

/**
 * The city and country a coordinate sits in, or undefined if the tables have nothing to say
 * (mid-ocean, Antarctica, a coordinate that is simply wrong).
 *
 * Distance is compared in squared degrees with a cosine correction for longitude rather than in
 * true metres: over a 50 km window the difference cannot change which city wins, and it keeps a
 * whole-store backfill — 900 places against 64k cities — to well under a second.
 */
export function cityFor(lat: number, lon: number): PlaceName | undefined {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const limit = (CONTAINS_KM / 111.32) ** 2;

  let nearest: CityRow | undefined;
  let nearestD = Number.POSITIVE_INFINITY;
  let biggest: CityRow | undefined;
  let biggestPop = -1;

  for (const row of ROWS) {
    const dx = (row[2] - lon) * cosLat;
    const dy = row[1] - lat;
    const d = dx * dx + dy * dy;
    if (d < nearestD) {
      nearestD = d;
      nearest = row;
    }
    if (row[4] >= CITY_POP_K && d <= limit && row[4] > biggestPop) {
      biggestPop = row[4];
      biggest = row;
    }
  }

  const chosen = biggest ?? nearest;
  if (!chosen) return undefined;
  const country = COUNTRIES[chosen[3]];
  if (!country) return undefined;
  return { city: chosen[0], country };
}

/**
 * The best available answer for one entry.
 *
 * Deliberately the tables and ONLY the tables, even for an entry carrying a Places
 * `formattedAddress` from an accepted match (ORB-117). Google's address is more precise about
 * that one place — and precisely for that reason it is the wrong source here: it says "New York,
 * USA" where the tables say "New York City, United States", and a `city` facet holding both is a
 * filter with two entries for one city. This field exists to GROUP places; one name per city
 * beats a better name per place.
 */
export function derivePlaceName(entry: { lat?: number; lon?: number }): PlaceName | undefined {
  if (entry.lat === undefined || entry.lon === undefined) return undefined;
  return cityFor(entry.lat, entry.lon);
}
