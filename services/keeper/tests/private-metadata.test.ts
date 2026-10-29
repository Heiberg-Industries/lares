import {afterAll,beforeAll,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import {provisionEngineDatabasePrivileges} from '../../box/lib/database-privileges.js';
import {quiet} from './helpers/quiet-pool.js';
import {OutsideCustodyStore,outsideCustodyOwnerForConnection} from '../lib/outside-custody.js';

const OWNER='private-metadata-owner',MEMBER='private-metadata-member',ORG='private-metadata-org';
const ACCOUNT='00000000-0000-4000-8000-000000000901',BINDING='00000000-0000-4000-8000-000000000902';
const CUSTODY='00000000-0000-4000-8000-000000000903',DEVICE='00000000-0000-4000-8000-000000000904';
const APP_PASSWORD=Buffer.from('private-metadata-app-role-disposable'),FINANCIAL_PASSWORD=Buffer.from('private-metadata-financial-role-disposable');
const CUSTODY_PASSWORD=Buffer.from('private-metadata-custody-role-disposable'),KEY=Buffer.alloc(32,23);
const READ_TOKEN='R'.repeat(43),UPLOAD_TOKEN='U'.repeat(43),
  hash=(value:string)=>createHash('sha256').update(value).digest();
let container:StartedPostgreSqlContainer,admin:Pool,app:Pool,custody:Pool,store:OutsideCustodyStore;

beforeAll(async()=>{
  container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  admin=quiet(new Pool({connectionString:container.getConnectionUri()}));
  const sqlDirectory=new URL('../../box/sql/',import.meta.url);
  const files=(await readdir(sqlDirectory)).filter(file=>/^\d+.*\.sql$/.test(file)).sort((a,b)=>
    Number(a.match(/^\d+/)![0])-Number(b.match(/^\d+/)![0])||a.localeCompare(b));
  for(const file of files)await admin.query(await readFile(new URL(file,sqlDirectory),'utf8'));
  const operator=await admin.connect();
  try{await provisionEngineDatabasePrivileges(operator,{expectedDatabase:container.getDatabase(),passwords:{application:APP_PASSWORD,
    financial:FINANCIAL_PASSWORD,outsideCustody:CUSTODY_PASSWORD}});}finally{operator.release();}
  const appUrl=new URL(container.getConnectionUri());appUrl.username='lares_app';appUrl.password=APP_PASSWORD.toString();
  app=quiet(new Pool({connectionString:appUrl.toString()}));
  const custodyUrl=new URL(container.getConnectionUri());custodyUrl.username='lares_outside_custody';custodyUrl.password=CUSTODY_PASSWORD.toString();
  custody=quiet(new Pool({connectionString:custodyUrl.toString()}));
  await admin.query(`INSERT INTO orgs(id,display_name) VALUES($1,'Fixture')`,[ORG]);
  await admin.query(`INSERT INTO users(id,display_name,org_id,org_role,status) VALUES($1,'Owner',$3,'owner','active'),($2,'Member',$3,'member','active')`,[OWNER,MEMBER,ORG]);
  await admin.query(`INSERT INTO agent_definitions(name,definition,hash,status) VALUES('metadata-agent','{}','fixture','valid')`);
  await admin.query(`INSERT INTO agent_access(agent_name,owner_member_id,organisation_id,revision) VALUES('metadata-agent',$1,$2,1)`,[OWNER,ORG]);
  await admin.query(`INSERT INTO connected_accounts(id,owner_member_id,connector_id,provider_issuer,provider_subject,provider_label,status)
    VALUES($1,$2,'lares-private-metadata-v1','lares-private-metadata-v1','fixture-dataset','Private dataset','ok')`,[ACCOUNT,OWNER]);
  await admin.query(`INSERT INTO connected_resource_bindings(id,owner_member_id,connected_account_id,resource_kind,external_id,provider_label)
    VALUES($1,$2,$3,'dataset','owner-dataset','Private dataset')`,[BINDING,OWNER,ACCOUNT]);
  await admin.query(`INSERT INTO outside_custody_accounts(account_id,owner_member_id,resource_id,connection_name,consent_generation,state)
    VALUES($1,$2,'metadata-agent','mac-private-metadata',1,'active')`,[CUSTODY,OWNER]);
  await admin.query(`INSERT INTO private_metadata_devices(id,owner_member_id,connected_account_id,dataset_resource_id,dataset_id,agent_name,
    connection_name,custody_account_id,descriptor_fingerprint,descriptor_json,consent_operation_id,consent_session_id,consent_json,
    upload_token_hash,read_token_hash,generation,connected_account_generation,state)
    VALUES($1,$2,$3,$4,'owner-dataset','metadata-agent','mac-private-metadata',$5,decode(repeat('a',64),'hex'),
    '{"version":1,"connectionName":"mac-private-metadata","scope":"read","allow":["lookup"],"read":["lookup"],"tools":[{"name":"lookup","inputSchema":{"type":"object"}}]}',
    '00000000-0000-4000-8000-000000000905','session-hash',
    '{"memberId":"private-metadata-owner","sessionHash":"session-hash","descriptorFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
    $6,$7,1,0,'active')`,[DEVICE,OWNER,ACCOUNT,BINDING,CUSTODY,hash(UPLOAD_TOKEN),hash(READ_TOKEN)]);
  store=new OutsideCustodyStore(custody as never,KEY,{mainPool:app as never,lifecycle:{} as never});
},120_000);

afterAll(async()=>{store?.close();await Promise.all([app?.end(),custody?.end(),admin?.end()]);await container?.stop();});

it('keeps upload and read scopes distinct and validates the current account generation through real restricted roles',async()=>{
  const read=await store.validatePrivateMetadataCredential(READ_TOKEN,'read');
  expect(read).toEqual({datasetId:'owner-dataset',accountId:ACCOUNT,scope:'read',generation:0});
  await expect(store.validatePrivateMetadataCredential(READ_TOKEN,'upload')).rejects.toThrow();
  await expect(store.validatePrivateMetadataCredential('X'.repeat(43),'read')).rejects.toThrow();
  await app.query(`UPDATE connected_accounts SET generation=1 WHERE id=$1`,[ACCOUNT]);
  await expect(store.validatePrivateMetadataCredential(READ_TOKEN,'read')).rejects.toThrow();
  await expect(app.query('SELECT * FROM private_metadata_devices')).rejects.toMatchObject({code:'42501'});
  await expect(custody.query('SELECT * FROM connected_accounts')).rejects.toMatchObject({code:'42501'});
});

it('uses the admitted member’s account only for the explicit Mac connection, with no owner fallback',async()=>{
  expect(outsideCustodyOwnerForConnection('mac-private-metadata',MEMBER,OWNER)).toBe(MEMBER);
  expect(outsideCustodyOwnerForConnection('another-provider',MEMBER,OWNER)).toBe(OWNER);
  const memberRows=await custody.query(`SELECT account_id FROM outside_custody_accounts WHERE owner_member_id=$1 AND resource_id='metadata-agent'
    AND connection_name='mac-private-metadata' AND state='active'`,[MEMBER]);
  expect(memberRows.rows).toEqual([]);
  const ownerRows=await custody.query(`SELECT account_id FROM outside_custody_accounts WHERE owner_member_id=$1 AND resource_id='metadata-agent'
    AND connection_name='mac-private-metadata' AND state='active'`,[OWNER]);
  expect(ownerRows.rows).toHaveLength(1);
});
