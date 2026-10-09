import { z } from 'zod';

/** Secret-free result of the keeper's `gateway.status` action, shared by keeper and console.
 * Every failure state is its own value; none can look like success. Nothing here can carry a
 * credential, a path or a full URL: the endpoint is an origin only, and a model target is only a
 * provider and a model name. "providerTested" is always false: this read never sends a model
 * request. */
export const GATEWAY_PURPOSES = ['brain', 'writer', 'utility', 'gate', 'embed'] as const;
const text = z.string().min(1).max(200);
export const gatewayTargetSchema = z.object({ provider: text, model: text }).strict();
export const gatewayPurposeSchema = z.object({
  purpose: z.enum(GATEWAY_PURPOSES), alias: text,
  state: z.enum(['served', 'served-target-hidden', 'not-served', 'unknown']),
  target: gatewayTargetSchema.optional(),
}).strict();
export const gatewayDetailsSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ok'), others: z.array(text).max(200) }).strict(),
  z.object({ state: z.enum(['refused', 'invalid', 'unavailable', 'key-unreadable', 'not-managed']) }).strict(),
]);
export const gatewayStatusSchema = z.object({
  mode: z.enum(['managed', 'external']).nullable(),
  endpoint: z.string().max(300).nullable(),
  checkedAt: z.iso.datetime(),
  reachability: z.enum(['reachable', 'not-ready', 'readiness-unreadable', 'unreachable', 'not-configured']),
  details: gatewayDetailsSchema,
  purposes: z.array(gatewayPurposeSchema).max(GATEWAY_PURPOSES.length),
  providerTested: z.literal(false),
}).strict();
export type GatewayStatus = z.infer<typeof gatewayStatusSchema>;
export type GatewayPurposeStatus = z.infer<typeof gatewayPurposeSchema>;
export const gatewayStatusInput = z.object({}).strict();
