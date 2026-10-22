import { createHash } from 'node:crypto';

/** Only the browser console's text and exact approval envelopes may enter private sessions.
 * Check the original request before Eve parses attachments or public callback destinations. */
// Only fully validated raw requests receive a minimal, immutable pre-dispatch receipt.
const verifiedResponses = new WeakMap<Request,Readonly<{requestId:string;optionId:'approve'|'cancel';method:string;path:string;rawBodyHash:string;modelCapsule?:string}>>();
const verifiedMessages = new WeakMap<Request, Readonly<{message:string;method:string;path:string;rawBodyHash:string;vaultCapsule?:string;modelCapsule?:string}>>();
/** Opaque, console-signed authority capsule. Its contents are not trusted until Keeper verifies it. */
export const PRIVATE_CONSOLE_VAULT_CAPSULE_HEADER = 'x-lares-vault-capsule';
/** Independent, purpose-bound model admission capsule. */
export const PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER = 'x-lares-model-capsule';
const MAX_VAULT_CAPSULE_CHARS = 8192;
const MAX_MODEL_CAPSULE_CHARS = 8192;
const denied = (): never => { throw new Error('Private conversation request is not supported'); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => { if (Object.keys(v).some(k => !allowed.includes(k))) denied(); };
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
function modelCapsuleRequest(capsule:string):Record<string,unknown> {
  if(capsule.length>MAX_MODEL_CAPSULE_CHARS)return denied();
  const parts=capsule.split('.');
  if(parts.length!==2||!/^[A-Za-z0-9_-]+$/.test(parts[0]!))return denied();
  let payload:unknown;
  try{payload=JSON.parse(Buffer.from(parts[0]!,'base64url').toString('utf8'));}catch{return denied();}
  if(!object(payload)||!object(payload.request))return denied();
  return payload.request;
}
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
  const rawBytes = Buffer.from(await request.clone().arrayBuffer());
  if (rawBytes.length > 262144) denied();
  const raw = rawBytes.toString('utf8');
  const rawBodyHash = createHash('sha256').update(rawBytes).digest('hex');
  const body=raw.trim()?JSON.parse(raw):{};
  assertPrivateConsoleEnvelope(body,path);
  const modelCapsule=request.headers.get(PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER)??undefined;
  if(modelCapsule!==undefined&&(modelCapsule.length>MAX_MODEL_CAPSULE_CHARS||!/^[A-Za-z0-9_.-]+$/.test(modelCapsule)))denied();
  if(Array.isArray(body.inputResponses)){
    const answer=body.inputResponses[0];
    if(answer.optionId!=='approve'&&answer.optionId!=='cancel')denied();
    verifiedResponses.set(request,Object.freeze({requestId:answer.requestId,optionId:answer.optionId,method:request.method,path,
      rawBodyHash,...(modelCapsule===undefined?{}:{modelCapsule})}));
  }
  if (/\/session(?:\/[^/]+)?$/.test(path) && typeof body.message==='string') {
    const capsule=request.headers.get(PRIVATE_CONSOLE_VAULT_CAPSULE_HEADER)??undefined;
    if(capsule!==undefined&&(capsule.length>MAX_VAULT_CAPSULE_CHARS||!/^[A-Za-z0-9_.-]+$/.test(capsule)))denied();
    verifiedMessages.set(request,Object.freeze({message:body.message,method:request.method,path,
      rawBodyHash,...(capsule===undefined?{}:{vaultCapsule:capsule}),...(modelCapsule===undefined?{}:{modelCapsule})}));
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

/** Receipt for an exact, validated human message. Keeper authenticates the opaque capsule. */
export function verifiedPrivateConsoleModelMessageReceipt(request:Request,message:unknown):Readonly<{method:string;path:string;rawBodyHash:string;requestId:string;purpose:'human';modelCapsule:string}> {
  assertVerifiedPrivateConsoleMessage(request,message);
  const receipt=verifiedMessages.get(request);if(!receipt?.modelCapsule)denied();
  const capsuleRequest=modelCapsuleRequest(receipt!.modelCapsule!);
  const requestId=capsuleRequest.requestId;
  if(capsuleRequest.purpose!=='human'||typeof requestId!=='string'||
    !/^[A-Za-z0-9_-]{32,64}$/.test(requestId)||capsuleRequest.resume!==undefined)denied();
  return Object.freeze({method:receipt!.method,path:receipt!.path,rawBodyHash:receipt!.rawBodyHash,
    requestId:requestId as string,purpose:'human',modelCapsule:receipt!.modelCapsule!});
}

/** Receipt for the exact validated approve/cancel body, including its original raw bytes. */
export function verifiedPrivateConsoleModelResponseReceipt(request:Request):Readonly<{method:string;path:string;rawBodyHash:string;requestId:string;purpose:'resume';resume:{requestId:string;optionId:'approve'|'cancel'};modelCapsule:string}> {
  const receipt=verifiedResponses.get(request);
  if(!receipt?.modelCapsule)return denied();
  const modelRequest=modelCapsuleRequest(receipt.modelCapsule);
  if(modelRequest.purpose!=='resume'||typeof modelRequest.requestId!=='string'||!object(modelRequest.resume))return denied();
  const resume=modelRequest.resume;
  if(resume.optionId!=='approve'&&resume.optionId!=='cancel')return denied();
  if(resume.requestId!==receipt.requestId||resume.optionId!==receipt.optionId)return denied();
  return Object.freeze({method:receipt.method,path:receipt.path,rawBodyHash:receipt.rawBodyHash,requestId:modelRequest.requestId,
    purpose:'resume',resume:Object.freeze({requestId:receipt.requestId,optionId:receipt.optionId}),modelCapsule:receipt.modelCapsule});
}

/** Same Request object only, after strict raw-envelope validation. Browser-supplied attributes
 * never create this receipt, and a human message cannot be combined with an answer. */
export function verifiedPrivateConsoleResponse(request:Request){
  const receipt=verifiedResponses.get(request);if(!receipt)denied();return receipt!;
}
