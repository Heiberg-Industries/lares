# Lares marketing and docs

Separate static Next.js application for https://lares.is. Never part of the self-hosted installer or console. Fumadocs uses the same approach as Orakel, with Lares tokens and local fonts. Content is explicitly curated in `content/docs`; internal repository documents are not auto-published.

From the repository root:

- `pnpm --filter @lares/website... install --frozen-lockfile`
- `pnpm --filter @lares/website build` (also generates the Fumadocs types)
- `pnpm --filter @lares/website typecheck`
- `pnpm exec vitest run services/website/tests/analytics.test.ts --maxWorkers=1`

Output: `services/website/out/`, including the static docs search index.

See `config.example` for build-time settings. Keep the actual public project token in build configuration; private PostHog management credentials never enter this app. Localhost and preview hosts never send analytics, even with consent. Consent is managed by the shared c15t service at consent.heiberg.co, with the Orakel banner design themed for Lares. The SDK loads only after a saved Analytics choice on lares.is or www.lares.is. Replay, automatic capture and user identification are off. A strict property allowlist drops arbitrary fields and URL queries.

The booking button loads the same `/embed.js` popup used by heiberg.co, from `booking.lares.is`, with appointment `walkthrough`. The shared provider keeps its trigger mounted across docs navigation. Until enabled, a contact fallback explains that booking is not yet available. No live booking is created by local tests.

Build the Dockerfile in CI, then deploy the resulting digest through Coolify on port 8080. Do not build on the production box. The runtime serves static files and needs no application database or model-provider credentials. Neither image publication nor deployment has been performed for this change.

Launch and booking dependencies: `docs/marketing/analytics-and-launch.md`.
