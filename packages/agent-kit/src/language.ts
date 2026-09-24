// The language switch (agent-definitions spec, Part 3).
//
// PER TURN, not per session and not per save. It is a small addition to the instructions, not a
// rewrite of the system prompt, so it does not cost the prompt cache — which is exactly why the
// spec puts language here and instructions at session start.
//
// THE DEFINITION NEVER CHANGES. "Answer me in English today" must not rewrite a file on the box.
// The choice lives in the session's own state and dies with the session, and the per-turn
// instruction reads the state first and the definition second.
//
// No eve import here on purpose: this module is pure text, so it can be unit-tested without a
// harness. Each service authors the four-line tool that actually writes the state.
export const LANGUAGE_STATE_KEY = "lares.language";

/** The per-turn instruction. Empty when neither source names a language, which is what every
 *  agent did before ORB-278 step 2 — follow the counterpart — and is what keeps the
 *  byte-identical gate green for the three that set none. */
export function languageInstruction(sessionLanguage: string | null, definitionLanguage: string | undefined): string {
  const session = (sessionLanguage ?? "").trim();
  if (session !== "") {
    return `## Language\n\nWrite in ${session} for this conversation. Someone asked for it here; it is not my default and it changes nothing about how I speak elsewhere.`;
  }
  const fallback = (definitionLanguage ?? "").trim();
  if (fallback !== "") {
    return `## Language\n\nWrite in ${fallback} unless someone asks me here for another one.`;
  }
  return "";
}
