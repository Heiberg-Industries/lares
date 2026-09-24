// ORB-189: this @lares/agent-kit contribution is resolved against THIS agent's own agent.json,
// and by `resolveSkillTool` rather than `resolveExtensionTool` — because `market-edge` is a
// SKILL, not a capability. The distinction is the whole reason the skills layer exists: the
// capability is `markets` (a prediction-market price feed, granted or not), and the skill is
// the policy composed over it (a required caveat, an edge that is computed rather than claimed,
// no stake advice anywhere). `resolveSkillTool` removes the tool unless the agent DECLARES the
// skill in its `skills` array AND every capability that skill requires is granted at least as
// widely as it asks — and it fails the BUILD, loudly, if a declaration ever asks for more than
// the grants give. A skill can never widen access; that is enforced here, not promised.
//
// This file is BYTE-IDENTICAL in every eve agent in this repo (eve-saga, eve-marcel,
// eve-calliope) — `diff -r` across their agent/extensions/agent-kit/tools directories is empty,
// and that emptiness is the point. Since ORB-189 Task 3 the same bytes resolve DIFFERENTLY in
// each: Saga declares `market-edge` over a `markets:read` grant, so `agent-kit__market_edge` is
// live for her; Marcel and Calliope declare neither, so it stays a disableTool() sentinel there
// and reaches nobody. Nothing but each agent's own agent.json separates the three outcomes.
//
// To give an agent a skill you add a declaration; you do not write or delete code. A declaration
// is not a deploy, though — see ../extension.ts for what `markets` still needs at call time: a
// proxy-aware fetch, a getter for a pg Pool over the four `tyche_*` tables (a getter, because
// `eve build` evaluates the mount with no DATABASE_URL), and squid egress allows for
// api.elections.kalshi.com, clob.polymarket.com and gamma-api.polymarket.com. A sealed agent
// cannot reach a domain the proxy does not permit.
import { market_edge } from "@lares/agent-kit/tools";
import { resolveSkillTool } from "@lares/agent-kit/manifest";

import manifest from "../../../../agent.json";

export default resolveSkillTool(manifest, "market-edge", market_edge);
