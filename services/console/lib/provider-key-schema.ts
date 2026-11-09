import { z } from 'zod';

/** What the console may show about an agent's own model key: whether there is one and when it was set. Never the key. */
export const providerKeyStatusSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  own: z.boolean(),
  setAt: z.string().max(40).optional(),
  setBy: z.enum(['host', 'owner']).optional(),
});
export type ProviderKeyStatus = z.infer<typeof providerKeyStatusSchema>;
export type ProviderKeyView = { kind: 'status'; status: ProviderKeyStatus } | { kind: 'unavailable' };

/** Same as the keeper's `providerKeyValue`: one line of printable characters, 1 to 4096. */
export const providerKeyRequest = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('save'), name: providerKeyStatusSchema.shape.name, key: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/) }),
  z.strictObject({ operation: z.literal('remove'), name: providerKeyStatusSchema.shape.name }),
]);
