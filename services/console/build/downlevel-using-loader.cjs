"use strict";

/**
 * W8B-s3 — a narrow, temporary webpack loader for exactly one file.
 *
 * eve 0.60.1's compiled browser client uses ONE TC39 "explicit resource management"
 * `using` declaration — `node_modules/eve/dist/src/client/eve-agent-store.js`, inside
 * `EveAgentStore`'s private `resume()` method (`using r = n.subscribe(...)`). Next.js 16's
 * webpack pipeline cannot parse it: without `transpilePackages`, webpack's own bare parser fails
 * outright on the file's private class fields; with `"eve"` added to `transpilePackages`, Next's
 * SWC loader parses further but then refuses with
 *   "Using declaration is not enabled. Set jsc.parser.explicitResourceManagement to true"
 * — a parser flag `next/dist/build/swc/options.js` never sets and that no `next.config.mjs` field
 * reaches. There is no supported way to turn it on from this side.
 *
 * Rather than patch eve's vendored `dist` (patches/eve.patch exists for unrelated server-side
 * harness fixes, and hand-editing a resource-cleanup construct there risks silently changing
 * eve's stream-disposal behaviour), add a bundler dependency, or switch off webpack, this loader
 * uses the TypeScript compiler the console already depends on (`services/console/package.json`
 * devDependencies) to downlevel JUST the `using` syntax, the same way `tsc` would for a target
 * that predates it. It is intentionally narrow: `ts.transpileModule` runs ONLY on a source file
 * that literally contains the token `using `, so every other file in every other dependency
 * passes through completely untouched.
 *
 * DELETE THIS FILE (and its `next.config.mjs` wiring) the day either side moves: eve ships a
 * build without a `using` declaration in its browser client, or Next.js's webpack/SWC pipeline
 * gains a way to parse one. Grep `eve/dist/src/client/eve-agent-store.js` for `using ` to check.
 */

const ts = require("typescript");

/** A conservative token check, not a real parse — matches the loader's own narrow contract. */
const USING_DECLARATION = /(^|[^.\w$])using\s+[A-Za-z_$]/;

/** @type {import("webpack").LoaderDefinitionFunction} */
module.exports = function downlevelUsingLoader(source) {
  if (typeof source !== "string" || !USING_DECLARATION.test(source)) return source;

  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      allowJs: true,
      importHelpers: false,
      sourceMap: false,
    },
    fileName: this.resourcePath,
  });

  // Fail loudly rather than ship a bundle that still carries syntax the rest of the pipeline
  // cannot parse — a silent no-op here would just move today's build failure somewhere quieter.
  if (USING_DECLARATION.test(result.outputText)) {
    throw new Error(
      `downlevel-using-loader: TypeScript's own output for ${this.resourcePath} still contains a ` +
        `"using" declaration — this loader's transform did not do what it exists to do.`,
    );
  }

  return result.outputText;
};
