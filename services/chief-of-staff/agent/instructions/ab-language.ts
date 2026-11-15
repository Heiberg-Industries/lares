// The language switch, once per turn (see ADR-0015).
//
// PER TURN: a switch asked for mid-thread must hold from the NEXT message, and an eve session is
// a whole chat-day on Slack and Telegram. This is the opposite of the persona's rule,
// deliberately — see aa-definition.ts: the persona is the cached system prompt, the language
// line is a small addition after it.
//
// WHERE THE TEXT GOES. eve 1.0 has one ordering for this directory, the filename, and no
// separate "per turn" group that lands after the per-conversation one (0.60.1 had both). A
// per-turn block emitted from here would sit between the persona and the connections, inside the
// part of the system prompt the prompt cache keys on. So this file only BUILDS the line:
// `zz-cache-boundary.ts`, the last file in the directory, emits it after the cache marker, where
// it always was. The default export contributes nothing, on purpose.
//
// `defineState`, not `ctx.session.state`: see set_language.ts's header. Keyed by NAME, so this
// resolver's handle and the tool's handle read and write the same durable slot even though eve
// compiles them into separate bundles.
//
// Never throws for an ordinary conversation: a failed resolver fails its turn, and there is
// nothing here worth a lost turn.
import { defineState } from "eve/context";
import { defineDynamic } from "eve/instructions";

import { LANGUAGE_STATE_KEY, languageInstruction } from "@lares/agent-kit/language";

import { thisAgent } from "../../lib/definition.js";

const language = defineState<string | null>(LANGUAGE_STATE_KEY, () => null);

/** The language line for this turn; "" when there is none. Called by `zz-cache-boundary.ts`. */
export async function languageBlock(sessionId: string, privateSession: boolean): Promise<string> {
  if (privateSession) return languageInstruction(language.get(), undefined);
  try {
    const { loaded } = await thisAgent(sessionId);
    return languageInstruction(language.get(), loaded.definition.language);
  } catch (err) {
    console.error("language resolver failed — this turn has no language instruction", err);
    return "";
  }
}

export default defineDynamic(() => null);
