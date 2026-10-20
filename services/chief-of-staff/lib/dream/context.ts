// lib/dream/context.ts — ContextProvider that folds active preferences into the chief of staff's turn context.
//
// At each turn, loads the currently active preferences from the dream store and
// renders a compact bounded block for injection into the system prompt. Returns
// undefined when there are no active preferences (so the seam is cleanly omitted).
//
// `ContextProvider` is declared locally: chief-of-staff has no equivalent shared type.
// Nothing wires this into the actual turn-context-building path yet.

import type { PreferenceRow } from "./store.js";

/** Builds the regenerated situational-awareness string injected at session start. */
interface ContextProvider {
  build(agent: string, sessionId: string): Promise<string | undefined>;
}

// ─── Structural dep — only the slice we need ──────────────────────────────────

interface PreferenceStore {
  activePreferences(): Promise<PreferenceRow[]>;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ITEMS = 12;
const DEFAULT_MAX_CHARS = 1500;
const HEADING = "## What I've learned about how the owner works";

/**
 * Returns a ContextProvider that on each call:
 *   1. Fetches all active preferences (ordered by confidence desc, then created_at asc).
 *   2. Renders them as a compact markdown bullet list under a fixed heading.
 *   3. Caps at maxItems bullets OR maxChars total — whichever hits first.
 *   4. Returns undefined when there are no active preferences.
 */
export function makePreferencesContext(opts: {
  store: PreferenceStore;
  maxItems?: number;
  maxChars?: number;
}): ContextProvider {
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  return {
    async build(_agent: string, _sessionId: string): Promise<string | undefined> {
      const prefs = await opts.store.activePreferences();
      if (prefs.length === 0) return undefined;

      // Build incrementally, stopping at the first cap that triggers.
      let block = HEADING + "\n";
      let count = 0;

      for (const pref of prefs) {
        if (count >= maxItems) break;
        const bullet = `- ${pref.text}\n`;
        if (block.length + bullet.length > maxChars) break;
        block += bullet;
        count++;
      }

      // If no bullets fit (e.g. extremely tight maxChars), return undefined.
      if (count === 0) return undefined;

      return block.trimEnd();
    },
  };
}
