// Move an existing note within one area of the Vault. GATED WRITE — the owner's 👍 on every
// call. The body lives in `../lib/note-write-tools.ts`; this file only names the tool.
//
// NO AREA AUTHORITY, SO IT WRITES NOTHING — see `vault_write.ts`'s header for the whole
// argument; this mount fails closed for exactly the same reason.
import { fileTool } from "../lib/note-write-tools.js";

export default fileTool();
