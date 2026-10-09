/**
 * The clipping request drain — every minute, answers what the console's Clipping card asked for
 * (LAR-113 child b): read a pasted Notion database, test the saved columns, import now, add the
 * Status / For / Origin columns.
 *
 * WHY A SCHEDULE OF ITS OWN. The console cannot reach Notion (only the chief of staff holds the
 * key), and the digest runs twice a day. A button press writes a row to `clipping_requests`
 * (box/sql/092) and this tick answers it within a minute. The `digest_requests` pattern, minus
 * Slack: the answer goes back into the row and the card shows it.
 *
 * GATES. This definition's own `schedules.clipping-requests.on` (silence means on) and the
 * service-wide `EVE_SCHEDULES_LIVE`. NOT `EVE_DIGEST_LIVE`: that one exists only to stop the old
 * digest container racing the new one for `digest_requests`; nothing here shares a table with it.
 *
 * "Import now" runs the same `clippingPass` the digest runs, behind the same in-process lock
 * (lib/clipping/step.ts), so the two never overlap. No model call anywhere in here.
 *
 * A box that has not applied migration 092 yet has no queue: this logs that once and returns,
 * stamping nothing (the freshness alarm then says what is true: the drain is not running).
 */
import { defineSchedule } from "eve/schedules";

import { getPool } from "@lares/agent-kit/db";
import { scheduleGate } from "@lares/agent-kit/schedule-gate";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { recordSchedulePass } from "@lares/agent-kit/schedule-heartbeat";
import { storeRoot } from "@lares/agent-kit/notes-store";
import { thisAgent } from "../../lib/definition.js";
import { makeNotionClient, readNotionToken } from "../../lib/clipping/notion-reader.js";
import { drainRequests } from "../../lib/clipping/requests.js";
import { makeVaultInbox } from "../../lib/clipping/step.js";

/** The row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/clipping-requests";

let running = false;
let warnedMissingTable = false;

export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "clipping-requests")) return;
    if (!scheduleGate()) return;
    if (running) return;
    running = true;
    try {
      const db = getPool();
      const log = (m: string) => console.log(`clipping-requests: ${m}`);
      const handled = await drainRequests({
        db,
        inbox: makeVaultInbox(storeRoot("brain")),
        token: () => readNotionToken(),
        makeClient: (token) => makeNotionClient({ token, proxyUrl: process.env["EGRESS_PROXY_URL"] }),
        log,
      });
      if (handled > 0) log(`answered ${handled} request(s)`);
      // A quiet pass is a completed pass: "ran and found nothing" must differ from "never ran".
      await recordSchedulePass(db, HEARTBEAT_KEY);
    } catch (e) {
      if ((e as { code?: string })?.code === "42P01" && /clipping_requests/.test(String((e as Error).message))) {
        if (!warnedMissingTable) {
          warnedMissingTable = true;
          console.log("clipping-requests: the request table is not there yet (apply box migration 092); skipped");
        }
        return;
      }
      console.error("clipping-requests: pass failed", e);
    } finally {
      running = false;
    }
  },
});
