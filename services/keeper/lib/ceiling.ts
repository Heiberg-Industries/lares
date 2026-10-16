/** B1: exactly 2 GiB reserved. The creation action has no override, including host callers.
 * A measured result is NOT approved merely because this calculation succeeds. */
export const HEADROOM_BYTES = 2 * 1024 ** 3;
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
