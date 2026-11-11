/**
 * Runs an eve 1.0 `defineDynamic(fn)` value the way eve does, for tests: the function is called with
 * a context that has `ctx.memo`. A memo keeps plain JSON per key (the result goes through a JSON round
 * trip, so a memo that tries to keep a function or a class instance fails here as it would in eve), a
 * failing memo keeps nothing, and a key used twice in one run throws. Pass the same `store` to
 * evaluate again, as eve does before every model call.
 */
export type MemoStore = Map<string, string>;

export async function runDynamic(sentinel: unknown, ctx: Record<string, unknown>, store: MemoStore = new Map()): Promise<any> {
  const fn = (sentinel as Record<symbol, ((c: unknown) => unknown) | undefined>)[Symbol.for("eve.dynamic")];
  if (typeof fn !== "function") throw new Error("not a defineDynamic() value");
  const used = new Set<string>();
  const memo = async (key: unknown, compute: (o: { idempotencyKey: string; abortSignal: AbortSignal }) => unknown) => {
    const k = JSON.stringify(key ?? null);
    if (used.has(k)) throw new Error(`memo key reused in one run: ${k}`);
    used.add(k);
    const saved = store.get(k);
    if (saved !== undefined) return JSON.parse(saved);
    const value = await compute({ idempotencyKey: k, abortSignal: new AbortController().signal });
    const json = JSON.stringify(value ?? null);
    store.set(k, json);
    return JSON.parse(json);
  };
  return fn({ ...ctx, memo });
}
