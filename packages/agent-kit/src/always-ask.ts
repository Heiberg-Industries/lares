// Always-ask by engine policy (agent-definitions spec, decisions + Part 3; Bendik 2026-09-15): moving
// money, deleting data, first contact with someone the owner has never been in touch with, publishing.
// No agent.json level and no board setting loosens these. Every engine tool has a line — `[]` when none
// applies — and tests/always-ask.test.ts fails when a tool is added without one.
//
// WHAT COUNTS (the rule a new line is judged by):
//   money    — pays, transfers, buys, commits spend. (None today; accounting lands here.)
//   delete   — removes a record the owner could not simply recreate: a calendar event, a reminder, a
//              stored fact, a vault note. NOT: marking something done or dismissed (reversible), removing an item
//              from a trip shopping list.
//   contact  — sends something to a person (mail, an invitation, a message) — unless the recipients
//              are established by construction (CONTACT_BY_CONSTRUCTION), in which case the board decides.
//              A history-checked contact tool (RECIPIENTS_OF, below) may ALSO skip the ask, but only
//              when the board says autonomous AND every recipient is already "known" — Bendik's
//              rulings from the fix-round-1 review (2026-09-15, task-3b-fix1-findings.md), which
//              REPLACE the original brief's decision 3:
//                D-A: the CRM (Twenty) does not count, at all — its own contact history is built
//                     from the same mail this check already reads, so counting it too would let
//                     the agent mark a prospect "emailed" via a CRM write and then mail them for
//                     real without ever asking.
//                D-B: "known" means the OWNER wrote to THEM first, not the reverse — inbound mail
//                     no longer counts (a stranger, or a prompt-injection email dressed as a
//                     reply, must never become "known" just by writing in). Known = (network) an
//                     OUTBOUND interaction to an identity with that address, or (mail) a message
//                     the owner SENT to that address (To, Cc, or Bcc) from the sending account.
//                D-C: `calendar_create_event` with `notify: false` is NOT "contacts nobody" —
//                     Google guests still see the event on their own calendars regardless of
//                     `notify`. Attendees are checked whether or not `notify` is set; only an
//                     empty/absent attendee list contacts nobody.
//              One unknown recipient, an unreadable recipient list, or any lookup failure asks,
//              same as first contact always did. See lib/contact-history.ts (services/chief-of-staff)
//              for the actual "known" check this policy calls.
//   publish  — makes something public: a public post, a public channel, a website. (None today.)
// And, apart from the categories: a tool that changes an agent's OWN autonomy (SELF_AUTONOMY_TOOLS) —
// an agent never raises its own autonomy without the owner's 👍.
// 🚫 on the board still refuses any of these (board-approval.ts): no setting loosens always-ask, 🚫 only tightens it.
// Reviewed by Bendik 2026-09-15: approved as proposed, including forget as delete; the vault delete tool (agent-kit__vault_drop) added as delete on review.
// meeting_followup_auto always asks — Bendik 2026-09-15.
import {
  CAPABILITY_DOCS,
  VAULT_FACT_TOOLS,
  VAULT_PRIVATE_TOOLS,
  VAULT_SHARED_TOOLS,
} from "./persona/capability-docs.js";
import type { VaultArea } from "./skill-grants.js";

export type AlwaysAskCategory = "money" | "delete" | "contact" | "publish";

export const TOOL_CATEGORIES: Readonly<Record<string, readonly AlwaysAskCategory[]>> = {
  // atlas. `atlas_proposals`/`atlas_resolve_proposal` keep their names (owner decision C5) —
  // they are the sync job's proposal lane, not a note operation.
  atlas_proposals: [], atlas_resolve_proposal: [],
  // W5C-s3: one set of note tools, told which area to read. These three replaced `atlas_search`,
  // `atlas_read` and `atlas_list`; reads, so nothing here either. W5C-s4: `vault_write` is the
  // unprefixed shared-area write that used to be `atlas_write` — the same empty category it had.
  vault_search: [], vault_read: [], vault_list: [], vault_write: [],
  // autonomy / meeting follow-ups
  meeting_followup_auto: ["contact"],
  meeting_followup_send: ["contact"],
  // LAR-28 — sends, deletes, pays and publishes nothing; internal bookkeeping over a row
  // `meeting_followup_send` already owns the terminal truth of.
  meeting_followup_record_denial: [],
  // Resets a claim so the next tick reconsiders a page — no send of its own (gated separately,
  // via the same policy `meeting_followup_send` uses, not this table).
  meeting_followup_redraft: [],
  // the Vault (shared toolkit)
  "agent-kit__vault_write": [], "agent-kit__vault_file": [], "agent-kit__vault_drop": ["delete"],
  "agent-kit__vault_search": [], "agent-kit__vault_read": [], "agent-kit__vault_list": [], "agent-kit__vault_backlinks": [],
  // calendar — an event with attendees sends invitations
  calendar_list_events: [], calendar_free_busy: [], calendar_conflicts: [], calendar_list_calendars: [],
  calendar_create_event: ["contact"],
  calendar_update_event: ["contact"],
  calendar_delete_event: ["delete"],
  // deadlines, digest, echo, identity, markets
  deadline_list: [], deadline_add: [], deadline_done: [], deadline_dismiss: [], deadline_reset: [], deadline_mint_statutory: [],
  digest_run: [], echo_note: [], identity_my_addresses: [], "agent-kit__market_edge": [],
  // gmail
  gmail_search: [], gmail_read: [], gmail_signature: [], gmail_draft: [], gmail_draft_recipients: [],
  gmail_send: ["contact"],
  // network, notion, obligation, orakel, person, read_url
  network_person: [], network_who_at: [], network_dormant: [],
  notion_proposals: [], notion_resolve_proposal: [], obligation_dismiss: [],
  "agent-kit__orakel_search": [], "agent-kit__orakel_enrich_org": [], "agent-kit__orakel_enrich_domain": [],
  "agent-kit__signals_recent": [],
  person_lookup: [], read_url: [],
  // reminders
  remind_set: [], remind_list: [], remind_cancel: ["delete"],
  // studio, transit, twenty, outreach, voice
  studio_ideate: [], "agent-kit__transit_plan": [],
  twenty_lookup: [], twenty_get_person: [], twenty_company_for_person: [], twenty_note: [], twenty_create_opportunity: [],
  twenty_set_stage: [], twenty_do_not_contact: [], twenty_comm_state: [],
  outreach_track: [], voice_guide: [],
  // travel
  trip_status: [], flight_status: [], sveip: [], nytur: [], link_group: [], predeparture_pack: [],
  travel_read: [], travel_current: [],
  nearby_places: [], place_link: [], transit_directions: [], weather_forecast: [], strava_routes: [],
  shopping_add: [], shopping_remove: [],
  // memory, persona, currency, admin
  // memory_resolve_proposal is `[]` on purpose, exactly as atlas_resolve_proposal and
  // notion_resolve_proposal are: its gate is `approvalFor("memory_resolve_proposal")`, the
  // board's own check, not a static category. Listing it as `delete` would lock the card open
  // for a reject as well, which changes nothing at all.
  memory_proposals: [], memory_resolve_proposal: [],
  remember: [], forget: ["delete"], facts_list: [], memory_used: [],
  // save_note (W4B-s5) is ungated for the same reason `remember` is: writing its own note
  // reaches nobody outside this box, and it deliberately does not refuse a tainted turn — the
  // stamp (computed by stampFor, never the model) is the answer, not a refusal.
  save_note: [],
  persona_overlay: [], currency_convert: [], info: [], toggle_kill_switch: [],
};

/** Contact tools whose recipients are established by what the tool IS; the board decides these. */
export const CONTACT_BY_CONSTRUCTION: ReadonlySet<string> = new Set([
  // The recipients are the attendees of a meeting the owner attended — never a stranger. It
  // auto-sends per meeting series (ORB-156) through its own series-level ratchet check.
  "meeting_followup_send",
]);

/** Tools that change an agent's OWN autonomy: always ask, whatever the board says (owner decision,
 *  final review O1, 2026-09-15). `meeting_followup_auto` is what switches a meeting series to
 *  auto-send — the level `meeting_followup_send` later reads. */
export const SELF_AUTONOMY_TOOLS: ReadonlySet<string> = new Set(["meeting_followup_auto"]);
const SELF_AUTONOMY_REASON = "changing its own autonomy always asks first";

const ADDRESS_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

/** Characters that may never appear OUTSIDE the `<addr>` part of a "Name <addr>" entry — a
 *  comma or semicolon there is how one entry smuggles a SECOND address past this parser and
 *  into the header (gmail_send writes `to` entries verbatim into the To header —
 *  `lib/google.ts`'s `buildMimeEnvelope` joins them with ", " — so a permissive display name
 *  is a straight path to an unapproved recipient); `<`/`>`/`"` would let a second angle-bracket
 *  pair or a quoted section confuse the split; `@` in a display name is never legitimate here. */
const DANGEROUS_OUTSIDE_ADDR = /[,;<>@"]/;

/**
 * Parses ONE `to`/`attendees` ENTRY into a lowercase bare address, or `null` if it is not
 * EXACTLY one of: a bare address, or a display name (containing none of `, ; < > @ "`) followed
 * by exactly one `<addr>` with nothing after the closing `>`. Fix-round-1 review, C1: the
 * original version took the FIRST `<…>` match anywhere in the string, so
 * `"Alice <a@x.com>, Bob <b@evil.com>"`, `"b@evil.com, <a@x.com>"` and
 * `"<a@x.com>\r\nBcc: b@evil.com"` all silently resolved to `a@x.com` alone — each one hides a
 * second, unapproved recipient (or a raw header injection) behind a single "known" address.
 *
 * CR/LF anywhere is an immediate reject, before anything else — a real single-line header
 * value never contains one, and a crafted entry using one to inject extra header lines must
 * never reach the address parser at all.
 */
function parseSingleAddress(raw: string): string | null {
  if (/[\r\n]/.test(raw)) return null;
  const s = raw.trim();
  if (s === "") return null;

  const lt = s.indexOf("<");
  if (lt === -1) {
    const lower = s.toLowerCase();
    return ADDRESS_RE.test(lower) ? lower : null;
  }

  // Exactly one '<...>' pair, and it must be the very end of the entry — a second '<', a
  // second '>', or anything trailing the closing '>' all fail this in one check: the FIRST
  // '>' in the string must sit at the last character position.
  if (s.indexOf(">") !== s.length - 1) return null;
  if (s.indexOf("<", lt + 1) !== -1) return null;

  const displayName = s.slice(0, lt);
  const addr = s.slice(lt + 1, -1).trim().toLowerCase();
  if (DANGEROUS_OUTSIDE_ADDR.test(displayName)) return null;
  return ADDRESS_RE.test(addr) ? addr : null;
}

/** Normalises a raw recipients field (an array of bare addresses or "Name <addr>" entries)
 *  into lowercase bare addresses, deduplicated — or null when the field cannot be read
 *  plausibly: not an array, a non-string entry, or an entry `parseSingleAddress` rejects. Any
 *  one bad entry invalidates the WHOLE list — a caller that gets null asks, rather than acting
 *  on a partial read of who this goes to. Deduplicated so a caller that checks contact history
 *  per address (board-approval.ts) never queries the same recipient twice because they
 *  appeared, say, in both `to` and a second time verbatim. */
function extractAddresses(field: unknown): string[] | null {
  if (!Array.isArray(field)) return null;
  const out = new Set<string>();
  for (const entry of field) {
    if (typeof entry !== "string") return null;
    const addr = parseSingleAddress(entry);
    if (addr === null) return null;
    out.add(addr);
  }
  return [...out];
}

/** True for a plain, non-array object — eve hands tools like `RECIPIENTS_OF` a `toolInput` that
 *  may be genuinely absent (e.g. `boardApproval(...)()` called with no ctx at all, which eve
 *  does for a non-object call input). Fix-round-1 review, I3: reading `i?.attendees ?? []` off
 *  a non-object `i` silently produced `[]` — "no attendees", read as "contacts nobody" — for an
 *  input that was actually UNREADABLE, not empty. Every RECIPIENTS_OF entry checks this FIRST
 *  and returns `null` (asks) rather than treating "can't read the input" as "empty list". */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Free-form message CONTENT fields on `gmail_send`'s input — legitimately multi-line, so a raw
 *  CR/LF in one of these is normal, not a header-injection attempt; rejecting every
 *  multi-paragraph email would defeat the entire history-checked-send feature. */
const GMAIL_SEND_FREEFORM_FIELDS: ReadonlySet<string> = new Set(["bodyText", "signatureText", "signatureHtml"]);

/** True if any string value — or any string entry of an array value — on a non-freeform field
 *  of `obj` contains a CR or LF. Fix-round-2 review, item 2b (Critical, controller ruling): a
 *  clean `to` is not enough on its own — `services/chief-of-staff/lib/google.ts`'s
 *  `buildMimeEnvelope` writes `from`, `subject`, `inReplyTo` and `references` verbatim into the
 *  raw RFC-5322 header block, so `subject: "Hi\r\nBcc: stranger@evil.example"` (with a
 *  perfectly clean `to`) can still reach an unapproved recipient once Task 5 wires this board
 *  to `gmail_send` — this engine-side check has no idea `buildMimeEnvelope` exists, so it
 *  refuses on ANY non-freeform field carrying CR/LF, not a curated list of "the dangerous
 *  ones". `google.ts` carries the SAME guard independently (belt and suspenders — that one
 *  protects every caller of `buildMimeEnvelope`, not only a board-approved send). */
function hasCRLFOutsideFreeform(obj: Record<string, unknown>): boolean {
  const bad = (v: unknown): boolean => typeof v === "string" && /[\r\n]/.test(v);
  for (const [key, value] of Object.entries(obj)) {
    if (GMAIL_SEND_FREEFORM_FIELDS.has(key)) continue;
    if (bad(value)) return true;
    if (Array.isArray(value) && value.some(bad)) return true;
  }
  return false;
}

/** Contact tools whose recipients can be read from the call's input: first contact is decided per recipient
 *  (board-approval.ts), not per tool. Returns null when the input cannot be read — the caller then asks. */
export const RECIPIENTS_OF: Readonly<Record<string, (input: unknown) => string[] | null>> = {
  gmail_send: (input) => {
    if (!isPlainObject(input)) return null;
    if (hasCRLFOutsideFreeform(input)) return null;
    return extractAddresses(input["to"]);
  },
  // D-C (controller ruling, fix round 1): `notify` does NOT decide whether this contacts
  // anybody — Google guests see the event on their own calendars regardless of `notify`.
  // Attendees are read unconditionally; only an empty/absent list contacts nobody.
  calendar_create_event: (input) => (isPlainObject(input) ? extractAddresses(input["attendees"] ?? []) : null),
  // calendar_update_event gets NO entry — its input carries no attendees, so it always asks.
};

/** What the console's 🔒 column says for a RECIPIENTS_OF tool: at ✓ it sends to people the owner
 *  has written to, so "first contact always asks" would overstate it. One string, here, so the
 *  console and this policy cannot drift apart. */
export const RECIPIENT_CHECK_REASON = "asks for anyone you haven't written to";

const REASON: Record<AlwaysAskCategory, string> = {
  money: "moving money always asks first",
  delete: "deleting data always asks first",
  contact: "first contact with someone always asks first",
  publish: "publishing always asks first",
};

/** Exported so board-approval.ts's history-checked path locks with the IDENTICAL string
 *  mustAlwaysAsk uses for an ordinary contact tool, rather than a literal that could drift. */
export const FIRST_CONTACT_REASON = REASON.contact;

export function categoriesOf(tool: string): readonly AlwaysAskCategory[] | undefined {
  return TOOL_CATEGORIES[tool] ?? TOOL_CATEGORIES[`agent-kit__${tool}`];
}

export function mustAlwaysAsk(tool: string): { ask: true; reason: string } | { ask: false } {
  if (SELF_AUTONOMY_TOOLS.has(tool)) return { ask: true, reason: SELF_AUTONOMY_REASON };
  const cats = categoriesOf(tool);
  if (!cats) return { ask: true, reason: "unknown tool — asking first" };
  for (const c of ["money", "delete", "publish"] as const) if (cats.includes(c)) return { ask: true, reason: REASON[c] };
  if (cats.includes("contact") && !CONTACT_BY_CONSTRUCTION.has(tool)) return { ask: true, reason: REASON.contact };
  return { ask: false };
}

/**
 * `mustAlwaysAsk`, minus the CONTACT category — for a `RECIPIENTS_OF` tool, whose contact lock
 * is decided per-recipient by board-approval.ts instead of statically here. Fix-round-1 review,
 * I8: the original code skipped `mustAlwaysAsk` WHOLESALE for a `RECIPIENTS_OF` tool, which
 * would have silently bypassed money/delete/publish too if such a tool ever carried one of
 * those categories — a real bypass risk, not a hypothetical one, since nothing enforced it.
 * Every `RECIPIENTS_OF` tool is contact-only today (`tests/always-ask.test.ts`'s own invariant
 * test proves it), so this never actually fires differently from `mustAlwaysAsk` right now —
 * but a future tool that is BOTH history-checked and, say, a delete must still be caught here.
 */
export function mustAlwaysAskExceptContact(tool: string): { ask: true; reason: string } | { ask: false } {
  if (SELF_AUTONOMY_TOOLS.has(tool)) return { ask: true, reason: SELF_AUTONOMY_REASON };
  const cats = categoriesOf(tool);
  if (!cats) return { ask: true, reason: "unknown tool — asking first" };
  for (const c of ["money", "delete", "publish"] as const) if (cats.includes(c)) return { ask: true, reason: REASON[c] };
  return { ask: false };
}

const TOOL_TO_CAPABILITY: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [capability, doc] of Object.entries(CAPABILITY_DOCS) as Array<[string, { tools?: unknown }]>) {
    for (const t of Array.isArray(doc.tools) ? doc.tools : []) if (typeof t === "string" && !m.has(t)) m.set(t, capability);
  }
  return m;
})();

export function capabilityOfTool(tool: string): string | undefined {
  return TOOL_TO_CAPABILITY.get(tool) ?? TOOL_TO_CAPABILITY.get(`agent-kit__${tool}`);
}

/**
 * THE TOOL→AREA TABLE, BESIDE THE TOOL→CAPABILITY ONE ABOVE — and for the same reason.
 *
 * Until W5C-s5 the capability a vault tool was registered under WAS its area: `brain` meant the
 * personal store, `atlas` the shared one, `memory` the standing facts, and an agent granted one
 * of the three was thereby offered that store's tools and no others. One `vault` capability
 * spanning all three would have lost that distinction — a grant of `vault` for the facts alone
 * would have handed over the personal note tools too — so the distinction is written down
 * explicitly here instead, derived from the three tool groups the capability doc keys its own
 * prose to (`VAULT_PRIVATE_TOOLS` / `VAULT_SHARED_TOOLS` / `VAULT_FACT_TOOLS`).
 *
 * It is a REQUIREMENT, never a grant: `grantedToolNames` offers a vault tool only to a
 * declaration whose `areas` cover the area named here, and a vault tool this table does not
 * know is not offered at all. Nothing here can widen anything — the only thing it can do is
 * take a tool away.
 */
const VAULT_TOOL_AREAS: ReadonlyMap<string, VaultArea> = new Map<string, VaultArea>([
  ...VAULT_PRIVATE_TOOLS.map((t) => [t, "private"] as const),
  ...VAULT_SHARED_TOOLS.map((t) => [t, "shared"] as const),
  ...VAULT_FACT_TOOLS.map((t) => [t, "facts"] as const),
]);

/** The Vault area `tool` touches, or `undefined` for a tool that is not a vault tool at all.
 *  Deliberately WITHOUT `capabilityOfTool`'s `agent-kit__` fallback: the prefixed and unprefixed
 *  spellings are two different tools over two different stores here, and guessing between them
 *  is exactly the widening this table exists to prevent. */
export function areaOfTool(tool: string): VaultArea | undefined {
  return VAULT_TOOL_AREAS.get(tool);
}

/** The documented tools `capabilityOfTool` maps to `capability` — the console's fallback when an
 *  agent registered no tool list of its own. */
export function toolsOfCapability(capability: string): string[] {
  return [...TOOL_TO_CAPABILITY].filter(([, c]) => c === capability).map(([t]) => t);
}
