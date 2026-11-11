/** Trusted synthetic private contexts; admission remains designated-owner-only.
 *
 * This file used to drive both roles' real instruction, tool and skill resolvers through eve 0.60's
 * internal dynamic-lifecycle modules (`dispatchDynamicInstructionEvent`, `dispatchDynamicToolEvent`,
 * `buildDynamicTools`, `executeLoadSkill`, …). eve 1.0 removed those modules and the `events`-keyed
 * resolver shape. The resolvers themselves belong to other parts of the upgrade (agent definition,
 * skills, approvals), so those cases are listed below as todo, to be restated against each part's new
 * shape; the cases that exercise code owned here (usage hooks) are ported. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const auth={authenticator:'lares-console',principalType:'user',principalId:'synthetic',attributes:{lares_member_id:'synthetic',lares_admission_nonce:'a'.repeat(43),lares_purpose:'human'}};
const context={session:{id:'private',turn:{id:'turn-1',sequence:0},auth:{current:auth,initiator:auth}}};
const load=(path:string)=>import(new URL(path,import.meta.url).href);
beforeEach(()=>{vi.stubEnv('LARES_AGENT_NAME','helper');vi.stubEnv('LARES_AGENT_INCARNATION','11111111-1111-4111-8111-111111111111');});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});

describe('usage hooks never count a private conversation',()=>{
 // eve 1.0: usage is the `usage.recorded` fact, its place on the stream is `ctx.position`, its turn is `scope.turnId`.
 const event={type:'usage.recorded',scope:{turnId:'turn'},data:{kind:'model',owner:{runId:'run_1'},usage:{inputTokens:12,outputTokens:3,cacheReadTokens:0,cacheWriteTokens:0}}};
 const position={line:4,index:0};
 for(const role of ['chief-of-staff','creative'])it(`${role}: private (including tagged initiator-only resumes) is omitted, a native session is counted once`,async()=>{
  const {makeModelUsage}=await load(`../../../services/${role}/agent/hooks/model-usage.ts`);const record=vi.fn();const hook=makeModelUsage({record});
  await hook['usage.recorded'](event,{...context,position});
  await hook['usage.recorded'](event,{session:{id:'private-resume',auth:{initiator:auth,current:null}},position});
  expect(record).not.toHaveBeenCalled();
  await hook['usage.recorded'](event,{session:{id:'native'},position});expect(record).toHaveBeenCalledOnce();
 });
});

// Restate against each part's eve 1.0 shape (they drove eve 0.60 internals that no longer exist):
it.todo('installed eve assembles neutral private instructions and only the safe intersection of tools, with no installation canary (agent definition, approvals)');
it.todo('native owner keeps its custom persona and native source tool surface (agent definition)');
it.todo('chief private automatic source resolvers and native skills cannot expose owner context (agent definition, skills)');
it.todo('private load_skill resolves only reviewed docs; the native loader preserves its exact skills (skills)');
it.todo('both roles expose only the fixed public reader and re-check private or resumed authority on execution (agent definition)');
it.todo('session-local todo state cannot cross between private sessions or into native sessions (the todo tool is gone in eve 1.0; confirm and drop)');
