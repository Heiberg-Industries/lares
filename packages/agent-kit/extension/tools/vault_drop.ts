// Delete a note from one area of the Vault. GATED WRITE, and an always-ask `delete` — the
// owner's 👍 on every call. The body lives in `../lib/note-write-tools.ts`; this file only
// names the tool.
//
// NO AREA AUTHORITY, SO IT DELETES NOTHING — see `vault_write.ts`'s header for the whole
// argument; this mount fails closed for exactly the same reason.
import { dropTool } from "../lib/note-write-tools.js";

export default dropTool();
