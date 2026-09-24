/** Read-only client for the persisted operational signal spine (LAR-41).
 *
 * A factory keeps this shared implementation independent of eve and process.env. Mounts decide
 * where configuration comes from, and tests inject fetch without opening the network.
 */
import { readFileSync } from "node:fs";

export class SignalsUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SignalsUnavailableError";
  }
}

export interface SignalsConfig {
  tokenFile: string;
  baseUrl?: string;
  fetch: typeof fetch;
}

export interface SignalRow {
  fingerprint: string;
  occurrence: number;
  kind: "alert" | "event" | "report";
  severity: "error" | "warn" | "info";
  state: "open" | "recovered" | "closed";
  title: string;
  project: string;
  source: string;
  type: string;
  description: string | null;
  url: string | null;
  firstSeen: string;
  lastSeen: string;
  count: number;
  linearRef: string | null;
}

export interface SignalsQuery {
  since?: string;
  severity?: SignalRow["severity"];
  project?: string;
  limit?: number;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isStringOrNull = (value: unknown): value is string | null => value === null || isString(value);

function parseRow(value: unknown): SignalRow | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (
    !isString(row["fingerprint"]) || !Number.isInteger(row["occurrence"]) ||
    !(row["kind"] === "alert" || row["kind"] === "event" || row["kind"] === "report") ||
    !(row["severity"] === "error" || row["severity"] === "warn" || row["severity"] === "info") ||
    !(row["state"] === "open" || row["state"] === "recovered" || row["state"] === "closed") ||
    !isString(row["title"]) || !isString(row["project"]) || !isString(row["source"]) ||
    !isString(row["type"]) || !isStringOrNull(row["description"]) || !isStringOrNull(row["url"]) ||
    !isString(row["firstSeen"]) || !isString(row["lastSeen"]) || !Number.isInteger(row["count"]) ||
    !isStringOrNull(row["linearRef"])
  ) return null;
  return row as unknown as SignalRow;
}

export function makeSignalsClient(resolveConfig: () => SignalsConfig | undefined) {
  async function signalsRecent(query: SignalsQuery = {}): Promise<SignalRow[]> {
    const config = resolveConfig();
    if (!config?.baseUrl) throw new SignalsUnavailableError("signal spine baseUrl is not configured");
    let token: string;
    try {
      token = readFileSync(config.tokenFile, "utf8").trim();
    } catch (error) {
      throw new SignalsUnavailableError(`signal read token is not readable: ${config.tokenFile}`, error);
    }
    if (!token) throw new SignalsUnavailableError(`signal read token file is empty: ${config.tokenFile}`);

    const params = new URLSearchParams();
    if (query.since) params.set("since", query.since);
    if (query.severity) params.set("severity", query.severity);
    if (query.project) params.set("project", query.project);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const suffix = params.size > 0 ? `?${params}` : "";
    let response: Response;
    try {
      response = await config.fetch(`${config.baseUrl.replace(/\/+$/u, "")}/signals${suffix}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch (error) {
      throw new SignalsUnavailableError("signal spine could not be reached", error);
    }
    if (!response.ok) {
      throw new SignalsUnavailableError(`signal spine returned HTTP ${response.status}`);
    }
    let body: unknown;
    try { body = await response.json(); } catch (error) {
      throw new SignalsUnavailableError("signal spine returned malformed JSON", error);
    }
    if (typeof body !== "object" || body === null || !Array.isArray((body as { signals?: unknown }).signals)) {
      throw new SignalsUnavailableError("signal spine returned an invalid response");
    }
    const rows: SignalRow[] = [];
    for (const value of (body as { signals: unknown[] }).signals) {
      const row = parseRow(value);
      if (!row) throw new SignalsUnavailableError("signal spine returned an invalid signal row");
      rows.push(row);
    }
    return rows;
  }
  return { signalsRecent };
}
