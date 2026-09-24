import {afterEach, describe, expect, it, vi} from 'vitest';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {registerDurableDynamicTools} from '../src/durable-dynamic-tools.js';

const require = createRequire(import.meta.url);
let root = dirname(require.resolve('eve'));
for (let i = 0; i < 10 && !existsSync(join(root, 'dist/src/context/build-dynamic-tools.js')); i++) root = dirname(root);
if (!existsSync(join(root, 'dist/src/context/build-dynamic-tools.js'))) throw new Error('Installed Eve replay module not found');
const {buildDynamicTools} = await import(/* @vite-ignore */ pathToFileURL(join(root, 'dist/src/context/build-dynamic-tools.js')).href);
const {SessionDynamicToolMetadataKey} = await import(/* @vite-ignore */ pathToFileURL(join(root, 'dist/src/context/keys.js')).href);
const registryKey = Symbol.for('@workflow/core//registeredSteps');
const world = globalThis as typeof globalThis & {[key: symbol]: unknown};
const originalRegistry = world[registryKey];
afterEach(() => {world[registryKey] = originalRegistry;});

// eve 0.32's persisted dynamic-tool metadata shape: `executeStepFnName`/`approvalStepFnName`
// pointing at the step names this module registers. eve 0.59.0 made every dynamic tool carry a
// durable descriptor instead (see this module's own file header for the full story), and
// 0.60.1's `buildDynamicTools` now REJECTS this old shape outright rather than replaying it —
// `requireCurrentDynamicToolMetadata` throws before `registerDurableDynamicTools`'s registrations
// are ever consulted. A session parked on 0.32 is interrupted by this upgrade, not silently
// misrouted; that is the property the second test below pins.
const saved0dot32 = {name: 'selected', description: 'Description pinned before restart', inputSchema: {type: 'object', properties: {}},
  executeStepFnName: 'eve:framework-dynamic:catalogue:selected', approvalStepFnName: 'eve:dynamic-tool-approval:catalogue:selected', closureVars: {}};
const replay = (metadata: unknown[]) => buildDynamicTools({get: (key: unknown) => key === SessionDynamicToolMetadataKey ? metadata : []});

describe('registerDurableDynamicTools on eve 0.60.1', () => {
  it('rejects malformed implementations instead of registering an unusable tool', () => {
    expect(() => registerDurableDynamicTools('catalogue', {bad: {execute: 'not a function'}})).toThrow('Invalid durable dynamic tool');
    expect(() => registerDurableDynamicTools('catalogue', {bad: {execute: () => {}, approval: true}})).toThrow('Invalid durable dynamic tool');
  });

  it('still registers step functions under the documented names that call through to the given execute/approval', async () => {
    // What is still true about this module on 0.60.1, independent of whether eve ever reads the
    // keys back (it does not, for dynamic tools — see the file header): calling it writes working
    // step functions into `@workflow/core//registeredSteps` under the names it always used.
    world[registryKey] = new Map();
    const approval = vi.fn(async () => ({type: 'denied', reason: 'board says never'}));
    const execute = vi.fn(async () => 'selected');
    registerDurableDynamicTools('catalogue', {
      selected: {execute, approval},
      unselected: {execute: async () => 'must remain unavailable'},
    });
    const registry = world[registryKey] as Map<string, (closure: unknown, input: unknown, context?: unknown) => unknown>;
    const context = {callId: 'after-restart'};
    await expect(registry.get('eve:framework-dynamic:catalogue:selected')!(undefined, {a: 1}, context)).resolves.toBe('selected');
    expect(execute).toHaveBeenCalledWith({a: 1}, context);
    await expect(registry.get('eve:dynamic-tool-approval:catalogue:selected')!(undefined, context)).resolves.toEqual({type: 'denied', reason: 'board says never'});
    expect(approval).toHaveBeenCalledWith(context);
    expect(registry.has('eve:framework-dynamic:catalogue:unselected')).toBe(true);
    expect(registry.has('eve:dynamic-tool-approval:catalogue:unselected')).toBe(false); // no approval was given
  });

  it('is INERT for dynamic-tool replay: eve 0.60.1 rejects a session persisted on 0.32 rather than reading these keys back', () => {
    // This is the new truth this wave established (W2-s7): eve's own `requireCurrentDynamicToolMetadata`
    // throws on the 0.32 metadata shape before this module's registrations are ever consulted, so a
    // session parked across the upgrade cannot be replayed — it must start over. This module is kept
    // anyway per owner decision 6 (it is harmless, and still used for eve's other registered-step
    // consumers), but for dynamic tools specifically it does nothing on 0.60.1.
    // The real proof that dynamic-tool REPLAY still works on 0.60.1 — for tools that carry the new
    // durable descriptors instead of this module's keys — is a genuine process restart:
    // packages/board-evals/scripts/restart-probe.sh (W2-s13), not a unit test.
    world[registryKey] = new Map();
    registerDurableDynamicTools('catalogue', {selected: {execute: async () => 'selected'}});
    expect(() => replay([saved0dot32])).toThrow(/persisted metadata was converted to the current schema/);
  });
});
