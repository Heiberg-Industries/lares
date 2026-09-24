import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import vm from "node:vm";

/**
 * Tests `build/downlevel-using-loader.cjs` for real semantics, not just "it parses": the fixtures
 * below are transpiled by the loader exactly as webpack would call it, then the OUTPUT is actually
 * executed (in a fresh `vm` context, never the real process, so a broken transform can't corrupt
 * this test run's own globals) and its observable behaviour is asserted — resource disposal order,
 * disposal on the happy path AND on a thrown error, and what happens with no `Symbol.dispose`.
 */

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const loader = require("../build/downlevel-using-loader.cjs") as (this: { resourcePath: string }, source: string) => string;

function transpile(source: string): string {
  return loader.call({ resourcePath: "/fake/eve/dist/src/client/eve-agent-store.js" }, source);
}

/** Runs transpiled CommonJS-shaped output in an isolated realm and returns its `module.exports`. */
function evaluate(code: string): Record<string, unknown> {
  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({ module: moduleObj, exports: moduleObj.exports, console });
  vm.runInContext(code, context, { filename: "downlevel-using-fixture.js" });
  return moduleObj.exports;
}

describe("downlevel-using-loader", () => {
  it("returns a source with no 'using' declaration byte-identical, untouched", () => {
    const source = 'const x = 1;\nfunction f() { return x + 1; }\nmodule.exports = { f };\n';
    expect(transpile(source)).toBe(source);
  });

  it("disposes a single resource exactly once, at scope exit", () => {
    const source = `
      function run(order) {
        using a = { [Symbol.dispose]() { order.push("dispose:a"); } };
        order.push("body");
      }
      module.exports = { run };
    `;
    const output = transpile(source);
    expect(output).not.toBe(source);
    expect(output).not.toMatch(/(^|[^.\w$])using\s+[A-Za-z_$]/);

    const order: string[] = [];
    const { run } = evaluate(output) as { run: (order: string[]) => void };
    run(order);
    expect(order).toEqual(["body", "dispose:a"]);

    // "exactly once": a second call must not accumulate extra dispose calls from the first run's
    // resource, and must itself dispose exactly once.
    const order2: string[] = [];
    run(order2);
    expect(order2).toEqual(["body", "dispose:a"]);
  });

  it("disposes two resources in reverse declaration order", () => {
    const source = `
      function run(order) {
        using a = { [Symbol.dispose]() { order.push("dispose:a"); } };
        using b = { [Symbol.dispose]() { order.push("dispose:b"); } };
        order.push("body");
      }
      module.exports = { run };
    `;
    const output = transpile(source);
    const order: string[] = [];
    const { run } = evaluate(output) as { run: (order: string[]) => void };
    run(order);
    // b was declared after a, so it is disposed first — LIFO, the same order a real "using" block
    // in a native runtime would use.
    expect(order).toEqual(["body", "dispose:b", "dispose:a"]);
  });

  it("still disposes every resource, and still lets the original error propagate, when the block throws", () => {
    const source = `
      function run(order) {
        using a = { [Symbol.dispose]() { order.push("dispose:a"); } };
        using b = { [Symbol.dispose]() { order.push("dispose:b"); } };
        order.push("body");
        throw new Error("boom");
      }
      module.exports = { run };
    `;
    const output = transpile(source);
    const order: string[] = [];
    const { run } = evaluate(output) as { run: (order: string[]) => void };
    expect(() => run(order)).toThrow("boom");
    expect(order).toEqual(["body", "dispose:b", "dispose:a"]);
  });

  it("matches TypeScript's own emitted helper when Symbol.dispose does not exist: it throws a " +
    "TypeError synchronously, at the point the resource is acquired, before the function body runs " +
    "any further — not lazily, at what would have been disposal time", () => {
    const source = `
      function run(order) {
        using a = { [Symbol.dispose]() { order.push("dispose:a"); } };
        order.push("unreachable");
      }
      module.exports = { run };
    `;
    const output = transpile(source);
    const moduleObj = { exports: {} as Record<string, unknown> };
    // A fresh realm whose global `Symbol` has no `.dispose` — standing in for a runtime that
    // predates explicit resource management, the case this fixture exists to pin down. The real
    // `Symbol.dispose` is a non-configurable well-known symbol (deleting or reassigning it on the
    // actual global throws), so this shadows the global binding with a plain stand-in instead of
    // touching the real one; nothing else in this fixture needs a real `Symbol`.
    const context = vm.createContext({ module: moduleObj, exports: moduleObj.exports, console, Symbol: { dispose: undefined } });
    vm.runInContext(output, context, { filename: "downlevel-using-fixture-no-dispose.js" });
    const { run } = moduleObj.exports as { run: (order: string[]) => void };

    const order: string[] = [];
    let caught: unknown;
    try {
      run(order);
    } catch (error) {
      caught = error;
    }
    // A cross-realm error is not `instanceof` this realm's TypeError, so assert on its shape
    // instead — the vm context's own TypeError is exactly what TypeScript's helper throws.
    expect((caught as Error)?.name).toBe("TypeError");
    expect((caught as Error)?.message).toBe("Symbol.dispose is not defined.");
    // The throw happens while acquiring "a", so the line after it — and "a"'s own dispose, which
    // never got the chance to be registered — never runs.
    expect(order).toEqual([]);
  });

  it("throws loudly if the output still contains what looks like a 'using' declaration", () => {
    // TypeScript cannot fail to downlevel valid `using` syntax, so this exercises the guard without
    // needing to break the real transform: the loader's trigger check is a token match, not a real
    // parse, and a STRING LITERAL containing that same token is a source `ts.transpileModule` will
    // (correctly) leave completely untouched — including inside the emitted output — which is
    // exactly the shape the loader's own post-transform guard exists to catch rather than ship.
    const source = 'const s = "using foo bar";\nmodule.exports = { s };\n';
    expect(() => transpile(source)).toThrow(/still contains a "using" declaration/);
  });
});
