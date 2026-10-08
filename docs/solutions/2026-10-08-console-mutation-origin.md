# Require the console origin for browser mutations

## Problem

SameSite=Lax cookies do not prevent a different origin on the same site from submitting an
authenticated request. A browser reproduction against the actual console approved a synthetic
Notion proposal through a text/plain POST even though CORS prevented reading its response.

## Change and configuration

The existing console middleware now requires an exact Origin match for methods other than GET,
HEAD and OPTIONS. The trusted public origin comes from `CONSOLE_OAUTH_REDIRECT`, which the installer
already generates. Host and forwarded headers cannot override it. Missing, opaque (`null`), sibling,
different-port and cross-site origins receive 403. Production without the configured origin returns
503 for mutations. Local development may use the request URL origin.

The configured redirect must use the same public origin users visit. Cookie-authenticated scripts
must supply that Origin in addition to their valid session; Origin is not an authentication token.
The exact Slack/Telegram webhook POST paths retain their existing exception and separate platform
authentication. OAuth GET callbacks, session checks and signed chat capabilities are unchanged.

This adds no dependency, data migration or token store. It addresses request forgery, not private
member isolation. SameSite remains useful as an additional boundary.

## Verification

- 123 tests passed across middleware, auth, chat proxy, door forwarding and account OAuth routes/state.
- Console typecheck and namespace check passed.
- Independent source review: no blockers; reviewer independently reran 27 middleware tests.
- A fresh Chrome profile, temporary copy of the console and synthetic PostgreSQL database reproduced
  the before/after difference: hostile same-site proposal changed before the patch and stayed pending
  after it. Cross-site control stayed pending; same-origin owner/member controls still approved.
  Temporary services were stopped. No installation accounts, provider calls or production changes.

The browser check used local development, not deployed HTTPS/reverse-proxy acceptance. A production
mutation without public-origin configuration intentionally fails closed. Source tests verify the
configured public-origin comparison against an internal container URL and forged forwarded headers.

Run the focused checks:

```sh
pnpm -C services/console exec vitest run tests/middleware.test.ts tests/auth.test.ts tests/chat-proxy.test.ts tests/door-forwarder.test.ts tests/account-oauth-routes.test.ts tests/account-oauth-state.test.ts --maxWorkers=1
pnpm -C services/console run typecheck
node scripts/check-namespace.mjs
```

Keep hostile same-site requests, missing Origin, proxy-host spoofing, legitimate browser actions and
signed webhook paths in the existing security regression checks. No separate checklist is needed.
