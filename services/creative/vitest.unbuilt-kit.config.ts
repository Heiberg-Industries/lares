// Run the tests that load the real catalogue before the kit has been built (`pnpm exec vitest run --config
// vitest.unbuilt-kit.config.ts <files>`). The catalogue imports two kit entry points that only exist in the kit's
// `dist/`; this points them at the sources instead. Once the kit builds, use the plain `vitest.config.ts` and
// delete this file.
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

const kit = (p: string) => fileURLToPath(new URL(`../../packages/agent-kit/${p}`, import.meta.url));

export default mergeConfig(base, defineConfig({
  resolve: {
    alias: [
      { find: "@lares/agent-kit/note-write-tools", replacement: kit("extension/lib/note-write-tools.ts") },
      { find: "@lares/agent-kit/tools", replacement: kit("tests/helpers/unbuilt-kit-tools.ts") },
    ],
  },
}));
