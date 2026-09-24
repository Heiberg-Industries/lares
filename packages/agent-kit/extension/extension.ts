// The @lares/agent-kit eve extension (ORB-143). Each capability gets its own optional key
// so a consumer that mounts the package but doesn't use a given capability — e.g. eve-marcel
// overriding away every tool this extension contributes (Task 3) — is never forced to supply
// config for a capability it never calls.
import { defineExtension } from "eve/extension";
import { z } from "zod";
import type { Pool } from "pg";

export default defineExtension({
  config: z.object({
    signals: z
      .object({
        tokenFile: z.string().default("/run/secrets/signal-read-token"),
        baseUrl: z.string().optional(),
        fetch: z.custom<typeof fetch>((v) => typeof v === "function"),
      })
      .optional(),
    orakel: z
      .object({
        keyFile: z.string().default("/run/secrets/orakel-key"),
        // Absent ⇒ OrakelUnavailableError at call time, same as the old client's unset
        // ORAKEL_URL — unchanged behaviour, just resolved through config instead of env.
        baseUrl: z.string().optional(),
      })
      .optional(),
    // ORB-143 Task 2. Deliberately NOT a "vaultPath" field here, despite the task brief's
    // draft schema: `vault_write`/`vault_file`/`vault_drop` resolve the vault root via
    // `storeRootForArea(area)` (@lares/agent-kit/notes-store), which reads VAULT_PATH from
    // process.env directly — unchanged, and shared with Atlas's identical ATLAS_PATH
    // mechanism, which stays unmounted and can never read extension config. Adding a
    // parallel, unused `vaultPath` config field here would be dead configuration with no
    // consumer. `isApprovedPrincipal` is the only thing that genuinely needs to cross the
    // extension boundary: it's the seam that lets the extension's gated tools re-check WHO
    // approved without importing eve-saga's `lib/principals.ts`/`lib/approvals.ts` (a
    // deliberate least-privilege boundary — see extension/lib/approval-gate.ts).
    brain: z
      .object({
        isApprovedPrincipal: z.custom<(authenticator: string | undefined, userId: string | undefined) => boolean>(
          (v) => typeof v === "function",
        ),
      })
      .optional(),
    // ORB-168, `transit_plan`. Optional for the same reason the two keys above are: eve-calliope
    // grants no `transit`, so her mount resolves the tool to a disable sentinel and must never be
    // forced to supply config for a capability she cannot call.
    //
    // `clientName` is an OVERRIDE, not a default restated here. Entur needs no API key, only an
    // `ET-Client-Name` identification header, and its value ("lares") is defined in
    // exactly one place — `../src/entur-client.ts`'s `DEFAULT_CLIENT_NAME`. A `.default()` on
    // this field would be a second copy of that literal, free to drift from the one the
    // non-extension callers (Task 3's eve-marcel path) get. So: absent ⇒ the client's own
    // default, present ⇒ this wins.
    // ORB-189, `market_edge` — the `markets` capability behind the `market-edge` code skill.
    // Optional like every key above: only an agent that grants `markets` supplies it, and a
    // mount that grants the skill but forgets this gets an `unavailable` card back rather than
    // a crash in a live turn (see extension/tools/market_edge.ts).
    //
    // TWO RUNTIME OBJECTS CROSS THE BOUNDARY, both by `z.custom` because neither is data:
    //
    //   `fetch` — MUST be `createTelegramFetch()` at the mount site. Both agents that could
    //     grant this are network-SEALED and reach api.elections.kalshi.com, clob.polymarket.com
    //     and gamma-api.polymarket.com only through the shared squid proxy, which Node's
    //     built-in fetch ignores outright (../src/telegram-fetch.ts's header records the full
    //     lesson). A default here would be the wrong one, so there is none: the client refuses
    //     to build without an injected fetch, which is why this field is required rather than
    //     optional (Task 1 review).
    //   `pool` — a GETTER, `() => getPool()`, not a live `Pool`. The mount file is a module
    //     `eve build` evaluates, and `getPool()` (@lares/agent-kit/db) THROWS when DATABASE_URL
    //     is unset — which is exactly the build's environment: no secrets, no Postgres. A live
    //     pool in this field would therefore fail the docker build of any agent that grants
    //     `markets`, and would open a database connection during a build if it ever succeeded.
    //     So the pool is deferred to the tool's first call (extension/tools/market_edge.ts
    //     calls `cfg.pool()` inside its own try/catch, where a throw becomes an `unavailable`
    //     card rather than an exception). Validated as a function: what it returns is checked
    //     by `makeMarkets`'s own type, and a test double must be able to cross this seam.
    //
    // The three base URLs, the cache TTL and the request timeout are OVERRIDES, not defaults
    // restated here — each has exactly one home in ../src/markets/*-client.ts and live-quotes.ts,
    // and a `.default()` on this side would be a second copy free to drift from it.
    markets: z
      .object({
        fetch: z.custom<typeof fetch>((v) => typeof v === "function"),
        pool: z.custom<() => Pool>((v) => typeof v === "function"),
        kalshiBase: z.string().optional(),
        polymarketClobBase: z.string().optional(),
        polymarketGammaBase: z.string().optional(),
        liveQuoteTtlMs: z.number().int().positive().optional(),
        // Same override-not-default reasoning: the per-request bound lives once in each of
        // ../src/markets/{kalshi,polymarket-clob,polymarket-gamma}-client.ts as
        // DEFAULT_TIMEOUT_MS, and this key only raises or lowers it for a mount that needs to.
        requestTimeoutMs: z.number().int().positive().optional(),
      })
      .optional(),
    transit: z
      .object({
        clientName: z.string().optional(),
        // Same override-not-default reasoning as `clientName`: the per-request bound lives once
        // in `../src/entur-client.ts`'s `DEFAULT_TIMEOUT_MS`, and this key only raises or lowers
        // it for a mount that needs to.
        timeoutMs: z.number().int().positive().optional(),
      })
      .optional(),
  }),
});
