// The in-memory stand-in for `adapters/vault-files.ts`'s `listCollisionCandidates`,
// shared by every `ApplySyncDeps` harness (T6 review round 4).
//
// One model, not six: the previous round gave each harness its own inline version,
// and the moment the engine's wiring sentinel grew a second probe all six had to
// change in the same way — which is the shape that produces five that agree and one
// that quietly does not.
//
// It models exactly two properties of the real adapter, and deliberately nothing
// else:
//
//  1. **The vault root is never empty.** Every vault is a git clone, so `.git` is
//     always there. A world without it would model a broken mount, which the engine
//     rightly refuses to run creates against.
//  2. **Nothing can collide below an ancestry that exists in no spelling.** The real
//     adapter resolves each ancestor segment by `collisionKey` and returns `[]` as
//     soon as one matches nothing; this asks the cheaper prefix-shaped version of the
//     same question over a flat world.
//
// What it does NOT model is the adapter's narrowing to the resolved ancestry — it
// hands back the whole world and lets `findCollidingPath` decide, because the
// DECISION is the engine's and an over-approximation exercises the identical
// decision with no path arithmetic of its own to get wrong. **The narrowing itself
// is pinned where it lives: `tests/vault-files.test.ts`, against a real filesystem.**
import { collisionKey } from "../../lib/vault-target.js";

/**
 * `paths` is called per lookup, never captured, so a harness whose vault changes
 * mid-run (every seam test) is modelled honestly rather than frozen at wiring time.
 */
export function makeCollisionLookup(
  paths: () => Iterable<string>,
): (vaultPath: string) => Promise<string[]> {
  return async (vaultPath: string) => {
    const world = [".git", ...paths()];
    const slash = vaultPath.lastIndexOf("/");
    // A root-level target has no ancestry to resolve — the root always exists.
    if (slash === -1) return world;
    const parentKey = collisionKey(vaultPath.slice(0, slash + 1));
    const ancestryExists = world.some((path) => collisionKey(path).startsWith(parentKey));
    return ancestryExists ? world : [];
  };
}
