/**
 * services/notion-sync/tests/live/notion-autolink.live.mts — the LIVE probe for rule 5 of
 * `normalizeForFidelity` in `../../lib/translate-pull.ts` (Notion's own links on bare addresses).
 *
 * NOT part of `pnpm test` (the `.live.mts` extension is not vitest's `*.test.*` glob, the same
 * convention every other `tests/live/` file in this repository uses). Read-only: it fetches one
 * page's markdown and writes nothing. Run it BY HAND against a desk page whose vault file has a
 * bare domain in prose (for example "Both on example.com, both in English."):
 *
 *     NOTION_TOKEN_FILE=/run/secrets/notion-token NOTION_VERSION=2026-03-11 \
 *       npx tsx services/notion-sync/tests/live/notion-autolink.live.mts <page-id> [vault-file]
 *
 * WHY THIS FILE EXISTS. Rule 5 assumes that Notion's `GET /markdown` returns a bare domain the
 * push wrote as plain text in the form `[example.com](http://example.com)` — observed once, on a
 * pushed desk page, while planning the change. The fixture in tests/translate-pull.test.ts is
 * SHAPED from that observation. This probe is what shows whether Notion still does it, with which
 * scheme, and whether the normaliser folds every such link back. With a vault file given, it also
 * runs the full live-leg comparison and prints the first line that still differs.
 */
import { readFileSync } from "node:fs";
import { makeNotionClient } from "../../lib/adapters/notion-client.js";
import { parseNotionPage, normalizeForFidelity } from "../../lib/translate-pull.js";
import { splitSource } from "../../lib/fidelity.js";

const [pageId, vaultFile] = process.argv.slice(2);
if (!pageId) {
  console.error("usage: notion-autolink.live.mts <page-id> [vault-file]");
  process.exit(2);
}
const tokenFile = process.env.NOTION_TOKEN_FILE;
const token = tokenFile ? readFileSync(tokenFile, "utf8").trim() : (process.env.NOTION_TOKEN ?? "");
if (!token) {
  console.error("set NOTION_TOKEN_FILE (preferred) or NOTION_TOKEN");
  process.exit(2);
}

const notion = makeNotionClient({ token, version: process.env.NOTION_VERSION ?? "2026-03-11" });
const live = await notion.getPageMarkdown(pageId);
const body = parseNotionPage(live, { resolvePage: () => null }).body;

const selfLinks = [...body.matchAll(/\[([^[\]\s]+)\]\((https?):\/\/([^()\s]+)\)/g)];
console.log(`links in the page whose text looks like an address: ${selfLinks.length}`);
for (const [whole, text, scheme, rest] of selfLinks) {
  const folded = rest === text || rest === `${text}/`;
  console.log(`  ${whole}  scheme=${scheme}  ${folded ? "→ folded to bare text by rule 5" : "→ NOT folded (text and target differ)"}`);
}

if (vaultFile) {
  const source = splitSource(readFileSync(vaultFile, "utf8")).body;
  const a = normalizeForFidelity(source).split("\n");
  const b = normalizeForFidelity(body).split("\n");
  const at = a.findIndex((line, i) => line !== b[i]);
  if (at === -1 && a.length === b.length) console.log("live leg: the page round-trips (after normalisation)");
  else {
    const i = at === -1 ? Math.min(a.length, b.length) : at;
    console.log(`live leg: first difference at line ${i + 1}`);
    console.log(`  vault: ${JSON.stringify(a[i] ?? "")}`);
    console.log(`  notion: ${JSON.stringify(b[i] ?? "")}`);
  }
}
