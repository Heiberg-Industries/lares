// Outside tools: the MCP servers the owner listed in this agent's definition, as eve
// connections. Engine code, the same in every installation; what it connects to is data.
//
// Resolved on session.started from the SAME per-session definition pin the persona and the model use
// (`thisAgent`). eve runs this several times per session and again after a restart, so everything
// below is idempotent. The work is in `@lares/agent-kit/outside-connections`.
import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { checkedOutsideConnections, descriptionChecks } from "@lares/agent-kit/outside-connections";

import { thisAgent } from "../../lib/definition.js";
import { isAllowedPrincipal, principalFromAuth } from "../../lib/principals.js";

/** The same allowlist `assertApprover` checks, applied to eve's responder. */
const isAllowedApprover = (responder: unknown): boolean => {
  const p = principalFromAuth(responder);
  return isAllowedPrincipal(p.authenticator, p.userId);
};

export default defineDynamic({
  events: {
    "session.started": async (_event: unknown, ctx?: { session?: { id?: string } }) => {
      const { loaded } = await thisAgent(ctx?.session?.id);
      const configs = await checkedOutsideConnections(loaded.definition, {
        isAllowedApprover,
        descriptions: descriptionChecks(),
        // Creative has no origin-taint hook, so the turn's taint is never written and a trusted read
        // could never see outside text. Fail closed: every call asks here.
        taintAware: false,
      }, ctx?.session?.id);
      if (configs === null) return null;
      return Object.fromEntries(Object.entries(configs).map(([name, c]) => [name, defineMcpClientConnection(c)]));
    },
  },
});
