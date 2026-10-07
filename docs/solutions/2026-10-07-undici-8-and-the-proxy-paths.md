# undici 8 kept the Slack router but stopped tunnelling http:// (LAR-69 batch 10)

**Problem.** Every sealed agent reaches Slack, Telegram, Google and Notion only through the squid
egress proxy, and a call that skips it hangs against the firewall instead of failing. undici 8
reworked the two plug-in points our proxy routing depends on: the global-dispatcher slot (which
Node's built-in `fetch` reads) and the handler interface a custom `Dispatcher` receives. A
mistake in either would show up on the box as silent Slack or Telegram hangs, never as a test
failure.

**What was checked, and how.** Node's built-in `fetch` runs on the undici copy bundled *inside*
Node (7.16 on Node 24.9), not on the one in `node_modules`, so the question was whether a
dispatcher installed with undici 8's `setGlobalDispatcher` still reaches it. A throwaway script
with a tiny CONNECT proxy on 127.0.0.1 answered it in a minute: it does, and Slack calls carry
through `ProxyAgent` while other traffic goes direct. That script became the committed probe
`packages/agent-kit/tests/live/slack-dispatcher.live.mts`, which also runs inside an agent
container against the real squid (`SLACK_PROXY_URL`).

**What did change.** undici 8's `ProxyAgent` only opens a CONNECT tunnel for `https://` targets.
An `http://` target is sent as a plain forward-proxy request (`GET http://host/...` to the proxy)
unless `proxyTunnel: true` is set. `tests/telegram-fetch.test.ts` caught it: its proxy only
answers CONNECT, so the http:// case hung until the test timed out. `telegram-fetch.ts`, the
shared egress fetch, now sets `proxyTunnel: true`. Every proxied production target is
`https://`, so nothing on a server was affected, but a future `http://` caller now keeps squid's
CONNECT shape.

**Two overrides that looked removable were not.** The plan expected to drop both `undici` pnpm
overrides. Without them eve's exact `undici 8.9.0` and a transitive 7.29.0 came back, both below
patched floors. Check `pnpm why <pkg>` after removing an override, before trusting the plan.

**Related, batch 13.** The `braces` alert was expected to clear with vite 8. It did not: it came
through `sass` 1.77.4, which no package declares. pnpm installs it to satisfy optional peers of
`next` and `vite`, and its `chokidar` 3 holds `braces`, which has no patched release. A
`sass@<1.79.0` override lifts it to a version on `chokidar` 5. `pnpm audit --json` shows the full
path (`.advisories[].findings[].paths`) and names the real holder; `pnpm why` on the top-level
package does not.

**Lesson.** For a library that sits under Node's own `fetch`, test the built-in `fetch` path
itself through a real local proxy. A unit test of the routing decision cannot see whether the
router is installed. And read a major's proxy behaviour for both `http://` and `https://`.
