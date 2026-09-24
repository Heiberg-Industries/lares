/**
 * EU embeddings through the LiteLLM gateway (OpenAI-compatible /v1/embeddings). Ported from
 * services/agent-runtime/lib/adapters/embeddings-gateway.ts. Keeps the corpus in memory
 * (small, single enrolled user) and does cosine top-k — no vector DB needed at this scale.
 *
 * identity-encoding: 2026-08-14/15 cost incident (see lib/gateway-provider.ts's
 * IDENTITY_ENCODING_HEADERS) — this is a raw fetch against the same gateway, so it carries
 * the same header defensively even though embeddings weren't implicated in the original
 * incident.
 */
import { IDENTITY_ENCODING_HEADERS } from "./gateway-provider.js";

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>;
}>;

export function makeGatewayEmbedder(deps: { gatewayUrl: string; apiKey: string; model: string; fetchImpl?: FetchLike }) {
  const fetchFn: FetchLike = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  const endpoint = `${deps.gatewayUrl.replace(/\/$/, "")}/v1/embeddings`;
  return {
    async embed(texts: string[]): Promise<number[][]> {
      const res = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.apiKey}`,
          "Content-Type": "application/json",
          ...IDENTITY_ENCODING_HEADERS,
        },
        body: JSON.stringify({ model: deps.model, input: texts }),
      });
      if (!res.ok) throw new Error(`gateway embeddings → ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      return json.data.map((d) => d.embedding);
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
