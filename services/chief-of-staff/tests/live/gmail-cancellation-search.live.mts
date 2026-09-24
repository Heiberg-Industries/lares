/**
 * tests/live/gmail-cancellation-search.live.mts — the LIVE sweep for the Gmail-search
 * assumptions `lib/conflict-resolution.ts`'s `buildCancellationQuery` bets on (LAR-59-s3):
 *
 *   1. a QUOTED phrase (`"<vendor>"`) matches that phrase, not its words separately;
 *   2. `OR` inside parentheses works as a disjunction over the cancellation words;
 *   3. `after:`/`before:` take `YYYY/MM/DD` and match the message's own date.
 *
 * Per the root CLAUDE.md's rule — "a fixture is what we believe an API does; only a live call
 * is what it does" — `tests/conflict-resolution.test.ts` runs entirely against a fake mailbox.
 * This file is what actually asks Gmail, with the SAME query builder `resolveConflicts` calls
 * (imported, never re-typed), for a real vendor and a real check-in day, and reports whether
 * the response has the shape that builder — and `matchCancellation` downstream of it — assumes.
 *
 * A wrong belief here is not cosmetic: `resolveConflicts` decides whether to propose deleting a
 * live calendar booking from what this query returns.
 *
 * NOT part of `pnpm test` — it needs a live Gmail OAuth session, which only exists inside the
 * deployed eve-saga container, exactly as `tests/live/calendar-conflicts.live.mts`'s header
 * describes (the read-only rootfs and the `/proc/1/environ` env read are the same two traps).
 * Run it there, by hand, with a vendor name and a check-in day you already know a cancellation
 * mail exists for:
 *
 *   cat services/chief-of-staff/tests/live/gmail-cancellation-search.live.mts | \
 *     ssh root@<box> 'docker exec -i <chief-of-staff container> sh -c \
 *       "cat > /app/services/chief-of-staff/node_modules/.cache/gmail-cancellation-search.live.mts"'
 *   ssh root@<box> 'docker exec <chief-of-staff container> sh -c \
 *     "cd /app/services/chief-of-staff && \
 *      export \$(tr \"\\0\" \"\\n\" < /proc/1/environ | grep -E \"^(DATABASE_URL|PGPASSWORD|TOKEN_ENC_KEY_FILE|GOOGLE_|GMAIL_PRIMARY_EMAIL|CALENDAR_PRIMARY_EMAIL|EGRESS_PROXY_URL)\" | xargs) && \
 *      /app/node_modules/.bin/tsx node_modules/.cache/gmail-cancellation-search.live.mts \"<vendor>\" <YYYY-MM-DD check-in day>"'
 *   ssh root@<box> 'docker exec <chief-of-staff container> rm -f /app/services/chief-of-staff/node_modules/.cache/gmail-cancellation-search.live.mts'
 *
 * Optional: set `PROBE_ACCOUNT=<mailbox>` (in the exported env line above) to search a
 * non-default enrolled mailbox, same convention as `resolveConflicts` itself.
 *
 * COUNTS AND SHAPE ONLY: this file prints how many message ids the query returned, and per
 * message — capped the same way `resolveConflicts` caps reads
 * ({@link MAX_MESSAGES_PER_EVENT}) — ONLY the sender's DOMAIN (never the full address), the
 * sent date, and the subject (never a body). It exits non-zero the moment a returned message is
 * missing a field this code assumes exists (`from`, `subject`, `sentAt`), so a Gmail API shape
 * drift shows up as a failing exit code, not a silently empty read.
 */
import { googleClients } from "../../lib/google.js";
import { buildCancellationQuery, MAX_MESSAGES_PER_EVENT } from "../../lib/conflict-resolution.js";

let failed = false;

function report(ok: boolean, label: string): void {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}`);
  if (!ok) failed = true;
}

function blocked(label: string): void {
  console.log(`  [BLOCKED] ${label}`);
  failed = true;
}

/** The sender's domain only — never the local part, never the full address. */
function domainOf(from: string): string {
  const m = /@([^\s>]+)/u.exec(from);
  return m ? m[1]! : "(no domain found in from)";
}

async function main(): Promise<void> {
  const [vendor, checkInDay] = process.argv.slice(2);
  if (!vendor || vendor.trim() === "") {
    blocked('usage: tsx gmail-cancellation-search.live.mts "<vendor>" <YYYY-MM-DD check-in day>');
    return;
  }
  if (!checkInDay || !/^\d{4}-\d{2}-\d{2}$/u.test(checkInDay)) {
    blocked(`check-in day must be YYYY-MM-DD, got: ${checkInDay ?? "(none given)"}`);
    return;
  }

  const account = process.env["PROBE_ACCOUNT"]; // undefined = the default mailbox, same as resolveConflicts
  const query = buildCancellationQuery(vendor, checkInDay);
  console.log(`query: ${query}`);
  console.log(`account: ${account ?? "(default)"}`);

  let gmail: Awaited<ReturnType<ReturnType<typeof googleClients>["gmail"]>>;
  try {
    gmail = await googleClients().gmail(account);
  } catch (err) {
    blocked(`could not resolve a Gmail client: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let ids: string[];
  try {
    ids = await gmail.search(query, MAX_MESSAGES_PER_EVENT);
  } catch (err) {
    blocked(`search failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  console.log(`ids returned: ${ids.length} (capped to ${MAX_MESSAGES_PER_EVENT} reads below, as resolveConflicts caps them)`);

  const capped = ids.slice(0, MAX_MESSAGES_PER_EVENT);
  for (const id of capped) {
    let mail: Awaited<ReturnType<typeof gmail.read>>;
    try {
      mail = await gmail.read(id);
    } catch (err) {
      report(false, `read(${id}) threw: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (mail === null) {
      report(false, `read(${id}) returned null — a search result that cannot be read is a shape this code does not expect`);
      continue;
    }
    const hasShape =
      typeof mail.from === "string" && mail.from.trim() !== "" &&
      typeof mail.subject === "string" &&
      typeof mail.sentAt === "string" && !Number.isNaN(Date.parse(mail.sentAt));
    if (!hasShape) {
      report(false, `message is missing from/subject/sentAt in the shape this code assumes (id ${id})`);
      continue;
    }
    console.log(`  [ok] ${domainOf(mail.from)} — ${mail.sentAt} — "${mail.subject.slice(0, 80)}"`);
  }

  if (ids.length === 0) {
    console.log("  (no messages matched — this is a valid result, not a failure; re-run with a vendor/date you know has a cancellation mail to exercise the shape checks above)");
  }

  console.log(failed ? "RESULT: at least one assumption did not hold — read the lines above" : "RESULT: query ran and every message read had the expected shape");
}

await main();
if (failed) process.exitCode = 1;
