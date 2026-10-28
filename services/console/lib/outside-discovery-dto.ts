export type OutsideCredentialStatusDto={state:'unavailable'|'active'|'pending'|'active-pending'|'revoked';reviewPending:boolean;applyPending:boolean;
  accountId:string|null;generation:number|null;hasCredentialMaterial:boolean;activeRevision:number|null;
  candidateRevision:number|null;discoveryRevision:number|null};
export type OutsideDiscoveryTargetDto={agentName:string;connectionName:string;credentialStatus:OutsideCredentialStatusDto};
export type OutsideDiscoveryPreviewDto={accountId:string;requestId:string;claimOperationId:string;agentName:string;connectionName:string;
  endpoint:string;purpose:'streamable-http-discovery-v1';definitionHash:string;accessRevision:number;destinationHash:string;
  routePolicyHash:string;expectedGeneration:number;expectedCandidateRevision:number|null;consentGeneration:number};
export type OutsideDiscoveryDocumentDto={protocolVersion:'2025-06-18';serverInfo:{name:string;version:string};
  tools:{name:string;description?:string;inputSchema:Record<string,unknown>}[]};
export type OutsideDiscoveryInspectionDto={state:'unresolved'}|{state:'complete';document:OutsideDiscoveryDocumentDto};
export type OutsideDescriptorReviewDto={descriptor:{version:1;connectionName:string;scope:'read'|'write'|'write-with-confirm';allow:string[];read:string[];
  tools:OutsideDiscoveryDocumentDto['tools']};descriptorHash:string;expectedGeneration:number;expectedCandidateRevision:number|null;
  expectedConsentGeneration:number;expectedDefinitionHash:string;expectedAccessRevision:number};
export type OutsideDescriptorPublicationDto={publicationId:string;publicationHash:string;descriptor:OutsideDescriptorReviewDto['descriptor']};
export type OutsideDescriptorAcceptanceDto={acceptanceId:string;publicationHash:string;acceptanceHash:string};
export type OutsidePendingApplyDto={accountId:string;agentName:string;connectionName:string;requestId:string;claimOperationId:string;publicationId:string;
  acceptanceId:string;expectedGeneration:number;expectedCandidateRevision:number|null;expectedConsentGeneration:number;expectedDefinitionHash:string;
  expectedAccessRevision:number;expectedPublicationHash:string;expectedAcceptanceHash:string;expectedPolicyHash:string;activationReviewId:string;
  activationReviewHash:string;stageOperationId:string;candidateRevision:number};

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
    if(!status||!exactKeys(status,['state','reviewPending','applyPending','accountId','generation','hasCredentialMaterial','activeRevision','candidateRevision','discoveryRevision'])||
        !['unavailable','active','pending','active-pending','revoked'].includes(String(status.state))||
        typeof status.reviewPending!=='boolean'||typeof status.applyPending!=='boolean'||
        !(status.accountId===null||isUuid(status.accountId))||!(status.generation===null||isInteger(status.generation,1))||
        typeof status.hasCredentialMaterial!=='boolean'||
        ![status.activeRevision,status.candidateRevision,status.discoveryRevision].every(revision=>revision===null||isInteger(revision,1)))return;
    const hasActive=status.activeRevision!==null,hasCandidate=status.candidateRevision!==null;
    const expectedState=String(status.state)==='revoked'?'revoked':hasCandidate?hasActive?'active-pending':'pending':hasActive?'active':'unavailable';
    const discoveryRevision=status.discoveryRevision as number|null;
    const expectedReview=status.state!=='revoked'&&discoveryRevision!==null&&
      discoveryRevision>Math.max((status.activeRevision as number|null)??0,(status.candidateRevision as number|null)??0);
    if(status.state!==expectedState||status.applyPending!==hasCandidate||status.reviewPending!==expectedReview||
        (hasActive||hasCandidate)&&!status.hasCredentialMaterial||
        (status.accountId===null)!==(status.generation===null)||
        status.state==='unavailable'&&(hasActive||hasCandidate)||
        status.accountId===null&&(status.hasCredentialMaterial||discoveryRevision!==null)||
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

export function parseOutsideDescriptorReview(value:unknown):OutsideDescriptorReviewDto|undefined{
  const item=record(value),descriptor=item&&record(item.descriptor);
  if(!item||!descriptor||!exactKeys(item,['descriptor','descriptorHash','expectedGeneration','expectedCandidateRevision','expectedConsentGeneration',
      'expectedDefinitionHash','expectedAccessRevision'])||!exactKeys(descriptor,['version','connectionName','scope','allow','read','tools'])||
      descriptor.version!==1||!isName(descriptor.connectionName)||!['read','write','write-with-confirm'].includes(String(descriptor.scope))||
      !Array.isArray(descriptor.allow)||!Array.isArray(descriptor.read)||!Array.isArray(descriptor.tools)||descriptor.allow.length>256||
      descriptor.read.length>256||descriptor.tools.length>256||!descriptor.allow.every(name=>typeof name==='string')||
      !descriptor.read.every(name=>typeof name==='string')||!isHash(item.descriptorHash)||!isInteger(item.expectedGeneration,1)||
      item.expectedCandidateRevision!==null&&!isInteger(item.expectedCandidateRevision,1)||!isInteger(item.expectedConsentGeneration,1)||
      !isHash(item.expectedDefinitionHash)||!isInteger(item.expectedAccessRevision,1))return;
  const allow=descriptor.allow as string[],read=descriptor.read as string[];
  if(new Set(allow).size!==allow.length||new Set(read).size!==read.length||read.some(name=>!allow.includes(name)))return;
  const doc=parseOutsideDiscoveryDocument({protocolVersion:'2025-06-18',serverInfo:{name:'review',version:'1'},tools:descriptor.tools});
  if(!doc||doc.tools.length!==descriptor.tools.length||doc.tools.map(tool=>tool.name).join('\0')!==allow.join('\0'))return;
  return {descriptor:{version:1,connectionName:descriptor.connectionName,scope:descriptor.scope as 'read'|'write'|'write-with-confirm',
    allow,read,tools:doc.tools},descriptorHash:item.descriptorHash,
    expectedGeneration:item.expectedGeneration,expectedCandidateRevision:item.expectedCandidateRevision as number|null,
    expectedConsentGeneration:item.expectedConsentGeneration,expectedDefinitionHash:item.expectedDefinitionHash,expectedAccessRevision:item.expectedAccessRevision};
}

export function parseOutsideDescriptorPublication(value:unknown):OutsideDescriptorPublicationDto|undefined{
  const item=record(value);
  if(!item||!exactKeys(item,['publicationId','publicationHash','descriptor'])||!isUuid(item.publicationId)||!isHash(item.publicationHash))return;
  const parsed=parseOutsideDescriptorReview({descriptor:item.descriptor,descriptorHash:item.publicationHash,expectedGeneration:1,
    expectedCandidateRevision:null,expectedConsentGeneration:1,expectedDefinitionHash:'0'.repeat(64),expectedAccessRevision:1});
  if(!parsed)return;
  return {publicationId:item.publicationId,publicationHash:item.publicationHash,descriptor:parsed.descriptor};
}

export function parseOutsideDescriptorAcceptance(value:unknown):OutsideDescriptorAcceptanceDto|undefined{
  const item=record(value);
  if(!item||!exactKeys(item,['acceptanceId','publicationHash','acceptanceHash'])||!isUuid(item.acceptanceId)||!isHash(item.publicationHash)||!isHash(item.acceptanceHash))return;
  return {acceptanceId:item.acceptanceId,publicationHash:item.publicationHash,acceptanceHash:item.acceptanceHash};
}

export function parseOutsidePendingApply(value:unknown):OutsidePendingApplyDto|undefined{
  const item=record(value),keys=['accountId','agentName','connectionName','requestId','claimOperationId','publicationId','acceptanceId','expectedGeneration',
    'expectedCandidateRevision','expectedConsentGeneration','expectedDefinitionHash','expectedAccessRevision','expectedPublicationHash',
    'expectedAcceptanceHash','expectedPolicyHash','activationReviewId','activationReviewHash','stageOperationId','candidateRevision'];
  if(!item||!exactKeys(item,keys)||!isUuid(item.accountId)||!isName(item.agentName)||!isName(item.connectionName)||!isUuid(item.requestId)||
      !isUuid(item.claimOperationId)||!isUuid(item.publicationId)||!isUuid(item.acceptanceId)||!isInteger(item.expectedGeneration,1)||
      item.expectedCandidateRevision!==null&&!isInteger(item.expectedCandidateRevision,1)||!isInteger(item.expectedConsentGeneration,1)||
      !isHash(item.expectedDefinitionHash)||!isInteger(item.expectedAccessRevision,1)||!isHash(item.expectedPublicationHash)||
      !isHash(item.expectedAcceptanceHash)||!isHash(item.expectedPolicyHash)||!isUuid(item.activationReviewId)||!isHash(item.activationReviewHash)||
      !isUuid(item.stageOperationId)||!isInteger(item.candidateRevision,1))return;
  return item as unknown as OutsidePendingApplyDto;
}
