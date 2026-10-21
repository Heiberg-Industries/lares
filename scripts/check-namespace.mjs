import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Two kinds of check, neither of which names anyone.
//
// 1. Generic: agents derive model names from LARES_MODEL_PREFIX, so a quoted model alias such as
//    "<prefix>-brain" in engine code, definitions, tests or probes must use a neutral prefix.
// 2. A deny-list read at run time from OUTSIDE the repository: LARES_DENYLIST_FILE points at a
//    text file with one regular expression per line (blank lines and lines starting with # are
//    ignored). Matching is case-insensitive and whole-word (an underscore or a literal \n, \t, \r escape counts as a boundary). With the variable unset, only the
//    generic check runs. A file that is named but unreadable fails the check.
//
// A line in a test that asserts a denied word is ABSENT (not.toMatch / not.toContain /
// doesNotMatch / doesNotContain / not.toBe) is allowed, so privacy guards keep working.
// A third generic check rejects internal planning labels (see `planningLabels`).
// Geographic data is unrelated project data.
//
// Whole-file exceptions, each for a reason that is not a leak:
//  - this script and its test (the test quotes the labels it must reject);
//  - the city list (geographic data);
//  - two transit test files whose fixtures are real place names from a public transit register;
//  - the contribution terms, which name the organisation that publishes the project.
const exceptions = new Set([
  'scripts/check-namespace.mjs',
  'scripts/check-namespace.test.mjs',
  'services/console/data/cities.json',
  'packages/agent-kit/tests/entur-client.test.ts',
  'packages/agent-kit/tests/transit-plan.test.ts',
  'CONTRIBUTING.md',
]);
const neutralPrefixes = new Set([
  'lares', 'home', 'example', 'installation', 'tenant', 'other', 'x', 'some', 'custom', 'test',
  'fixture', 'external', 'fake', 'dream', 'vault', 'atlas',
]);
const modelAlias = /["'`]([a-z0-9]+)-(?:brain|writer|utility|gate|embed)["'`]/g;
const modelNameDirs = ['services/', 'packages/', 'scripts/'];
// Internal planning labels must not come back into the tree. Each one is an unambiguous work-item
// label, never product text: a slice id such as W8B-s5, "fix round 2", "controller ruling", a migration
// quoted as "box 085", or a lettered decision such as "owner decision C1" / "ruling D4".
// `skip` lists path prefixes left verbatim: dated evidence records and shipped migration files (their
// names and text are referenced by release records, so they are never rewritten).
const evidenceRecords = ['packages/board-evals/proofs/', 'packages/board-evals/snapshots/'];
const shippedMigrations = ['services/chief-of-staff/sql/', 'services/box/sql/'];
const planningLabels = [
  { name: 'slice id', re: /\bW\d+[A-Z]?-s\d+[a-z]?\b/, skip: [...evidenceRecords, ...shippedMigrations] },
  { name: 'fix round', re: /\bfix round \d/i },
  { name: 'controller ruling', re: /\bcontroller ruling\b/i },
  { name: 'migration number', re: /\bbox \d{3}\b/i, skip: [...evidenceRecords, ...shippedMigrations] },
  { name: 'lettered decision', re: /\b(?:owner decision|ruling) [A-Z]\d+\b/i },
];
const negativeAssertion = /\b(?:not\.(?:toMatch|toContain|toBe|toEqual)|doesNotMatch|doesNotContain)\b/;

const denylistPath = process.env.LARES_DENYLIST_FILE;
const denied = [];
if (denylistPath) {
  // Throws when the file cannot be read: a silent empty list would make the check look clean.
  for (const raw of readFileSync(denylistPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // An underscore counts as a boundary (U_NAME), and so does a literal escape such as \n before the word.
    denied.push(new RegExp(`(?:(?<![\\p{L}\\p{N}])|(?<=\\\\[ntr]))(?:${line})(?![\\p{L}\\p{N}])`, 'iu'));
  }
}

const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const failures = [];
for (const path of new Set(paths)) {
  if (exceptions.has(path)) continue;
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { continue; }
  if (text.includes('\0') && !/\.(?:ts|tsx|js|mjs|json|md|sql|sh|ya?ml)$/.test(path)) continue;
  const checkModelNames = modelNameDirs.some((dir) => path.startsWith(dir));
  text.split('\n').forEach((line, index) => {
    if (checkModelNames) {
      for (const m of line.matchAll(modelAlias)) {
        if (!neutralPrefixes.has(m[1])) failures.push(`${path}:${index + 1} (model name with a non-neutral prefix; use LARES_MODEL_PREFIX or a neutral prefix)`);
      }
    }
    for (const label of planningLabels) {
      if (label.skip?.some((prefix) => path.startsWith(prefix))) continue;
      if (label.re.test(line)) failures.push(`${path}:${index + 1} (internal planning label: ${label.name}; say what it means instead)`);
    }
    if (denied.some((re) => re.test(line)) && !(path.includes('/tests/') && negativeAssertion.test(line))) {
      failures.push(`${path}:${index + 1} (matches a private deny-list entry)`);
    }
  });
}
if (failures.length) {
  console.error('Namespace check failed:\n' + failures.join('\n'));
  process.exitCode = 1;
} else console.log(`Lares namespace check passed (${denylistPath ? 'deny-list applied' : 'no deny-list set; generic checks only'}).`);
