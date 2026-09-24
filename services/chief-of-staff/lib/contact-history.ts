/**
 * ORB-278 step 1, Task 3b (fix round 1, 2026-09-15) — who counts as "been in touch with the
 * owner before". This is the `ContactHistory` the engine's `board-approval.ts` calls, per
 * recipient, ONLY when a history-checked contact tool (`RECIPIENTS_OF`,
 * `@lares/agent-kit/always-ask`) is set to `autonomous` on the permissions board — see that
 * module's header for the decided contract.
 *
 * Owner rulings from the fix-round-1 review (task-3b-fix1-findings.md) REPLACE the original
 * brief's decision 3:
 *   - D-A: the CRM (Twenty) does not count, at all. Twenty's own contact history is BUILT from
 *     the same mail this file already checks — counting it too would let the agent mark a
 *     prospect "emailed" via a CRM write and then mail them for real without ever asking. (The
 *     earlier version of this file had a Twenty leg and `tests/live/contact-history-twenty.live.mts`;
 *     both are removed.)
 *   - D-B: "been in touch" means the OWNER wrote to THEM first, not the other way round. Inbound
 *     mail no longer counts — a stranger, or a prompt-injection email dressed as a reply, must
 *     never become "known" just by writing in. Known = (network) an OUTBOUND interaction to an
 *     identity carrying that email, or (mail) a message the owner SENT to that address — in To,
 *     Cc, or Bcc — from the sending account.
 * D-C (`calendar_create_event`'s `notify:false` no longer means "contacts nobody") lives entirely
 * in `@lares/agent-kit/always-ask`'s `RECIPIENTS_OF` — nothing in this file changes for it.
 *
 * Checked in that order — network first (a local sqlite read, cheap), then mail (one Gmail
 * search plus a bounded number of header reads) — known as soon as ONE source says yes, so the
 * more expensive source is never consulted once the cheaper one already answered.
 *
 * A source that THROWS is logged — the source name and the error's CLASS only, never its own
 * message and never the recipient address (fix-round-1 review, I4: a client error can embed
 * the request it was making, which can embed the address) — and the next source is tried. If no
 * source says yes and at least one threw, the whole call THROWS, so `board-approval.ts` records
 * "contact history could not be read" rather than the false negative "never in touch"; if every
 * source answered cleanly with no evidence, this returns `false`.
 *
 * Not wired into any tool by this task: `lib/board.ts` binds it in Task 5.
 */
import type { ContactHistory } from "@lares/agent-kit/board-approval";

import { googleClients } from "./google.js";
import { networkHasOutboundInteraction } from "./network-client.js";

/**
 * The address inside "Name <addr>", lowercased — or the whole trimmed+lowercased string when
 * there are no angle brackets.
 *
 * Deliberately the LAST `<…>` pair ENDING the (trimmed) entry, not the first `<…>` found
 * anywhere — fix-round-2 review, item 1: the fix-round-1 shape of this function took the FIRST
 * match, so a crafted entry like `"<victim@target.example>" <stranger@evil.example>` (a fake
 * address inside a quoted display name, the REAL recipient trailing it) misread as
 * `victim@target.example` — one reply from a complete stranger, using that display name, would
 * make an unrelated victim's address count as "known". Any entry whose display-name PORTION
 * itself contains `<`, `>` or `@` is either crafted or malformed either way, so it now counts as
 * NO match (`""`, which can never equal a real recipient) rather than guessing which `<…>` is
 * the genuine one. One exception (final review F10): a display name that, unquoted and
 * lowercased, IS the bracketed address exactly (`"a@x.com" <a@x.com>`, common) names the same
 * recipient, so it counts — anything else in the display name still counts as no match.
 *
 * EXPORTED (was private) so `tests/live/contact-history-gmail.live.mts` imports this SAME
 * function instead of keeping its own copy — a second, silently-diverging copy of exactly this
 * logic is how this bug reached the verification side in the first place: fix round 1 fixed
 * `always-ask.ts`'s address PARSING (C1) but this file's separate address-header VERIFICATION
 * helper still had the old, unfixed shape.
 */
export function addressOf(header: string): string {
  const s = header.trim();
  if (!s.endsWith(">")) return s.toLowerCase();
  const lt = s.lastIndexOf("<");
  if (lt === -1) return s.toLowerCase();
  const displayName = s.slice(0, lt);
  const addr = s.slice(lt + 1, -1).trim().toLowerCase();
  if (/[<>@]/.test(displayName)) {
    const unquoted = displayName.trim().replace(/^"(.*)"$/, "$1").toLowerCase();
    return unquoted === addr ? addr : "";
  }
  return addr;
}

/** Bounded — this only needs to find ONE sent message addressed to the recipient, not
 *  enumerate every message the owner ever sent them; a wide fan-out here is cost with no
 *  benefit, and every candidate costs one extra `read()` round trip (see below). */
const MAIL_CANDIDATE_LIMIT = 10;

/**
 * Mail leg (D-B): SENT mail only (`in:sent`), matching the address in To, Cc, or Bcc.
 * `toolInput.account` names the sending account when the call carries one, else the primary
 * mailbox (the same default `googleClients().gmail()` uses everywhere else).
 *
 * Gmail's own address search is NOT trusted to be exact — fix-round-1 review, C2: a known
 * `jim.bob@example.com` can satisfy a search for `bob@example.com`, and the search also has no
 * way to promise it matched the field it looks like it matched. Every candidate message the
 * search returns is READ and its own To/Cc/Bcc headers are parsed and compared to the EXACT
 * recipient address — `lib/google.ts`'s `read()` already does this parsing (`parseAddressHeader`)
 * for `to`/`cc`, and now `bcc` too. `in:sent` already excludes drafts (a draft carries the DRAFT
 * label, never SENT); the client's `read()` does not expose per-message labels to double-check
 * that here, so this relies on that Gmail invariant rather than re-verifying it.
 */
async function contactedByMail(email: string, account: string | undefined): Promise<boolean> {
  const gmail = await googleClients().gmail(account);
  const ids = await gmail.search(`in:sent (to:${email} OR cc:${email} OR bcc:${email})`, MAIL_CANDIDATE_LIMIT);
  for (const id of ids) {
    const msg = await gmail.read(id);
    if (!msg) continue;
    const addressed = [...msg.to, ...msg.cc, ...(msg.bcc ?? [])].map(addressOf);
    if (addressed.includes(email)) return true;
  }
  return false;
}

function sendingAccountOf(toolInput: unknown): string | undefined {
  const account = (toolInput as { account?: unknown } | null)?.account;
  return typeof account === "string" ? account : undefined;
}

/** The engine's `ContactHistory` (`@lares/agent-kit/board-approval`) — typed directly against
 *  the engine's own contract (fix-round-1 review, I9) so any drift between the two shapes fails
 *  typecheck here, not silently at runtime. */
export const isKnownRecipient: ContactHistory = async (recipient, toolInput) => {
  const email = recipient.trim().toLowerCase();
  const account = sendingAccountOf(toolInput);

  const sources: ReadonlyArray<{ name: string; check: () => Promise<boolean> }> = [
    { name: "network", check: async () => networkHasOutboundInteraction(email) },
    { name: "mail", check: () => contactedByMail(email, account) },
  ];

  let anySourceThrew = false;
  for (const source of sources) {
    try {
      if (await source.check()) return true;
    } catch (err) {
      anySourceThrew = true;
      const errorClass = err instanceof Error ? err.name : "Error";
      console.error(`[contact-history] ${source.name} unavailable: ${errorClass}`);
    }
  }
  if (anySourceThrew) {
    throw new Error("contact history could not be fully checked — at least one source was unavailable");
  }
  return false;
};
