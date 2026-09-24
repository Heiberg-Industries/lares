/**
 * Weekly voice learn — one run per enrolled mailbox (ORB-119).
 *
 * Replaces the old runtime's `voice-learn` CONTAINER, which no longer exists: every exemplar
 * in the corpus was created 2026-07-01 and nothing has learned since, so the fleet has been
 * drafting from a snapshot that ages a week every week.
 *
 * Runs Sunday 04:00 by default on the owner's clock — a per-installation setting since LAR-17-s4
 * (`packages/agent-kit/src/schedule-settings.ts`'s `voice-learn` key, no more a plain constant):
 * the corpus is read by the drafting paths all day, the learn is the only job here that both
 * bills an LLM and pages a whole mailbox, and Sunday pre-dawn is the quietest slot that still
 * refreshes before the working week. The cron is `* * * * *` and the slot is computed in `run()`
 * — the house convention (see weekly-summary.ts), because a cron expression cannot express a
 * seasonal offset. ORB-193 put that slot on `ownerTz()` with every other one; at home the
 * resolver answers `Europe/Oslo`, so nothing moves.
 *
 * Cost shape, stated because this is the fleet's only scheduled billed batch (the Aug-14/15
 * lesson): one embedding call per 32 kept emails plus ONE distillation call, per mailbox,
 * per week — bounded by `voice_profile.learn_cap`. There is no retry around either. A failure
 * sets `learn_status = 'error'` with the message and the run is simply skipped until next
 * week, or until the console's re-learn button asks for it.
 *
 * That button is the second trigger, and it is not decoration: the console writes
 * `relearn_requested_at` (`services/console/app/actions/voice.ts:57`) and the OLD job polled
 * it. Dropping the poll in the port would have left a button that silently does nothing —
 * so the tick claims the request (clears it first, then runs) and a manual re-learn lands
 * within a minute instead of waiting for Sunday.
 */
import { defineSchedule } from "eve/schedules";

import { getPool } from "@lares/agent-kit/db";
import { googleClients, listEnrolledMailboxes } from "../../lib/google.js";
import { gatewayComplete } from "../../lib/llm-complete.js";
import { makeGatewayEmbedder } from "../../lib/embeddings-gateway.js";
import { gatewayUrl, gatewayKey } from "../../lib/gateway-provider.js";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { thisAgent } from "../../lib/definition.js";
import { recordSchedulePass, recordScheduleTick } from "@lares/agent-kit/schedule-heartbeat";
import { dowIn, slotIn } from "../../lib/recurrence.js";
import { ownerTz } from "../../lib/owner-clock.js";
import { scheduleHours } from "../../lib/schedule-hours.js";
import { runVoiceLearn, readPaced, type LearnExemplar, type ProposedCard, type SentMessage } from "../../lib/voice-learn.js";

/** ORB-193 extracted the three hand-copied `osloSlotNow` helpers (this was the third) into
 *  `lib/recurrence.ts`'s `slotIn`, which takes the timezone rather than assuming Oslo — the same
 *  seam every slot schedule now shares. This weekly 04:00 pass touches nothing Bendik sees, so
 *  moving it onto the owner clock is a consistency choice, not a behaviour one: on an Oslo day
 *  the resolver answers `Europe/Oslo` and the slot is unchanged. */
function isSunday(now: Date, tz: string): boolean {
  return dowIn(now, tz) === 0;
}

interface LearnConfig { lookbackDays: number; cap: number }

/** Learn parameters live on the profile so the console stays the single control surface —
 *  the same contract the old job had (`bin/voice-learn.ts:65-68`). */
async function readConfig(): Promise<LearnConfig> {
  const { rows } = await getPool().query<{ learn_lookback_days: number; learn_cap: number }>(
    `SELECT learn_lookback_days, learn_cap FROM voice_profile WHERE id = 'default'`,
  );
  const r = rows[0];
  return { lookbackDays: r?.learn_lookback_days ?? 365, cap: r?.learn_cap ?? 300 };
}

async function upsertExemplar(e: LearnExemplar): Promise<void> {
  await getPool().query(
    `INSERT INTO voice_exemplar (id, mailbox, lang, text, vector, source_message_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (mailbox, id) DO UPDATE
       SET lang = EXCLUDED.lang, text = EXCLUDED.text, vector = EXCLUDED.vector`,
    [e.id, e.mailbox, e.lang, e.text, JSON.stringify(e.vector), e.sourceMessageId],
  );
}

/**
 * ORB-176 (sql/033): the proposed card and the learn status land on the MAILBOX's own
 * voice_profile row. The 2026-08-18 ruling ("the rules describe one human, shared across
 * mailboxes") put every proposal on `default`, so the last mailbox in a run wrote the card for
 * all of them — and a project.example sales register became the card for owner.example mail. Upserted, so
 * a mailbox enrolled after the migration gets its row on its first run. `default` keeps the
 * shared learn settings and the Relearn button (`relearn_requested_at`).
 */
export async function setProposedFor(mailbox: string, p: ProposedCard): Promise<void> {
  await getPool().query(
    `INSERT INTO voice_profile (id, proposed) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET proposed = EXCLUDED.proposed`,
    [mailbox, JSON.stringify(p)],
  );
}

export async function setStatusFor(mailbox: string, status: string, message?: string): Promise<void> {
  await getPool().query(
    `INSERT INTO voice_profile (id, learn_status, learn_message) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET learn_status = EXCLUDED.learn_status, learn_message = EXCLUDED.learn_message`,
    [mailbox, status, message ?? ""],
  );
}

/** One mailbox's Sent mail within the lookback window, capped. */
async function listSentMessages(mailbox: string, cfg: LearnConfig): Promise<SentMessage[]> {
  const gmail = await googleClients(process.env["GOOGLE_PRINCIPAL_ID"]).gmail(mailbox);
  const afterEpoch = Math.floor((Date.now() - cfg.lookbackDays * 86_400_000) / 1000);
  const ids = await gmail.search(`in:sent after:${afterEpoch}`, cfg.cap);
  // Paced: 300 tight `messages.get` calls tripped Gmail's per-minute quota on owner.example
  // (2026-09-08, twice). 20 reads, 3 s pause; one 65 s back-off on a quota error.
  const msgs = await readPaced(ids, (id) => gmail.read(id), { batch: SENT_READ_BATCH, pauseMs: SENT_READ_PAUSE_MS, backoffMs: QUOTA_BACKOFF_MS });
  return msgs.map((m) => ({ id: m.id, subject: m.subject, bodyText: m.bodyText }));
}

const SENT_READ_BATCH = 20;
const SENT_READ_PAUSE_MS = 3_000;
const QUOTA_BACKOFF_MS = 65_000;

/** Claim a console-requested re-learn: returns true if one was pending. Clearing BEFORE the
 *  run (not after) is deliberate — a run that fails must not re-fire every minute against a
 *  billed gateway, which is the shape of the Aug-14/15 incident. The failure is recorded on
 *  the profile as `learn_status = 'error'`; the human re-presses the button. */
async function claimRelearnRequest(): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE voice_profile SET relearn_requested_at = NULL
     WHERE id = 'default' AND relearn_requested_at IS NOT NULL`,
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Exported for the test suite — the whole run, minus the clock gate.
 *
 * Resolves `true` for a completed pass: zero enrolled mailboxes (an observable world state, the
 * same shape as reping's OFF-by-configuration return — nothing was wrong, there was simply
 * nothing to learn) OR at least one enrolled mailbox succeeding. Resolves `false` only when
 * EVERY enrolled mailbox failed — a per-mailbox failure alone (one of two, say) still counts as
 * a completed pass; total failure does not (ORB-175 fix round 1, controller ruling).
 */
export async function learnAllMailboxes(): Promise<boolean> {
  const cfg = await readConfig();
  const mailboxes = await listEnrolledMailboxes();
  if (mailboxes.length === 0) {
    console.warn("voice-learn: no enrolled mailboxes; skipping");
    return true;
  }

  const embedder = makeGatewayEmbedder({
    gatewayUrl: gatewayUrl(),
    apiKey: gatewayKey(),
    model: process.env["EMBED_MODEL"] ?? "heiberg-embed",
  });

  let anySucceeded = false;
  for (const mailbox of mailboxes) {
    try {
      const { kept, dropped } = await runVoiceLearn({
        mailbox,
        listSentMessages: () => listSentMessages(mailbox, cfg),
        embedder,
        think: (prompt) => gatewayComplete(prompt, { maxOutputTokens: 1024 }),
        upsertExemplar,
        setProposed: (p) => setProposedFor(mailbox, p),
        setStatus: (status, message) => setStatusFor(mailbox, status, message),
      });
      console.log(`voice-learn: ${mailbox} — kept ${kept}, dropped ${dropped}`);
      anySucceeded = true;
    } catch (err) {
      // One mailbox's failure must not cost the other its refresh. runVoiceLearn has already
      // recorded 'error' with the message on the profile, so this is visible in the console.
      console.error(`voice-learn: ${mailbox} FAILED — other mailboxes continue`, err);
    }
  }
  return anySucceeded;
}

let lastSlot: string | null = null;
let running = false;

/** ORB-175 — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/voice-learn";

export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "voice-learn")) return;
    await recordScheduleTick(getPool(), HEARTBEAT_KEY);
    if (running) return;                       // a previous run is still paging mail

    // A human pressing "re-learn" wins over the clock — checked first so an on-demand run is
    // not swallowed by the weekly slot bookkeeping.
    const requested = await claimRelearnRequest();

    const now = new Date();
    // The owner clock, resolved once per tick and cached for five minutes (lib/owner-clock.ts).
    const tz = await ownerTz();
    // LAR-17-s4 — the hour is a setting now, cached in-process for a few minutes too
    // (lib/schedule-hours.ts).
    const [hour] = await scheduleHours("voice-learn");
    const slot = slotIn(now, tz, hour);
    const scheduled = slot !== null && slot !== lastSlot && isSunday(now, tz);
    if (!requested && !scheduled) return;
    if (scheduled) lastSlot = slot;

    running = true;
    try {
      console.log(`voice-learn: starting (${requested ? "console re-learn request" : "weekly slot"})`);
      const completed = await learnAllMailboxes();
      if (completed) await recordSchedulePass(getPool(), HEARTBEAT_KEY);
    } finally {
      running = false;
    }
  },
});
