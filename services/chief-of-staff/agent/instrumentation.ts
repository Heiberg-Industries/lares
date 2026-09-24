/**
 * Telemetry (Task 11) — eve's OpenTelemetry export, pointed at Langfuse.
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
 */
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { defineInstrumentation } from "eve/instrumentation";

import { isLangfuseConfigured, langfuseExporterConfig } from "@lares/agent-kit/langfuse-otel";
import { registerApprovalSummary } from "@lares/agent-kit/approval-summary";
import { installAttachmentHydration } from "@lares/agent-kit/attachment-hydration";
import { registerAgent } from "@lares/agent-kit/agent-registry";
import { grantedToolNames } from "@lares/agent-kit/catalogue";
import { releaseStaleWorkflowLocks, workflowDatabaseUrl } from "@lares/agent-kit/release-stale-workflow-locks";
import { CATALOGUE } from "../catalogue/index.js";
import { BOOT, thisAgent } from "../lib/definition.js";
import { ownerTzSync } from "../lib/owner-clock.js";

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
    // BEFORE the Langfuse branch below, deliberately: that branch returns early when the
    // key file is unreadable, and a missing telemetry secret must not also cost us
    // readable approval cards. The two have nothing to do with each other beyond both
    // needing a startup hook, and eve gives us exactly one (ORB-121).
    // The owner clock rides in, so a date on a card is on the SAME clock as the date in the turn's
    // own clock block (ORB-193 final review). Synchronous by necessity — eve renders a card inline.
    registerApprovalSummary({ tz: ownerTzSync });
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

    if (!isLangfuseConfigured()) {
      // Deliberately a warning and not a throw: telemetry must never be load-bearing, and
      // an agent that will not boot because its tracing backend is unreachable is worse
      // than one running untraced. But it must be VISIBLE — a silently untraced shadow
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

  // Full prompts and completions ride to Langfuse. That is the point — the scorecard
  // compares ANSWERS, and a trace without them cannot settle "is she as good as the old
  // Saga". Everything she reads is Bendik's own (Brain, Atlas) and Langfuse is the EU
  // region; revisit both if the shadow is ever pointed at someone else's data.
  //
  // eve 0.60.1 still honours these two keys on `defineInstrumentation`'s own config — the
  // 0.60.0 removal (`assertNoRemovedContentOptions`, dist/src/tracing/otel-declaration.js)
  // applies only to OTel DESTINATION options (otelIntegration/managedOtelIntegration/
  // agentRunsIntegration, the experimental multi-file `instrumentationProviders` layout,
  // which this file does not use and which no role enables). See
  // tests/instrumentation-keys.test.ts for the regression pin.
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
  // agent reads is the owner's own material. Revisit this if the shadow is ever pointed at
  // someone else's data.
  //
  // Must be deterministic: eve documents that it may be invoked more than once per session.
  tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
});
