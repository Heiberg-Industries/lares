// services/chief-of-staff/lib/person/render.ts
// CORE — vendor-neutral. Turns the dossier into the text the model reads.
// Ported verbatim from services/agent-runtime/lib/person/render.ts (Task 8) — logic unchanged.
//
// This file is where the honesty rules stop being types and become words. A failed
// source must READ as failed by the time it reaches a prompt; a union that is correct
// in memory and flattened here would have bought nothing.
import { SEARCH_WINDOW_DAYS } from "./types.js";
import type { MailItem, MeetingItem, PersonDossier, TranscriptItem } from "./gather.js";
import type { OrgFacts } from "./org.js";
import type { SourceResult } from "./types.js";

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * One line per source: found / nothing / COULD NOT READ / not searchable this way. Never two
 * of these collapsed — least of all the last two, which point in opposite directions: one asks
 * the reader to flag a broken tool, the other asks them to accept a permanent shape of the
 * index and move on.
 */
function sourceLine(name: string, r: SourceResult<unknown>): string {
  if (r.status === "failed") return `- ${name}: COULD NOT READ (${r.reason})`;
  if (r.status === "not-applicable") return `- ${name}: not searchable this way (${r.reason})`;
  if (r.status === "empty") return `- ${name}: nothing found`;
  return `- ${name}: read OK`;
}

/** The windows every "nothing found" above is scoped to. See SEARCH_WINDOW_DAYS. */
const windowNote =
  `Windows searched: mail ${SEARCH_WINDOW_DAYS.mail} days back, calendar ` +
  `${SEARCH_WINDOW_DAYS.calendarBack} days back and ${SEARCH_WINDOW_DAYS.calendarAhead} ahead. ` +
  `"Nothing found" means nothing in that window — not nothing ever.`;

function mailLine(m: MailItem): string {
  return `- ${day(m.at)} — "${m.subject}"${m.lastSpeakerIsThem ? " [they spoke last]" : ""}`;
}
const meetingLine = (m: MeetingItem) => `- ${day(m.at)} — ${m.title}${m.upcoming ? " (upcoming)" : ""}`;
const transcriptLine = (t: TranscriptItem) => `- ${day(t.at)} — ${t.path}\n  "${t.excerpt}"`;

function section(title: string, lines: string[]): string[] {
  return lines.length ? [title, ...lines, ""] : [];
}

/**
 * ORB-166 — the ORGANISATION section: what the note stores and the CRM hold about the COMPANY
 * behind this person, as opposed to about the person.
 *
 * Rendered in both the resolved and the UNKNOWN branch, because the shape it exists for lives in
 * the unknown one: a first-contact address where "no record of the person" is the right answer
 * and "you know nothing about them" is not — the morning this was filed, Saga told Bendik to go
 * read up on the vendor his own dev agent runs on.
 *
 * Every hit carries its STORE and its PATH, and the closing sentence says what they are: notes to
 * READ, not facts to restate. A path is not a claim, and a list of paths must never become one —
 * the whole point of naming them is that she can open the note before she says anything about the
 * relationship.
 *
 * `not-applicable` prints nothing at all here (the source line below still reports it): a personal
 * mailbox has no organisation, and a heading over that non-question is precisely the "company
 * unknown" the ticket forbids.
 */
function organisationSection(r: SourceResult<OrgFacts>): string[] {
  if (r.status !== "found") return [];
  const { asked, notes, crm } = r.data;
  const label = [asked.name, asked.domain].filter(Boolean).join(" — ") || "the organisation";
  const lines = [
    ...(crm
      ? [`- CRM: ${crm.name}${crm.domain ? ` (${crm.domain})` : ""}${crm.orgNumber ? `, org no ${crm.orgNumber}` : ""}`]
      : []),
    ...notes.map((n) => `- ${n.store}: ${n.path}`),
  ];
  if (lines.length === 0) return [];
  return [
    `ORGANISATION — ${label}:`,
    ...lines,
    "These are NOTES, not findings: paths into the Brain and Atlas, matched on the company name",
    "and the mail domain. Read the note (Brain or Atlas, per the marker) before you rely on it,",
    "and say only what the note you actually read says. Never restate a path as a fact, and never",
    "infer a relationship from a filename.",
    "",
  ];
}

/**
 * `bounded: true` drops the three `EARLIER — …` sections and the ORGANISATION section.
 *
 * Later ORB-147 tasks feed this text into a prompt that already carries the thread, his sent
 * mail, and free/busy — a full multi-history dump on top of that is bulk, not context, and
 * EARLIER is exactly the part a prompt with its own history elsewhere does not need repeated.
 * `NEW SINCE` stays: it is what he has not seen yet regardless of what else is in the prompt.
 *
 * ORB-166 fix round 1 — the ORGANISATION section is dropped under bounded too, for a different
 * and sharper reason. The one bounded caller is the OUTBOUND EMAIL DRAFTER
 * (`agent/schedules/email-triage.ts`), whose prompt writes a reply to an external counterparty.
 * The org section carries internal vault paths (`ventures/orakel/…md`), CRM org numbers, and an
 * instruction to go and read them — exactly the class of internal context ORB-147 introduced
 * `bounded` to keep out of that prompt. The drafter keeps precisely what it had; giving it
 * organisation context is a deliberate change to make later, on purpose, with its own test.
 * The `Sources consulted` lines — including every `COULD NOT READ` / `not searchable this way`
 * — MUST survive bounded too: a gap in OUR reading is a fact about the tool, not a piece of
 * history, and dropping it here would let a broken source pass as a quiet one.
 */
export function renderDossier(d: PersonDossier, opts: { bounded?: boolean } = {}): string {
  const out: string[] = [];
  // Same precedence as resolvePerson's own branch order: a merge query supplies no single
  // `email`/`name`, so without this an UNKNOWN or AMBIGUOUS header from an emails-only query
  // would read "(no query)" — true of the OTHER two fields, false of what he actually asked.
  const label = d.query.emails?.length ? d.query.emails.join(", ") : d.query.email ?? d.query.name ?? "(no query)";

  if (d.resolution.kind === "ambiguous") {
    return [
      `PERSON LOOKUP — AMBIGUOUS: ${label}`,
      "",
      d.resolution.question,
      "",
      "Ask him which one. Do NOT pick one and do NOT merge them — their histories are different people's histories.",
      "If he says they are the same person — a job change gives one human two addresses — call",
      "`person.lookup` again with `emails` set to both addresses, and you will get one combined view.",
    ].join("\n");
  }

  if (d.resolution.kind === "unknown") {
    // ONLY `failed` breaks a lookup. A `not-applicable` source answered the only way it
    // honestly can — "not in this form" — and treating that as an outage is what turned every
    // new meeting participant in the 20:00 pass into a message telling him his tools are down.
    const lookupIntact = d.sources.crm.status !== "failed" && d.sources.pulse.status !== "failed";
    const brokenSources = [d.sources.crm, d.sources.pulse]
      .filter((s): s is Extract<typeof s, { status: "failed" }> => s.status === "failed")
      .map((s) => `${s.source} (${s.reason})`);
    // Named separately so the "no record" sentence can scope itself to the sources that
    // actually answered. Absence is only established where something was asked.
    const unaskable = [d.sources.crm, d.sources.pulse]
      .filter((s): s is Extract<typeof s, { status: "not-applicable" }> => s.status === "not-applicable")
      .map((s) => s.source);
    const answered = [d.sources.crm, d.sources.pulse]
      .filter((s) => s.status !== "failed" && s.status !== "not-applicable")
      .map((s) => (s.source === "crm" ? "the CRM" : "the relationship graph"));

    // An absence is only established where something was actually asked and answered. Both
    // ways of failing that test — a source that broke, or every source refusing the question's
    // shape — must produce a headline AND a closing instruction that say so.
    const absenceEstablished = lookupIntact && answered.length > 0;

    const headline = !lookupIntact
      ? `COULD NOT COMPLETE THE LOOKUP — ${brokenSources.join("; ")} failed. ` +
        `"No record" is NOT established: you did not manage to look. Say exactly that — ` +
        `that you could not check, and which source was unreachable — and do not say there is nothing on them.`
      : !absenceEstablished
        ? `NOTHING COULD BE ASKED IN THIS FORM — ${unaskable.join(", ")} cannot answer a query of this ` +
          `shape at all. "No record" is NOT established: no source was actually searched. Say what you ` +
          `could not ask and why, and ask him for something you CAN search on (a name).`
        : unaskable.length === 0
          ? "No record in the CRM or the relationship graph."
          : `No record in ${answered.join(" or ")}. ` +
            `${unaskable.join(", ")} could not be searched in this form at all — that is how it is indexed, ` +
            `not a finding about them, so do not report it as an absence or as a fault.`;

    // The two tails are mutually exclusive on purpose. The old code emitted "say plainly that
    // there is no record" underneath the COULD NOT COMPLETE header — two opposite instructions
    // in one tool result, and the model gets to pick.
    const tail = absenceEstablished
      ? [
          "Say plainly that there is no record, then offer him ready-made lookup links to open himself",
          "(a LinkedIn people search, a web search for the name plus company, the company site).",
          "If he pastes a link back, read it with `read_url.fetch`.",
        ]
      : [
          "Do NOT say there is no record — you did not establish that. Say what you could not check, and why.",
          "You can still offer him ready-made lookup links to open himself (a LinkedIn people search, a web",
          "search for the name plus company, the company site). If he pastes a link back, read it with `read_url.fetch`.",
        ];

    // ORB-166 — the one thing that CAN be known about a first-contact address: who they write
    // FROM. It sits above "Sources consulted" because it is the answer, not the audit trail.
    const orgLines = organisationSection(d.sources.organisation);

    return [
      `PERSON LOOKUP — UNKNOWN: ${label}`,
      "",
      headline,
      "",
      ...(orgLines.length
        ? [
            "You do know their ORGANISATION, though — that is a different question and it was asked",
            "separately. This is first contact with the PERSON, and that is NOT the same as no prior",
            "history with the company. Lead with the organisation: read the notes below and say what",
            "the relationship actually is.",
            "",
            ...orgLines,
          ]
        : []),
      ...section("Sources consulted:", [
        sourceLine("crm", d.sources.crm),
        sourceLine("pulse", d.sources.pulse),
        sourceLine("organisation", d.sources.organisation),
        sourceLine("identity", d.sources.identity),
      ]),
      "You cannot search the web — you have no search tool, only `read_url.fetch` for a link you are GIVEN.",
      ...tail,
    ].join("\n");
  }

  const p = d.resolution.person;
  out.push(`PERSON LOOKUP: ${p.displayName}${p.company ? ` — ${p.company}` : ""}`);
  out.push(`Addresses on file: ${p.emails.join(", ") || "none"}`);
  out.push(`Matched in: ${[p.source, ...d.resolution.alsoSeenIn].join(", ")}`);

  // He typed part of a name and got a whole one. One clause makes the inference his to
  // correct; silence would make it look like the record was called what he typed.
  if (d.resolution.matchedLoosely) {
    out.push(
      `MATCHED LOOSELY: you asked for "${d.resolution.matchedLoosely.asked}" and this is the record for ` +
      `"${d.resolution.matchedLoosely.matched}" — the only one that matched. Say so in one clause ` +
      `("matched ${d.resolution.matchedLoosely.matched} from your ${d.resolution.matchedLoosely.asked}") so he can correct you.`,
    );
  }

  // Disclosed, not merged. A same-name record carrying no address cannot be confirmed as
  // this person — and it cannot be asked about usefully either, since there is nothing to
  // tell the two apart. So it is named and set aside. The answer stays useful; the choice
  // stops being invisible, which was the actual failure.
  if (d.resolution.setAside.length > 0) {
    out.push(
      `ALSO FOUND, NOT MERGED: ${d.resolution.setAside.length} other record(s) named ` +
      `${p.displayName} with no address on file — ` +
      `${d.resolution.setAside.map((s) => s.source).join(", ")}. ` +
      `Answered about the ${p.source} record. Mention this in one clause so he knows a choice was made.`,
    );
  }
  out.push("");

  out.push(
    d.anchor
      ? `Last engagement: ${day(d.anchor.at)} (${d.anchor.kind}). Everything under NEW SINCE is what he has not seen.`
      // Scoped to the window, not to all of history: nothing was searched beyond it, so
      // "he does not know them" is an assertion about the relationship that this lookup
      // never established. Someone he last met nine months ago lands here.
      : "No prior engagement found in the window searched (see the windows below) — give the full picture, " +
        "but say it as 'nothing in that period', never as 'he has never dealt with them'.",
  );
  out.push("");

  if (d.owed.length) {
    out.push("YOU OWE A REPLY — they spoke last and nobody answered:");
    out.push(...d.owed.map(mailLine));
    out.push("");
  }

  out.push(...section("NEW SINCE — mail:", d.fresh.mail.map(mailLine)));
  out.push(...section("NEW SINCE — meetings:", d.fresh.meetings.map(meetingLine)));
  out.push(...section("NEW SINCE — what was said:", d.fresh.transcripts.map(transcriptLine)));
  if (!opts.bounded) {
    out.push(...section("EARLIER — mail:", d.history.mail.map(mailLine)));
    out.push(...section("EARLIER — meetings:", d.history.meetings.map(meetingLine)));
    out.push(...section("EARLIER — what was said:", d.history.transcripts.map(transcriptLine)));
  }

  if (d.sources.company.status === "found") {
    out.push(`COMPANY — ${d.sources.company.data.name}: ${d.sources.company.data.note}`);
    out.push("");
  }

  if (!opts.bounded) out.push(...organisationSection(d.sources.organisation));

  out.push("Sources consulted:");
  out.push(sourceLine("crm", d.sources.crm));
  out.push(sourceLine("pulse", d.sources.pulse));
  out.push(sourceLine("mail", d.sources.mail));
  out.push(sourceLine("meetings", d.sources.meetings));
  out.push(sourceLine("transcripts", d.sources.transcripts));
  out.push(sourceLine("company", d.sources.company));
  out.push(sourceLine("organisation", d.sources.organisation));
  out.push(sourceLine("identity", d.sources.identity));
  out.push(windowNote);
  out.push("");
  out.push(
    "A source marked COULD NOT READ is a gap in YOUR reading, not an absence in the world. " +
    "Say so in those terms — never report it as 'nothing found'. A source marked 'not searchable " +
    "this way' is neither: it cannot answer a question of this shape, and no retry changes that.",
  );

  return out.join("\n");
}
