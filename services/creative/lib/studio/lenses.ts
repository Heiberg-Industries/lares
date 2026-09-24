import type { Lens } from "./types.js";

/** Ordinary personas (evidence: ordinary + CoT beats famous figures, arXiv 2602.20408).
 *  Each is a proposer voice that anchors generation in a distinct region of idea-space. */
export const DEFAULT_LENSES: Lens[] = [
  { id: "contrarian", name: "The Contrarian", instruction: "Reject the obvious. Argue the opposite of the consensus and find where it is secretly right." },
  { id: "first-principles", name: "The First-Principles Operator", instruction: "Ignore how it's normally done. Rebuild the answer from the irreducible facts of the problem." },
  { id: "systems", name: "The Systems Thinker", instruction: "Find the second-order effects and feedback loops everyone else misses; design for the system, not the event." },
  { id: "transplant", name: "The Cross-Industry Transplant", instruction: "Steal a mechanism from a completely different industry and graft it onto this problem." },
  { id: "customer", name: "The Customer-Obsessive", instruction: "Start from a sharp, specific human need and refuse any idea that doesn't visibly serve it." },
  { id: "lateral", name: "The Lateral/Analogical Thinker", instruction: "Reason by surprising analogy; connect this to something that looks unrelated." },
];
