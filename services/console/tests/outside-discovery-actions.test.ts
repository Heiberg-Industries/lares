import { beforeEach,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({member:vi.fn(),auditAddress:vi.fn(),keeper:vi.fn(),cookie:vi.fn()}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>({value:mocks.cookie()})})}));
vi.mock('../lib/auth',()=>({sessionMember:mocks.member,memberAuditAddress:mocks.auditAddress}));
vi.mock('../lib/keeper-client',()=>({keeper:mocks.keeper,KeeperRefusedError:class extends Error{},KeeperUnavailableError:class extends Error{outcomeMayBeUnknown=false;}}));
import { acceptOutsideDescriptorReview,discoverOutsideTools,inspectOutsideDiscovery,listOutsideDiscoveryTargets,previewOutsideDescriptorReview,
  previewOutsideDiscovery,publishOutsideDescriptorReview,stageOutsideCredentialCandidate,applyOutsideCredentialCandidate,previewOutsideCredentialApply } from '../app/actions/outside-discovery.js';
import { KeeperUnavailableError } from '../lib/keeper-client.js';
import { parseOutsideDescriptorReview,parseOutsideDiscoveryTargets } from '../lib/outside-discovery-dto.js';

const sessionToken='S'.repeat(43),accountId='00000000-0000-4000-8000-000000000001',requestId='00000000-0000-4000-8000-000000000002',
  claimOperationId='00000000-0000-4000-8000-000000000003';
const preview={accountId,requestId,claimOperationId,agentName:'worker',connectionName:'connector',endpoint:'https://example.test/mcp',
  purpose:'streamable-http-discovery-v1',definitionHash:'a'.repeat(64),accessRevision:1,destinationHash:'b'.repeat(64),
  routePolicyHash:'c'.repeat(64),expectedGeneration:0,expectedCandidateRevision:null,consentGeneration:1};
const memberId='11111111-1111-4111-8111-111111111111',auditActor='member@example.test';
const credentialStatus={state:'unavailable',reviewPending:false,applyPending:false,activeRevision:null,candidateRevision:null,discoveryRevision:null};
beforeEach(()=>{vi.clearAllMocks();mocks.cookie.mockReturnValue(sessionToken);mocks.member.mockResolvedValue({id:memberId,role:'member'});
  mocks.auditAddress.mockResolvedValue(auditActor);mocks.keeper.mockResolvedValue([]);});

it('derives session and actor at the server boundary for target and preview requests',async()=>{
  await listOutsideDiscoveryTargets();
  expect(mocks.member).toHaveBeenCalledWith(sessionToken);
  expect(mocks.auditAddress).toHaveBeenCalledWith(memberId);
  expect(mocks.keeper).toHaveBeenCalledWith('outside.discovery-targets',{sessionToken},auditActor);
  mocks.keeper.mockResolvedValueOnce(preview);
  await previewOutsideDiscovery({agentName:'worker',connectionName:'connector'});
  expect(mocks.keeper).toHaveBeenLastCalledWith('outside.discovery-preview',{sessionToken,agentName:'worker',connectionName:'connector'},auditActor);
  await expect(previewOutsideDiscovery({agentName:'worker',connectionName:'connector',endpoint:'https://untrusted.test'})).rejects.toThrow(/Invalid discovery/);
});

it('rejects malformed target and preview DTOs before they can reach the member page',async()=>{
  mocks.keeper.mockResolvedValueOnce([{agentName:'worker',connectionName:'connector',credentialStatus,extra:'ignored'}]);
  await expect(listOutsideDiscoveryTargets()).rejects.toThrow(/unavailable/);
  mocks.keeper.mockResolvedValueOnce({accountId,requestId,claimOperationId,agentName:'worker',connectionName:'connector',
    endpoint:`https://${'x'.repeat(8200)}.test/mcp`,purpose:'streamable-http-discovery-v1',definitionHash:'a'.repeat(64),accessRevision:1,
    destinationHash:'b'.repeat(64),routePolicyHash:'c'.repeat(64),expectedGeneration:0,expectedCandidateRevision:null,consentGeneration:1});
  await expect(previewOutsideDiscovery({agentName:'worker',connectionName:'connector'})).rejects.toThrow(/unavailable/);
});

it('accepts target counts through the authority limit and rejects larger or malformed lists',()=>{
  const targets=(count:number)=>Array.from({length:count},(_,index)=>({agentName:'worker',connectionName:`connector-${index}`,credentialStatus}));
  expect(parseOutsideDiscoveryTargets(targets(50))).toHaveLength(50);
  expect(parseOutsideDiscoveryTargets(targets(51))).toHaveLength(51);
  expect(parseOutsideDiscoveryTargets(targets(128))).toHaveLength(128);
  expect(parseOutsideDiscoveryTargets(targets(129))).toBeUndefined();
  expect(parseOutsideDiscoveryTargets([{agentName:'worker',connectionName:'connector',credentialStatus,unexpected:true}])).toBeUndefined();
  expect(parseOutsideDiscoveryTargets([{agentName:'worker',connectionName:'connector',credentialStatus},
    {agentName:'worker',connectionName:'connector',credentialStatus}])).toBeUndefined();
  expect(parseOutsideDiscoveryTargets([{agentName:'worker',connectionName:'connector',credentialStatus:{...credentialStatus,state:'secrets'}}])).toBeUndefined();
  expect(parseOutsideDiscoveryTargets([{agentName:'worker',connectionName:'connector',credentialStatus:{...credentialStatus,state:'active'}}])).toBeUndefined();
});

it('requires literal consent and accepts only preview expectations and the bearer',async()=>{
  const input={consent:true,requestId,claimOperationId,accountId,agentName:'worker',connectionName:'connector',expectedGeneration:0,
    expectedCandidateRevision:null,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:1,expectedDestinationHash:'b'.repeat(64),
    expectedRoutePolicyHash:'c'.repeat(64),consentGeneration:1,credential:'private-token'};
  await expect(discoverOutsideTools({...input,consent:false})).rejects.toThrow(/Invalid discovery/);
  await expect(discoverOutsideTools({...input,endpoint:'https://attacker.test'})).rejects.toThrow(/Invalid discovery/);
  expect(mocks.keeper).not.toHaveBeenCalled();
  await discoverOutsideTools(input);
  expect(mocks.keeper).toHaveBeenCalledWith('outside.discover',{sessionToken,...input},auditActor);
});

it('maps an uncertain transport response to inspect-only state without retrying',async()=>{
  const unknown=Object.assign(new KeeperUnavailableError('unknown'),{outcomeMayBeUnknown:true});
  mocks.keeper.mockRejectedValueOnce(unknown);
  const input={consent:true,requestId,claimOperationId,accountId,agentName:'worker',connectionName:'connector',expectedGeneration:0,
    expectedCandidateRevision:null,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:1,expectedDestinationHash:'b'.repeat(64),
    expectedRoutePolicyHash:'c'.repeat(64),consentGeneration:1,credential:'private-token'};
  await expect(discoverOutsideTools(input)).resolves.toEqual({state:'unknown'});
  expect(mocks.keeper).toHaveBeenCalledTimes(1);
  mocks.keeper.mockResolvedValueOnce({state:'unresolved'});
  await inspectOutsideDiscovery({accountId,agentName:'worker',connectionName:'connector',requestId,claimOperationId});
  expect(mocks.keeper).toHaveBeenLastCalledWith('outside.discovery-inspect',{sessionToken,accountId,agentName:'worker',connectionName:'connector',requestId,claimOperationId},auditActor);
});

it('turns malformed completed discovery and inspection payloads into unknown or unresolved',async()=>{
  const input={consent:true,requestId,claimOperationId,accountId,agentName:'worker',connectionName:'connector',expectedGeneration:0,
    expectedCandidateRevision:null,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:1,expectedDestinationHash:'b'.repeat(64),
    expectedRoutePolicyHash:'c'.repeat(64),consentGeneration:1,credential:'private-token'};
  mocks.keeper.mockResolvedValueOnce({protocolVersion:'2025-06-18',serverInfo:{name:'sample',version:'1'},tools:[],unexpected:true});
  await expect(discoverOutsideTools(input)).resolves.toEqual({state:'unknown'});
  mocks.keeper.mockResolvedValueOnce({state:'complete',document:{protocolVersion:'2025-06-18',serverInfo:{name:'sample',version:'1'},tools:[],extra:true}});
  await expect(inspectOutsideDiscovery({accountId,agentName:'worker',connectionName:'connector',requestId,claimOperationId}))
    .resolves.toEqual({state:'unresolved'});
});

it('accepts normalized tool descriptions with empty text and permitted multiline controls',async()=>{
  const document={protocolVersion:'2025-06-18',serverInfo:{name:'sample',version:'1'},tools:[
    {name:'empty-description',description:'',inputSchema:{}},
    {name:'multiline-description',description:'first line\nsecond line\tindented\r',inputSchema:{}},
  ]};
  mocks.keeper.mockResolvedValueOnce(document);
  const input={consent:true,requestId,claimOperationId,accountId,agentName:'worker',connectionName:'connector',expectedGeneration:0,
    expectedCandidateRevision:null,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:1,expectedDestinationHash:'b'.repeat(64),
    expectedRoutePolicyHash:'c'.repeat(64),consentGeneration:1,credential:'private-token'};
  await expect(discoverOutsideTools(input)).resolves.toEqual({state:'complete',document});
});

it('accepts only the exact reviewed tool set and rejects invalid tool names or altered allow lists',()=>{
  const descriptor={version:1,connectionName:'connector',scope:'read',allow:['lookup_alpha'],read:['lookup_alpha'],
    tools:[{name:'lookup_alpha',description:'Find a record',inputSchema:{type:'object'}}]};
  const review={descriptor,descriptorHash:'d'.repeat(64),expectedGeneration:1,expectedCandidateRevision:null,
    expectedConsentGeneration:2,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:1};
  expect(parseOutsideDescriptorReview(review)?.descriptor.allow).toEqual(['lookup_alpha']);
  expect(parseOutsideDescriptorReview({...review,descriptor:{...descriptor,tools:[...descriptor.tools,{name:'extra',inputSchema:{}}]}})).toBeUndefined();
  expect(parseOutsideDescriptorReview({...review,descriptor:{...descriptor,allow:['lookup_alpha','extra']}})).toBeUndefined();
  expect(parseOutsideDescriptorReview({...review,descriptor:{...descriptor,tools:[{...descriptor.tools[0],name:'lookup\u0001alpha'}]}})).toBeUndefined();
});

it('refuses missing session or unavailable active-member audit identity before Keeper',async()=>{
  mocks.member.mockResolvedValueOnce(null);
  await expect(listOutsideDiscoveryTargets()).rejects.toThrow(/Sign in again/);
  expect(mocks.auditAddress).not.toHaveBeenCalled();expect(mocks.keeper).not.toHaveBeenCalled();
  mocks.auditAddress.mockResolvedValueOnce(null);
  await expect(listOutsideDiscoveryTargets()).rejects.toThrow(/Sign in again/);
  expect(mocks.keeper).not.toHaveBeenCalled();
});

it('derives the custodian from the signed-in session for exact preview, publication, acceptance and stage',async()=>{
  const discovery={accountId,agentName:'worker',connectionName:'connector',requestId,claimOperationId};
  const descriptor={version:1,connectionName:'connector',scope:'read',allow:['lookup_alpha'],read:['lookup_alpha'],
    tools:[{name:'lookup_alpha',description:'Lookup',inputSchema:{type:'object'}}]};
  const review={descriptor,descriptorHash:'d'.repeat(64),expectedGeneration:1,expectedCandidateRevision:null,expectedConsentGeneration:2,
    expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:1};
  mocks.keeper.mockResolvedValueOnce(review);
  await previewOutsideDescriptorReview(discovery);
  expect(mocks.keeper).toHaveBeenLastCalledWith('outside.discovery-review-preview',{sessionToken,...discovery},auditActor);

  mocks.keeper.mockResolvedValueOnce({publicationId:'00000000-0000-4000-8000-000000000004',publicationHash:'b'.repeat(64),descriptor});
  await publishOutsideDescriptorReview({...discovery,expectedGeneration:1,expectedDescriptorHash:review.descriptorHash});
  expect(mocks.keeper).toHaveBeenLastCalledWith('outside.discovery-review-publish',{sessionToken,...discovery,expectedGeneration:1,
    expectedDescriptorHash:review.descriptorHash},auditActor);

  const publication={publicationId:'00000000-0000-4000-8000-000000000004',publicationHash:'b'.repeat(64)};
  mocks.keeper.mockResolvedValueOnce(review).mockResolvedValueOnce({acceptanceId:'00000000-0000-4000-8000-000000000005',
    publicationHash:publication.publicationHash,acceptanceHash:'c'.repeat(64)});
  await acceptOutsideDescriptorReview({...discovery,publicationId:publication.publicationId,expectedPublicationHash:publication.publicationHash});
  expect(mocks.keeper).toHaveBeenNthCalledWith(3,'outside.discovery-review-preview',{sessionToken,...discovery},auditActor);
  expect(mocks.keeper).toHaveBeenNthCalledWith(4,'outside.discovery-review-accept',{sessionToken,accountId,publicationId:publication.publicationId,
    expectedPublicationHash:publication.publicationHash},auditActor);

  const stage={...discovery,publicationId:publication.publicationId,acceptanceId:'00000000-0000-4000-8000-000000000005',
    expectedGeneration:1,expectedCandidateRevision:null,expectedConsentGeneration:2,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:1,
    expectedPublicationHash:publication.publicationHash,expectedAcceptanceHash:'c'.repeat(64)};
  const staged={staged:true,activationReviewId:'00000000-0000-4000-8000-000000000006',activationReviewHash:'d'.repeat(64),
    expectedPolicyHash:'e'.repeat(64),stageOperationId:'00000000-0000-4000-8000-000000000007',candidateRevision:7};
  mocks.keeper.mockResolvedValueOnce(staged);
  await expect(stageOutsideCredentialCandidate(stage)).resolves.toEqual(staged);
  expect(mocks.keeper).toHaveBeenLastCalledWith('outside.candidate-stage',{sessionToken,...stage},auditActor);
  const {staged:_staged,...receipt}=staged;
  const apply={...stage,...receipt};
  mocks.keeper.mockResolvedValueOnce({kind:'apply',outcome:'applied',credentialRevision:7});
  await expect(applyOutsideCredentialCandidate(apply)).resolves.toEqual({state:'applied',credentialRevision:7});
  expect(mocks.keeper).toHaveBeenLastCalledWith('outside.candidate-apply',{sessionToken,...apply},auditActor,{timeoutMs:90_000});
  await expect(previewOutsideDescriptorReview({...discovery,actor:'submitted'})).rejects.toThrow(/Invalid discovery input/);
});

it('recovers an exact pending Apply projection using the signed-in custodian session',async()=>{
  const pending={accountId,agentName:'worker',connectionName:'connector',requestId,claimOperationId,publicationId:requestId,acceptanceId:claimOperationId,
    expectedGeneration:1,expectedCandidateRevision:null,expectedConsentGeneration:2,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:1,
    expectedPublicationHash:'b'.repeat(64),expectedAcceptanceHash:'c'.repeat(64),expectedPolicyHash:'d'.repeat(64),activationReviewId:requestId,
    activationReviewHash:'e'.repeat(64),stageOperationId:claimOperationId,candidateRevision:7};
  mocks.keeper.mockResolvedValueOnce(pending);
  await expect(previewOutsideCredentialApply({agentName:'worker',connectionName:'connector'})).resolves.toEqual(pending);
  expect(mocks.keeper).toHaveBeenLastCalledWith('outside.candidate-apply-preview',{sessionToken,agentName:'worker',connectionName:'connector'},auditActor);
  await expect(previewOutsideCredentialApply({agentName:'worker',connectionName:'connector',candidateRevision:7})).rejects.toThrow(/Invalid discovery input/);
});
