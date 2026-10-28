// @vitest-environment jsdom
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';

const actions=vi.hoisted(()=>({targets:vi.fn(),preview:vi.fn(),discover:vi.fn(),inspect:vi.fn(),review:vi.fn(),publish:vi.fn(),accept:vi.fn(),stage:vi.fn(),apply:vi.fn(),previewApply:vi.fn()}));
vi.mock('../app/actions/outside-discovery',()=>({listOutsideDiscoveryTargets:actions.targets,previewOutsideDiscovery:actions.preview,
  discoverOutsideTools:actions.discover,inspectOutsideDiscovery:actions.inspect,previewOutsideDescriptorReview:actions.review,
  publishOutsideDescriptorReview:actions.publish,acceptOutsideDescriptorReview:actions.accept,stageOutsideCredentialCandidate:actions.stage,
  applyOutsideCredentialCandidate:actions.apply,previewOutsideCredentialApply:actions.previewApply}));
import { OutsideDiscoverySection } from '../components/OutsideDiscoverySection.js';

const tuple={accountId:'00000000-0000-4000-8000-000000000001',requestId:'00000000-0000-4000-8000-000000000002',
  claimOperationId:'00000000-0000-4000-8000-000000000003',agentName:'worker',connectionName:'connector'};
const preview={...tuple,endpoint:'https://exact.example.test/mcp',purpose:'streamable-http-discovery-v1' as const,definitionHash:'a'.repeat(64),accessRevision:1,
  destinationHash:'b'.repeat(64),routePolicyHash:'c'.repeat(64),expectedGeneration:0,expectedCandidateRevision:null,consentGeneration:1};
const document={protocolVersion:'2025-06-18',serverInfo:{name:'sample',version:'1'},tools:[{name:'read',description:'Read a record',inputSchema:{type:'object'}}]};
const descriptorReview={descriptor:{version:1 as const,connectionName:'connector',scope:'read' as const,allow:['read'],read:['read'],tools:document.tools},
  descriptorHash:'d'.repeat(64),expectedGeneration:1,expectedCandidateRevision:null,expectedConsentGeneration:2,
  expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:1};
const publication={publicationId:'00000000-0000-4000-8000-000000000004',publicationHash:'b'.repeat(64),descriptor:descriptorReview.descriptor};
const acceptance={acceptanceId:'00000000-0000-4000-8000-000000000005',publicationHash:publication.publicationHash,acceptanceHash:'c'.repeat(64)};
const recoveryKey=(memberId:string)=>`lares.outside.discovery.recovery.v1:${encodeURIComponent(memberId)}`;
beforeEach(()=>{vi.clearAllMocks();sessionStorage.clear();actions.targets.mockResolvedValue([{agentName:'worker',connectionName:'connector',
  credentialStatus:{state:'unavailable',reviewPending:false,applyPending:false,activeRevision:null,candidateRevision:null,discoveryRevision:null}}]);
  actions.preview.mockResolvedValue(preview);actions.discover.mockResolvedValue({state:'complete',document});actions.inspect.mockResolvedValue({state:'unresolved'});
  actions.review.mockResolvedValue(descriptorReview);actions.publish.mockResolvedValue(publication);actions.accept.mockResolvedValue(acceptance);
  actions.stage.mockResolvedValue({staged:true,activationReviewId:'00000000-0000-4000-8000-000000000006',activationReviewHash:'d'.repeat(64),
    expectedPolicyHash:'e'.repeat(64),stageOperationId:'00000000-0000-4000-8000-000000000007',candidateRevision:7});
  actions.apply.mockResolvedValue({state:'applied',credentialRevision:7});});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

it('shows the active credential separately from a pending token-only replacement without displaying credential data',async()=>{
  actions.targets.mockResolvedValue([{agentName:'worker',connectionName:'connector',credentialStatus:{state:'active',
    reviewPending:true,applyPending:false,activeRevision:3,candidateRevision:null,discoveryRevision:4}}]);
  render(<OutsideDiscoverySection memberId="member-a"/>);
  await screen.findByText("A completed discovery is pending review. The active saved credential revision remains in place.");
  expect(screen.queryByText(/private-token|ciphertext|policy/i)).toBeNull();
});

it('labels a staged replacement as pending Apply, separately from completed discovery review',async()=>{
  actions.targets.mockResolvedValue([{agentName:'worker',connectionName:'connector',credentialStatus:{state:'active-pending',
    reviewPending:false,applyPending:true,activeRevision:3,candidateRevision:5,discoveryRevision:4}}]);
  render(<OutsideDiscoverySection memberId="member-a"/>);
  await screen.findByText("A staged credential revision is pending Apply. The previous active saved revision remains in place.");
});

it('reports both phases when a newer discovery and a staged candidate coexist',async()=>{
  actions.targets.mockResolvedValue([{agentName:'worker',connectionName:'connector',credentialStatus:{state:'active-pending',
    reviewPending:true,applyPending:true,activeRevision:3,candidateRevision:5,discoveryRevision:6}}]);
  render(<OutsideDiscoverySection memberId="member-a"/>);
  await screen.findByText("A completed discovery is pending review and a staged credential revision is pending Apply. The active saved revision remains in place.");
});

async function prepareConsent(){
  render(<OutsideDiscoverySection memberId="member-a"/>);
  await waitFor(()=>expect((screen.getByRole('button',{name:'Review connection'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'Review connection'}));
  await screen.findByText('https://exact.example.test/mcp');
  fireEvent.change(screen.getByLabelText('Bearer credential'),{target:{value:'private-token'}});
}

it('saves only the recovery tuple before enabling one explicit consent and never stores the credential',async()=>{
  await prepareConsent();
  const submit=screen.getByRole('button',{name:'Send one discovery request'});
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  expect((submit as HTMLButtonElement).disabled).toBe(false);
  expect(JSON.parse(sessionStorage.getItem(recoveryKey('member-a'))!)).toEqual(tuple);
  expect(sessionStorage.getItem(recoveryKey('member-a'))).not.toContain('private-token');
  fireEvent.click(submit);
  await screen.findByText('Exact current tool descriptions are ready for your review. No credential has been staged.');
  expect(actions.discover).toHaveBeenCalledTimes(1);
  expect(actions.inspect).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Bearer credential') as HTMLInputElement).value).toBe('');
  expect((screen.getByRole('button',{name:'Send one discovery request'}) as HTMLButtonElement).disabled).toBe(true);
});

it('reviews exact descriptions, records and accepts them, then stages a candidate pending Apply',async()=>{
  actions.targets.mockResolvedValueOnce([{agentName:'worker',connectionName:'connector',credentialStatus:{state:'unavailable',reviewPending:false,
    applyPending:false,activeRevision:null,candidateRevision:null,discoveryRevision:null}}]).mockResolvedValueOnce([{agentName:'worker',connectionName:'connector',
      credentialStatus:{state:'pending',reviewPending:false,applyPending:true,activeRevision:null,candidateRevision:7,discoveryRevision:4}}]);
  await prepareConsent();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button',{name:'Send one discovery request'}));
  await screen.findByText('Exact current tool descriptions are ready for your review. No credential has been staged.');
  await screen.findByText('Exact descriptions covered by this review');
  expect(actions.review).toHaveBeenCalledWith(tuple);
  expect(screen.getAllByText('Read a record')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button',{name:'Record these exact descriptions for acceptance'}));
  await screen.findByRole('button',{name:'Accept these exact descriptions'});
  fireEvent.click(screen.getByRole('button',{name:'Accept these exact descriptions'}));
  await screen.findByRole('button',{name:'Stage credential candidate'});
  fireEvent.click(screen.getByRole('button',{name:'Stage credential candidate'}));
  await screen.findByText(/Credential revision 7 is pending Apply and is not active/);
  expect(actions.publish).toHaveBeenCalledWith({...tuple,expectedGeneration:1,expectedDescriptorHash:'d'.repeat(64)});
  expect(actions.accept).toHaveBeenCalledWith({...tuple,publicationId:publication.publicationId,expectedPublicationHash:publication.publicationHash});
  expect(actions.stage).toHaveBeenCalledWith({...tuple,publicationId:publication.publicationId,acceptanceId:acceptance.acceptanceId,
    expectedGeneration:1,expectedCandidateRevision:null,expectedConsentGeneration:2,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:1,
    expectedPublicationHash:publication.publicationHash,expectedAcceptanceHash:acceptance.acceptanceHash});
});

it('applies the exact staged custody revision and reports no runtime claim',async()=>{
  actions.targets.mockResolvedValueOnce([{agentName:'worker',connectionName:'connector',credentialStatus:{state:'unavailable',reviewPending:false,
    applyPending:false,activeRevision:null,candidateRevision:null,discoveryRevision:null}}]).mockResolvedValueOnce([{agentName:'worker',connectionName:'connector',
      credentialStatus:{state:'pending',reviewPending:false,applyPending:true,activeRevision:null,candidateRevision:7,discoveryRevision:4}}])
    .mockResolvedValueOnce([{agentName:'worker',connectionName:'connector',credentialStatus:{state:'active',reviewPending:false,applyPending:false,
      activeRevision:7,candidateRevision:null,discoveryRevision:4}}]);
  await prepareConsent();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Send one discovery request'}));
  await screen.findByText('Exact current tool descriptions are ready for your review. No credential has been staged.');
  fireEvent.click(screen.getByRole('button',{name:'Record these exact descriptions for acceptance'}));
  await screen.findByRole('button',{name:'Accept these exact descriptions'});fireEvent.click(screen.getByRole('button',{name:'Accept these exact descriptions'}));
  await screen.findByRole('button',{name:'Stage credential candidate'});fireEvent.click(screen.getByRole('button',{name:'Stage credential candidate'}));
  const apply=await screen.findByRole('button',{name:'Apply credential revision'});fireEvent.click(apply);
  await screen.findByText(/Credential revision 7 is active in Keeper custody/);
  expect(actions.apply).toHaveBeenCalledWith(expect.objectContaining({candidateRevision:7,stageOperationId:'00000000-0000-4000-8000-000000000007',
    expectedPolicyHash:'e'.repeat(64),activationReviewHash:'d'.repeat(64)}));
  expect(screen.getByText(/does not confirm that the outside server is reachable or the agent is running/)).toBeTruthy();
});

it('recovers exact pending Apply evidence after reload and applies only the projected revision',async()=>{
  const pending={...tuple,publicationId:'00000000-0000-4000-8000-000000000004',acceptanceId:'00000000-0000-4000-8000-000000000005',
    expectedGeneration:1,expectedCandidateRevision:null,expectedConsentGeneration:2,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:1,
    expectedPublicationHash:'b'.repeat(64),expectedAcceptanceHash:'c'.repeat(64),expectedPolicyHash:'e'.repeat(64),
    activationReviewId:'00000000-0000-4000-8000-000000000006',activationReviewHash:'d'.repeat(64),
    stageOperationId:'00000000-0000-4000-8000-000000000007',candidateRevision:7};
  actions.targets.mockResolvedValue([{agentName:'worker',connectionName:'connector',credentialStatus:{state:'pending',reviewPending:false,
    applyPending:true,activeRevision:null,candidateRevision:7,discoveryRevision:4}}]);
  actions.previewApply.mockResolvedValue(pending);
  render(<OutsideDiscoverySection memberId="member-reload"/>);
  const button=await screen.findByRole('button',{name:'Apply credential revision'});
  expect(actions.previewApply).toHaveBeenCalledWith({agentName:'worker',connectionName:'connector'});
  fireEvent.click(button);
  await screen.findByText(/Credential revision 7 is active in Keeper custody/);
  expect(actions.apply).toHaveBeenCalledWith(pending);
});

it('clears a recovered receipt on refresh when the selected target changes at the same revision number',async()=>{
  const pending={...tuple,agentName:'other',publicationId:'00000000-0000-4000-8000-000000000004',acceptanceId:'00000000-0000-4000-8000-000000000005',
    expectedGeneration:1,expectedCandidateRevision:null,expectedConsentGeneration:2,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:1,
    expectedPublicationHash:'b'.repeat(64),expectedAcceptanceHash:'c'.repeat(64),expectedPolicyHash:'e'.repeat(64),
    activationReviewId:'00000000-0000-4000-8000-000000000006',activationReviewHash:'d'.repeat(64),
    stageOperationId:'00000000-0000-4000-8000-000000000007',candidateRevision:2};
  const status=(agentName:string)=>({agentName,connectionName:'connector',credentialStatus:{state:'active-pending',reviewPending:false,
    applyPending:true,activeRevision:1,candidateRevision:2,discoveryRevision:1}});
  actions.targets.mockResolvedValueOnce([status('worker'),status('other')]).mockResolvedValueOnce([status('worker')]);
  actions.previewApply.mockResolvedValue(pending);
  render(<OutsideDiscoverySection memberId="member-target-refresh"/>);
  const select=await screen.findByLabelText('Agent connection');
  fireEvent.change(select,{target:{value:'other\0connector'}});
  await screen.findByRole('button',{name:'Apply credential revision'});
  fireEvent.click(screen.getByRole('button',{name:'Refresh connections'}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Apply credential revision'})).toBeNull());
  expect(actions.apply).not.toHaveBeenCalled();
});

it('ignores delayed pending-receipt recovery after an A to B to A selection change',async()=>{
  const status=(agentName:string)=>({agentName,connectionName:'connector',credentialStatus:{state:agentName==='worker'?'active':'active-pending',reviewPending:false,
    applyPending:agentName!=='worker',activeRevision:agentName==='worker'?null:1,candidateRevision:agentName==='worker'?null:2,discoveryRevision:1}});
  const pending={...tuple,publicationId:'00000000-0000-4000-8000-000000000004',acceptanceId:'00000000-0000-4000-8000-000000000005',
    expectedGeneration:1,expectedCandidateRevision:null,expectedConsentGeneration:2,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:1,
    expectedPublicationHash:'b'.repeat(64),expectedAcceptanceHash:'c'.repeat(64),expectedPolicyHash:'e'.repeat(64),
    activationReviewId:'00000000-0000-4000-8000-000000000006',activationReviewHash:'d'.repeat(64),
    stageOperationId:'00000000-0000-4000-8000-000000000007',candidateRevision:2};
  const resolvePending:Array<(value:typeof pending)=>void>=[];
  actions.targets.mockResolvedValue([status('worker'),status('other')]);
  actions.previewApply.mockImplementation(()=>new Promise(resolve=>{resolvePending.push(resolve);}));
  render(<OutsideDiscoverySection memberId="member-target-aba"/>);
  const select=await screen.findByLabelText('Agent connection');
  fireEvent.change(select,{target:{value:'other\0connector'}});
  await waitFor(()=>expect(actions.previewApply).toHaveBeenCalledTimes(1));
  fireEvent.change(select,{target:{value:'worker\0connector'}});
  fireEvent.change(select,{target:{value:'other\0connector'}});
  await waitFor(()=>expect(actions.previewApply).toHaveBeenCalledTimes(2));
  resolvePending[0]({...pending,agentName:'other'});
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Apply credential revision'})).toBeNull());
  expect(actions.apply).not.toHaveBeenCalled();
});

it('hides pending Apply and disables submission when both Apply and its status refresh are lost',async()=>{
  const pending={...tuple,publicationId:'00000000-0000-4000-8000-000000000004',acceptanceId:'00000000-0000-4000-8000-000000000005',
    expectedGeneration:1,expectedCandidateRevision:null,expectedConsentGeneration:2,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:1,
    expectedPublicationHash:'b'.repeat(64),expectedAcceptanceHash:'c'.repeat(64),expectedPolicyHash:'e'.repeat(64),
    activationReviewId:'00000000-0000-4000-8000-000000000006',activationReviewHash:'d'.repeat(64),
    stageOperationId:'00000000-0000-4000-8000-000000000007',candidateRevision:7};
  actions.targets.mockResolvedValue([{agentName:'worker',connectionName:'connector',credentialStatus:{state:'pending',reviewPending:false,
    applyPending:true,activeRevision:null,candidateRevision:7,discoveryRevision:4}}]);
  actions.previewApply.mockResolvedValue(pending);actions.apply.mockRejectedValue(new Error('lost response'));
  render(<OutsideDiscoverySection memberId="member-uncertain"/>);
  const apply=await screen.findByRole('button',{name:'Apply credential revision'});
  actions.targets.mockRejectedValueOnce(new Error('status unavailable'));
  fireEvent.click(apply);
  await screen.findByText(/last Apply result is uncertain/);
  expect(screen.queryByText(/Credential revision 7 is pending Apply and is not active/)).toBeNull();
  expect(screen.queryByRole('button',{name:'Apply credential revision'})).toBeNull();
  expect(actions.apply).toHaveBeenCalledTimes(1);
});

it('does not treat an older pending candidate as success when replacement staging is refused',async()=>{
  const existingPending={agentName:'worker',connectionName:'connector',credentialStatus:{state:'active-pending',reviewPending:false,applyPending:true,
    activeRevision:2,candidateRevision:3,discoveryRevision:2}};
  actions.targets.mockResolvedValue([existingPending]);
  actions.stage.mockRejectedValue(new Error('replacement refused'));
  await prepareConsent();
  fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Send one discovery request'}));
  await screen.findByRole('button',{name:'Record these exact descriptions for acceptance'});
  fireEvent.click(screen.getByRole('button',{name:'Record these exact descriptions for acceptance'}));
  fireEvent.click(await screen.findByRole('button',{name:'Accept these exact descriptions'}));
  fireEvent.click(await screen.findByRole('button',{name:'Stage credential candidate'}));
  await screen.findByText('The stage result could not be confirmed. A pending candidate may be from an earlier attempt; refresh status before proceeding.');
  expect(screen.queryByText('This candidate is pending Apply and is not active.')).toBeNull();
  expect(screen.getByText('A staged credential revision is pending Apply. The previous active saved revision remains in place.')).toBeTruthy();
});

it('ignores a descriptor preview response after the selected connection changes',async()=>{
  let resolveReview!:(value:typeof descriptorReview)=>void;
  actions.targets.mockResolvedValue([
    {agentName:'worker',connectionName:'connector',credentialStatus:{state:'unavailable',reviewPending:false,applyPending:false,activeRevision:null,candidateRevision:null,discoveryRevision:null}},
    {agentName:'worker',connectionName:'connector-two',credentialStatus:{state:'unavailable',reviewPending:false,applyPending:false,activeRevision:null,candidateRevision:null,discoveryRevision:null}},
  ]);
  actions.review.mockImplementationOnce(()=>new Promise(resolve=>{resolveReview=resolve;}));
  render(<OutsideDiscoverySection memberId="member-a"/>);
  fireEvent.click(await screen.findByRole('button',{name:'Review connection'}));
  await screen.findByText('https://exact.example.test/mcp');
  fireEvent.change(screen.getByLabelText('Bearer credential'),{target:{value:'private-token'}});
  fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Send one discovery request'}));
  await waitFor(()=>expect(actions.review).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText('Agent connection'),{target:{value:'worker\0connector-two'}});
  resolveReview(descriptorReview);
  await waitFor(()=>expect(screen.queryByLabelText('Exact tool description review')).toBeNull());
  expect(screen.queryByText('Exact current tool descriptions are ready for your review. No credential has been staged.')).toBeNull();
});

it('refuses consent when same-tab recovery storage fails',async()=>{
  await prepareConsent();
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('storage unavailable');});
  fireEvent.click(screen.getByRole('checkbox'));
  expect((screen.getByRole('button',{name:'Send one discovery request'}) as HTMLButtonElement).disabled).toBe(true);
  expect(await screen.findByText('Recovery information could not be saved in this tab. Consent cannot be sent.')).toBeTruthy();
  expect(actions.discover).not.toHaveBeenCalled();
});

it('inspects a saved request on reload and blocks consent while its outcome is unresolved',async()=>{
  sessionStorage.setItem(recoveryKey('member-a'),JSON.stringify(tuple));
  render(<OutsideDiscoverySection memberId="member-a"/>);
  await screen.findByText('This request has no confirmed result. Its status is unresolved; do not send the consent again.');
  expect(actions.inspect).toHaveBeenCalledWith(tuple);
  expect((screen.getByRole('button',{name:'Review connection'}) as HTMLButtonElement).disabled).toBe(true);
  expect(actions.discover).not.toHaveBeenCalled();
});

it('treats corrupt recovery information as unresolved and never offers consent',async()=>{
  sessionStorage.setItem(recoveryKey('member-a'),JSON.stringify({accountId:'unknown'}));
  render(<OutsideDiscoverySection memberId="member-a"/>);
  await screen.findByText('Saved discovery recovery information is incomplete. Its status cannot be confirmed; do not send consent again.');
  expect((screen.getByRole('button',{name:'Review connection'}) as HTMLButtonElement).disabled).toBe(true);
  expect(actions.discover).not.toHaveBeenCalled();
  expect(actions.inspect).not.toHaveBeenCalled();
});

it('inspects once after an ambiguous submission and never resends the bearer',async()=>{
  actions.discover.mockRejectedValue(new Error('lost reply'));
  await prepareConsent();
  fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Send one discovery request'}));
  await screen.findByText('No completed result is recorded. Its status is unresolved; do not send the consent again.');
  expect(actions.discover).toHaveBeenCalledTimes(1);
  expect(actions.inspect).toHaveBeenCalledWith(tuple);
  expect((screen.getByRole('button',{name:'Review connection'}) as HTMLButtonElement).disabled).toBe(true);
});

it('also inspects a definite transport-unavailable response without making the saved request reusable',async()=>{
  actions.discover.mockResolvedValue({state:'unavailable'});
  await prepareConsent();
  fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Send one discovery request'}));
  await screen.findByText('No completed result is recorded. Its status is unresolved; do not send the consent again.');
  expect(actions.discover).toHaveBeenCalledTimes(1);
  expect(actions.inspect).toHaveBeenCalledWith(tuple);
  expect((screen.getByRole('button',{name:'Review connection'}) as HTMLButtonElement).disabled).toBe(true);
});

it('keeps unresolved recovery private while members switch in one tab and restores it for its owner',async()=>{
  const savedKey=recoveryKey('member-a');
  sessionStorage.setItem(savedKey,JSON.stringify(tuple));
  const view=render(<OutsideDiscoverySection memberId="member-a"/>);
  await screen.findByText('This request has no confirmed result. Its status is unresolved; do not send the consent again.');
  expect(actions.inspect).toHaveBeenCalledTimes(1);
  expect(actions.inspect).toHaveBeenLastCalledWith(tuple);

  view.rerender(<OutsideDiscoverySection memberId="member-b"/>);
  await waitFor(()=>expect((screen.getByRole('button',{name:'Review connection'}) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByText('Recovery reference saved for worker · connector.')).toBeNull();
  expect(screen.queryByText('This request has no confirmed result. Its status is unresolved; do not send the consent again.')).toBeNull();
  expect(actions.inspect).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Review connection'}));
  await screen.findByText('https://exact.example.test/mcp');
  expect(actions.inspect).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(savedKey)).toBe(JSON.stringify(tuple));

  view.rerender(<OutsideDiscoverySection memberId="member-a"/>);
  await screen.findByText('This request has no confirmed result. Its status is unresolved; do not send the consent again.');
  expect(actions.inspect).toHaveBeenCalledTimes(2);
  expect(actions.inspect).toHaveBeenLastCalledWith(tuple);
  expect(actions.discover).not.toHaveBeenCalled();
});

it('inspects a malformed completion response and leaves consent disabled when no valid saved result exists',async()=>{
  actions.discover.mockResolvedValue({state:'unknown'});
  await prepareConsent();
  fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Send one discovery request'}));
  await screen.findByText('No completed result is recorded. Its status is unresolved; do not send the consent again.');
  expect(actions.discover).toHaveBeenCalledTimes(1);
  expect(actions.inspect).toHaveBeenCalledWith(tuple);
  expect((screen.getByRole('button',{name:'Review connection'}) as HTMLButtonElement).disabled).toBe(true);
});
