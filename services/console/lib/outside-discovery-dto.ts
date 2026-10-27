export type OutsideCredentialStatusDto={state:'unavailable'|'active'|'pending'|'active-pending'|'revoked';reviewPending:boolean;applyPending:boolean;activeRevision:number|null;
  candidateRevision:number|null;discoveryRevision:number|null};
export type OutsideDiscoveryTargetDto={agentName:string;connectionName:string;credentialStatus:OutsideCredentialStatusDto};
export type OutsideDiscoveryPreviewDto={accountId:string;requestId:string;claimOperationId:string;agentName:string;connectionName:string;
  endpoint:string;purpose:'streamable-http-discovery-v1';definitionHash:string;accessRevision:number;destinationHash:string;
  routePolicyHash:string;expectedGeneration:number;expectedCandidateRevision:number|null;consentGeneration:number};
export type OutsideDiscoveryDocumentDto={protocolVersion:'2025-06-18';serverInfo:{name:string;version:string};
  tools:{name:string;description?:string;inputSchema:Record<string,unknown>}[]};
export type OutsideDiscoveryInspectionDto={state:'unresolved'}|{state:'complete';document:OutsideDiscoveryDocumentDto};

type RecordValue=Record<string,unknown>;
const MAX_DOCUMENT_BYTES=65536;
const HASH=/^[a-f0-9]{64}$/;
const NAME=/^[a-z][a-z0-9-]{1,30}$/;
function record(value:unknown):RecordValue|undefined{
  return value!==null&&typeof value==='object'&&!Array.isArray(value)&&
    (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)?value as RecordValue:undefined;
}
function exactKeys(value:RecordValue,keys:string[]):boolean{
  return Object.keys(value).sort().join(',')===[...keys].sort().join(',');
}
function isUuid(value:unknown):value is string{
  return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function isHash(value:unknown):value is string{return typeof value==='string'&&HASH.test(value);}
function isName(value:unknown):value is string{return typeof value==='string'&&NAME.test(value);}
function isInteger(value:unknown,min:number):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min;}
function text(value:unknown,maxBytes:number):value is string{
  return typeof value==='string'&&value.length>0&&new TextEncoder().encode(value).byteLength<=maxBytes&&![...value].some(char=>{
    const code=char.codePointAt(0)!;return code<0x20||code===0x7f;
  });
}
function description(value:unknown):value is string{
  return typeof value==='string'&&utf8Bytes(value)<=2048&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}
function jsonValue(value:unknown,depth=0):value is null|boolean|number|string|unknown[]|RecordValue{
  if(depth>16)return false;
  if(value===null||typeof value==='boolean')return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(typeof value==='string')return true;
  if(Array.isArray(value))return value.every(item=>jsonValue(item,depth+1));
  const object=record(value);
  return !!object&&Object.values(object).every(item=>jsonValue(item,depth+1));
}
function utf8Bytes(value:string):number{return new TextEncoder().encode(value).byteLength;}

export function parseOutsideDiscoveryTargets(value:unknown):OutsideDiscoveryTargetDto[]|undefined{
  if(!Array.isArray(value)||value.length>128)return;
  const targets:OutsideDiscoveryTargetDto[]=[];
  const seen=new Set<string>();
  for(const candidate of value){
    const item=record(candidate);
    if(!item||!exactKeys(item,['agentName','connectionName','credentialStatus'])||!isName(item.agentName)||!isName(item.connectionName))return;
    const status=record(item.credentialStatus);
    if(!status||!exactKeys(status,['state','reviewPending','applyPending','activeRevision','candidateRevision','discoveryRevision'])||
        !['unavailable','active','pending','active-pending','revoked'].includes(String(status.state))||
        typeof status.reviewPending!=='boolean'||typeof status.applyPending!=='boolean'||
        ![status.activeRevision,status.candidateRevision,status.discoveryRevision].every(revision=>revision===null||isInteger(revision,1)))return;
    const hasActive=status.activeRevision!==null,hasCandidate=status.candidateRevision!==null;
    const expectedState=String(status.state)==='revoked'?'revoked':hasCandidate?hasActive?'active-pending':'pending':hasActive?'active':'unavailable';
    const discoveryRevision=status.discoveryRevision as number|null;
    const expectedReview=status.state!=='revoked'&&discoveryRevision!==null&&
      discoveryRevision>Math.max((status.activeRevision as number|null)??0,(status.candidateRevision as number|null)??0);
    if(status.state!==expectedState||status.applyPending!==hasCandidate||status.reviewPending!==expectedReview||
        status.state==='revoked'&&(hasActive||hasCandidate))return;
    const key=`${item.agentName}\0${item.connectionName}`;
    if(seen.has(key))return;
    seen.add(key);targets.push({agentName:item.agentName,connectionName:item.connectionName,credentialStatus:status as unknown as OutsideCredentialStatusDto});
  }
  return targets;
}

export function parseOutsideDiscoveryPreview(value:unknown):OutsideDiscoveryPreviewDto|undefined{
  const item=record(value);
  if(!item||!exactKeys(item,['accountId','requestId','claimOperationId','agentName','connectionName','endpoint','purpose','definitionHash',
    'accessRevision','destinationHash','routePolicyHash','expectedGeneration','expectedCandidateRevision','consentGeneration'])||
      !isUuid(item.accountId)||!isUuid(item.requestId)||!isUuid(item.claimOperationId)||!isName(item.agentName)||!isName(item.connectionName)||
      !text(item.endpoint,8192)||item.purpose!=='streamable-http-discovery-v1'||!isHash(item.definitionHash)||
      !isInteger(item.accessRevision,1)||!isHash(item.destinationHash)||!isHash(item.routePolicyHash)||!isInteger(item.expectedGeneration,0)||
      item.expectedCandidateRevision!==null&&!isInteger(item.expectedCandidateRevision,1)||!isInteger(item.consentGeneration,1))return;
  let endpoint:URL;
  try{endpoint=new URL(item.endpoint);}catch{return;}
  if(endpoint.protocol!=='https:'||endpoint.href!==item.endpoint||endpoint.username||endpoint.password||
      endpoint.port&&endpoint.port!=='443'||endpoint.hash||!endpoint.hostname||endpoint.hostname.endsWith('.invalid'))return;
  return {accountId:item.accountId,requestId:item.requestId,claimOperationId:item.claimOperationId,agentName:item.agentName,
    connectionName:item.connectionName,endpoint:item.endpoint,purpose:'streamable-http-discovery-v1',definitionHash:item.definitionHash,
    accessRevision:item.accessRevision,destinationHash:item.destinationHash,routePolicyHash:item.routePolicyHash,
    expectedGeneration:item.expectedGeneration,expectedCandidateRevision:item.expectedCandidateRevision,consentGeneration:item.consentGeneration};
}

export function parseOutsideDiscoveryDocument(value:unknown):OutsideDiscoveryDocumentDto|undefined{
  const item=record(value);
  if(!item||!exactKeys(item,['protocolVersion','serverInfo','tools'])||item.protocolVersion!=='2025-06-18'||!Array.isArray(item.tools)||item.tools.length>256)return;
  const serverInfo=record(item.serverInfo);
  if(!serverInfo||!exactKeys(serverInfo,['name','version'])||!text(serverInfo.name,128)||!text(serverInfo.version,128))return;
  const names=new Set<string>(),tools:OutsideDiscoveryDocumentDto['tools']=[];
  for(const candidate of item.tools){
    const tool=record(candidate);
    if(!tool||Object.keys(tool).some(key=>!['name','description','inputSchema'].includes(key))||!text(tool.name,128)||
        /[\x00-\x1f\x7f]/.test(tool.name)||names.has(tool.name)||tool.description!==undefined&&!description(tool.description))return;
    const inputSchema=record(tool.inputSchema);
    if(!inputSchema||!jsonValue(inputSchema))return;
    names.add(tool.name);
    tools.push({name:tool.name,...(tool.description===undefined?{}:{description:tool.description}),inputSchema});
  }
  const document:OutsideDiscoveryDocumentDto={protocolVersion:'2025-06-18',serverInfo:{name:serverInfo.name,version:serverInfo.version},tools};
  let encoded:string;
  try{encoded=JSON.stringify(document);}catch{return;}
  if(utf8Bytes(encoded)>MAX_DOCUMENT_BYTES)return;
  return document;
}

export function parseOutsideDiscoveryInspection(value:unknown):OutsideDiscoveryInspectionDto|undefined{
  const item=record(value);
  if(!item)return;
  if(item.state==='unresolved'&&exactKeys(item,['state']))return {state:'unresolved'};
  if(item.state==='complete'&&exactKeys(item,['state','document'])){
    const document=parseOutsideDiscoveryDocument(item.document);
    if(document)return {state:'complete',document};
  }
  return;
}
