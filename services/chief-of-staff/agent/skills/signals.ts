// An INSTRUCTION skill: text the model pulls into a conversation with the framework's own loader
// (`eve__skill`, eve 1.0). That loader loads any skill the conversation has and nothing authored
// can stand in front of it, so this file decides whether the skill EXISTS here. Returning `null`
// means it is absent: not listed, not searchable, not loadable.
//
// The function runs before every model call. Two things are decided, in this order:
//
//  1. Is this a private console conversation? Verified again on every run, never kept. A
//     conversation that claims to be private and cannot prove it makes the call below throw,
//     which fails the turn before any model call: nothing is offered to an unverified caller.
//  2. Does the agent's definition allow this skill? Read once per conversation (`ctx.memo`) from
//     the same loaded definition the tool list comes from, and checked by the kit
//     (`instructionSkillOffered`, @lares/agent-kit/manifest), which answers "no" on every path
//     that is not a plain "yes", including a definition that cannot be read or does not validate.
//
// THIS SKILL is the method for the `signals` code skill. It exists only where the definition
// declares that skill and grants the signal feed, and never in a private console conversation.
import { defineDynamic, defineSkill } from "eve/skills";
import { manifestViewOf } from "@lares/agent-kit/definition";
import { instructionSkillOffered } from "@lares/agent-kit/manifest";
import { verifyPrivateConsoleSession } from "@lares/agent-kit/private-console-surface";

import { thisAgent } from "../../lib/definition.js";

const description = "Read the operational signal spine when asked what is alerting, what broke, or what the spine saw about something.";

const content = "# Signals\n\nCall `agent-kit__signals_recent` first whenever the owner asks whether anything is alerting,\nwhat broke, or what the spine saw about a project or event. Never answer all-clear from memory.\n\nAnswer from the returned cards in their compact shape: `severity \u00b7 [project] title \u00b7 when \u00b7\nissue reference`, adding the count when it is greater than one and saying when a signal recovered.\nAn empty `cards` list is a real empty answer. If the result has `unavailable`, say plainly that\nthe spine could not be read; never turn unavailable into \u201cnothing is alerting\u201d.\n";

export default defineDynamic(async (ctx) => {
  const privateConsole = await verifyPrivateConsoleSession(ctx);
  const offered = await instructionSkillOffered("signals", {
    privateConsole,
    memo: (key, fn) => ctx.memo(key, fn),
    definition: async () => manifestViewOf((await thisAgent(ctx.session?.id)).loaded.definition),
  });
  return offered ? defineSkill({ description, content }) : null;
});
