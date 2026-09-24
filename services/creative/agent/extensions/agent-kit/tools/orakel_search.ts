// ORB-144: this @lares/agent-kit contribution is resolved against THIS agent's own
// agent.json, not hard-coded. `resolveExtensionTool` removes the tool when "orakel" is
// ungranted, scoped `none`, or set to autonomy `never`; strips its approval gate when
// "orakel" is `autonomous`; and otherwise hands it back untouched.
//
// This file is BYTE-IDENTICAL in every eve agent in this repo (eve-saga, eve-marcel,
// eve-calliope) — `diff -r` across their agent/extensions/agent-kit/tools directories is
// empty, and that emptiness is the point.
// Saga grants "orakel", so there this resolves to the live tool the kit contributes, byte for
// byte; Marcel grants no "orakel", so there the same code is a disableTool() sentinel and
// `agent-kit__orakel_search` never reaches him.
// To give an agent a capability you add a grant; you do not write or delete code. A grant is
// not a deploy, though — see ../extension.ts for the env, volume and secret each capability
// still needs before its tools can do anything at call time.
import { orakel_search } from "@lares/agent-kit/tools";
import { resolveExtensionTool } from "@lares/agent-kit/manifest";

import manifest from "../../../../agent.json";

export default resolveExtensionTool(manifest, "orakel", orakel_search);
