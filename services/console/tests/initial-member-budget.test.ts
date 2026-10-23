import {beforeEach,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({keeper:vi.fn()}));
vi.mock('../lib/keeper-client',()=>({
  keeper:mock.keeper,
  KeeperRefusedError:class KeeperRefusedError extends Error{constructor(message:string,readonly findings?:Array<{check:string;message:string}>){super(message);}},
  KeeperUnavailableError:class KeeperUnavailableError extends Error{constructor(message:string,readonly outcomeMayBeUnknown=false){super(message);}},
}));
import {listInitialMemberBudgetStatus,setInitialMemberBudgetLimit,InitialMemberBudgetRefused} from '../lib/initial-member-budget';
import {KeeperRefusedError,KeeperUnavailableError} from '../lib/keeper-client';
beforeEach(()=>mock.keeper.mockReset());

it('accepts only the bounded strict Keeper status result',async()=>{
  mock.keeper.mockResolvedValueOnce([{memberId:'m1',eligible:true,setupComplete:false}]);
  await expect(listInitialMemberBudgetStatus('opaque','audit-only')).resolves.toEqual({available:true,members:[{memberId:'m1',eligible:true,setupComplete:false}]});
  mock.keeper.mockResolvedValueOnce([]);
  await expect(listInitialMemberBudgetStatus('opaque','audit-only')).resolves.toEqual({available:true,members:[]});
  mock.keeper.mockResolvedValueOnce([{memberId:'m1',eligible:true,setupComplete:false,monthlyLimit:'25'}]);
  await expect(listInitialMemberBudgetStatus('opaque','audit-only')).resolves.toEqual({available:false,members:[]});
  mock.keeper.mockRejectedValueOnce(new KeeperUnavailableError('offline'));
  await expect(listInitialMemberBudgetStatus('opaque','audit-only')).resolves.toEqual({available:false,members:[]});
});

it('keeps owner denial distinct from optional setup unavailability',async()=>{
  mock.keeper.mockRejectedValueOnce(new KeeperRefusedError('refused',[{check:'member.initial-budget',message:'unavailable'}]));
  await expect(listInitialMemberBudgetStatus('opaque','audit-only')).resolves.toMatchObject({available:false});
  mock.keeper.mockRejectedValueOnce(new KeeperRefusedError('refused',[{check:'member.initial-budget',message:'denied'}]));
  await expect(listInitialMemberBudgetStatus('opaque','audit-only')).rejects.toMatchObject({reason:'denied'});
});

it('sends one narrow write and preserves an unknown outcome without retrying',async()=>{
  mock.keeper.mockResolvedValueOnce({saved:true});
  await expect(setInitialMemberBudgetLimit({sessionToken:'opaque',targetMemberId:'target',monthlyLimit:'25.5'},'audit-only')).resolves.toEqual({saved:true});
  expect(mock.keeper).toHaveBeenCalledTimes(1);
  expect(mock.keeper).toHaveBeenCalledWith('member.set-initial-budget',{sessionToken:'opaque',targetMemberId:'target',monthlyLimit:'25.5'},'audit-only');
  mock.keeper.mockRejectedValueOnce(new KeeperUnavailableError('unknown',true));
  await expect(setInitialMemberBudgetLimit({sessionToken:'opaque',targetMemberId:'target',monthlyLimit:'25.5'},'audit-only')).rejects.toMatchObject({outcomeMayBeUnknown:true});
  expect(mock.keeper).toHaveBeenCalledTimes(2);
  mock.keeper.mockRejectedValueOnce(new KeeperRefusedError('refused',[{check:'member.initial-budget',message:'setup-complete'}]));
  await expect(setInitialMemberBudgetLimit({sessionToken:'opaque',targetMemberId:'target',monthlyLimit:'25.5'},'audit-only')).rejects.toBeInstanceOf(InitialMemberBudgetRefused);
});
