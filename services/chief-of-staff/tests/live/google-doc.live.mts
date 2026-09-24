/**
 * tests/live/google-doc.live.mts — the LIVE check for read_url's Google Docs path (ORB-286 batch 6).
 *
 * NOT part of `pnpm test`. Runs inside the eve-saga container (tokens, OAuth client secrets and the
 * egress proxy are there). Bundle it first, the same way as tests/live/notion-page.live.mts, and
 * keep npm packages external so they resolve from the service:
 *
 *   esbuild services/chief-of-staff/tests/live/google-doc.live.mts --bundle --platform=node --format=esm \
 *     --external:googleapis --external:pg --external:undici --external:unpdf --external:https-proxy-agent \
 *     --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" \
 *     --outfile=/tmp/gd.mjs
 *   (only externals that resolve from services/chief-of-staff/node_modules; googleapis-common lives under
 *   the kit, so it is bundled.) Copy into /app/services/chief-of-staff/node_modules/.cache/orb286/ and run
 *   with the database env the image's CMD builds:
 *   docker exec -w /app/services/eve-saga agent-box-eve-saga-1 sh -c \
 *     'PGPASSWORD=$(cat /run/secrets/db_password) DATABASE_URL=postgres://lares@db:5432/lares_state \
 *      GOOGLE_DOC_LIVE_URL=<a Doc Bendik can see> node node_modules/.cache/orb286/gd.mjs'
 *
 * First run 2026-09-14, BEFORE the re-consent: both cases answered the plain "not yet allowed to
 * read Google Drive" sentence — Google's real 403 insufficient-scope, detected as such.
 *
 * Two modes, by what the enrolled tokens hold:
 *  - BEFORE the drive.readonly re-consent: every account must answer insufficient-scope, and the
 *    reader must turn that into the plain "not yet allowed to read Google Drive" sentence.
 *  - AFTER it: GOOGLE_DOC_LIVE_URL (a Doc Bendik can see) must read (name + text), and a made-up
 *    id must be "not found in, or not shared with". Prints lengths only, never document text.
 */
import { driveApisFor } from "../../lib/google-drive.js";
import { GoogleDocUnavailableError, readGoogleDoc } from "../../lib/google-doc.js";

const real = process.env["GOOGLE_DOC_LIVE_URL"] ?? "https://docs.google.com/document/d/1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/edit";
let failed = 0;
try {
  const out = await readGoogleDoc(real, { apis: () => driveApisFor() });
  console.log(`READ   ${real.slice(0, 60)}… → title ${out.title.length} chars, text ${out.text.length} chars`);
} catch (e) {
  const plain = e instanceof GoogleDocUnavailableError;
  if (!plain) failed++;
  console.log(`${plain ? "PLAIN " : "FAIL  "} ${(e as Error).name}: ${(e as Error).message.replace(/Link: .*/, "").slice(0, 200)}`);
}
try {
  await readGoogleDoc("https://docs.google.com/document/d/1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/edit", { apis: () => driveApisFor() });
  failed++;
  console.log("FAIL   made-up id read something");
} catch (e) {
  const plain = e instanceof GoogleDocUnavailableError;
  if (!plain) failed++;
  console.log(`${plain ? "PLAIN " : "FAIL  "} made-up id → ${(e as Error).message.replace(/Link: .*/, "").slice(0, 200)}`);
}
console.log(failed === 0 ? "\nALL PLAIN OR READ" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
