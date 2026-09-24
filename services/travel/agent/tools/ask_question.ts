// Removes eve's built-in `ask_question` tool from the harness.
//
// Marcel asks for missing detail as ordinary conversational reply — persona.md's own line,
// "Er du usikker på fakta: si det, eller søk. Gjett aldri på tider og adresser" — not via a
// dedicated park-and-wait tool. The Telegram channel's Gatekeeper gate (whether to speak at
// all in a group) and admin-DM turns both work as plain message/response; nothing in this
// port needs a mid-turn structured clarifying-question primitive.
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
