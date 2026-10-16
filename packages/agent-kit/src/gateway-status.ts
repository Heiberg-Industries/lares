import { z } from 'zod';

/** Secret-free result of the keeper's `gateway.status` action, shared by keeper and console.
 * Every failure state is its own value; none can look like success. Nothing here can carry a
 * credential, a path or a full URL: the endpoint is an origin only, and a model target is only a
 * provider and a model name. "providerTested" is always false: this read never sends a model
 * request. */
export const GATEWAY_PURPOSES = ['brain', 'writer', 'utility', 'gate', 'embed'] as const;
export type GatewayPurpose = (typeof GATEWAY_PURPOSES)[number];
/** The model name an agent asks the gateway for: the installation's prefix plus the purpose
 * (`<prefix>-brain`). The keeper hands every agent the prefix as LARES_MODEL_PREFIX; there is no
 * fallback name, so a missing prefix is a plain error at the call, not a wrong model. Read lazily
 * (at call time) so importing this never needs the variable. */
export function purposeModel(purpose: GatewayPurpose, env: Record<string, string | undefined> = process.env): string {
  const prefix = env['LARES_MODEL_PREFIX'];
  if (!prefix) throw new Error(`LARES_MODEL_PREFIX is not set, so the ${purpose} model name cannot be worked out; the keeper sets it from the models.alias_prefix setting when it starts the agent`);
  return `${prefix}-${purpose}`;
}
const text = z.string().min(1).max(200);
export const gatewayTargetSchema = z.object({ provider: text, model: text }).strict();
export const gatewayPurposeSchema = z.object({
  purpose: z.enum(GATEWAY_PURPOSES), alias: text,
  state: z.enum(['served', 'served-target-hidden', 'not-served', 'unknown']),
  target: gatewayTargetSchema.optional(),
}).strict();
export const gatewayDetailsSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ok'), others: z.array(text).max(200), othersTotal: z.number().int().min(0) }).strict(),
  z.object({ state: z.enum(['refused', 'invalid', 'unavailable', 'key-unreadable', 'not-managed', 'aliases-unknown']) }).strict(),
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
