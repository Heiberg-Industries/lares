import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

// Every file that runs an `eve` CLI command. NOTE: `pnpm install` counts — packages/agent-kit's
// own "prepare" script is `eve extension build`, and pnpm runs a workspace package's prepare
// during install. So a Dockerfile's install layer is an eve CLI invocation.
const EVE_CLI_SITES = [
  "services/chief-of-staff/Dockerfile",
  "services/travel/Dockerfile",
  "services/creative/Dockerfile",
  "services/console/Dockerfile",
  ".github/workflows/chief-of-staff-builder.yml",
  ".github/workflows/travel-builder.yml",
  ".github/workflows/creative-builder.yml",
  ".github/workflows/keeper-runtime-images.yml",
  ".github/workflows/console-image.yml",
  "packages/board-evals/scripts/setup-eval-env.sh",
  "packages/board-evals/scripts/all-evals.mjs",
] as const;

describe("nothing phones home: every eve CLI invocation has telemetry disabled", () => {
  for (const site of EVE_CLI_SITES) {
    it(`${site} sets EVE_TELEMETRY_DISABLED`, () => {
      expect(readFileSync(repo(site), "utf8")).toContain("EVE_TELEMETRY_DISABLED");
    });
  }

  it("every Dockerfile that installs agent-kit sets it BEFORE its pnpm install layer", () => {
    for (const df of EVE_CLI_SITES.slice(0, 4)) {
      const lines = readFileSync(repo(df), "utf8").split("\n");
      const env = lines.findIndex((l) => l.includes("EVE_TELEMETRY_DISABLED"));
      const install = lines.findIndex((l) => l.includes("RUN pnpm install"));
      expect(env).toBeGreaterThan(-1);
      expect(install).toBeGreaterThan(-1);
      // agent-kit's `prepare` runs `eve extension build` during install — the variable must
      // already be in the environment by then, not appear later beside `eve build`.
      expect(env).toBeLessThan(install);
    }
  });
});
