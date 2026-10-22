import { createHash } from 'node:crypto';

/** Only the browser console's text and exact approval envelopes may enter private sessions.
 * Check the original request before Eve parses attachments or public callback destinations. */
// Only fully validated raw requests receive a minimal, immutable pre-dispatch receipt.
const verifiedResponses = new WeakMap<Request,Readonly<{requestId:string;optionId:'approve'|'cancel'}>>();
const verifiedMessages = new WeakMap<Request, Readonly<{message:string;method:string;path:string;rawBodyHash:string;vaultCapsule?:string}>>();
/** Opaque, console-signed authority capsule. Its contents are not trusted until Keeper verifies it. */
export const PRIVATE_CONSOLE_VAULT_CAPSULE_HEADER = 'x-lares-vault-capsule';
const MAX_VAULT_CAPSULE_CHARS = 8192;
const denied = (): never => { throw new Error('Private conversation request is not supported'); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => { if (Object.keys(v).some(k => !allowed.includes(k))) denied(); };
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
export function assertPrivateConsoleEnvelope(payload: unknown, path: string): void {
  if (!object(payload)) denied();
  const body = payload as Record<string, unknown>;
  const control = /\/(cancel|clear|compact|reset)$/.exec(path)?.[1];
  if (control) {
    keys(body, control === 'cancel' ? ['turnId'] : control === 'reset' ? ['reason'] : []);
    for (const value of Object.values(body)) if (!nonempty(value)) denied();
    return;
  }
  keys(body, ['message', 'inputResponses', 'operationId']);
  if ('operationId' in body && (!nonempty(body.operationId) || /\/session\/[^/]+$/.test(path))) denied();
  if ('message' in body && 'inputResponses' in body) denied();
  if ('message' in body && !nonempty(body.message)) denied();
  if ('inputResponses' in body) {
    if (!/\/session\/[^/]+$/.test(path) || !Array.isArray(body.inputResponses) || body.inputResponses.length !== 1) denied();
    for (const response of body.inputResponses as unknown[]) {
      if (!object(response)) denied();
      const answer = response as Record<string, unknown>;
      keys(answer, ['requestId', 'optionId']);
      if (!nonempty(answer.requestId) || !nonempty(answer.optionId)) denied();
    }
  }
  if (!('message' in body) && !('inputResponses' in body) && /\/session\/[^/]+$/.test(path)) denied();
}
export async function assertPrivateConsoleRequest(request: Request): Promise<void> {
  if (request.method !== 'POST') return;
  const path = new URL(request.url).pathname;
  if (!/\/session(?:\/[^/]+)?(?:\/(?:cancel|clear|compact|reset))?$/.test(path)) return;
  const raw = await request.clone().text();
  if (raw.length > 262144) denied();
  const body=raw.trim()?JSON.parse(raw):{};
  assertPrivateConsoleEnvelope(body,path);
  if(Array.isArray(body.inputResponses)){
    const answer=body.inputResponses[0];
    if(answer.optionId!=='approve'&&answer.optionId!=='cancel')denied();
    verifiedResponses.set(request,Object.freeze({requestId:answer.requestId,optionId:answer.optionId}));
  }
  if (/\/session(?:\/[^/]+)?$/.test(path) && typeof body.message==='string') {
    const capsule=request.headers.get(PRIVATE_CONSOLE_VAULT_CAPSULE_HEADER)??undefined;
    if(capsule!==undefined&&(capsule.length>MAX_VAULT_CAPSULE_CHARS||!/^[A-Za-z0-9_.-]+$/.test(capsule)))denied();
    verifiedMessages.set(request,Object.freeze({message:body.message,method:request.method,path,
      rawBodyHash:createHash('sha256').update(raw).digest('hex'),...(capsule===undefined?{}:{vaultCapsule:capsule})}));
  }
}

/** Eve consumes this SAME request after authentication. Verify its parsed text against the
 * successful raw-envelope check without rereading the consumed body. No receipt is a refusal. */
export function assertVerifiedPrivateConsoleMessage(request:Request,message:unknown):void {
  if(request.method!=='POST'||!/\/session(?:\/[^/]+)?$/.test(new URL(request.url).pathname))denied();
  const receipt=verifiedMessages.get(request);
  if(!receipt||typeof message!=='string'||message!==receipt.message)denied();
}

/** A broker may consume only the exact Request that passed raw-envelope validation and whose
 * parsed Eve message matches. This does not authenticate the capsule: Keeper must verify its
 * independent console signature, challenge, tuple and expiry. */
export function verifiedPrivateConsoleMessageReceipt(request:Request,message:unknown):Readonly<{method:string;path:string;rawBodyHash:string;vaultCapsule:string}> {
  assertVerifiedPrivateConsoleMessage(request,message);
  const receipt=verifiedMessages.get(request);
  if(!receipt?.vaultCapsule)denied();
  return Object.freeze({method:receipt!.method,path:receipt!.path,rawBodyHash:receipt!.rawBodyHash,vaultCapsule:receipt!.vaultCapsule!});
}

/** Same Request object only, after strict raw-envelope validation. Browser-supplied attributes
 * never create this receipt, and a human message cannot be combined with an answer. */
export function verifiedPrivateConsoleResponse(request:Request){
  const receipt=verifiedResponses.get(request);if(!receipt)denied();return receipt!;
}
