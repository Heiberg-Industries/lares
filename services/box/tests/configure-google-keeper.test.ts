import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'ops', 'configure-google-keeper.py');

function addPrincipal(contents: string, owner: string): string {
  const python = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('configure_google_keeper',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
request=json.load(sys.stdin)
print(json.dumps(module.console_env_with_principal(request['contents'],request['owner'])))`;
  return JSON.parse(execFileSync('python3', ['-c', python, script], {
    input: JSON.stringify({ contents, owner }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }));
}

it('pins the installed owner without changing the Google client pair or duplicating the setting', () => {
  const env = 'GOOGLE_CLIENT_ID_ACME=client-id\nGOOGLE_CLIENT_SECRET_ACME=secret-value\n';
  const saved = addPrincipal(env, 'owner@example.test');
  expect(saved).toBe(env + 'CONSOLE_PRINCIPAL_ID=owner@example.test\n');
  expect(addPrincipal(saved, 'owner@example.test')).toBe(saved);
});

it('refuses a conflicting or duplicate principal instead of replacing it', () => {
  expect(() => addPrincipal('CONSOLE_PRINCIPAL_ID=someone-else\n', 'owner@example.test')).toThrow();
  expect(() => addPrincipal('CONSOLE_PRINCIPAL_ID=owner@example.test\nCONSOLE_PRINCIPAL_ID=owner@example.test\n', 'owner@example.test')).toThrow();
  expect(() => addPrincipal('', 'owner\nOTHER=unsafe')).toThrow();
});

function runLegacyHelper(config: unknown): {code:number;error:string;output:string} {
  const python=`import contextlib,importlib.util,io,json,stat,sys,types
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('configure_google_keeper',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
config=json.load(sys.stdin)
values='GOOGLE_CLIENT_ID_ACME=fixture-id\\nGOOGLE_CLIENT_SECRET_ACME=fixture-private-value\\n'
def lstat(path):
 return types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=(stat.S_IFDIR|0o700) if path.name=='secrets' else (stat.S_IFREG|0o600))
def read_text(path,*args,**kwargs):
 return json.dumps(config) if path.name=='keeper.json' else values
output,error=io.StringIO(),io.StringIO()
with patch.object(module.os,'geteuid',return_value=0),patch.object(Path,'lstat',lstat),patch.object(Path,'read_text',read_text),patch.object(Path,'is_file',return_value=True),patch.object(module,'atomic_write',side_effect=AssertionError('unexpected write')),patch.object(sys,'argv',[sys.argv[1],'--org','acme','--env-file','/fixture/oauth.env','--keeper-config','/fixture/keeper.json','--secrets-dir','/fixture/secrets','--dry-run']),contextlib.redirect_stderr(error),contextlib.redirect_stdout(output):
 try:
  module.main()
  code=0
 except SystemExit as stopped:
  code=stopped.code
print(json.dumps({'code':code,'error':error.getvalue(),'output':output.getvalue()}))`;
  return JSON.parse(execFileSync('python3',['-c',python,script],{input:JSON.stringify(config),encoding:'utf8',stdio:['pipe','pipe','pipe']}));
}

it('the legacy helper explicitly refuses personal-only Google config before looking for a legacy owner or writing files', () => {
  const result=runLegacyHelper({lifecycle:{runtime:{google:{tokenKeyFile:'/fixture/secrets/token-enc-key',clients:{}}}}});
  expect(result.code).toBe(2);
  expect(result.error).toContain('legacy email-door access only');
  expect(result.error).toContain('without adding a principal');
  expect(result.error).toContain('explicitly reconcile the Gmail runtime');
  expect(result.error).not.toMatch(/KeyError|Traceback|fixture-private-value/);
  expect(result.output).toBe('');
});

const legacyConfig=(principal='owner@example.test')=>({lifecycle:{runtime:{google:{principal,tokenKeyFile:'/fixture/secrets/token-enc-key',clients:{}}},
  defaultBindings:{'chief-of-staff':{ownerId:'owner@example.test'}}}});
it('keeps explicit legacy dry-run setup working without any file writes',()=>{
  const result=runLegacyHelper(legacyConfig());
  expect(result.code).toBe(0);expect(result.error).toBe('');
  expect(result.output).toContain('Would configure Google org acme');
  expect(result.output).not.toContain('fixture-private-value');
});
it('still refuses an explicit conflicting legacy principal without substituting the owner',()=>{
  const result=runLegacyHelper(legacyConfig('other@example.test'));
  expect(result.code).toBe(2);expect(result.error).toContain('existing Keeper Google principal or token key differs');
  expect(result.error).not.toMatch(/Traceback|other@example.test|fixture-private-value/);
});
