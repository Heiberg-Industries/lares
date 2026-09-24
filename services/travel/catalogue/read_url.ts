/**
 * agent/tools/read_url.ts — read the readable text of a web link via the shared readability
 * worker (ORB-158). New — no old-Marcel equivalent.
 *
 * eve-marcel is sealed and its built-in `web_fetch` is deliberately disabled
 * (`agent/tools/web_fetch.ts`): an arbitrary URL from inside the container either hangs
 * against the egress firewall or punches a hole in the boundary the travel-API allowlist
 * exists for. This tool is the sanctioned path instead — the same one eve-saga already
 * ships: a read-only POST to the shared `@lares/readability` worker at `READABILITY_URL`
 * (192.0.2.10, already inside the sealed-container allow in
 * `services/box/ops/egress-saga.nft` — no firewall or squid change rode this tool).
 *
 * Error posture ported with the client (ORB-51): `ReadabilityUnavailableError` = the worker
 * itself is unreachable, `ReadabilityNoContentError` = a real page with no usable article
 * text. Two different situations, two different honest answers — never "not found".
 *
 * W3A-s5 (beyond the slice's own file list — found auditing the three role services'
 * catalogues for the register-completeness test, services/chief-of-staff/tests/
 * origin-taint-reads.test.ts). Structurally identical to `services/chief-of-staff/catalogue/
 * read_url.ts`'s web branch: an arbitrary page's text, brought back by the same read, taints
 * the turn `third_party` after a successful call
 * (docs/specs/2026-09-18-origin-model-design.md, "The in-turn taint rule"). This copy has no
 * Notion/Google-Docs branching to preserve — always one class.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { readUrl, readUrlModelOutput } from "@lares/agent-kit/readability-client";
import { taintTurn, turnKeyFrom } from "@lares/agent-kit/origin-taint";

export default defineTool({
  description:
    "Read a web link — USE THIS whenever someone pastes a URL whose content matters (a hotel " +
    "room page, a restaurant menu, an article, a booking page, a PDF, a picture). Read-only call " +
    "to the shared readability worker: a page comes back as its title + body text, a PDF as its " +
    "text, a picture (JPEG/PNG/GIF/WebP) as the image itself. Never claim a link is unreadable " +
    "without having called this tool; name its failures honestly — 'the reader service is " +
    "unreachable' (ReadabilityUnavailableError), 'the reader couldn't fetch that page' " +
    "(ReadabilityTargetError, with the reason), or 'that page has no readable article text'.",
  inputSchema: z.object({ url: z.string() }),
  async execute({ url }, ctx) {
    const result = await readUrl(url);
    const k = turnKeyFrom(ctx);
    if (k) taintTurn(k, "third_party");
    return result;
  },
  toModelOutput: readUrlModelOutput,
});
