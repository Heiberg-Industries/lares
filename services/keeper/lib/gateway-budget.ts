import {closeSync,constants,fstatSync,openSync,readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import type {Pool} from 'pg';
import {PgBudgetAdmissionStore,consumeDispatchPermit,canonicalBudgetMoney,type BudgetFinancialWriter,type BudgetRecoveryReference,type BudgetGatewayTicket} from '@lares/agent-kit/budget-admission-store';
import {GATEWAY_ADMIT_PATH,GATEWAY_RPC_MS,gatewayRpcPath,gatewayAdmitSchema,gatewayGrantSchema,gatewaySettleSchema,gatewayCanonical,gatewayGrantHash,gatewayHash,gatewaySignature,verifyGatewaySignature,parseGatewayDocument} from '@lares/agent-kit/gateway-admission-protocol';
import {gatewayPricingSchema,gatewayMaximumLiability,gatewayActualAmount} from '@lares/agent-kit/gateway-pricing';
import {HostFinancialJournal} from './financial-journal.js';
import {JournalBudgetFinancialWriter} from './budget-financial-writer.js';

/** A trusted, non-rollback observation, not an epoch reader on the billing database. There
 * is deliberately no production implementation or configuration switch for this seam. */
export interface GatewayRecoveryWitness {
  observe(reference:Pick<BudgetGatewayTicket,'installationAccountId'|'epoch'|'endpointGeneration'>):Promise<BudgetRecoveryReference|undefined>;
}
export interface GatewayRpcReply {status:number;headers:Record<string,string>;body:Buffer}
const refused=():GatewayRpcReply=>({status:503,headers:{'content-type':'application/json','cache-control':'no-store'},body:Buffer.from('{"state":"unavailable","version":1}')});

/** Protected service key shared with the gateway, never the console or browser. No key is
 * generated here. Missing/unsafe custody leaves this optional service unavailable. */
export function readGatewayServiceKey(path:string|undefined):Buffer|undefined {
  if(!path)return undefined;
  let fd:number|undefined;
  try {
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.size!==32||stat.uid!==0||(stat.mode&0o027)!==0)return undefined;
    const key=readFileSync(fd);return key.length===32?key:undefined;
  }catch{return undefined;}finally{if(fd!==undefined)closeSync(fd);}
}

export class GatewayBudgetAuthority {
  private readonly key:Buffer|undefined;
  constructor(private readonly pool:Pool,key:Uint8Array|undefined,private readonly financialWriter:BudgetFinancialWriter|undefined,private readonly recovery?:GatewayRecoveryWitness) {
    this.key=key?.byteLength===32?Buffer.from(key):undefined;
  }
  async handle(path:string,signature:string|undefined,raw:Buffer,deadline=performance.now()+GATEWAY_RPC_MS):Promise<GatewayRpcReply> {
    deadline=Math.min(deadline,performance.now()+GATEWAY_RPC_MS);
    if(!Number.isFinite(deadline)||deadline<=performance.now())return refused();
    // Bound the caller even if a future witness stalls. Work already inside an owned
    // transaction may still commit; every subsequent transition checks the same deadline
    // and never issues an allow or releases an uncertain reservation.
    return new Promise(resolve=>{
      const timer=setTimeout(()=>resolve(refused()),Math.max(1,Math.ceil(deadline-performance.now())));
      void this.execute(path,signature,raw,deadline).then(reply=>{clearTimeout(timer);resolve(reply);},()=>{clearTimeout(timer);resolve(refused());});
    });
  }
  private async execute(path:string,signature:string|undefined,raw:Buffer,deadline:number):Promise<GatewayRpcReply> {
    const fresh=()=>{if(performance.now()>=deadline)throw new Error('Gateway deadline elapsed');};
    // Without a writer this authority is read-only and closed. In particular, terminal
    // receipts must not settle liability outside prepared Keeper custody.
    if(!this.key||!this.financialWriter||!gatewayRpcPath(path))return refused();
    try {
      fresh();
      if(!verifyGatewaySignature(this.key,signature,'request',path,raw))return refused();
      const document=parseGatewayDocument(raw);
      let result:unknown;
      const store=new PgBudgetAdmissionStore(this.pool,process.env,30_000,this.financialWriter);
      if(path===GATEWAY_ADMIT_PATH){
        const request=gatewayAdmitSchema.parse(document);
        // Production remains closed until a real witness and provisioning adapter exist.
        if(!this.recovery)return refused();
        const ticket=await store.discoverGatewayTicket(request.ticket);fresh();
        if(!ticket)return refused();
        const pricing=gatewayPricingSchema.parse(ticket.pricingProfile);
        if(pricing.capabilityHash!==ticket.profileHash||gatewayMaximumLiability(pricing)!==canonicalBudgetMoney(ticket.maximumLiability))return refused();
        const recovery=await this.recovery.observe({installationAccountId:ticket.installationAccountId,epoch:ticket.epoch,endpointGeneration:ticket.endpointGeneration});fresh();
        if(!recovery)return refused();
        // Exact managed identity is derived only from persisted data. admit rechecks the
        // current reference, policy, generation, endpoint, authority and recovery under lock.
        const selected=new PgBudgetAdmissionStore(this.pool,{LARES_AGENT_NAME:ticket.agent,LARES_AGENT_INCARNATION:ticket.incarnation},30_000,this.financialWriter);
        const admitted=await selected.admit(request.ticket,{...request,agent:ticket.agent,incarnation:ticket.incarnation,credentialGeneration:ticket.credentialGeneration},recovery);
        if(admitted.state!=='allowed')return refused();
        // Burn before any further await, including grant persistence. Lost/unknown ACKs
        // leave admitted liability behind and never reconstruct the process-local permit.
        const consumed=consumeDispatchPermit(admitted.permit);
        if(!consumed||consumed.attemptId!==admitted.attemptId||consumed.bindingId!==ticket.bindingId||consumed.requestHash!==request.requestHash)return refused();
        fresh();
        const grant=gatewayGrantSchema.parse({version:1,nonce:request.nonce,requestHash:request.requestHash,profileHash:request.profileHash,endpointHash:request.endpointHash,keyFingerprint:request.keyFingerprint,purposeAlias:request.purposeAlias,attemptId:consumed.attemptId,bindingId:consumed.bindingId});
        if(!await selected.recordGatewayGrant(consumed,gatewayGrantHash(grant)))return refused();
        fresh();
        result={...grant,state:'allowed',validForMs:Math.max(1,Math.floor(deadline-performance.now()))};
      }else{
        const receipt=gatewaySettleSchema.parse(document);
        const {receiptHash,...evidence}=receipt;
        if(gatewayHash(gatewayCanonical(evidence))!==receiptHash)return refused();
        const {kind,format,usage,...grant}=evidence;
        const persisted=await store.gatewaySettlement(receipt.attemptId);fresh();
        if(!persisted||persisted.grantHash!==gatewayGrantHash(grant))return refused();
        const pricing=gatewayPricingSchema.parse(persisted.pricingProfile);
        if(pricing.capabilityHash!==persisted.profileHash||format!==pricing.format)return refused();
        const state=await store.settle({attemptId:persisted.attemptId,bindingId:persisted.bindingId,requestHash:persisted.requestHash,profileHash:persisted.profileHash,endpointHash:persisted.endpointHash,credentialGeneration:persisted.credentialGeneration,receiptHash,actualAmount:gatewayActualAmount(pricing,usage),kind});
        fresh();if(state==='denied')return refused();
        result={version:1,state};
      }
      fresh();
      const body=gatewayCanonical(result);
      return {status:200,headers:{'content-type':'application/json','cache-control':'no-store','x-lares-signature':gatewaySignature(this.key,'response',path,body)},body};
    }catch{return refused();}
  }
}

/** Actual witness/provisioning integration is a follow-on. Never derive reconciled state
 * from the restored database or expose a test-witness environment/configuration switch. */
export function productionGatewayBudgetAuthority(pool:Pool,keyFile?:string,journal?:HostFinancialJournal):GatewayBudgetAuthority {
  const writer=journal?.prepared?new JournalBudgetFinancialWriter(journal):undefined;
  return new GatewayBudgetAuthority(pool,readGatewayServiceKey(keyFile),writer);
}
