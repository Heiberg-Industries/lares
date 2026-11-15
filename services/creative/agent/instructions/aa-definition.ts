// The assembled persona, resolved ONCE PER CONVERSATION (see ADR-0015).
//
// `aa-` because eve places this directory's entries in filename order
// (node_modules/eve/docs/instructions.mdx). The persona must come first, ahead of the
// connections and the standing facts, exactly where the static root file used to put it.
//
// WHY THE STATIC FILE MOVED. eve reads a root `agent/instructions.md` AND `agent/instructions/`
// TOGETHER, root content first and then the sorted directory entries. Leaving the persona at
// `agent/instructions.md` would therefore have injected it TWICE. It now lives at
// `agent/persona.md`, which eve does not read at all: it stays on disk purely as the artefact
// `assemble:check` compares against, and this resolver is the only thing that reaches the model.
//
// ONCE PER CONVERSATION, NOT PER CALL. eve 1.0 runs this function before every model call. The
// system prompt is what the prompt cache keys on; rebuilding it would re-bill the whole
// conversation on every message, and a past retry-loop spend leak is why that is a rule and not
// a tuning choice. The assembled text is therefore kept in a memo keyed on the session: eve
// returns the saved text on every later call, in any process. A new image discards memos, so a
// running conversation is re-assembled once after an upgrade.
import { verifyPrivateConsoleSession, privateRoleInstructions, markPrivateConsoleSurface } from "@lares/agent-kit/private-console-surface";
import { readFileSync } from "node:fs";

import { defineDynamic, defineInstructions } from "eve/instructions";

import { outsideToolsInEffect } from "@lares/agent-kit/outside-tools";
import { assemblePersona, deployedToolsFor } from "@lares/agent-kit/persona";

import { roleMdPath, thisAgent } from "../../lib/definition.js";

export default defineDynamic(async (ctx) => {
  // Whether this is a private console conversation is decided once per turn; an unauthorized
  // one throws, and the turn fails with no persona rather than with the wrong one.
  if (await ctx.memo(["private-console", ctx.turn?.id ?? null], () => verifyPrivateConsoleSession(ctx))) {
    markPrivateConsoleSurface();
    return defineInstructions({ content: privateRoleInstructions("creative") });
  }
  // The session id is what pins ONE read of the definition for this whole conversation — the
  // persona, the model, the approval fallback and the tools all resolve from it (lib/definition.ts).
  const content = await ctx.memo(["persona", ctx.session.id], async () => {
    const { loaded } = await thisAgent(ctx.session.id);
    // See lib/definition.ts: cwd is the app root at runtime and under vitest; import.meta.url
    // is not, because eve inlines this module into .output/server/index.mjs.
    const serviceDir = process.cwd();
    return assemblePersona({
      manifest: loaded.definition,
      roleMd: readFileSync(roleMdPath(serviceDir), "utf8"),
      voiceMd: loaded.voiceMd,
      dutiesMd: loaded.dutiesMd,
      displayName: loaded.definition.display ?? loaded.definition.name,
      deployedTools: deployedToolsFor(serviceDir),
      // The owner's words about each outside tool; eve shows the model only a bare name.
      // Part of the conversation's persona, so the prompt cache stays stable.
      outsideTools: outsideToolsInEffect(loaded.definition),
    });
  });
  return defineInstructions({ content });
});
