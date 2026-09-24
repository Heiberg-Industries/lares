// Removes eve's built-in `bash` tool from the harness.
//
// Shell execution inside the container. Not sandboxed (`sandbox: null`), so it would run against the real filesystem — including /run/secrets.
//
// eve resolves this by FILENAME — and, corrected by ORB-152: eve does NOT validate the name
// at build time, so a typo here silently removes nothing. What makes a typo loud is the fleet
// drift alarm in packages/agent-kit/tests/disable-tool-names.test.ts, which checks every
// disableTool() filename against the installed eve's framework-tools.
import { disableTool } from "eve/tools";

export default disableTool();
