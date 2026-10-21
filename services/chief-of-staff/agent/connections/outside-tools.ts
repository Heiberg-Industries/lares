// Outside tools: the MCP servers the owner listed in this agent's definition, as eve
// connections. Engine code, the same in every installation; what it connects to is data.
//
// Resolved on session.started from the SAME per-session definition pin the persona and the model use
// (`thisAgent`). eve runs this several times per session and again after a restart, so everything
// below is idempotent. The work is in `@lares/agent-kit/outside-connections`.
import { verifyPrivateConsoleSession } from "@lares/agent-kit/private-console-surface";
import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { checkedOutsideConnections, descriptionChecks } from "@lares/agent-kit/outside-connections";

import { thisAgent } from "../../lib/definition.js";
import { emitSignal } from "../../lib/signal-emit.js";
import { isAllowedPrincipal, principalFromAuth } from "../../lib/principals.js";

/** The same allowlist `assertApprover` checks, applied to eve's responder. */
const isAllowedApprover = (responder: unknown): boolean => {
  const p = principalFromAuth(responder);
  return isAllowedPrincipal(p.authenticator, p.userId);
};

export default defineDynamic({
  events: {
    "session.started": async (_event: unknown, ctx?: { session?: { id?: string } }) => {
      if (await verifyPrivateConsoleSession(ctx)) return null;
      const { loaded } = await thisAgent(ctx?.session?.id);
      // Resolved once per session for the description check (locked tool descriptions, ADR-0019 rule 10).
      const configs = await checkedOutsideConnections(
        loaded.definition,
        { isAllowedApprover, descriptions: descriptionChecks((key, summary, detail) => emitSignal(key, summary, detail)) },
        ctx?.session?.id,
      );
      if (configs === null) return null;
      return Object.fromEntries(Object.entries(configs).map(([name, c]) => [name, defineMcpClientConnection(c)]));
    },
  },
});
