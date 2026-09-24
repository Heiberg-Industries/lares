// Removes eve's built-in `bash` tool from the harness.
//
// Shell execution inside the container, not sandboxed (`sandbox: null`) — it would run
// against the real filesystem, /run/secrets included. Every travel lookup Marcel needs
// (place_link, nearby_places, weather_forecast, strava_routes, flight_status, ...) is an
// authored tool; there is nothing left for a shell to do.
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
