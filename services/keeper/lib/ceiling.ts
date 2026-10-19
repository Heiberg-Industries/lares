/** B1: exactly 2 GiB reserved. The creation action has no override, including host callers.
 * A measured result is NOT approved merely because this calculation succeeds. */
export const HEADROOM_BYTES = 2 * 1024 ** 3;
/** ESTIMATES, not measurements: what the stack (keeper, console, database, gateway) and one running
 * agent typically need. They only drive the "this looks too high" hint; they never block anything. */
export const STACK_ESTIMATE_BYTES = 2.5 * 1024 ** 3;
export const PER_AGENT_ESTIMATE_BYTES = 1.5 * 1024 ** 3;
/** The highest limit the owner can set through the keeper. */
export const AGENT_LIMIT_MAX = 50;
export function ceilingFor(o: {
    boxMemoryBytes: number;
    stackBytes: number;
    headroomBytes: number;
    perAgentPeakBytes: number;
}): number {
    for (const n of Object.values(o))
        if (!Number.isFinite(n) || n < 0)
            throw new Error('Invalid memory measurement');
    if (o.boxMemoryBytes === 0 || o.perAgentPeakBytes === 0)
        throw new Error('Memory and peak must be positive');
    return Math.max(0, Math.floor((o.boxMemoryBytes - o.stackBytes - o.headroomBytes) / o.perAgentPeakBytes));
}
