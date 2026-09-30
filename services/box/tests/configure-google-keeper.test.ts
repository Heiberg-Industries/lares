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
  const env = 'GOOGLE_CLIENT_ID_HEIBERG=client-id\nGOOGLE_CLIENT_SECRET_HEIBERG=secret-value\n';
  const saved = addPrincipal(env, 'owner@example.test');
  expect(saved).toBe(env + 'CONSOLE_PRINCIPAL_ID=owner@example.test\n');
  expect(addPrincipal(saved, 'owner@example.test')).toBe(saved);
});

it('refuses a conflicting or duplicate principal instead of replacing it', () => {
  expect(() => addPrincipal('CONSOLE_PRINCIPAL_ID=someone-else\n', 'owner@example.test')).toThrow();
  expect(() => addPrincipal('CONSOLE_PRINCIPAL_ID=owner@example.test\nCONSOLE_PRINCIPAL_ID=owner@example.test\n', 'owner@example.test')).toThrow();
  expect(() => addPrincipal('', 'owner\nOTHER=unsafe')).toThrow();
});
