/** Defensively pull JSON out of a model reply. Models wrap JSON in prose or ```json fences
 *  and sometimes write a stray brace in the preamble — so we try a fenced block first, then
 *  EVERY balanced {…}/[…] span in order, returning the first that actually parses. Only if
 *  none parses do we throw. */
export function extractJson<T>(raw: string): T {
  const candidates: string[] = [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) candidates.push(fence[1].trim());
  for (const span of balancedSpans(raw)) candidates.push(span);
  for (const c of candidates) {
    try { return JSON.parse(c) as T; } catch { /* stray/invalid span — try the next */ }
  }
  throw new Error(`extractJson: no JSON could be parsed from model output`);
}

/** Yield each balanced {…} or […] span, one per opening bracket, in document order. */
function* balancedSpans(raw: string): Generator<string> {
  for (let start = 0; start < raw.length; start++) {
    const open = raw[start];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) { depth--; if (depth === 0) { yield raw.slice(start, i + 1); break; } }
    }
  }
}
