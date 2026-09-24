// services/atlas/tests/helpers/fake-writer.ts
// A fake AtlasWriter over an in-memory file map, for tests that exercise a caller of
// AtlasWriter (migrate-okf today; Task 9's tests need the same fake) without shelling out to
// real git. Extracted here rather than defined inline in each test file so the two don't
// drift.
import type { AtlasWriter } from "../../lib/adapters/atlas-writer.js";

export function fakeWriter(
  files: Record<string, string>,
): AtlasWriter & { files: Record<string, string>; commits: string[] } {
  const commits: string[] = [];
  return {
    files,
    commits,
    listNotes: () => Object.keys(files).sort(),
    readNote: (p) => files[p]!,
    writeNotes: async (batch, message) => {
      const changed = batch.filter((f) => files[f.path] !== f.raw);
      for (const f of changed) files[f.path] = f.raw;
      if (changed.length > 0) commits.push(message);
      return { committed: changed.length > 0, pushed: changed.length > 0 };
    },
  };
}
