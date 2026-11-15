/** @type {import('next').NextConfig} */
export default {
  output: "standalone",
  reactStrictMode: true,
  experimental: { cpus: 1, serverActions: { bodySizeLimit: "3mb" } },
  outputFileTracingIncludes: {
    "/*": ["../../packages/agent-kit/templates/*/definition.json", "../../packages/agent-kit/templates/*/role.md"],
  },
  // Skip TS type-checking at build time: workspace sibling devDependencies
  // (e.g. @testcontainers/postgresql in agent-box/tests/) are not installed
  // in the production Docker build closure. Type-check runs separately via
  // `pnpm typecheck` in dev.
  typescript: { ignoreBuildErrors: true },
  // These workspace packages ship TypeScript source with NodeNext-style `.js`
  // import specifiers (e.g. oauth-tokens.ts imports "./crypto.js"). Transpile
  // them and resolve `.js` → `.ts` so the build can follow those imports.
  // "eve" is NOT named here: its compiled browser client (eve/react, eve/client, eve/events) holds
  // no `using` declaration any more, so the loader that used to downlevel one is gone, and
  // webpack's ordinary node_modules handling parses the rest of eve's output (private class
  // fields, etc.) without help. tests/downlevel-using-loader.test.ts fails if a framework upgrade
  // brings such a declaration back into what the browser loads.
  transpilePackages: ["@lares/ui", "@lares/agent-box", "@lares/agent-kit", "@lares/notion-sync", "@lares/taste", "@lares/vault-format"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};
