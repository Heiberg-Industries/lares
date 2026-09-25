import { fileURLToPath } from "node:url";

// W8B-s3 — see services/console/build/downlevel-using-loader.cjs's header for why this exists,
// and delete both when it says to.
const downlevelUsingLoader = fileURLToPath(new URL("./build/downlevel-using-loader.cjs", import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  output: "standalone",
  reactStrictMode: true,
  experimental: { cpus: 1 },
  outputFileTracingIncludes: {
    "/*": ["../../packages/agent-kit/templates/*/definition.json"],
  },
  // Skip TS type-checking at build time: workspace sibling devDependencies
  // (e.g. @testcontainers/postgresql in agent-box/tests/) are not installed
  // in the production Docker build closure. Type-check runs separately via
  // `pnpm typecheck` in dev.
  typescript: { ignoreBuildErrors: true },
  // These workspace packages ship TypeScript source with NodeNext-style `.js`
  // import specifiers (e.g. oauth-tokens.ts imports "./crypto.js"). Transpile
  // them and resolve `.js` → `.ts` so the build can follow those imports.
  // "eve" is NOT named here: once the `using` declaration in its compiled client is downleveled
  // by the webpack rule below (before anything else sees the file), webpack's ordinary node_modules
  // handling parses the rest of eve's output (private class fields, etc.) without help — adding it
  // to transpilePackages was tried and is not needed once that rule is in place.
  transpilePackages: ["@lares/ui", "@lares/agent-box", "@lares/agent-kit", "@lares/notion-sync", "@lares/taste", "@lares/vault-format"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    // Runs BEFORE Next's own SWC loader (enforce: "pre"), and only on eve's compiled client
    // files — see build/downlevel-using-loader.cjs's header.
    config.module.rules.unshift({
      test: /\.js$/,
      include: /[\\/]node_modules[\\/](\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?eve[\\/]dist[\\/]/,
      enforce: "pre",
      use: [downlevelUsingLoader],
    });
    return config;
  },
};
