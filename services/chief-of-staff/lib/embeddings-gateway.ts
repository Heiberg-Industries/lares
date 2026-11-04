/**
 * EU embeddings through the LiteLLM gateway (OpenAI-compatible /v1/embeddings). Keeps the
 * corpus in memory (small, single enrolled user) and does cosine top-k — no vector DB needed
 * at this scale.
 *
 * An embedding call runs outside any conversation (a schedule, or a tool in someone's chat), so it
 * goes through the owner-job path: one Keeper ticket per request, charged to the installation owner.
 * There is no gateway key and no direct fetch here.
 */
import { GATEWAY_EMBEDDINGS_MODEL_PATH } from "@lares/agent-kit/gateway-admission-protocol";
import { dispatchOwnerJob } from "@lares/agent-kit/owner-job";

/** The gateway accepts at most this many inputs in one embeddings request. */
export const EMBED_MAX_INPUTS = 32;
/** The gateway's default for the longest single input, in tokens. */
export const EMBED_DEFAULT_MAX_INPUT_TOKENS = 8192;

type PostLike = (body: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** Cut a text to at most `maxChars` characters without splitting a character. A token is never
 *  shorter than one character, so a character bound equal to the token limit always fits. */
export function cutToFit(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return Array.from(text).slice(0, maxChars).join("");
}

export function makeGatewayEmbedder(deps: { model: string; maxInputTokens?: number; post?: PostLike }) {
  const maxChars = deps.maxInputTokens ?? EMBED_DEFAULT_MAX_INPUT_TOKENS;
  const post: PostLike = deps.post ?? ((body) => dispatchOwnerJob({
    alias: deps.model, path: GATEWAY_EMBEDDINGS_MODEL_PATH, rawBody: Buffer.from(body, "utf8"),
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  }));
  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length < 1 || texts.length > EMBED_MAX_INPUTS) throw new Error(`gateway embeddings take 1 to ${EMBED_MAX_INPUTS} inputs, got ${texts.length}`);
      const input = texts.map((t) => cutToFit(t, maxChars));
      if (input.some((t) => t.trim() === "")) throw new Error("gateway embeddings refuse an empty input");
      const res = await post(JSON.stringify({ model: deps.model, input, encoding_format: "float" }));
      if (!res.ok) throw new Error(`gateway embeddings → ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
      const json = (await res.json()) as { data?: { index?: unknown; embedding?: unknown }[] };
      const data = json.data;
      if (!Array.isArray(data) || data.length !== input.length) throw new Error("gateway embeddings returned the wrong number of vectors");
      const out: number[][] = new Array(input.length);
      for (const d of data) {
        if (!Number.isInteger(d.index) || (d.index as number) < 0 || (d.index as number) >= input.length || out[d.index as number] !== undefined ||
            !Array.isArray(d.embedding) || d.embedding.length === 0 || d.embedding.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
          throw new Error("gateway embeddings returned a malformed vector");
        }
        out[d.index as number] = d.embedding as number[];
      }
      const width = out[0]!.length;
      if (out.some((v) => v.length !== width)) throw new Error("gateway embeddings returned vectors of different lengths");
      return out;
    },
  };
}

export interface VoiceExemplar { id: string; text: string; vector: number[]; lang?: "en" | "no" }

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export function makeVoiceStore(deps: { embedder: { embed(t: string[]): Promise<number[][]> }; exemplars: VoiceExemplar[] }) {
  return {
    async retrieve(query: string, k: number, opts?: { lang?: "en" | "no" }): Promise<string[]> {
      const pool = opts?.lang ? deps.exemplars.filter((e) => e.lang === opts.lang) : deps.exemplars;
      if (pool.length === 0) return [];
      const [q] = await deps.embedder.embed([query]);
      return [...pool]
        .map((e) => ({ text: e.text, score: cosine(q, e.vector) }))
        .sort((x, y) => y.score - x.score)
        .slice(0, k)
        .map((e) => e.text);
    },
  };
}
