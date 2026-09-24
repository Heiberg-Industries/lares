/**
 * Outreach reply watch (ORB-75) — polls threads `agent/tools/outreach_track.ts` is tracking
 * for a reply. A thread untouched for MAX_AWAIT_DAYS stops being tracked — bounded, so this
 * table cannot grow unbounded the way the Aug 14/15 incident's retry loop did
 * (docs/solutions/2026-08-15-api-cost-leak-proposal-retry-loop.md).
 *
 * ORB-91 SECURITY: reply handling is now THINK-ONLY, then a fixed-prompt act session — see
 * lib/outreach-reply-triage.ts's module header. It used to paste the reply body straight into
 * a fresh full-tool Saga session (`to(slack, {channelId}).send(buildReplyTriagePrompt(...))`),
 * which gave a hostile reply the run of the whole harness (gmail_search, vault/atlas reads,
 * read_url — an exfil channel through the readability worker's egress). Now: classify + draft
 * via plain gatewayComplete() calls (no tool surface exists to abuse), then — only for
 * outcomes that need a real write — a session whose ENTIRE prompt is fixed, code-built
 * instructions naming the exact call(s) to make; the raw reply body never reaches it.
 *
 * ORB-93: cron itself now owns the 15-minute cadence (every-15-minutes, see the schedule
 * config below) instead of firing every minute and self-filtering on
 * `now.getMinutes() % 15 === 0` — a systematic offset between
 * when the scheduler actually fires and true wall-clock 15-minute boundaries would make that
 * modulo check NEVER pass, starving the poll entirely with no error, nothing to see in logs.
 * Native cron has no such failure mode. `beginTriage` (lib/outreach-store.ts) sets a durable
 * checkpoint before a detected reply's triage starts, so a restart/DB hiccup between
 * detecting it and `markReplied` doesn't cause the next poll to re-detect the same reply and
 * start an independent, duplicate triage (duplicate approval cards, two 👍 = two sends).
 *
 * PROACTIVITY (ORB-193): both of this schedule's outbound sends — the plain Slack notify and the
 * fixed-prompt act session — are ONE `event` initiation, keyed `outreach/<threadId>`. One reply is
 * one thing that happened; whichever of the two branches it takes, it earns one message. A
 * held-back initiation leaves the thread UNMARKED (no `markReplied`), so the next poll reconsiders
 * it once the gate reopens rather than losing the reply.
 *
 * LAR-35-s1: the BILLED work — `classifyReply` and, for a positive or meeting-request reply,
 * `draftReply` — now runs INSIDE the gate's send callback, not before it. Before this fix, both
 * calls ran ahead of the gate, so a reply arriving during quiet hours (or DND, or an owner-day
 * ceiling) was reclassified and redrafted on every 15-minute poll all night for nothing: the gate
 * only decided afterwards whether any of that work could be shown to anyone. Wrapping `classify` +
 * `draft` + `send` in one `gate(...)` call means a held or suppressed verdict short-circuits before
 * either model call is made — the thread simply stays tracked and unmarked, exactly as before, but
 * for free. (Half of ADR 0014's "two lanes bill a model" open question — the other lane,
 * meeting-followup, is a separate fix.)
 *
 * No durable multi-day session wait: eve's HITL parking only resumes on framework-known
 * events (an approval answer, an OAuth callback, a subagent completing) — "a Gmail reply
 * arrived" isn't one of those. This polls instead, the same shape every other
 * detect-then-start-a-session schedule in this codebase already uses.
 */
import { defineSchedule } from "eve/schedules";
import { callSlackApi } from "eve/channels/slack";

import slack, { slackCredentials } from "../channels/slack.js";
import { getPool } from "@lares/agent-kit/db";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { thisAgent } from "../../lib/definition.js";
import { recordSchedulePass } from "@lares/agent-kit/schedule-heartbeat";
import { allowedSlackUserIds } from "../../lib/slack-allowlist.js";
import { listAwaitingReply, markReplied, stopTracking, beginTriage, type OutreachThread } from "../../lib/outreach-store.js";
import { detectReply } from "../../lib/outreach-reply-detect.js";
import {
  classifyReply, draftReply, buildSendActPrompt, buildDoNotContactActPrompt, notifyTextFor,
} from "../../lib/outreach-reply-triage.js";
import { makeDbVoiceAccess } from "../../lib/voice-store.js";
import { googleClients, type ThreadMessage } from "../../lib/google.js";
import { emitSignal } from "../../lib/signal-emit.js";
import { doorId } from "../../lib/principals.js";
import { initiateTo, type DoorInitiate, type InitiationOutcome } from "../../lib/initiation.js";

const MAX_AWAIT_DAYS = 30;

// ─── Testable tick ──────────────────────────────────────────────────────────────────────────

export interface OutreachReplyWatchDeps {
  awaitingThreads(): Promise<OutreachThread[]>;
  readThread(account: string, threadId: string): Promise<ThreadMessage[]>;
  /** Durable checkpoint set BEFORE onReply starts (ORB-93) — false means another attempt is
   *  still within its retry window, so this tick must skip re-triaging it. */
  beginTriage(thread: OutreachThread): Promise<boolean>;
  onReply(thread: OutreachThread, reply: ThreadMessage): Promise<void>;
  onStale(thread: OutreachThread): Promise<void>;
}

export interface OutreachReplyWatchState { running: boolean }
export function freshState(): OutreachReplyWatchState { return { running: false }; }

/** `tick()` resolves `true` for a completed pass — including zero awaiting threads, or a
 *  per-thread failure caught inside the loop — and `false` when the OUTER catch swallowed the
 *  whole pass (e.g. `deps.awaitingThreads()` itself throwing) or a previous tick is still
 *  running. ORB-175's fix round 1: ONLY a `true` result may stamp the schedule's heartbeat. */
export interface OutreachReplyWatchTick {
  tick(now: Date): Promise<boolean>;
}

export function makeOutreachReplyWatchTick(
  deps: OutreachReplyWatchDeps, state: OutreachReplyWatchState = freshState(),
): OutreachReplyWatchTick {
  return {
    async tick(now) {
      if (state.running) return false; // a previous tick is still running — not this tick's pass
      state.running = true;
      try {
        const threads = await deps.awaitingThreads();
        for (const t of threads) {
          try {
            const messages = await deps.readThread(t.account, t.threadId);
            const reply = detectReply(messages, t.account, t.sentAt);
            if (reply) {
              if (await deps.beginTriage(t)) {
                await deps.onReply(t, reply);
              } else {
                console.log(`outreach-reply-watch: skipping ${t.threadId} (${t.account}) — triage already in flight`);
              }
              continue;
            }
            const ageDays = (now.getTime() - t.sentAt.getTime()) / 86_400_000;
            if (ageDays > MAX_AWAIT_DAYS) await deps.onStale(t);
          } catch (err) {
            console.error(`outreach-reply-watch: check failed for thread ${t.threadId} (${t.account})`, err);
          }
        }
        return true;
      } catch (err) {
        // A failure listing the tracked threads themselves (not a per-thread check) — the
        // caller's schedule must survive it, matching crm-routing.ts's own tick() contract.
        console.error("outreach-reply-watch: tick failed", err);
        return false;
      } finally {
        state.running = false;
      }
    },
  };
}

// ─── Live wiring ────────────────────────────────────────────────────────────────────────────

function liveSlackChannelId(): string | undefined {
  return allowedSlackUserIds()[0];
}

const liveState = freshState();

/** ORB-175 — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/outreach-reply-watch";

export default defineSchedule({
  cron: "*/15 * * * *",
  async run({ to, waitUntil, appAuth }) {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "outreach-reply-watch")) return;

    const now = new Date();

    const channelId = liveSlackChannelId();
    if (!channelId) {
      console.warn("outreach-reply-watch: no Slack principal configured (SLACK_ALLOWED_USER_IDS); skipping");
      return;
    }

    try {
      const pool = getPool();

      // ORB-193 — bound to the Slack DM both sends below go to; the itemKey is per THREAD.
      const gate: DoorInitiate = initiateTo("outreach-reply-watch", doorId("slack", channelId));

      const notify = async (text: string) => {
        const botToken = await slackCredentials.botToken();
        const res = await callSlackApi({ botToken, operation: "chat.postMessage", body: { channel: channelId, text } });
        if (!res.ok) throw new Error(`outreach-reply-watch: slack notify failed: ${String((res as { error?: unknown }).error)}`);
      };

      const startActSession = async (prompt: string) => {
        const task = to(slack, { channelId }).send(prompt, { auth: { ...appAuth, attributes: { lane: "outreach-reply-watch" } } });
        waitUntil(task);
        await task;
      };

      const deps: OutreachReplyWatchDeps = {
        awaitingThreads: () => listAwaitingReply(pool),
        readThread: async (account, threadId) => {
          const gmail = await googleClients().gmail(account);
          return gmail.readThread(threadId);
        },
        beginTriage: (thread) => beginTriage(pool, thread.id),
        async onReply(thread, reply) {
          // ORB-193 / LAR-35-s1 — ONE initiation for this reply, and the gate is asked FIRST: the
          // callback below is everything that bills or sends, so a held or suppressed verdict never
          // runs `classifyReply` or `draftReply` at all, not just never sends their result. Every
          // branch inside sends exactly one message, so all of them share the SAME key: a second
          // branch for the same thread would be the same interruption, not a new one.
          const initiation: InitiationOutcome = await gate(
            { cls: "event", itemKey: `outreach/${thread.threadId}` },
            async () => {
              // Think-only classify — the reply body reaches only this plain completion call,
              // never a tool-enabled session (ORB-91). Billed, and now inside the gate.
              const classification = await classifyReply(reply);

              if (classification === "positive" || classification === "meeting_request") {
                // The outreach was sent FROM thread.account, so the reply is drafted in that
                // mailbox's voice (sql/026_voice_per_mailbox.sql). Also billed, also inside the gate.
                const voice = makeDbVoiceAccess({ db: pool, mailbox: thread.account });
                const draft = await draftReply({ voice }, thread, reply);
                await startActSession(buildSendActPrompt(thread, reply, draft));
              } else if (classification === "unsubscribe") {
                if (thread.personId) {
                  await startActSession(buildDoNotContactActPrompt(thread));
                } else {
                  await notify(
                    `Reply on outreach thread ${thread.threadId} (${thread.account}) looks like an unsubscribe ` +
                    "request, but there's no linked CRM person to flag do-not-contact — handle manually.",
                  );
                }
              } else {
                // negative | not_now | bounce — no write, just tell Bendik. Raw postMessage, no
                // session: this is text on a chat surface, never fed back into a tool-enabled context.
                await notify(notifyTextFor(classification, thread, reply));
              }
            },
          );

          // A genuine HOLD (quiet hours, DND, a ceiling): leave the thread tracked and unmarked so
          // the next poll re-detects this same reply — and, now, re-tries the classify/draft it
          // never got to run. `beginTriage`'s checkpoint expires on its own retry window, which is
          // what makes that re-detection possible rather than a permanent "triage in flight".
          //
          // ALREADY SEEN is the opposite instruction (fix round 1, CRITICAL) and falls through to
          // `markReplied`: a `sent` row for `outreach/<threadId>` proves he was already told about
          // this reply, so the thread is finished whatever happened to the write that failed last
          // time. Left "eligible", it would be re-classified — a BILLED `classifyReply` plus a
          // billed `draftReply` — on every poll, forever, for a reply he has already seen.
          if (!initiation.handled) return;

          await markReplied(pool, thread.id);
        },
        async onStale(thread) {
          await stopTracking(pool, thread.id);
          console.log(`outreach-reply-watch: stopped tracking ${thread.threadId} (${thread.account}) — no reply after ${MAX_AWAIT_DAYS} days`);
        },
      };

      const completed = await makeOutreachReplyWatchTick(deps, liveState).tick(now);
      if (completed) await recordSchedulePass(pool, HEARTBEAT_KEY);
    } catch (err) {
      console.error("outreach-reply-watch: live wiring failed", err);
      await emitSignal("schedule-tick-failed", "outreach-reply-watch: tick failed", String(err));
    }
  },
});
