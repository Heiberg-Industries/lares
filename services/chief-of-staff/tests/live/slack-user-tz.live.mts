/**
 * tests/live/slack-user-tz.live.mts — the LIVE sweep for the ONE Slack field the owner clock
 * believes: `users.info` → `user.tz` (ORB-193).
 *
 * Per the root CLAUDE.md's third-party rule — "a fixture is what we believe an API does; only a live
 * call is what it does." `tests/owner-clock.test.ts` proves the plumbing with a fake reader; it
 * cannot tell us whether Slack actually returns an IANA zone id for this account, whether it is ever
 * absent, or whether `tz_label`/`tz_offset` disagree with it. Both directions matter here:
 *
 *   - the LEAK — a value that is not an IANA id (a legacy zone name, an empty string) would reach
 *     `owner_clock_signals` and, without the kit's `isValidTimeZone` guard, throw inside every slot
 *     computation in the service at once;
 *   - the OVER-REJECTION — a perfectly good zone the guard refuses, which silently pins the clock
 *     to home for a whole trip and looks exactly like "no signal yet".
 *
 * So this prints the raw value, whether `Intl` accepts it, and what the profile's own label and
 * offset say beside it. NOT part of `pnpm test`: it needs the live Slack user token, which exists
 * only inside the deployed container. Run it there, by hand, whenever
 * `lib/slack-source.ts`'s `fetchSlackUserTimezone` or the owner clock's Slack source changes:
 *
 *   cat services/chief-of-staff/tests/live/slack-user-tz.live.mts | \
 *     ssh root@192.0.2.20 'docker exec -i agent-box-eve-saga-1 sh -c \
 *       "cat > /app/services/chief-of-staff/node_modules/.cache/slack-user-tz.live.mts"'
 *   ssh root@192.0.2.20 'docker exec agent-box-eve-saga-1 sh -c \
 *     "cd /app/services/chief-of-staff && \
 *      export \$(tr \"\\0\" \"\\n\" < /proc/1/environ | grep -E \"^(DATABASE_URL|PGPASSWORD|TOKEN_ENC_KEY_FILE|SLACK_|EGRESS_PROXY_URL|OWNER_HOME_TZ|TRAVEL_PATH)\" | xargs) && \
 *      /app/node_modules/.bin/tsx node_modules/.cache/slack-user-tz.live.mts"'
 *   ssh root@192.0.2.20 'docker exec agent-box-eve-saga-1 rm -f /app/services/chief-of-staff/node_modules/.cache/slack-user-tz.live.mts'
 *
 * Read-only against Slack (`users.info` only) and against the database (it prints the current signal
 * row, and writes nothing — the 30-minute schedule is what writes). It prints the timezone, the
 * label and the offset, and no other profile field: a name or an email is not what is being asked.
 */
import { allowedSlackUserIds } from "../../lib/principals.js";
import { fetchSlackUserTimezone, resolveSlackToken } from "../../lib/slack-source.js";
import { getPool } from "@lares/agent-kit/db";
import { isValidTimeZone, readSlackProfileSignal, resolveOwnerClock } from "@lares/agent-kit/owner-clock";
import { homeTimezone } from "../../lib/owner-clock.js";
import { ownerId } from "../../lib/principals.js";

const userId = allowedSlackUserIds()[0];
if (!userId) throw new Error("no SLACK_ALLOWED_USER_IDS in this environment");

const token = await resolveSlackToken();

// The raw call as well as the wrapper: the wrapper NORMALISES (trim, "" → null), and the point of a
// live sweep is to see what arrived before anything normalised it.
const res = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const raw = (await res.json()) as {
  ok: boolean;
  error?: string;
  user?: { tz?: unknown; tz_label?: unknown; tz_offset?: unknown; deleted?: boolean };
};

console.log("users.info ok:", raw.ok, raw.error ? `error=${raw.error}` : "");
console.log("tz        :", JSON.stringify(raw.user?.tz), `(typeof ${typeof raw.user?.tz})`);
console.log("tz_label  :", JSON.stringify(raw.user?.tz_label));
console.log("tz_offset :", JSON.stringify(raw.user?.tz_offset));
console.log("deleted   :", raw.user?.deleted ?? false);

const tz = typeof raw.user?.tz === "string" ? raw.user.tz : undefined;
console.log("Intl accepts tz:", tz === undefined ? "n/a — no tz field" : isValidTimeZone(tz));
if (tz !== undefined && isValidTimeZone(tz)) {
  console.log("wall clock there:", new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(new Date()));
}

console.log("through the wrapper:", JSON.stringify(await fetchSlackUserTimezone(userId, { token })));

const pool = getPool();
const owner = ownerId();
console.log("stored signal:", JSON.stringify(await readSlackProfileSignal(pool, owner)));
console.log("resolved clock:", JSON.stringify(await resolveOwnerClock({
  now: new Date(),
  ...(process.env["TRAVEL_PATH"] ? { tripsDir: process.env["TRAVEL_PATH"] } : {}),
  db: pool,
  owner,
  homeTz: homeTimezone(),
})));

await pool.end();
