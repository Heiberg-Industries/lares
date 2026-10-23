import {keeper,KeeperRefusedError,KeeperUnavailableError} from './keeper-client';

export type InitialMemberBudgetStatus={memberId:string;eligible:boolean;setupComplete:boolean};
export type InitialMemberBudgetStatusResult={available:true;members:InitialMemberBudgetStatus[]}|{available:false;members:[]};
export class InitialMemberBudgetRefused extends Error {
  constructor(readonly reason:'invalid'|'denied'|'setup-complete'|'unavailable') {super('Initial monthly limit setup was refused');}
}
const unavailableFinding=(error:KeeperRefusedError):boolean=>error.findings?.some(finding=>finding.check==='member.initial-budget'&&finding.message==='unavailable')===true;
const refusalReason=(error:KeeperRefusedError):InitialMemberBudgetRefused['reason']|undefined=>{
  const message=error.findings?.find(finding=>finding.check==='member.initial-budget')?.message;
  return message==='invalid'||message==='denied'||message==='setup-complete'||message==='unavailable'?message:undefined;
};
function validStatuses(value:unknown):value is InitialMemberBudgetStatus[]{
  return Array.isArray(value)&&value.length<=1024&&value.every(row=>typeof row==='object'&&row!==null&&!Array.isArray(row)
    &&Object.keys(row).length===3&&typeof row.memberId==='string'&&row.memberId.length>0&&row.memberId.length<=128
    &&typeof row.eligible==='boolean'&&typeof row.setupComplete==='boolean');
}

/** Optional setup observation. Unavailable Keeper or malformed data never becomes an empty list. */
export async function listInitialMemberBudgetStatus(sessionToken:string,auditActor:string):Promise<InitialMemberBudgetStatusResult>{
  try{
    const result=await keeper<unknown>('member.initial-budget-status',{sessionToken},auditActor);
    return validStatuses(result)?{available:true,members:result}:{available:false,members:[]};
  }catch(error){
    if(error instanceof KeeperUnavailableError)return{available:false,members:[]};
    if(error instanceof KeeperRefusedError){
      if(unavailableFinding(error))return{available:false,members:[]};
      if(refusalReason(error)==='denied')throw new InitialMemberBudgetRefused('denied');
    }
    throw error;
  }
}

export async function setInitialMemberBudgetLimit(input:{sessionToken:string;targetMemberId:string;monthlyLimit:string},auditActor:string):Promise<{saved:true}>{
  try{
    const result=await keeper<unknown>('member.set-initial-budget',input,auditActor);
    if(typeof result==='object'&&result!==null&&!Array.isArray(result)&&Object.keys(result).length===1&&(result as Record<string,unknown>).saved===true)return{saved:true};
    throw new KeeperUnavailableError('keeper returned an invalid result; refresh before trying again',true);
  }catch(error){
    if(error instanceof KeeperRefusedError){
      const reason=refusalReason(error);
      if(reason)throw new InitialMemberBudgetRefused(reason);
    }
    throw error;
  }
}
