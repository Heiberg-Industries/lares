/**
 * tests/live/gmail-list-headers.live.mts - the LIVE check for the mailing-list gate in
 * `lib/email-triage.ts` (`msg.isBulk`, set by `isBulkMail` in `lib/google.ts`).
 *
 * The gate bets that real newsletters and mailing-list mail carry `List-Unsubscribe`, `List-Id`,
 * `List-Post` or `Precedence: bulk|list|junk`, and that real human mail carries none of them.
 * Fixtures only say what we believe; this reads real mail and prints what Gmail actually returns.
 *
 * READ-ONLY: lists and reads inbox messages, never sends, drafts, labels or modifies anything.
 *
 * NOT part of `pnpm test` - it needs a live Gmail OAuth session, which only exists inside the
 * deployed chief-of-staff container. Run it there, by hand, the same way the other
 * `tests/live/*.live.mts` probes are run (see gmail-cancellation-search.live.mts for the
 * copy-in-and-run recipe under `tsx`), with:
 *
 *   PROBE_ACCOUNT=<mailbox>   optional; default is the default enrolled mailbox
 *   tsx gmail-list-headers.live.mts [N]      N = newest inbox messages to read (default 30, max 100)
 *
 * Check by eye: a Substack, a LinkedIn and a "newsletter from a person" mail should read
 * isBulkMail=true; three real human mails should read false.
 *
 * PRIVACY: prints sender, subject and header NAMES only (never header values or bodies). The
 * output is for the owner's eyes on their own mailbox; do not paste it anywhere public.
 */
import { googleClients, isBulkMail } from "../../lib/google.js";

const LIST_HEADERS = ["list-unsubscribe", "list-id", "list-post", "precedence"] as const;

async function main(): Promise<void> {
  const n = Math.min(100, Math.max(1, Number.parseInt(process.argv[2] ?? "30", 10) || 30));
  const account = process.env["PROBE_ACCOUNT"];
  console.log(`account: ${account ?? "(default)"}  newest inbox messages: ${n}`);

  const gmail = await googleClients().gmail(account);
  const ids = await gmail.search("in:inbox", n);
  console.log(`ids returned: ${ids.length}`);

  let bulk = 0;
  for (const id of ids) {
    const thread = await gmail.read(id);
    if (thread === null) {
      console.log(`  [FAIL] read(${id}) returned null`);
      process.exitCode = 1;
      continue;
    }
    // `read` returns a MailMessage (no raw headers); readThread carries them per message.
    const full = (await gmail.readThread(thread.threadId)).find((m) => m.id === id);
    const present = LIST_HEADERS.filter((name) =>
      Object.keys(full?.headers ?? {}).some((k) => k.toLowerCase() === name));
    const verdict = isBulkMail(Object.entries(full?.headers ?? {}).map(([name, value]) => ({ name, value })));
    if (verdict) bulk++;
    if (verdict !== thread.isBulk) {
      console.log(`  [FAIL] ${id}: GmailClient.read says isBulk=${thread.isBulk} but headers say ${verdict}`);
      process.exitCode = 1;
    }
    console.log(`  isBulkMail=${verdict}  headers=[${present.join(", ") || "none"}]  from=${thread.from}  subject=${thread.subject}`);
  }
  console.log(`done: ${bulk} of ${ids.length} read as bulk`);
}

main().catch((err) => {
  console.log(`  [BLOCKED] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
