import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { registerHumanOutsideDiscoveryActions } from '../lib/outside-discovery-actions.js';
import { actionNames,resetActions,runAction } from '../lib/actions.js';
import type { OutsideCustodyStore } from '../lib/outside-custody.js';

const methods=vi.hoisted(()=>({targets:vi.fn(),preview:vi.fn(),discover:vi.fn(),inspect:vi.fn()}));
const sessionToken='S'.repeat(43),accountId='00000000-0000-4000-8000-000000000001',requestId='00000000-0000-4000-8000-000000000002',claimOperationId='00000000-0000-4000-8000-000000000003';
const base={sessionToken,consent:true,accountId,requestId,claimOperationId,agentName:'worker',connectionName:'connector',expectedGeneration:0,
  expectedCandidateRevision:null,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:1,expectedDestinationHash:'b'.repeat(64),
  expectedRoutePolicyHash:'c'.repeat(64),consentGeneration:1,credential:'private-token'};
const audit=vi.fn(async()=>{});
beforeEach(()=>{vi.clearAllMocks();registerHumanOutsideDiscoveryActions({listHumanDiscoveryTargets:methods.targets,
  previewHumanDiscovery:methods.preview,consentAndDiscover:methods.discover,inspectHumanDiscovery:methods.inspect} as unknown as OutsideCustodyStore);});
afterEach(()=>resetActions());

it('registers only private member discovery actions and strictly requires explicit consent',async()=>{
  expect(actionNames()).toEqual(['outside.discover','outside.discovery-inspect','outside.discovery-preview','outside.discovery-targets']);
  methods.discover.mockResolvedValue({protocolVersion:'2025-06-18',serverInfo:{name:'sample',version:'1'},tools:[]});
  await expect(runAction('outside.discover',{...base,consent:false},{actor:'derived-member',audit})).rejects.toThrow(/invalid input/);
  expect(methods.discover).not.toHaveBeenCalled();
  const result=await runAction('outside.discover',base,{actor:'derived-member',audit});
  expect(result).toEqual({protocolVersion:'2025-06-18',serverInfo:{name:'sample',version:'1'},tools:[]});
  expect(methods.discover).toHaveBeenCalledWith(sessionToken,expect.objectContaining({operationId:claimOperationId,accountId,agentName:'worker'}),
    expect.objectContaining({deadlineAtMs:expect.any(Number)}));
  const discoverCall=methods.discover.mock.calls[0] as unknown as [string,{credential:Buffer},unknown];
  expect(Buffer.isBuffer(discoverCall[1].credential)).toBe(true);
  const auditCalls=audit.mock.calls as unknown as [unknown][];
  const record=auditCalls.find(([entry])=>(entry as {outcome?:string}).outcome==='pending')?.[0] as {actor:string;input:Record<string,string>};
  expect(record.actor).toBe('derived-member');
  expect(record.input).toMatchObject({sessionToken:'<redacted>',credential:'<redacted>'});
});

it('keeps target, preview and inspection inputs strict and passes only the session plus exact selection',async()=>{
  methods.targets.mockResolvedValue([{agentName:'worker',connectionName:'connector'}]);
  methods.preview.mockResolvedValue({endpoint:'https://example.test/mcp'});
  methods.inspect.mockResolvedValue({state:'unresolved'});
  await expect(runAction('outside.discovery-targets',{sessionToken},{actor:'member',audit})).resolves.toEqual([{agentName:'worker',connectionName:'connector'}]);
  await expect(runAction('outside.discovery-preview',{sessionToken,agentName:'worker',connectionName:'connector',endpoint:'https://evil.test'},
    {actor:'member',audit})).rejects.toThrow(/invalid input/);
  await expect(runAction('outside.discovery-preview',{sessionToken,agentName:'worker',connectionName:'connector'},
    {actor:'member',audit})).resolves.toEqual({endpoint:'https://example.test/mcp'});
  await expect(runAction('outside.discovery-inspect',{sessionToken,accountId,agentName:'worker',connectionName:'connector',requestId,claimOperationId},
    {actor:'member',audit})).resolves.toEqual({state:'unresolved'});
  expect(methods.preview).toHaveBeenCalledWith(sessionToken,{agentName:'worker',connectionName:'connector'},expect.any(Object));
  expect(methods.inspect).toHaveBeenCalledWith(sessionToken,{accountId,agentName:'worker',connectionName:'connector',requestId,claimOperationId},expect.any(Object));
});
