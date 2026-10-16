import { expect, it } from 'vitest';
import { ceilingFor, HEADROOM_BYTES } from '../lib/ceiling.js';
it('uses fixed two GiB headroom and rounds down without a host override', () => {
 expect(HEADROOM_BYTES).toBe(2 * 1024 ** 3);
 expect(ceilingFor({boxMemoryBytes:32e9,stackBytes:12e9,headroomBytes:2e9,perAgentPeakBytes:2.5e9})).toBe(7);
 expect(ceilingFor({boxMemoryBytes:8e9,stackBytes:7e9,headroomBytes:2e9,perAgentPeakBytes:2e9})).toBe(0);
});
it.each([0,-1,NaN,Infinity])('rejects invalid peak %s', peak => {
 expect(() => ceilingFor({boxMemoryBytes:8e9,stackBytes:1,headroomBytes:HEADROOM_BYTES,perAgentPeakBytes:peak})).toThrow();
});
