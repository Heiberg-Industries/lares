// Propose a new note for one area of the Vault. GATED WRITE — the owner's 👍 on every call.
// The body lives in `../lib/note-write-tools.ts`; this file only names the tool, because eve
// derives a tool's runtime name from its filename.
//
// NO AREA AUTHORITY, SO IT WRITES NOTHING (W5C-s4, the same posture W5C-s3 gave the reads). A
// write tool refuses every area unless the file that builds it injects "which areas may this
// session open?" — and this mounted copy cannot: an extension has no per-session definition
// read. Every role service supersedes it, either with a `disableTool()` sentinel under
// `agent/extensions/agent-kit/tools/` or with its own catalogue file that builds this same
// factory WITH its authority. This object is what remains when nobody has wired one up, and
// failing closed is the honest answer to that.
import { writeTool } from "../lib/note-write-tools.js";

export default writeTool();
