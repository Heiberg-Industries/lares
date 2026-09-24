/**
 * tests/live/notion-page.live.mts — the LIVE check for read_url's Notion path (ORB-289, ORB-286).
 *
 * NOT part of `pnpm test`. Run inside the eve-saga container, where the Notion token and the
 * egress proxy are, so the check covers the sealed path end to end. The rootfs is read-only and
 * tsx won't transpile under node_modules, so bundle it first and run the bundle from the
 * writable cache tmpfs (so `undici` resolves from the service):
 *
 *   npx esbuild services/chief-of-staff/tests/live/notion-page.live.mts --bundle --platform=node \
 *     --format=esm --external:undici --outfile=/tmp/np.mjs
 *   ssh root@<agent-1> 'docker exec -i agent-box-eve-saga-1 sh -c "mkdir -p /app/services/chief-of-staff/node_modules/.cache/orb286 && cat > /app/services/chief-of-staff/node_modules/.cache/orb286/np.mjs"' < /tmp/np.mjs
 *   ssh root@<agent-1> 'docker exec -e NOTION_LIVE_PAGE=<page id shared with the integration> \
 *     -w /app/services/chief-of-staff agent-box-eve-saga-1 node node_modules/.cache/orb286/np.mjs'
 *
 * First run 2026-09-14 (ORB-286 round 5): a shared meeting page read (title 39 chars, markdown
 * 12,126 chars) and a missing id was refused with NotionPageUnavailableError.
 *
 * Both directions: a page shared with the integration MUST read (title + non-empty markdown), and
 * a page id that doesn't exist MUST fail with NotionPageUnavailableError — never a generic error
 * that reads as "the reader is down". It prints statuses and lengths only, never page content.
 */
import { NotionPageUnavailableError, readNotionPage } from "../../lib/notion-page.js";

const shared = process.env["NOTION_LIVE_PAGE"];
if (!shared) {
  console.error("set NOTION_LIVE_PAGE to the id of a page shared with Saga's Notion integration");
  process.exit(2);
}
let failed = 0;

try {
  const out = await readNotionPage(`https://www.notion.so/${shared.replace(/-/g, "")}`);
  const ok = out.title.length > 0 && out.text.length > 0;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} shared page reads → title ${out.title.length} chars, markdown ${out.text.length} chars`);
} catch (e) {
  failed++;
  console.log(`FAIL shared page reads → ${(e as Error).name}: ${(e as Error).message.slice(0, 160)}`);
}

try {
  await readNotionPage("https://www.notion.so/00000000000040008000000000000000");
  failed++;
  console.log("FAIL missing page refused → it read something");
} catch (e) {
  const ok = e instanceof NotionPageUnavailableError;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} missing page refused → ${(e as Error).name}`);
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
