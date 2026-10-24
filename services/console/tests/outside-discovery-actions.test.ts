import { beforeEach,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({member:vi.fn(),auditAddress:vi.fn(),keeper:vi.fn(),cookie:vi.fn()}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>({value:mocks.cookie()})})}));
vi.mock('../lib/auth',()=>({sessionMember:mocks.member,memberAuditAddress:mocks.auditAddress}));
vi.mock('../lib/keeper-client',()=>({keeper:mocks.keeper,KeeperRefusedError:class extends Error{},KeeperUnavailableError:class extends Error{outcomeMayBeUnknown=false;}}));
import { discoverOutsideTools,inspectOutsideDiscovery,listOutsideDiscoveryTargets,previewOutsideDiscovery } from '../app/actions/outside-discovery.js';
import { KeeperUnavailableError } from '../lib/keeper-client.js';

const sessionToken='S'.repeat(43),accountId='00000000-0000-4000-8000-000000000001',requestId='00000000-0000-4000-8000-000000000002',
  claimOperationId='00000000-0000-4000-8000-000000000003';
const preview={accountId,requestId,claimOperationId,agentName:'worker',connectionName:'connector',endpoint:'https://example.test/mcp',
  purpose:'streamable-http-discovery-v1',definitionHash:'a'.repeat(64),accessRevision:1,destinationHash:'b'.repeat(64),
  routePolicyHash:'c'.repeat(64),expectedGeneration:0,expectedCandidateRevision:null,consentGeneration:1};
const memberId='11111111-1111-4111-8111-111111111111',auditActor='member@example.test';
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
  mocks.keeper.mockResolvedValueOnce([{agentName:'worker',connectionName:'connector',extra:'ignored'}]);
  await expect(listOutsideDiscoveryTargets()).rejects.toThrow(/unavailable/);
  mocks.keeper.mockResolvedValueOnce({accountId,requestId,claimOperationId,agentName:'worker',connectionName:'connector',
    endpoint:`https://${'x'.repeat(8200)}.test/mcp`,purpose:'streamable-http-discovery-v1',definitionHash:'a'.repeat(64),accessRevision:1,
    destinationHash:'b'.repeat(64),routePolicyHash:'c'.repeat(64),expectedGeneration:0,expectedCandidateRevision:null,consentGeneration:1});
  await expect(previewOutsideDiscovery({agentName:'worker',connectionName:'connector'})).rejects.toThrow(/unavailable/);
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

it('refuses missing session or unavailable active-member audit identity before Keeper',async()=>{
  mocks.member.mockResolvedValueOnce(null);
  await expect(listOutsideDiscoveryTargets()).rejects.toThrow(/Sign in again/);
  expect(mocks.auditAddress).not.toHaveBeenCalled();expect(mocks.keeper).not.toHaveBeenCalled();
  mocks.auditAddress.mockResolvedValueOnce(null);
  await expect(listOutsideDiscoveryTargets()).rejects.toThrow(/Sign in again/);
  expect(mocks.keeper).not.toHaveBeenCalled();
});
