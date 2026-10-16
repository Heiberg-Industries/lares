// Exercise the actual Prisma configuration loader affected by the scoped security
// override, without opening a database or loading installation configuration.
import { createRequire } from 'node:module';
import { readdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const entries = readdirSync('node_modules/.pnpm').filter(name => name.startsWith('@prisma+config@6.19.3'));
assert.equal(entries.length, 1, 'Review the override and compatibility check when Prisma config changes');
const location = join(process.cwd(), 'node_modules/.pnpm', entries[0], 'node_modules/@prisma/config/dist/index.js');
const require = createRequire(location);
const { deepmerge } = require('deepmerge-ts');
assert.deepEqual(deepmerge({ nested: { a: 1 }, items: [1] }, { nested: { b: 2 }, items: [2] }),
  { nested: { a: 1, b: 2 }, items: [1, 2] });
const { loadConfigFromFile } = require(location);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'lares-prisma-compat-')));
try {
  writeFileSync(join(root, 'prisma.config.ts'), 'export default { schema: "./schema.prisma" };\n');
  const result = await loadConfigFromFile({ configRoot: root });
  assert.equal(result.error, undefined);
  assert.equal(result.config.schema, join(root, 'schema.prisma'));
  console.log('Prisma config-loader and merge compatibility checks passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
