// services/atlas/lib/config.ts
// Env → Config, plus the two guards that a composition root cannot pass by accident.
//
// WHY THE GUARDS EXIST: a root wired to a wrong-but-PRESENT value typechecks and passes the
// whole suite. notion-sync Phase 4 shipped that defect three times. Types cannot catch it —
// `makeFsReader({id:"vault", root: atlasPath})` is a perfectly well-typed vault reader that
// reads the wrong store — so the check has to be a runtime one whose correct answer is a
// semantic contradiction: two readers cannot both be "the store containing index.md" and
// "the store containing SCHEMA.md" unless they really are two different stores.
import { readFileSync } from "node:fs";
import type { ReaderMap, SourceReader } from "./resolve.js";
import type { StorePrefix } from "./sources.js";
import { STORE_PREFIXES } from "./sources.js";

export interface Config {
  atlasPath: string;
  vaultPath: string;
  /** Read-only token covering the explicitly configured repositories. */
  githubToken: string;
  notionToken: string;
  gatewayUrl: string;
  gatewayKey: string;
  /** No default, ever. Model selection is resolved from the live gateway config at deploy. */
  draftModel: string;
  tickMs: number;
  live: boolean;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (v === undefined || v.trim() === "") throw new Error(`atlas: ${key} is required`);
  return v;
}

/** A secret from a FILE, never a plaintext env var — the box's convention for every token. */
function secret(env: NodeJS.ProcessEnv, key: string, read: (p: string) => string): string {
  const path = required(env, key);
  const value = read(path).trim();
  if (value === "") throw new Error(`atlas: the secret file at ${key}=${path} is empty`);
  return value;
}

/**
 * The signal-spine bearer token (ORB-178 / ORB-35 item 4): `SIGNAL_SPINE_TOKEN_FILE` wins
 * when set (trimmed file content), else the plain `SIGNAL_SPINE_TOKEN` env var, else
 * `undefined`. Unlike `secret()` above, absence is a legitimate answer here — the spine
 * notifier degrades to a log line when unconfigured, and the plain env var is a fallback ONLY
 * when `_FILE` is unset — but a FILE path that IS set must resolve to a real token or throw
 * naming the path: a deploy that mounts the secret wrong must crash-loud, never silently fall
 * through to "not configured" or to the plain env var. That covers both an unreadable file
 * (throws) and a blank one (also throws — mirrors `secret()`'s "REFUSES an empty secret file"
 * above: a mounted-but-blank file is the same failure mode whether the secret is required or
 * optional). Empty string still counts as unset for the plain env var itself, same as every
 * other read in this file.
 */
export function readSpineToken(
  env: NodeJS.ProcessEnv,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): string | undefined {
  const filePath = env["SIGNAL_SPINE_TOKEN_FILE"];
  if (filePath !== undefined && filePath.trim() !== "") {
    let fromFile: string;
    try {
      fromFile = readFile(filePath).trim();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`atlas: cannot read SIGNAL_SPINE_TOKEN_FILE at ${filePath}: ${reason}`);
    }
    if (fromFile === "") {
      throw new Error(`atlas: the secret file at SIGNAL_SPINE_TOKEN_FILE=${filePath} is empty`);
    }
    return fromFile;
  }
  const plain = env["SIGNAL_SPINE_TOKEN"];
  return plain === undefined || plain.trim() === "" ? undefined : plain;
}

export function readConfig(
  env: NodeJS.ProcessEnv,
  readSecretFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): Config {
  const tickRaw = env["ATLAS_SYNC_TICK_MS"];
  const tickMs = tickRaw === undefined || tickRaw.trim() === "" ? 86_400_000 : Number(tickRaw);
  // A non-numeric tick would become NaN, and `setInterval(fn, NaN)` fires every ~1ms —
  // a daily job turned into a hot loop against GitHub, Notion and the model gateway. Fail
  // at startup instead, where it is one line in the logs rather than a rate-limit incident.
  if (!Number.isFinite(tickMs) || tickMs <= 0) {
    throw new Error(`atlas: ATLAS_SYNC_TICK_MS must be a positive number of milliseconds, got "${tickRaw}"`);
  }

  return {
    atlasPath: env["ATLAS_PATH"] ?? "/srv/atlas",
    vaultPath: env["BRAIN_PATH"] ?? "/srv/brain",
    githubToken: secret(env, "GITHUB_TOKEN_FILE", readSecretFile),
    notionToken: secret(env, "NOTION_TOKEN_FILE", readSecretFile),
    // Bare host — draft-model.ts's adapter appends `/v1/messages` itself, landing on the
    // gateway's ROUTER route, where purpose aliases (heiberg-brain, etc.) resolve. Never the
    // `/anthropic` pass-through: that forwards the model id to Anthropic verbatim, and an
    // alias 404s there (ORB-225).
    gatewayUrl: env["GATEWAY_URL"] ?? "https://gateway.example.com",
    gatewayKey: secret(env, "GATEWAY_KEY_FILE", readSecretFile),
    draftModel: required(env, "ATLAS_DRAFT_MODEL"),
    tickMs,
    live: env["ATLAS_SYNC_LIVE"] === "1",
  };
}

/** Which reader id each prefix must have. Distinct by construction. */
const EXPECTED_ID: Record<StorePrefix, string> = {
  repo: "github", vault: "vault", notion: "notion", atlas: "atlas",
};

/**
 * Three passes, in this order on purpose.
 *
 * Sharing one instance across two prefixes trips the id check too — every prefix expects a
 * different id, so a shared reader is wrong for at least one of them. But "reports id
 * 'atlas', expected 'vault'" sends you looking for a typo, when the actual mistake is
 * `atlas: r, vault: r`. Checking distinctness FIRST, across the whole map rather than as the
 * loop passes each prefix, means the copy-paste root gets named for what it is regardless of
 * which prefix the duplicate lands on.
 */
export function assertReaderWiring(readers: ReaderMap): void {
  for (const prefix of STORE_PREFIXES) {
    if (readers[prefix] === undefined) {
      throw new Error(`atlas: no reader wired for "${prefix}:" — refusing to start`);
    }
  }

  const seen = new Map<SourceReader, StorePrefix>();
  for (const prefix of STORE_PREFIXES) {
    const already = seen.get(readers[prefix]);
    if (already !== undefined) {
      throw new Error(
        `atlas: the same reader instance is wired to both "${already}:" and "${prefix}:" — the four ` +
        "stores must be four distinct readers",
      );
    }
    seen.set(readers[prefix], prefix);
  }

  for (const prefix of STORE_PREFIXES) {
    const reader = readers[prefix];
    if (reader.id !== EXPECTED_ID[prefix]) {
      throw new Error(
        `atlas: the "${prefix}:" reader reports id "${reader.id}", expected "${EXPECTED_ID[prefix]}" ` +
        "— the composition root has wired the wrong store to this prefix",
      );
    }
  }
}

/**
 * The runtime sentinel. Each local store is asked for a file that exists ONLY in it:
 * `SCHEMA.md` is the Atlas's contract file; `index.md` is the vault's root index (both
 * verified present on the box, 2026-08-11). A root that pointed both readers at one root
 * cannot satisfy both, and a root that pointed either at nothing cannot satisfy either.
 *
 * Local stores only: the remote ones need network and belong in `atlas-sync --doctor`, not in
 * a startup path that must survive a transient GitHub outage.
 */
export async function probeLocalStores(readers: ReaderMap): Promise<void> {
  const atlas = await readers.atlas.read({ prefix: "atlas", locator: "SCHEMA.md", declared: "atlas:SCHEMA.md" });
  if (atlas.outcome !== "found") {
    throw new Error(
      `atlas: the "atlas:" reader cannot see SCHEMA.md (${atlas.outcome}: ${atlas.reason}). ` +
      "ATLAS_PATH is wrong, or /srv/atlas is not mounted.",
    );
  }
  const vault = await readers.vault.read({ prefix: "vault", locator: "index.md", declared: "vault:index.md" });
  if (vault.outcome !== "found") {
    throw new Error(
      `atlas: the "vault:" reader cannot see index.md (${vault.outcome}: ${vault.reason}). ` +
      "BRAIN_PATH is wrong, /srv/brain is not mounted, or this reader is pointed at the Atlas.",
    );
  }
}
