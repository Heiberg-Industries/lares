import { describe, expect, it } from 'vitest';
import { ModelPurposeBrokerState, modelPurposeDigest, modelPurposeMac, signModelPurposeRequest, type ModelPurposeRequest, type ModelPurposeStepInput } from '../lib/model-purpose-broker.js';
import type { ConversationBudgetAuthorityReference as BudgetAuthorityReference, DoorBudgetAuthorityReference } from '@lares/agent-kit/budget-model-authority';
import { createHash } from 'node:crypto';
import { preparedModelPurposeConsumer } from '../lib/budget-financial-writer.js';
import { parseModelPurposeAdmissionResponse } from '@lares/agent-kit/model-purpose-protocol';

const request=(overrides:Partial<ModelPurposeRequest>={}):ModelPurposeRequest=>({agent:'neutral-helper',incarnation:'123e4567-e89b-42d3-a456-426614174000',session:'wrun_model_test',member:'member-a',admissionNonce:'a'.repeat(43),method:'POST',path:'/eve/v1/session',rawBodyHash:'b'.repeat(64),policyRevision:3,definitionHash:'c'.repeat(64),purpose:'human',requestId:'d'.repeat(43),...overrides});
// eve 1.0: an answered card continues its own turn (`turn_<n>`); no turn has an empty id.
const reference=(kind:'human'|'resume'='human',turnId=kind==='resume'?'turn_0':'eve-step-turn',turnSequence=kind==='resume'?0:7,resume:{requestId:string;optionId:'approve'|'deny'}={requestId:'resume-1',optionId:'approve'}):BudgetAuthorityReference=>({kind,binding:{agent:'neutral-helper',incarnation:'123e4567-e89b-42d3-a456-426614174000',sessionId:'wrun_model_test',memberId:'member-a',admissionNonce:'a'.repeat(43),placeId:'place',audienceRevision:1,policyRevision:3,agentAccessRevision:2},turnId,turnSequence,...(kind==='resume'?{resume}:{})});
const step=(overrides:Partial<ModelPurposeStepInput>={}):ModelPurposeStepInput=>({turnCapability:'e'.repeat(43),purposeAlias:'lares-brain',event:{type:'step.started',data:{turnId:'eve-step-turn',sequence:7,stepIndex:0}},...overrides});

describe('Keeper model-purpose broker state',()=>{
  it('assembles the consumer only from Keeper startup financial pool and prepared journal',()=>{
    const pool={query:async()=>({rows:[]})} as never;
    expect(preparedModelPurposeConsumer(undefined,{prepared:true} as never)).toBeUndefined();
    expect(preparedModelPurposeConsumer(pool,{prepared:false} as never)).toBeUndefined();
    const consumer=preparedModelPurposeConsumer(pool,{prepared:true} as never);
    expect(consumer?.pool).toBe(pool);
    expect(consumer?.writer).toBeDefined();
  });

  it('burns a challenge before validation and binds every request field into its digest',()=>{
    let now=10_000;const state=new ModelPurposeBrokerState(()=>now),original=request(),issued=state.challenge(original);
    const changed={...original,rawBodyHash:'2'.repeat(64)};
    expect(()=>state.consumeChallenge(issued.challenge,changed,issued.requestDigest)).toThrow();
    expect(()=>state.consumeChallenge(issued.challenge,original,issued.requestDigest)).toThrow();
    const next=state.challenge(original);expect(state.consumeChallenge(next.challenge,original,next.requestDigest).digest).toBe(modelPurposeDigest(original));
    expect(()=>state.consumeChallenge(next.challenge,original,next.requestDigest)).toThrow();
    now+=10_001;expect(state.sizes.challenges).toBe(0);
  });

  it('MACs the whole request digest into the one-use signed capsule challenge',()=>{
    const key=Buffer.alloc(32,7),value=request(),challenge='g'.repeat(43),expiresAt=20_000,digest=modelPurposeDigest(value);
    const fields={direction:'keeper-to-console' as const,domain:'model-purpose-challenge',agent:value.agent,incarnation:value.incarnation,operation:'request.challenge',requestId:value.requestId,requestDigest:digest,outcomeDigest:createHash('sha256').update('').digest('hex'),payloadDigest:modelPurposeDigest({challenge,expiresAt,requestDigest:digest})};
    const challengeMac=modelPurposeMac(key,fields).toString('base64url');
    expect(signModelPurposeRequest(key,value,challenge,challengeMac,expiresAt)).toContain('.');
    expect(()=>signModelPurposeRequest(key,{...value,policyRevision:4},challenge,challengeMac,expiresAt)).toThrow();
  });

  it('consumes pending receipts once and rejects a mismatched runtime identity',()=>{
    const state=new ModelPurposeBrokerState(()=>100),value=request(),issued=state.pendingReceipt(value,modelPurposeDigest(value));
    expect(Object.keys(issued).sort()).toEqual(['expiresAt','pendingReceipt']);
    expect(parseModelPurposeAdmissionResponse(issued)).toEqual(issued);
    expect(parseModelPurposeAdmissionResponse({receipt:issued.pendingReceipt,expiresAt:issued.expiresAt})).toBeUndefined();
    expect(()=>state.consumePending(issued.pendingReceipt,{agent:value.agent,incarnation:value.incarnation,session:value.session,member:'other',admissionNonce:value.admissionNonce})).toThrow();
    expect(()=>state.consumePending(issued.pendingReceipt,{agent:value.agent,incarnation:value.incarnation,session:value.session,member:value.member,admissionNonce:value.admissionNonce})).toThrow();
    const next=state.pendingReceipt(value,modelPurposeDigest(value));expect(state.consumePending(next.pendingReceipt,{agent:value.agent,incarnation:value.incarnation,session:value.session,member:value.member,admissionNonce:value.admissionNonce}).digest).toBe(modelPurposeDigest(value));
  });

  it('takes the eve 1.0 option names only: approve and deny are valid, cancel and every near-miss is refused',()=>{
    const attempt=(optionId:unknown)=>{
      const state=new ModelPurposeBrokerState(()=>100),value=request({purpose:'resume',resume:{requestId:'resume-1',optionId:optionId as 'approve'}});
      return ()=>state.challenge(value);
    };
    expect(attempt('approve')).not.toThrow();
    expect(attempt('deny')).not.toThrow();
    for(const bad of ['cancel','Approve','APPROVE',' approve','approve ','Deny','denied','',undefined,null,1,{}]) expect(attempt(bad),String(bad)).toThrow();
  });

  it('opens a resume turn only on the paused turn itself, from the authentic evidence for that one card',()=>{
    const state=new ModelPurposeBrokerState(()=>100),value=request({purpose:'resume',resume:{requestId:'resume-1',optionId:'approve'}});
    const opened=state.registerTurn(value,reference('resume'),'turn_0',0,value.definitionHash,'lares-brain');
    expect(opened).toBeDefined();
    const firstResumeStep=step({turnCapability:opened.capability,purposeAlias:'lares-brain',event:{type:'step.started',data:{turnId:'turn_0',sequence:0,stepIndex:0}}});
    expect(state.finishStep(state.reserveStep(opened.capability,{agent:value.agent,incarnation:value.incarnation},firstResumeStep)).claim).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // A resume receipt never opens on a human reference, nor a human receipt on a resume one.
    expect(()=>state.registerTurn(value,reference('human'),'turn-1',0,value.definitionHash,'lares-brain')).toThrow();
    expect(()=>state.registerTurn(request(),reference('resume'),'turn_0',0,value.definitionHash,'lares-brain')).toThrow();
    // Card A's receipt never opens on Keeper's reference for card B (S1), nor for the other option (S3).
    expect(()=>state.registerTurn(value,reference('resume','turn_0',0,{requestId:'resume-2',optionId:'approve'}),'turn_0',0,value.definitionHash,'lares-brain')).toThrow();
    expect(()=>state.registerTurn(value,reference('resume','turn_0',0,{requestId:'resume-1',optionId:'deny'}),'turn_0',0,value.definitionHash,'lares-brain')).toThrow();
    // eve 1.0 has no empty turn id: refused for either purpose; the reference must name the turn opened.
    expect(()=>state.registerTurn(value,reference('resume','',0),'',0,value.definitionHash,'lares-brain')).toThrow();
    expect(()=>state.registerTurn(request(),reference('human','',0),'',0,value.definitionHash,'lares-brain')).toThrow();
    expect(()=>state.registerTurn(value,reference('resume'),'turn_1',1,value.definitionHash,'lares-brain')).toThrow();
    // A step event with an empty turn id is refused on an open turn.
    const empty=step({turnCapability:opened.capability,event:{type:'step.started',data:{turnId:'',sequence:0,stepIndex:1}}});
    expect(()=>state.reserveStep(opened.capability,{agent:value.agent,incarnation:value.incarnation},empty)).toThrow();
  });

  it('burns concurrent step claims and withholds a delayed ACK when the turn closes',()=>{
    const state=new ModelPurposeBrokerState(()=>100),value=request(),opened=state.registerTurn(value,reference(),'eve-step-turn',7,value.definitionHash,'lares-brain'),call=step({turnCapability:opened.capability});
    const reserved=state.reserveStep(opened.capability,{agent:value.agent,incarnation:value.incarnation},call);
    expect(()=>state.reserveStep(opened.capability,{agent:value.agent,incarnation:value.incarnation},call)).toThrow();
    expect(state.closeTurn(opened.capability,{agent:value.agent,incarnation:value.incarnation},'eve-step-turn',7)).toEqual({closed:true});
    expect(()=>state.finishStep(reserved)).toThrow();
  });

  it('issues one opaque ACK for the actual step event and expires it without extending the turn',()=>{
    let now=100;const state=new ModelPurposeBrokerState(()=>now),value=request(),opened=state.registerTurn(value,reference(),'eve-step-turn',7,value.definitionHash,'lares-brain'),call=step({turnCapability:opened.capability});
    const reserved=state.reserveStep(opened.capability,{agent:value.agent,incarnation:value.incarnation},call),ack=state.finishStep(reserved);
    expect(ack.claim).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(()=>state.reserveStep(opened.capability,{agent:value.agent,incarnation:value.incarnation},call)).toThrow();
    now+=30_001;expect(state.sizes.claims).toBe(0);expect(state.sizes.turns).toBe(1);
  });

  it('resolves only an exact synchronously consumed claim handle and keeps the resume turn coordinates',()=>{
    let now=100;const state=new ModelPurposeBrokerState(()=>now),value=request({purpose:'resume',resume:{requestId:'resume-1',optionId:'approve'}});
    const opened=state.registerTurn(value,reference('resume'),'turn_0',0,value.definitionHash,'lares-brain');
    const event={type:'step.started',data:{turnId:'turn_0',sequence:0,stepIndex:4}};
    const token=state.finishStep(state.reserveStep(opened.capability,{agent:value.agent,incarnation:value.incarnation},step({turnCapability:opened.capability,event}))).claim;
    const handle=state.reserveClaimConsumption(token,{agent:value.agent,incarnation:value.incarnation},{method:'POST',path:'/v1/chat/completions',requestHash:'f'.repeat(64)});
    expect(state.resolveConsumedClaim({})).toBeUndefined();
    expect(state.resolveConsumedClaim(handle)).toMatchObject({event:{turnId:'turn_0',sequence:0,stepIndex:4},reference:{kind:'resume',turnId:'turn_0'},purposeAlias:'lares-brain'});
    expect(()=>state.reserveClaimConsumption(token,{agent:value.agent,incarnation:value.incarnation},{method:'POST',path:'/v1/chat/completions',requestHash:'f'.repeat(64)})).toThrow();
    expect(state.resolveConsumedClaim(handle)?.isActive()).toBe(true);
    state.closeTurn(opened.capability,{agent:value.agent,incarnation:value.incarnation},'turn_0',0);
    expect(state.resolveConsumedClaim(handle)).toBeUndefined();
  });

  it('rejects wrong-identity and concurrent consumption while expiring the opaque handle',()=>{
    let now=100;const state=new ModelPurposeBrokerState(()=>now),value=request(),opened=state.registerTurn(value,reference(),'eve-step-turn',7,value.definitionHash,'lares-brain');
    const event={type:'step.started',data:{turnId:'eve-step-turn',sequence:7,stepIndex:0}};
    const token=state.finishStep(state.reserveStep(opened.capability,{agent:value.agent,incarnation:value.incarnation},step({turnCapability:opened.capability,event}))).claim;
    const requestIdentity={method:'POST' as const,path:'/v1/messages',requestHash:'f'.repeat(64)};
    expect(()=>state.reserveClaimConsumption(token,{agent:value.agent,incarnation:'123e4567-e89b-42d3-a456-426614174001'},requestIdentity)).toThrow();
    const handle=state.reserveClaimConsumption(token,{agent:value.agent,incarnation:value.incarnation},requestIdentity);
    expect(()=>state.reserveClaimConsumption(token,{agent:value.agent,incarnation:value.incarnation},requestIdentity)).toThrow();
    expect(state.resolveConsumedClaim(handle)?.isActive()).toBe(true);
    now+=30_001;
    expect(state.resolveConsumedClaim(handle)).toBeUndefined();
  });

  it('bounds and expires replay tombstones without rearming live request IDs',()=>{
    let now=100;const state=new ModelPurposeBrokerState(()=>now,1),id='h'.repeat(43);state.burnRequest(id);
    expect(()=>state.burnRequest(id)).toThrow();expect(()=>state.burnRequest('i'.repeat(43))).toThrow();
    now+=60_001;state.burnRequest('i'.repeat(43));expect(state.sizes.requests).toBe(1);
  });

  it('burns a step whose finite source authority expires before the ACK',()=>{
    let now=100;const state=new ModelPurposeBrokerState(()=>now),value=request(),opened=state.registerTurn(value,reference(),'eve-step-turn',7,value.definitionHash,'lares-brain'),call=step({turnCapability:opened.capability});
    const reserved=state.reserveStep(opened.capability,{agent:value.agent,incarnation:value.incarnation},call);
    expect(()=>state.finishStep(reserved,now+10)).not.toThrow();
    const next=step({turnCapability:opened.capability,event:{type:'step.started',data:{turnId:'eve-step-turn',sequence:7,stepIndex:1}}});
    const second=state.reserveStep(opened.capability,{agent:value.agent,incarnation:value.incarnation},next);now+=11;
    expect(()=>state.finishStep(second,now-1)).toThrow();
    expect(()=>state.reserveStep(opened.capability,{agent:value.agent,incarnation:value.incarnation},next)).toThrow();
  });
});

// A Slack or Telegram turn: no console request, the payer found by Keeper from the door claim.
const doorAgent='neutral-helper',doorIncarnation='123e4567-e89b-42d3-a456-426614174000',doorHash='c'.repeat(64);
const doorIdentity={agent:doorAgent,incarnation:doorIncarnation};
const doorReference=(overrides:Partial<DoorBudgetAuthorityReference>={},binding:Partial<DoorBudgetAuthorityReference['binding']>={}):DoorBudgetAuthorityReference=>({kind:'door',
  binding:{agent:doorAgent,incarnation:doorIncarnation,sessionId:'slack_session_1',memberId:'member-a',agentAccessRevision:2,door:'slack',principal:'U0EXAMPLE',claimRevision:'22222222-2222-4222-8222-222222222222',...binding},
  turnId:'turn_3',turnSequence:3,...overrides});
const doorStep=(capability:string,stepIndex=0,overrides:Partial<ModelPurposeStepInput>={}):ModelPurposeStepInput=>({turnCapability:capability,purposeAlias:'lares-brain',event:{type:'step.started',data:{turnId:'turn_3',sequence:3,stepIndex}},...overrides});
const openDoor=(state:ModelPurposeBrokerState,reference=doorReference())=>state.registerDoorTurn(doorAgent,doorIncarnation,reference,'turn_3',3,doorHash,'lares-brain');

describe('Keeper model-purpose broker state: door turns',()=>{
  it('registers a door turn only with a door reference whose turn, sequence, agent and incarnation match',()=>{
    const state=new ModelPurposeBrokerState(()=>100);
    const opened=openDoor(state);
    expect(Object.keys(opened).sort()).toEqual(['capability','expiresAt']);
    expect(opened.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(opened.expiresAt).toBe(100+5*60_000);
    // A web-chat reference never opens a door turn.
    expect(()=>state.registerDoorTurn(doorAgent,doorIncarnation,reference('human','turn_3',3) as never,'turn_3',3,doorHash,'lares-brain')).toThrow();
    // The reference must name the turn being opened.
    expect(()=>state.registerDoorTurn(doorAgent,doorIncarnation,doorReference(),'turn_4',3,doorHash,'lares-brain')).toThrow();
    expect(()=>state.registerDoorTurn(doorAgent,doorIncarnation,doorReference(),'turn_3',4,doorHash,'lares-brain')).toThrow();
    // The reference must belong to the runtime asking.
    expect(()=>state.registerDoorTurn('other-helper',doorIncarnation,doorReference(),'turn_3',3,doorHash,'lares-brain')).toThrow();
    expect(()=>state.registerDoorTurn(doorAgent,'123e4567-e89b-42d3-a456-426614174001',doorReference(),'turn_3',3,doorHash,'lares-brain')).toThrow();
    // A definition hash and a model name are pinned in their usual shapes.
    expect(()=>state.registerDoorTurn(doorAgent,doorIncarnation,doorReference(),'turn_3',3,'fixture','lares-brain')).toThrow();
    expect(()=>state.registerDoorTurn(doorAgent,doorIncarnation,doorReference(),'turn_3',3,doorHash,'Not An Alias')).toThrow();
    // A door turn is not a console turn: the console path never takes a door reference.
    expect(()=>state.registerTurn(request(),doorReference() as never,'turn_3',3,request().definitionHash,'lares-brain')).toThrow();
  });

  it('claims, consumes, resolves and closes a door turn like a web-chat turn, for its own runtime only',()=>{
    const state=new ModelPurposeBrokerState(()=>100),opened=openDoor(state);
    const other={agent:doorAgent,incarnation:'123e4567-e89b-42d3-a456-426614174001'};
    expect(()=>state.reserveStep(opened.capability,other,doorStep(opened.capability))).toThrow();
    expect(()=>state.reserveStep(opened.capability,{agent:'other-helper',incarnation:doorIncarnation},doorStep(opened.capability,1))).toThrow();
    expect(()=>state.reserveStep(opened.capability,doorIdentity,doorStep(opened.capability,2,{purposeAlias:'other-model'}))).toThrow();
    const token=state.finishStep(state.reserveStep(opened.capability,doorIdentity,doorStep(opened.capability,3))).claim;
    const identity={method:'POST' as const,path:'/v1/chat/completions',requestHash:'f'.repeat(64)};
    expect(()=>state.reserveClaimConsumption(token,other,identity)).toThrow();
    const handle=state.reserveClaimConsumption(token,doorIdentity,identity);
    expect(state.resolveConsumedClaim(handle)).toMatchObject({agent:doorAgent,incarnation:doorIncarnation,definitionHash:doorHash,purposeAlias:'lares-brain',
      event:{turnId:'turn_3',sequence:3,stepIndex:3},reference:{kind:'door',binding:{memberId:'member-a',principal:'U0EXAMPLE'}}});
    expect(()=>state.closeTurn(opened.capability,other,'turn_3',3)).toThrow();
    expect(()=>state.closeTurn(opened.capability,doorIdentity,'turn_4',3)).toThrow();
    expect(state.closeTurn(opened.capability,doorIdentity,'turn_3',3)).toEqual({closed:true});
    expect(state.resolveConsumedClaim(handle)).toBeUndefined();
  });

  it('refuses a step claim on a door turn after the turn has expired',()=>{
    let now=100;const state=new ModelPurposeBrokerState(()=>now),opened=openDoor(state);
    expect(state.finishStep(state.reserveStep(opened.capability,doorIdentity,doorStep(opened.capability,0))).claim).toMatch(/^[A-Za-z0-9_-]{43}$/);
    now+=5*60_000;
    expect(()=>state.reserveStep(opened.capability,doorIdentity,doorStep(opened.capability,1))).toThrow();
    expect(state.sizes.turns).toBe(0);
  });

  it('refuses claims on a closed door turn and opens a fresh one for the same point after a pause',()=>{
    const state=new ModelPurposeBrokerState(()=>100),first=openDoor(state);
    expect(state.closeTurn(first.capability,doorIdentity,'turn_3',3)).toEqual({closed:true});
    expect(()=>state.reserveStep(first.capability,doorIdentity,doorStep(first.capability,0))).toThrow();
    expect(()=>state.closeTurn(first.capability,doorIdentity,'turn_3',3)).toThrow();
    const second=openDoor(state);
    expect(second.capability).not.toBe(first.capability);
    expect(state.finishStep(state.reserveStep(second.capability,doorIdentity,doorStep(second.capability,0))).claim).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(()=>state.reserveStep(first.capability,doorIdentity,doorStep(first.capability,1))).toThrow();
  });
});
