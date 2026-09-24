/**
 * W2-s7 — the dynamic catalogue survives a replay under eve 0.59.0's durability rules.
 *
 * eve 0.59.0 (`7973fa2`) stopped trusting a dynamic tool it cannot rebuild in a fresh process.
 * Every callback phase an entry uses must carry a DURABLE DESCRIPTOR — `{ callback, closure }`
 * stamped under `Symbol.for("eve:durable-dynamic-callback")`. `execute` always needs one; an
 * approval policy, an `approvalKey`, a `toModelOutput` and a LIVE (validating) input or output
 * schema each need one when present. Two things can produce a descriptor: eve's compiler
 * transform on authored source, and the public helpers `defineDurableCallback` /
 * `defineDurableSchema` from `eve/tools` (`eve/docs/guides/dynamic-capabilities.md`).
 *
 * WHY THIS IS NOT A STYLE RULE. eve does not reject the offending entry — it rejects the WHOLE
 * resolver result. On 0.60.1 a real `eve invoke` logged
 *   [eve:dynamic-tools] Dynamic tool resolver (session.started) failed — skipping its complete
 *   result … Dynamic tool "agent-kit__vault_drop" callback "execute" does not have a durable
 *   descriptor.
 * and each role's model-visible tool list collapsed to its framework tools alone (4 / 2 / 3
 * against 0.32 baselines of 77 / 24 / 9). `eve build` and every typecheck stayed green while
 * that was true. On a box that is an agent with almost no tools and no error the owner sees.
 *
 * THE GATE ITSELF IS WHAT THIS TEST CALLS. `validateDurableDynamicToolCallbacks` is the function
 * that throws, read out of the installed eve by file path (it is not on a public subpath, so it
 * is loaded the way `disable-tool-names.test.ts` loads `framework/sources/registry.js`: through
 * the package's own resolution, so an eve upgrade that moves it turns this red rather than
 * quietly passing). Nothing here re-implements the rule.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { defineDurableCallback, defineDurableSchema, defineTool } from "eve/tools";

const require_ = createRequire(join(import.meta.dirname, "..", "package.json"));
const EVE_ROOT = dirname(require_.resolve("eve/package.json"));
const LIFECYCLE = join(EVE_ROOT, "dist", "src", "context", "dynamic-tool-lifecycle.js");

type Validate = (
  name: string,
  entry: object,
  owner: { sessionId: string; scope: string; resolverSlug: string; entryKey: string; name: string },
) => Record<string, { closure: Record<string, unknown> }>;

const { validateDurableDynamicToolCallbacks } = (await import(pathToFileURL(LIFECYCLE).href)) as {
  validateDurableDynamicToolCallbacks: Validate;
};

const owner = (name: string) => ({
  sessionId: "fixture-session",
  scope: "session",
  resolverSlug: "catalogue",
  entryKey: name,
  name,
});

/** Stands in for one `CatalogueEntry.tool`: a live zod schema, a board approval, an executor. */
const POOL: Record<string, { description: string; inputSchema: unknown; approval?: unknown; execute: (i: unknown, c: unknown) => unknown }> = {
  fixture_write: {
    description: "a gated write",
    inputSchema: z.object({ title: z.string() }),
    approval: async () => "user-approval",
    execute: async () => ({ ok: true }),
  },
};
const valueOf = (name: string) => POOL[name]!;

describe("the catalogue resolver's entries are replay-durable (eve 0.59.0)", () => {
  it("eve accepts an entry built the way the three role resolvers build one", () => {
    const name = "fixture_write";
    const tool = valueOf(name);
    const entry = defineTool({
      description: tool.description,
      inputSchema: defineDurableSchema({
        closure: { name },
        schema: (closure) => valueOf(closure.name).inputSchema as Record<string, unknown>,
      }),
      ...(tool.approval !== undefined
        ? {
            approval: defineDurableCallback({
              closure: { name },
              callback: (closure: { name: string }, ...args: unknown[]) =>
                (valueOf(closure.name).approval as (...a: unknown[]) => unknown)(...args),
            }),
          }
        : {}),
      execute: defineDurableCallback({
        closure: { name },
        callback: async (closure: { name: string }, input: unknown, toolCtx: unknown) =>
          valueOf(closure.name).execute(input, toolCtx),
      }),
    } as never) as unknown as object;

    const callbacks = validateDurableDynamicToolCallbacks(name, entry, owner(name));

    // The three phases this catalogue uses, each with the only capture that has to survive a
    // cold start: the tool's name. Anything richer would be a non-serializable capture.
    expect(callbacks.execute?.closure).toEqual({ name });
    expect(callbacks.inputSchema?.closure).toEqual({ name });
    expect(callbacks.approvalRequest?.closure).toEqual({ name });
  });

  it("the wrapping does not change what the model is handed, or what the approval answers", async () => {
    const name = "fixture_write";
    const durable = defineDurableSchema({
      closure: { name },
      schema: (closure) => valueOf(closure.name).inputSchema as Record<string, unknown>,
    }) as unknown as { "~standard": { validate: (v: unknown) => unknown; jsonSchema: { input: () => unknown } } };
    const authored = valueOf(name).inputSchema as { "~standard": { jsonSchema?: unknown } };

    // eve's canonical serialization drops the `$schema` key (`tools/schema.d.ts`: "canonical JSON
    // Schema data (no `$schema` key)"); everything else is the authored schema's own JSON Schema.
    const { $schema: _canonical, ...expected } = z.toJSONSchema(authored as never, { io: "input" } as never);
    expect(durable["~standard"].jsonSchema.input()).toEqual(expected);
    expect(durable["~standard"].validate({ title: "x" })).toEqual({ value: { title: "x" } });

    const approval = defineDurableCallback({
      closure: { name },
      callback: (closure: { name: string }, ...args: unknown[]) =>
        (valueOf(closure.name).approval as (...a: unknown[]) => unknown)(...args),
    });
    await expect(approval({})).resolves.toBe("user-approval");
  });

  it("eve still rejects the un-stamped shape this slice replaced", () => {
    // The 0.32 shape: the schema and the approval handed straight through, and an `execute`
    // arrow that eve's transform never saw (this test file is not authored eve source, and the
    // resolvers' `defineTool({…} as never)` is not an ObjectExpression argument either).
    const name = "fixture_write";
    const tool = valueOf(name);
    const entry = defineTool({
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.approval !== undefined ? { approval: tool.approval } : {}),
      execute: async (input: unknown, toolCtx: unknown) => valueOf(name).execute(input, toolCtx),
    } as never) as unknown as object;

    expect(() => validateDurableDynamicToolCallbacks(name, entry, owner(name))).toThrow(
      /callback "execute" does not have a durable descriptor/u,
    );
  });
});

describe("all three role resolvers stamp every phase they use", () => {
  const roles = ["chief-of-staff", "travel", "creative"] as const;
  const resolver = (role: string) =>
    readFileSync(
      join(import.meta.dirname, "..", "..", "..", "services", role, "agent", "tools", "catalogue.ts"),
      "utf8",
    );

  for (const role of roles) {
    it(`${role} routes inputSchema, approval and execute through a durable helper`, () => {
      const text = resolver(role);
      expect(text).toMatch(/inputSchema:\s*defineDurableSchema\(/u);
      expect(text).toMatch(/approval:\s*defineDurableCallback\(/u);
      expect(text).toMatch(/execute:\s*defineDurableCallback\(/u);
      // The closure is the tool NAME and nothing else: the entry object itself carries the
      // authored schema and two functions, none of which survives `JSON.stringify`.
      expect(text).not.toMatch(/closure:\s*\{\s*tool\s*\}/u);
    });
  }
});
