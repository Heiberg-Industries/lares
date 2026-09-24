import type { Db } from "./db.js";
import { importLinkedIn, type LinkedInSummary } from "./importers/linkedin.js";
import { importContacts, type ContactsSummary } from "./importers/contacts.js";
import { importIMessage, type IMessageSummary } from "./importers/imessage.js";
import { importCalls, type CallsSummary } from "./importers/calls.js";
import { importMeta, type MetaSummary } from "./importers/meta.js";
import { computePulse, type InteractionRow } from "./pulse.js";
import { detectCallUnreturned } from "./call-signals.js";

export type ImportOptions = {
  linkedInDir?: string;
  ownLinkedInUrl: string;
  /** Meta export root (~/.lares/exports/meta). Omit to skip Meta ingestion. */
  metaDir?: string;
  /** The owner's display name for Meta direction classification. */
  ownMetaName?: string;
  /** per-source toggles, default all true; tests disable Apple sources */
  sources?: { contacts?: boolean; imessage?: boolean; calls?: boolean };
  now?: Date;
};

export type ImportReport = {
  contacts?: ContactsSummary;
  imessage?: IMessageSummary;
  calls?: CallsSummary;
  linkedin?: LinkedInSummary;
  meta?: MetaSummary;
  pulse: { scored: number; dormantWarm: number; cadenceBreaks: number };
  callSignals?: number;
};

export function runImport(db: Db, opts: ImportOptions): ImportReport {
  // Validate every requested export before reading sources or writing any rows.
  if (opts.linkedInDir && (typeof opts.ownLinkedInUrl !== "string" || !opts.ownLinkedInUrl.trim())) {
    throw new Error("Set ownLinkedInUrl in the network config before importing LinkedIn exports.");
  }
  if (opts.metaDir && (typeof opts.ownMetaName !== "string" || !opts.ownMetaName.trim())) {
    throw new Error("Set ownMetaName in the network config before importing Meta exports.");
  }
  const on = { contacts: true, imessage: true, calls: true, ...(opts.sources ?? {}) };
  const report = {} as ImportReport;

  // Contacts first: best identities, so later sources resolve onto real names.
  if (on.contacts) report.contacts = importContacts(db);
  if (opts.linkedInDir) report.linkedin = importLinkedIn(db, opts.linkedInDir, opts.ownLinkedInUrl);
  if (opts.metaDir) report.meta = importMeta(db, opts.metaDir, opts.ownMetaName!);
  if (on.imessage) report.imessage = importIMessage(db);
  if (on.calls) report.calls = importCalls(db);

  report.pulse = recomputePulse(db, opts.now ?? new Date());
  report.callSignals = detectCallUnreturned(db, opts.now ?? new Date());

  db.prepare("INSERT INTO import_runs (source, ran_at, summary) VALUES (?, ?, ?)").run(
    "all", new Date().toISOString(), JSON.stringify(report),
  );
  return report;
}

export function recomputePulse(db: Db, now: Date): { scored: number; dormantWarm: number; cadenceBreaks: number } {
  const contacts = db.prepare("SELECT id, twenty_last_contacted FROM contacts").all() as { id: number; twenty_last_contacted: string | null }[];
  const getRows = db.prepare(
    // Outbound calls are always logged with answered=0 on macOS — we can't trust the answered
    // column for outbound calls. Include ALL outbound calls and only drop truly unanswered
    // INBOUND calls (where answered=0 means the call was never picked up by the owner).
    `SELECT channel, direction, at FROM interactions
     WHERE contact_id = ?
       AND channel != 'linkedin_invite'
       AND NOT (channel = 'call' AND answered = 0 AND direction = 'inbound')`,
  );
  const getPrev = db.prepare("SELECT band, dormant_warm FROM pulse WHERE contact_id = ?");
  const upsert = db.prepare(
    `INSERT INTO pulse (contact_id, score, band, dormant_warm, last_interaction_at, components)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(contact_id) DO UPDATE SET score=excluded.score, band=excluded.band,
       dormant_warm=excluded.dormant_warm, last_interaction_at=excluded.last_interaction_at,
       components=excluded.components`,
  );
  const insSignal = db.prepare("INSERT INTO signals (contact_id, kind, at, evidence) VALUES (?, 'cadence_break', ?, ?)");

  let scored = 0, dormantWarm = 0, cadenceBreaks = 0;
  const tx = db.transaction(() => {
    for (const c of contacts) {
      const rows = getRows.all(c.id) as InteractionRow[];
      const p = computePulse(rows, now, c.twenty_last_contacted);
      const prev = getPrev.get(c.id) as { band: string; dormant_warm: number } | undefined;
      // cadence_break fires on the transition into dormant-warm
      if (p.dormantWarm && prev && !prev.dormant_warm) {
        insSignal.run(c.id, now.toISOString(), JSON.stringify({ lastInteractionAt: p.lastInteractionAt, previousBand: prev.band }));
        cadenceBreaks++;
      }
      upsert.run(c.id, p.score, p.band, p.dormantWarm ? 1 : 0, p.lastInteractionAt, JSON.stringify(p.components));
      scored++;
      if (p.dormantWarm) dormantWarm++;
    }
  });
  tx();
  return { scored, dormantWarm, cadenceBreaks };
}
