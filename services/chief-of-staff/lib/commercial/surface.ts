/**
 * Surface orchestrator — ties together the commercial radar pipeline:
 *   listPeople (T1) → doNotContact filter → pre-floor
 *   → ICP read (T2) + think → scoreContact (T3) → rank per brand
 *
 * Brand relevance is computed from per-brand ICP fit (there is no brand filter stage) — one
 * contact can surface under several brands.
 *
 * "subset" mode: pre-floor on warmth/recency before calling expensive think. The
 * `commercial_who_to_contact` tool only ever calls this mode.
 * "sweep"  mode: skip pre-floor, score everything (full universe pass) — kept for fidelity
 * with the ported source and future reuse, not currently wired to any eve-saga caller.
 *
 * Ported near-verbatim from `services/agent-runtime/lib/commercial/surface.ts`. ORB-51
 * posture (new to this port, not present upstream): `getCompanyForPerson` and `listPeople`
 * are called with NO try/catch here — deliberately, so a genuine Twenty failure propagates
 * out of `surfaceCommercial` rather than silently producing an empty/partial result.
 * `orakelEnrich`, `think`, and `opportunitiesForPerson` stay wrapped in try/catch — each is a
 * best-effort enrichment whose absence should degrade the contact's score, not abort the call.
 */

import type { TwentyPerson } from "../twenty-people.js";
import { scoreContact, DEFAULT_SCORE_CONFIG } from "./score.js";
import type { ScoreConfig } from "./score.js";
import { isJunkContact } from "./junk.js";

// Canonical relationship-strength order (weakest→strongest), mirrored from
// services/network's @lares/strength. Inlined (not imported) so this module has no
// cross-package dependency beyond @lares/junk — matching the upstream source's own reasoning
// for inlining this table rather than importing crm-intelligence's copy.
const STRENGTH_LEVELS = [
  "NO_CONNECTION",
  "VERY_WEAK",
  "WEAK",
  "GOOD",
  "STRONG",
  "VERY_STRONG",
] as const;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SurfaceDeps {
  /** Fetch all CRM contacts. */
  listPeople(): Promise<TwentyPerson[]>;
  /** Return the ICP markdown for a brand, or null if not configured. */
  icpFor(brand: string): Promise<string | null>;
  /** Call the LLM for a one-shot completion (used for ICP-fit scoring). */
  think(prompt: string): Promise<string>;
  /** Best-effort company enrichment via Orakel (optional). */
  orakelEnrich?(companyName: string): Promise<Record<string, unknown> | null>;
  /** Resolve the company name for a person by their CRM id (optional, called per-survivor
   *  when companyName is null). */
  getCompanyForPerson?(personId: string): Promise<string | null>;
  /** Read a person's open opportunities to detect pipeline membership per brand (optional
   *  annotation). */
  opportunitiesForPerson?(personId: string): Promise<Array<{ brand: string }>>;
  /** Brands to surface contacts for. */
  brands: string[];
  /** Score configuration (defaults to DEFAULT_SCORE_CONFIG). */
  cfg?: ScoreConfig;
  /** Clock injection for deterministic testing. */
  now?: Date | (() => Date);
  /** Max contacts to return per brand (default 8). */
  topN?: number;
  /**
   * Hard cap on the number of candidates that proceed to the expensive per-survivor work
   * (getCompanyForPerson + orakelEnrich + think) in "sweep" mode. Candidates are pre-sorted
   * by warmth desc then recency asc before the cap is applied. Default 200. Subset mode is
   * unaffected.
   */
  sweepMax?: number;
}

export interface SurfacedContact {
  id: string;
  name: string;
  email: string | null;
  brand: string;
  score: number;
  reason: string;
  /** True when the contact is already in this brand's pipeline (Opportunity tagged the
   *  brand). */
  inPipeline?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Map a TwentyPerson strength value (string enum) to a 0-100 warmth number. */
function strengthToWarmth(strength: string | null): number | null {
  if (strength === null) return null;
  const idx = STRENGTH_LEVELS.indexOf(strength as (typeof STRENGTH_LEVELS)[number]);
  if (idx === -1) return null;
  const len = STRENGTH_LEVELS.length;
  return (idx / (len - 1)) * 100;
}

/** Compute days elapsed between an ISO string and now. Returns null if lastContactedAt is null. */
function daysSince(lastContactedAt: string | null, now: Date): number | null {
  if (lastContactedAt === null) return null;
  const ms = now.getTime() - new Date(lastContactedAt).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

/**
 * Cheap pre-floor: passes if warmth >= 50 OR daysSinceContact <= 30.
 * Used in "subset" mode to avoid calling think (LLM) for stale/cold contacts.
 */
function passesPreFloor(
  warmth: number | null,
  days: number | null,
  cfg: ScoreConfig,
): boolean {
  if (warmth !== null && warmth >= cfg.floors.warmth) return true;
  if (days !== null && days <= cfg.floors.recencyDays) return true;
  return false;
}

/** Parse the leading integer from a think response like "70|fits the profile well". */
function parseIcpScore(response: string): number | null {
  const m = response.match(/^\s*(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return isNaN(n) ? null : Math.max(0, Math.min(100, n));
}

/** Build the think prompt for ICP-fit. */
function buildIcpPrompt(
  icp: string,
  companyName: string | null,
  orakelFacts: string,
): string {
  const name = companyName ?? "unknown";
  const facts = orakelFacts ? ` ${orakelFacts}` : "";
  return `Score 0-100 how well this company fits the ICP, then a 6-word reason. ICP:\n${icp}\nCompany: ${name}${facts}. Reply: <score>|<reason>`;
}

/** Summarise Orakel enrichment output into a compact string. */
function summariseOrakel(data: Record<string, unknown> | null): string {
  if (!data) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && v !== undefined && v !== "") {
      parts.push(`${k}=${String(v)}`);
    }
  }
  return parts.slice(0, 5).join(", ");
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function surfaceCommercial(
  deps: SurfaceDeps,
  mode: "subset" | "sweep",
): Promise<Record<string, SurfacedContact[]>> {
  const { brands, topN = 8, sweepMax = 200 } = deps;

  // Resolve the "now" clock once
  const now = deps.now instanceof Date
    ? deps.now
    : typeof deps.now === "function"
    ? deps.now()
    : new Date();

  // Load the full universe. ORB-51: no try/catch — a genuine Twenty failure propagates.
  const allPeople = await deps.listPeople();

  // Candidate pool = all warm/recent contacts minus doNotContact minus junk. Computed once
  // over the full universe — brands share the same candidate pool (see NO-brand-filter note
  // below).
  let junkFiltered = 0;
  const eligiblePeople = allPeople.filter((p) => {
    if (p.doNotContact) return false;
    if (isJunkContact(p)) {
      junkFiltered += 1;
      return false;
    }
    return true;
  });
  if (junkFiltered > 0) {
    console.log(`commercial-radar: junk-filtered ${junkFiltered}`);
  }

  // Cache ICP strings per brand (fetched lazily below)
  const icpCache = new Map<string, string | null>();

  const result: Record<string, SurfacedContact[]> = {};

  for (const brand of brands) {
    // NO brand filter: brand relevance is computed from ICP fit below, so one person can
    // surface under multiple brands. (Person.brand is intentionally not read here.)
    const brandPeople = eligiblePeople;

    // Compute cheap signals for every candidate
    type Candidate = {
      person: TwentyPerson;
      warmth: number | null;
      days: number | null;
    };

    const candidates: Candidate[] = brandPeople.map((person) => ({
      person,
      warmth: strengthToWarmth(person.strength),
      days: daysSince(person.lastContactedAt, now),
    }));

    // Fetch ICP for this brand (cached)
    if (!icpCache.has(brand)) {
      icpCache.set(brand, await deps.icpFor(brand));
    }
    const icp = icpCache.get(brand) ?? null;

    // Apply pre-floor in subset mode; cap fan-out in sweep mode.
    const cfg = deps.cfg ?? DEFAULT_SCORE_CONFIG;
    let survivors: typeof candidates;
    if (mode === "sweep") {
      // Sort by warmth desc, then recency asc (nulls last) so the most promising candidates
      // are always included when the cap bites.
      const sorted = [...candidates].sort((a, b) => {
        const wa = a.warmth ?? -1;
        const wb = b.warmth ?? -1;
        if (wb !== wa) return wb - wa;
        const da = a.days ?? Infinity;
        const db = b.days ?? Infinity;
        return da - db;
      });
      survivors = sorted.slice(0, sweepMax);
    } else {
      survivors = candidates.filter((c) => passesPreFloor(c.warmth, c.days, cfg));
    }

    // For each survivor: enrich + think + score
    const scored: Array<SurfacedContact & { _score: number }> = [];

    for (const { person, warmth, days } of survivors) {
      // Resolve companyName per-survivor — listPeople always returns null here, so call the
      // optional resolver if provided. ORB-51: no try/catch — a genuine Twenty failure
      // propagates out of surfaceCommercial rather than silently dropping this contact.
      let companyName = person.companyName;
      if (!companyName && deps.getCompanyForPerson) {
        companyName = await deps.getCompanyForPerson(person.id);
      }

      // Best-effort Orakel enrichment
      let orakelFacts = "";
      if (deps.orakelEnrich && companyName) {
        try {
          const data = await deps.orakelEnrich(companyName);
          orakelFacts = summariseOrakel(data);
        } catch {
          // best-effort — ignore errors (ORB-51: Orakel unavailable degrades this ONE
          // contact's enrichment, never sinks the whole call)
        }
      }

      // ICP-fit via think
      let icpFit: number | null = null;
      if (icp) {
        try {
          const prompt = buildIcpPrompt(icp, companyName, orakelFacts);
          const reply = await deps.think(prompt);
          icpFit = parseIcpScore(reply);
        } catch {
          // best-effort — leave null
        }
      }

      // Final score
      const { score, passesFloor, reason } = scoreContact(
        { warmth, daysSinceContact: days, icpFit },
        cfg,
      );

      if (!passesFloor) continue;

      // Optional pipeline annotation: is this contact already in THIS brand's pipeline? Only
      // read opportunities for survivors that pass the floor, to avoid an extra Twenty call
      // per non-survivor. Best-effort — never breaks the pass.
      let inPipeline = false;
      if (deps.opportunitiesForPerson) {
        try {
          const opps = await deps.opportunitiesForPerson(person.id);
          inPipeline = opps.some(
            (o) => (o.brand ?? "").toLowerCase() === brand.toLowerCase(),
          );
        } catch {
          // best-effort — leave false
        }
      }

      const boostedScore = inPipeline ? score + 10 : score;
      const finalReason = inPipeline
        ? `${reason} — already in pipeline, re-engage`
        : reason;

      scored.push({
        id: person.id,
        name: person.name,
        email: person.email,
        brand,
        score: boostedScore,
        reason: finalReason,
        inPipeline,
        _score: boostedScore,
      });
    }

    // Sort descending, take top N
    scored.sort((a, b) => b._score - a._score);
    result[brand] = scored.slice(0, topN).map(({ _score: _s, ...c }) => c);
  }

  return result;
}
