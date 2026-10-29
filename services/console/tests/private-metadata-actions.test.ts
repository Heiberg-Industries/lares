import {beforeEach,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({cookie:'member-a-session',sessionMember:vi.fn(),audit:vi.fn(),keeper:vi.fn(),createdFor:[] as string[],resources:[] as string[]}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='lares_session'&&mocks.cookie?{value:mocks.cookie}:undefined})}));
vi.mock('../lib/auth',()=>({sessionMember:mocks.sessionMember,memberAuditAddress:mocks.audit}));
vi.mock('../lib/keeper-client',async original=>({...await original<typeof import('../lib/keeper-client')>(),keeper:mocks.keeper}));
vi.mock('../lib/db',()=>({pool:{}}));
vi.mock('@lares/agent-kit/account-store',()=>({PgAccountStore:class{
  forTrustedAdapter(adapter:unknown){return {createPersonalAccount:async(memberId:string)=>{
    mocks.createdFor.push(memberId);return {id:`account-${memberId}`,generation:0};
  }};}
  async listResources(memberId:string){mocks.resources.push(memberId);return [{id:`resource-${memberId}`,resourceKind:'dataset',externalId:`dataset-${memberId}`}];}
}}));
import {createPrivateMetadataDataset,issuePrivateMetadataDevice,previewPrivateMetadataTarget} from '../app/actions/private-metadata';

const member='member-a',datasetArgs={accountId:'11111111-1111-4111-8111-111111111111',resourceBindingId:'22222222-2222-4222-8222-222222222222',
  agentName:'worker',connectionName:'mac-private-metadata',consent:true,expectedDescriptorFingerprint:'a'.repeat(64)};
const uploadToken='U'.repeat(43),deviceId='33333333-3333-4333-8333-333333333333';
beforeEach(()=>{vi.clearAllMocks();mocks.createdFor.length=0;mocks.resources.length=0;mocks.cookie='member-a-session';mocks.sessionMember.mockImplementation(async(token:string)=>token==='member-a-session'?{id:member}:null);
  mocks.audit.mockImplementation(async(memberId:string)=>`audit:${memberId}`);mocks.keeper.mockResolvedValue({deviceId,deviceGeneration:1,accountGeneration:0,uploadToken});});

it('creates a dataset for the verified session member and ignores caller identity fields',async()=>{
  await expect(createPrivateMetadataDataset()).resolves.toEqual({accountId:`account-${member}`,generation:0,
    resourceBindingId:`resource-${member}`,datasetId:`dataset-${member}`});
  expect(mocks.createdFor).toEqual([member]);expect(mocks.resources).toEqual([member]);
});

it('refuses missing or forged sessions before dataset creation, preview, or credential issue',async()=>{
  mocks.cookie='';await expect(createPrivateMetadataDataset()).rejects.toThrow(/Sign in again/);
  mocks.cookie='forged-session';await expect(previewPrivateMetadataTarget('worker')).rejects.toThrow(/Sign in again/);
  await expect(issuePrivateMetadataDevice(datasetArgs)).rejects.toThrow(/Sign in again/);
  expect(mocks.createdFor).toEqual([]);expect(mocks.keeper).not.toHaveBeenCalled();
});

it('binds consent to the session and exact descriptor fingerprint, returning the upload token only as the action result',async()=>{
  await expect(issuePrivateMetadataDevice(datasetArgs)).resolves.toEqual({deviceId,deviceGeneration:1,accountGeneration:0,uploadToken});
  expect(mocks.keeper).toHaveBeenCalledWith('private-metadata.device-issue',{sessionToken:'member-a-session',...datasetArgs},'audit:member-a');
  expect(JSON.stringify(mocks.keeper.mock.calls)).not.toContain(uploadToken);
});

it('shows the currently configured descriptor preview only to the authenticated member session',async()=>{
  const preview={agentName:'worker',connectionName:'mac-private-metadata',descriptorFingerprint:'b'.repeat(64),tools:['lookup'],
    purpose:'read-only private metadata lookup'};
  mocks.keeper.mockResolvedValue(preview);
  await expect(previewPrivateMetadataTarget('worker')).resolves.toEqual(preview);
  expect(mocks.keeper).toHaveBeenCalledWith('private-metadata.target-preview',{sessionToken:'member-a-session',agentName:'worker'},'audit:member-a');
});

it('cannot use another member account by supplying its IDs; Keeper refuses under the verified session',async()=>{
  mocks.keeper.mockRejectedValue(new Error('Keeper refused the account/member binding'));
  await expect(issuePrivateMetadataDevice({...datasetArgs,accountId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})).rejects.toThrow(/unavailable/);
  const [action,input]=mocks.keeper.mock.calls[0]!;
  expect(action).toBe('private-metadata.device-issue');expect(input.sessionToken).toBe('member-a-session');
  expect(input).not.toHaveProperty('memberId');
});
