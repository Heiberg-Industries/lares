/**
 * tests/live/readability.live.mts — the LIVE check for the URL → text reader (ORB-286).
 *
 * NOT part of `pnpm test`, and deliberately so: it fetches real pages. Run it by hand after any
 * change to `lib/extract.ts` or to the `undici` / `jsdom` versions, and after a redeploy:
 *
 *     npx tsx services/readability/tests/live/readability.live.mts          # the code, from this Mac
 *     READABILITY_URL=https://readability.example.com READABILITY_TOKEN=… \
 *       npx tsx services/readability/tests/live/readability.live.mts        # the deployed worker
 *
 * WHY THIS FILE EXISTS. From 2026-09-01 to 2026-09-14 the worker failed EVERY url with
 * "fetch failed": the undici ^7 → ^8 bump made Node's built-in fetch reject the SSRF-pinning
 * dispatcher. Every unit test injects `fetchFn`, which skips that dispatcher, so the suite stayed
 * green for two weeks while Saga and Marcel told Bendik "the reader is down".
 *
 * IT COVERS BOTH DIRECTIONS: real public pages MUST read (the over-rejection that shipped), and
 * internal addresses MUST still be refused (the leak a careless fix would open).
 * Exit code 0 only when both hold.
 */
import { fetchAndExtract } from "../../lib/extract.js";

const MUST_READ = [
  "https://paulgraham.com/greatwork.html",
  "https://en.wikipedia.org/wiki/Readability",
  "https://www.nrk.no/",
  "https://arxiv.org/pdf/1706.03762", // a PDF link (ORB-286 round 5) — "Attention Is All You Need"
  // YouTube (batch 6): title + channel via oEmbed, never the spoken content — see extractYouTube.
  "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  "https://youtu.be/8jPQjjsBbIc",
];
/** Must fail with a reason (the worker answers 502 + {error}), never pretend to have read it. */
const MUST_FAIL = [
  "https://www.youtube.com/watch?v=AAAAAAAAAAA", // no such video
];
const MUST_IMAGE = [
  "https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg", // an image link (ORB-286 batch 6)
];
const MUST_REFUSE = [
  "http://127.0.0.1:8080/",
  "http://169.254.169.254/latest/meta-data/",
  "http://localhost/",
  "file:///etc/passwd",
];

const remote = process.env["READABILITY_URL"];
async function read(url: string): Promise<{ status: number; title?: string; chars?: number; error?: string; image?: string }> {
  if (!remote) {
    try {
      const out = await fetchAndExtract(url);
      return { status: 200, title: out.title, chars: out.text.length, image: out.image?.mediaType };
    } catch (e) {
      return { status: (e as { status?: number }).status ?? 500, error: String((e as Error).message) };
    }
  }
  const res = await fetch(`${remote.replace(/\/$/, "")}/extract`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-readability-token": process.env["READABILITY_TOKEN"] ?? "" },
    body: JSON.stringify({ url }),
  });
  const body = (await res.json().catch(() => ({}))) as { title?: string; text?: string; error?: string; image?: { mediaType?: string } };
  return { status: res.status, title: body.title, chars: body.text?.length, error: body.error, image: body.image?.mediaType };
}

let failed = 0;
console.log(`target: ${remote ?? "lib/extract.ts, from this machine"}\n`);
for (const url of MUST_READ) {
  const r = await read(url);
  const ok = r.status === 200 && (r.chars ?? 0) > 200;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} read    ${url} → ${r.status} ${ok ? `"${r.title}" (${r.chars} chars)` : r.error}`);
}
for (const url of MUST_IMAGE) {
  const r = await read(url);
  const ok = r.status === 200 && typeof r.image === "string" && r.image.startsWith("image/");
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} image   ${url} → ${r.status} ${ok ? r.image : r.error}`);
}
for (const url of MUST_FAIL) {
  const r = await read(url);
  const ok = r.status === 502 && typeof r.error === "string";
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} fails   ${url} → ${r.status} ${r.error ?? r.title ?? ""}`);
}
for (const url of MUST_REFUSE) {
  const r = await read(url);
  const ok = r.status === 400;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} refuse  ${url} → ${r.status} ${r.error ?? r.title ?? ""}`);
}
console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
