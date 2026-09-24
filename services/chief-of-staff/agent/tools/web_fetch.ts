// Removes eve's built-in `web_fetch` tool from the harness.
//
// Egress is sealed to gateway + db + slack-proxy + DNS, so this can only ever hang — the ORB-51 failure shape, where a blocked call reads as absence.
//
// eve resolves this by FILENAME — and, corrected by ORB-152: eve does NOT validate the name
// at build time, so a typo here silently removes nothing. What makes a typo loud is the fleet
// drift alarm in packages/agent-kit/tests/disable-tool-names.test.ts, which checks every
// disableTool() filename against the installed eve's framework-tools.
import { disableTool } from "eve/tools";

export default disableTool();
