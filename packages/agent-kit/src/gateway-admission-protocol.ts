/** Server wire protocol only. It grants no spending authority and reads no secrets. */
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
export const GATEWAY_RPC_BYTES=8192;
export const GATEWAY_RPC_MS=3000;
export const GATEWAY_ADMIT_PATH='/v1/gateway-budget/admit';
export const GATEWAY_SETTLE_PATH='/v1/gateway-budget/settle';
export const GATEWAY_ANTHROPIC_MODEL_PATH='/v1/messages';
export const GATEWAY_OPENAI_MODEL_PATH='/v1/chat/completions';
export const gatewayRpcPath=(path:string):path is typeof GATEWAY_ADMIT_PATH|typeof GATEWAY_SETTLE_PATH=>path===GATEWAY_ADMIT_PATH||path===GATEWAY_SETTLE_PATH;
export type GatewayModelFormat='anthropic'|'openai';
export type GatewayModelPath=typeof GATEWAY_ANTHROPIC_MODEL_PATH|typeof GATEWAY_OPENAI_MODEL_PATH;
export function gatewayModelPath(format:unknown):GatewayModelPath|undefined {
  return format==='anthropic'?GATEWAY_ANTHROPIC_MODEL_PATH:format==='openai'?GATEWAY_OPENAI_MODEL_PATH:undefined;
}
/** Hash the exact request bytes that the gateway later checks. The method and path
 * are fixed model routes; query strings, redirects and alternate paths are refused. */
export function gatewayRawRequestHash(method:string,path:string,rawBody:Uint8Array):string {
  if(method!=='POST'||(path!==GATEWAY_ANTHROPIC_MODEL_PATH&&path!==GATEWAY_OPENAI_MODEL_PATH)||
    !(rawBody instanceof Uint8Array))throw new Error('Invalid gateway model request');
  return createHash('sha256').update('lares.gateway.raw-request.v1\0POST\0').update(path).update('\0').update(rawBody).digest('hex');
}
const hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const echoed={version:z.literal(1),nonce:hash,requestHash:hash,profileHash:hash,endpointHash:hash,keyFingerprint:hash,purposeAlias:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)};
export const gatewayAdmitSchema=z.object({...echoed,ticket:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict();
export const gatewayGrantSchema=z.object({...echoed,attemptId:id,bindingId:id}).strict();
export const gatewayUsageSchema=z.object({inputTokens:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),outputTokens:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),cacheReadTokens:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),cacheWriteTokens:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict();
export const gatewaySettleSchema=gatewayGrantSchema.extend({kind:z.literal('terminal-usage'),format:z.enum(['openai','anthropic']),usage:gatewayUsageSchema,receiptHash:hash}).strict();
export type GatewayGrant=z.infer<typeof gatewayGrantSchema>;
export type GatewayUsage=z.infer<typeof gatewayUsageSchema>;
/** Matches Python ensure_ascii=True, sorted keys, compact separators, integer-only wire. */
export function gatewayCanonical(value:unknown):Buffer {
  const ordered=(v:any):any=>{
    if(v===null||typeof v==='string'||typeof v==='boolean')return v;
    if(typeof v==='number'){if(!Number.isSafeInteger(v))throw new Error('Invalid gateway number');return v;}
    if(Array.isArray(v))return v.map(ordered);
    if(typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype)return Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])]));
    throw new Error('Invalid gateway document');
  };
  return Buffer.from(JSON.stringify(ordered(value)).replace(/[^\x20-\x7e]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')),'ascii');
}
/** The gateway sends canonical JSON. Requiring exactly those bytes also rejects duplicate
 * keys at every depth, nonfinite/exponent numbers, invalid UTF-8 and hidden extra framing. */
export function parseGatewayDocument(raw:Buffer):unknown {
  if(!raw.length||raw.length>GATEWAY_RPC_BYTES)throw new Error('Invalid gateway body');
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  if(!gatewayCanonical(value).equals(raw))throw new Error('Noncanonical gateway body');
  return value;
}
export const gatewayHash=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
export function gatewaySignature(key:Uint8Array,direction:'request'|'response',path:string,raw:Buffer):string {
  if(key.byteLength!==32||!gatewayRpcPath(path))throw new Error('Gateway signing unavailable');
  return createHmac('sha256',key).update(gatewayCanonical(['lares.gateway.rpc.v1',direction,'POST',path,gatewayHash(raw)])).digest('hex');
}
export function verifyGatewaySignature(key:Uint8Array,signature:string|undefined,direction:'request'|'response',path:string,raw:Buffer):boolean {
  return typeof signature==='string'&&/^[a-f0-9]{64}$/.test(signature)&&timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(gatewaySignature(key,direction,path,raw),'hex'));
}
/** The nonce has 256 random bits. Keep only this opaque commitment, never erased identity. */
export function gatewayGrantHash(grant:GatewayGrant):string {
  return gatewayHash(gatewayCanonical(['lares.gateway.grant.v1',gatewayGrantSchema.parse(grant)]));
}
