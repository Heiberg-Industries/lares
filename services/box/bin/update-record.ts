// services/box/bin/update-record.ts — the one place ops/update.sh and ops/rollback.sh reach this
// package's own TypeScript: the release rules (lib/release-manifest.ts) and the update record
// (lib/update-history.ts) are engine code, so neither script restates them in shell.
//
// Usage: update-record.ts <operation> [arguments...]
//   release <file>                          read a release file; prints tab-separated lines
//   previous-release                        the release of the newest update that finished ok
//   begin <from> <to> <images-json> <snap>  write down what is running; prints the new id
//   finish <id> <outcome> [detail]          close that record
//   previous-images                         the newest record and the images to put back
//
// It runs either on a host with this package's dependencies (`node`, the checkout mode) or in a
// container of the engine image (`tsx`). Because the host form is plain `node`, the libraries are
// imported by their real `.ts` file names, relative to this file, and only when an operation
// needs them: reading a release file never loads the database driver.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [op, ...rest] = process.argv.slice(2);
const lib = (name: string) =>
  import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", name)).href);

async function main(): Promise<void> {
  if (op === "release") {
    const { parseReleaseManifest } = await lib("release-manifest.ts");
    const manifest = parseReleaseManifest(readFileSync(rest[0]!, "utf8"));
    let out = "release\t" + manifest.release + "\n";
    for (const service of Object.keys(manifest.images)) {
      out += "image\t" + service + "\t" + manifest.images[service] + "\n";
    }
    for (const sentence of manifest.breaking) out += "breaking\t" + sentence + "\n";
    process.stdout.write(out);
    return;
  }
  const { poolFromEnv } = await lib("db.ts");
  const history = await lib("update-history.ts");
  const pool = poolFromEnv();
  try {
    if (op === "previous-release") {
      const rows = await history.recentUpdates(pool);
      const last = rows.find((row: { outcome: string }) => row.outcome === "ok");
      process.stdout.write((last ? last.toRelease : "") + "\n");
    } else if (op === "begin") {
      const id = await history.beginUpdate(pool, {
        fromRelease: rest[0] === "" ? null : rest[0],
        toRelease: rest[1],
        images: JSON.parse(rest[2]!),
        snapshotId: rest[3] === "" ? null : rest[3],
      });
      process.stdout.write(String(id) + "\n");
    } else if (op === "finish") {
      await history.finishUpdate(
        pool,
        Number(rest[0]),
        rest[1],
        rest[2] === undefined || rest[2] === "" ? undefined : rest[2],
      );
    } else if (op === "previous-images") {
      // Exactly one record: the newest. Going further back is not an option a rollback has.
      const [last] = await history.recentUpdates(pool, 1);
      if (!last) return; // nothing written down — the caller refuses
      // previousImages() is the module's own answer to "what was running before the newest
      // update that finished ok". When the newest record IS that update, it is the source. An
      // update that failed after switching is the other case a rollback exists for, and its
      // own row holds the same map.
      const images = last.outcome === "ok" ? await history.previousImages(pool) : last.images;
      let out =
        ["record", String(last.id), last.outcome, last.toRelease, last.snapshotId ?? ""].join("\t") + "\n";
      for (const service of Object.keys(images ?? {})) {
        out += ["image", service, (images as Record<string, string>)[service]].join("\t") + "\n";
      }
      process.stdout.write(out);
    } else {
      throw new Error("update-record: unknown operation '" + String(op) + "'");
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exit(1);
});
