/**
 * The digest — 09:00 and 17:00 Europe/Oslo, plus an on-demand drain of `digest_requests`.
 *
 * Replaces the old runtime's standalone digest CONTAINER (`services/agent-runtime/bin/digest.ts`).
 * One pass: pull new Karakeep saves and Notion saved links into `_inbox`, list `_inbox`, classify each item through the
 * gateway, file the confident ones (write + retire the source in ONE commit), record a skip and
 * ask about the rest, then post ONE Slack summary with any error detail as a thread reply.
 *
 * TIMEZONE: the house "poll every minute, gate on the wall clock" shape — a fixed cron string
 * cannot track a seasonal offset. `dueScheduledSlot` requires `minute === 0`, so a container down
 * across the whole slot minute misses that slot; that is pre-existing house behaviour (stability
 * finding S3b), ported rather than quietly changed. ORB-193 made the clock the OWNER's
 * (`ownerTz()`, cached per tick): at home it answers `Europe/Oslo` and 09:00/17:00 are the slots
 * they have always been.
 *
 * PROACTIVITY (ORB-193): the SCHEDULED pass's Slack summary passes `@lares/agent-kit`'s gate as a
 * `scheduled` initiation keyed on the slot. An ON-DEMAND pass (`digest_run`) does NOT — it is a
 * reply to something Bendik just asked for, and a reply is not an initiation. Everything else in
 * a held-back pass still happens: the Karakeep pull, the filing, the skip rows and the heartbeat.
 * Only the message is withheld, and the morning brief's held-back line names it.
 *
 * THREE GATES, all fail-closed: this definition's own `schedules.digest.on` (read fresh at
 * every tick via `scheduleEnabled`, ORB-278 step 2 — silence means on, same as every other
 * schedule), the service-wide `EVE_SCHEDULES_LIVE` (ANDed into `scheduleEnabled` itself), and
 * this port's own `EVE_DIGEST_LIVE`. The last exists because `claimDigestRequests` is a
 * DELETE … RETURNING — while the old container still runs, two consumers would race for
 * on-demand rows and double-post scheduled passes. The cutover flips this gate and stops that
 * container in ONE change.
 *
 * SLACK DELIVERY is a RAW `callSlackApi` postMessage — no session, no model turn — matching
 * `email-triage.ts` and `reminders.ts`, which use the same primitive for the same reason: the
 * digest's text is already fully composed by `renderDigest`, so handing it to a model would only
 * risk it being rewritten.
 */
import { defineSchedule } from "eve/schedules";
import { callSlackApi } from "eve/channels/slack";
import { basename, join } from "node:path";
import { readdirSync, readFileSync, statSync, promises as fsPromises } from "node:fs";

import { slackCredentials } from "../channels/slack.js";
import { getPool } from "@lares/agent-kit/db";
import { scheduleGate } from "@lares/agent-kit/schedule-gate";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { recordSchedulePass, recordScheduleTick } from "@lares/agent-kit/schedule-heartbeat";
import { storeRoot, listNotes } from "@lares/agent-kit/notes-store";
import { thisAgent } from "../../lib/definition.js";
import { gatewayComplete } from "../../lib/llm-complete.js";
import { allowedSlackUserIds } from "../../lib/slack-allowlist.js";
import { writeRawNote } from "@lares/agent-kit/vault-raw";
import { makeDigestFileNote } from "../../lib/digest-file.js";
import {
  claimDigestRequests, recordDigestSkip, listSkippedPaths, type DigestRequest,
} from "../../lib/digest-store.js";
import { makeKarakeepClient, makePgSeenStore, syncKarakeep } from "../../lib/karakeep.js";
import { clippingPass, makeVaultInbox } from "../../lib/clipping/step.js";
import { makeNotionClient, readNotionToken } from "../../lib/clipping/notion-reader.js";
import { normaliseUrl } from "../../lib/clipping/record.js";
import { readClippingChoice, recordKarakeepImport } from "../../lib/clipping/store.js";
import { parseFrontmatter } from "../../lib/digest/extract.js";
import { runDigest } from "../../lib/digest/runner.js";
import { dueScheduledSlot } from "../../lib/digest/schedule.js";
import { doorId } from "../../lib/principals.js";
import { initiate } from "../../lib/initiation.js";
import { ownerTz } from "../../lib/owner-clock.js";
import { scheduleHours } from "../../lib/schedule-hours.js";
import { makeEnrich } from "../../lib/digest/enrich.js";
import { digestReadability } from "../../lib/digest/readability.js";
import { emitSignal } from "../../lib/signal-emit.js";

/** Must match the producer's own constant (`agent/tools/digest_run.ts`), which polls on agent. */
const AGENT = "saga";

/** ORB-175 — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/digest";

/** Both gates, fail-closed on anything but the exact string "1". */
export function digestGate(env: NodeJS.ProcessEnv = process.env): boolean {
  return scheduleGate(env) && env["EVE_DIGEST_LIVE"] === "1";
}

/**
 * A scheduled pass ALWAYS goes to Bendik's DM; a purely on-demand pass replies in the thread
 * that asked for it. Ported from `bin/digest.ts:122`.
 */
export function chooseTarget(
  scheduled: boolean,
  requests: DigestRequest[],
  dmTarget: string,
): string {
  if (scheduled) return dmTarget;
  return requests[0]?.threadRef ?? dmTarget;
}

function vaultRoot(): string {
  return storeRoot("brain");
}

function listInboxFiles(): { path: string; body: string }[] {
  const inbox = join(vaultRoot(), "_inbox");
  let entries: string[] = [];
  try { entries = readdirSync(inbox); } catch { return []; }
  return entries
    .filter((n) => n.endsWith(".md"))
    .map((n) => ({ rel: `_inbox/${n}`, abs: join(inbox, n) }))
    .filter((e) => { try { return statSync(e.abs).isFile(); } catch { return false; } })
    .map((e) => ({ path: e.rel, body: readFileSync(e.abs, "utf8") }));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The digest's Slack DM target — Bendik's own id, from the fail-closed allowlist. */
function dmTarget(): string | undefined {
  return process.env["DIGEST_SLACK_TARGET"] || allowedSlackUserIds()[0];
}

async function postToSlack(channel: string, text: string, threadTs?: string): Promise<string | undefined> {
  const res = await callSlackApi({
    botToken: slackCredentials.botToken,
    operation: "chat.postMessage",
    body: { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) },
  });
  if (!res.ok) throw new Error(`digest: slack post failed: ${String((res as { error?: unknown }).error)}`);
  return (res as { ts?: string }).ts;
}

/**
 * Karakeep → `_inbox`, best-effort. Runs FIRST so the same pass enriches and files what it pulls.
 *
 * Writes RAW and uncommitted (`writeRawNote`), exactly as the old service did via `writeRaw` —
 * a commit per imported bookmark would be noise, and the digest's own filing step commits the
 * note properly a moment later anyway. Unconfigured (no URL or key) is a silent no-op, by design.
 */
async function karakeepPass(log: (m: string) => void): Promise<void> {
  const base = process.env["KARAKEEP_URL"] ?? "";
  let token = "";
  try {
    token = readFileSync(
      process.env["KARAKEEP_API_KEY_FILE"] ?? "/run/secrets/karakeep-api-key", "utf8",
    ).trim();
  } catch { /* unconfigured — skip, as the old service did */ }
  if (!base || !token) return;

  const db = getPool();
  const seen = makePgSeenStore(db);
  await seen.ensure();
  const root = vaultRoot();
  const written = await syncKarakeep({
    client: makeKarakeepClient({ baseUrl: base, token }),
    seen,
    writeNote: async (o) => {
      await writeRawNote({ vaultRoot: root, relPath: o.relPath, bytes: Buffer.from(o.body, "utf8") });
      // LAR-113: remember the link in the clipping ledger so a Notion clip of the same link in the
      // same inbox is not brought in twice. Best effort: Karakeep's own seen table stays the truth.
      try {
        const fm = parseFrontmatter(o.body);
        const urlKey = normaliseUrl(fm["url"] ?? "");
        const bookmarkId = fm["karakeep_id"];
        if (urlKey && bookmarkId) await recordKarakeepImport(db, { bookmarkId, urlKey, inboxPath: o.relPath });
      } catch (e) { log(`karakeep: could not record the link for duplicate checks (${String(e)})`); }
    },
    log,
  });
  if (written > 0) log(`karakeep: imported ${written} new bookmark(s) to _inbox`);
}

/**
 * Notion saved links to `_inbox` (LAR-113). Runs right after the Karakeep pull so the same pass
 * enriches and files what it brings in. A failure is NOT swallowed: `clippingPass` records it,
 * opens a repair and hands back a line for this pass's digest summary. No model call here.
 */
async function clippingStep(log: (m: string) => void): Promise<string[]> {
  try {
    const result = await clippingPass({
      db: getPool(),
      inbox: makeVaultInbox(vaultRoot()),
      token: () => readNotionToken(),
      makeClient: (token) => makeNotionClient({ token, proxyUrl: process.env["EGRESS_PROXY_URL"] }),
      log,
    });
    return result.notices;
  } catch (e) {
    // Migration 091 not applied yet: nothing can be configured, so this is "not configured".
    if ((e as { code?: string })?.code === "42P01" && /clipping_(sources|items)/.test(String((e as Error).message))) {
      log("clipping: the clipping tables are not there yet (apply box migration 091); skipped");
      return [];
    }
    // Only reachable when even the state row could not be read or written (database trouble).
    console.error("digest: clipping step failed (continuing):", e);
    return ["Clipping from Notion could not be checked this pass: Lares could not read its own records."];
  }
}

export async function runDigestPass(
  target: string,
  mode: "scheduled" | "on-demand",
  // ORB-193 — present only for a SCHEDULED pass: the slot key the initiation is deduped on, and
  // the owner clock it was computed from. Absent means "not an initiation", which is exactly what
  // an on-demand `digest_run` reply is.
  initiation?: { slot: string; tz: string; now: Date },
): Promise<void> {
  const db = getPool();
  const log = (m: string) => console.log(`digest: ${m}`);
  const root = vaultRoot();

  // LAR-113: the owner's choice of source (Clipping card). No row, or a box without migration 092,
  // is today's behaviour: each source runs if it is set up. `notion` skips Karakeep; `karakeep`
  // skips the Notion step; `both` is the changeover and runs both.
  const choice = await readClippingChoice(db).catch((e) => {
    log(`could not read the clipping source choice (${String(e)}); running every source that is set up`);
    return null;
  });

  // Best-effort: a Karakeep hiccup must never block the digest itself.
  if (choice === "notion") log("karakeep: skipped (clipping is set to Notion)");
  else {
    try { await karakeepPass(log); }
    catch (e) { console.error("digest: karakeep sync failed (continuing):", e); }
  }

  // Best-effort for the digest, never silent for the owner: a failure becomes a notice below.
  let notices: string[] = [];
  if (choice === "karakeep") log("clipping: skipped (clipping is set to Karakeep)");
  else notices = await clippingStep(log);

  const summary = await runDigest({
    agent: AGENT,
    mode,
    notices,
    listInbox: async () => listInboxFiles(),
    alreadySkipped: () => listSkippedPaths(db, AGENT),
    noteNames: async () => listNotes(root).map((p) => basename(p, ".md")),
    llm: (prompt: string) => gatewayComplete(prompt),
    fileNote: makeDigestFileNote(root),
    recordSkip: (path, reason) => recordDigestSkip(db, { agent: AGENT, path, reason }),
    post: async (view) => {
      const post = async () => {
        const accepted = await emitSignal("daily-digest", view.report.title, view.text, {
          kind: "report",
          type: "user-feedback",
          severity: "info",
          key: "daily",
          fingerprintKey: "user-feedback|daily",
          sections: view.report.sections,
          links: view.report.links,
          target,
        });
        // The spine adapter deliberately never throws. A false result means it was unconfigured,
        // unreachable or rejected the payload, so the old direct Slack delivery remains the
        // lossless fallback (and supplies a ts for an error-detail thread reply).
        return accepted ? undefined : postToSlack(target, view.text);
      };
      if (!initiation) return { ts: await post() };
      // A suppressed summary leaves `ts` undefined, so `postErrorDetail` below logs the paths
      // instead of threading them under a message that was never posted.
      // `ts` stays undefined on anything but a real send (a hold, or an already-posted slot), which
      // is what routes `postErrorDetail` to the log instead of threading under a message that is not
      // there. Nothing else in a pass depends on it.
      let ts: string | undefined;
      await initiate(
        "digest",
        {
          cls: "scheduled",
          door: doorId("slack", target),
          itemKey: `digest/${initiation.slot}`,
          now: initiation.now,
          tz: initiation.tz,
        },
        async () => { ts = await post(); },
      );
      return { ts };
    },
    // Error paths go to a REPLY in the summary's thread — paths never belong in the headline.
    postErrorDetail: async (parentTs, text) => {
      if (parentTs) await postToSlack(target, text, parentTs);
      else console.log(text);
    },
    capturedAt: todayIso(),
    log,
    enrich: makeEnrich({
      readability: digestReadability(),
      readFile: (rel: string) => fsPromises.readFile(join(root, rel)),
    }),
  });

  log(`pass done — filed ${summary.filed.length}, asked ${summary.asked.length}, errors ${summary.errors.length}`);
  await emitSignal("digest-run", "Saga ran the digest", undefined, {
    kind: "event", severity: "info", key: "digest",
  });

  // ORB-175 (was ORB-179's private row) — the durable trace. Stamped after EVERY pass, filed-0
  // included: "ran and found nothing" must be distinguishable from "never ran".
  await recordSchedulePass(db, HEARTBEAT_KEY);
}

let lastSlot: string | null = null;
let running = false;

export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "digest")) return;
    if (!digestGate()) return;
    await recordScheduleTick(getPool(), HEARTBEAT_KEY);
    if (running) return;

    const now = new Date();
    // The owner clock, resolved once per tick and cached for five minutes (lib/owner-clock.ts).
    const tz = await ownerTz();
    // LAR-17-s3 — the slots are a setting now, cached in-process for a few minutes
    // (lib/schedule-hours.ts) so this per-minute tick does not query Postgres for an answer
    // that changes only a handful of times a year.
    const hours = await scheduleHours("digest");
    const slot = dueScheduledSlot(now, tz, hours);
    const scheduled = slot !== null && slot !== lastSlot;

    // Claimed every tick, not only on a slot — this is what makes `digest_run` responsive.
    const db = getPool();
    const requests = await claimDigestRequests(db, AGENT)
      .catch((e) => { console.warn("digest: claim failed", e); return [] as DigestRequest[]; });

    if (!scheduled && requests.length === 0) return;

    const dm = dmTarget();
    const target = chooseTarget(scheduled, requests, dm ?? "");
    if (!target) {
      console.warn("digest: no Slack target (DIGEST_SLACK_TARGET / SLACK_ALLOWED_USER_IDS); skipping");
      return;
    }

    running = true;
    if (scheduled && slot) lastSlot = slot;
    try {
      console.log(`digest: running (${scheduled ? `scheduled ${slot}` : "on-demand"})`);
      await runDigestPass(
        target,
        scheduled ? "scheduled" : "on-demand",
        scheduled && slot ? { slot, tz, now } : undefined,
      );
    } catch (e) {
      console.error("digest: pass failed", e);
    } finally {
      running = false;
    }
  },
});
