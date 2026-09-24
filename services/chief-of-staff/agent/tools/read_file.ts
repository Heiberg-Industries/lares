// Removes eve's built-in `read_file` tool from the harness.
//
// Reads any absolute path in the container, /run/secrets included (ORB-52). The authored agent-kit__vault_read (private) and vault_read (shared) hands cover note reading with store-relative paths and no sandbox.
//
// Fenced behind a path allowlist first (ORB-52, lib/fs-allowlist.ts), then removed outright
// on 2026-08-13 once the authored hands landed: the fence made them safe, the hands made
// them unnecessary, and a tool that cannot work is worse than no tool — she reaches for it,
// gets an environment error, and has to recover mid-answer.
//
// eve resolves this by FILENAME — and, corrected by ORB-152: eve does NOT validate the name
// at build time, so a typo here silently removes nothing. What makes a typo loud is the fleet
// drift alarm in packages/agent-kit/tests/disable-tool-names.test.ts, which checks every
// disableTool() filename against the installed eve's framework-tools.
import { disableTool } from "eve/tools";

export default disableTool();
