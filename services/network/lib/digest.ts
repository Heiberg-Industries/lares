import type { Db } from "./db.js";
import { whoAt, dormantQueue } from "./queries.js";
import type { SlackMessage } from "./slack.js";

/** ISO-8601 week id, e.g. "2026-W24". The ISO year can differ from the calendar year at boundaries. */
export function isoWeekOf(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; // Mon=1 .. Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day); // shift to the Thursday of this week
  const year = t.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export type ReactivateRow = { displayName: string; company: string | null; lastInteractionAt: string | null };
export type FreshSignal = { displayName: string; kind: string; at: string; evidence: string };
export type WarmPath = { company: string; stage: string; contacts: { displayName: string; band: string }[] };
export type DigestData = { isoWeek: string; reactivate: ReactivateRow[]; signals: FreshSignal[]; warmPaths: WarmPath[] };
export type PipelineCompany = { name: string; stage: string };

const WARM_BANDS = new Set(["GOOD", "STRONG", "VERY_STRONG"]);
const REACTIVATE_LIMIT = 5;
const SIGNALS_LIMIT = 10;
const CONTACTS_PER_COMPANY = 3;
const DEFAULT_WINDOW_DAYS = 14;

export function composeDigest(db: Db, opts: { now: Date; pipeline: PipelineCompany[] }): DigestData {
  const lastPost = db.prepare("SELECT MAX(posted_at) AS p FROM digest_runs").get() as { p: string | null };
  const since = lastPost.p ?? new Date(opts.now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000).toISOString();

  const reactivate: ReactivateRow[] = dormantQueue(db, REACTIVATE_LIMIT).map((r) => ({
    displayName: r.displayName,
    company: r.company,
    lastInteractionAt: r.lastInteractionAt,
  }));

  // cadence_break is excluded: the reactivate section already covers gone-quiet contacts.
  const signals = db
    .prepare(
      `SELECT c.display_name AS displayName, s.kind, s.at, s.evidence
       FROM signals s JOIN contacts c ON c.id = s.contact_id
       WHERE s.at >= ? AND s.kind != 'cadence_break'
       ORDER BY s.at DESC LIMIT ?`,
    )
    .all(since, SIGNALS_LIMIT) as FreshSignal[];

  const warmPaths: WarmPath[] = opts.pipeline.map((p) => ({
    company: p.name,
    stage: p.stage,
    contacts: whoAt(db, p.name)
      .filter((r) => WARM_BANDS.has(r.band))
      .slice(0, CONTACTS_PER_COMPANY)
      .map((r) => ({ displayName: r.displayName, band: r.band })),
  }));

  return { isoWeek: isoWeekOf(opts.now), reactivate, signals, warmPaths };
}

const STAGE_LABEL: Record<string, string> = {
  NEW: "New", CONTACTED: "Contacted", MEETING: "Meeting", QUALIFIED: "Qualified", PROPOSAL: "Proposal",
};
const SIGNAL_LABEL: Record<string, string> = {
  job_change: "Job change", promotion: "Promotion", company_switch: "Company switch", call_unreturned: "Unreturned call",
};

function renderEvidence(evidence: string): string {
  try {
    const e = JSON.parse(evidence) as Record<string, unknown>;
    if (typeof e.from === "string" && typeof e.to === "string") return `${e.from} → ${e.to}`;
    return Object.entries(e).map(([k, v]) => `${k}: ${String(v)}`).join(", ");
  } catch {
    return evidence;
  }
}

export function renderDigest(d: DigestData): string {
  const lines: string[] = [`:satellite_antenna: *Network digest — ${d.isoWeek}*`];
  if (!d.reactivate.length && !d.signals.length && !d.warmPaths.length) {
    lines.push("", "Nothing needs attention this week.");
    return lines.join("\n");
  }
  if (d.reactivate.length) {
    lines.push("", "*Reactivate — warm but gone quiet*");
    for (const r of d.reactivate) {
      lines.push(`• ${r.displayName}${r.company ? ` (${r.company})` : ""} — last contact ${r.lastInteractionAt?.slice(0, 10) ?? "unknown"}`);
    }
  }
  if (d.signals.length) {
    lines.push("", "*Fresh signals*");
    for (const s of d.signals) {
      lines.push(`• ${SIGNAL_LABEL[s.kind] ?? s.kind}: ${s.displayName} — ${renderEvidence(s.evidence)} (${s.at.slice(0, 10)})`);
    }
  }
  if (d.warmPaths.length) {
    lines.push("", "*Warm paths into the pipeline*");
    for (const w of d.warmPaths) {
      const stage = STAGE_LABEL[w.stage] ?? w.stage;
      lines.push(
        w.contacts.length
          ? `• *${w.company}* (${stage}): ${w.contacts.map((c) => `${c.displayName} (${c.band})`).join(", ")}`
          : `• *${w.company}* (${stage}): no warm path yet`,
      );
    }
  }
  return lines.join("\n");
}

const CLOSED_STAGES = new Set(["CUSTOMER", "LOST"]);
const PIPELINE_COMPANY_LIMIT = 8;

/** Open opportunities → unique company list, oldest-listed first. Company name falls back to the opportunity name. */
export async function fetchPipelineCompanies(
  twenty: { listOpportunities(): Promise<{ name: string; stage: string; companyId: string | null }[]>; getCompanyName(id: string): Promise<string | null> },
  limit = PIPELINE_COMPANY_LIMIT,
): Promise<PipelineCompany[]> {
  const open = (await twenty.listOpportunities()).filter((o) => !CLOSED_STAGES.has(o.stage));
  const out: PipelineCompany[] = [];
  const seen = new Set<string>();
  for (const o of open) {
    const name = (o.companyId ? await twenty.getCompanyName(o.companyId) : null) ?? o.name;
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, stage: o.stage });
    if (out.length >= limit) break;
  }
  return out;
}

export type DigestRunResult = { status: "posted" | "already-posted" | "dry-run"; isoWeek: string; text: string };

export async function runDigest(
  db: Db,
  opts: {
    channel: string;
    now: Date;
    dryRun: boolean;
    /** Null = Twenty not configured; the warm-paths section is skipped. */
    twenty: Parameters<typeof fetchPipelineCompanies>[0] | null;
    post: (msg: SlackMessage) => Promise<void>;
  },
): Promise<DigestRunResult> {
  const isoWeek = isoWeekOf(opts.now);
  const existing = db.prepare("SELECT posted_at FROM digest_runs WHERE iso_week = ?").get(isoWeek);
  if (existing) return { status: "already-posted", isoWeek, text: "" };

  let pipeline: PipelineCompany[] = [];
  let twentyWarning = "";
  if (opts.twenty) {
    try {
      pipeline = await fetchPipelineCompanies(opts.twenty);
    } catch {
      // Twenty being down must not kill the local sections; surface it in the digest instead.
      twentyWarning = "\n\n⚠️ Twenty was unreachable — pipeline warm paths omitted this week.";
    }
  }
  const data = composeDigest(db, { now: opts.now, pipeline });
  const text = renderDigest(data) + twentyWarning;
  if (opts.dryRun) return { status: "dry-run", isoWeek, text };

  await opts.post({ channel: opts.channel, text });
  // Record only after a successful post: a failed run retries on the next daily launchd fire.
  // posted_at uses toISOString() — composeDigest compares it lexicographically with signals.at.
  db.prepare("INSERT INTO digest_runs (iso_week, posted_at, summary) VALUES (?, ?, ?)").run(
    isoWeek,
    opts.now.toISOString(),
    JSON.stringify({ reactivate: data.reactivate.length, signals: data.signals.length, warmPaths: data.warmPaths.length }),
  );
  return { status: "posted", isoWeek, text };
}
