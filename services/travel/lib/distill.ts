// lib/distill.ts — the one-shot model call, in one place.
//
// `agent/schedules/dream.ts` and `agent/schedules/taste-promote.ts` each grew their own private
// copy of this three-line function (same model, same shape, same `maxOutputTokens: 1500`), which
// was fine while there were two. ORB-96 would have made it three, so the third one lives here
// instead. The existing two are deliberately left alone — converging them is a refactor of
// working, tested schedules, not part of this ticket.
//
// This is NOT the conversational path: it is the "ask the brain model one question, get text
// back" seam that background work uses. Every caller injects it as a dependency (`distill`) so
// tests never touch the gateway and the billed call stays visible at the call site.
import { generateText } from "ai";

import { gatewayModel } from "./gateway-provider.js";

function brainModelId(): string {
  const id = process.env["MARCEL_MODEL_BRAIN"];
  if (!id) throw new Error("distill: MARCEL_MODEL_BRAIN is not set");
  return id;
}

/** One call, capped output. Same shape as dream.ts's own `distill` (which mirrors old Marcel's
 *  `makeDistill`): plain prompt, no system message, no temperature override. */
export async function distillBrain(prompt: string, maxOutputTokens = 1500): Promise<string> {
  const result = await generateText({ model: gatewayModel(brainModelId()), prompt, maxOutputTokens });
  return result.text;
}
