// The one wikilink resolver every fixture test AND the expected-output generator
// share. Exact-output fixture tests are only meaningful if both sides render with
// the identical resolver, so it lives here rather than being redefined inline.
//
// The map simulates a mid-backfill store: the fixture files themselves (plus two
// pages they link to) have Notion pages already; everything else — `raw/` sources,
// Obsidian-style capitalised links, wiki pages outside the fixture set — resolves
// to null and must come out as an escaped literal. URLs use the id-no-dashes shape
// the engine constructs from stored page ids (plan T4).
import type { ResolvedWikiLink } from "../../lib/translate.js";

const PAGES: Record<string, ResolvedWikiLink> = {
  "agent-loops-design": {
    url: "https://www.notion.so/11111111111111111111111111111111",
    title: "Designing agent loops — heartbeats, crons, hooks & goals",
  },
  "camera-not-an-engine": {
    url: "https://www.notion.so/22222222222222222222222222222222",
    title: "A Camera, Not an Engine — seeing in latent space, and the camera/engine split in agents",
  },
  "writing": {
    url: "https://www.notion.so/33333333333333333333333333333333",
    title: "Writing — seeds & the studio bridge",
  },
  "services-as-software-autopilots": {
    url: "https://www.notion.so/44444444444444444444444444444444",
    title: "Services as Software — copilots become autopilots",
  },
  "rune-danielsen": {
    url: "https://www.notion.so/55555555555555555555555555555555",
    title: "Rune Danielsen",
  },
  "anfo-annonsorforeningen": {
    url: "https://www.notion.so/66666666666666666666666666666666",
    title: "ANFO Annonsørforeningen",
  },
};

export function fixtureResolve(target: string): ResolvedWikiLink | null {
  return PAGES[target] ?? null;
}

// The pull-direction inverse of PAGES: Notion URL -> wikilink target text.
// Built from the same map so push and pull tests can never disagree about
// which page is which. translate-pull.ts emits whatever `target` a resolver
// returns verbatim — deriving "bare stem vs. directory-qualified path" is the
// real engine's job (it needs the whole vault's title index), not this file's
// — so every entry here is just the bare stem, since all six fixture pages
// live at the wikiDir root.
const PAGES_BY_URL: Record<string, string> = Object.fromEntries(
  Object.entries(PAGES).map(([stem, page]) => [page.url, stem]),
);

// One representative "directory-qualified" entry, not tied to any real
// fixture file, so a test can assert the emitted link text for the case
// where a resolver's index needed to disambiguate by directory.
export const NESTED_TARGET_URL = "https://www.notion.so/77777777777777777777777777777777";
PAGES_BY_URL[NESTED_TARGET_URL] = "people/jane";

export function fixtureResolvePage(url: string): { target: string } | null {
  const target = PAGES_BY_URL[url];
  return target === undefined ? null : { target };
}
