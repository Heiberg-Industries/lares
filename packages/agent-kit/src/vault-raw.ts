/**
 * An UNCOMMITTED write into the vault.
 *
 * No git commit — untracked storage, the uncommitted counterpart to `vault-git.ts`.
 * Conversation logs use it: one commit-and-push
 * per conversation turn would be noisy in history and would put a git push on the latency path
 * of every reply.
 *
 * Files under `_meta/conversations/` have always been untracked, and preserving
 * that is deliberate; whether they SHOULD be tracked is a separate question.
 *
 * Path containment reuses `resolveInStore` — the same traversal- and symlink-safe check
 * every other vault path goes through, so an attacker-influenced relPath cannot escape.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { resolveInStore } from "./notes-store.js";

export async function writeRawNote(opts: {
  vaultRoot: string;
  relPath: string;
  bytes: Buffer;
}): Promise<void> {
  const { vaultRoot, relPath, bytes } = opts;
  const abs = resolveInStore(relPath, vaultRoot); // throws before touching disk
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
}
