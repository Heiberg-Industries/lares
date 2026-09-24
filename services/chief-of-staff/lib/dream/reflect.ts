/**
 * Dream-cycle reflector.
 *
 * makeReflector({ llm, agentLabel }).reflect(entries, { since }) → Promise<Observation[]>
 *
 * Takes a batch of TurnLogEntry records (already loaded by the caller),
 * filters to those at >= `since`, prompts the gateway LLM to extract
 * durable signals about the owner (preferences, decisions, taste, facts),
 * and returns them as typed Observation objects.
 *
 * `agentLabel` is the running agent's own label, resolved by the CALLER the same way
 * `agent/schedules/dream.ts` already resolves it (`thisAgent()`'s `display ?? name`) — never a
 * literal name here, so the prompt and the scaffolding filter below both name whichever agent is
 * actually running rather than one installation's persona. Optional, defaulting to "the agent",
 * so a test that only cares about origin handling need not supply one.
 *
 * Short-circuits to [] when the filtered entry list is empty — no LLM call.
 * Gracefully returns [] when the LLM response cannot be parsed.
 *
 * The LLM interface is a plain (prompt: string) => Promise<string> so
 * makeGatewayLlm() is a drop-in and tests can inject a fake.
 */

import { narrowest, type Origin } from "@lares/agent-kit/origin";

import type { TurnLogEntry } from "../turn-capture.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** The valid observation kinds the reflector may extract. */
const VALID_KINDS = ["preference", "decision", "taste", "fact"] as const;
export type ObservationKind = (typeof VALID_KINDS)[number];

/**
 * A durable signal about the owner extracted from conversation logs.
 * Each observation is backed by one or more source turn timestamps.
 */
export interface Observation {
  /** Plain-language statement of what was learned about the owner. */
  text: string;
  /** Category of the observation. */
  kind: ObservationKind;
  /** Short subject label (e.g. "communication style", "vendor policy"). */
  subject: string;
  /** Confidence score 0–1. The LLM assigns; downstream may threshold. */
  confidence: number;
  /** ISO timestamps (`entry.at`) of source turns backing this observation. */
  evidenceRefs: string[];
  /**
   * Which class of turn this observation was drawn from — computed by CODE from the entries it
   * cites (`originForObservation` below), never by the model, which is not asked for it and
   * could not be trusted with it.
   *
   * It is the LEAST trusted class among the cited turns (the origin spec's narrowest-origin
   * rule), and `third_party` in all three fail-closed directions: an evidence ref naming a turn
   * that is not in the batch, a cited turn that carries no class at all (a legacy markdown
   * entry), and an observation that cites nothing.
   */
  origin: Origin;
}

/**
 * The class an observation inherits from the turns it cites — ADR-0018 rule 4's input, and the
 * origin spec's narrowest-origin rule applied to consolidation.
 *
 * Pure, and exported so the test and the promoter can both assert on it without a model. The
 * model may say WHICH turns it drew on; it can never say what they were worth.
 */
export function originForObservation(
  evidenceRefs: readonly string[],
  entries: readonly TurnLogEntry[],
): Origin {
  // Citing nothing verifiable is the same as citing somebody else: there is nothing here that
  // can be traced back to the owner speaking.
  if (evidenceRefs.length === 0) return "third_party";

  const byAt = new Map<string, Origin>();
  for (const e of entries) {
    // An entry with no origin is a legacy markdown turn, which never carried one — unknown is
    // not a licence to trust. Two entries sharing one timestamp collapse to the narrower of
    // the two, so an ambiguous reference can never pick the more trusted of them.
    const here: Origin = e.origin ?? "third_party";
    const already = byAt.get(e.at);
    byAt.set(e.at, already ? narrowest([already, here]) : here);
  }

  return narrowest(evidenceRefs.map((ref) => byAt.get(ref) ?? "third_party"));
}

/** Same shape as BriefLlm / DigestLlm — injectable, offline-testable. */
export type ReflectorLlm = (prompt: string) => Promise<string>;

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Patterns that identify scaffolding observations — statements about the running agent's own
 * mechanics, tooling, or design rather than durable facts about the owner.
 *
 * Each entry documents what it catches and why it's safe to drop.
 * Be CONSERVATIVE: only drop observations that are clearly self-referential.
 * Tune this list as false-positives or false-negatives are found.
 *
 * Two further patterns — matching the agent as the ACTOR in a sentence — need the running
 * agent's own label to mean anything and are built fresh per call by `agentScaffoldingPatterns`
 * below, rather than living in this fixed list.
 */
export const SCAFFOLDING_PATTERNS: Array<{
  /** Human-readable label for logging / debugging. */
  label: string;
  /** Compiled regular expression applied to lowercased `text + " " + subject`. */
  pattern: RegExp;
}> = [
  {
    // Catches "the owner uses 👍 to confirm", "👍 is the approval signal", etc.
    label: "thumbs-emoji",
    pattern: /👍|thumbs[\s-]?up/u,
  },
  {
    // Catches "the approval step", "confirmation signal", "approval mechanic", etc.
    label: "approval-confirmation-mechanic",
    pattern: /\b(approval|confirmation)\s+(step|signal|system|mechanic|flow)\b/,
  },
  {
    // Catches "the agent proposes then waits for the owner to confirm/approve".
    // Uses .{0,100} (bounded) instead of .* to prevent spanning across joined text+subject.
    label: "propose-then-confirm-flow",
    pattern: /\bproposes?\b.{0,100}\b(confirm|approv)/,
  },
  {
    // Catches "the Brain vault", "the Brain knowledge base", "files stored in the Brain",
    // "saved into the Brain", etc. — the Brain as the agent's storage plumbing.
    // Does NOT catch "second-brain theme" (topical interest, not the storage mechanic).
    // Uses \b word-boundary after verb stems to prevent false matches on "folder", "storefront", etc.
    label: "brain-as-system-store",
    pattern:
      /\b(fold|file|store|save|keep)\b\s+(in|into)\s+(the\s+)?brain\b|\bbrain\b.*\b(vault|knowledge base|store of record|source of record)\b/,
  },
];

/** Escapes a string for safe interpolation into a `RegExp` source — the running agent's label
 *  is owner-chosen text, not a pattern fragment, and must never be treated as one. */
function escapeForPattern(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The two scaffolding patterns that only mean something once you know which agent is running —
 * they catch the agent named as the ACTOR in a sentence ("<agent> sends a morning brief"). Built
 * fresh from whatever label the caller passes (never a fixed installation's name), so they fire
 * correctly whichever agent this reflector is running for.
 */
function agentScaffoldingPatterns(agentLabel: string): Array<{ label: string; pattern: RegExp }> {
  const name = escapeForPattern(agentLabel.toLowerCase());
  return [
    {
      // Catches observations where the agent is the ACTOR performing an agent mechanic —
      // e.g. "<agent> sends a morning brief", "<agent> proposes and files the note".
      // Does NOT fire on "the owner decided to build <agent>" (the agent as object/topic, not
      // actor).
      label: "agent-as-subject",
      pattern: new RegExp(
        `\\b${name}\\b.{0,60}\\b(send|sends|propose|proposes|confirm|confirms|file|files|store|stores|deliver|delivers|remind|reminds|surfaces?)\\b`,
      ),
    },
    {
      // Catches "<agent>'s morning brief", "receives a morning brief from <agent>",
      // "the digest is sent by the agent", etc. — own-feature descriptions.
      // Requires the running agent's own label to be present OR restricts to specific feature
      // terms (morning brief/digest/radar) to avoid dropping legitimate uses of bare "reminder"
      // (e.g. "the owner ignores vendor reminder emails").
      label: "agent-feature-as-mechanic",
      pattern: new RegExp(
        "\\b(morning brief|digest|radar)\\b.*\\b(sends?|sent|receives?|received|gets?|got|delivers?|delivered)\\b|" +
          "\\b(sends?|sent|receives?|received|gets?|got|delivers?|delivered)\\b.*\\b(morning brief|digest|radar)\\b|" +
          `\\b${name}\\b.*\\breminder\\b|\\breminder\\b.*\\b${name}\\b`,
      ),
    },
  ];
}

/**
 * Returns true when an observation text+subject pair matches any scaffolding
 * pattern (i.e. the observation is about the agent's own mechanics, not the owner).
 */
function isScaffolding(text: string, subject: string, agentLabel: string): boolean {
  const haystack = `${text} ${subject}`.toLowerCase();
  return [...SCAFFOLDING_PATTERNS, ...agentScaffoldingPatterns(agentLabel)].some(({ pattern }) =>
    pattern.test(haystack),
  );
}

/**
 * ADR-0018 rule 5's "do not learn" list — a second, narrower filter beside
 * `SCAFFOLDING_PATTERNS` above, and not a replacement for it. Where scaffolding drops
 * statements about the agent's own mechanics, this list drops statements that are true in the
 * moment but were never meant to outlive it: an environment or tool hiccup, a one-off request,
 * a failure nobody resolved, or a claim that a tool is broken. Report 09 (Hermes Agent) is the
 * reason these matter more than they look: such statements "harden into refusals the agent
 * cites against itself for months after the actual problem was fixed."
 *
 * Deliberately narrow — this is the code half of a rule the prompt states in full (see
 * `buildPrompt` below), and a false positive here silently costs a real preference. Each entry
 * names the class it exists for and quotes why, so the list can grow by adding a tested entry,
 * not by editing an existing one.
 */
export const DO_NOT_LEARN_PATTERNS: Array<{ label: string; pattern: RegExp; why: string }> = [
  {
    label: "environment-failure",
    pattern:
      /\b(timed out|timeout|rate.?limit|5\d\d|outage|unreachable|expired|reconnect|credential|token|utløpt|tidsavbrudd)\b/,
    why:
      "A timeout, an outage, an expired token or a rate limit is the environment breaking, not " +
      "something durable about the owner — yesterday's outage says nothing about tomorrow.",
  },
  {
    label: "one-off-task",
    pattern: /\b(asked (me )?to|please |move the|reschedul|send (this|that)|book the)\b/,
    why:
      "A one-off request ('move the 14:00', 'send this') is a task, not a standing preference — " +
      "recording every ask as a rule would make the agent rigid about things asked only once.",
  },
  {
    label: "unresolved-failure",
    pattern: /\b(failed|never (went|sent|worked)|still (not|isn't)|could not)\b/,
    why:
      "A failure nobody resolved is not yet a fact about anything; recording it risks the agent " +
      "treating an open incident as settled history.",
  },
  {
    label: "negative-claim-about-a-tool",
    pattern:
      /\b(is|isn'?t|does ?n'?t|does not|won'?t|cannot|can'?t)\b.{0,20}\b(broken|work|working|available|respond)\b|fungerer ikke|virker ikke/,
    why:
      "\"X is broken\" or \"X doesn't work\" hardens into a refusal the agent cites against " +
      "itself for months after the actual problem was fixed (report 09, Hermes Agent).",
  },
];

/** True when an observation falls in one of the four do-not-learn classes. The prompt above asks
 *  the model not to produce these at all; this is the code-level check for when it does anyway.
 *  Passed to the promotion gate (`agent/schedules/dream.ts`'s `doNotLearn`, wired into
 *  `makePromoter`) rather than applied here in the reflector, so a match is RECORDED with its
 *  rejection reason instead of vanishing before anything ever sees it (ADR-0018 rule 6 — nothing
 *  is silently dropped). Same haystack shape `isScaffolding` uses above. */
export function isDoNotLearn(text: string, subject: string): boolean {
  const haystack = `${text} ${subject}`.toLowerCase();
  return DO_NOT_LEARN_PATTERNS.some(({ pattern }) => pattern.test(haystack));
}

/** Who produced the input line, for the prompt below. Inlined here (rather than imported) since
 *  `lib/conversation-log.ts`, which used to export this, was retired by W3B-s8. W4C-s1 rewrote
 *  this line and the turn rendering below, so both come back role-neutral; W4C-s3 rewrote the
 *  instruction prose further down the same way, using `agentLabel` and "the owner" in place of
 *  one installation's persona and owner names. */
function speakerLabel(e: Pick<TurnLogEntry, "lane">): string {
  return e.lane ? `${e.lane} (scheduled)` : "the owner";
}

/** The label a turn whose content came from outside carries in the prompt. The CODE half of this
 *  rule is `originForObservation`; this is only the half the model can see, and it is not what
 *  decides anything. */
const QUOTED_MARKER = "[quoted from someone else]";

function buildPrompt(entries: TurnLogEntry[], agentLabel: string): string {
  // Attribute each input to whoever actually produced it: the owner on a door turn, the
  // lane on a scheduled turn. Labelling a machine nudge as the owner would invite the
  // reflector to record a preference they never expressed.
  //
  // A turn whose content was read from outside — an email, a web page, a synced document — is
  // marked as such, so the model is not asked to tell an owner's words from a supplier's by
  // reading them.
  const turns = entries
    .map((e) => {
      const quoted = e.origin === "third_party" || e.origin === "synced" ? ` ${QUOTED_MARKER}` : "";
      return `[${e.at}] ${speakerLabel(e)}${quoted}: ${e.input}\nthe agent: ${e.reply}`;
    })
    .join("\n\n");

  return [
    `You analyse conversation logs between the owner (a solo founder) and ${agentLabel}, their`,
    "Chief-of-Staff agent.",
    "Extract ONLY durable signals about the owner — their preferences, decisions, taste, or facts",
    "about how they work. Ignore ephemera (e.g. 'send this message', one-off tasks, chit-chat).",
    "Do NOT capture personal data about third parties.",
    // The marker is named here WITHOUT its square brackets on purpose: the first bracketed
    // occurrence in the prompt must be the one attached to the turn it describes, which is what
    // tests/dream-observation-origin.test.ts pins.
    "A turn marked `quoted from someone else` is an email, a web page or a synced document —",
    "not the owner speaking. You may use it to understand what happened; never record something",
    "learned about the owner from one.",
    "",
    `IMPORTANT — do NOT extract observations about ${agentLabel}'s own mechanics or this system's`,
    "design. Specifically exclude anything about:",
    "  - the owner using 👍 / reactions / thumbs-up to approve or confirm actions",
    "  - A 'Brain', vault, or knowledge base where information is stored",
    `  - ${agentLabel} proposing actions and waiting for confirmation before proceeding`,
    `  - ${agentLabel}'s own tools, hands, reminders, digest, radar, or morning brief`,
    `  - ${agentLabel}'s persona or how ${agentLabel} operates`,
    "Learn only durable signals about the owner — their taste, decisions, and how they work —",
    "not how the agent operates.",
    "",
    "ALSO do NOT extract: a one-off task or request ('move the 14:00', 'send this'); a passing",
    "environment or tool failure (an outage, an expired credential, a timeout); a failure that",
    "was never resolved; or a claim that a tool is broken or unavailable. None of these are",
    "durable facts about the owner, and treating them as such would harden a problem that has",
    "since been fixed into a standing belief.",
    "",
    "For each durable signal, return a JSON object with:",
    '  "text"         — plain-language statement of what was learned about the owner',
    '  "kind"         — one of: "preference", "decision", "taste", "fact"',
    '  "subject"      — short label for the topic area (e.g. "communication style")',
    '  "confidence"   — number 0–1 reflecting how clearly the log supports this',
    '  "evidenceRefs" — array of ISO turn timestamps the observation is drawn from',
    "",
    "Return a JSON array (may be empty []). No prose outside the array.",
    "If no durable signals are present, return [].",
    "",
    "--- CONVERSATION TURNS ---",
    turns,
    "--- END TURNS ---",
    "",
    "Respond with ONLY a JSON array:",
  ].join("\n");
}

/**
 * Extract the first JSON array from a raw LLM response.
 * Handles both bare arrays and arrays wrapped in ```json fences or prose.
 * Returns null when no parseable array is found.
 */
function extractArray(raw: string): unknown[] | null {
  // Try to grab the first [...] block (possibly multi-line)
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isValidKind(kind: unknown): kind is ObservationKind {
  return VALID_KINDS.includes(kind as ObservationKind);
}

/**
 * The model's half of an observation, and only that half. The return type omits `origin`
 * deliberately: every field here is read off the model's JSON, so an `origin` key it invented
 * has nowhere to land. `reflect` sets the real one afterwards from the entries the item cites.
 */
function toObservation(raw: unknown): Omit<Observation, "origin"> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const text = typeof r.text === "string" ? r.text.trim() : "";
  const subject = typeof r.subject === "string" ? r.subject.trim() : "";
  const kind = r.kind;
  const confidence = typeof r.confidence === "number" ? r.confidence : 0;
  const evidenceRefs = Array.isArray(r.evidenceRefs)
    ? r.evidenceRefs.filter((x): x is string => typeof x === "string")
    : [];

  if (!text || !isValidKind(kind)) return null;

  return { text, kind, subject, confidence, evidenceRefs };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function makeReflector(deps: { llm: ReflectorLlm; agentLabel?: string }) {
  const { llm } = deps;
  // Never a hard-coded persona name — resolved by the caller (`agent/schedules/dream.ts`) the
  // same way it already resolves `agentLabel` for the log reader. The fallback exists only so a
  // test exercising origin handling, not wording, does not have to supply one.
  const agentLabel = deps.agentLabel ?? "the agent";

  return {
    async reflect(
      entries: TurnLogEntry[],
      opts: { since: string },
    ): Promise<Observation[]> {
      // Filter to entries at or after the cursor
      const filtered = entries.filter((e) => e.at >= opts.since);

      // Short-circuit: nothing to analyse
      if (filtered.length === 0) return [];

      const prompt = buildPrompt(filtered, agentLabel);
      const raw = await llm(prompt);

      const items = extractArray(raw);
      if (!items) return [];

      return items.flatMap((item) => {
        const draft = toObservation(item);
        if (!draft) return [];
        // Drop any observation that describes the agent's own mechanics rather than
        // durable facts about the owner. This is a deterministic backstop that
        // catches what the prompt instruction may miss.
        //
        // The do-not-learn list (ADR-0018 rule 5, `isDoNotLearn` above) is deliberately NOT
        // applied here. Scaffolding is dropped at this stage because a scaffolding observation
        // is never worth recording at all — it is about this system, not the owner. A
        // do-not-learn observation is different: ADR-0018 rule 6 requires that "nothing is
        // silently dropped" — a run that rejected something must be able to say what and why.
        // So `isDoNotLearn` is applied at the PROMOTION gate instead (`agent/schedules/dream.ts`
        // wires it into `makePromoter`), which records every observation it sees before
        // deciding, then reports the rejection with its reason. The prompt above already asks
        // the model not to produce these in the first place; this is the code-level backstop
        // for when it does anyway.
        if (isScaffolding(draft.text, draft.subject, agentLabel)) return [];
        // The class is computed here, from the batch the model was actually shown — so a
        // reference to a turn outside it is a reference to nothing, and fails closed.
        const obs: Observation = {
          ...draft,
          origin: originForObservation(draft.evidenceRefs, filtered),
        };
        return [obs];
      });
    },
  };
}
