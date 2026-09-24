/**
 * The voice-learn engine, ported from services/agent-runtime/lib/voice/learn.ts.
 *
 * Take a mailbox's Sent mail, keep genuine email prose (drop forwards, one-liners,
 * quoted-only replies and long-form essays), embed and upsert each kept email as a
 * language-tagged exemplar, then distil a PROPOSED bilingual card. The ACTIVE card is never
 * written here — proposals are accepted by a human in the console. That separation is the
 * whole safety model of this job: it can only ever add examples and suggest wording.
 *
 * Two changes from the original, both deliberate:
 *
 *  - **Per-mailbox.** The old job resolved every Google account, split its cap across them
 *    and pooled the results into one corpus (`bin/voice-learn.ts:73-82`), so one blended
 *    voice stood in for two audiences. This engine learns ONE mailbox per call; the schedule
 *    runs it once per enrolled mailbox. See `sql/026_voice_per_mailbox.sql`.
 *  - **Batched embedding.** The original embedded one email per gateway call inside the keep
 *    loop — up to `learn_cap` (300) billed round trips per run. Same vectors, same order,
 *    far fewer calls. It also bounds the blast radius differently: a failed batch loses that
 *    batch rather than one email, which is fine because upserts are idempotent by
 *    (mailbox, id) and a re-run redoes only what is missing.
 *
 * The card distillation is the only LLM call, and it is made ONCE per run over a capped
 * sample — not per email. That matters: the Aug-14/15 incident was a billed call inside an
 * uncapped retry, and this job's cost must stay proportional to mail volume, nothing else.
 */
import { detectLanguage } from "./voice.js";

/** The subset of a sent message this engine needs. Structurally compatible with
 *  `lib/google.ts`'s MailMessage, declared locally so the engine stays testable without a
 *  Gmail client. */
export interface SentMessage {
  id: string;
  subject: string;
  bodyText: string;
}

const FORWARD_RE = /^(fwd?|vs):/i;
const FORWARD_BODY_RE = /-{3,}\s*forwarded message|videresendt melding/i;
const QUOTE_TAIL_RE = /(?:^|\n)\s*(on .+wrote:|den .+skrev:)\s*\n[\s\S]*$/i;

/** Drop quoted reply tails and >-prefixed lines so we score only what Bendik actually wrote.
 *  Without this the corpus would mostly learn the voices of the people he replies TO. */
export function stripQuoted(body: string): string {
  const noTail = body.replace(QUOTE_TAIL_RE, "");
  return noTail.split(/\r?\n/).filter((l) => !l.trimStart().startsWith(">")).join("\n");
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const MIN_WORDS = 8;
const MAX_WORDS = 400;

/** How many emails are embedded per gateway call. Small enough that one failure is cheap to
 *  redo, large enough that a 300-email run is ~10 calls instead of 300. */
const EMBED_BATCH = 32;

/** Pure filter: the kept emails plus why each drop happened (the reasons are logged, so a
 *  surprisingly small corpus can be explained rather than guessed at). */
export function selectExemplars(messages: SentMessage[]): { kept: SentMessage[]; dropped: Array<{ id: string; reason: string }> } {
  const kept: SentMessage[] = [];
  const dropped: Array<{ id: string; reason: string }> = [];
  for (const m of messages) {
    if (FORWARD_RE.test(m.subject) || FORWARD_BODY_RE.test(m.bodyText)) { dropped.push({ id: m.id, reason: "forward" }); continue; }
    const prose = stripQuoted(m.bodyText).trim();
    const words = wordCount(prose);
    if (words === 0) { dropped.push({ id: m.id, reason: "quoted_only" }); continue; }
    if (words < MIN_WORDS) { dropped.push({ id: m.id, reason: "too_short" }); continue; }
    if (words > MAX_WORDS) { dropped.push({ id: m.id, reason: "too_long" }); continue; }
    kept.push({ ...m, bodyText: prose });
  }
  return { kept, dropped };
}

/** Parse the distilled card, tolerating a ```json fence. */
export function parseProposedCard(raw: string): { core: string; english: string; norsk: string } {
  const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
  const o = JSON.parse(cleaned) as { core?: string; english?: string; norsk?: string };
  return { core: String(o.core ?? ""), english: String(o.english ?? ""), norsk: String(o.norsk ?? "") };
}

export interface LearnExemplar { id: string; mailbox: string; lang: "en" | "no"; text: string; vector: number[]; sourceMessageId: string }

export interface ProposedCard { core: string; english: string; norsk: string; learnedAt: string; sampleSize: number }

export interface LearnDeps {
  mailbox: string;
  listSentMessages(): Promise<SentMessage[]>;
  embedder: { embed(t: string[]): Promise<number[][]> };
  think(prompt: string): Promise<string>;
  upsertExemplar(e: LearnExemplar): Promise<void>;
  setProposed(p: ProposedCard): Promise<void>;
  setStatus(status: "running" | "idle" | "error", message?: string): Promise<void>;
  now?(): Date;
}

export interface PacedReadOptions {
  /** Reads per batch before a pause. */
  batch: number;
  /** Pause between batches. */
  pauseMs: number;
  /** One back-off on a quota error before the same id is retried; a second failure propagates. */
  backoffMs: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const QUOTA_ERROR = /quota exceeded|rateLimitExceeded|userRateLimitExceeded|\b429\b/i;

/**
 * Sequential reads that respect Gmail's per-minute quota (2026-09-08: the owner.example relearn
 * failed twice on "Units per minute per user" — up to 300 `messages.get` calls in a tight loop).
 * Pauses after every `batch` reads; on a quota error backs off ONCE and retries that id — a second
 * failure propagates, so a run that cannot proceed ends as `error` on the mailbox's card instead of
 * hammering the API every minute (the Aug-14/15 lesson). `null` reads are dropped.
 */
export async function readPaced<T>(
  ids: readonly string[],
  read: (id: string) => Promise<T | null>,
  opts: PacedReadOptions,
): Promise<T[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const out: T[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    let m: T | null;
    try {
      m = await read(id);
    } catch (err) {
      if (!QUOTA_ERROR.test(err instanceof Error ? err.message : String(err))) throw err;
      await sleep(opts.backoffMs);
      m = await read(id);
    }
    if (m !== null) out.push(m);
    if ((i + 1) % opts.batch === 0 && i + 1 < ids.length) await sleep(opts.pauseMs);
  }
  return out;
}

/** Build the distillation prompt from a balanced sample of kept emails. */
function distillPrompt(kept: SentMessage[], mailbox: string): string {
  const sample = kept.slice(0, 40);
  const block = sample.map((m, i) => `--- email ${i + 1} ---\n${m.bodyText}`).join("\n\n");
  // ORB-176: one card per mailbox. Bendik writes differently from owner@owner.example (partners,
  // press, the portfolio) than from owner@project.example (sales) — the card must describe THIS
  // mailbox, not "his email voice" in general.
  return (
    `Below are real emails Bendik has sent FROM ${mailbox}. Distil how he writes from this mailbox ` +
    `specifically — his EMAIL voice for these correspondents (NOT essay/long-form voice) — into a short, ` +
    `plain-English style guide. Return ONLY JSON: {"core": "...", "english": "...", "norsk": "..."} where ` +
    `"core" = shared traits (tone, length, openings, sign-offs, what he avoids), "english" = notes specific to ` +
    `his English email, "norsk" = notes specific to his Norwegian email. Keep each field to a few short bullet ` +
    `lines. Describe how he actually writes from this mailbox; do not invent.\n\n${block}`
  );
}

export async function runVoiceLearn(deps: LearnDeps): Promise<{ kept: number; dropped: number }> {
  const now = deps.now ?? (() => new Date());
  await deps.setStatus("running");
  try {
    const messages = await deps.listSentMessages();
    const { kept, dropped } = selectExemplars(messages);

    for (let i = 0; i < kept.length; i += EMBED_BATCH) {
      const batch = kept.slice(i, i + EMBED_BATCH);
      const vectors = await deps.embedder.embed(batch.map((m) => m.bodyText));
      for (const [j, m] of batch.entries()) {
        const vector = vectors[j];
        // A short vector array would silently mis-pair emails with other emails' embeddings,
        // producing a corpus that retrieves confidently wrong examples. Refuse instead.
        if (vector === undefined) throw new Error(`embedder returned ${vectors.length} vectors for ${batch.length} inputs`);
        await deps.upsertExemplar({
          id: m.id, mailbox: deps.mailbox, lang: detectLanguage(m.bodyText), text: m.bodyText, vector, sourceMessageId: m.id,
        });
      }
    }

    // Distil only when there is something to distil — an empty sample would have the model
    // invent a voice from nothing, and the proposed card is a human-facing suggestion.
    if (kept.length > 0) {
      const card = parseProposedCard(await deps.think(distillPrompt(kept, deps.mailbox)));
      await deps.setProposed({ ...card, learnedAt: now().toISOString(), sampleSize: kept.length });
    }

    await deps.setStatus("idle");
    return { kept: kept.length, dropped: dropped.length };
  } catch (err) {
    await deps.setStatus("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
}
