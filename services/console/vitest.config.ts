import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  // Explicit identity for legacy fixtures; never used by Next.js or runtime builds.
  env: { AGENT_OWNER_USER_ID: "bendik" },
} });
