import {isIP} from 'node:net';
const ROUTES:Record<string,Record<string,string>>={creative:{slack:'/eve/v1/slack'},travel:{telegram:'/eve/v1/telegram'},'chief-of-staff':{slack:'/eve/v1/slack',telegram:'/eve/v1/telegram'}};
export const DOOR_PATH=/^\/api\/doors\/[a-z][a-z0-9-]{1,30}\/(slack|telegram)\/events$/;
interface Dependencies {query(sql:string,values:unknown[]):Promise<{rows:any[]}>;fetch:typeof fetch}
async function bounded(stream:ReadableStream<Uint8Array>|null,limit:number,signal:AbortSignal):Promise<Uint8Array> {
  if(!stream)return new Uint8Array();
  const reader=stream.getReader();const parts:Uint8Array[]=[];let size=0;
  const abort=()=>void reader.cancel();signal.addEventListener('abort',abort,{once:true});
  try {while(true){if(signal.aborted)throw new Error('timeout');const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new RangeError('body too large');parts.push(value);}if(signal.aborted)throw new Error('timeout');}
  finally {signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
  const body=new Uint8Array(size);let offset=0;for(const p of parts){body.set(p,offset);offset+=p.length;}return body;
}
/** This relay has no credential reads and adds no claimed identity. Eve verifies the original
 * platform signature/secret downstream BEFORE claim consumption or any session delivery. */
export async function forwardDoor(request:Request,name:string,kind:string,deps:Dependencies):Promise<Response> {
  if(request.method!=='POST'||!/^[a-z][a-z0-9-]{1,30}$/.test(name)||!['slack','telegram'].includes(kind))return new Response('Not found',{status:404});
  const signal=AbortSignal.timeout(8000);
  try {
    const {rows}=await deps.query(`SELECT host(r.address) AS address,r.runtime_control_token,r.ownership_token AS incarnation,
      r.applied_definition->>'role' AS role,d.enabled,NOT r.pending AS applied
      FROM agent_resources r JOIN agent_definitions a ON a.name=r.name JOIN agent_doors d ON d.agent=r.name AND d.kind=$2
      WHERE r.name=$1 AND r.state='ready' AND a.status='valid'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.applied_definition->'doors') x WHERE x->>'kind'=$2 AND x->>'enabled'='true')`,[name,kind]);
    const row=rows[0];const address=typeof row?.address==='string'?row.address.split('/')[0]:'';
    // Only private registered runtime-authorized resources. Never accept a caller host, port, URL or path.
    const octets=address.split('.').map(Number);
    const privateAddress=octets[0]===10||(octets[0]===172&&octets[1]>=16&&octets[1]<=31)||(octets[0]===192&&octets[1]===168);
    const route=ROUTES[row?.role]?.[kind];
    if(!row||!row.runtime_control_token||row.runtime_control_token!==row.incarnation||!row.enabled||!row.applied||!route||isIP(address)!==4||!privateAddress||!/^[a-f0-9-]{36}$/.test(row.incarnation))return new Response('Not found',{status:404});
    if(Number(request.headers.get('content-length')??0)>262144)return new Response('Body too large',{status:413});
    const body=await bounded(request.body,262144,signal);
    const headers=new Headers();
    for(const key of ['content-type',...(kind==='slack'?['x-slack-signature','x-slack-request-timestamp','x-slack-retry-num','x-slack-retry-reason']:['x-telegram-bot-api-secret-token'])]){
      const value=request.headers.get(key);if(value!==null)headers.set(key,value);
    }
    const upstream=await deps.fetch(`http://${address}:3000${route}`,{method:'POST',headers,body:body as BodyInit,signal,redirect:'error'});
    const responseBody=await bounded(upstream.body,65536,signal);
    return new Response(responseBody as BodyInit,{status:upstream.status,headers:{'content-type':upstream.headers.get('content-type')??'text/plain','cache-control':'no-store'}});
  } catch(error) {return new Response(error instanceof RangeError?'Body too large':'Door unavailable',{status:error instanceof RangeError?413:502});}
}
