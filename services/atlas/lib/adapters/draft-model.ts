// services/atlas/lib/adapters/draft-model.ts
// The ONE model call in this service, against the LiteLLM gateway every other agent uses.
//
// The model id is a REQUIRED option with no default. Model selection follows the standing
// portfolio policy — resolved from the live gateway config at deploy time, never named from
// memory in code (spec §4.2). A default here would be a name that rots.
//
// Every failure THROWS. A drafting call that returns something plausible on failure is how
// a proposal gets made from nothing; decideNote's caller treats a throw as "skip this note
// this tick", which is the honest outcome.
import type { DraftModel, Draft } from "../narrative.js";
import { SECTIONS } from "../narrative.js";
import type { ResolvedSource } from "../resolve.js";
import { formatSourceRef } from "../sources.js";

export interface GatewayDraftOptions {
  /** The bare gateway host, e.g. https://gateway.example.com — this adapter appends
   *  `/v1/messages` itself below, the gateway's router route where purpose aliases resolve.
   *  Never pass an `/anthropic`-suffixed URL: that pass-through forwards the model id to
   *  Anthropic verbatim and 404s on an alias (ORB-225). */
  url: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}

// The length and register rules are not stylistic preferences. The first live run produced
// ~1000-word sections full of source-auditing asides ("its TL;DR undercounted these as four;
// §4 actually lists seven") and hedges, because rule 5 asked for restraint without defining
// it. This store is loaded into every business agent's context on every turn: prose nobody
// can skim is prose nobody reads, and a 👍-gate over eight walls of text becomes a rubber
// stamp. Hard ceilings, stated as counts, are what the model actually holds to.
const RULES = [
  "You are re-deriving one note in an internal business knowledge store. Write PLAINLY.",
  "",
  "This note is loaded into an agent's context on every turn. It is a BRIEFING, not a report.",
  "Someone should be able to read the whole thing in under a minute and know what this",
  "venture is, who it is for, and where it stands.",
  "",
  "RULES, in order of importance:",
  "1. NEVER GUESS. If a field is genuinely unknown from the sources below, write exactly `—`.",
  "   A confident wrong note is worse than an honest gap. A `[TBD]` in a source stays a gap.",
  "2. Say only what the sources support. Do not carry over a claim from the current note that",
  "   the sources no longer contain — but do not INVENT its replacement either.",
  "3. BUSINESS CONTEXT ONLY. No personal, relationship or network material of any kind.",
  "4. Never write an empty section. If there is nothing to say, the section body is `—`.",
  "5. LENGTH CEILINGS, per section. These are limits, not targets — shorter is better:",
  "     What it is                  — 70 words, at most 2 sentences",
  "     Positioning / wedge         — 70 words",
  "     Target                      — 50 words",
  "     Stage / current state       — 100 words",
  "     Load-bearing strategy calls — at most 5 bullets, 20 words each",
  "     Brand voice                 — 40 words",
  "6. DESCRIBE THE VENTURE, NOT THE DOCUMENTS. Never name a source file, quote a section",
  "   number, or comment on what a source got wrong, omitted or contradicted. The reader",
  "   wants to know what is true, not how you worked it out.",
  "7. NO HEDGING. Banned: 'treat this as', 'with the caveat that', 'as of that date',",
  "   'this reads as', 'per <file>'. State the fact, or write `—`. If two sources disagree,",
  "   state the better-supported one plainly and say nothing about the disagreement.",
  "8. Write the CURRENT state, not a history. No changelogs, no 'was X, now Y', no dated",
  "   narration of what happened in which session.",
].join("\n");

export function makeGatewayDraftModel(opts: GatewayDraftOptions): DraftModel {
  // Model selection is resolved from the live gateway config at deploy time — "which
  // model" must never be a silent question. An empty or missing id would omit the `model`
  // key from the request body entirely, surfacing as an opaque gateway 400 far from this
  // call's actual caller; failing loudly HERE, at construction, names the real mistake.
  if (typeof opts.model !== "string" || opts.model.trim() === "") {
    throw new Error(
      "atlas: makeGatewayDraftModel requires a non-empty model id — none was given. Model " +
      "selection is resolved from the live gateway config at deploy time; a missing one is " +
      "a caller bug, not something to paper over with a default.",
    );
  }
  const doFetch = opts.fetch ?? fetch;

  return {
    async draft(req): Promise<Draft> {
      const sourceBlock = req.sources
        .map((s: ResolvedSource) => `### ${formatSourceRef(s.ref)}\n\n${s.content}`)
        .join("\n\n---\n\n");

      const prompt = [
        RULES,
        "",
        `BRAND: ${req.brand}`,
        "",
        "THE NOTE AS IT STANDS TODAY:",
        "",
        req.currentBody,
        "",
        "ITS CANONICAL SOURCES, as read just now:",
        "",
        sourceBlock,
        "",
        "Return ONLY a JSON object, no prose around it, of the shape:",
        `{"sections": {${SECTIONS.map((s) => `"${s}": "…"`).join(", ")}}}`,
        "Each value is the section's markdown BODY — do not repeat the heading inside it.",
      ].join("\n");

      // `fetch()` itself rejecting — network unreachable, DNS failure, an aborted request —
      // is the realistic failure on a sealed/egress-restricted box, not a hypothetical one:
      // an outbound call that never reaches the gateway looks, to native fetch, like a bare
      // TypeError with no mention of which note or brand it was for.
      let res: Response;
      try {
        res = await doFetch(`${opts.url.replace(/\/$/, "")}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: opts.model,
            max_tokens: 4000,
            messages: [{ role: "user", content: prompt }],
          }),
        });
      } catch (e) {
        throw new Error(
          `atlas: the drafting gateway request for ${req.brand} failed ` +
          `(${e instanceof Error ? e.message : String(e)})`,
        );
      }
      if (!res.ok) {
        throw new Error(`atlas: the drafting gateway returned ${res.status} for ${req.brand}`);
      }

      // The gateway responding 200 is not the same guarantee as it responding with the
      // JSON shape expected — a proxy in front of it can hand back an HTML error page, or
      // an empty body, on a 200, and a `null` JSON literal is valid JSON that is still not
      // an object. Both `res.json()` throwing and `payload` being non-object are branded
      // here, rather than left to surface as a bare SyntaxError or TypeError with no
      // mention of which note or gateway call produced it.
      let payload: { content?: Array<{ type: string; text?: string }> };
      try {
        const parsed: unknown = await res.json();
        if (parsed === null || typeof parsed !== "object") {
          throw new Error(`reply was ${parsed === null ? "null" : typeof parsed}, not an object`);
        }
        payload = parsed as { content?: Array<{ type: string; text?: string }> };
      } catch (e) {
        throw new Error(
          `atlas: the drafting gateway's reply for ${req.brand} was not the JSON shape ` +
          `expected (${e instanceof Error ? e.message : String(e)})`,
        );
      }
      const text = payload.content?.find((c) => c.type === "text")?.text ?? "";
      let parsed: { sections?: Record<string, string> };
      try {
        // Tolerate a fenced block, refuse anything else. Salvaging prose into "sections"
        // would be inventing the note.
        parsed = JSON.parse(text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, ""));
      } catch {
        throw new Error(`atlas: the drafting model did not return JSON for ${req.brand}`);
      }

      const sections = parsed.sections ?? {};
      for (const heading of SECTIONS) {
        if (typeof sections[heading] !== "string") {
          throw new Error(`atlas: the drafting model omitted "${heading}" for ${req.brand}`);
        }
      }
      return { sections };
    },
  };
}
