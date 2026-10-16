// services/atlas/tests/helpers/tick-deps.ts
// A minimal, fully-wired TickDeps builder for apply.test.ts and run.test.ts — extracted so
// the two test files don't grow two independently-driftable ideas of "what a stub TickDeps
// looks like" (the same reason fake-writer.ts was pulled out for Task 9).
//
// Readers and the draft model default to THROWING if actually invoked: a test that only
// exercises apply.ts (which never resolves a source or drafts anything) should never reach
// either, and a silent stub that hands back plausible-looking data would hide a wiring
// mistake instead of failing the test loudly.
import type { Queryable } from "@lares/agent-box";
import type { AtlasWriter } from "../../lib/adapters/atlas-writer.js";
import type { ReaderMap, SourceReader } from "../../lib/resolve.js";
import type { DraftModel } from "../../lib/narrative.js";
import type { TickDeps } from "../../lib/run.js";

function unwiredReader(id: string): SourceReader {
  return {
    id,
    read: async () => { throw new Error(`atlas test: the "${id}" reader was not wired for this test`); },
  };
}

export function stubReaders(): ReaderMap {
  return {
    repo: unwiredReader("repo"),
    vault: unwiredReader("vault"),
    notion: unwiredReader("notion"),
    atlas: unwiredReader("atlas"),
  };
}

export const stubModel: DraftModel = {
  draft: async () => { throw new Error("atlas test: the draft model was not wired for this test"); },
};

export interface TestTickDeps extends TickDeps {
  /** Every message passed to `notify`, in call order. */
  notifications: string[];
  /** Every (message, opts) pair passed to `notify`, in call order — for asserting on
   *  opts.key (Task 15: source-health notices carry `{ key: "source-health" }`). */
  notifyCalls: Array<{ message: string; opts?: { key?: string } }>;
  /** Every message passed to `log`, in call order. */
  logs: string[];
}

export function makeTickDeps(
  db: Queryable, writer: AtlasWriter, over: Partial<TickDeps> = {},
): TestTickDeps {
  const notifications: string[] = [];
  const notifyCalls: Array<{ message: string; opts?: { key?: string } }> = [];
  const logs: string[] = [];
  return {
    db,
    writer,
    readers: stubReaders(),
    model: stubModel,
    today: "2026-08-12",
    now: new Date("2026-08-12T09:00:00Z"),
    notify: async (m: string, opts?: { key?: string }) => {
      notifications.push(m);
      notifyCalls.push({ message: m, opts });
    },
    log: (m: string) => { logs.push(m); },
    ...over,
    notifications,
    notifyCalls,
    logs,
  };
}
