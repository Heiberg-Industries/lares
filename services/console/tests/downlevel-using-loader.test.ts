import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * Why the console no longer has a `using` loader, kept as a test so the reason cannot go stale.
 *
 * An earlier framework version shipped ONE explicit-resource-management `using` declaration in the
 * code a browser loads, which Next.js's webpack pipeline cannot parse. The console carried a narrow
 * webpack loader (`build/downlevel-using-loader.cjs`, with wiring in `next.config.mjs`) to
 * downlevel it. The framework's browser client holds no such declaration any more, so the loader
 * and its wiring were removed.
 *
 * This file keeps its name because it guards the same thing from the other side: it walks every
 * file the console's browser bundle can load from the framework — everything reachable from
 * `eve/react`, `eve/client` and `eve/events`, the three entries the console imports — and PARSES
 * each one for a `using` declaration. If a framework upgrade brings one back, this fails here, with
 * the file's name, instead of as an unreadable `next build` error.
 */

const require = createRequire(import.meta.url);
const SRC = join(dirname(realpathSync(require.resolve("eve/package.json"))), "dist", "src");

/** The framework's own import map (`imports` in its package.json), for its compiled output. */
function target(from: string, specifier: string): string | null {
  if (specifier.startsWith("#compiled/")) return join(SRC, "compiled", specifier.slice("#compiled/".length));
  if (specifier.startsWith("#")) return join(SRC, specifier.slice(1));
  if (specifier.startsWith(".")) return resolve(dirname(from), specifier);
  return null; // another package (react), not the framework's own code
}

/** Every module a file statically or dynamically imports, read from its syntax tree. */
function importsOf(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** True for `using x = …` and `await using x = …`, and for nothing else (`const` and `let` share bits). */
function isUsing(list: ts.VariableDeclarationList): boolean {
  const scoped = list.flags & ts.NodeFlags.BlockScoped;
  return scoped === ts.NodeFlags.Using || scoped === ts.NodeFlags.AwaitUsing;
}

function usingDeclarations(source: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node) && isUsing(node)) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

const parse = (file: string, text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);

/** Everything reachable from the entries, by following the framework's own imports. */
function closure(entries: readonly string[]): Map<string, ts.SourceFile> {
  const seen = new Map<string, ts.SourceFile>();
  const queue = entries.map((entry) => join(SRC, entry));
  while (queue.length > 0) {
    let file = queue.pop()!;
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.js");
    if (seen.has(file)) continue;
    const source = parse(file, readFileSync(file, "utf8"));
    seen.set(file, source);
    for (const specifier of importsOf(source)) {
      const next = target(file, specifier);
      if (next !== null) queue.push(next);
    }
  }
  return seen;
}

describe("the framework's browser client needs no `using` loader", () => {
  it("the check itself tells a `using` declaration from everything that merely looks like one", () => {
    expect(usingDeclarations(parse("a.js", "function f(){ using a = open(); const b = 1; let c = 2; }"))).toBe(1);
    expect(usingDeclarations(parse("b.js", "async function f(){ await using a = open(); }"))).toBe(1);
    // The token in a string, in a comment, and as an ordinary name is not a declaration.
    expect(usingDeclarations(parse("c.js", 'const s = "using foo bar"; /* using x = 1 */ const using = 3; let y = using + 1;'))).toBe(0);
  });

  it("no file the browser can load from eve/react, eve/client or eve/events declares one", () => {
    const files = closure(["react/index.js", "client/index.js", "public/events/index.js"]);
    // The walk really followed the imports: the hook, the store, the stream reader and the
    // projection the chat page uses are all in it.
    const names = [...files.keys()].map((file) => relative(SRC, file));
    for (const expected of ["react/use-eve-agent.js", "client/session-store.js", "client/open-stream.js", "client/session.js", "protocol/session-projection/fold.js"]) {
      expect(names, expected).toContain(expected);
    }
    expect(files.size).toBeGreaterThan(40);
    const offenders = [...files].filter(([, source]) => usingDeclarations(source) > 0).map(([file]) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it("the loader and its wiring are gone", () => {
    expect(existsSync(new URL("../build/downlevel-using-loader.cjs", import.meta.url))).toBe(false);
    const config = readFileSync(new URL("../next.config.mjs", import.meta.url), "utf8");
    expect(config).not.toMatch(/downlevel-using-loader\.cjs|enforce:\s*"pre"|module\.rules/);
  });
});
