// List the note paths in one area of the Vault, store-relative, one page at a time.
// Relative import, not the package specifier — see vault_search.ts's header comment.
// Carries no area authority, so it opens nothing — see vault_read.ts's header.
import { listTool } from "../../src/note-tools.js";

export default listTool();
