// services/creative/lib/studio/pipeline.ts — ported verbatim from the old runtime (ORB-135).
import type { Idea, ScoredIdea, StudioSpreadItem, StudioRun, StudioPipelineDeps } from "./types.js";
import { DEFAULT_LENSES } from "./lenses.js";
import { proposerPrompt, criticPrompt, directorPrompt } from "./prompts.js";
import { extractJson } from "./json.js";

export const COHERENCE_FLOOR = 0.4;
const NEUTRAL = 0.5;          // score for an idea NO critic scored — an id-echo glitch must not read as "incoherent"
const IDEAS_PER_LENS = 3;
const MAX_SPREAD = 8;

type ScoreRow = { id: string; coherence: number; novelty: number; relevance: number };
type DirectorPick = { spread: Array<{ id: string; rationale: string }>; baseline: { title: string; body: string; rationale: string } };

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

export async function runStudioPipeline(brief: string, deps: StudioPipelineDeps): Promise<StudioRun> {
  const lenses = deps.lenses ?? DEFAULT_LENSES;
  const critics = deps.critics ?? 3;
  const consensus = await deps.consensus(brief);

  // ── Stage 3: parallel, independent proposers (no debate). Fail-soft: a lens whose
  //    reply won't parse is DROPPED, not fatal — one misfire must not kill the spread. ──
  const proposed = await Promise.all(lenses.map(async (lens) => {
    try {
      const raw = await deps.llm(proposerPrompt(brief, consensus, lens, IDEAS_PER_LENS));
      const { ideas } = extractJson<{ ideas: Array<{ title: string; body: string; oddsTypical: number }> }>(raw);
      return ideas
        .filter((it) => typeof (it as { title?: unknown }).title === "string" && (it as { title?: unknown }).title !== "")
        .map((it, i): Idea => ({
          id: `${lens.id}-${i}`, lens: lens.id, title: it.title, body: String(it.body ?? ""),
          oddsTypical: typeof it.oddsTypical === "number" ? it.oddsTypical : 0.5,
        }));
    } catch (e) {
      console.warn(`studio: proposer "${lens.id}" failed, dropping it`, e);
      return [] as Idea[];
    }
  }));
  const ideas: Idea[] = proposed.flat();
  if (ideas.length === 0) throw new Error("studio: every proposer failed — no ideas to work with");

  // ── Stage 4: ~3 critics score independently; fail-soft; average over critics that scored. ──
  const scoreSets = (await Promise.all(Array.from({ length: critics }, async () => {
    try {
      const { scores } = extractJson<{ scores: ScoreRow[] }>(await deps.llm(criticPrompt(brief, consensus, ideas)));
      return new Map(scores.map((s) => [s.id, s]));
    } catch (e) {
      console.warn("studio: a critic failed, dropping it", e);
      return null;
    }
  }))).filter((m): m is Map<string, ScoreRow> => m !== null);

  const avg = (id: string, k: keyof Omit<ScoreRow, "id">) => {
    const vals = scoreSets.map((m) => m.get(id)?.[k]).filter((v): v is number => typeof v === "number");
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NEUTRAL;
  };
  // Cull ONLY ideas a critic actually scored and that fell below the floor. An idea no critic
  // scored (id-echo glitch, or all critics failed) passes through with neutral scores — a
  // labelling slip must not silently delete a good idea.
  const scored: ScoredIdea[] = [];
  for (const i of ideas) {
    const seen = scoreSets.filter((m) => m.has(i.id)).length;
    const item: ScoredIdea = {
      ...i,
      coherence: seen ? avg(i.id, "coherence") : NEUTRAL,
      novelty: seen ? avg(i.id, "novelty") : NEUTRAL,
      relevance: seen ? avg(i.id, "relevance") : NEUTRAL,
    };
    if (seen === 0 || item.coherence >= COHERENCE_FLOOR) scored.push(item);
  }

  // dedupe by normalised title, keeping the highest-novelty survivor
  const byTitle = new Map<string, ScoredIdea>();
  for (const i of [...scored].sort((a, b) => b.novelty - a.novelty)) {
    const key = normTitle(i.title);
    if (!byTitle.has(key)) byTitle.set(key, i);
  }
  const survivors = [...byTitle.values()];

  // ── Stage 5: director curates the spread + a deliberate baseline. Fail-soft: on a bad
  //    director reply, fall back to the top survivors by novelty so the user ALWAYS gets a spread. ──
  let picked: DirectorPick | null = null;
  try {
    picked = extractJson<DirectorPick>(await deps.llm(directorPrompt(brief, consensus, survivors)));
  } catch (e) {
    console.warn("studio: director failed, using deterministic fallback", e);
  }

  const byId = new Map(survivors.map((s) => [s.id, s]));
  const spread: StudioSpreadItem[] = [];
  for (const p of picked?.spread ?? []) {
    const s = byId.get(p.id);
    if (s) spread.push({ ...s, kind: "outlier", rationale: p.rationale });
  }
  if (spread.length === 0) {
    for (const s of [...survivors].sort((a, b) => b.novelty - a.novelty).slice(0, MAX_SPREAD)) {
      spread.push({ ...s, kind: "outlier", rationale: "(selected by novelty)" });
    }
  }
  const baseline = picked?.baseline ?? {
    title: "The conventional approach",
    body: "The obvious, safe default for this brief.",
    rationale: "included as a baseline to judge the outliers against",
  };
  spread.push({
    id: "baseline", lens: "baseline", title: baseline.title, body: baseline.body,
    oddsTypical: 1, coherence: 1, novelty: 0, relevance: 1, kind: "baseline", rationale: baseline.rationale,
  });

  return { brief, consensus, spread };
}
