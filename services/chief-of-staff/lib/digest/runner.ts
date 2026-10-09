import { basename } from "node:path";
import { classifyArticle, classifyItem, type DigestLlm, type ClassifyContext } from "./classifier.js";
import { parseInboxClip, type ArticleArea } from "./article.js";
import type { FileArticleFn } from "./article-file.js";
import { legacyEnrichedBody, type EnrichedItem } from "./enrich.js";
import { fileDecision, type FileNoteFn } from "./filer.js";
import { renderDigest, type DigestView } from "./format.js";

export interface RunnerDeps {
  agent: string;
  listInbox(): Promise<{ path: string; body: string }[]>;
  alreadySkipped(): Promise<string[]>;
  noteNames(): Promise<string[]>;
  /**
   * The projects a transcript may be filed under, read from the private store at run time
   * (see `listTranscriptProjects`). Empty is fine: transcripts then go to "ask".
   */
  projects(): Promise<string[]>;
  llm: DigestLlm;
  fileNote: FileNoteFn;
  recordSkip(path: string, reason: string): Promise<void>;
  /** Post the rendered digest summary (Block Kit + text fallback). Returns the message id. */
  post(view: DigestView): Promise<{ ts?: string } | void>;
  /** Post the error detail as a reply in the summary's thread (paths never go in the main message). */
  postErrorDetail?(parentTs: string | undefined, text: string): Promise<void>;
  /** "scheduled" runs stay silent when fully empty; "on-demand" always posts. */
  mode: "scheduled" | "on-demand";
  capturedAt: string;
  log?(m: string): void;
  /**
   * Optional URL enrichment: when the item is a saved link the reader can open, the page comes
   * back beside the item (`article`), and the item's own body is left as it was.
   */
  enrich?(item: { path: string; body: string }): Promise<EnrichedItem>;
  /**
   * Files a saved link as an article note. Absent, a fetched page is classified and filed the way
   * it always was (the page text stands in for the item's body), so a pass that has not been set
   * up for articles behaves as before.
   */
  fileArticle?: FileArticleFn;
  /**
   * Told where each article ended up (including a link that was already filed). A failure here is
   * logged and never fails the filing: the article is already in the vault.
   */
  onFiled?(inboxPath: string, filed: { area: ArticleArea; destPath: string }): Promise<void> | void;
  /**
   * The most model calls one pass may make; items past it stay in the inbox, are not even fetched,
   * and are counted in a notice. Default 20 when `fileArticle` is set, otherwise no ceiling.
   */
  maxClassify?: number;
  /**
   * One-line notices from steps that ran before the digest (LAR-113: a clipping fetch that failed).
   * Any notice makes the pass worth posting, even when the inbox is otherwise empty, so a failure
   * is never swallowed by a quiet scheduled run.
   */
  notices?: string[];
}

export interface DigestSummary {
  filed: { title: string; destination: string }[];
  asked: { title: string; reason: string; suggestedDestination?: string; suggestedType?: string }[];
  errors: { path: string; error: string }[];
  /** Lines from earlier steps (see RunnerDeps.notices). Absent means none. */
  notices?: string[];
}

const IGNORE_BASENAMES = new Set(["README.md"]);

/** Model calls per pass once articles are being filed (one call per article). */
export const DEFAULT_MAX_CLASSIFY = 20;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export async function runDigest(deps: RunnerDeps): Promise<DigestSummary> {
  const summary: DigestSummary = { filed: [], asked: [], errors: [], notices: [...(deps.notices ?? [])] };
  const skipped = new Set(await deps.alreadySkipped());
  const noteNames = await deps.noteNames();
  const projects = await deps.projects();
  const ctx: ClassifyContext = { projects: [...projects], noteNames };
  const limit = deps.maxClassify ?? (deps.fileArticle ? DEFAULT_MAX_CLASSIFY : Number.POSITIVE_INFINITY);
  let modelCalls = 0;
  let heldBack = 0;
  let filedPrivately = 0;

  for (const item of await deps.listInbox()) {
    if (IGNORE_BASENAMES.has(basename(item.path))) continue;
    if (skipped.has(item.path)) continue;
    // Checked before the page is fetched: an item past the ceiling costs nothing this pass.
    if (modelCalls >= limit) {
      heldBack += 1;
      continue;
    }
    try {
      const item0: EnrichedItem = deps.enrich ? await deps.enrich(item) : { ...item, enriched: false };

      if (item0.article && deps.fileArticle) {
        const article = item0.article;
        const filed = await deps.fileArticle({
          inboxPath: item.path,
          inboxBody: item.body,
          article,
          today: deps.capturedAt,
          classify: async () => {
            modelCalls += 1;
            const decision = await classifyArticle(
              { title: article.title, url: article.url, ownerNote: parseInboxClip(item.body).note, text: article.text },
              { noteNames },
              deps.llm,
            );
            if (decision.unreadable) deps.log?.(`could not read the classifier's reply for ${item.path}; filing it with no summary`);
            return decision;
          },
        });
        if (filed.fellBack) filedPrivately += 1;
        if (!filed.duplicate) summary.filed.push({ title: filed.title, destination: "articles" });
        deps.log?.(`${filed.duplicate ? "already filed" : "filed"} ${item.path} → articles (${filed.area})`);
        try {
          await deps.onFiled?.(item.path, { area: filed.area, destPath: filed.destPath });
        } catch (err) {
          deps.log?.(`could not record where ${item.path} went: ${String(err instanceof Error ? err.message : err)}`);
        }
        continue;
      }

      // Not an article, or nothing is set up to file one: the page (if any) stands in for the body.
      const body = item0.article ? legacyEnrichedBody(item0.article) : item0.body;
      modelCalls += 1;
      const decision = await classifyItem({ path: item0.path, body }, ctx, deps.llm);
      if (decision.route === "file") {
        await fileDecision(decision, { path: item.path, body, capturedAt: deps.capturedAt }, deps.fileNote);
        summary.filed.push({ title: decision.title, destination: decision.destination });
        deps.log?.(`filed ${item.path} → ${decision.destination}`);
      } else {
        await deps.recordSkip(item.path, decision.reason);
        summary.asked.push({
          title: decision.title, reason: decision.reason,
          suggestedDestination: decision.destination, suggestedType: decision.type,
        });
        deps.log?.(`asked about ${item.path}: ${decision.reason}`);
      }
    } catch (err) {
      summary.errors.push({ path: item.path, error: String(err instanceof Error ? err.message : err) });
      deps.log?.(`ERROR ${item.path}: ${String(err instanceof Error ? err.message : err)}`);
    }
  }

  if (filedPrivately > 0) {
    summary.notices?.push(
      `The shared area is not connected, so ${plural(filedPrivately, "article was", "articles were")} filed in the private area.`,
    );
  }
  if (heldBack > 0) {
    summary.notices?.push(`${plural(heldBack, "more saved item", "more saved items")} will be filed in the next pass.`);
  }

  const empty = !summary.filed.length && !summary.asked.length && !summary.errors.length && !summary.notices?.length;
  if (deps.mode === "scheduled" && empty) return summary; // silent on an empty timed run
  const view = renderDigest(summary);
  const res = await deps.post(view);
  const ts = res && typeof res === "object" && "ts" in res ? res.ts : undefined;
  if (view.errorDetail) await deps.postErrorDetail?.(ts, view.errorDetail);
  return summary;
}
