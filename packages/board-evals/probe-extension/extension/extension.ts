// The smallest possible eve extension, and the ONLY reason it exists: Q3 needs a real mounted
// extension namespace so the agent's own dynamic catalogue can try to emit a tool under that
// namespace's reserved `probe__` prefix.
//
// It is a package, not a file, because eve requires one: `locateExtensionMountPackage`
// (eve/dist/src/discover/extensions.js) resolves a mount's default export back to a directory
// containing a package.json that declares `eve.extension.dist`, and fails the build with
// `discover/extension-mount-unresolved` otherwise. An inline `defineExtension()` in the mount file
// does not compile.
//
// It lives INSIDE packages/board-evals (mounted by the relative specifier "../../../probe-extension")
// rather than being a workspace package, and deliberately is not @lares/agent-kit: `eve dev` rebuilds
// every source-backed extension a mounted agent reaches, and rebuilding agent-kit's dist would
// disturb the services that consume it. Nothing outside this fixture is touched.
import { defineExtension } from "eve/extension";

export default defineExtension();
