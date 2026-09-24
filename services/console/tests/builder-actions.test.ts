import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(()=>({keeper:vi.fn(),verify:vi.fn(),cookies:vi.fn()}));
vi.mock('next/headers',()=>({cookies:mocks.cookies}));
vi.mock('../lib/auth',()=>({verify:mocks.verify}));
vi.mock('../lib/keeper-client',async(importOriginal)=>({...await importOriginal<typeof import('../lib/keeper-client')>(),keeper:mocks.keeper}));
import { createAgent, saveDefinition, retireAgent, deleteAgent, connectDoor, applyConnections, listConversations, startFreshConversation, setDoorEnabled } from '../app/actions/definition';
beforeEach(()=>{ vi.clearAllMocks(); mocks.cookies.mockResolvedValue({get:()=>({value:'cookie'})}); mocks.verify.mockResolvedValue('owner@example.test'); mocks.keeper.mockResolvedValue({hash:'abc',backup:{ok:false,message:'backup failed'},runtime:{pending:true,reason:'doors'}}); });
const input={name:'example',definition:{},duties:'Duties',voice:'Voice'};
it('verifies every mutation before keeper access',async()=>{
 mocks.verify.mockResolvedValue(null);
 for(const action of [()=>createAgent({...input,startingPoint:'travel'}),()=>saveDefinition(input),()=>retireAgent({name:'example'}),()=>deleteAgent({name:'example',confirm:true}),()=>connectDoor({name:'example',kind:'slack',secret:'secret'}),()=>applyConnections({name:'example',hash:'abc'}),()=>listConversations({name:'example'}),()=>startFreshConversation({name:'example',incarnation:'id',sessionId:'wrun_one',confirm:true})]) await expect(action()).rejects.toThrow('unauthenticated');
 expect(mocks.keeper).not.toHaveBeenCalled();
});
it('preserves backup and pending results and authenticated actor',async()=>{
 const result=await saveDefinition(input);
 expect(mocks.keeper).toHaveBeenCalledWith('definition.save',input,'owner@example.test');
 expect(JSON.parse(JSON.stringify(result))).toMatchObject({ok:true,result:{backup:{ok:false},runtime:{pending:true}}});
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

it('serializes door read failures before mutation, preserving findings without retry',async()=>{
 const {KeeperRefusedError,KeeperUnavailableError}=await import('../lib/keeper-client');
 mocks.keeper.mockRejectedValueOnce(new KeeperRefusedError('Read refused',[{check:'ownership',message:'Different incarnation'}]));
 expect(await setDoorEnabled('example','slack',true)).toEqual({ok:false,error:{message:'Read refused',findings:[{check:'ownership',message:'Different incarnation'}],outcomeMayBeUnknown:false}});
 expect(mocks.keeper).toHaveBeenCalledTimes(1);
 mocks.keeper.mockResolvedValueOnce({definition:'invalid json'});
 expect(await setDoorEnabled('example','slack',true)).toMatchObject({ok:false,error:{outcomeMayBeUnknown:false}});
 expect(mocks.keeper).toHaveBeenCalledTimes(2);
});
