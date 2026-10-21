import {describe,it,expect} from 'vitest';
import {canonicalBudgetMoney,budgetIdentitySuppression,consumeDispatchPermit} from '../src/budget-admission-store.js';
describe('exact budget boundaries',()=>{
  it('canonicalises bounded decimals without floating point rounding',()=>{
    expect(canonicalBudgetMoney('0.100000000000000001')).toBe('0.100000000000000001');
    expect(canonicalBudgetMoney('10.000')).toBe('10');expect(canonicalBudgetMoney('0.00')).toBe('0');
    for(const value of ['-0','-1','1e-3','NaN','Infinity','+1','01','1.',' 1','1 ','0.0000000000000000001','1000000000000000000',0,null,undefined])expect(()=>canonicalBudgetMoney(value)).toThrow();
  });
  it('domain-separates keyed exact provider identities; email is never a linking key',()=>{
    const key=Buffer.alloc(32,1),identity={canonicalMemberId:'member-a',providers:[{issuer:'https://issuer.invalid',subject:'subject-a',tenantId:'tenant-a'}]};
    const first=budgetIdentitySuppression(key,identity);
    expect(first).toEqual(budgetIdentitySuppression(key,identity));
    expect(first.canonicalSuppressionHash).not.toBe(first.providerSuppressionHashes[0]);
    expect(first).not.toEqual(budgetIdentitySuppression(Buffer.alloc(32,2),identity));
    expect(first.providerSuppressionHashes).not.toEqual(budgetIdentitySuppression(key,{...identity,providers:[{...identity.providers[0]!,tenantId:'other'}]}).providerSuppressionHashes);
    expect(()=>budgetIdentitySuppression(Buffer.alloc(16),identity)).toThrow();
  });
  it('cannot forge or deserialize a dispatch permit',()=>{
    expect(consumeDispatchPermit({kind:'budget-dispatch-permit'})).toBeUndefined();
    expect(consumeDispatchPermit(JSON.parse('{"kind":"budget-dispatch-permit"}'))).toBeUndefined();
  });
});
