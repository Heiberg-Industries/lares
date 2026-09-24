/**
 * ICP (Ideal Customer Profile) markdown reader for the commercial radar.
 *
 * Ported from `services/agent-runtime/lib/commercial/icp.ts`, which reads
 * `${ATLAS_PATH}/icp/<brand>.md` via a plain injected `readFile` (returns null on any read
 * failure — no ICP configured for a brand is a normal, expected outcome, not an error).
 *
 * eve-saga already has an Atlas-store abstraction (`lib/notes-store.ts`): `storeRoot("atlas")`
 * resolves the SAME `ATLAS_PATH` env var, and `resolveInStore` gives traversal/symlink-safe
 * containment for free. This reuses those two primitives rather than a bare
 * `${ATLAS_PATH}/icp/${brand}.md` string join — but deliberately does NOT call
 * `notes-store.ts`'s `readNote`: that function requires the WHOLE store to be "healthy" (at
 * least one .md file anywhere under the root) before it will read anything, and throws
 * `NoteNotFoundError`/`StoreUnhealthyError` rather than returning null. Neither matches this
 * function's contract — "no ICP file for this brand" must stay a quiet, expected null, not an
 * error that could make an unconfigured brand look like a broken Atlas mount.
 */
import { readFileSync } from "node:fs";
import { StorePathNotConfiguredError, resolveInStore, storeRoot } from "@lares/agent-kit/notes-store";

const BRAND_RE = /^[a-z0-9_-]+$/i;

/** Read the ICP markdown for `brand`, or null if the brand name is malformed, ATLAS_PATH is
 *  unconfigured, or no `icp/<brand>.md` file exists there. Never throws. */
export async function icpFor(brand: string): Promise<string | null> {
  if (!BRAND_RE.test(brand)) return null;

  let root: string;
  try {
    root = storeRoot("atlas");
  } catch (err) {
    if (err instanceof StorePathNotConfiguredError) return null;
    throw err;
  }

  let abs: string;
  try {
    abs = resolveInStore(`icp/${brand}.md`, root);
  } catch {
    return null; // pathologically escapes the store — treat as "no ICP configured"
  }

  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null; // no ICP file for this brand
  }
}
