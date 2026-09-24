// The tool pool. GENERATED — regenerate with the snippet in the ORB-278 step 2 plan, Task 7.
// Each entry names the capability whose grant decides whether a session gets the tool.
//
// It is a real module and not a glob on purpose: `eve build` bundles what it can see statically,
// and a directory read at runtime would resolve against .output/server/, not this folder.
// `tests/catalogue-index.test.ts` is what keeps it honest — it holds this map against the files
// on disk in both directions, and every capability against `capabilityOfTool`.
//
// WHAT IS NOT HERE: the thirteen `agent-kit__*` contributions. Calliope grants none of `brain`,
// `orakel`, `transit`, `markets` or `signals`, so every one of her override files under
// agent/extensions/agent-kit/tools/ already resolves to a `disableTool()` sentinel and the
// extension contributes nothing to her session — `readResolvedTools` lists zero of them. There is
// no ungranted tool for a catalogue entry to take over, so the prefixed-key mechanism (Task 1's
// Q3) first carries real weight in Tasks 8 and 9, on the two agents that actually ship kit tools.
import type { Catalogue } from "@lares/agent-kit/catalogue";
import { ALWAYS_PRESENT_CAPABILITY } from "@lares/agent-kit/catalogue";

import set_language from "./set_language.js";
import studio_ideate from "./studio_ideate.js";
import vault_list from "./vault_list.js";
import vault_read from "./vault_read.js";
import vault_search from "./vault_search.js";
import vault_write from "./vault_write.js";

export const CATALOGUE: Catalogue = {
  // Ruling R2: not a capability, has no grant and no capability doc — `capabilityOfTool` returns
  // undefined for it by design. `ALWAYS_PRESENT` short-circuits it before any grant lookup.
  set_language: { capability: ALWAYS_PRESENT_CAPABILITY, tool: set_language },
  studio_ideate: { capability: "studio", tool: studio_ideate },
  // ONE SET OF NOTE TOOLS FOR EVERY AREA (W5C-s3). These three replace `atlas_list`,
  // `atlas_read` and `atlas_search`: the area is an input now, and each refuses an area this
  // declaration does not grant — which is the shared one and nothing else. W5C-s6 moved the
  // capability from `atlas` to `vault` in the same commit that rewrote the grant, because either
  // half alone would have taken all four tools away from every session.
  //
  // W5C-s4 renamed `atlas_write` to `vault_write` and gave it the same required `area` and the
  // same injected authority; W5C-s5 moved its ratchet row from `(agent, "atlas", "")` to
  // `(agent, "vault", "")` — see `vault_write.ts`'s header.
  vault_list: { capability: "vault", tool: vault_list },
  vault_read: { capability: "vault", tool: vault_read },
  vault_search: { capability: "vault", tool: vault_search },
  vault_write: { capability: "vault", tool: vault_write },
};
