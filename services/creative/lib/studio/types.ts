/** One ordinary-persona proposer voice (NOT a famous figure — evidence: arXiv 2602.20408). */
export interface Lens { id: string; name: string; instruction: string; }

export interface Idea { id: string; lens: string; title: string; body: string; oddsTypical: number; }
export interface ScoredIdea extends Idea { coherence: number; novelty: number; relevance: number; }
export interface StudioSpreadItem extends ScoredIdea { kind: "outlier" | "baseline"; rationale: string; }

/** The result of one studio run — also the persisted/displayed unit. */
export interface StudioRun { brief: string; consensus: string; spread: StudioSpreadItem[]; }

/** The swap seam: v1 = runStudioPipeline; phase-2 = a QD/MAP-Elites ideator. */
export interface Ideator { ideate(brief: string): Promise<StudioRun>; }

export interface StudioPipelineDeps {
  /** Brief → "what is already obvious/known here" (Brain in v1, + corpus in v1.5). */
  consensus: (brief: string) => Promise<string>;
  /** Injected gateway LLM — `(prompt) => Promise<string>` (makeGatewayLlm in prod, a fake in tests). */
  llm: (prompt: string) => Promise<string>;
  lenses?: Lens[];   // defaults to DEFAULT_LENSES
  critics?: number;  // default 3 (the evidence sweet spot)
}
