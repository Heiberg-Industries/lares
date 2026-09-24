import { basename } from "node:path";
import { classifyItem, type DigestLlm, type ClassifyContext } from "./classifier.js";
import { fileDecision, type FileNoteFn } from "./filer.js";
import { PROJECTS } from "./types.js";
import { renderDigest, type DigestView } from "./format.js";

export interface RunnerDeps {
  agent: string;
  listInbox(): Promise<{ path: string; body: string }[]>;
  alreadySkipped(): Promise<string[]>;
  noteNames(): Promise<string[]>;
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
  /** Optional URL enrichment: if the item body is a bare URL, replace it with article text before classify. */
  enrich?(item: { path: string; body: string }): Promise<{ path: string; body: string; enriched: boolean }>;
}

export interface DigestSummary {
  filed: { title: string; destination: string }[];
  asked: { title: string; reason: string; suggestedDestination?: string; suggestedType?: string }[];
  errors: { path: string; error: string }[];
}

const IGNORE_BASENAMES = new Set(["README.md"]);

export async function runDigest(deps: RunnerDeps): Promise<DigestSummary> {
  const summary: DigestSummary = { filed: [], asked: [], errors: [] };
  const skipped = new Set(await deps.alreadySkipped());
  const noteNames = await deps.noteNames();
  const ctx: ClassifyContext = { projects: [...PROJECTS], noteNames };

  for (const item of await deps.listInbox()) {
    if (IGNORE_BASENAMES.has(basename(item.path))) continue;
    if (skipped.has(item.path)) continue;
    try {
      const item0 = deps.enrich ? await deps.enrich(item) : item;
      const decision = await classifyItem(item0, ctx, deps.llm);
      if (decision.route === "file") {
        await fileDecision(decision, { path: item.path, body: item0.body, capturedAt: deps.capturedAt }, deps.fileNote);
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

  const empty = !summary.filed.length && !summary.asked.length && !summary.errors.length;
  if (deps.mode === "scheduled" && empty) return summary; // silent on an empty timed run
  const view = renderDigest(summary);
  const res = await deps.post(view);
  const ts = res && typeof res === "object" && "ts" in res ? res.ts : undefined;
  if (view.errorDetail) await deps.postErrorDetail?.(ts, view.errorDetail);
  return summary;
}
