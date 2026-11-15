/**
 * Which built-in tools does the INSTALLED eve hand an agent, and has someone decided on each?
 *
 * eve gives every agent a set of default tools it never declared. There are two ways to turn
 * them away, and this module checks either:
 *
 *  - ALL AT ONCE: `defaultTools: false` in the agent's `defineAgent({...})`. eve's compiler then
 *    drops every framework default tool except a slot the author also has a file for
 *    (`dist/src/compiler/default-tool-policy.js`, `applyDefaultToolPolicy`). A framework upgrade
 *    that adds a default tool cannot reach such an agent. What CAN still go wrong is a file
 *    under `agent/tools/` named after a default tool: it keeps that slot alive, so it is a
 *    decision and has to be written down.
 *  - ONE BY ONE: a `disableTool()` sentinel file per tool under `agent/tools/`. That only covers
 *    the tools somebody already knew about: an upgrade that adds one more default tool would
 *    hand it to the agent with nothing going red.
 *
 * Either way this module reads the framework's own list at test time and compares it with the
 * decisions a service has written down, so anything undecided fails the ordinary tests.
 *
 * Test support only. Nothing in a running agent imports this.
 *
 * WHERE THE LIST COMES FROM. eve has no public export for it. The one place that draws the
 * line between "a tool eve ships" and "a tool eve turns on by default" is
 * `dist/src/framework/sources/registry.js` inside the package: the module eve's own compiler
 * imports to build the framework-default candidates (`compiler/normalize-manifest.js`), and
 * the candidates a `disableTool()` sentinel shadows. It exports `frameworkAgentSourceRegistry`,
 * whose `registrations[].source.modules[].logicalPath` entries name every default slot
 * (`tools/bash.ts`, ...). This module IMPORTS that object rather than pattern-matching the
 * file's text: a text match can silently miss an entry the pattern did not anticipate, while
 * the object is the data the compiler itself uses. The file is not in the package's exports
 * map, so it is loaded by absolute path. If a future eve moves the file, renames the export or
 * changes the shape, every function here throws — the right failure, because the place the
 * framework keeps this list has moved and has to be found again by a person.
 *
 * WHAT IT CANNOT SEE. Only tools that occupy an `agent/tools/<name>.ts` slot through that
 * registry. A tool the framework's runtime adds some other way is invisible here: eve 1.0 adds
 * its `eve__…` tools per conversation, with no slot and no switch. Each service's
 * `tests/eve-tools-offered.test.ts` and the model-visible tool baselines in
 * `packages/board-evals/snapshots/` are the net for those.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Where the registry lives inside the installed eve package. */
const REGISTRY_PATH_IN_EVE = ["dist", "src", "framework", "sources", "registry.js"] as const;
const REGISTRY_EXPORT = "frameworkAgentSourceRegistry";

const TOOL_SLOT_PREFIX = "tools/";
const MODULE_EXTENSION = /\.(?:ts|mts|js|mjs)$/u;

function formatChanged(where: string, detail: string): Error {
  return new Error(
    `Cannot read the framework's default tools from ${where}: ${detail}. The installed eve ` +
      `keeps this list somewhere else or in another shape now — find it again before trusting ` +
      `any tool-harness test.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Pull the default tool names out of a registry object. Separate from the import so the shape
 * checks can be exercised with made-up registries. Throws on anything it does not recognise
 * rather than returning a partial list — a partial list would let a tool through unseen.
 */
export function defaultToolNamesFromRegistry(registry: unknown, where = "the registry"): string[] {
  if (!isRecord(registry) || !Array.isArray(registry.registrations)) {
    throw formatChanged(where, "it has no `registrations` list");
  }
  const names = new Set<string>();
  for (const registration of registry.registrations as unknown[]) {
    const source = isRecord(registration) ? registration.source : undefined;
    if (!isRecord(source) || !Array.isArray(source.modules)) {
      throw formatChanged(where, "a registration has no `source.modules` list");
    }
    for (const module of source.modules as unknown[]) {
      const logicalPath = isRecord(module) ? module.logicalPath : undefined;
      if (typeof logicalPath !== "string") {
        throw formatChanged(where, "a module has no `logicalPath` string");
      }
      if (!logicalPath.startsWith(TOOL_SLOT_PREFIX)) continue; // agent.ts, sandbox.ts, channels/…
      // `tools/bash.ts` and the folder form `tools/bash/index.ts` are the same slot.
      const name = logicalPath
        .slice(TOOL_SLOT_PREFIX.length)
        .replace(MODULE_EXTENSION, "")
        .replace(/\/index$/u, "");
      if (name === "" || name.includes("/")) {
        throw formatChanged(where, `"${logicalPath}" is not a tool slot shape this reader knows`);
      }
      names.add(name);
    }
  }
  if (names.size === 0) throw formatChanged(where, "it lists no `tools/…` module at all");
  return [...names].sort();
}

/**
 * The built-in tools the INSTALLED eve turns on by default, read from the package at call
 * time. `resolveFrom` is a file inside the service asking (its `import.meta.url` or a path):
 * eve is resolved through THAT service's dependencies, so the answer is for the eve it runs
 * on, not for whichever copy happens to sit at the workspace root.
 */
export async function installedFrameworkDefaultTools(resolveFrom: string | URL): Promise<string[]> {
  const eveRoot = dirname(createRequire(resolveFrom).resolve("eve/package.json"));
  const registryPath = join(eveRoot, ...REGISTRY_PATH_IN_EVE);
  let namespace: Record<string, unknown>;
  try {
    namespace = (await import(/* @vite-ignore */ pathToFileURL(registryPath).href)) as Record<string, unknown>;
  } catch (cause) {
    throw formatChanged(registryPath, `the module could not be imported (${String(cause)})`);
  }
  if (!(REGISTRY_EXPORT in namespace)) {
    throw formatChanged(registryPath, `it no longer exports \`${REGISTRY_EXPORT}\``);
  }
  return defaultToolNamesFromRegistry(namespace[REGISTRY_EXPORT], registryPath);
}

export interface FrameworkToolDecisions {
  /** Every built-in tool the installed framework provides by default. */
  readonly frameworkTools: readonly string[];
  /** The tools this service switches off with a `disableTool()` sentinel. */
  readonly disabled: readonly string[];
  /** The tools this service leaves in place on purpose: name → one-line reason. */
  readonly accepted: Readonly<Record<string, string>>;
  /**
   * `true` only when the agent's definition sets `defaultTools: false`, read from the definition
   * itself. Then every framework default tool is off unless a file under `agent/tools/` carries
   * its name. Anything else (absent, `true`, unreadable) is treated as "the defaults are on".
   */
  readonly defaultToolsOff?: boolean;
  /**
   * Files under `agent/tools/` that are NOT sentinels, by name. Only read with
   * `defaultToolsOff`: one named after a framework default tool takes that tool's place.
   */
  readonly authored?: readonly string[];
}

/**
 * Compare what the framework provides with what a service has decided. Returns one sentence
 * per problem; an empty list means every built-in tool is accounted for. Pure: no file
 * access, no framework import — the caller supplies all three lists.
 *
 * With `defaultToolsOff` it reports instead of the first item:
 *  - an authored file named after a framework tool that is not in the accepted list (the file
 *    keeps the slot `defaultTools: false` would have emptied);
 *  - an accepted tool no authored file keeps (the list claims a tool the agent does not have).
 *
 * It reports, in this order:
 *  - a framework tool nobody decided on (the reason this exists);
 *  - a tool both switched off and accepted (the two lists contradict each other);
 *  - an accepted tool without a reason;
 *  - an accepted tool the framework no longer provides (the list has gone stale — after a
 *    framework upgrade this is also the sign that the tool is now provided some other way and
 *    has to be looked for);
 *  - a sentinel for a tool the framework does not provide (it switches nothing off).
 */
export function frameworkToolDecisionProblems(decisions: FrameworkToolDecisions): string[] {
  const provided = new Set(decisions.frameworkTools);
  const disabled = new Set(decisions.disabled);
  const accepted = new Map(Object.entries(decisions.accepted));
  const problems: string[] = [];
  const defaultsOff = decisions.defaultToolsOff === true;
  const authored = new Set(decisions.authored ?? []);

  for (const tool of [...provided].sort()) {
    if (defaultsOff) {
      // `defaultTools: false` has already decided every tool nobody wrote a file for.
      if (!authored.has(tool) || accepted.has(tool)) continue;
      problems.push(
        `agent/tools/${tool}.ts carries the name of the framework's built-in tool "${tool}". ` +
          `With defaultTools: false a file by that name is the one thing that keeps the slot, so ` +
          `the agent has a "${tool}" tool. Rename the file, or name "${tool}" in the accepted ` +
          `list with the reason.`,
      );
      continue;
    }
    if (disabled.has(tool) || accepted.has(tool)) continue;
    problems.push(
      `The installed framework ships a built-in tool "${tool}" that is neither switched off ` +
        `nor accepted here. A new framework tool is an owner decision: once the owner has ` +
        `decided, either add agent/tools/${tool}.ts exporting disableTool(), or name ` +
        `"${tool}" in the accepted list with the reason.`,
    );
  }
  for (const tool of [...accepted.keys()].sort()) {
    const reason = accepted.get(tool)!;
    if (disabled.has(tool)) {
      problems.push(`"${tool}" is both switched off by a sentinel and named in the accepted list — it can only be one.`);
    }
    if (reason.trim() === "") {
      problems.push(`"${tool}" is in the accepted list without a reason — say in one line why it is left on.`);
    }
    if (defaultsOff && provided.has(tool) && !authored.has(tool) && !disabled.has(tool)) {
      problems.push(
        `"${tool}" is in the accepted list, but defaultTools: false switches it off and no ` +
          `agent/tools/${tool}.ts keeps it: the agent does not have this tool. Remove the entry.`,
      );
    }
    if (!provided.has(tool)) {
      problems.push(
        `"${tool}" is in the accepted list, but the installed framework no longer provides a ` +
          `built-in tool by that name. Either it is gone (remove the entry) or the framework ` +
          `now provides it some other way this check cannot see — find out which.`,
      );
    }
  }
  for (const tool of [...disabled].sort()) {
    if (provided.has(tool)) continue;
    problems.push(
      `agent/tools/${tool}.ts switches off "${tool}", but the installed framework provides no ` +
        `built-in tool by that name — the sentinel switches nothing off.`,
    );
  }
  return problems;
}
