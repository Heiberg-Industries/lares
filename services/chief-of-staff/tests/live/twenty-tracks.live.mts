/**
 * Read-only owner-run check for Twenty's opportunity brand/stage metadata and filtered items.
 * This file is committed as the live API probe; fixtures in `twenty-tracks.test.ts` are synthetic
 * contract evidence only. Do not run this from a builder session. Run it manually where the
 * connected Twenty credentials are available, then review the returned option values privately.
 *
 *   pnpm -C services/chief-of-staff exec tsx tests/live/twenty-tracks.live.mts
 *
 * Requires `TWENTY_BASE_URL`, `TWENTY_KEY_FILE`, and `CRM_BRANDS` entries with exact live
 * `closingSteps` values. Performs GET requests only.
 */
import { TwentyTracksHome } from '../../lib/twenty-tracks.js';

const home = new TwentyTracksHome();
const tracks = await home.listTracks();
console.log(`Twenty tracks: ${tracks.length}`);
for (const track of tracks) {
  console.log(`${track.id} (${track.name})`);
  console.log(`  steps: ${track.steps.join(' | ')}`);
  console.log(`  closing steps: ${track.closingSteps.join(' | ')}`);
  const items = await home.listItems(track.id);
  console.log(`  open items returned: ${items.length}`);
}
