/** Canonical, redacted SQL row encoding shared by write proposals and continuity reads. */
import {createHash} from 'node:crypto';
import {canonicalBudgetMoney} from '@lares/agent-kit/budget-admission-store';
import {FINANCIAL_ATOM_SCHEMA,type FinancialAtom} from './financial-journal.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
type FinancialRow=Record<string,any>;

export function financialAtomFromRow(kind:FinancialAtom['kind'],row:FinancialRow):FinancialAtom {
  switch(kind){
    case 'account':return FINANCIAL_ATOM_SCHEMA.parse({kind,id:row.id,installationAccountId:row.installation_account_id,accountKind:row.kind,state:row.state,reason:row.reason,activeWindowId:row.active_window_id,installationCap:row.installation_cap===null?null:canonicalBudgetMoney(row.installation_cap),policyGeneration:String(row.policy_generation),selectedEndpointHash:row.selected_endpoint,endpointGeneration:String(row.endpoint_generation),recoveryEpochHash:row.recovery_epoch===null?null:hash(row.recovery_epoch),canonicalSuppressionHash:row.canonical_suppression_hash,providerSuppressionHashes:row.provider_suppression_hashes});
    case 'window':return FINANCIAL_ATOM_SCHEMA.parse({kind,id:row.id,accountId:row.account_id,startsAt:row.starts_utc,endsAt:row.ends_utc,openingLiability:canonicalBudgetMoney(row.opening_liability),openingCap:canonicalBudgetMoney(row.opening_cap),policyRevision:String(row.policy_revision)});
    case 'binding':return FINANCIAL_ATOM_SCHEMA.parse({kind,id:row.id,installationAccountId:row.installation_account_id,memberAccountId:row.member_account_id,endpointHash:row.endpoint_hash,credentialGeneration:String(row.credential_generation),profileHash:row.profile_hash,maximumLiability:canonicalBudgetMoney(row.maximum_liability),pricingProfile:row.pricing_profile,state:row.state});
    case 'attempt':return FINANCIAL_ATOM_SCHEMA.parse({kind,id:row.id,installationAccountId:row.installation_account_id,memberAccountId:row.member_account_id,bindingId:row.binding_id,installationWindowId:row.installation_window_id,memberWindowId:row.member_window_id,endpointHash:row.endpoint_hash,credentialGeneration:String(row.credential_generation),installationPolicyGeneration:String(row.installation_policy_generation),memberPolicyGeneration:String(row.member_policy_generation),endpointGeneration:String(row.endpoint_generation),recoveryEpochHash:hash(row.recovery_epoch),requestHash:row.request_hash,profileHash:row.profile_hash,invocationHash:row.invocation_hash,reservedAmount:canonicalBudgetMoney(row.reserved_amount),installationCapSnapshot:canonicalBudgetMoney(row.installation_cap_snapshot),memberCapSnapshot:canonicalBudgetMoney(row.member_cap_snapshot),createdAt:row.created_utc,expiresAt:row.expires_utc,admittedAt:row.admitted_utc,state:row.state,actualAmount:row.actual_amount===null?null:canonicalBudgetMoney(row.actual_amount),settlementHash:row.settlement_hash,conflictReason:row.conflict_reason,conflictHash:row.conflict_hash,highestObservedLiability:canonicalBudgetMoney(row.highest_observed_liability)});
    case 'grant':return FINANCIAL_ATOM_SCHEMA.parse({kind,attemptId:row.attempt_id,grantHash:row.grant_hash});
    case 'tombstone':return FINANCIAL_ATOM_SCHEMA.parse(row);
  }
}

export const FINANCIAL_UTC_TIMESTAMP=(column:string)=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
