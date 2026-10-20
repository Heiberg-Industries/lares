/**
 * tests/live/notion-page.live.mts — the LIVE check for read_url's Notion path.
 *
 * NOT part of `pnpm test`. Run inside the chief-of-staff container, where the Notion token and the
 * egress proxy are, so the check covers the sealed path end to end. The rootfs is read-only and
 * tsx won't transpile under node_modules, so bundle it first and run the bundle from the
 * writable cache tmpfs (so `undici` resolves from the service):
 *
 *   npx esbuild services/chief-of-staff/tests/live/notion-page.live.mts --bundle --platform=node \
 *     --format=esm --external:undici --outfile=/tmp/np.mjs
 *   ssh <user>@<server-address> 'docker exec -i <chief-of-staff-container> sh -c "mkdir -p /app/services/chief-of-staff/node_modules/.cache/probe && cat > /app/services/chief-of-staff/node_modules/.cache/probe/np.mjs"' < /tmp/np.mjs
 *   ssh <user>@<server-address> 'docker exec -e NOTION_LIVE_PAGE=<page id shared with the integration> \
 *     -w /app/services/chief-of-staff <chief-of-staff-container> node node_modules/.cache/probe/np.mjs'
 *
 * Both directions: a page shared with the integration MUST read (title + non-empty markdown), and
 * a page id that doesn't exist MUST fail with NotionPageUnavailableError — never a generic error
 * that reads as "the reader is down". It prints statuses and lengths only, never page content.
 */
import { NotionPageUnavailableError, readNotionPage } from "../../lib/notion-page.js";

const shared = process.env["NOTION_LIVE_PAGE"];
if (!shared) {
  console.error("set NOTION_LIVE_PAGE to the id of a page shared with Assistant's Notion integration");
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
