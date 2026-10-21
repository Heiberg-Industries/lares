/** Only the browser console's text and exact approval envelopes may enter private sessions.
 * Check the original request before Eve parses attachments or public callback destinations. */
// Only fully validated raw requests receive a minimal, immutable pre-dispatch receipt.
const verifiedMessages = new WeakMap<Request, Readonly<{message:string}>>();
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
  if (/\/session(?:\/[^/]+)?$/.test(path) && typeof body.message==='string') {
    verifiedMessages.set(request,Object.freeze({message:body.message}));
  }
}

/** Eve consumes this SAME request after authentication. Verify its parsed text against the
 * successful raw-envelope check without rereading the consumed body. No receipt is a refusal. */
export function assertVerifiedPrivateConsoleMessage(request:Request,message:unknown):void {
  if(request.method!=='POST'||!/\/session(?:\/[^/]+)?$/.test(new URL(request.url).pathname))denied();
  const receipt=verifiedMessages.get(request);
  if(!receipt||typeof message!=='string'||message!==receipt.message)denied();
}
