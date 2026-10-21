# ADR 0016 — The fleet runs on eve, self-hosted, and carries three standing costs knowingly

**Date:** 2026-09-15
**Status:** Accepted
**Supersedes:** the earlier runtime choice (Vercel AI SDK run directly inside the box; the record is not part of this repository)
**Superseded by:** —

## Context

The fleet's first runtime was the Vercel AI SDK, run directly inside the box. A later
consolidation chose **eve** — Vercel's open-source agent framework, built on that same SDK — and
every agent moved to it; the old standalone agent-runtime service was decommissioned and archived.
This ADR records that decision; it does not re-decide it.

An earlier evaluation had rejected Vercel **Eve** for sovereignty reasons. What was rejected was the
managed runtime. eve self-hosted on the installation's own box, calling models only through the self-hosted LiteLLM
gateway, keeps every byte in the EU; that is the form adopted.

## Decision

1. **Every Lares agent runs on eve, self-hosted, on the installation's own box.** Models go through the
   gateway by purpose alias (ADR-0013); the model is a string and stays swappable. Model-agnosticism
   remains the vision; the separately managed development runner remains the one exception.
2. **eve is pinned and patched, never tracked loosely.** The engine pins one eve version (the 0.32 line
   today) and carries `patches/eve.patch` in this repository. A version bump is a ticket that
   re-inspects the three standing costs below before it deploys.
3. **Three standing costs are accepted, not litigated per deploy** (verified live):
   - **F1 — restart recovery is defective upstream.** A bare restart mid-turn costs ~15 minutes; the
     restart wrapper costs 26 seconds. We own the
     wrapper and the discipline to use it.
   - **F2 — eve's Slack channel is webhook-only and needs public inbound; the box has none by design**
     (ADR-0011). The Slack relay plus its uptime monitor are permanent operating surface. In a
     Lares install the installer places the relay on the one box.
   - **F3 — eve's default harness is open** (shell, file tools, no approval). Every agent's harness is
     narrowed on adoption and the box's sealed egress is non-negotiable in Lares; a rollback to a
     pre-fence image un-fences the tools, so the fence is checked, not assumed.
4. **eve's job is narrower than "one image per agent".** ADR-0015 makes an agent a
   definition resolved at runtime on one general image; eve's dynamic capabilities (`defineDynamic`)
   are the mechanism. Nothing in this ADR depends on the per-agent images the earlier repo-split design
   described.

## Consequences

- The earlier decision to run the AI SDK directly, with self-hosted Inngest / pg-boss as the fleet's
  durability spine, is superseded. What runs an agent's turns and schedules is eve's own durable sessions and schedules
  (an eve session is one chat-day; a schedule resumes the live session). Anything else on the box that
  still uses pg-boss is a fact of the box compose, not of this decision.
- The earlier decisions on a per-capability trust ratchet and one governance module above the model
  layer survive as ADR-0015 and the permissions board (its first step). The ratchet is being built there,
  not in a framework-neutral module of our own.
- The costs in 3 are the reason the release process treats an eve bump as a release, and the
  reason `patches/eve.patch` must be copied into every image (the Dockerfile must copy `patches/` before `pnpm install`).

## Cross-references

- ADR-0011 (public ingress; not part of this repository), ADR-0013 (purpose aliases), ADR-0015 (agents are definitions).
