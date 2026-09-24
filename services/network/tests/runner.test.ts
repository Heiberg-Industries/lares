import { describe, it, expect } from "vitest";
import { buildProgram } from "../bin/program.js";

// The Mac-side jobs (network-ingest.sh, push-network-replica.sh) and the network skill call
// these through `pnpm network <sub>`. A missing one fails a launchd job silently at 09:30.
const USED_BY_MAC_JOBS = ["import", "slack-import", "backup", "digest", "brain-notes", "export-replica"];
const USED_BY_SKILL = ["who-at", "dormant", "person", "sql", "merge", "sync-twenty", "push"];

describe("lares network runner", () => {
  it("registers `network` with every subcommand the Mac jobs and the skill use", () => {
    const program = buildProgram();
    const net = program.commands.find((c) => c.name() === "network");
    expect(net).toBeDefined();
    const subs = net!.commands.map((c) => c.name());
    for (const name of [...USED_BY_MAC_JOBS, ...USED_BY_SKILL]) {
      expect(subs, `missing network subcommand "${name}"`).toContain(name);
    }
  });
});
