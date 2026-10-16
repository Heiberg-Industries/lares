// A secret nobody declared is invisible (W6A-s4). Two lists claim to say which secret files an
// installation needs — the integration manifests (`integrations/<id>/integration.json`) and
// `integrations/installation.json`, together rendered as `connections.ts` (W6A-s3). Neither list
// is checked against what the fleet's OWN CODE actually reads. A secret a door or a client reads
// but no list names it does not get rotated with the rest, the console cannot show it, and an
// export or an erase pass that walks the declared set silently misses it.
//
// This is a TRIPWIRE over source text, the same shape as `write-shape-lint.ts`: it does not run
// the code or resolve an import graph, it looks for the two ways a secret file path shows up in
// this codebase — a literal `/run/secrets/<name>` and a `*_FILE` env default that resolves to
// one — and reports every name that is not in the declared union.
//
// No credential reads and no I/O at module scope. Build- and test-time only.
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, extname, join, resolve } from "node:path";

import { loadIntegrationManifests, INTEGRATIONS_DIR } from "./integration-manifest.js";
import { connections, secretsForRefs } from "./connections.js";

export interface SecretFinding {
  file: string;
  secret: string;
  message: string;
}

/** A `/run/secrets/` + name literal — the shape every secret file path in this codebase takes,
 *  whether it is a bare default or the fallback half of a `*_FILE` env binding (an env default
 *  of the form `process.env["X_KEY_FILE"] ?? "` + the same path + `"`). The name itself, never a
 *  value: this regex cannot and must not match a token, a key or any other secret's contents.
 *  (This comment spells the path in parts so the lint does not flag its own doc comment.) */
export const SECRET_PATH_RE = /\/run\/secrets\/([a-z0-9][a-z0-9-]{0,62})/g;

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

/** `root` as given, resolved against the repo root when it is not already absolute — so a
 *  caller can pass either a scratch directory (tests) or a repo-relative path like
 *  `"packages/agent-kit/src"` (the real check, run from any package's own `vitest run`). */
function resolveRoot(root: string): string {
  return isAbsolute(root) ? root : join(REPO_ROOT, root);
}

function walkTsFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // a root that does not exist finds nothing, rather than throwing
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && extname(entry.name) === ".ts") out.push(full);
    }
  }
  return out;
}

/** Every secret name declared anywhere: an integration manifest's own `secrets` field, plus
 *  every connection instance's secret files (`connections.ts`, generated from
 *  `integrations/installation.json` — W6A-s3). The two are checked together because Slack's and
 *  Google's manifests declare `secrets: []` on purpose (their real names are per agent instance,
 *  installation data) — the manifest alone would under-count what IS declared. */
function declaredSecrets(dir: string): Set<string> {
  const out = new Set<string>();
  for (const manifest of loadIntegrationManifests(dir)) {
    for (const s of manifest.secrets) out.add(s);
  }
  const refs: string[] = [];
  for (const def of connections.values()) {
    for (const inst of def.instances) refs.push(`${def.id}:${inst.id}`);
  }
  for (const s of secretsForRefs(refs)) out.add(s);
  return out;
}

/** Every `/run/secrets/<name>` literal and every `*_TOKEN_FILE` / `*_KEY_FILE` default in the
 *  given roots, checked against what the manifests and installation.json declare. `roots` may be
 *  absolute (a scratch directory) or repo-relative (`"packages/agent-kit/src"`); `dir` is the
 *  integrations directory to load manifests from, defaulting to the repo's own `integrations/`. */
export function lintUndeclaredSecrets(roots: readonly string[], dir?: string): SecretFinding[] {
  const declared = declaredSecrets(dir ?? join(REPO_ROOT, INTEGRATIONS_DIR));
  const found: SecretFinding[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    for (const file of walkTsFiles(resolveRoot(root))) {
      const text = readFileSync(file, "utf8");
      const re = new RegExp(SECRET_PATH_RE.source, SECRET_PATH_RE.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const secret = m[1]!;
        if (declared.has(secret)) continue;
        const key = `${file}\0${secret}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({
          file,
          secret,
          message:
            `${secret}: read at ${file}, but no integrations/ manifest and no ` +
            `integrations/installation.json instance declares it — nobody would rotate it, the ` +
            `console cannot show it, and an export or erase walking the declared set misses it.`,
        });
      }
    }
  }

  return found.sort((a, b) => a.secret.localeCompare(b.secret) || a.file.localeCompare(b.file));
}
