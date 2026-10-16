// services/atlas/lib/adapters/fs-source.ts
// The `vault:` and `atlas:` readers — one implementation, two roots, distinct ids.
//
// Two roots and one implementation because the stores differ only in where they are
// mounted; distinct ids because the composition root asserts the four readers are four
// DIFFERENT things (a root that wires the same reader twice typechecks and passes every
// unit test — the notion-sync Phase 4 composition-root defect, three times in one phase).
import { readFileSync, statSync, realpathSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { SourceRef } from "../sources.js";
import type { ResolvedSource, SourceReader } from "../resolve.js";

export function makeFsReader(opts: { id: string; root: string }): SourceReader {
  const root = resolvePath(opts.root);

  return {
    id: opts.id,
    async read(ref: SourceRef): Promise<ResolvedSource> {
      // An absent or unreadable STORE ROOT is `failed`, not `missing`. This is the mount
      // that isn't there — /srv/brain not bind-mounted into the container is the live
      // shape — and calling every one of its files "gone" would propose emptying every
      // note that derives from the vault, in one tick.
      let rootReal: string;
      try {
        if (!statSync(root).isDirectory()) {
          return { ref, outcome: "failed", reason: `store root ${root} is not a directory` };
        }
        rootReal = realpathSync(root);
      } catch (e) {
        return {
          ref, outcome: "failed",
          reason: `store root ${root} is not readable (${e instanceof Error ? e.message : String(e)})`,
        };
      }

      const abs = resolvePath(join(root, ref.locator));
      // The guard sources.ts cannot give: resolve() is string arithmetic and never touches
      // the disk, so a SYMLINKED DIRECTORY inside the store pointing anywhere at all passes
      // it unchanged. Real inodes are the only way to close that.
      let real: string;
      try {
        real = realpathSync(abs);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        // Only "the path itself doesn't exist" means missing. Everything else — EACCES on
        // a parent directory (the box's most likely trigger: the container user loses read
        // on a mounted subtree while the files underneath are untouched), ELOOP on a
        // symlink cycle, ENAMETOOLONG, EIO — means we could not find out, and reporting it
        // as `missing` would propose deleting content that is still there.
        if (code === "ENOENT" || code === "ENOTDIR") {
          return { ref, outcome: "missing", reason: "no such file" };
        }
        return {
          ref, outcome: "failed",
          reason: `could not resolve ${abs} (${code ?? (e instanceof Error ? e.message : String(e))})`,
        };
      }
      // Containment is a byte-exact realpath-vs-realpath prefix test — NOT case- or
      // Unicode-normalisation-folded. On the box (ext4) `/srv/atlas` and `/srv/ATLAS` are
      // genuinely different directories; folding case here would let a symlink to the
      // wrong one read as contained. (Comparing DECLARED paths — e.g. routing on a store
      // prefix — is a different concern and may reasonably normalise; a security guard
      // over real inodes may not.)
      if (real !== rootReal && !real.startsWith(`${rootReal}/`)) {
        return { ref, outcome: "failed", reason: `refusing to escape ${opts.id} store root via a symlink` };
      }

      try {
        return { ref, outcome: "found", content: readFileSync(real, "utf8") };
      } catch (e) {
        // The file EXISTS (realpath succeeded) but we could not read it — a permissions
        // problem, not a deletion.
        return { ref, outcome: "failed", reason: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
