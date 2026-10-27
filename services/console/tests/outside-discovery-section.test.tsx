// @vitest-environment jsdom
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';

const actions=vi.hoisted(()=>({targets:vi.fn(),preview:vi.fn(),discover:vi.fn(),inspect:vi.fn()}));
vi.mock('../app/actions/outside-discovery',()=>({listOutsideDiscoveryTargets:actions.targets,previewOutsideDiscovery:actions.preview,
  discoverOutsideTools:actions.discover,inspectOutsideDiscovery:actions.inspect}));
import { OutsideDiscoverySection } from '../components/OutsideDiscoverySection.js';

const tuple={accountId:'00000000-0000-4000-8000-000000000001',requestId:'00000000-0000-4000-8000-000000000002',
  claimOperationId:'00000000-0000-4000-8000-000000000003',agentName:'worker',connectionName:'connector'};
const preview={...tuple,endpoint:'https://exact.example.test/mcp',purpose:'streamable-http-discovery-v1' as const,definitionHash:'a'.repeat(64),accessRevision:1,
  destinationHash:'b'.repeat(64),routePolicyHash:'c'.repeat(64),expectedGeneration:0,expectedCandidateRevision:null,consentGeneration:1};
const document={protocolVersion:'2025-06-18',serverInfo:{name:'sample',version:'1'},tools:[{name:'read',description:'Read a record',inputSchema:{type:'object'}}]};
const recoveryKey=(memberId:string)=>`lares.outside.discovery.recovery.v1:${encodeURIComponent(memberId)}`;
beforeEach(()=>{vi.clearAllMocks();sessionStorage.clear();actions.targets.mockResolvedValue([{agentName:'worker',connectionName:'connector',
  credentialStatus:{state:'unavailable',reviewPending:false,applyPending:false,activeRevision:null,candidateRevision:null,discoveryRevision:null}}]);
  actions.preview.mockResolvedValue(preview);actions.discover.mockResolvedValue({state:'complete',document});actions.inspect.mockResolvedValue({state:'unresolved'});});
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
  await screen.findByText('Discovery finished. Review the descriptions below.');
  expect(actions.discover).toHaveBeenCalledTimes(1);
  expect(actions.inspect).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Bearer credential') as HTMLInputElement).value).toBe('');
  expect((screen.getByRole('button',{name:'Send one discovery request'}) as HTMLButtonElement).disabled).toBe(true);
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
