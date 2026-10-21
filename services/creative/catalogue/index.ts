// The tool pool. One entry per tool file in this directory.
// Each entry names the capability whose grant decides whether a session gets the tool.
//
// It is a real module and not a glob on purpose: `eve build` bundles what it can see statically,
// and a directory read at runtime would resolve against .output/server/, not this folder.
// `tests/catalogue-index.test.ts` is what keeps it honest — it holds this map against the files
// on disk in both directions, and every capability against `capabilityOfTool`.
//
// WHAT IS NOT HERE: the `agent-kit__*` contributions. The creative agent grants none of `brain`,
// `transit` or `signals`, so every one of the override files under
// agent/extensions/agent-kit/tools/ already resolves to a `disableTool()` sentinel and the
// extension contributes nothing to a session — `readResolvedTools` lists zero of them. There is
// no ungranted tool for a catalogue entry to take over, so the prefixed-key mechanism only
// carries real weight on agents that actually ship kit tools.
import type { Catalogue } from "@lares/agent-kit/catalogue";
import { ALWAYS_PRESENT_CAPABILITY } from "@lares/agent-kit/catalogue";

import set_language from "./set_language.js";
import studio_ideate from "./studio_ideate.js";
import vault_list from "./vault_list.js";
import vault_read from "./vault_read.js";
import vault_search from "./vault_search.js";
import vault_write from "./vault_write.js";

export const CATALOGUE: Catalogue = {
  // Not a capability: has no grant and no capability doc — `capabilityOfTool` returns
  // undefined for it by design. `ALWAYS_PRESENT` short-circuits it before any grant lookup.
  set_language: { capability: ALWAYS_PRESENT_CAPABILITY, tool: set_language },
  studio_ideate: { capability: "studio", tool: studio_ideate },
  // ONE SET OF NOTE TOOLS FOR EVERY AREA. The area is an input,
  // and each tool refuses an area this declaration does not grant — which is the shared one and
  // nothing else. The capability is `vault`, and the grant in agent.json must name it: either
  // half alone would take all four tools away from every session. `vault_write` takes the same
  // required `area` and the same injected authority, and its ratchet row is keyed
  // `(agent, "vault", "shared")` — see `vault_write.ts`'s header.
  vault_list: { capability: "vault", tool: vault_list },
  vault_read: { capability: "vault", tool: vault_read },
  vault_search: { capability: "vault", tool: vault_search },
  vault_write: { capability: "vault", tool: vault_write },
};
