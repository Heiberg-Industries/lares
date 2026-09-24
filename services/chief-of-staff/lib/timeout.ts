/**
 * `withTimeout` — one promise, one ceiling, one labeled rejection.
 *
 * ORB-209: extracted from `lib/brief-content.ts`, byte-identical. It lived there only because
 * the obligation radar was its first caller; by now every scheduled lane in this service
 * (`agent/schedules/*`, `agent/instructions/*`, `lib/obligation-resolution.ts`) reaches for it,
 * and `lib/obligation-resolution.ts` importing it back out of `brief-content.ts` was one half of
 * a value-level ESM cycle (`brief-content` ⇄ `obligation-resolution`). A module with no imports
 * of its own cannot participate in a cycle at all, which is the whole reason this file exists.
 *
 * Nothing else belongs here. It is a leaf on purpose.
 */

/** Bounds a promise to `ms`, throwing a labeled error instead of hanging. Every scheduled lane
 *  here consumes its slot before the await, so a wedged Gmail/Calendar call must cost this
 *  ONE tick, never delay or silently swallow the next. */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
