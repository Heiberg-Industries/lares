/** What saving a change to a running agent does to its open web-chat conversations. The installation owner
 * ruled on 12 Nov 2026 that a save may end them, with a warning on the page; the private-notes guard and the
 * access-revision rule below stay exactly as they are. Real storage and the real authority code, no fakes. */
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { getPool, closePool } from '@lares/agent-kit/db';
import { PgGrantStore } from '@lares/agent-kit/grant-store';
import { PgVaultStore } from '@lares/agent-kit/vault-area-store';
import { hashOf, parseDefinition } from '@lares/agent-kit/definition';
import { bindConsoleSession, captureConsoleVaultSources, requireConsoleSessionBinding } from '@lares/agent-kit/console-turn-authority';
import { reserveExactApproval, attachExactApproval, approveExactResponse, requireApprovedExecution } from '@lares/agent-kit/approval-execution';
import { deadlineApprovalAdapter } from '../lib/deadlines-store.js';

const inc='11111111-1111-4111-8111-111111111111';
const env={LARES_AGENT_NAME:'helper',LARES_AGENT_INCARNATION:inc,AGENT_OWNER_USER_ID:'member-a'};
const auth=(purpose='human',nonce='a'.repeat(43),option='approve')=>({authenticator:'lares-console',principalId:'member-a',principalType:'user',attributes:{user_id:'member-a',lares_member_id:'member-a',lares_admission_nonce:nonce,lares_purpose:purpose,...(purpose==='resolver'?{lares_resume_request_id:'request-1',lares_resume_option:option}:{})}});
const input={id:'11111111-2222-4333-8444-555555555555',reason:'Duplicate filing'};
const context=(purpose='human'):any=>({callId:'call-1',toolName:'deadline_dismiss',toolInput:input,abortSignal:new AbortController().signal,session:{id:'wrun_notes',turn:{id:'turn-original',sequence:0},auth:{current:auth('human'),initiator:auth()}},...(purpose==='resolver'?{approval:{responder:auth('resolver')}}:{})});
const response={request:{interactionId:'request-1',callId:'call-1',toolName:'deadline_dismiss',toolInput:input},response:{decision:'approve' as const,principal:auth('resolver')},session:{id:'wrun_notes',initiator:auth(),turn:{id:'turn-resolver',sequence:1}}};
const opts=()=>({adapter:deadlineApprovalAdapter});
const def={name:'helper',model:'fixture-brain',persona:'voice.md',role:'chief-of-staff',channels:[],
  grants:[{capability:'deadline',scope:'write-with-confirm'},{capability:'vault',scope:'read',areas:['shared']}],autonomy:{deadline:'gated',vault:'gated'},skills:[]};
const loaded=(definition:object)=>{const x={definition:parseDefinition(definition),dutiesMd:'',voiceMd:'',source:'service' as const,dir:'<fixture>',hash:''};x.hash=hashOf(x);return x;};
let container:StartedPostgreSqlContainer;

beforeAll(async()=>{
 container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
 vi.stubEnv('DATABASE_URL',container.getConnectionUri());
 for(const [k,v] of Object.entries(env))vi.stubEnv(k,v);
 const db=getPool();db.on('error',()=>undefined);db.on('connect',c=>c.on('error',()=>undefined));
 const sqlDir=new URL('../../box/sql/',import.meta.url);
 for(const f of readdirSync(sqlDir).filter(n=>/^\d{3}_.*\.sql$/.test(n)).sort())await db.query(readFileSync(new URL(f,sqlDir),'utf8'));
 const first=loaded(def);
 await db.query("INSERT INTO orgs(id,display_name) VALUES('fixture-org','Fixture'); INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('member-a','A','fixture-org','owner','active')");
 await db.query("INSERT INTO agent_definitions(name,definition,hash,status) VALUES('helper',$1,$2,'valid')",[first.definition,first.hash]);
 await db.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending,applied_definition) VALUES('helper','172.30.0.99','fixture','owned',$1,$1,'ready',false,$2)",[inc,first.definition]);
 await db.query("INSERT INTO org_member_policy(user_id,allowed_capabilities) VALUES('member-a',NULL)");
 await new PgGrantStore(db).adoptAgent('member-a',{agentName:'helper',expectedDefinitionHash:first.hash},{designatedOwnerMemberId:'member-a'});
 await db.query("INSERT INTO deadlines(id,owner,entity,title,source,due_date,created_by) VALUES($1,'member-a','Fixture','Filing','manual','2026-12-01','member-a')",[input.id]);
},120_000);
afterAll(async()=>{await closePool();await container?.stop();vi.unstubAllEnvs();});

it('ends every open conversation when the agent is edited, a waiting card with it, and a new conversation works',async()=>{
 const db=getPool(),vault=new PgVaultStore(db),authority={designatedOwnerMemberId:'member-a'};
 const before=loaded(def),after=loaded({...def,description:'Edited while the agent runs'});
 await vault.provisionBacking('member-a',{id:'edit-backing',kind:'git'},authority);
 const area=await vault.provisionArea('member-a',{id:'edit-area',kind:'shared',owner:{kind:'organisation',id:'fixture-org'},backingStoreId:'edit-backing',relativePath:'shared'},authority);
 await vault.configureAccess('member-a',{areaId:area.areaId,expectedRevision:area.accessRevision,grants:[{principal:{kind:'member',id:'member-a'},permission:'use',expiresAt:null}]},authority);
 const notes={agent:'helper',incarnation:inc,sessionId:'wrun_notes',memberId:'member-a',admissionNonce:'a'.repeat(43)};
 const plain={...notes,sessionId:'wrun_plain',admissionNonce:'p'.repeat(43)};
 await bindConsoleSession(notes,db,env);await bindConsoleSession(plain,db,env);
 // One conversation reads the notes, and the agent asks for an approval in it.
 await captureConsoleVaultSources(notes,{sessionDefinition:before,areaIds:[area.areaId]},db,env);
 await reserveExactApproval(context(),'deadline_dismiss',opts());
 await attachExactApproval({requestId:'request-1',callId:'call-1',tool:'deadline_dismiss',input});
 await expect(requireConsoleSessionBinding(plain,db,env)).resolves.toMatchObject({sessionId:'wrun_plain'});

 // A save of the description, as the console makes it on a running agent: the new definition is recorded and,
 // since nothing in it needs a restart, applied at once.
 await db.query('UPDATE agent_definitions SET definition=$1,hash=$2 WHERE name=$3',[after.definition,after.hash,'helper']);
 await db.query('UPDATE agent_resources SET applied_definition=$1 WHERE name=$2',[after.definition,'helper']);

 // The save itself ended every open conversation of the agent: a new definition hash moves the agent's access
 // revision on, and that revokes all its conversations at once (014_agent_access_grants.sql). Neither can be
 // used or bound again, whether or not it read notes (the notes guard would refuse the first one anyway).
 expect((await db.query("SELECT revoked_at FROM console_session_bindings WHERE session_id='wrun_notes'")).rows[0].revoked_at).not.toBeNull();
 await expect(requireConsoleSessionBinding(notes,db,env)).rejects.toThrow();
 await expect(bindConsoleSession(notes,db,env)).rejects.toThrow();
 await expect(requireConsoleSessionBinding(plain,db,env)).rejects.toThrow();
 await expect(bindConsoleSession(plain,db,env)).rejects.toThrow();
 expect((await db.query("SELECT revoked_at FROM console_session_bindings WHERE session_id='wrun_plain'")).rows[0].revoked_at).not.toBeNull();
 // The waiting card cannot be answered, and what it would do never happens.
 await expect(approveExactResponse(response,opts())).rejects.toThrow();
 await expect(requireApprovedExecution(context('resolver'),'deadline_dismiss',input,opts())).rejects.toThrow();
 expect((await db.query("SELECT outcome FROM approval_asks WHERE call_id='call-1'")).rows[0].outcome).toBeNull();
 expect((await db.query('SELECT status FROM deadlines WHERE id=$1',[input.id])).rows[0].status).toBe('open');

 // A new conversation after the edit is admitted and can use the notes under the edited definition.
 const fresh={...notes,sessionId:'wrun_after_edit',admissionNonce:'f'.repeat(43)};
 await bindConsoleSession(fresh,db,env);
 await captureConsoleVaultSources(fresh,{sessionDefinition:after,areaIds:[area.areaId]},db,env);
 await expect(requireConsoleSessionBinding(fresh,db,env)).resolves.toMatchObject({sessionId:'wrun_after_edit'});
});
