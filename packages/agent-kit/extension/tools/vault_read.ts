// Read one note from one area of the Vault, by its store-relative path.
// Relative import, not the package specifier — see vault_search.ts's header comment.
//
// NO AREA AUTHORITY, SO IT OPENS NOTHING (W5C-s3). A note tool refuses every area unless the
// file that builds it injects "which areas may this session open?" — and this mounted copy
// cannot: an extension has no per-session definition read. Every role service supersedes it,
// either with a `disableTool()` sentinel under `agent/extensions/agent-kit/tools/` or with its
// own catalogue file that builds this same factory WITH its authority. This object is what
// remains when nobody has wired one up, and failing closed is the honest answer to that.
import { readTool } from "../../src/note-tools.js";

export default readTool();
