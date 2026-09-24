import type { Lens, Idea, ScoredIdea } from "./types.js";

export function proposerPrompt(brief: string, consensus: string, lens: Lens, n: number): string {
  return `ROLE: PROPOSER — ${lens.name}
You are one voice on a creative team. ${lens.instruction}

BRIEF:
${brief}

CONSENSUS (the obvious/known takes — go ORTHOGONAL to these, do not repeat them):
${consensus}

Produce ${n} genuinely distinct ideas from your vantage point. Be specific and concrete.
For each, estimate "oddsTypical": your 0–1 guess that a typical consultant would ALSO propose it
(LOWER = more original — aim low without becoming incoherent).

Return ONLY JSON:
{"ideas":[{"title":"...","body":"...","oddsTypical":0.0}]}`;
}

export function criticPrompt(brief: string, consensus: string, ideas: Idea[]): string {
  const list = ideas.map((i) => `- ${i.id}: ${i.title} — ${i.body}`).join("\n");
  return `ROLE: CRITIC
Score each idea independently. Do NOT collapse to one winner.

BRIEF:
${brief}

CONSENSUS (novelty = distance FROM this — closer to consensus means LOWER novelty):
${consensus}

IDEAS:
${list}

For each id score 0–1: coherence (is it sound/feasible?), novelty (distance from consensus),
relevance (does it serve the brief?).
Echo each id EXACTLY as written above — do not rename, reformat, or omit any id.

Return ONLY JSON:
{"scores":[{"id":"...","coherence":0.0,"novelty":0.0,"relevance":0.0}]}`;
}

export function directorPrompt(brief: string, consensus: string, survivors: ScoredIdea[]): string {
  const list = survivors.map((s) => `- ${s.id}: ${s.title} — ${s.body} [coherence ${s.coherence}, novelty ${s.novelty}]`).join("\n");
  return `ROLE: DIRECTOR — elite creative director.
From the SURVIVORS, curate a DIVERSE spread of 5–8 (favour novelty + coherence; avoid near-duplicates).
ALSO write exactly one strong CONVENTIONAL baseline idea so each outlier can be judged against the obvious.

BRIEF:
${brief}

CONSENSUS:
${consensus}

SURVIVORS:
${list}

Return ONLY JSON:
{"spread":[{"id":"...","rationale":"one line"}],"baseline":{"title":"...","body":"...","rationale":"why this is the safe default"}}`;
}
