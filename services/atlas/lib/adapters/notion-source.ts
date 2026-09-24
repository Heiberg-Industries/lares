// services/atlas/lib/adapters/notion-source.ts
// The `notion:` reader. Takes `getPageMarkdown` as a dependency rather than building a
// client: the real one comes from @lares/notion-sync's makeNotionClient, whose
// truncated-read guard ("refusing to hash a partial read") is exactly the kind of hard-won
// detail a second implementation would quietly drop.
import type { SourceRef } from "../sources.js";
import type { ResolvedSource, SourceReader } from "../resolve.js";

export interface NotionReaderDeps {
  getPageMarkdown(pageId: string): Promise<string>;
}

/** notion-sync's NotionRequestError carries `status`; a bare network failure does not. */
function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

export function makeNotionReader(deps: NotionReaderDeps): SourceReader {
  return {
    id: "notion",
    async read(ref: SourceRef): Promise<ResolvedSource> {
      let markdown: string;
      try {
        markdown = await deps.getPageMarkdown(ref.locator);
      } catch (e) {
        const status = statusOf(e);
        // 404 is the ONE status that means the world changed: the page was deleted, or the
        // integration lost access to it. Everything else — including 401/403/429/5xx and
        // any thrown network error — means we did not find out.
        if (status === 404) {
          return { ref, outcome: "missing", reason: `Notion page ${ref.locator} is gone or no longer shared` };
        }
        const detail = e instanceof Error ? e.message : String(e);
        // notion-sync's client throws a bare Error (no `.status`) once it has exhausted its
        // own retries on repeated 429s — a host we DID reach, repeatedly, not one that is
        // unreachable. Blaming egress there sends a human to the firewall for a problem
        // that is actually "back off and retry later", so that one message shape gets its
        // own reason instead of falling into the network-error default below.
        const rateLimited = status === undefined && /rate limit/i.test(detail);
        return {
          ref, outcome: "failed",
          reason: status !== undefined
            ? `Notion returned ${status} for ${ref.declared} (${detail})`
            : rateLimited
              ? `Notion rate-limited ${ref.declared} and notion-sync's client exhausted its ` +
                `retries (${detail}) — back off and retry later; the host was reachable`
              : `could not reach api.notion.com for ${ref.declared} (${detail}). On the agent ` +
                "box check egress first — a dropped call is NOT a missing page.",
        };
      }
      if (markdown === "") {
        return { ref, outcome: "failed", reason: `Notion returned empty markdown for ${ref.declared}` };
      }
      return { ref, outcome: "found", content: markdown };
    },
  };
}
