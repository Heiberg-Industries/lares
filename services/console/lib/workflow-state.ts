import type { FleetSnapshot } from "./console-overview";
export function workflowState(
  snapshot: FleetSnapshot,
  agent: string,
): "unavailable" | "failed" | "waiting" | "running" | "idle" {
  if (!snapshot.workflows.available) return "unavailable";
  const mine = snapshot.workflows.value.filter(
    (r) => r.agent === agent && r.n > 0,
  );
  if (mine.some((r) => r.status === "failed")) return "failed";
  if (mine.some((r) => r.status === "waiting")) return "waiting";
  if (mine.some((r) => r.status === "running" || r.status === "pending"))
    return "running";
  return "idle";
}
