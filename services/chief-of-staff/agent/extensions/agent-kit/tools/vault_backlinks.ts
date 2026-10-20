// Superseded by `catalogue/agent-kit__vault_backlinks.ts` — a resolver-emitted
// tool under the SAME prefixed key (`agent-kit__vault_backlinks`) replaces an authored/mounted tool of
// that name completely, so this mount must stay dead unconditionally rather than
// resolve against the grant the way it used to: leaving both live would either collide or
// silently double-resolve. See `catalogue/agent-kit__vault_backlinks.ts`'s own header.
import { disableTool } from "eve/tools";

export default disableTool();
