// services/agent-runtime/lib/adapters/digest/types.ts
export type DigestType = "transcript" | "inspiration" | "writing-seed" | "reference" | "person-signal";
export type DigestRoute = "file" | "ask";

export interface DigestDecision {
  route: DigestRoute;
  type: DigestType;
  project?: string;       // required (and validated) when type === "transcript"
  destination: string;    // vault-relative folder the filer will write into
  title: string;
  summary: string;        // 2–4 lines
  links: string[];        // proposed [[wikilinks]] (basenames); validated downstream
  reason: string;         // one line, for the audit/ask
}

/** Projects that have a transcripts/ folder (a transcript must map to one of these). */
export const PROJECTS = ["zero7", "murmur", "orakel", "Heiberg Industries"] as const;

/** type → destination folder. transcript is special (per-project); others are fixed. */
export const DESTINATIONS: Record<Exclude<DigestType, "transcript" | "person-signal">, string> = {
  inspiration: "inspiration",
  "writing-seed": "writing-seeds",
  reference: "reads",
};

/** Only classify on the head of the body — enough to judge type, bounds token cost. */
export const BODY_CHARS_FOR_CLASSIFY = 6000;
