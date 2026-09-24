/**
 * Orakel — Norwegian/Nordic company enrichment. THE single implementation.
 *
 * ORB-143 left two copies of this logic: one here (backing the extension's `orakel_*` tools)
 * and one in `services/chief-of-staff/lib/orakel-client.ts`, each carrying a "keep them in step by
 * hand" comment. That comment is the exact convention ORB-142 deleted as superseded, and two
 * phases later the anti-duplication programme had reintroduced it. So the logic lives here,
 * once, and both sides bind it.
 *
 * WHY A FACTORY. The two callers resolve config differently and neither should win:
 *   - the eve extension binds `resolveConfig` to its own `extension.config.orakel`
 *   - eve-saga binds it to `ORAKEL_KEY_FILE` / `ORAKEL_URL`, because two NON-TOOL consumers
 *     (`agent/tools/commercial_who_to_contact.ts`, `lib/person-sources.ts`) call `orakelSearch`
 *     directly rather than through a tool, and they are not inside the extension's config scope.
 *
 * `makeOrakelClient` therefore has zero dependency on eve or on `process.env` — which is also
 * what keeps the normalisation, error classification and `getJson` behaviour unit-testable
 * against a plain fake resolver.
 */
import { readFileSync } from "node:fs";


export class OrakelUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OrakelUnavailableError";
  }
}

export class OrakelNotFoundError extends Error {
  constructor(readonly query: string) {
    super(`Orakel: no company found for ${query}`);
    this.name = "OrakelNotFoundError";
  }
}

export interface EnrichmentCompany {
  orgNumber: string;
  name: string;
  country: string;
  website: string | null;
  primaryDomain: string | null;
  employeeCount: number | null;
  foundingDate: string | null; // ISO date string as Orakel returns it
  naceCode: string | null;
  naceDescription: string | null;
  technologies: string[];
  linkedinHandle: string | null;
  sizeClass: string | null; // "small" | "medium" | "large" (Orakel's bucket)
  municipality: string | null; // businessAddressMuni — where it's based
  isBankrupt: boolean | null;
  isInDebtNegotiation: boolean | null;
  latestFinancialYear: number | null;
  revenue: number | null;
  operatingResult: number | null;
  netResult: number | null;
  financialHealthScore: number | null; // 0–100
  revenueCagr: number | null; // fraction, e.g. 0.19 = 19%
  ownershipConcentrationPct: number | null;
  isForeignOwned: boolean | null;
}

/** Lightweight search hit — enough to choose a company, then enrich it by org number. */
export interface CompanyCandidate {
  orgNumber: string;
  name: string;
  country: string;
  employeeCount: number | null;
  naceName: string | null;
  sizeClass: string | null;
}

/** Matches the extension's `orakel` config shape (`extension.ts`). */
export interface OrakelConfig {
  keyFile: string;
  baseUrl?: string;
}

const DEFAULT_KEY_FILE = "/run/secrets/orakel-key";

/** JSON `technologies` may be string[] or array of objects — flatten to a clean string[]. */
function normaliseTechnologies(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t === "string") {
      if (t.trim()) out.push(t.trim());
      continue;
    }
    if (t && typeof t === "object") {
      const o = t as Record<string, unknown>;
      const label = o["name"] ?? o["technology"] ?? o["title"] ?? o["slug"];
      if (typeof label === "string" && label.trim()) out.push(label.trim());
    }
  }
  return out;
}

/** Fiscal year from a "YYYY-MM-DD" period-end string; null if absent/unparseable. */
function yearOf(periodTo: unknown): number | null {
  if (typeof periodTo !== "string" || !periodTo) return null;
  const y = Number(periodTo.slice(0, 4));
  return Number.isFinite(y) && y > 1900 ? y : null;
}

function normalise(raw: Record<string, unknown>): EnrichmentCompany {
  const financials = Array.isArray(raw["financials"]) ? (raw["financials"] as Record<string, unknown>[]) : [];
  const latest = financials[0];
  const signals = (raw["signals"] ?? null) as Record<string, unknown> | null;
  return {
    orgNumber: String(raw["orgNumber"] ?? ""),
    name: String(raw["name"] ?? ""),
    country: (raw["country"] as string | undefined) ?? "NO",
    website: (raw["website"] as string | null | undefined) ?? null,
    primaryDomain: (raw["primaryDomain"] as string | null | undefined) ?? null,
    employeeCount: (raw["employeeCount"] as number | null | undefined) ?? null,
    foundingDate: (raw["foundingDate"] as string | null | undefined) ?? null,
    naceCode: (raw["naceCode1"] as string | null | undefined) ?? null,
    naceDescription:
      (raw["naceName"] as string | null | undefined) ?? (raw["naceDescription1"] as string | null | undefined) ?? null,
    technologies: normaliseTechnologies(raw["technologies"]),
    linkedinHandle: (raw["linkedinHandle"] as string | null | undefined) ?? null,
    sizeClass: (raw["sizeClass"] as string | null | undefined) ?? null,
    municipality: (raw["businessAddressMuni"] as string | null | undefined) ?? null,
    isBankrupt: (raw["isBankrupt"] as boolean | null | undefined) ?? null,
    isInDebtNegotiation: (signals?.["isInDebtNegotiation"] as boolean | null | undefined) ?? null,
    latestFinancialYear: yearOf(latest?.["periodTo"]),
    revenue: (latest?.["revenue"] as number | null | undefined) ?? null,
    operatingResult: (latest?.["operatingResult"] as number | null | undefined) ?? null,
    netResult: (latest?.["netResult"] as number | null | undefined) ?? null,
    financialHealthScore: (signals?.["financialHealthScore"] as number | null | undefined) ?? null,
    revenueCagr: (signals?.["revenueCagr"] as number | null | undefined) ?? null,
    ownershipConcentrationPct: (signals?.["ownershipConcentrationPct"] as number | null | undefined) ?? null,
    isForeignOwned: (signals?.["isForeignOwned"] as boolean | null | undefined) ?? null,
  };
}

/** Strip protocol/path/www and lowercase, e.g. "https://www.Ledidi.com/x" → "ledidi.com". */
function cleanDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]!;
}

/** Name-search label from a domain, e.g. "ledidi.com" → "ledidi". */
function domainLabel(domain: string): string {
  return cleanDomain(domain).split(".")[0]!;
}

function domainMatches(company: EnrichmentCompany, want: string, enrichedDomains: string[]): boolean {
  const target = cleanDomain(want);
  if (!target) return false;
  const candidates = [company.primaryDomain, company.website, ...enrichedDomains]
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .map(cleanDomain);
  return candidates.some((d) => d === target || d.endsWith(`.${target}`) || d.includes(target));
}

/**
 * Builds a bound set of the three Orakel functions against a `resolveConfig` callback,
 * called lazily on every HTTP call (never at construction) — mirrors the original client's
 * "read on every call, `eve build` has no secrets" discipline. Kept free of any eve
 * import so tests can construct a client with a plain fake resolver, no extension-config
 * machinery involved.
 */
export function makeOrakelClient(resolveConfig: () => OrakelConfig | undefined) {
  function readApiKey(): string {
    const path = resolveConfig()?.keyFile ?? DEFAULT_KEY_FILE;
    let value: string;
    try {
      value = readFileSync(path, "utf8").trim();
    } catch {
      throw new OrakelUnavailableError(`Orakel API key not readable: ${path}`);
    }
    if (value.length === 0) throw new OrakelUnavailableError(`Orakel API key file is empty: ${path}`);
    return value;
  }

  function baseUrl(): string {
    const url = resolveConfig()?.baseUrl;
    if (!url) throw new OrakelUnavailableError("Orakel baseUrl is not configured");
    return url.replace(/\/+$/, "");
  }

  async function getJson(path: string): Promise<unknown> {
    const apiKey = readApiKey();
    let res: Response;
    try {
      res = await fetch(`${baseUrl()}${path}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      });
    } catch (err) {
      throw new OrakelUnavailableError(`Orakel GET ${path} — network error: ${(err as Error).message}`, err);
    }
    if (res.status === 404) throw new OrakelNotFoundError(path);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new OrakelUnavailableError(`Orakel GET ${path} → ${res.status} ${text.slice(0, 160)}`);
    }
    try {
      return await res.json();
    } catch (err) {
      throw new OrakelUnavailableError(`Orakel GET ${path} — malformed JSON response`, err);
    }
  }

  async function fetchByOrgNumber(
    orgNumber: string,
  ): Promise<{ company: EnrichmentCompany; enrichedDomains: string[] }> {
    const json = (await getJson(`/api/companies/${encodeURIComponent(orgNumber)}`)) as Record<string, unknown>;
    const enrichedDomains = Array.isArray(json["enrichedDomains"]) ? (json["enrichedDomains"] as string[]) : [];
    return { company: normalise(json), enrichedDomains };
  }

  /** GET `/api/companies/{orgNumber}` — the reliable flat-object lookup. Throws
   *  `OrakelNotFoundError` on a 404, `OrakelUnavailableError` on any other failure. */
  async function orakelEnrichOrg(orgNumber: string): Promise<EnrichmentCompany> {
    if (!orgNumber.trim()) throw new OrakelNotFoundError(orgNumber);
    return (await fetchByOrgNumber(orgNumber)).company;
  }

  /**
   * Search companies by name (or any free text). Returns up to `limit` lightweight
   * candidates (org number + a few signals) so the caller can pick one and then enrich it
   * by org number. A search that legitimately returns zero matches is NOT an error — this
   * throws only on a genuine transport/HTTP failure.
   */
  async function orakelSearch(query: string, opts?: { limit?: number }): Promise<CompanyCandidate[]> {
    const q = query.trim();
    if (!q) return [];
    const limit = Math.min(Math.max(opts?.limit ?? 5, 1), 25);
    const json = (await getJson(`/api/companies?q=${encodeURIComponent(q)}&limit=${limit}`)) as Record<
      string,
      unknown
    >;
    const data = Array.isArray(json["data"]) ? (json["data"] as Record<string, unknown>[]) : [];
    return data.map((c) => ({
      orgNumber: String(c["orgNumber"] ?? ""),
      name: (c["name"] as string | undefined) ?? "",
      country: (c["country"] as string | undefined) ?? "NO",
      employeeCount: (c["employeeCount"] as number | null | undefined) ?? null,
      naceName: (c["naceName"] as string | null | undefined) ?? null,
      sizeClass: (c["sizeClass"] as string | null | undefined) ?? null,
    }));
  }

  /**
   * Best-effort domain lookup: name-search by the domain label, confirm each candidate's
   * real domain matches, return the first confirmed match. Throws `OrakelNotFoundError`
   * when no candidate's domain matches (a real "no such company" outcome, not a transport
   * failure); `OrakelUnavailableError` only on an actual network/HTTP/parse failure.
   */
  async function orakelEnrichDomain(domain: string): Promise<EnrichmentCompany> {
    const want = cleanDomain(domain);
    if (!want) throw new OrakelNotFoundError(domain);
    const label = domainLabel(domain);
    const json = (await getJson(`/api/companies?q=${encodeURIComponent(label)}&limit=5`)) as Record<string, unknown>;
    const candidates = Array.isArray(json["data"]) ? (json["data"] as Record<string, unknown>[]) : [];
    for (const item of candidates) {
      const orgNumber = String(item["orgNumber"] ?? "");
      if (!orgNumber) continue;
      let hit: { company: EnrichmentCompany; enrichedDomains: string[] };
      try {
        hit = await fetchByOrgNumber(orgNumber);
      } catch (err) {
        if (err instanceof OrakelNotFoundError) continue; // try the next candidate
        throw err;
      }
      if (domainMatches(hit.company, want, hit.enrichedDomains)) return hit.company;
    }
    throw new OrakelNotFoundError(domain);
  }

  return { orakelEnrichOrg, orakelSearch, orakelEnrichDomain };
}
