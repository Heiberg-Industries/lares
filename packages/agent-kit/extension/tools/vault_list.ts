// List every note path in one area of the Vault, store-relative.
// Relative import, not the package specifier — see vault_search.ts's header comment.
// Carries no area authority, so it opens nothing — see vault_read.ts's header.
import { listTool } from "../../src/note-tools.js";

export default listTool();
