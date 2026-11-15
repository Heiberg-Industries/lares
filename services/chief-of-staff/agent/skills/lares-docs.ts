// An INSTRUCTION skill: text the model pulls into a conversation with the framework's own loader
// (`eve__skill`, eve 1.0). That loader loads any skill the conversation has and nothing authored
// can stand in front of it, so this file decides whether the skill EXISTS here. Returning `null`
// means it is absent: not listed, not searchable, not loadable.
//
// THIS SKILL NEEDS NO GRANT, and it is the only one a private console conversation gets. Its
// text is an index of the public, reviewed documentation fixed into the release, and the one tool
// it names reads only those baked pages by a listed id. Nothing here belongs to an installation,
// so the decision (`instructionSkillOffered`, with the rule in INSTRUCTION_SKILLS,
// @lares/agent-kit/skill-grants) does not depend on the agent's definition and does not read it.
//
// The function runs before every model call, and verifies the private console claim again each
// time. A conversation that claims to be private and cannot prove it makes that call throw, which
// fails the turn before any model call: nothing is offered to an unverified caller.
import { defineDynamic, defineSkill } from "eve/skills";
import { manifestViewOf } from "@lares/agent-kit/definition";
import { instructionSkillOffered } from "@lares/agent-kit/manifest";
import { publicDocsIndex } from "@lares/agent-kit/public-docs-runtime";
import { verifyPrivateConsoleSession } from "@lares/agent-kit/private-console-surface";

import { thisAgent } from "../../lib/definition.js";

const description = "Use when asked about Lares installation, product setup, the console, or the reviewed public help pages.";

const content = `# Public Lares documentation

Use this only for public Lares product, installation, and console guidance. The pages are fixed to the reviewed release corpus; they do not describe a particular installation or reveal private state.

To answer from a page, call the lares_read_public_doc tool with exactly one listed ID. Do not guess IDs or URLs. If the baked page cannot be verified or read, say that the public guidance is unavailable and answer only from information already provided.

${publicDocsIndex()}
`;

export default defineDynamic(async (ctx) => {
  const privateConsole = await verifyPrivateConsoleSession(ctx);
  const offered = await instructionSkillOffered("lares-docs", {
    privateConsole,
    memo: (key, fn) => ctx.memo(key, fn),
    // Not called while this skill needs nothing from the definition; given so that a rule which
    // one day does need it reads the same loaded definition every other skill reads.
    definition: async () => manifestViewOf((await thisAgent(ctx.session?.id)).loaded.definition),
  });
  return offered ? defineSkill({ description, content }) : null;
});
