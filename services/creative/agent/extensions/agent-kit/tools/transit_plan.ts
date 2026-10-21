// : this @lares/agent-kit contribution is resolved against THIS agent's own
// agent.json, not hard-coded. `resolveExtensionTool` removes the tool when "transit" is
// ungranted, scoped `none`, or set to autonomy `never`; strips its approval gate when
// "transit" is `autonomous`; and otherwise hands it back untouched.
//
// This file is BYTE-IDENTICAL in every eve agent in this repo (chief-of-staff,
// creative agent) — `diff -r` across their agent/extensions/agent-kit/tools directories is
// empty, and that emptiness is the point.
// An agent that grants "transit" at scope `read` (the chief of staff, for one) resolves this to the live
// tool the kit contributes, byte for byte. The creative agent grants no "transit", so there the same code is a
// disableTool() sentinel and `agent-kit__transit_plan` never reaches it.
// To give an agent a capability you add a grant; you do not write or delete code. A grant is
// not a deploy, though — see ../extension.ts for the env, volume and secret each capability
// still needs before its tools can do anything at call time. For `transit` that is the squid
// egress allow on `api.entur.io`: the tool is proxy-aware by construction, but a sealed agent
// still cannot reach a domain the proxy does not permit.
import { transit_plan } from "@lares/agent-kit/tools";
import { resolveExtensionTool } from "@lares/agent-kit/manifest";

import manifest from "../../../../agent.json";

export default resolveExtensionTool(manifest, "transit", transit_plan);
