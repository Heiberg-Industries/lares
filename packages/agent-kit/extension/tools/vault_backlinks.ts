// What else in one area of the Vault links to this note.
// Relative import, not the package specifier — see vault_search.ts's header comment.
// Carries no area authority, so it opens nothing — see vault_read.ts's header.
import { backlinksTool } from "../../src/note-tools.js";

export default backlinksTool();
