// services/console/lib/signals.ts
// Reads the spine's record (GET /signals) and the two admin lists. Degrades to `unavailable` on
// ANY failure — the pattern lib/crm-status.ts uses; an empty table must never read as "no problems".
import { readSecret } from "./secrets";

export interface SignalRow {
  fingerprint: string; occurrence: number; kind: "alert" | "event" | "report"; severity: "error" | "warn" | "info";
  state: "open" | "recovered" | "closed"; title: string; project: string; source: string; type: string;
  description: string | null; url: string | null; firstSeen: string; lastSeen: string; count: number; linearRef: string | null;
}
export interface SlackRule { position: number; project?: string; severity?: string; type?: string; source?: string; kind?: string; destinations: string[]; allowTarget: boolean }
export interface CatalogueRow { source: string; type: string; key: string; description: string }
/** ORB-240: the delivery kill switches. `name` is a closed set on the spine side. */
export interface ConsumerRow { name: "slack" | "linear"; enabled: boolean }
type Unavailable = { unavailable: true };
const UNAVAILABLE: Unavailable = { unavailable: true };

function base(): string | undefined { return process.env["SIGNAL_SPINE_URL"]?.replace(/\/$/, ""); }

/** Fetch + parse only — no shape validation. Degrades to `unavailable` on ANY failure. */
async function getJson(path: string, token: string | undefined): Promise<unknown | Unavailable> {
  const url = base();
  if (!url || !token) return UNAVAILABLE;
  try {
    const res = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000), cache: "no-store" });
    if (!res.ok) return UNAVAILABLE;
    return (await res.json()) as unknown;
  } catch { return UNAVAILABLE; }
}

function isUnavailable(v: unknown): v is Unavailable {
  return typeof v === "object" && v !== null && (v as { unavailable?: unknown }).unavailable === true;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number";

/**
 * Validates one signal row at the wire boundary, mirroring lib/crm-status.ts's toChannel(): the
 * spine and the console deploy independently, so a field rename or a widened enum on the spine
 * side is invisible to the console's `tsc`. Any bad row degrades the WHOLE response — dropping
 * just that row and rendering the rest would silently read as "no problems" for the missing case.
 */
function toSignalRow(u: unknown): SignalRow | null {
  if (typeof u !== "object" || u === null) return null;
  const r = u as Record<string, unknown>;
  if (
    !isStr(r["fingerprint"]) || !isStr(r["title"]) || !isStr(r["project"]) ||
    !isStr(r["source"]) || !isStr(r["type"]) || !isStr(r["firstSeen"]) || !isStr(r["lastSeen"]) ||
    !isNum(r["occurrence"]) || !isNum(r["count"]) ||
    !(r["kind"] === "alert" || r["kind"] === "event" || r["kind"] === "report") ||
    !(r["severity"] === "error" || r["severity"] === "warn" || r["severity"] === "info") ||
    !(r["state"] === "open" || r["state"] === "recovered" || r["state"] === "closed") ||
    !isStrOrNull(r["description"]) || !isStrOrNull(r["url"]) || !isStrOrNull(r["linearRef"])
  ) {
    return null;
  }
  return {
    fingerprint: r["fingerprint"], occurrence: r["occurrence"], kind: r["kind"], severity: r["severity"],
    state: r["state"], title: r["title"], project: r["project"], source: r["source"], type: r["type"],
    description: r["description"], url: r["url"], firstSeen: r["firstSeen"], lastSeen: r["lastSeen"],
    count: r["count"], linearRef: r["linearRef"],
  };
}

export async function getRecentSignals(q: { since?: string; severity?: string; project?: string; kind?: string; state?: string }): Promise<{ signals: SignalRow[] } | Unavailable> {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => !!v) as [string, string][]).toString();
  const body = await getJson(`/signals${qs ? `?${qs}` : ""}`, readSecret("SIGNAL_READ_TOKEN"));
  if (isUnavailable(body)) return body;
  if (typeof body !== "object" || body === null || !Array.isArray((body as { signals?: unknown }).signals)) {
    return UNAVAILABLE;
  }
  const signals: SignalRow[] = [];
  for (const raw of (body as { signals: unknown[] }).signals) {
    const row = toSignalRow(raw);
    if (row === null) return UNAVAILABLE;
    signals.push(row);
  }
  return { signals };
}
export async function getRules(): Promise<{ rules: SlackRule[] } | Unavailable> {
  const body = await getJson("/admin/rules", readSecret("SIGNAL_ADMIN_TOKEN"));
  if (isUnavailable(body)) return body;
  if (typeof body !== "object" || body === null || !Array.isArray((body as { rules?: unknown }).rules)) {
    return UNAVAILABLE;
  }
  return body as { rules: SlackRule[] };
}
export async function getCatalogue(): Promise<{ catalogue: CatalogueRow[] } | Unavailable> {
  const body = await getJson("/admin/catalogue", readSecret("SIGNAL_ADMIN_TOKEN"));
  if (isUnavailable(body)) return body;
  if (typeof body !== "object" || body === null || !Array.isArray((body as { catalogue?: unknown }).catalogue)) {
    return UNAVAILABLE;
  }
  return body as { catalogue: CatalogueRow[] };
}
/**
 * The two delivery kill switches. Validated at the wire boundary for the same reason `toSignalRow`
 * is: the spine and the console deploy independently, so a widened enum on the spine is invisible
 * to the console's `tsc`. A row it cannot read degrades the WHOLE response — showing one switch and
 * silently dropping the other would let someone believe they had muted something they had not.
 */
export async function getConsumers(): Promise<{ consumers: ConsumerRow[] } | Unavailable> {
  const body = await getJson("/admin/consumers", readSecret("SIGNAL_ADMIN_TOKEN"));
  if (isUnavailable(body)) return body;
  if (typeof body !== "object" || body === null || !Array.isArray((body as { consumers?: unknown }).consumers)) {
    return UNAVAILABLE;
  }
  const consumers: ConsumerRow[] = [];
  for (const raw of (body as { consumers: unknown[] }).consumers) {
    if (typeof raw !== "object" || raw === null) return UNAVAILABLE;
    const r = raw as Record<string, unknown>;
    if (!(r["name"] === "slack" || r["name"] === "linear") || typeof r["enabled"] !== "boolean") return UNAVAILABLE;
    consumers.push({ name: r["name"], enabled: r["enabled"] });
  }
  return { consumers };
}

/** PUT one of the admin lists. Throws with the spine's message on failure (the page shows it). */
export async function putAdmin(path: "/admin/rules" | "/admin/catalogue" | "/admin/consumers", body: unknown, by: string): Promise<void> {
  const url = base(); const token = readSecret("SIGNAL_ADMIN_TOKEN");
  if (!url || !token) throw new Error("signal spine not configured (SIGNAL_SPINE_URL / SIGNAL_ADMIN_TOKEN)");
  const res = await fetch(`${url}${path}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-updated-by": by },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
}
