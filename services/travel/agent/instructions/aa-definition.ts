// The assembled persona, resolved at SESSION START (agent-definitions spec, Part 3).
//
// `aa-` because eve reads this directory's entries in filename order
// (node_modules/eve/docs/instructions.mdx). The persona must come before the clock and the
// standing facts, exactly where the static root file used to put it.
//
// WHY THE STATIC FILE MOVED. eve reads a root `agent/instructions.md` AND `agent/instructions/`
// TOGETHER — root content first, then the sorted directory entries — and the compiled manifest
// proves it: `instructions.markdown` (the whole root file) and `dynamicInstructions` (this
// directory) are separate, co-existing fields, and eve's own `resolveAgent` keeps both. Leaving
// the persona at `agent/instructions.md` would therefore have injected it TWICE. It now lives at
// `agent/persona.md`, which eve does not read at all: it stays on disk purely as the artefact
// `assemble:check` compares against, and this resolver is the only thing that reaches the model.
//
// `session.started`, NOT `turn.started`. The system prompt is what the prompt cache keys on;
// rebuilding it every turn would re-bill the whole conversation on every message. The $250
// retry-loop incident (2026-08-14/15) is why this is a rule and not a tuning choice.
import { readFileSync } from "node:fs";

import { defineDynamic, defineInstructions } from "eve/instructions";

import { assemblePersona, deployedToolsFor } from "@lares/agent-kit/persona";

import { roleMdPath, thisAgent } from "../../lib/definition.js";

/** Only the field this resolver needs off eve's `DynamicResolveContext`. */
interface ResolveCtx { readonly session?: { readonly id?: string } }

export default defineDynamic({
  events: {
    // The session id is what pins ONE read of the definition for this whole conversation — the
    // persona, the model, the approval fallback and the tools all resolve from it (lib/definition.ts).
    // Optional-chained deliberately: eve always supplies the context, and if it ever did not,
    // falling back to the process-lifetime pin is far better than throwing, which would leave the
    // agent with no persona at all.
    "session.started": async (_event: unknown, ctx?: ResolveCtx) => {
      const { loaded } = await thisAgent(ctx?.session?.id);
      // See lib/definition.ts: cwd is the app root at runtime and under vitest; import.meta.url
      // is not, because eve inlines this module into .output/server/index.mjs.
      const serviceDir = process.cwd();
      return defineInstructions({
        markdown: assemblePersona({
          manifest: loaded.definition,
          roleMd: readFileSync(roleMdPath(serviceDir), "utf8"),
          voiceMd: loaded.voiceMd,
          dutiesMd: loaded.dutiesMd,
          displayName: loaded.definition.display ?? loaded.definition.name,
          deployedTools: deployedToolsFor(serviceDir),
        }),
      });
    },
  },
});
