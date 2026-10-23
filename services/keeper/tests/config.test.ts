import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { keeperFinancialPool, keeperOutsideCustodyPool, keeperPool, loadKeeperConfig } from "../lib/config.js";
const dirs: string[] = [];
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-config-"));
  dirs.push(dir);
  return { dir, file: join(dir, "keeper.json"), config: { mode: "overlay", project: "lares", dir, files: ["compose.yaml"], agentsDir: dir, retiredDir: dir, secretsDir: dir, rolesDir: dir, templatesDir: dir, backupDir: dir, db: { host: "db", port: 5432, database: "lares_state", user: "lares_app", passwordFile: join(dir, "password") } } };
};
function outsideLifecycle(f:ReturnType<typeof fixture>,gatewayKeyFile:string){
  const image='example/runtime@sha256:'+'a'.repeat(64);
  return {network:'fixture_default',subnet:'172.18.0.0/24',reservedAddresses:[],
    composeFile:join(f.dir,'compose.yaml'),egressDir:f.dir,imageByRole:{'chief-of-staff':image,creative:image},
    proxyContainer:'lares-proxy',squidImage:image,firewallImage:image,
    adminDb:{...f.config.db,database:'postgres',user:'lares_workflow_provisioner',passwordFile:join(f.dir,'admin-password')},
    workflowTemplate:'template',workflowOwner:'lares_workflow_owner',installationPrepared:true,
    maintenanceAdmission:{hostDirectory:join(f.dir,'maintenance-admission'),installationId:'11111111-1111-4111-8111-111111111111',epoch:7},
    runtime:{databaseUrl:'postgres://lares_app@db/lares_state',workflowServer:'postgres://lares_workflow@db/',gatewayUrl:'https://gateway.example',
      proxyUrl:'http://proxy:8888',passwordFile:f.config.db.passwordFile,workflowPasswordFile:join(f.dir,'workflow-password'),gatewayKeys:{worker:gatewayKeyFile}},
    egress:{endpoints:{},legacyConsumers:[{name:'outside-bridge',address:'172.18.0.23',hosts:['api.example.com']}],internalNetworks:['172.18.0.0/24'],directDestinations:[],infrastructureHosts:[]}};
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
it("loads overlay and rendered configs without installation defaults", () => {
  const f = fixture();
  for (const mode of ["overlay", "rendered"]) {
    writeFileSync(f.file, JSON.stringify({ ...f.config, mode }));
    expect(loadKeeperConfig(f.file)).toEqual({ ...f.config, mode });
  }
});
it("keeps the trusted designated owner optional for older keeper configs and validates rendered values",()=>{
  const f=fixture();
  writeFileSync(f.file,JSON.stringify({...f.config,mode:'rendered',designatedOwnerId:'owner-id'}));
  expect(loadKeeperConfig(f.file).designatedOwnerId).toBe('owner-id');
  for(const designatedOwnerId of ['', 'x'.repeat(129), {id:'owner'}]){
    writeFileSync(f.file,JSON.stringify({...f.config,mode:'rendered',designatedOwnerId}));
    expect(()=>loadKeeperConfig(f.file)).toThrow('designatedOwnerId');
  }
});
// : the keeper used to replace every failure with "invalid or unreadable configuration",
// so the owner could not see which field in the boot file was wrong. Each failure now says
// what it is and where — and still never repeats a value from the file.
it("a missing file is reported as missing, with its path and the system's reason", () => {
  const f = fixture();
  expect(() => loadKeeperConfig(f.file)).toThrow(`keeper: configuration file ${f.file} is missing or unreadable (ENOENT)`);
});
it("a file that is not JSON is reported as such, without quoting its text", () => {
  const f = fixture();
  writeFileSync(f.file, '{ "db": { "password": "hunter2-the-secret" }');
  const error = catchError(() => loadKeeperConfig(f.file));
  expect(error.message).toBe(`keeper: configuration file ${f.file} is not valid JSON`);
  expect(error.message).not.toContain("hunter2");
});
it("a schema failure names the field's path and the reason, for top-level and nested fields alike", () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ ...f.config, project: "secret;rm", db: { ...f.config.db, port: "5432" } }));
  const error = catchError(() => loadKeeperConfig(f.file));
  expect(error.message).toContain(`keeper: invalid configuration in ${f.file}:`);
  expect(error.message).toMatch(/\bproject: /);
  expect(error.message).toMatch(/\bdb\.port: .*expected number/);
  expect(error.message).not.toContain("secret;rm");
  expect(error.message).not.toContain("5432");
});
it("names an unrecognized key but never the value stored under it", () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ ...f.config, db: { ...f.config.db, password: "hunter2-the-secret" } }));
  const error = catchError(() => loadKeeperConfig(f.file));
  expect(error.message).toMatch(/\bdb: .*password/);
  expect(error.message).not.toContain("hunter2");
});
it("a relative directory is refused with the field named, not the path echoed", () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ ...f.config, agentsDir: "relative/agents-of-hunter2" }));
  const error = catchError(() => loadKeeperConfig(f.file));
  expect(error.message).toMatch(/\bagentsDir: /);
  expect(error.message).not.toContain("hunter2");
});
it("reads the password only when creating a pool", async () => {
  const f = fixture();
  writeFileSync(f.config.db.passwordFile, "secret\n");
  const pool = keeperPool(f.config.db);
  expect(pool.options.password).toBe("secret");
  expect(pool.options.database).toBe("lares_state");
  await pool.end();
  rmSync(f.config.db.passwordFile);
  expect(() => keeperPool(f.config.db)).toThrow("credentials unavailable");
});
it.each([
  ["missing", undefined],
  ["empty", ""],
  ["newline-only", "\n"],
  ["CRLF-only", "\r\n"],
])("refuses %s app and financial password files without falling back to ambient PGPASSWORD", (_label, contents) => {
  const f = fixture(), passwordFile = join(f.dir, "missing-password");
  const previous = process.env.PGPASSWORD;
  process.env.PGPASSWORD = "ambient-only-secret";
  try {
    if (contents !== undefined) writeFileSync(passwordFile, contents);
    const app = { ...f.config.db, passwordFile };
    const financial = { ...app, user: "lares_financial" as const };
    const appError = catchError(() => keeperPool(app));
    const financialError = catchError(() => keeperFinancialPool({ budgetFinancial: { directory: "/var/lib/lares/budget-financial", db: financial } }));
    expect(appError.message).toBe("keeper: database credentials unavailable");
    expect(financialError.message).toBe("keeper: database credentials unavailable");
    expect(appError.message + financialError.message).not.toContain("ambient-only-secret");
  } finally {
    if (previous === undefined) delete process.env.PGPASSWORD;
    else process.env.PGPASSWORD = previous;
  }
});
function catchError(fn: () => unknown): Error {
  try {
    fn();
  }
  catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to throw");
}

it("accepts only the named generated slot and one explicit administrator", () => {
  const f = fixture();
  const credentials = { administrator: "owner@example.invalid", slot: "notion:shared", binding: "NOTION_TOKEN_FILE", prepared: false, inventoryComplete: false, retainedConsumers: [] };
  writeFileSync(f.file, JSON.stringify({ ...f.config, credentials }));
  expect(loadKeeperConfig(f.file).credentials).toEqual(credentials);
  for (const invalid of [{...credentials, administrator: ["one@example.invalid", "two@example.invalid"]}, {...credentials, administrator: "one@example.invalid,two@example.invalid"}, {...credentials, slot: "gateway:master"}, {...credentials, binding: "TOKEN_ENC_KEY_FILE"}, {...credentials, path: "/tmp/key"}, {...credentials, token: "synthetic-secret"}]) {
    writeFileSync(f.file, JSON.stringify({ ...f.config, credentials: invalid }));
    const error = catchError(() => loadKeeperConfig(f.file));
    expect(error.message).toContain("invalid configuration");
    expect(error.message).not.toContain("synthetic-secret");
  }
});

it('loads digit-leading canonical Google orgs while preserving exact legacy keys', () => {
  const f=fixture(), image='example/runtime@sha256:'+'a'.repeat(64);
  const client={clientIdFile:join(f.dir,'client-id'),clientSecretFile:join(f.dir,'client-secret')};
  const lifecycle={network:'fixture_default',subnet:'172.18.0.0/24',reservedAddresses:[],
    composeFile:join(f.dir,'compose.yaml'),egressDir:f.dir,imageByRole:{'chief-of-staff':image,creative:image},
    proxyContainer:'lares-proxy',squidImage:image,firewallImage:image,adminDb:{...f.config.db,database:'postgres',user:'lares_workflow_provisioner'},
    workflowTemplate:'template',workflowOwner:'lares_workflow_owner',installationPrepared:true,
    maintenanceAdmission:{hostDirectory:join(f.dir,'maintenance-admission'),installationId:'11111111-1111-4111-8111-111111111111',epoch:7},
    runtime:{databaseUrl:'postgres://lares_app@db/lares',workflowServer:'postgres://lares_workflow@db/',gatewayUrl:'https://gateway.example',
      proxyUrl:'http://proxy:8888',passwordFile:join(f.dir,'password'),workflowPasswordFile:join(f.dir,'workflow-password'),gatewayKeys:{},
      google:{tokenKeyFile:join(f.dir,'token-key'),clients:{'123':client,'1acme':client,ac_me:client,'old-client':client,['legacy'+'a'.repeat(40)]:client}}},
    egress:{endpoints:{},legacyConsumers:[],internalNetworks:[],directDestinations:[],infrastructureHosts:[]}};
  const load=(clients:Record<string,typeof client>)=>{
    writeFileSync(f.file,JSON.stringify({...f.config,lifecycle:{...lifecycle,runtime:{...lifecycle.runtime,google:{...lifecycle.runtime.google,clients}}}}));
    return loadKeeperConfig(f.file).lifecycle!.runtime.google!;
  };
  const clients=lifecycle.runtime.google.clients, loaded=load(clients);
  expect(loaded.clients).toEqual(clients);expect(loaded.principal).toBeUndefined();
  for(const org of ['123','1acme','0','1'.repeat(32)])expect(load({[org]:client}).clients).toEqual({[org]:client});
  for(const org of ['1ac-me','1_acme','ACME','../acme','1'.repeat(33)])expect(()=>load({[org]:client})).toThrow('invalid configuration');
});

it('keeps financial custody optional and only accepts its dedicated backup-excluded path',()=>{
  const f=fixture(),budgetFinancial={directory:'/var/lib/lares/budget-financial',db:{...f.config.db,user:'lares_financial'}};
  writeFileSync(f.file,JSON.stringify({...f.config,budgetFinancial}));expect(loadKeeperConfig(f.file).budgetFinancial).toEqual(budgetFinancial);
  for(const invalid of [{directory:'/etc/lares/budget-financial',db:budgetFinancial.db},{directory:'/srv/lares/budget-financial',db:budgetFinancial.db},{directory:budgetFinancial.directory,db:budgetFinancial.db,reset:true},{directory:budgetFinancial.directory,db:budgetFinancial.db,enabled:true}]){
    writeFileSync(f.file,JSON.stringify({...f.config,budgetFinancial:invalid}));expect(()=>loadKeeperConfig(f.file)).toThrow('budgetFinancial');
  }
});
it('never creates a financial connection from the ordinary app login',async()=>{
  const f=fixture();
  expect(keeperFinancialPool({})).toBeUndefined();
  writeFileSync(join(f.dir,'financial-password'),'financial-secret');
  const financial=keeperFinancialPool({budgetFinancial:{directory:'/var/lib/lares/budget-financial',db:{...f.config.db,user:'lares_financial',passwordFile:join(f.dir,'financial-password')}}});
  expect(financial?.options.user).toBe('lares_financial');
  expect(financial?.options.database).toBe('lares_state');
  await financial?.end();
});
it('keeps outside custody disabled unless its exact role, same database, and distinct protected files are configured',async()=>{
  const f=fixture(),outsideCustody={db:{...f.config.db,user:'lares_outside_custody' as const,passwordFile:join(f.dir,'outside-password')},
    keyFile:'/var/lib/lares/outside-custody/key' as const,keyFingerprint:'a'.repeat(64),routeConsumerName:'outside-bridge'};
  expect(keeperOutsideCustodyPool({})).toBeUndefined();
  writeFileSync(f.file,JSON.stringify({...f.config,outsideCustody}));
  expect(()=>loadKeeperConfig(f.file)).toThrow('outsideCustody: requires the root lifecycle and route policy');
  writeFileSync(outsideCustody.db.passwordFile,'outside-secret');
  const pool=keeperOutsideCustodyPool({outsideCustody});
  expect(pool?.options.user).toBe('lares_outside_custody');
  expect(pool?.options.database).toBe(f.config.db.database);
  await pool?.end();
  for(const invalid of [
    {...outsideCustody,db:{...outsideCustody.db,database:'another'}},
    {...outsideCustody,db:{...outsideCustody.db,passwordFile:f.config.db.passwordFile}},
    {...outsideCustody,keyFile:outsideCustody.db.passwordFile},
    {...outsideCustody,db:{...outsideCustody.db,user:'lares_app'}},
  ]){
    writeFileSync(f.file,JSON.stringify({...f.config,outsideCustody:invalid}));
    expect(()=>loadKeeperConfig(f.file)).toThrow('outsideCustody');
  }
});
it('rejects physical aliases between outside custody files and existing Keeper credentials',()=>{
  const f=fixture(),gatewayKeyFile=join(f.dir,'gateway-key'),outsidePassword=join(f.dir,'outside-password');
  writeFileSync(gatewayKeyFile,'test-only gateway key');
  symlinkSync(gatewayKeyFile,outsidePassword);
  const outsideCustody={db:{...f.config.db,user:'lares_outside_custody',passwordFile:outsidePassword},
    keyFile:'/var/lib/lares/outside-custody/key',keyFingerprint:'a'.repeat(64),routeConsumerName:'outside-bridge'};
  writeFileSync(f.file,JSON.stringify({...f.config,outsideCustody,lifecycle:outsideLifecycle(f,gatewayKeyFile)}));
  expect(()=>loadKeeperConfig(f.file)).toThrow('outside custody files must not alias');
});
it('requires prepared financial custody for the fixed native custody path',()=>{
  const f=fixture(),budgetNative={directory:'/var/lib/lares/budget-native'};
  writeFileSync(f.file,JSON.stringify({...f.config,budgetNative}));
  expect(()=>loadKeeperConfig(f.file)).toThrow('budgetNative: requires prepared financial custody');
  const budgetFinancial={directory:'/var/lib/lares/budget-financial',db:{...f.config.db,user:'lares_financial'}};
  writeFileSync(f.file,JSON.stringify({...f.config,budgetFinancial,budgetNative}));
  expect(loadKeeperConfig(f.file).budgetNative).toEqual(budgetNative);
  for(const invalid of [{directory:'/etc/lares/budget-native'},{directory:'/srv/lares/budget-native'},{directory:budgetNative.directory,reset:true}]){
    writeFileSync(f.file,JSON.stringify({...f.config,budgetFinancial,budgetNative:invalid}));
    expect(()=>loadKeeperConfig(f.file)).toThrow('budgetNative');
  }
  const withPolicy={...budgetNative,reviewedPolicyFile:'/etc/lares/native-policy.json'};
  writeFileSync(f.file,JSON.stringify({...f.config,budgetFinancial,budgetNative:withPolicy}));
  expect(loadKeeperConfig(f.file).budgetNative).toEqual(withPolicy);
  for(const invalid of [{...withPolicy,reviewedPolicyFile:'relative.json'},{...withPolicy,reviewedPolicyFile:'/etc/lares/policy.json',inlinePolicy:{secret:true}}]){
    writeFileSync(f.file,JSON.stringify({...f.config,budgetFinancial,budgetNative:invalid}));
    expect(()=>loadKeeperConfig(f.file)).toThrow('budgetNative');
  }
});
