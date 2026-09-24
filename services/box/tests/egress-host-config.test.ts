import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

describe("legacy egress refresher configuration", () => {
  for (const [label, content] of [
    ["missing", null], ["empty", " # comment\n"],
    ["URL instead of hostname", "https://example.com\n"],
    ["multiple hosts on one line", "a.example b.example\n"],
  ] as const) {
    it(`rejects ${label} before calling DNS or firewall tools`, () => {
      const dir = mkdtempSync(join(tmpdir(), "egress-config-"));
      try {
        const marker = join(dir, "called");
        const file = join(dir, "hosts");
        if (content !== null) writeFileSync(file, content);
        for (const tool of ["nft", "getent"]) {
          writeFileSync(join(dir, tool), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
        }
        const result = spawnSync("bash", [resolve(import.meta.dirname, "../ops/refresh-egress-allowlist.sh")], {
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LARES_EGRESS_HOSTS_FILE: file },
          encoding: "utf8",
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/egress-allowlist:/);
        expect(existsSync(marker)).toBe(false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
