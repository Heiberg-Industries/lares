// Removes eve's built-in `web_fetch` tool from the harness.
//
// eve-marcel is sealed (Task 1): its container IP can only reach the gateway, db, and the
// box's squid proxy, whose allowlist (services/box/proxy/squid.conf's `marcel_travel`
// ACL) names only the specific travel-API domains the authored tools call through
// `lib/telegram-fetch.ts`'s `telegramFetch`. A bare `web_fetch` pointed at an arbitrary URL
// would either hang against a blocked address (the ORB-51 failure shape — a blocked call
// reads as absence, not an error) or bypass the tool-mediated boundary those domains are
// allow-listed for in the first place.
//
// Global Constraints (docs/superpowers/plans/2026-08-16-eve-marcel-wave.md): disable every
// default eve tool except the one explicit re-enable (web_search, agent/tools/web_search.ts).
//
// eve resolves this by FILENAME — and, corrected by ORB-152: eve does NOT validate the name
// at build time, so a typo here silently removes nothing. What makes a typo loud is the fleet
// drift alarm in packages/agent-kit/tests/disable-tool-names.test.ts, which checks every
// disableTool() filename against the installed eve's framework-tools.
import { disableTool } from "eve/tools";

export default disableTool();
