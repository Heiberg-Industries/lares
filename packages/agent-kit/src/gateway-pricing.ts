/** Reviewed immutable prices, separate from the gateway's capability profile. No defaults,
 * vendor price lookup or tokenizer estimate is a spending authority. */
import {z} from 'zod';
import {canonicalBudgetMoney} from './budget-admission-store.js';
import {gatewayUsageSchema,type GatewayUsage} from './gateway-admission-protocol.js';
const SCALE=10n**18n,MILLION=1_000_000n;
const rate=z.string().refine(v=>{try{return canonicalBudgetMoney(v)===v&&moneyUnits(v)<=1_000_000n*SCALE;}catch{return false;}},'Invalid reviewed rate');
export const gatewayPricingSchema=z.object({
  version:z.literal(1),capabilityHash:z.string().regex(/^[a-f0-9]{64}$/),format:z.enum(['openai','anthropic']),
  // inputTokens bounds the TOTAL of all chargeable input categories. These are explicit
  // reviewed provider/capability bounds, never inferred from request byte count.
  limits:z.object({inputTokens:z.number().int().min(1).max(1_000_000_000),outputTokens:z.number().int().min(1).max(1_000_000_000)}).strict(),
  // Rates are USD per million tokens, canonical decimal strings. A supported tariff has
  // fixed rates for the complete reviewed context range; tiered/extra fees are unsupported.
  usdPerMillionTokens:z.object({input:rate,output:rate,cacheRead:rate,cacheWrite:rate}).strict(),
}).strict().superRefine((p,ctx)=>{if(p.format==='openai'&&p.usdPerMillionTokens.cacheWrite!=='0')ctx.addIssue({code:'custom',message:'OpenAI cache writes are unsupported'});});
export type GatewayPricing=z.infer<typeof gatewayPricingSchema>;
function moneyUnits(value:string):bigint {const [a,b='']=canonicalBudgetMoney(value).split('.');return BigInt(a!)*SCALE+BigInt(b.padEnd(18,'0'));}
function amount(numerator:bigint):string {
  // Aggregate first, then round UP to the ledger's 10^-18 USD unit. Never truncate a
  // sub-unit positive charge or round each category independently.
  const units=(numerator+MILLION-1n)/MILLION;
  const fraction=(units%SCALE).toString().padStart(18,'0').replace(/0+$/,'');
  return canonicalBudgetMoney((units/SCALE).toString()+(fraction?'.'+fraction:''));
}
export function gatewayMaximumLiability(profile:GatewayPricing):string {
  const p=gatewayPricingSchema.parse(profile),r=p.usdPerMillionTokens;
  const inputRates=[r.input,r.cacheRead,...(p.format==='anthropic'?[r.cacheWrite]:[])].map(moneyUnits);
  const highest=inputRates.reduce((a,b)=>a>b?a:b);
  const maximum=amount(BigInt(p.limits.inputTokens)*highest+BigInt(p.limits.outputTokens)*moneyUnits(r.output));
  if(maximum==='0')throw new Error('A positive maximum liability is required');
  return maximum;
}
export function gatewayActualAmount(profile:GatewayPricing,usage:GatewayUsage):string {
  const p=gatewayPricingSchema.parse(profile),u=gatewayUsageSchema.parse(usage),r=p.usdPerMillionTokens;
  if(p.format==='openai'&&(u.cacheReadTokens>u.inputTokens||u.cacheWriteTokens!==0))throw new Error('Invalid OpenAI cache usage');
  const ordinary=BigInt(u.inputTokens)-(p.format==='openai'?BigInt(u.cacheReadTokens):0n);
  // Do not discard valid observed overages. Even counts above the reviewed maximum must
  // reach the ledger's over-reservation conflict/freeze path. Safe integers and bounded
  // rates keep all representable wire usage within budget_money's integral range.
  return amount(ordinary*moneyUnits(r.input)+BigInt(u.outputTokens)*moneyUnits(r.output)+BigInt(u.cacheReadTokens)*moneyUnits(r.cacheRead)+BigInt(u.cacheWriteTokens)*moneyUnits(r.cacheWrite));
}
