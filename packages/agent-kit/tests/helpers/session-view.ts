import { emptySessionView, foldEvents, position } from "eve/events";

/**
 * A REAL eve 1.0 session view whose stream position is `line`: built by folding real stream lines
 * with eve's own `foldEvents`, one `model.requested` fact per line, so `position(view)` is eve's own
 * answer and nothing from `eve/events` needs replacing. The model resolver reads only the position
 * (it stands in for the step number), and what tests vary is the position, not the fold.
 */
export function viewAt(line: number): ReturnType<typeof emptySessionView> {
  if (!Number.isSafeInteger(line) || line < 1) throw new Error("a view needs at least one line");
  const events = Array.from({ length: line }, (_, i) => ({
    type: "model.requested",
    scope: { turnId: "turn_0", runId: `run_${i}` },
    data: { runId: `run_${i}`, owner: { turnId: "turn_0" } },
    meta: { position: { line: i, index: 0 }, at: "2026-01-01T00:00:00.000Z" },
  }));
  const view = foldEvents(emptySessionView(), events as never) as unknown as ReturnType<typeof emptySessionView>;
  const reached = position(view);
  if (reached !== line) throw new Error(`built a view at position ${reached}, wanted ${line}`);
  return view;
}
