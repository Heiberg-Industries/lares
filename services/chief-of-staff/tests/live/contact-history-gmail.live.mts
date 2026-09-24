/**
 * tests/live/contact-history-gmail.live.mts — the LIVE sweep for the Gmail-search assumptions
 * behind `lib/contact-history.ts`'s mail leg (`contactedByMail`), which decides whether a
 * recipient counts as "known" for the ORB-278 step 1 first-contact-history check.
 *
 * Rewritten for fix round 1 (task-3b-fix1-findings.md, C2/D-B/I6) — the mail leg now means
 * "the OWNER wrote to them" (D-B), never the reverse, and it now VERIFIES the candidate
 * messages' own headers rather than trusting Gmail's search tokenisation (C2). `contactedByMail`
 * runs:
 *
 *     in:sent (to:<addr> OR cc:<addr> OR bcc:<addr>)
 *
 * then reads each candidate message and checks its OWN To/Cc/Bcc headers contain the exact
 * address. This file checks both directions that matter for that design:
 *
 *   MUST match — an address the owner SENT to, in To; one only ever Cc'd; one only ever Bcc'd.
 *   MUST NOT match — an address that only ever wrote TO the owner (inbound only — this is
 *     exactly the D-B case: inbound mail must never count); an address that appears only in a
 *     DRAFT, never an actually-sent message; a near-miss address (same local part at a
 *     different domain, or the known address with one local-part character removed — proving
 *     the header-verification step, not just the search, is doing real work); and a random
 *     `.invalid` address nobody has ever used.
 *
 * NOT part of `pnpm test` — it needs a live Gmail OAuth session, which only exists inside the
 * deployed eve-saga container. Run it there, by hand, whenever `contactedByMail`'s query or
 * verification logic changes: copy this file inside the saga container on the box (the engine
 * repo names no servers — see this project's deploy docs for how the box is reached and how a
 * one-off script gets copied in and run under `tsx`, the same mechanism every other
 * `tests/live/*.live.mts` probe uses), set the env vars below, and run it with the service's
 * own `node_modules` on the path so `googleapis`/`@lares/agent-kit` resolve:
 *
 *      PROBE_ACCOUNT=<sending-mailbox> \
 *      PROBE_SENT_TO=<address the owner has sent mail To> \
 *      PROBE_SENT_CC_ONLY=<address only ever Cc'd on a sent message, never To/Bcc> \
 *      PROBE_SENT_BCC_ONLY=<address only ever Bcc'd on a sent message, never To/Cc> \
 *      PROBE_INBOUND_ONLY=<address that has written TO the owner, but the owner has never sent to> \
 *      PROBE_DRAFT_ONLY=<address that appears only in an unsent draft> \
 *      PROBE_NEAR_MISS=<a known local part at a DIFFERENT domain, OR a known address with one local-part character removed> \
 *      tsx contact-history-gmail.live.mts
 *
 * COUNTS ONLY, never an address or message content: this file never prints a subject, a body,
 * or any of the PROBE_* env values themselves — only which env var was set, how many message
 * ids a search returned, and whether the header check found a match. A failure line names the
 * ENV VAR that failed, never the address it held.
 */
import { googleClients } from "../../lib/google.js";
import { addressOf } from "../../lib/contact-history.js";

let failed = false;

function report(ok: boolean, label: string): void {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}`);
  if (!ok) failed = true;
}

function blocked(label: string): void {
  console.log(`  [BLOCKED] ${label}`);
  failed = true;
}

/** VERBATIM copy of lib/contact-history.ts's contactedByMail query + loop shape (imports the
 *  real `addressOf` above rather than keeping its own copy — fix-round-2 review, item 1: a
 *  second, diverging copy of that exact function is how its bug reached this probe in the
 *  first place). Returns whether a SENT message's own To/Cc/Bcc headers contain `email`
 *  exactly — not just whether the search matched something. */
async function contactedByMail(account: string, email: string): Promise<{ ok: boolean; searched: number } | null> {
  let gmail: Awaited<ReturnType<ReturnType<typeof googleClients>["gmail"]>>;
  try {
    gmail = await googleClients().gmail(account);
  } catch (err) {
    blocked(`could not resolve a Gmail client: ${(err as Error).name}`);
    return null;
  }
  let ids: string[];
  try {
    ids = await gmail.search(`in:sent (to:${email} OR cc:${email} OR bcc:${email})`, 10);
  } catch (err) {
    blocked(`search failed: ${(err as Error).name}`);
    return null;
  }
  const lower = email.toLowerCase();
  for (const id of ids) {
    const msg = await gmail.read(id);
    if (!msg) continue;
    const addressed = [...msg.to, ...msg.cc, ...(msg.bcc ?? [])].map(addressOf);
    if (addressed.includes(lower)) return { ok: true, searched: ids.length };
  }
  return { ok: false, searched: ids.length };
}

async function checkMustMatch(label: string, account: string, envVar: string): Promise<void> {
  const email = process.env[envVar];
  if (!email) {
    console.log(`  [skipped] ${label} — set ${envVar} to run this check`);
    return;
  }
  const result = await contactedByMail(account, email);
  if (result === null) return;
  report(result.ok, `${label} (${envVar}): header-verified match (searched ${result.searched} candidate id(s))`);
}

async function checkMustNotMatch(label: string, account: string, envVar: string): Promise<void> {
  const email = process.env[envVar];
  if (!email) {
    console.log(`  [skipped] ${label} — set ${envVar} to run this check`);
    return;
  }
  const result = await contactedByMail(account, email);
  if (result === null) return;
  report(!result.ok, `${label} (${envVar}): correctly did NOT match (searched ${result.searched} candidate id(s))`);
}

const account = process.env["PROBE_ACCOUNT"];
if (!account) {
  blocked("PROBE_ACCOUNT not set — this is the sending mailbox contactedByMail would search");
} else {
  console.log(`account env: PROBE_ACCOUNT (value not printed)`);

  console.log("\n=== MUST match: owner sent To this address ===");
  await checkMustMatch("sent-to", account, "PROBE_SENT_TO");

  console.log("\n=== MUST match: owner sent, this address only ever Cc'd ===");
  await checkMustMatch("sent-cc-only", account, "PROBE_SENT_CC_ONLY");

  console.log("\n=== MUST match: owner sent, this address only ever Bcc'd ===");
  await checkMustMatch("sent-bcc-only", account, "PROBE_SENT_BCC_ONLY");

  console.log("\n=== MUST NOT match: inbound-only address (D-B — inbound mail never counts) ===");
  await checkMustNotMatch("inbound-only", account, "PROBE_INBOUND_ONLY");

  console.log("\n=== MUST NOT match: address only present in a draft, never sent ===");
  await checkMustNotMatch("draft-only", account, "PROBE_DRAFT_ONLY");

  console.log("\n=== MUST NOT match: near-miss address (proves header verification, not just search) ===");
  await checkMustNotMatch("near-miss", account, "PROBE_NEAR_MISS");

  console.log("\n=== MUST NOT match: a random address nobody has ever used ===");
  const neverSeen = `orb278-contact-history-probe-${Date.now()}@does-not-exist.invalid`;
  const result = await contactedByMail(account, neverSeen);
  if (result !== null) report(!result.ok, `made-up .invalid address does not match (searched ${result.searched} candidate id(s))`);
}

console.log(`\n=== ${failed ? "FAIL" : "PASS"} ===`);
process.exit(failed ? 1 : 0);
