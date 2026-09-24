/**
 * DB-backed access to the voice: the editable card (voice_profile, singleton) and the
 * language-tagged exemplar corpus (voice_exemplar, included rows only) — the latter scoped
 * to ONE MAILBOX.
 *
 * The card and the corpus split differently on purpose (Bendik, 2026-08-18): the card holds
 * the RULES, which describe one human and are shared across mailboxes; the corpus holds
 * EXAMPLES, which are audience-specific — owner@owner.example and owner@project.example write to
 * different people. Grounding a Zero7 draft in Heiberg examples is the thing this scoping
 * prevents; before it, both were pooled into one indistinguishable blend
 * (sql/026_voice_per_mailbox.sql explains what happened to those rows).
 *
 * Ported from
 * services/agent-runtime/lib/voice/store.ts — reads the SAME existing tables
 * (services/box/sql/013_voice.sql), shared Postgres, no new migration for this piece.
 * Loaded fresh per draft (a handful of drafts/day) so console edits + re-learns take effect
 * without a restart.
 */
import type { Pool } from "pg";
import { pickCard } from "./voice.js";
import { gatewayUrl, gatewayKey } from "./gateway-provider.js";
import { makeGatewayEmbedder, makeVoiceStore, type VoiceExemplar } from "./embeddings-gateway.js";
import type { Lang, VoiceProfile } from "./voice.js";

export interface VoiceAccess {
  getProfile(): Promise<VoiceProfile | null>;
  retrieve(query: string, k: number, lang: Lang): Promise<string[]>;
}

/** Raised when the corpus cannot be searched — the gateway refused the embedding call, the
 *  query could not be embedded, the table is unreachable. Deliberately DISTINCT from an
 *  empty result (ORB-119, and the ORB-51 posture generally): for six weeks eve-saga's
 *  gateway key could not reach the embedding model, every `retrieve()` 401'd, and all three
 *  call sites swallowed it as "no similar emails found" — so 151 usable exemplars sat unread
 *  and nothing anywhere said so.
 *
 *  Callers are still expected to CONTINUE on this: examples are grounding, not a hard
 *  dependency, and a draft written from the rules alone is far better than no draft. What
 *  they must not do is treat it as evidence that the corpus is empty. */
export class VoiceRetrievalUnavailableError extends Error {
  constructor(readonly mailbox: string, override readonly cause: unknown) {
    super(`voice retrieval unavailable for ${mailbox}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "VoiceRetrievalUnavailableError";
  }
}

interface ProfileRow { id: string; core: string; english: string; norsk: string; model_en: string | null; model_no: string | null }
interface ExemplarRow { id: string; text: string; lang: "en" | "no"; vector: unknown }

/**
 * The card for ONE mailbox (ORB-176, sql/033): the mailbox's own `voice_profile` row when it
 * says anything, else `default`. The model-alias overrides always come from `default` — they
 * are a portfolio setting, not a register. `mailbox` omitted = the `default` card alone
 * (callers that predate per-mailbox cards).
 */
export async function loadVoiceProfile(db: Pool, mailbox = "default"): Promise<VoiceProfile | null> {
  const res = await db
    .query<ProfileRow>(
      `SELECT id, core, english, norsk, model_en, model_no FROM voice_profile WHERE id IN ($1, 'default')`,
      [mailbox],
    )
    .catch(() => ({ rows: [] as ProfileRow[] }));
  const card = pickCard(res.rows, mailbox);
  if (!card) return null;
  const def = res.rows.find((r) => r.id === "default");
  return { ...card, modelEn: def?.model_en ?? null, modelNo: def?.model_no ?? null };
}

/** Scoped to one mailbox — see the module header. A mailbox with no corpus yet returns [],
 *  which is a real, expected state (a newly enrolled account before its first learn run) and
 *  is why this is not itself an error. */
export async function loadVoiceExemplars(db: Pool, mailbox: string): Promise<VoiceExemplar[]> {
  const res = await db
    .query<ExemplarRow>(`SELECT id, text, lang, vector FROM voice_exemplar WHERE included = true AND mailbox = $1`, [mailbox])
    .catch(() => ({ rows: [] as ExemplarRow[] }));
  return res.rows.map((r) => ({
    id: r.id,
    text: r.text,
    lang: r.lang,
    vector: Array.isArray(r.vector) ? (r.vector as number[]) : (JSON.parse(String(r.vector)) as number[]),
  }));
}

/** Real callers omit `embedder`, wiring the live gateway — deferred until `retrieve()`
 *  actually needs to embed a query (never on an empty/no-exemplars-for-language pool), same
 *  build/test-has-no-secrets contract as gateway-provider.ts. Constructing this object must
 *  read no secret: a caller that only ever calls `getProfile()`, or calls `retrieve()` when
 *  there is nothing to search, must not need a gateway key file to exist at all. Tests inject
 *  a fake embedder to exercise the real `db` against a real Postgres without a live model
 *  call. */
export function makeDbVoiceAccess(deps: {
  db: Pool; mailbox: string; embedModel?: string; embedder?: { embed(t: string[]): Promise<number[][]> };
}): VoiceAccess {
  const embedder = deps.embedder ?? {
    embed: (texts: string[]) => makeGatewayEmbedder({
      gatewayUrl: gatewayUrl(), apiKey: gatewayKey(), model: deps.embedModel ?? process.env["EMBED_MODEL"] ?? "heiberg-embed",
    }).embed(texts),
  };
  return {
    getProfile: () => loadVoiceProfile(deps.db, deps.mailbox),
    async retrieve(query, k, lang) {
      const exemplars = await loadVoiceExemplars(deps.db, deps.mailbox);
      // No exemplars for this mailbox/language is a genuine empty, not a failure: skip the
      // embedding call entirely (it would be billed for nothing) and say so plainly.
      if (exemplars.length === 0) return [];
      try {
        return await makeVoiceStore({ embedder, exemplars }).retrieve(query, k, { lang });
      } catch (err) {
        throw new VoiceRetrievalUnavailableError(deps.mailbox, err);
      }
    },
  };
}
