/**
 * Telemetry — eve's OpenTelemetry export, pointed at Langfuse.
 *
 * Ported verbatim from services/chief-of-staff/agent/instrumentation.ts (Wave A fix — finding 4:
 * the plan's Tech Stack line requires "Langfuse OTLP (mirror eve-saga's
 * agent/instrumentation.ts verbatim — same gateway, same telemetry contract)"; this file
 * shipped in every other task but was never actually created). Naming only differs — the
 * logic, exporter config, and recordInputs/recordOutputs stance are identical.
 *
 * eve auto-discovers this file and runs `setup` at server startup, before any agent code.
 * Its mere presence enables authored telemetry and REPLACES eve's local on-disk traces, so
 * a broken exporter here means no traces anywhere — which is why the not-configured path
 * below is loud rather than silent.
 *
 * What lands in Langfuse: eve creates an `ai.eve.turn` span per turn, parenting the AI
 * SDK's own model-call and tool-execution spans, with session/turn/step/channel context
 * attached. That is the structure the gateway's own logging cannot give us — it sees
 * isolated completions, not conversations.
 *
 * ALSO the startup hook (ORB-104): this is the one authored module eve runs at server
 * startup, before any agent code, which makes it the place to notice that the previous
 * process died holding a running sweep. The check is best-effort and never blocks boot —
 * an agent that will not start because it could not send a diagnostic DM is worse than one
 * that starts quietly.
 */
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { defineInstrumentation } from "eve/instrumentation";

import { isLangfuseConfigured, langfuseExporterConfig } from "@lares/agent-kit/langfuse-otel";
import { installAttachmentHydration } from "@lares/agent-kit/attachment-hydration";
import { registerAgent } from "@lares/agent-kit/agent-registry";
import { grantedToolNames } from "@lares/agent-kit/catalogue";
import { releaseStaleWorkflowLocks, workflowDatabaseUrl } from "@lares/agent-kit/release-stale-workflow-locks";
import { CATALOGUE } from "../catalogue/index.js";
import { BOOT, thisAgent } from "../lib/definition.js";
import { notifyIfSweepInterrupted } from "../lib/sweep-marker.js";
import { adminChatId, tgSend } from "../lib/sveip-run.js";
import { registerCommandMenus } from "../lib/telegram-commands.js";
import { telegramCredentials } from "../lib/telegram-credentials.js";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";

// LAR-73: before anything else, free the workflow jobs a previous, dead process of this agent left
// locked — otherwise a restart that landed inside a turn leaves that conversation silent for ~14
// minutes. AWAITED AT MODULE LEVEL on purpose, not inside `setup`: eve calls `setup` without
// awaiting it (eve/harness/instrumentation-config.js), whereas the built server evaluates this
// module to the end before it opens its HTTP port, and the workflow job runner is held until that
// port answers (@workflow/world-postgres dist/queue.js). So the unlock is over before this process
// can lock its first job. Bounded to a few seconds and never throws (the module's own header has
// the full argument). Only where a workflow database exists — never at `eve build`.
if (workflowDatabaseUrl()) await releaseStaleWorkflowLocks();

export default defineInstrumentation({
  setup: ({ agentName }) => {
    // ORB-286: files eve does not inline reach the model as text or a plain sentence, not a bare path.
    installAttachmentHydration();
    // ORB-278 step 1: tell the console who this agent is. Only where a database exists (never at `eve build`).
    // ORB-278 step 2: the console must show what this agent IS RUNNING ON, not what its image
    // was built with. That is the resolved DEFINITION — the mounted folder where one exists, the
    // committed declaration where it does not. `BOOT`, not a session id: eve documents
    // instrumentation's `setup` as a non-ALS callback with no session context, and what the
    // agent BOOTED on is genuinely a process-lifetime fact. Passed explicitly so this cannot be
    // confused with a resolver that simply failed to find its session (lib/definition.ts).
    // NEVER allowed to stop the agent (agent-registry.ts's own first line). Two ways it could,
    // both closed here: `thisAgent()` does all of its I/O inside the promise, so a missing role
    // template in the image cannot throw synchronously out of this unguarded `setup()` and skip
    // everything below it; and the `.catch` keeps a rejected resolve — a broken mounted
    // definition with no last-valid row — from becoming an unhandled rejection that Node 24
    // turns into process exit. Registration failing is a console line, never a dead agent.
    if (process.env.DATABASE_URL) {
      void thisAgent(BOOT)
        // ORB-278 step 2, Task 8: his tools are a POOL now, picked from at session start, so the
        // compiled manifest lists the resolver and none of its entries. The console would
        // under-report his toolset unless the granted names are handed over here — computed from
        // the SAME definition that is being registered, by the same function the resolver uses,
        // so the row cannot claim a tool the model was not given.
        .then(({ loaded }) =>
          registerAgent({
            manifest: loaded.definition,
            dynamicTools: grantedToolNames(CATALOGUE, loaded.definition),
          }),
        )
        .catch((err: unknown) => {
          console.error(`[registry] agent not registered: ${err instanceof Error ? err.message : String(err)}`);
        });
    }

    // ORB-104 — announce a sweep that died with the last process. Detached from boot: a
    // rejected promise here must not surface as a startup failure, and the DM must not delay
    // the server accepting its first webhook.
    void notifyIfSweepInterrupted({
      dataRoot: process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel",
      now: () => Date.now(),
      notify: async (text) => {
        await tgSend(adminChatId(), text);
      },
    }).catch((err: unknown) => {
      console.error("[instrumentation] interrupted-sweep check failed —", err);
    });

    // ORB-159 — the "/" command menu, re-registered at every boot so a bot re-registration
    // (2026-08-17: the menu came back empty, hand-restored a week later) can never leave it
    // dead again. Detached and best-effort like the sweep check above: Telegram overwrites on
    // every call, a hiccup logs, and boot never waits for it. `adminChatId()` is resolved
    // inside the chain so a missing env var is a logged line, not a startup failure.
    void Promise.resolve()
      .then(() =>
        registerCommandMenus({ botToken: telegramCredentials.botToken, fetch: telegramFetch, adminChatId: adminChatId() }),
      )
      .then((result) => {
        if (result.ok) console.log("[instrumentation] Telegram command menus registered (groups: info; admin: toolkit)");
        else console.error(`[instrumentation] Telegram command menus NOT registered — ${result.error}`);
      })
      .catch((err: unknown) => {
        console.error("[instrumentation] command-menu registration failed —", err);
      });

    if (!isLangfuseConfigured()) {
      // Deliberately a warning and not a throw: telemetry must never be load-bearing, and
      // an agent that will not boot because its tracing backend is unreachable is worse
      // than one running untraced. But it must be VISIBLE — a silently untraced Marcel
      // would be scored on evidence that was never collected.
      console.warn(
        "[instrumentation] Langfuse key file unreadable — running WITHOUT trace export. " +
          "eve's local on-disk traces are also disabled whenever this file exists.",
      );
      return;
    }

    const { url, headers, httpAgentOptions } = langfuseExporterConfig();
    const sdk = new NodeSDK({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: agentName }),
      // httpAgentOptions carries the squid proxy agent on the box (see lib/langfuse-otel.ts).
      // Omitting it there would not error — the POST would hang against the seal.
      traceExporter: new OTLPTraceExporter({ url, headers, ...(httpAgentOptions ? { httpAgentOptions } : {}) }),
    });
    sdk.start();
    console.log(`[instrumentation] exporting traces to ${url} as "${agentName}"`);
  },

  // Full prompts and completions ride to Langfuse. That is the point — a trace without them
  // cannot answer "did Marcel get this booking-extraction right". Everything Marcel reads is
  // trip data Bendik's own family generated, and Langfuse is the EU region.
  //
  // eve 0.60.1 still honours these two keys on `defineInstrumentation`'s own config — the
  // 0.60.0 removal (`assertNoRemovedContentOptions`, dist/src/tracing/otel-declaration.js)
  // applies only to OTel DESTINATION options (otelIntegration/managedOtelIntegration/
  // agentRunsIntegration, the experimental multi-file `instrumentationProviders` layout,
  // which this file does not use and which no role enables). See
  // chief-of-staff/tests/instrumentation-keys.test.ts for the regression pin.
  recordInputs: true,
  recordOutputs: true,

  // eve 0.44/0.46 made trace CONTENT audience-dependent: without a policy, eve emits every
  // audience but includes content only for conversations it classes "public" (or when
  // `environment === "development"`) — so a private door's traces arrive in Langfuse as
  // metadata with no prompts or completions in them. That is not a failure anybody would
  // notice — the traces still appear, they are just empty of the thing the scorecard
  // compares.
  //
  // A bare `true` return is NOT enough: eve's own `resolveTracePolicyDecision`
  // (dist/src/shared/trace-policy.js) treats boolean `true` as "apply the audience
  // ceiling" — it calls the exact same `shouldCaptureInstrumentationContent` check the
  // no-policy default uses, so `() => true` would be a silent no-op, identical to having no
  // tracePolicy at all. The explicit decision object below is what actually lifts the
  // ceiling for every audience.
  //
  // This says plainly that on this installation every audience's content is exported,
  // because the destination is the owner's own EU Langfuse instance and everything the
  // agent reads is the owner's own material. Revisit this if the agent is ever pointed at
  // someone else's data.
  //
  // Must be deterministic: eve documents that it may be invoked more than once per session.
  tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
});
