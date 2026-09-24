// Search one area of the Vault. See ../../src/note-tools.ts for the shared mechanics and
// ../../src/notes-store.ts for the ORB-51 posture (a store with no notes is an error, never
// an empty answer).
//
// A RELATIVE import, not the package specifier `@lares/agent-kit/note-tools` the task brief
// drafted: eve's extension bundler refuses a self-referencing package import from within the
// package's own extension source ("Package '@lares/agent-kit/note-tools' is not declared by
// the extension. Add '@lares/agent-kit' to dependencies...") — verified by actually running
// `eve extension build` and reading the error. Every OTHER file that imports note-tools
// (Atlas's tools, eve-saga's tests) is a genuine cross-package consumer and correctly uses
// the package specifier; only files inside this same package's `extension/` reach `src/` by
// relative path.
import { searchTool } from "../../src/note-tools.js";

// Carries no area authority, so it opens nothing — see vault_read.ts's header.
export default searchTool();
