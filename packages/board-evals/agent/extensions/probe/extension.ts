// A DIRECTORY mount, so the override slot beside it (tools/probe_extension_tool.ts) exists. The
// directory name is the namespace: every contribution this extension makes is prefixed `probe__`.
// The specifier is relative on purpose — eve's mount resolver accepts a relative path to a package
// root (`resolvePackageRoot`, eve/dist/src/discover/extensions.js), which keeps the whole fixture
// inside packages/board-evals with no workspace member and no lockfile change.
export { default } from "../../../probe-extension";
