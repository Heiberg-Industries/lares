# ADR 0016 — The fleet runs on eve, self-hosted, and carries three standing costs knowingly

**Date:** 2026-09-15 (records a decision taken 2026-08-11 and live since 2026-08-16)
**Status:** Accepted
**Supersedes:** ADR-0009 (the runtime choice — Vercel AI SDK direct)
**Superseded by:** —

## Context

ADR-0009 (2026-06-20) chose the Vercel AI SDK, run directly inside our own box, as the fleet's
runtime. On 2026-08-11 the consolidation spec
(`../superpowers/specs/2026-08-11-eve-fleet-consolidation.md`) chose **eve** — Vercel's open-source
agent framework, built on that same SDK — and the fleet moved: Saga first (shadow 2026-08-11,
cutover 2026-08-16), Marcel (2026-08-16), Calliope (2026-08-24), and the old
`services/agent-runtime` decommissioned 2026-08-31 (ORB-72), archived 2026-09-15. The decision was
scored (`../superpowers/plans/2026-08-11-eve-saga-scorecard.md`) and written into HANDOFF, but no ADR
recorded it. The 2026-09-15 Lares audit (finding B3) found ADR-0009 still standing as the decision of
record for a runtime nothing runs on. This ADR closes that gap; it records, it does not re-decide.

The 2026-06-17 evaluation had rejected Vercel **Eve** for sovereignty reasons. What was rejected was the
managed runtime. eve self-hosted on our Hetzner box, calling models only through the self-hosted LiteLLM
gateway, keeps every byte in the EU; that is the form adopted.

## Decision

1. **Every Lares agent runs on eve, self-hosted, on the installation's own box.** Models go through the
   gateway by purpose alias (ADR-0013); the model is a string and stays swappable. Model-agnosticism
   remains the vision; the separately managed development runner remains the one exception.
2. **eve is pinned and patched, never tracked loosely.** The engine pins one eve version (the 0.32 line
   today) and carries `patches/eve.patch` in `Heiberg-Industries/lares`. A version bump is a ticket that
   re-inspects the three standing costs below before it deploys.
3. **Three standing costs are accepted, not litigated per deploy** (from the scorecard, verified live):
   - **F1 — restart recovery is defective upstream.** A bare restart mid-turn costs ~15 minutes; the
     wrapper (`eve-saga-restart.sh`, runbook `../runbooks/eve-saga.md`) costs 26 seconds. We own the
     wrapper and the discipline to use it.
   - **F2 — eve's Slack channel is webhook-only and needs public inbound; the box has none by design**
     (ADR-0011). The slack-relay on ops-1 plus its Kuma monitor are permanent operating surface. In a
     Lares install the installer spec places the relay on the one box.
   - **F3 — eve's default harness is open** (shell, file tools, no approval). Every agent's harness is
     narrowed on adoption and the box's sealed egress is non-negotiable in Lares; a rollback to a
     pre-fence image un-fences the tools, so the fence is checked, not assumed.
4. **Since 2026-09-15 eve's job is narrower than "one image per agent".** ADR-0015 makes an agent a
   definition resolved at runtime on one general image; eve's dynamic capabilities (`defineDynamic`)
   are the mechanism. Nothing in this ADR depends on the per-agent images the split spec's Part 3
   described.

## Consequences

- ADR-0009's Decision 3 (AI SDK direct, self-hosted Inngest / pg-boss as the fleet's durability spine)
  is superseded. What runs an agent's turns and schedules is eve's own durable sessions and schedules
  (an eve session is one chat-day; a schedule resumes the live session). Anything else on the box that
  still uses pg-boss is a fact of the box compose, not of this decision.
- ADR-0009's Decisions 1–2 (a per-capability trust ratchet, one governance module above the model
  layer) survive as ADR-0015 and the permissions board (ORB-278 step 1). The ratchet is being built there,
  not in a framework-neutral module of our own.
- The costs in 3 are the reason the release process (ORB-269) treats an eve bump as a release, and the
  reason `patches/eve.patch` must be copied into every image (`docs/solutions` — pnpm patches).

## Cross-references

- `../superpowers/specs/2026-08-11-eve-fleet-consolidation.md` — the decision as taken.
- `../superpowers/plans/2026-08-11-eve-saga-scorecard.md` — the scorecard; §F1–F3 and "standing costs".
- `../superpowers/plans/2026-08-14-eve-cutover-wave1.md`, `2026-08-16-eve-marcel-wave.md`,
  `2026-08-19-eve-calliope-port.md` — the cutovers.
- `../research/2026-06-17-vercel-eve-evaluation.md` — the managed-runtime rejection this does not reverse.
- ADR-0011 (public ingress), ADR-0013 (purpose aliases), ADR-0015 (agents are definitions).
