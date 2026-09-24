/**
 * Eve 0.32 stores dynamic tool names in durable sessions, but its fallback execute
 * and approval functions live only in the process that ran session.started.
 * Register the same implementations when the module loads in each server process.
 * This does not expose tools or re-run a resolver: the session's saved metadata
 * remains the authority for which tools, descriptions and schemas are available.
 * Keep the installed-runtime restart probe when changing Eve or these key names.
 *
 * 2026-09-19, eve 0.60.1 (W2-s7) — WHAT EVE NOW DOES ITSELF, AND WHY THIS STAYS ANYWAY.
 *
 * eve 0.59.0 made durability a rule rather than a convention. Every dynamic tool entry must
 * carry a DURABLE DESCRIPTOR for each callback phase it uses — `execute` always, plus the
 * approval request/response policies, `approvalKey`, `toModelOutput` and any live (validating)
 * input/output schema. A descriptor is `{ callback, closure }` stamped under
 * `Symbol.for("eve:durable-dynamic-callback")`, produced either by eve's compiler transform on
 * authored source or by the public helpers `defineDurableCallback` / `defineDurableSchema`
 * (`eve/tools`). eve keeps those bindings itself, in a session-keyed registry under
 * `Symbol.for("eve:scoped-dynamic-tool-callbacks")`, and when a persisted session-scoped
 * callback has no binding in this process — a cold start, a redeploy — it RE-RUNS the
 * `session.started` resolvers once to rebind, then replays. A tool the resolver no longer
 * returns fails closed with an explicit error instead of invoking something else.
 * (`eve/dist/src/tools/durable-callbacks.js`, `eve/dist/src/context/dynamic-tool-lifecycle.js`,
 * `eve/docs/guides/dynamic-capabilities.md` — "Identity and redeploys".)
 *
 * So the restart case this module was written for is covered natively, and the three role
 * resolvers now stamp their phases by hand (`services/<role>/agent/tools/catalogue.ts`).
 *
 * MEASURED: the two key shapes this module writes — `eve:framework-dynamic:<slug>:<name>` and
 * `eve:dynamic-tool-approval:<slug>:<name>` — appear NOWHERE in eve 0.60.1's `dist/`. The
 * `@workflow/core//registeredSteps` map it writes into still exists (eve uses it for remote
 * subagent dispatch), so these registrations are harmless, but for dynamic tools they are now
 * INERT: nothing reads them back.
 *
 * It is kept for this wave on purpose (plan Owner decision 6). It sits in the approval and
 * tool-resolution path, and "measured inert" is a reading of the installed package, not a
 * restart proof. Delete it in its own slice once W2-s13's restart proofs have run green on
 * 0.60.1 and shown eve's own rebind carrying the same cases.
 */
type Step = (closure: unknown, input: unknown, context?: unknown) => unknown;
interface Tool {
  execute(input: unknown, context: unknown): unknown;
  approval?(context: unknown): unknown;
}

export function registerDurableDynamicTools(slug: string, tools: Readonly<Record<string, unknown>>): void {
  const key = Symbol.for('@workflow/core//registeredSteps');
  const world = globalThis as typeof globalThis & { [key: symbol]: Map<string, Step> | undefined };
  const registry = world[key] ??= new Map<string, Step>();
  for (const [name, value] of Object.entries(tools)) {
    const tool = value as Tool;
    if (!tool || typeof tool.execute !== 'function' || (tool.approval !== undefined && typeof tool.approval !== 'function')) {
      throw new Error(`Invalid durable dynamic tool ${slug}/${name}`);
    }
    registry.set(`eve:framework-dynamic:${slug}:${name}`, (_closure, input, context) => tool.execute(input, context));
    if (tool.approval !== undefined) {
      registry.set(`eve:dynamic-tool-approval:${slug}:${name}`, (_closure, context) => tool.approval!(context));
    }
  }
}
