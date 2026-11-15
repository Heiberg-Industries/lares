import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(()=>({keeper:vi.fn(),verify:vi.fn(),cookies:vi.fn()}));
vi.mock('next/headers',()=>({cookies:mocks.cookies}));
vi.mock('../lib/auth',()=>({verify:mocks.verify}));
vi.mock('../lib/keeper-client',async(importOriginal)=>({...await importOriginal<typeof import('../lib/keeper-client')>(),keeper:mocks.keeper}));
import { DELIVERY_KIND_LIST } from '../lib/delivery';
import { createAgent, saveDefinition, retireAgent, deleteAgent, connectDoor, applyConnections, listConversations, startFreshConversation, setDoorEnabled } from '../app/actions/definition';
beforeEach(()=>{ vi.clearAllMocks(); mocks.cookies.mockResolvedValue({get:()=>({value:'cookie'})}); mocks.verify.mockResolvedValue('owner@example.test'); mocks.keeper.mockResolvedValue({hash:'abc',backup:{ok:false,message:'backup failed'},runtime:{pending:true,reason:'doors'}}); });
const input={name:'example',definition:{},duties:'Duties',voice:'Voice'};
it('verifies every mutation before keeper access',async()=>{
 mocks.verify.mockResolvedValue(null);
 for(const action of [()=>createAgent({...input,startingPoint:'creative'}),()=>saveDefinition(input),()=>retireAgent({name:'example'}),()=>deleteAgent({name:'example',confirm:true}),()=>connectDoor({name:'example',kind:'slack',secret:'secret'}),()=>applyConnections({name:'example',hash:'abc'}),()=>listConversations({name:'example'}),()=>startFreshConversation({name:'example',incarnation:'id',sessionId:'wrun_one',confirm:true})]) await expect(action()).rejects.toThrow('unauthenticated');
 expect(mocks.keeper).not.toHaveBeenCalled();
});
it('preserves backup and pending results and authenticated actor',async()=>{
 const result=await saveDefinition(input);
 expect(mocks.keeper).toHaveBeenCalledWith('definition.save',input,'owner@example.test',{timeoutMs:90_000});
 expect(JSON.parse(JSON.stringify(result))).toMatchObject({ok:true,result:{backup:{ok:false},runtime:{pending:true}}});
});
it('waits for slow first-agent lifecycle work before reporting an unknown outcome',async()=>{
 await createAgent({...input,startingPoint:'creative'});
 await applyConnections({name:'example',hash:'abc'});
 expect(mocks.keeper).toHaveBeenNthCalledWith(1,'definition.create',expect.anything(),'owner@example.test',{timeoutMs:60_000});
 expect(mocks.keeper).toHaveBeenNthCalledWith(2,'definition.reconcile',{name:'example',hash:'abc'},'owner@example.test',{timeoutMs:90_000});
});
it('does not retry or hide a post-send failure',async()=>{
 mocks.keeper.mockRejectedValue(new Error('outcome may be unknown'));
 expect(await saveDefinition(input)).toMatchObject({ok:false,error:{outcomeMayBeUnknown:true,message:expect.stringContaining('unknown')}});
 expect(mocks.keeper).toHaveBeenCalledTimes(1);
});
it('requires explicit deletion confirmation',async()=>{
 await expect(deleteAgent({name:'example',confirm:false})).rejects.toThrow('confirmation');
 expect(mocks.keeper).not.toHaveBeenCalled();
 await deleteAgent({name:'example',confirm:true});
 expect(mocks.keeper).toHaveBeenCalledWith('definition.delete',{name:'example',confirm:true},'owner@example.test');
});
it('requires explicit confirmation for a fixed conversation reset',async()=>{
 await expect(startFreshConversation({name:'example',incarnation:'id',sessionId:'wrun_one',confirm:false})).rejects.toThrow('confirmation');
 expect(mocks.keeper).not.toHaveBeenCalled();
 await startFreshConversation({name:'example',incarnation:'id',sessionId:'wrun_one',confirm:true});
 expect(mocks.keeper).toHaveBeenCalledWith('conversation.reset',{name:'example',incarnation:'id',sessionId:'wrun_one',confirm:true},'owner@example.test');
});

it('serializes validation findings across the production server-action boundary',async()=>{
 const {KeeperRefusedError}=await import('../lib/keeper-client');
 mocks.keeper.mockRejectedValue(new KeeperRefusedError('Skill requires a removed grant',[{check:'skills-within-grants',message:'A skill can never widen access'}]));
 const result=JSON.parse(JSON.stringify(await saveDefinition(input)));
 expect(result).toEqual({ok:false,error:{message:'Skill requires a removed grant',findings:[{check:'skills-within-grants',message:'A skill can never widen access'}],outcomeMayBeUnknown:false}});
});

it('gives a door switch the same wait as Apply, since it can stop the agent until Apply',async()=>{
 mocks.keeper.mockResolvedValueOnce({definition:JSON.stringify({doors:[],channels:[]}),duties:'',voice:''});
 await setDoorEnabled('example','telegram',true);
 expect(mocks.keeper).toHaveBeenNthCalledWith(1,'definition.get',{name:'example'},'owner@example.test');
 expect(mocks.keeper).toHaveBeenNthCalledWith(2,'definition.save',expect.objectContaining({name:'example'}),'owner@example.test',{timeoutMs:90_000});
});

it('tells the owner why a door cannot be turned on without its credentials, and that nothing changed',async()=>{
 const {KeeperRefusedError}=await import('../lib/keeper-client');
 const message='Telegram needs a bot token before it can be turned on. Save the credentials first.';
 mocks.keeper.mockResolvedValueOnce({definition:JSON.stringify({doors:[],channels:[]}),duties:'',voice:''});
 mocks.keeper.mockRejectedValueOnce(new KeeperRefusedError(message));
 expect(await setDoorEnabled('example','telegram',true)).toEqual({ok:false,error:{message,findings:undefined,outcomeMayBeUnknown:false}});
});

it('serializes door read failures before mutation, preserving findings without retry',async()=>{
 const {KeeperRefusedError,KeeperUnavailableError}=await import('../lib/keeper-client');
 mocks.keeper.mockRejectedValueOnce(new KeeperRefusedError('Read refused',[{check:'ownership',message:'Different incarnation'}]));
 expect(await setDoorEnabled('example','slack',true)).toEqual({ok:false,error:{message:'Read refused',findings:[{check:'ownership',message:'Different incarnation'}],outcomeMayBeUnknown:false}});
 expect(mocks.keeper).toHaveBeenCalledTimes(1);
 mocks.keeper.mockResolvedValueOnce({definition:'invalid json'});
 expect(await setDoorEnabled('example','slack',true)).toMatchObject({ok:false,error:{outcomeMayBeUnknown:false}});
 expect(mocks.keeper).toHaveBeenCalledTimes(2);
});

describe('the first chat app a new chief of staff is connected to',()=>{
 const starting=()=>Object.fromEntries(DELIVERY_KIND_LIST.map(k=>[k,['web']]));
 const stored=(over:object={})=>({definition:JSON.stringify({role:'chief-of-staff',doors:[],channels:[],delivery:starting(),...over}),duties:'',voice:''});
 const savedDefinition=()=>mocks.keeper.mock.calls.find(c=>c[0]==='definition.save')?.[1].definition;
 it('moves the untouched starting list to that door first, web chat last, in the same save',async()=>{
  mocks.keeper.mockResolvedValueOnce(stored());
  const result=await setDoorEnabled('example','telegram',true);
  expect(mocks.keeper.mock.calls.filter(c=>c[0]==='definition.save')).toHaveLength(1);
  expect(savedDefinition().doors).toEqual([{kind:'telegram',enabled:true,settings:{}}]);
  expect(Object.values(savedDefinition().delivery)).toEqual(DELIVERY_KIND_LIST.map(()=>['telegram','web']));
  expect(result).toMatchObject({ok:true,result:{hash:'abc',messagesFollow:'telegram'}});
 });
 it('leaves an edited list, a second door and a door switched off alone, and says nothing',async()=>{
  const cases:[object,'slack'|'telegram',boolean][]=[
   [{delivery:{...starting(),'morning-brief':['web','slack']}},'telegram',true],
   [{doors:[{kind:'slack',enabled:true,settings:{}}],channels:['slack']},'telegram',true],
   [{doors:[{kind:'telegram',enabled:false,settings:{}}],channels:[]},'telegram',true],
   [{doors:[{kind:'telegram',enabled:true,settings:{}}],channels:['telegram']},'telegram',false],
   [{},'telegram',false],
  ];
  for(const [over,kind,enabled] of cases){
   mocks.keeper.mockClear();
   const before=JSON.parse(stored(over).definition).delivery;
   mocks.keeper.mockResolvedValueOnce(stored(over));
   const result=await setDoorEnabled('example',kind,enabled);
   expect(savedDefinition().delivery).toEqual(before);
   expect(result).toMatchObject({ok:true});
   expect(result.ok&&result.result.messagesFollow).toBeUndefined();
  }
 });
});
