// Barrel for the `./persona` subpath export (ORB-145 Phase 2, Task 5).
export { assemblePersona, renderEnvironment } from "./assemble.js";
export type { AssembleInput, RenderOptions } from "./assemble.js";
export { deployedToolsFor } from "./deployed-tools.js";
export { CAPABILITY_DOCS, hostsFor, docFor, adapterRegion, coversCountry, renderSummary } from "./capability-docs.js";
export type { AdapterRegion, CapabilityDoc, CapabilityRule, KeyedRule, SummaryPart } from "./capability-docs.js";
export { lintRole, assertRoleIsGeneric, toolNamesIn, assertRoleToolsAreDeployed } from "./lint.js";
export type { LintFinding } from "./lint.js";
export { lintCapabilityDoc, lintCapabilityDocs, assertCapabilityDocsAreGeneric, lintInstructionSkill, assertSkillIsGeneric } from "./doc-lint.js";
export type { DocLintFinding } from "./doc-lint.js";
