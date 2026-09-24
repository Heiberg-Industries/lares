/**
 * Human-readable approval-card titles for every gated tool (ORB-121).
 *
 * eve builds an approval card's title in `dist/src/harness/input-extraction.js` as the bare
 * string `Approve tool call: <toolName>`, derived from the tool NAME alone — there is no
 * per-tool label or description hook in the 0.32 approval API (`Approval` is a policy
 * function returning a decision, nothing more). So the only thing distinguishing "send this
 * email to a customer" from "delete this calendar event" on the card itself was the tool
 * name, with the actual arguments relegated to a collapsed raw-JSON block.
 *
 * `patches/eve.patch` makes that one line consult this module instead, falling back to eve's
 * original string. All semantics live HERE, in our code, so the patch stays a single
 * expression and survives an eve upgrade with minimal re-derivation.
 *
 * Two invariants this module must never break, because it renders the last thing a human
 * reads before authorising a write:
 *
 *   1. **It must never throw.** A formatter that crashes would take the approval card with
 *      it — turning a cosmetic feature into an outage of the gate itself. Every formatter
 *      runs inside `summarizeApproval`'s try/catch, and every field access is defensive:
 *      `input` is model-supplied and only schema-validated AFTER approval, so a field may be
 *      missing, null, or the wrong type at render time.
 *   2. **It must never overstate.** A summary that omits a destructive detail is worse than
 *      no summary, because it invites a faster tap. Where a field changes what the action
 *      DOES to the outside world — guests being emailed, a recurrence repeating forever —
 *      it is named, not dropped for brevity.
 */

import { formatDateTimeIn } from "./clock.js";
import { inboxNotePath } from "./note-paths.js";
import { mintYear } from "./deadlines.js";
import { ownerDay } from "./proactivity.js";

/** A date field rendered for a human, or the raw value when it is not a date.
 *
 *  Live 2026-08-18: the reminder card read `for 2026-08-19T09:00:00+02:00`. The date was
 *  correct, but an ISO timecode on an approval card is the same illegibility this module
 *  exists to remove — and it was read as a returning date bug. Saga's own confirmation
 *  directly below already said "onsdag 2026-08-19 kl 09:00 (Europe/Oslo)"; the card must not
 *  be the least readable line in the thread.
 *
 *  Converted into the OWNER's zone regardless of the offset the model supplied, because that is the
 *  clock Bendik is reading — an accurate "08:00" that is really 10:00 to him is worse than useless
 *  on something he is about to authorise. ORB-193 final review made the zone a parameter: on a New
 *  York trip his turn's clock block says New York, and a card still saying Europe/Oslo would describe
 *  the same instant on a second clock inside one exchange. Unparseable input falls through unchanged
 *  rather than rendering "Invalid Date": the model may legitimately pass something this function does
 *  not understand, and the raw value is still more informative than an error string. */
function when(v: unknown, tz: string): string | null {
  const raw = str(v);
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? trunc(raw) : formatDateTimeIn(parsed, tz);
}

/** The zone a card renders in when no owner clock was supplied — the home clock, which is what every
 *  agent without a wired `ownerTz` was already using. Never a silent guess: `formatDateTimeIn` names
 *  whichever zone it used in the output. */
export const DEFAULT_CARD_TZ = "Europe/Oslo";

/** Longest a single interpolated value may be before it is elided. Chosen so a title still
 *  fits one line in Slack and Telegram without wrapping into a wall of text. */
const MAX_FIELD = 72;

function str(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function trunc(v: string, max = MAX_FIELD): string {
  return v.length <= max ? v : `${v.slice(0, max - 1)}…`;
}

/** A quoted, truncated field, or null when absent — so callers can drop the clause entirely
 *  rather than render an empty pair of quotes. */
function quoted(v: unknown): string | null {
  const s = str(v);
  return s === null ? null : `"${trunc(s)}"`;
}

/**
 * LAR-59-s4 — the honesty marker for a reason the AGENT supplied, not the owner: "given by the
 * agent" is what tells him this is a claim to verify against the evidence, not a fact. Truncated
 * at 160, longer than {@link MAX_FIELD} on purpose — a delete's reason is the one clause on this
 * card worth a full sentence, not a fragment.
 *
 * STRICTLY `typeof v === "string"` (never `str()`, which coerces numbers/booleans): the
 * acceptance rule is "a non-string reason is ignored", and `str(42)` would otherwise render "42"
 * as if the agent had actually said something.
 */
function reasonClause(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : `— reason given by the agent: "${trunc(t, 160)}"`;
}

/** An array-or-scalar input as a list of non-null strings — the shape both recipient
 *  renderers start from. Factored out so the two cannot drift on what counts as a value. */
function stringList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.map(str).filter((x): x is string => x !== null)
    : [str(v)].filter((x): x is string => x !== null);
}

/** Recipient lists arrive as string[] (gmail `to`, calendar `attendees`) but a model may pass
 *  a bare string. Render the first, count the rest — "and 3 more" is the detail that matters
 *  before authorising a send. */
function recipients(v: unknown): string | null {
  const list = stringList(v);
  if (list.length === 0) return null;
  const [first] = list as [string, ...string[]];
  return list.length === 1 ? trunc(first) : `${trunc(first, 48)} and ${list.length - 1} more`;
}

/** All recipients from an array or scalar, each truncated individually so none are dropped
 *  for length. Used when every recipient must be named (e.g. a meeting follow-up where a
 *  wrong match must be visibly wrong before approval). Unlike `recipients()`, this never
 *  abbreviates to "and N more", which would hide who is about to be emailed. */
function allRecipients(v: unknown): string | null {
  const list = stringList(v);
  if (list.length === 0) return null;
  return list.map(a => trunc(a)).join(", ");
}

// ─── The link card (W7D-s3) ───────────────────────────────────────────────────────────────────
//
// `read_url` asks whenever the turn has already read somebody else's words
// (`tainted-approval.ts`), and the entire value of that card is the address. Every helper below
// exists because an address can read as one thing and resolve as another, and because this is
// the ONE formatter in this file whose field must never be shortened: a middle ellipsis in a URL
// eats exactly the query string a data-carrying exfiltration link is made of, and "https://…"
// plus a host is the shape of every phishing link ever clicked.

/**
 * Every character that would be invisible, or visible in the wrong place, on a card.
 *
 * C0 and C1 controls, the plain space (never legitimate inside an address, and a gap says
 * nothing about how many there are), NBSP and every other Unicode space, the bidi controls
 * (U+202A–U+202E reverse everything that follows them — the classic `exe.gnp` trick), the
 * zero-width and word-joiner range, the Hangul filler look-alikes, variation selectors and BOM.
 */
const INVISIBLE_IN_A_URL: readonly (readonly [number, number])[] = [
  [0x0000, 0x0020], // C0 controls and the plain space
  [0x007f, 0x00a0], // DEL, C1 controls, NBSP
  [0x034f, 0x034f], // COMBINING GRAPHEME JOINER
  [0x061c, 0x061c], // ARABIC LETTER MARK
  [0x115f, 0x1160], // Hangul fillers — render as blank in most fonts
  [0x1680, 0x1680], // OGHAM SPACE MARK
  [0x17b4, 0x17b5], // KHMER inherent vowels — zero width
  [0x180b, 0x180e], // Mongolian selectors and vowel separator
  [0x2000, 0x200f], // every Unicode space, ZWSP/ZWNJ/ZWJ, LRM/RLM
  [0x2028, 0x202f], // line/paragraph separators, the bidi overrides, narrow NBSP
  [0x205f, 0x206f], // medium math space, word joiner, invisible operators, deprecated bidi
  [0x3000, 0x3000], // IDEOGRAPHIC SPACE
  [0x3164, 0x3164], // HANGUL FILLER
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
  [0xffa0, 0xffa0], // HALFWIDTH HANGUL FILLER
  [0xfff9, 0xfffb], // interlinear annotation controls
];

/** The string as supplied, with every unseeable character written out as `\uXXXX`. Never
 *  trimmed, and never matched with a regular expression carrying raw control characters: this
 *  file is read by people, and a literal NUL in a source line is the same invisibility the
 *  function exists to remove. Iterated by CODE POINT, so an astral character is one character
 *  and a surrogate half is never printed on its own. */
function visibleUrl(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!;
    out += INVISIBLE_IN_A_URL.some(([lo, hi]) => cp >= lo && cp <= hi)
      ? `\\u${cp.toString(16).padStart(4, "0")}`
      : ch;
  }
  return out;
}

/** The host a fetch of this address would really resolve, or null when it is not a web address
 *  at all (`javascript:`, `data:`, `file:`, `mailto:`, or unparseable — all of which `new URL`
 *  happily accepts or rejects without saying so on a card). `hostname` is already IDNA-encoded
 *  by the WHATWG parser, which is why a mixed-script host comes back as its punycode. */
function fetchTarget(raw: string): { host: string; userinfo: boolean } | null {
  try {
    const u = new URL(raw);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.hostname === "") return null;
    return { host: u.hostname, userinfo: u.username !== "" || u.password !== "" };
  } catch {
    return null;
  }
}

/** What a percent-encoded address actually reads as, or null when decoding changes nothing (or
 *  cannot be done). The card shows what was SUPPLIED first — decoding it in place would be the
 *  lie — and this second. */
function percentReading(raw: string): string | null {
  if (!raw.includes("%")) return null;
  try {
    const decoded = decodeURIComponent(raw);
    return decoded === raw ? null : decoded;
  } catch {
    return null;
  }
}

/** Join non-empty clauses; returns null when nothing survived, so the caller falls back. */
function line(...parts: (string | null)[]): string | null {
  const kept = parts.filter((p): p is string => p !== null && p !== "");
  return kept.length === 0 ? null : kept.join(" ");
}

/** `tz` is the OWNER's zone at render time (see `when`); every formatter takes it so none has to
 *  reach for a module-level default that would be wrong on a trip. */
type Formatter = (input: Record<string, unknown>, tz: string) => string | null;

const FORMATTERS: Record<string, Formatter> = {
  // — Mail. `to` and subject are the two fields that decide whether this is safe to approve.
  gmail_send: (i) => line("Send email to", recipients(i["to"]), quoted(i["subject"]) && `— ${quoted(i["subject"])}`),
  gmail_draft: (i) => line("Draft email to", recipients(i["to"]), quoted(i["subject"]) && `— ${quoted(i["subject"])}`),

  // 2026-09-08 — changing who an EXISTING draft goes to ("add Kjetil to the reply to Stefan").
  // Every address is named, never counted: the card is the one moment to see exactly who is
  // being added to, or dropped from, a real email before it can be sent.
  gmail_draft_recipients: (i) => {
    const add = stringList(i["add"]).map((a) => trunc(a));
    const remove = stringList(i["remove"]).map((a) => trunc(a));
    const parts = [
      add.length > 0 ? `add ${add.join(", ")}` : null,
      remove.length > 0 ? `remove ${remove.join(", ")}` : null,
    ].filter((p): p is string => p !== null);
    return parts.length === 0 ? "Change the draft's recipients" : `Change the draft's recipients — ${parts.join("; ")}`;
  },

  // ORB-156. The card is where a WRONG meeting match becomes visible — ORB-155 refuses to
  // guess, but the one thing it cannot rule out is a confident wrong match, and the only
  // defence against that is a human seeing the meeting and the addresses side by side
  // before tapping. So both are named, never summarised away. Unlike `recipients()`,
  // `allRecipients()` never abbreviates to "and N more", which would hide who will receive
  // the follow-up email.
  meeting_followup_send: (i, tz) => line(
    "Send meeting follow-up for",
    quoted(i["meetingTitle"]),
    when(i["meetingWhen"], tz) && `(${when(i["meetingWhen"], tz)})`,
    allRecipients(i["to"]) && `to ${allRecipients(i["to"])}`,
  ),

  // ORB-156 Task 12 (fix round 1). The card is the deliberate-decision moment for switching
  // a series to auto-send — and unlike every other formatter in this file, `level` is not a
  // detail whose loss merely thins the card: it IS the decision. `line()` silently drops any
  // part that resolves to null, which is right everywhere else (a missing subject still
  // leaves "Send email to jonas@..." — degraded but honest) and wrong here: dropping `level`
  // would render "Set meeting follow-ups for "Folkepuls" to" with the actual choice —
  // `autonomous` vs `never`, opposites — silently missing, on the one card whose entire job
  // is to show that choice before a human taps it. `summarizeApproval` runs on
  // PRE-VALIDATION model input (invariant 1's premise), so either field can legitimately be
  // absent or the wrong type — this formatter refuses to render at all unless BOTH resolve to
  // real strings, falling back to `generic()`'s raw field dump, which is uglier but complete.
  meeting_followup_auto: (i) => {
    const meetingName = quoted(i["meetingName"]);
    const level = str(i["level"]);
    if (meetingName === null || level === null) return null;
    return line("Set meeting follow-ups for", meetingName, "to", level);
  },

  // — Brain. The path IS the blast radius for file/drop; never summarise it away.
  // ORB-143 Task 2: the three vault write tools moved into the @lares/agent-kit eve
  // extension and now run under the mandatory `agent-kit__` prefix. eve's approval card
  // looks up the title by the tool's FINAL runtime name (see this module's header) — a
  // formatter keyed on the old bare name would silently fall through to `generic()` for
  // every real Brain write from here on, which is exactly the degraded-card failure this
  // module exists to prevent. Renamed in the SAME commit as the tool migration, never after.
  "agent-kit__vault_write": (i) => line("Write Brain note", quoted(i["title"])),
  "agent-kit__vault_file": (i) => line("Move Brain note", str(i["path"]) && trunc(str(i["path"])!), "→", str(i["destination"]) && trunc(str(i["destination"])!)),
  "agent-kit__vault_drop": (i) => line("DELETE Brain note", str(i["path"]) && trunc(str(i["path"])!)),

  // — Reminders. A recurrence is the difference between one ping and a standing one.
  remind_set: (i, tz) => line("Set reminder", quoted(i["message"]), when(i["dueAt"], tz) && `for ${when(i["dueAt"], tz)}`, str(i["recurrence"]) && `repeating ${trunc(str(i["recurrence"])!, 24)}`, str(i["door"]) && `via ${str(i["door"])}`),
  remind_cancel: (i) => line("Cancel reminder", str(i["id"]) && trunc(str(i["id"])!, 40)),

  // — Deadlines (ORB-180). `deadline_mint_statutory`'s TITLE stays short (a count, not the
  // list — the list is DETAILS_MAX_LENGTH-sized text, which belongs in `DETAILS` below, not a
  // one-line card title); its full row-by-row breakdown and the "confirm each date" line are
  // the `deadline_mint_statutory` entry in `DETAILS` below, computed the same way this title
  // is: by calling the exported `mintYear()` again on the raw input, since eve's approval API
  // has no step between "the model proposed this call" and `execute()` where a card could be
  // handed a pre-computed value.
  deadline_mint_statutory: (i, tz) => {
    const entity = quoted(i["entity"]);
    const fiscalYear = str(i["fiscalYear"]);
    const jurisdiction = i["jurisdiction"] === "NO-AS" ? "NO-AS" : null;
    if (entity === null || fiscalYear === null || jurisdiction === null) return null;
    try {
      const omit = Array.isArray(i["omit"]) ? stringList(i["omit"]) : undefined;
      // The COUNT the card promises must be the count `execute()` inserts, so the card applies
      // the same already-past skip the tool does (ORB-180 review fix) — `includePast` rides in
      // from the model's own input, and `today` is the owner's day on the card's zone.
      const includePast = i["includePast"] === true;
      const { minted } = mintYear(jurisdiction, Number(fiscalYear), {
        omit,
        includePast,
        today: ownerDay(new Date(), tz),
      });
      return line("Mint", `${minted.length} statutory deadlines for`, entity, fiscalYear);
    } catch {
      return null;
    }
  },
  deadline_done: (i) => line("Close deadline DONE", str(i["id"]) && trunc(str(i["id"])!, 40), quoted(i["evidence"]) && `— ${quoted(i["evidence"])}`),
  deadline_dismiss: (i) =>
    line(
      "Dismiss deadline",
      str(i["id"]) && trunc(str(i["id"])!, 40),
      str(i["candidateThreadId"]) && `(candidate ${trunc(str(i["candidateThreadId"])!, 40)})`,
      quoted(i["reason"]) && `— ${quoted(i["reason"])}`,
    ),

  // — CRM. Prefixed so a Twenty write is never mistaken for a local one.
  twenty_comm_state: (i) => line("CRM: set comm-state to", str(i["state"]), str(i["expectedPrevious"]) && `(only if currently ${str(i["expectedPrevious"])})`),
  twenty_set_stage: (i) => line("CRM: set opportunity stage to", str(i["stage"])),
  twenty_create_opportunity: (i) => line("CRM: create opportunity", quoted(i["name"]), str(i["stage"]) && `at ${str(i["stage"])}`),
  twenty_note: (i) => line("CRM: add note", quoted(i["title"]) ?? quoted(i["body"])),
  twenty_do_not_contact: (i) => line("CRM: mark DO-NOT-CONTACT", quoted(i["reason"]) && `— ${quoted(i["reason"])}`),

  // — Calendar. `notify` decides whether real people receive mail; it is always stated.
  calendar_create_event: (i, tz) => line("Calendar: create", quoted(i["summary"]), when(i["start"], tz) && `at ${when(i["start"], tz)}`, recipients(i["attendees"]) && `with ${recipients(i["attendees"])}`, i["notify"] === true ? "(guests notified)" : null),
  calendar_update_event: (i) => line("Calendar: update", quoted(i["summary"]) ?? (str(i["eventId"]) && `event ${trunc(str(i["eventId"])!, 32)}`), i["notify"] === true ? "(guests notified)" : null),
  // LAR-59-s4: `account`/`calendarId` name WHERE the event lives (LAR-59-s1 carries them
  // through from the calendar the fan-out read it off), and `reason` names WHY the agent is
  // asking — both are additive: absent, as on every call before this ticket, the line is
  // byte-identical to what it always was.
  calendar_delete_event: (i) => line(
    "Calendar: DELETE event",
    str(i["eventId"]) && trunc(str(i["eventId"])!, 40),
    str(i["account"]) && `on ${trunc(str(i["account"])!, 40)}`,
    str(i["calendarId"]) && `(calendar ${trunc(str(i["calendarId"])!, 40)})`,
    i["notify"] === true ? "(guests notified)" : null,
    reasonClause(i["reason"]),
  ),

  // — Proposal resolutions. The decision is the whole point; lead with it.
  notion_resolve_proposal: (i) => line("Notion proposal —", str(i["decision"])?.toUpperCase() ?? null, str(i["id"]) && `(${trunc(str(i["id"])!, 32)})`),
  atlas_resolve_proposal: (i) => line("Atlas proposal —", str(i["decision"])?.toUpperCase() ?? null, str(i["id"]) && `(${trunc(str(i["id"])!, 32)})`),

  // — The link a tainted turn wants to open (W7D-s3). The address is the whole decision, so it
  // is rendered WHOLE: no `trunc`, no `MAX_FIELD`, no middle ellipsis, at any length. Three
  // clauses may follow it, and each only when it adds something the address itself does not say:
  // the host that is really resolved (userinfo before the "@", or a punycode host the owner
  // cannot see); what a percent-encoded address decodes to; and "this is not a web address" for
  // a `javascript:`/`data:`/`file:` string or one that does not parse. A case-only difference
  // (`EXAMPLE.com`) earns no clause — it is not a spoof, and a clause on every ordinary link is
  // how a card stops being read.
  //
  // `str()` is deliberately NOT used to read the url: it trims, and a trimmed leading space is a
  // character removed from the one field on this card that must be shown character for character.
  read_url: (i) => {
    const raw = typeof i["url"] === "string" ? i["url"] : null;
    if (raw === null || raw.trim() === "") return null;
    const target = fetchTarget(raw);
    const reading = percentReading(raw);
    return line(
      "Open link",
      visibleUrl(raw),
      target === null
        ? "— not a web address the fetcher will follow"
        : target.userinfo || !raw.toLowerCase().includes(target.host)
          ? `— the fetcher resolves this to ${target.host}`
          : null,
      reading === null ? null : `— percent-encoded; it reads ${visibleUrl(reading)}`,
    );
  },

  echo_note: (i) => line("Gate proof — echo note", quoted(i["note"])),

  // — Calliope (ORB-135). Her two gated tools; both are LOCAL to eve-calliope
  // (agent/tools/*.ts), so they carry no `agent-kit__` prefix — that prefix belongs to tools
  // served BY this package's extension, which is exactly the distinction the Brain block
  // above records. This file is fleet-wide, so a formatter here for an agent's local tool is
  // normal: `gmail_send`, `remind_set` and every `twenty_*` above are eve-saga's local tools.
  //
  // In both cases the field named is the one that decides what the action does to the outside
  // world — the note that gets written, the spend that gets incurred — never the body or a
  // count, which would invite the faster tap this module exists to prevent (invariant 2).
  //
  // BOTH RETURN null RATHER THAN A BARE LABEL when their key field is missing, which is why
  // neither is written as a plain `line(...)` call. `line()` drops absent clauses and keeps
  // the literal, so `line("Write Atlas note", null)` renders "Write Atlas note" — a card that
  // looks complete while saying strictly less than eve's own "Approve tool call: vault_write",
  // and nothing at all about blast radius. Returning null falls through to `generic()`, which
  // at least lists whatever fields the model did supply.
  //
  // The shared-area `vault_write` (W5C-s4; `atlas_write` before the rename) takes a TITLE, not
  // a path (ORB-135 fix round 1 — the path is derived, so a traversal argument is
  // unrepresentable rather than merely refused). The card names both:
  // the title is what the owner recognises, and the DERIVED path is still what says whether
  // an existing _inbox note is about to be replaced. `inboxNotePath` is imported rather than
  // re-implemented here — two copies of that derivation ends with a card naming one file while
  // the tool writes another.
  vault_write: (i) => {
    const title = str(i["title"]);
    return title === null ? null : `Write Atlas note ${quoted(title)} → ${trunc(inboxNotePath(title))}`;
  },

  // A studio run is ten paid model calls at the frontier model. The BRIEF is what decides
  // whether that spend is wanted, so it is the field shown — truncated, because a brief can
  // be a paragraph and a card must stay one line.
  studio_ideate: (i) => {
    const brief = quoted(i["brief"]);
    return brief === null ? null : `Run the studio on ${brief}`;
  },
};

/** Last resort for a tool with no formatter: name it, then show its first few scalar fields.
 *  Better than the bare tool name, and it means a NEW gated tool is never worse off than
 *  before this module existed — it just isn't as good as a hand-written line. */
function generic(toolName: string, input: Record<string, unknown>): string {
  const fields = Object.entries(input)
    .map(([k, v]) => {
      const s = str(v);
      return s === null ? null : `${k}: ${trunc(s, 40)}`;
    })
    .filter((x): x is string => x !== null)
    .slice(0, 3);
  return fields.length === 0 ? `Approve tool call: ${toolName}` : `${toolName} — ${fields.join(", ")}`;
}

/**
 * The entry point the eve patch calls. Returns the card title, or `undefined` to let eve use
 * its own string (which is also what happens on any error).
 */
export function summarizeApproval(toolName: unknown, input: unknown, tz: string = DEFAULT_CARD_TZ): string | undefined {
  try {
    const name = typeof toolName === "string" ? toolName : null;
    if (name === null) return undefined;
    const obj: Record<string, unknown> =
      input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const formatted = FORMATTERS[name]?.(obj, tz) ?? generic(name, obj);
    const trimmed = formatted.trim();
    return trimmed === "" ? undefined : trimmed;
  } catch {
    // Deliberately swallowed: see invariant 1 in the module header. A cosmetic title is
    // never worth risking the approval gate it sits on.
    return undefined;
  }
}

/**
 * Whether a DEDICATED formatter exists for this tool (ORB-140). The generic fallback above names
 * at most three fields, forty characters each — enough for a title, not enough to be the only
 * thing a human reads before authorising a write. The eve patch drops the raw "Tool input"
 * block from a Slack card only when this is true; for anything else the block stays, collapsed.
 */
export function coversApproval(toolName: unknown): boolean {
  return typeof toolName === "string" && Object.prototype.hasOwnProperty.call(FORMATTERS, toolName);
}

// ─── The draft under a mail card ───────────────────────────────────────────────────────────
//
// 2026-09-07: the Folkepuls follow-up card read `Send meeting follow-up for "Folkepuls" (…) to
// kjetiltu@…, stefanskogevall@…` and not one word of the email. ORB-140 had removed the raw
// "Tool input" JSON from every card with a dedicated title — and for a mail send that JSON was
// the only place the subject and body ever appeared. The title cannot carry them (a Slack card
// body is capped at 200 characters), so the eve patch's seventh hunk asks THIS registry for a
// second piece of text and renders it as a section directly under the approve/cancel card.
//
// Same two invariants as the titles: never throw, never overstate. And one more — the draft is
// the thing being authorised, so it is shown whole up to the Slack section limit and cut with a
// visible ellipsis, never summarised. Slack mrkdwn treats `<…>` as a link and `&` as an entity,
// so both are escaped: an address written `<kjetil@x.com>` must be read, not eaten.

/** Under Slack's 3000-character section limit with room for eve's own truncation to stay idle. */
export const DETAILS_MAX_LENGTH = 2800;

function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The sentence a shortened card ends with, so "…" is never the only sign that something
 *  was cut. Exported so the test and any future renderer agree on one wording. */
export function shortenedNotice(hidden: number): string {
  return `\n\n— shortened — ${hidden} characters are not shown.`;
}

/** Cuts to `max` and SAYS SO. A bare "…" reads as a stylistic ellipsis; an approval card that
 *  hid part of what is being authorised has to admit it (OpenClaw advisory: "Exec approval
 *  display truncation could hide the command being approved"). */
function shorten(text: string, max = DETAILS_MAX_LENGTH): string {
  if (text.length <= max) return text;
  const room = shortenedNotice(text.length).length; // widest the notice can get
  const kept = Math.max(0, max - room - 1);
  return `${text.slice(0, kept).trimEnd()}…${shortenedNotice(text.length - kept)}`;
}

/** `tz` is the OWNER's zone at render time, exactly as {@link Formatter} takes it. Unlike the
 *  title hook, eve's details hook is published with no zone of its own, so
 *  {@link detailsForApproval} falls back to {@link DEFAULT_CARD_TZ} — a boundary that can differ
 *  from the title's by one day for a few hours on a trip, and by nothing at all at home. */
type Details = (input: Record<string, unknown>, tz: string) => string | null;

/** `subject` + `bodyText` — the field names all three mail tools share (gmail_send,
 *  gmail_draft, meeting_followup_send). Either may be absent on pre-validation input. */
const mailDetails: Details = (i) => {
  const subject = str(i["subject"]);
  const body = str(i["bodyText"]);
  if (subject === null && body === null) return null;
  const parts: string[] = [];
  const to = allRecipients(i["to"]);
  if (to !== null) parts.push(`*To:* ${escapeMrkdwn(to)}`);
  if (subject !== null) parts.push(`*Subject:* ${escapeMrkdwn(subject)}`);
  if (body !== null) parts.push(escapeMrkdwn(body));
  return shorten(parts.join("\n\n"));
};

// The mint card's row list — every `<title> — <dueDate>` line `deadline_mint_statutory` would
// insert, plus the line that says what the card exists to make the owner do. Re-derives the
// same `mintYear()` call the title formatter above and the tool's own `execute()` all make —
// three call sites computing the same pure function from the same input is the trade for a
// card that shows real dates before a single row exists in the database.
const deadlineMintDetails: Details = (i, tz) => {
  const fiscalYear = str(i["fiscalYear"]);
  const jurisdiction = i["jurisdiction"] === "NO-AS" ? "NO-AS" : null;
  if (fiscalYear === null || jurisdiction === null) return null;
  try {
    const omit = Array.isArray(i["omit"]) ? stringList(i["omit"]) : undefined;
    const includePast = i["includePast"] === true;
    const { minted, skippedPast } = mintYear(jurisdiction, Number(fiscalYear), {
      omit,
      includePast,
      today: ownerDay(new Date(), tz),
    });
    if (minted.length === 0 && skippedPast.length === 0) return null;
    const lines = minted.map((r) => `${escapeMrkdwn(r.title)} — ${r.dueDate}`);
    // NAMED, not counted: a mid-year mint that quietly showed 4 of the year's 8 rules would look
    // like a broken rule set. The line says what was left out and how to get it back.
    const past =
      skippedPast.length === 0
        ? []
        : ["", `Already past, not minted: ${skippedPast.map((r) => escapeMrkdwn(r.title)).join(", ")}.`];
    return shorten(
      [...lines, ...past, "", "Confirm each date against the authority before approving."].join("\n"),
    );
  } catch {
    return null;
  }
};

const DETAILS: Record<string, Details> = {
  gmail_send: mailDetails,
  gmail_draft: mailDetails,
  meeting_followup_send: mailDetails,
  deadline_mint_statutory: deadlineMintDetails,
  // Every guest of a calendar invitation, named in full — never abbreviated to "and N more",
  // which would hide who is about to be invited — plus the line that says guests see the event
  // on their own calendars whether or not `notify` sends an email (the D-C ruling in
  // `always-ask.ts`, stated on the card as well as in prose).
  calendar_create_event: (i, tz) => {
    const guests = allRecipients(i["attendees"]);
    if (guests === null) return null;
    const whenStr = when(i["start"], tz); // reuse the existing `when(v, tz)` helper
    return shorten(
      [
        `*Guests:* ${escapeMrkdwn(guests)}`,
        whenStr === null ? null : `*When:* ${whenStr}`,
        "Invited guests see it on their own calendars whether or not an email notification is sent.",
      ]
        .filter((p): p is string => p !== null)
        .join("\n\n"),
    );
  },
};

/**
 * The second entry point the eve patch calls: mrkdwn to render under the card, or `undefined`
 * for no block at all — which is also what happens on any error, and for every tool without a
 * details formatter, so ORB-140's card-only shape is unchanged for them.
 */
export function detailsForApproval(
  toolName: unknown,
  input: unknown,
  tz: string = DEFAULT_CARD_TZ,
): string | undefined {
  try {
    if (typeof toolName !== "string") return undefined;
    if (!Object.prototype.hasOwnProperty.call(DETAILS, toolName)) return undefined;
    const obj: Record<string, unknown> =
      input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const out = DETAILS[toolName]!(obj, tz);
    return out === null || out.trim() === "" ? undefined : out;
  } catch {
    // Deliberately swallowed: see invariant 1 in the module header.
    return undefined;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __eveApprovalSummary: ((toolName: unknown, input: unknown) => string | undefined) | undefined;
  // eslint-disable-next-line no-var
  var __eveApprovalCovers: ((toolName: unknown) => boolean) | undefined;
  // eslint-disable-next-line no-var
  var __eveApprovalDetails: ((toolName: unknown, input: unknown) => string | undefined) | undefined;
}

/** Publish the formatters where the eve patch can reach them. Called once at server startup,
 *  before any turn runs, from `agent/instrumentation.ts`. A global is the seam because the
 *  patch edits COMPILED framework code that cannot import from our workspace. If this is
 *  never called — other workspace members share this patch — eve keeps its original cards. */
export interface ApprovalSummaryOptions {
  /**
   * The OWNER's timezone at render time (ORB-193 final review). SYNCHRONOUS, because eve's card
   * rendering is: the patch calls `__eveApprovalSummary` inline and there is nowhere to await. An
   * agent whose clock is only resolvable asynchronously should pass a last-known-value reader —
   * `services/chief-of-staff/lib/owner-clock.ts`'s `ownerTzSync()` is that shape. Omitted, or throwing,
   * means {@link DEFAULT_CARD_TZ}: a card on the home clock is a small wrongness on a trip, and a
   * card that failed to render is an outage of the gate it sits on (invariant 1).
   */
  tz?: () => string;
}

export function registerApprovalSummary(opts: ApprovalSummaryOptions = {}): void {
  const tz = (): string => {
    try {
      const t = opts.tz?.();
      return typeof t === "string" && t.trim() !== "" ? t : DEFAULT_CARD_TZ;
    } catch {
      return DEFAULT_CARD_TZ;
    }
  };
  globalThis.__eveApprovalSummary = (toolName, input) => summarizeApproval(toolName, input, tz());
  globalThis.__eveApprovalCovers = coversApproval;
  globalThis.__eveApprovalDetails = detailsForApproval;
}
