/**
 * An UNCOMMITTED write into the vault.
 *
 * The counterpart to `services/box/lib/brain-source.ts`'s `writeRaw`, described there as
 * "no git commit — untracked attachment storage". Conversation logs use it: one commit-and-push
 * per conversation turn would be noisy in history and would put a git push on the latency path
 * of every reply.
 *
 * Verified on the box 2026-08-19: `_meta/conversations/` holds 160 markdown files and
 * `git ls-files _meta/conversations` returns 0 — they have always been untracked. Preserving
 * that is deliberate (ORB-138); whether they SHOULD be tracked is a separate question.
 *
 * Path containment reuses `resolveInStore` — the same ORB-52 traversal- and symlink-safe check
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
