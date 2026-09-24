/**
 * Email triage — the eve schedule (ORB-76, Option A: native Gmail polling, replacing BOTH
 * the old runtime's email-watcher container and saga-workflow's triage consumer).
 *
 * Every enrolled mailbox (both owner@owner.example and owner@project.example — `listEnrolledMailboxes`,
 * no hard-coded account), a short rolling window (`in:inbox -from:me newer_than:2d`), each
 * candidate message claimed via `email-triage-store.ts`'s exactly-once table, then
 * `lib/email-triage.ts`'s triageOneMessage does the actual classify/draft.
 *
 * COST-SAFETY (the Aug 14/15 lesson, docs/solutions/2026-08-15-api-cost-leak-proposal-retry-loop.md):
 * `TRIAGE_CEILING_PER_TICK` bounds how many billed triage calls one tick can make — without
 * it, a first-tick or post-outage backfill (many candidates surfacing at once from the 2-day
 * scan window) would fire one billed call per candidate with no limit. `claimMessage` seeds
 * the outcome as 'error' before triage runs, so a genuine crash mid-triage leaves an honest
 * trail; it now retries a still-'error' row up to MAX_ATTEMPTS times (ORB-92) rather than
 * treating every post-claim failure as permanent — see email-triage-store.ts's module header
 * for why an unconditional one-shot-forever was itself a silent-drop bug.
 *
 * ORB-92: candidates whose thread Bendik already replied to manually (most likely a message
 * that arrived while this schedule was down) are skipped before any billed call — the
 * `-from:me` scan window can't tell the difference between "never answered" and "already
 * answered by a human," only `readThread` + `hasHumanReplyAfter` can.
 *
 * Slack notification is a RAW postMessage (`callSlackApi`, no session/model turn) — matches
 * the old runtime's verbatim delivery exactly, same primitive `reminders.ts` already
 * documents and uses for the identical reason.
 *
 * PROACTIVITY (ORB-193): that notification is an `event` initiation through
 * `@lares/agent-kit`'s gate, keyed `email-triage/<mailbox>/<messageId>`. Only the PING is gated —
 * the classify and the draft happen either way, and the outcome row is written either way, because
 * the draft genuinely exists. There is deliberately no `notified` column in v1: a held-back ping
 * is reported by the morning brief's held-back line, not re-attempted from a marker.
 */
import { defineSchedule } from "eve/schedules";
import { configuredOwnerId, listAliases } from "../../lib/identity-client.js";
import { callSlackApi } from "eve/channels/slack";

import { slackCredentials } from "../channels/slack.js";
import { getPool } from "@lares/agent-kit/db";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { thisAgent } from "../../lib/definition.js";
import { recordSchedulePass } from "@lares/agent-kit/schedule-heartbeat";
import { allowedSlackUserIds } from "../../lib/slack-allowlist.js";
import { googleClients, listEnrolledMailboxes, type MailMessage, type ThreadMessage, type GmailClient, type CalendarClient } from "../../lib/google.js";
import { makeDbVoiceAccess } from "../../lib/voice-store.js";
import { triageOneMessage, notifyTextFor, hasHumanReplyAfter, type TriageResult } from "../../lib/email-triage.js";
import { claimMessage, recordOutcome, recordDraft, pruneOldRecords, MAX_ATTEMPTS, type TriageOutcome, type ClaimResult } from "../../lib/email-triage-store.js";
import { emitSignal } from "../../lib/signal-emit.js";
import { doorId } from "../../lib/principals.js";
import { initiateTo, SEND_UNGATED, type DoorInitiate } from "../../lib/initiation.js";
import { gatherPerson, type PersonDossier, type PersonSources } from "../../lib/person/gather.js";
import { renderDossier } from "../../lib/person/render.js";
import { eveSagaPersonWiring, makePersonSources } from "../../lib/person-sources.js";

const SCAN_WINDOW_DAYS = 2;
const SCAN_CEILING = 100;
const TRIAGE_CEILING_PER_TICK = 10;

/**
 * The dossier text handed to the DRAFTER — deliberately NOT every dossier `renderDossier` can
 * produce (ORB-147 Task 4 review, Important finding). `renderDossier`'s `ambiguous`/`unknown`
 * branches (`lib/person/render.ts:61-136`) are authored as second-person INSTRUCTIONS for
 * Saga-the-conversationalist talking to Bendik — "Ask him which one", "You cannot search the
 * web — you have no search tool, only `read_url.fetch` for a link you are GIVEN" — not facts
 * about the counterpart. Placed verbatim under a `## Person` block in a reply-drafting prompt,
 * they can leak into the draft itself: a reply to an external third party that mentions the
 * CRM, offers LinkedIn search links, or references a tool name that means nothing to them. The
 * `unknown` branch is exactly the case that fires for a cold inbound sender in neither Twenty
 * nor the network graph — the population a drafted reply most needs to get right.
 *
 * Only a RESOLVED dossier carries facts a draft can use; the unresolved branches carry no
 * facts worth this section existing for anyway, so gating them to `null` costs nothing —
 * `labeledContext` (`@lares/compose-contract`) drops an empty block rather than rendering a
 * bare label with no content.
 */
export function renderDossierForDraft(d: PersonDossier): string | null {
  if (d.resolution.kind === "resolved") return renderDossier(d, { bounded: true });

  // ORB-147 review, Minor finding 3: a failed CRM/pulse/identity read collapses into
  // `resolution.kind === "unknown"` — the exact SAME branch a genuinely never-seen sender
  // takes — and this function used to return null either way with zero trace. A Twenty
  // outage then looks exactly like a run of cold senders: the ORB-119 shape, six weeks of a
  // swallowed 401 hiding behind what reads as an empty result. Logging here does not change
  // what this function returns — the Person block still silently drops from the draft, which
  // stays correct (see the module header above) — it only makes an outage visible.
  const failed = [d.sources.crm, d.sources.pulse, d.sources.identity]
    .filter((s): s is Extract<typeof s, { status: "failed" }> => s.status === "failed")
    .map((s) => `${s.source} (${s.reason})`);
  console.error(
    `email-triage: person dossier NOT resolved (${d.resolution.kind}) for query ${JSON.stringify(d.query)}` +
    (failed.length > 0 ? ` — failed source(s): ${failed.join(", ")}` : " — no source failed (genuinely unknown/ambiguous)"),
  );
  return null;
}

/**
 * The drafter's dossier lookup, as one function so the option it passes is testable (ORB-166 review
 * fix). `{ organisation: false }` is not a tuning knob — it is the other half of `bounded`:
 * `renderDossierForDraft` drops the ORGANISATION section from every draft, so gathering it was
 * pure cost. Up to six synchronous full-note-store walks plus a Twenty call, per inbound message,
 * per tick, for text that was discarded immediately. Skipping it here and dropping the section
 * there must stay a matched pair — if a later ticket gives the drafter organisation context, this
 * option comes off at the same time.
 */
export function draftDossierLookup(sources: PersonSources): (email: string) => Promise<string | null> {
  return async (email) =>
    renderDossierForDraft(await gatherPerson({ email }, sources, { organisation: false }));
}

function storedOutcome(result: TriageResult): TriageOutcome {
  // "draft-pending" means a draft already existed on the thread — handled, not an error;
  // stored the same as a fresh draft since both mean "there's a draft for Bendik to review."
  return result.outcome === "draft-pending" ? "drafted" : result.outcome;
}

// ─── Testable tick ──────────────────────────────────────────────────────────────────────────

export interface EmailTriageDeps {
  mailboxes(): Promise<string[]>;
  searchCandidates(mailbox: string): Promise<string[]>;
  readMessage(mailbox: string, id: string): Promise<MailMessage | null>;
  readThread(mailbox: string, threadId: string): Promise<ThreadMessage[]>;
  claim(mailbox: string, id: string): Promise<ClaimResult>;
  /** `thread` is the SAME array the tick already fetched via `readThread` (for
   *  `hasHumanReplyAfter`) — passed through, never fetched a second time. */
  triage(mailbox: string, msg: MailMessage, thread: ThreadMessage[]): Promise<TriageResult>;
  recordOutcome(mailbox: string, id: string, outcome: TriageOutcome): Promise<void>;
  /** sql/034: remember the Gmail draft a `drafted` outcome created. Optional so every existing
   *  caller/test keeps constructing deps unchanged. */
  recordDraft?(mailbox: string, id: string, draft: { draftId: string; threadId: string }): Promise<void>;
  /** ORB-193 — `item` is what the initiation is keyed on: the message this ping is ABOUT. */
  notify(text: string, item: { mailbox: string; messageId: string }): Promise<void>;
  /**
   * ORB-193 — the proactivity gate the Slack ping passes (`event` class). Injected so this factory
   * stays pure and its unit tests keep running with no ledger; the live wiring passes the real one.
   *
   * A held-back ping does NOT hold back the draft: `triage` has already run and the draft is
   * sitting in Gmail, and the outcome row records that truthfully. v1 keeps no "notified" column —
   * the ping is simply skipped, and the morning brief's held-back line is what tells him something
   * was withheld (the plan's Task 3 ruling). So a suppressed ping means: the work happened, the
   * interruption did not.
   */
  gate?: DoorInitiate;
  /** The final allowed attempt (see MAX_ATTEMPTS) also failed — report it loudly instead of
   *  letting the standing 'error' outcome be the only trace (ORB-92). */
  reportDropped(mailbox: string, id: string, err: unknown): Promise<void>;
  prune(): Promise<void>;
}

export interface EmailTriageState { running: boolean }
export function freshState(): EmailTriageState { return { running: false }; }

/** `tick()` resolves `true` for a completed pass — including zero mailboxes, zero candidates,
 *  or a per-item failure caught inside the loop (one bad message must not cost the whole tick
 *  its heartbeat) — and `false` when the OUTER catch swallowed the whole pass (e.g.
 *  `deps.mailboxes()` itself throwing) or a previous tick is still running. ORB-175's fix round
 *  1: ONLY a `true` result may stamp the schedule's heartbeat — ticking through a total outage
 *  must not read as a healthy pass. */
export interface EmailTriageTick { tick(): Promise<boolean> }

export function makeEmailTriageTick(deps: EmailTriageDeps, state: EmailTriageState = freshState()): EmailTriageTick {
  return {
    async tick() {
      if (state.running) return false; // a previous tick is still running — not this tick's pass
      state.running = true;
      try {
        const mailboxes = await deps.mailboxes();
        let billedThisTick = 0;
        outer: for (const mailbox of mailboxes) {
          try {
            const ids = await deps.searchCandidates(mailbox);
            for (const id of ids) {
              // Cap first — a tick that's already spent its billed-call budget must not
              // claim (and thereby spend an attempt on) messages it isn't going to process;
              // leaving them unclaimed means the next tick's re-scan picks them up fresh.
              if (billedThisTick >= TRIAGE_CEILING_PER_TICK) break outer;

              const claimResult = await deps.claim(mailbox, id);
              if (!claimResult.claimed) continue; // already handled, or retries exhausted
              try {
                const msg = await deps.readMessage(mailbox, id);
                if (!msg) {
                  if (claimResult.isFinalAttempt) {
                    await deps.reportDropped(mailbox, id, new Error("message could not be read (deleted?)"));
                  }
                  continue; // seeded 'error' stands; retried next tick unless this was final
                }

                // Skip threads Bendik already answered manually — a backfill/outage replay
                // must not re-draft (or ping about) something already handled.
                const threadMessages = await deps.readThread(mailbox, msg.threadId);
                if (hasHumanReplyAfter(threadMessages, mailbox, msg.sentAt)) {
                  await deps.recordOutcome(mailbox, id, "fyi");
                  continue;
                }

                billedThisTick++;
                const result = await deps.triage(mailbox, msg, threadMessages);
                await deps.recordOutcome(mailbox, id, storedOutcome(result));
                if (result.outcome === "drafted" && result.draftId && result.threadId && deps.recordDraft) {
                  await deps.recordDraft(mailbox, id, { draftId: result.draftId, threadId: result.threadId });
                }
                if (result.outcome === "drafted") {
                  await emitSignal("email-draft-written", "Saga wrote an email draft", undefined, {
                    kind: "event", severity: "info", key: result.account,
                  });
                }
                const text = notifyTextFor(result);
                if (text) {
                  // Nothing to finish afterwards — `recordOutcome` above already recorded the draft,
                  // which is why this lane needs no `handled` branch: an already-seen ping means the
                  // ping went out on an earlier tick, and nothing else was ever owed.
                  const gate = deps.gate ?? SEND_UNGATED;
                  await gate(
                    { cls: "event", itemKey: `email-triage/${mailbox}/${id}` },
                    () => deps.notify(text, { mailbox, messageId: id }),
                  );
                }
              } catch (err) {
                console.error(`email-triage: failed to process ${mailbox}:${id}`, err);
                if (claimResult.isFinalAttempt) await deps.reportDropped(mailbox, id, err);
              }
            }
          } catch (err) {
            console.error(`email-triage: mailbox scan failed for ${mailbox}`, err);
          }
        }
        await deps.prune();
        return true;
      } catch (err) {
        console.error("email-triage: tick failed", err);
        return false;
      } finally {
        state.running = false;
      }
    },
  };
}

// ─── Live wiring ────────────────────────────────────────────────────────────────────────────

const liveState = freshState();

/** ORB-175 — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/email-triage";

export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "email-triage")) return;

    const channelId = allowedSlackUserIds()[0];
    if (!channelId) {
      console.warn("email-triage: no Slack principal configured (SLACK_ALLOWED_USER_IDS); skipping");
      return;
    }

    try {
      const pool = getPool();
      const principal = process.env["GOOGLE_PRINCIPAL_ID"];
      const query = `in:inbox -from:me newer_than:${SCAN_WINDOW_DAYS}d`;

      // ORB-147 review, Important finding 2: `calendarClient()` below resolves NO explicit
      // account, so it always lands on `CALENDAR_PRIMARY_EMAIL` (env-pinned to
      // owner@owner.example, `services/box/compose.yaml`) — ONE calendar of the TWO
      // Google accounts enrolled — and always queries the literal calendarId "primary"
      // (`calFor`'s default, `lib/google.ts`). Named here once, per tick, and threaded through
      // to `triageOneMessage` so `renderBusyBlock`'s "no conflicts" text reads as the scoped
      // claim it actually is rather than a universal one.
      const calendarLabel = `${process.env["CALENDAR_PRIMARY_EMAIL"] ?? "the primary Google account"}'s primary calendar`;

      // ORB-92 efficiency finding: resolving a Gmail client re-decrypts the refresh token
      // from the DB every call — this used to happen fresh for search/read/triage
      // independently (up to 3x per message, plus once per mailbox per tick). One resolution
      // per mailbox per tick, reused by every dep below.
      const gmailByMailbox = new Map<string, Promise<GmailClient>>();
      function gmailFor(mailbox: string): Promise<GmailClient> {
        let client = gmailByMailbox.get(mailbox);
        if (!client) {
          client = googleClients(principal).gmail(mailbox);
          gmailByMailbox.set(mailbox, client);
        }
        return client;
      }

      // Same one-resolution-per-tick discipline as gmailFor above — the calendar is not
      // mailbox-specific, so one client covers every message in the tick regardless of which
      // mailbox it arrived on.
      let calendarClientPromise: Promise<CalendarClient> | undefined;
      function calendarClient(): Promise<CalendarClient> {
        if (!calendarClientPromise) calendarClientPromise = googleClients(principal).calendar();
        return calendarClientPromise;
      }

      // ORB-147 Task 4: the dossier for the message's counterpart, scoped to the mailbox the
      // message ARRIVED on. `eveSagaPersonWiring()`'s own mailSearch/mailRead resolve
      // `googleClients().gmail()` with NO account — the env-pinned primary mailbox — which
      // would read the WRONG inbox for a message on the other enrolled mailbox (a false "you
      // owe a reply" line in the dossier) and would re-decrypt a fresh refresh token from the
      // DB instead of reusing gmailFor's per-tick cache. `listEvents` gets the same caching
      // treatment via `calendarClient()`, for the same re-decrypt-per-call reason — the account
      // it resolves to is unchanged (still `CALENDAR_PRIMARY_EMAIL`/most-recent, same as the
      // default), only the resolution is now shared with `freeBusy` below instead of repeated
      // per drafted message. `gatherPerson` does no LLM call — it is pure I/O fan-out — so this
      // adds no billed call. Construction alone does no I/O (see person-sources.ts's header),
      // so this is safe to build fresh per message.
      function dossierFor(mailbox: string): (email: string) => Promise<string | null> {
        const sources = makePersonSources({
          ...eveSagaPersonWiring(),
          mailSearch: async (q, max) => (await gmailFor(mailbox)).search(q, max),
          mailRead: async (id) => (await gmailFor(mailbox)).read(id),
          listEvents: async (o) => (await calendarClient()).listEvents(o),
        });
        return draftDossierLookup(sources);
      }

      const deps: EmailTriageDeps = {
        mailboxes: () => listEnrolledMailboxes(principal),
        searchCandidates: async (mailbox) => (await gmailFor(mailbox)).search(query, SCAN_CEILING),
        readMessage: async (mailbox, id) => (await gmailFor(mailbox)).read(id),
        readThread: async (mailbox, threadId) => (await gmailFor(mailbox)).readThread(threadId),
        claim: (mailbox, id) => claimMessage(pool, mailbox, id),
        recordDraft: (mailbox, id, draft) => recordDraft(pool, mailbox, id, draft),
        triage: async (mailbox, msg, thread) => {
          const gmail = await gmailFor(mailbox);
          // Examples come from the ARRIVING mailbox's own sent mail — the same mailbox the
          // draft lands in. Grounding a project.example reply in owner.example examples would be a
          // different voice (sql/026_voice_per_mailbox.sql).
          const voice = makeDbVoiceAccess({ db: pool, mailbox });
          // The member's own addresses, so a reply-to-everyone never includes him: the identity
          // registry's email aliases plus the arriving mailbox (per install, never a literal).
          const selfEmails = [...(await listAliases(pool, configuredOwnerId(), "email")), mailbox];
          return triageOneMessage(
            {
              gmail,
              voice,
              selfEmails,
              // Both are best-effort at the lib layer already (tryOrNull around every call in
              // lib/email-triage.ts) — a dossier or calendar failure surfaces as an absent
              // context block, never a failed draft or a failed tick.
              dossier: dossierFor(mailbox),
              freeBusy: async (o) => (await calendarClient()).freeBusy(o),
              calendarLabel,
              // eve injects no ambient clock — every computed date is a guess without one.
              now: () => new Date(),
            },
            mailbox,
            msg,
            thread,
          );
        },
        recordOutcome: (mailbox, id, outcome) => recordOutcome(pool, mailbox, id, outcome),
        gate: initiateTo("email-triage", doorId("slack", channelId)),
        notify: async (text) => {
          const res = await callSlackApi({
            botToken: slackCredentials.botToken,
            operation: "chat.postMessage",
            body: { channel: channelId, text },
          });
          if (!res.ok) throw new Error(`email-triage: slack notify failed: ${String((res as { error?: unknown }).error)}`);
        },
        reportDropped: (mailbox, id, err) => emitSignal(
          "email-triage-message-dropped",
          `email-triage: gave up on ${mailbox}:${id} after ${MAX_ATTEMPTS} attempts`,
          String(err),
        ),
        prune: () => pruneOldRecords(pool),
      };

      const completed = await makeEmailTriageTick(deps, liveState).tick();
      if (completed) await recordSchedulePass(pool, HEARTBEAT_KEY);
    } catch (err) {
      console.error("email-triage: live wiring failed", err);
      await emitSignal("schedule-tick-failed", "email-triage: tick failed", String(err));
    }
  },
});
