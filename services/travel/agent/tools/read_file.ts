// Removes eve's built-in `read_file` tool from the harness.
//
// Reads any absolute path in the container, /run/secrets included. Marcel's own data (trip
// files, taste lists, the Notert log) is reached exclusively through TripStore inside the
// authored tools (remember, place_link, nearby_places, ...) — never a general file read.
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
