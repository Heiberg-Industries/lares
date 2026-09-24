# ADR 0013 — Agents name purposes, the gateway maps them to models

**Date:** 2026-09-04
**Status:** Accepted
**Supersedes:** —
**Superseded by:** —

## Context

Every model call in the fleet went through LiteLLM, but through the wrong route. The
`/anthropic/v1` pass-through forwards the model id in the request straight to Anthropic — it
never resolves a LiteLLM `model_group_alias`, so an alias like `heiberg-brain` 404s there. That
forced every service's code and every compose file to carry a real, versioned model id
(`claude-opus-4-8`) as a literal, and it metered spend poorly: the Aug 2026 $250 leak
(`docs/solutions/2026-08-15-api-cost-leak-proposal-retry-loop.md`, memory
`project_api_cost_leak_notion_proposal_loop`) was invisible in LiteLLM's SpendLogs because
passthrough traffic isn't a routed call.

Two prior decisions set the stage. ORB-202 (2026-09-02) split the shared Saga/Calliope gateway
key into one key per (person, agent) — `owner-chief` and `owner-creative` — so their spend and
revocation are scoped to who is calling, not just what model answers; the remaining keys were
renamed to the same `<person>-<agent>` / `<job>` scheme (`owner-travel`, `atlas-sync`, `radar`)
and the old shared `Saga` key deleted as 2026-09-04 housekeeping for this ticket. Orakel had
already proven the alias-key pattern independently
(`orakel-extract`, etc.), before ORB-225 gave the internal fleet the same shape. Separately, the
Lares design brief (`feedback_lares_console_first_and_design_brief`) commits every project to a
console knob for every operational lever — including which model answers which kind of call —
which only works if "which model" is a mapping that can be *read and changed in one place*, not
a value baked into a dozen files.

On 2026-09-04 the router route (`/v1/messages`, Anthropic request format) was verified live from
the box to resolve aliases, and to carry tools, streaming, thinking blocks, `cache_control`, and
non-Anthropic targets (Mistral) correctly — see `project_gateway_purpose_aliases_native_route`
and ORB-225's plan (`docs/superpowers/plans/2026-09-04-orb-225-purpose-aliases.md`). the owner set
the model-group aliases on the gateway the same day: `heiberg-brain` → `claude-opus-5`,
`heiberg-writer` → `claude-fable-5-1`, `heiberg-utility` → `mistral/mistral-small-latest`,
`heiberg-gate` → `mistral/ministral-3b-latest`, `heiberg-embed` → `jina-embeddings-v3`. This
confirms the general direction in `docs/research/2026-06-14-portfolio-model-policy.md` (open
models for the commodity tier, frontier for the differentiated tier) can be expressed as gateway
configuration rather than per-service code, and extends ADR-0009 (the internal fleet's shared
Vercel-AI-SDK/trust-ratchet substrate) with the rule for how that substrate names a model.

## Decision

1. **Five purposes, fleet-wide.** `heiberg-brain` (reflection, ideation, judgment calls —
   Opus-class), `heiberg-writer` (drafts a human will read and send as their own words),
   `heiberg-utility` (classification, filing, routing, everything that doesn't need brain- or
   writer-grade output), `heiberg-gate` (cheap yes/no gatekeeper decisions), `heiberg-embed`
   (embeddings). A sixth purpose is added only when an existing one demonstrably doesn't fit —
   not per new call site.
2. **Alias naming is `<installation>-<purpose>`.** `heiberg-*` for the Heiberg Industries
   installation; a future second installation (if ever) gets its own prefix, never a second
   meaning layered onto `heiberg-*`.
3. **Code and configuration name a purpose, never a raw model id.** `agent.json` `model` fields,
   compose/env model knobs, and every `gatewayComplete`-style call site take an alias (or, for
   eve-saga, a `purpose` string resolved to an alias by `lib/llm-complete.ts`). No default in
   code may be a versioned model id — that was the old failure mode this ADR retires.
4. **Keys carry aliases, not raw model access.** A LiteLLM virtual key's model list names the
   aliases it may call (e.g. `owner-chief`: brain, writer, utility, gate, embed), following the
   pattern Orakel and ORB-202 already established. Revoking or re-scoping a purpose for an agent
   is a key edit, not a code change.
5. **The router route (`/v1/messages`) is the only route.** `/anthropic/v1` pass-through is
   retired fleet-wide; nothing may reintroduce it. `baseURL` is always the bare gateway host with
   `/v1` appended by the SDK's own path construction — never `/anthropic`-suffixed.
6. **Env knobs override the alias for experiments, and take precedence over the code default.**
   `UTILITY_MODEL`, `WRITER_MODEL`, `EVE_SAGA_MODEL`, `STUDIO_MODEL`, `MARCEL_MODEL_BRAIN`,
   `MARCEL_MODEL_GATE`, `ATLAS_DRAFT_MODEL` and equivalents stay as escape hatches — but their
   *values* are expected to be alias names in normal operation, not raw ids. A raw id in one of
   these env vars is a deliberate, temporary experiment, not a standing configuration.

## Consequences

**Positive:**

- **A model swap is a gateway edit.** Moving brain-tier work from Opus 5 to a future model (or
  routing writer-tier to a different vendor) touches the gateway's alias mapping once; no
  service redeploys, no code review of a dozen files with the same literal.
- **Per-purpose cost visibility.** SpendLogs on the router route are real routed calls, keyed by
  the (person, agent) or per-job key, further broken down by which alias — brain vs utility vs
  writer spend is now a query, not a guess (closing the exact blind spot the Aug leak exploited).
- **Lares: the console knob is the mapping.** Once a console surface reads/writes the gateway's
  alias table, "which model handles X" becomes a UI element instead of a grep-and-redeploy — the
  parity gap item this was blocking (`feedback_lares_console_first_and_design_brief`).
- **One code path for every provider.** The router route translates the Anthropic request shape
  for non-Anthropic targets too (Mistral verified live 2026-09-04), so `gateway-provider.ts` lost
  its per-provider branch (the `/anthropic/v1`-vs-OpenAI-compatible split) entirely — less code,
  not just relocated configuration.

**Negative / accepted trade-offs:**

- **An unmapped alias is a silent-until-called failure.** If a purpose is used in code before the
  matching `model_group_alias` exists on the gateway, the call 404s at request time, not at
  deploy time — there is no compile-time or deploy-time check that an alias resolves. Accepted:
  the fleet is small enough that the deploy runbook (verify one real turn per service, Marcel
  first) catches this before it reaches the owner as a `#lares-alerts` message.
- **Opus 5 has thinking on by default**, which the `heiberg-brain` alias now sits on without any
  service-level opt-out. Every brain-tier call pays the thinking-token cost even where a call
  site would have been fine without it. Accepted for now; revisit if a specific brain-tier call
  site's cost profile changes materially — narrowing thinking is a gateway-side or per-call
  parameter change, not a reason to leave the alias.
- **`modelContextWindowTokens: 200_000` stays hard-coded** in `agent.ts` across the fleet even
  though Opus 5 supports 1M — deliberately conservative for compaction behavior, and a separate
  decision to revisit, not bundled into this one.

## Operational rules

- **Do:** adding a purpose = an alias in the gateway's `model_group_alias` config, a grant on
  every key that should reach it, and a `purpose` (or alias) value in the calling code — in that
  order. The alias must resolve before the code ships.
- **Do:** when experimenting with a different model for a purpose, use the env override
  (`UTILITY_MODEL`, etc.) with a raw id for the duration of the experiment, then fold the result
  back into the gateway's alias mapping — never leave a raw id as the standing default.
- **Don't:** ever write `/anthropic/v1` (or `/anthropic`-suffixed `GATEWAY_URL`) into new code,
  compose, or docs. The router route is the only route.
- **Don't:** default any `model` field, compose env var, or SDK call to a versioned model id.
  Absence of a default (a `required()`-style throw, as `ATLAS_DRAFT_MODEL` already does) is
  preferable to a raw-id fallback.

## Open questions

- **Does a sixth purpose ever earn its place, and who decides?** No trigger has appeared yet.
  Resolved when a concrete call site demonstrably doesn't fit brain/writer/utility/gate/embed —
  decide at that point, not speculatively.
- **Should alias resolution be checked at deploy time rather than discovered at first call?**
  Today it's caught by the Task-6 deploy runbook's one-real-turn verification per service.
  Revisit if an unmapped alias ever reaches the owner as a live incident instead of a deploy-time
  catch.

## Cross-references

- `docs/research/2026-06-14-portfolio-model-policy.md` — the standing open-vs-frontier policy
  this ADR expresses as gateway configuration.
- `docs/decisions/0009-internal-agent-fleet-vercel-ai-sdk.md` — the shared fleet substrate this
  ADR names the model-selection convention for.
- `docs/superpowers/plans/2026-09-04-orb-225-purpose-aliases.md` — the implementation plan (kit
  route change, per-service purpose wiring, this compose/ADR task).
