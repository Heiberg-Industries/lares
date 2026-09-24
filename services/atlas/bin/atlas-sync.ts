#!/usr/bin/env tsx
/**
 * bin/atlas-sync.ts — the container entrypoint, and the only place the Atlas sync job's
 * operator modes can be run. The box has no lares checkout and the shared image ships THIS
 * package, so every mode the runbook names must appear here or it is un-runnable where the
 * store, the database and the tokens actually are.
 *
 *   tsx bin/atlas-sync.ts --once              → one tick now (bypasses ATLAS_SYNC_LIVE)
 *   tsx bin/atlas-sync.ts --migrate-okf       → the one-shot OKF migration (idempotent)
 *   tsx bin/atlas-sync.ts --check-okf         → conformance report, writes nothing
 *   tsx bin/atlas-sync.ts --doctor            → probe all four stores + the gateway, write nothing
 *   tsx bin/atlas-sync.ts --list              → open proposals
 *   tsx bin/atlas-sync.ts --approve <id>      → record the 👍 (the write happens next tick)
 *   tsx bin/atlas-sync.ts --reject <id>       → record the 👎
 *   ATLAS_SYNC_LIVE=1 tsx bin/atlas-sync.ts   → daemon, a tick every ATLAS_SYNC_TICK_MS
 *
 * THE ORDER OF THE ROOT IS LOAD-BEARING: config → readers → assertReaderWiring →
 * probeLocalStores → writer → model → deps. Both guards run BEFORE the first tick and
 * before the daemon's interval is armed, so a mis-wired deploy crash-loops loudly instead of
 * quietly deriving every note from the wrong store.
 *
 * Why a daemon and not a timer: the agent box has no cron container. Every scheduled job
 * there ticks in-process under `restart: unless-stopped`, so this matches its neighbours'
 * containment rather than running as a bare root process on the host.
 *
 * Runbook: docs/runbooks/atlas-sync.md
 */
import { poolFromEnv } from "@lares/agent-box";
import { makeNotionClient } from "@lares/notion-sync/lib/adapters/notion-client.js";
import { MIN_NOTION_VERSION } from "@lares/notion-sync";
import { readConfig, readSpineToken, assertReaderWiring, probeLocalStores } from "../lib/config.js";
import { parseArgs, buildReaders, listProposals, decideProposal, checkOkf } from "../lib/cli.js";
import { makeAtlasWriter } from "../lib/adapters/atlas-writer.js";
import { makeGatewayDraftModel } from "../lib/adapters/draft-model.js";
import { makeSignalNotify } from "../lib/adapters/signal-notify.js";
import { migrateOkf } from "../lib/migrate-okf.js";
import { runTick, type TickDeps } from "../lib/run.js";

const args = parseArgs(process.argv.slice(2));
const config = readConfig(process.env);
const log = (s: string): void => console.log(s);

/**
 * Posts to the signal spine when it is configured and degrades to the log when it is not.
 * See lib/adapters/signal-notify.ts for the wire format and the deploy-ahead-of-env posture
 * (notion-sync's own adapter is the prior art for the same move).
 */
const spineUrl = process.env["SIGNAL_SPINE_URL"];
// SIGNAL_SPINE_TOKEN_FILE preferred since ORB-178 (the box mounts it as a Docker secret);
// the plain env var stays supported until the box's .env line is retired.
const spineToken = readSpineToken(process.env);
const notify = makeSignalNotify({ url: spineUrl, token: spineToken });

/**
 * The proxy-aware fetch the two REMOTE readers must use.
 *
 * This container is CONTAINED (its address is in the saga_egress set), so its only route to
 * api.github.com and api.notion.com is a CONNECT tunnel through slack-proxy — both rotate
 * IPs, which is why they are allow-listed by domain rather than by address. Node's built-in
 * fetch ignores proxy environment variables entirely, so setting EGRESS_PROXY_URL without
 * this function reaches nothing: every repo: and notion: source resolves `failed`, and the
 * store simply stops refreshing. Caught by `--doctor` on the first deploy, 2026-08-12.
 *
 * Deliberately NOT applied to the model gateway. That is a stable address the firewall
 * allows directly, and squid's allow-list does not include it — routing it through the proxy
 * would break the one remote call that currently works.
 */
const proxyUrl = process.env["EGRESS_PROXY_URL"];
const proxiedFetch: typeof fetch = await (async () => {
  if (proxyUrl === undefined || proxyUrl.trim() === "") return fetch;
  const { fetch: undiciFetch, ProxyAgent } = await import("undici");
  const dispatcher = new ProxyAgent(proxyUrl);
  log(`atlas: remote sources tunnel through ${proxyUrl}`);
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    undiciFetch(input as never, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
})();

const notion = makeNotionClient({
  token: config.notionToken, version: MIN_NOTION_VERSION, fetchImpl: proxiedFetch,
});
const readers = buildReaders(config, {
  getPageMarkdown: notion.getPageMarkdown, fetch: proxiedFetch,
});

// The two guards, before anything reads or writes a store.
assertReaderWiring(readers);
await probeLocalStores(readers);

const writer = makeAtlasWriter({ atlasPath: config.atlasPath });

// Only the modes that touch the proposal queue open a pool. A read-only report or a
// store-only migration must not fail because Postgres is down.
const DB_MODES: ReadonlySet<string> = new Set(["once", "daemon", "list", "approve", "reject"]);
const pool = DB_MODES.has(args.mode) ? poolFromEnv() : null;

function tickDeps(): TickDeps {
  const now = new Date();
  return {
    db: pool!,
    writer,
    readers,
    model: makeGatewayDraftModel({
      url: config.gatewayUrl, apiKey: config.gatewayKey, model: config.draftModel,
    }),
    // Pinned once per tick rather than read at each use, so a tick that straddles midnight
    // cannot stamp two different dates into one batch.
    today: now.toISOString().slice(0, 10),
    now,
    notify,
    log,
  };
}

try {
  switch (args.mode) {
    case "check-okf": {
      const { findings } = checkOkf(writer, log);
      process.exitCode = findings === 0 ? 0 : 1;
      break;
    }

    case "doctor": {
      if (!process.env.LARES_ATLAS_PROBE_CODEBASE?.trim() || !process.env.LARES_ATLAS_PROBE_NOTION_PAGE?.trim()) {
        throw new Error("doctor requires LARES_ATLAS_PROBE_CODEBASE and LARES_ATLAS_PROBE_NOTION_PAGE");
      }
      // The local stores are already proven above; this adds the two remote ones and the
      // gateway, which is why it is a mode rather than part of startup — a transient GitHub
      // outage must not stop the daemon from booting and applying decisions already made.
      log("atlas: local stores OK (SCHEMA.md and index.md both answered).");
      for (const [prefix, ref] of [
        ["repo", { prefix: "repo" as const, locator: "README.md", declared: "repo:README.md", codebase: process.env.LARES_ATLAS_PROBE_CODEBASE ?? "" }],
        ["notion", { prefix: "notion" as const, locator: process.env.LARES_ATLAS_PROBE_NOTION_PAGE ?? "", declared: "notion:operator-configured-probe" }],
      ] as const) {
        const r = await readers[prefix as "repo" | "notion"].read(ref);
        log(`atlas: ${prefix}: ${r.outcome}${r.reason === undefined ? "" : ` — ${r.reason}`}`);
        if (r.outcome !== "found") process.exitCode = 1;
      }
      const probe = await makeGatewayDraftModel({
        url: config.gatewayUrl, apiKey: config.gatewayKey, model: config.draftModel,
      }).draft({
        brand: "doctor",
        currentBody: "## What it is\n\nA connectivity probe.\n",
        sources: [{
          ref: { prefix: "atlas", locator: "SCHEMA.md", declared: "atlas:SCHEMA.md" },
          outcome: "found",
          content: "A connectivity probe. Reply with anything.",
        }],
      }).then(() => "ok").catch((e: unknown) => `FAILED — ${e instanceof Error ? e.message : String(e)}`);
      log(`atlas: gateway (${config.draftModel}): ${probe}`);
      if (probe !== "ok") process.exitCode = 1;
      break;
    }

    case "migrate-okf": {
      const res = await migrateOkf(writer, new Date().toISOString().slice(0, 10));
      log(`atlas: OKF migration — ${res.changed.length} note(s) updated: ${res.changed.join(", ") || "(none)"}`);
      break;
    }

    case "list":
      await listProposals(pool!, log);
      break;

    case "approve":
    case "reject":
      await decideProposal(pool!, args.id!, args.mode, log);
      break;

    case "once": {
      const summary = await runTick(tickDeps());
      log(JSON.stringify(summary, null, 2));
      break;
    }

    case "daemon": {
      if (!config.live) {
        log(
          "atlas: ATLAS_SYNC_LIVE is not 1 — not starting the daemon. Use --once for a manual " +
          "tick. Idling so the container stays up for operator commands.",
        );
        // PARK, do not exit. `restart: unless-stopped` treats a clean exit as a reason to
        // restart, so returning here produces an endless restart loop that buries the box's
        // logs — and worse, makes `docker compose exec` a race against the next restart,
        // which is how every operator command in the runbook is run. Observed on the first
        // deploy, 2026-08-12.
        //
        // Parking is an idle TIMER, not `await new Promise(() => {})`. That was the second
        // attempt and it fails in a way worth recording: Node detects a top-level await that
        // can never settle, calls it a deadlock, and exits with code 13 — straight back into
        // the restart loop, now with a warning that reads like the fix is working. A live
        // timer handle keeps the event loop non-empty without any pending await, so the
        // process simply stays up until it is stopped.
        setInterval(() => {}, 1 << 30);
        break;
      }
      log(`atlas: daemon starting — a tick every ${config.tickMs}ms.`);
      // First tick immediately, then on the interval: a restarted container should not wait
      // a full day before it applies a decision Bendik already made.
      const tick = async (): Promise<void> => {
        try {
          await runTick(tickDeps());
        } catch (e) {
          // One bad tick must not kill the daemon — the next one may well succeed, and a
          // dead container stops applying approvals too.
          console.error(`atlas: tick failed — ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        }
      };
      await tick();
      setInterval(() => { void tick(); }, config.tickMs);
      break;
    }
  }
} finally {
  // The daemon keeps its pool for the life of the process; every other mode is done with it.
  if (pool !== null && args.mode !== "daemon") await pool.end();
}
