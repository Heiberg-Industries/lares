/**
 * Brief strings — LAR-16-s2. Every string the six Norwegian structural places in
 * `lib/brief-content.ts` used to hard-code (`heldBackLine`, `dueLabel`, `candidateRow`, the
 * "+N flere frister" tail, the block label `"Frister"`, `deadlinesClause`), now keyed by
 * `BriefLanguage` so the brief can render in the owner's chosen language instead of always
 * Norwegian.
 *
 * `nb` is today's wording, copied verbatim — nothing about the owner's own brief changes by a
 * single character. `en` is a plain, natural translation in the same brisk, businesslike
 * register. No i18n library: this is a small, closed set of short phrases, some of which take a
 * count or a name, so each is a plain function where the wording (not just a placeholder) needs
 * to change with the number — see `heldBack.count` and `deadlines.dueLabel.overdue`, where
 * singular and plural are spelled out rather than papered over with an "(s)".
 *
 * Tool names inside `deadlines.candidateRow` (`deadline_add fromThreadId …`,
 * `deadline_dismiss candidateThreadId …`) are code, not prose, and are byte-identical across
 * every language — only the surrounding sentence translates.
 *
 * The `Record<BriefLanguage, BriefStrings>` annotation is load-bearing: a language added to
 * `BRIEF_LANGUAGES` (`lib/brief-settings.ts`) without an entry here is a compile error, not a
 * runtime surprise.
 *
 * LAR-16-s4 added `BriefRender.tz` beside `lang`: one bag of render options for both of a
 * brief's independent axes (which language, which clock), rather than a second trailing
 * parameter threaded everywhere `render` already is.
 */
import type { BriefLanguage } from "./brief-settings.js";

export interface BriefRender {
  lang?: BriefLanguage;
  /** IANA zone, e.g. "Europe/Oslo". Defaults to `DEFAULT_HOME_TZ` (`@lares/agent-kit/owner-clock`)
   *  wherever this is consumed — see `buildMorningPrompt`/`buildEveningPrompt`. */
  tz?: string;
}

interface BriefStrings {
  heldBack: {
    /** "Holdt tilbake siden forrige brief:" — precedes the joined per-door parts. */
    prefix: string;
    /** "1 melding" / "3 meldinger" — the noun, spelled out for the FIRST door only; later doors
     *  in the same line show a bare number (see `heldBackLine`). */
    count: (n: number) => string;
    /** "på Slack" / "on Slack" — the preposition, fused with the (language-neutral) door label. */
    onDoor: (doorLabel: string) => string;
    /** "(tak nådd eller stille timer)." — trailing clause, period included. */
    suffix: string;
  };
  deadlines: {
    dueLabel: {
      /** "Forfalt for 2 dager siden:" — `late` is always ≥ 1. */
      overdue: (late: number) => string;
      /** "SISTE FRIST — i dag:" */
      dueToday: string;
      /** "SISTE FRIST — i morgen:" */
      dueTomorrow: string;
      /** "Om 8 dager (2026-09-16):" */
      dueIn: (days: number, dueDate: string) => string;
    };
    /** The full candidate line, tool names untranslated. */
    candidateRow: (subject: string, sender: string, threadId: string) => string;
    /** "- +5 flere frister — se konsollen" */
    moreTail: (hidden: number) => string;
    /** "Frister" — the `## `-prefixed block heading `labeledContext` renders. */
    blockLabel: string;
    /** The one sentence that tells the model what to do with the block above. */
    clause: string;
  };
  /** LAR-59-s6 — the ONE fixed word `conflictLine` (`lib/brief-content.ts`) prefixes a
   *  cancellation mail's evidence sentence with, when a clash's resolution is strong. The
   *  sentence itself (`lib/conflict-evidence.ts`'s `evidenceSentence`) stays fixed English in
   *  every language — it is mail-derived third-party text, never translated — so only this one
   *  label word varies. */
  conflicts: {
    /** "Evidence:" — precedes the evidence sentence verbatim, with one space either side. */
    evidenceLabel: string;
  };
  /** LAR-68 — the deadline LADDER's own fixed sentences (`agent/schedules/deadlines.ts`'s
   *  `rungText`), a separate lane from `deadlines` above: that one is a LINE inside the brief,
   *  this one is the whole message an unprompted reminder sends. `title`/`entity` arrive
   *  untranslated (they are the owner's own data, like `candidateRow`'s subject/sender); the
   *  `consequence` argument already carries its leading punctuation (`" — X"` or `""`) from the
   *  caller, since the em dash itself is not a language-specific choice. */
  deadlineLadder: {
    /** Rung 1, the day before: "Frist i morgen: X (Y) — Z. Si «ferdig» eller «avvis» når den er håndtert." */
    dueTomorrow: (title: string, entity: string, consequence: string) => string;
    /** Rung 2, the day itself: "SISTE FRIST i dag: X (Y) — Z." */
    dueToday: (title: string, entity: string, consequence: string) => string;
    /** Rung 3's stop for a row that was never raised at all (rung 0 — the ladder never catches a
     *  rung up): "«X» (Y) forfalt N dag(er) siden uten at jeg fikk sagt fra. Jeg stopper her —
     *  si fra om du vil ha den tilbake." `lateDays` is always ≥ 0. */
    stopNeverRaised: (title: string, entity: string, lateDays: number) => string;
    /** Rung 3's stop counting the rungs actually raised: "Jeg har tatt opp «X» N gang(er) og
     *  stopper nå. Si fra om du vil ha den tilbake." `times` is always ≥ 1 (see the file's own
     *  note on why this ternary's singular branch is unreachable today, kept for honesty). */
    stopWithCount: (title: string, times: number) => string;
  };
}

const nb: BriefStrings = {
  heldBack: {
    prefix: "Holdt tilbake siden forrige brief:",
    count: (n) => (n === 1 ? "1 melding" : `${n} meldinger`),
    onDoor: (doorLabel) => `på ${doorLabel}`,
    suffix: "(tak nådd eller stille timer).",
  },
  deadlines: {
    dueLabel: {
      overdue: (late) => `Forfalt for ${late} ${late === 1 ? "dag" : "dager"} siden:`,
      dueToday: "SISTE FRIST — i dag:",
      dueTomorrow: "SISTE FRIST — i morgen:",
      dueIn: (days, dueDate) => `Om ${days} dager (${dueDate}):`,
    },
    candidateRow: (subject, sender, threadId) =>
      `- Mulig frist fra e-post: "${subject}" fra ${sender} — ` +
      `legg til (deadline_add fromThreadId ${threadId}) eller ` +
      `ignorer (deadline_dismiss candidateThreadId ${threadId}) [thread ${threadId}]`,
    moreTail: (hidden) => `- +${hidden} flere frister — se konsollen`,
    blockLabel: "Frister",
    clause: "Frister er institusjonelle forfall; gjengi dem som sin egen liste, aldri blandet inn i svar-listen.",
  },
  deadlineLadder: {
    dueTomorrow: (title, entity, consequence) =>
      `Frist i morgen: ${title} (${entity})${consequence}. ` +
      "Si «ferdig» eller «avvis» når den er håndtert.",
    dueToday: (title, entity, consequence) => `SISTE FRIST i dag: ${title} (${entity})${consequence}.`,
    stopNeverRaised: (title, entity, lateDays) =>
      `«${title}» (${entity}) forfalt ${lateDays} ${lateDays === 1 ? "dag" : "dager"} siden uten at jeg ` +
      "fikk sagt fra. Jeg stopper her — si fra om du vil ha den tilbake.",
    stopWithCount: (title, times) =>
      `Jeg har tatt opp «${title}» ${times} ${times === 1 ? "gang" : "ganger"} og stopper nå. ` +
      "Si fra om du vil ha den tilbake.",
  },
  conflicts: {
    evidenceLabel: "Bevis:",
  },
};

const en: BriefStrings = {
  heldBack: {
    prefix: "Held back since the last brief:",
    count: (n) => (n === 1 ? "1 message" : `${n} messages`),
    onDoor: (doorLabel) => `on ${doorLabel}`,
    suffix: "(ceiling reached or quiet hours).",
  },
  deadlines: {
    dueLabel: {
      overdue: (late) => `Overdue by ${late} ${late === 1 ? "day" : "days"}:`,
      dueToday: "DUE TODAY:",
      dueTomorrow: "DUE TOMORROW:",
      dueIn: (days, dueDate) => `In ${days} days (${dueDate}):`,
    },
    candidateRow: (subject, sender, threadId) =>
      `- Possible deadline from an email: "${subject}" from ${sender} — ` +
      `add it (deadline_add fromThreadId ${threadId}) or ` +
      `ignore it (deadline_dismiss candidateThreadId ${threadId}) [thread ${threadId}]`,
    moreTail: (hidden) => `- +${hidden} more deadlines — see the console`,
    blockLabel: "Deadlines",
    clause: "Deadlines are institutional obligations; render them as their own list, never mixed into the reply list.",
  },
  deadlineLadder: {
    dueTomorrow: (title, entity, consequence) =>
      `Due tomorrow: ${title} (${entity})${consequence}. ` +
      'Say "done" or "dismiss" once it\'s handled.',
    dueToday: (title, entity, consequence) => `FINAL DEADLINE today: ${title} (${entity})${consequence}.`,
    stopNeverRaised: (title, entity, lateDays) =>
      `"${title}" (${entity}) was due ${lateDays} ${lateDays === 1 ? "day" : "days"} ago and I never got ` +
      "the chance to flag it. Stopping here — let me know if you want it back.",
    stopWithCount: (title, times) =>
      `I've raised "${title}" ${times} ${times === 1 ? "time" : "times"} and I'm stopping now. ` +
      "Let me know if you want it back.",
  },
  conflicts: {
    evidenceLabel: "Evidence:",
  },
};

// FIRST-PASS TRANSLATIONS BELOW (sv, da, fi) — not reviewed by a native speaker. Structure and
// register copy `nb`/`en`; the owner's report lists every one of these strings side by side with
// `nb` so they can be checked and corrected before anyone relies on them.

const sv: BriefStrings = {
  heldBack: {
    prefix: "Kvarhållet sedan förra briefen:",
    count: (n) => (n === 1 ? "1 meddelande" : `${n} meddelanden`),
    onDoor: (doorLabel) => `på ${doorLabel}`,
    suffix: "(gräns nådd eller tysta timmar).",
  },
  deadlines: {
    dueLabel: {
      overdue: (late) => `Förfallet för ${late} ${late === 1 ? "dag" : "dagar"} sedan:`,
      dueToday: "SISTA FRISTEN — idag:",
      dueTomorrow: "SISTA FRISTEN — imorgon:",
      dueIn: (days, dueDate) => `Om ${days} dagar (${dueDate}):`,
    },
    candidateRow: (subject, sender, threadId) =>
      `- Möjlig frist från e-post: "${subject}" från ${sender} — ` +
      `lägg till (deadline_add fromThreadId ${threadId}) eller ` +
      `ignorera (deadline_dismiss candidateThreadId ${threadId}) [thread ${threadId}]`,
    moreTail: (hidden) => `- +${hidden} fler frister — se konsolen`,
    blockLabel: "Frister",
    clause: "Frister är institutionella förfall; återge dem som en egen lista, aldrig blandade in i svarslistan.",
  },
  deadlineLadder: {
    dueTomorrow: (title, entity, consequence) =>
      `Frist imorgon: ${title} (${entity})${consequence}. ` +
      'Säg "klar" eller "avvisa" när den är hanterad.',
    dueToday: (title, entity, consequence) => `SISTA FRISTEN idag: ${title} (${entity})${consequence}.`,
    stopNeverRaised: (title, entity, lateDays) =>
      `"${title}" (${entity}) förföll för ${lateDays} ${lateDays === 1 ? "dag" : "dagar"} sedan utan att ` +
      "jag fick sagt till. Jag stannar här — säg till om du vill ha tillbaka den.",
    stopWithCount: (title, times) =>
      `Jag har tagit upp "${title}" ${times} ${times === 1 ? "gång" : "gånger"} och stannar nu. ` +
      "Säg till om du vill ha tillbaka den.",
  },
  conflicts: {
    evidenceLabel: "Bevis:",
  },
};

const da: BriefStrings = {
  heldBack: {
    prefix: "Tilbageholdt siden sidste brief:",
    count: (n) => (n === 1 ? "1 besked" : `${n} beskeder`),
    onDoor: (doorLabel) => `på ${doorLabel}`,
    suffix: "(grænse nået eller stille timer).",
  },
  deadlines: {
    dueLabel: {
      overdue: (late) => `Forfaldet for ${late} ${late === 1 ? "dag" : "dage"} siden:`,
      dueToday: "SIDSTE FRIST — i dag:",
      dueTomorrow: "SIDSTE FRIST — i morgen:",
      dueIn: (days, dueDate) => `Om ${days} dage (${dueDate}):`,
    },
    candidateRow: (subject, sender, threadId) =>
      `- Mulig frist fra e-mail: "${subject}" fra ${sender} — ` +
      `tilføj (deadline_add fromThreadId ${threadId}) eller ` +
      `ignorer (deadline_dismiss candidateThreadId ${threadId}) [thread ${threadId}]`,
    moreTail: (hidden) => `- +${hidden} flere frister — se konsollen`,
    blockLabel: "Frister",
    clause: "Frister er institutionelle forfald; gengiv dem som deres egen liste, aldrig blandet ind i svarlisten.",
  },
  deadlineLadder: {
    dueTomorrow: (title, entity, consequence) =>
      `Frist i morgen: ${title} (${entity})${consequence}. ` +
      'Sig "færdig" eller "afvis" når den er håndteret.',
    dueToday: (title, entity, consequence) => `SIDSTE FRIST i dag: ${title} (${entity})${consequence}.`,
    stopNeverRaised: (title, entity, lateDays) =>
      `"${title}" (${entity}) forfaldt for ${lateDays} ${lateDays === 1 ? "dag" : "dage"} siden uden at ` +
      "jeg fik sagt til. Jeg stopper her — sig til hvis du vil have den tilbage.",
    stopWithCount: (title, times) =>
      `Jeg har taget "${title}" op ${times} ${times === 1 ? "gang" : "gange"} og stopper nu. ` +
      "Sig til hvis du vil have den tilbage.",
  },
  conflicts: {
    evidenceLabel: "Bevis:",
  },
};

const fi: BriefStrings = {
  heldBack: {
    prefix: "Pidätetty edellisen briefin jälkeen:",
    count: (n) => (n === 1 ? "1 viesti" : `${n} viestiä`),
    onDoor: (doorLabel) => `kanavassa ${doorLabel}`,
    suffix: "(raja saavutettu tai hiljaiset tunnit).",
  },
  deadlines: {
    dueLabel: {
      overdue: (late) => `${late} ${late === 1 ? "päivä" : "päivää"} myöhässä:`,
      dueToday: "MÄÄRÄPÄIVÄ — tänään:",
      dueTomorrow: "MÄÄRÄPÄIVÄ — huomenna:",
      dueIn: (days, dueDate) => `${days} päivän kuluttua (${dueDate}):`,
    },
    candidateRow: (subject, sender, threadId) =>
      `- Mahdollinen määräaika sähköpostista: "${subject}" lähettäjältä ${sender} — ` +
      `lisää (deadline_add fromThreadId ${threadId}) tai ` +
      `ohita (deadline_dismiss candidateThreadId ${threadId}) [thread ${threadId}]`,
    moreTail: (hidden) => `- +${hidden} määräaikaa lisää — katso konsolista`,
    blockLabel: "Määräajat",
    clause: "Määräajat ovat institutionaalisia eräpäiviä; esitä ne omana listanaan, älä koskaan sekoita niitä vastauslistaan.",
  },
  deadlineLadder: {
    dueTomorrow: (title, entity, consequence) =>
      `Määräaika huomenna: ${title} (${entity})${consequence}. ` +
      'Sano "valmis" tai "hylkää", kun se on hoidettu.',
    dueToday: (title, entity, consequence) => `VIIMEINEN MÄÄRÄAIKA tänään: ${title} (${entity})${consequence}.`,
    stopNeverRaised: (title, entity, lateDays) =>
      `"${title}" (${entity}) erääntyi ${lateDays} ${lateDays === 1 ? "päivä" : "päivää"} sitten enkä ` +
      "ehtinyt mainita siitä. Lopetan tähän — sano, jos haluat sen takaisin.",
    stopWithCount: (title, times) =>
      `Olen ottanut esiin "${title}"-asian ${times} ${times === 1 ? "kerran" : "kertaa"} ja lopetan nyt. ` +
      "Sano, jos haluat sen takaisin.",
  },
  conflicts: {
    evidenceLabel: "Todiste:",
  },
};

export const BRIEF_STRINGS: Record<BriefLanguage, BriefStrings> = { en, nb, sv, da, fi };
