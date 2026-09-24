// Removes eve's built-in `write_file` tool from the harness.
//
// The shadow is write-gated by standing constraint. Brain and Atlas are mounted read-only, but this would still write /tmp and the workflow volume.
//
// eve resolves this by FILENAME — and, corrected by ORB-152: eve does NOT validate the name
// at build time, so a typo here silently removes nothing. What makes a typo loud is the fleet
// drift alarm in packages/agent-kit/tests/disable-tool-names.test.ts, which checks every
// disableTool() filename against the installed eve's framework-tools.
import { disableTool } from "eve/tools";

export default disableTool();
