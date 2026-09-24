---
title: "Designing agent loops — heartbeats, crons, hooks & goals"
type: summary
source: "[[raw/how-to-design-ai-agent-loops]]"
created: 2026-06-22
tags: [ai, agents, loops, claude-code, codex, automation]
---

# Designing agent loops — heartbeats, crons, hooks & goals

> [!summary]
> Claire Vo's practical how-to on **loop design**: a loop is "just an automated
> prompt." Four ways to fire one (heartbeat, cron, hook, goal), five things every
> loop needs before production, and an "onboard an employee" mental model — shown
> through two live builds in Claude Code and Codex.

This is the **operator's companion** to [[loop-engineering-designing-loops-instead-of-prompting-agents]]
(Addy Osmani's essay, which the episode cites directly). Where that piece argues
*why* you stop prompting agents and start designing the systems that prompt them,
this one shows *how* to actually wire one up.

## The four ways to automate a prompt

| Type | Fires when | Use for |
|------|-----------|---------|
| **Heartbeat** | continuously / steady tick | always-on watching |
| **Cron** | fixed schedule (e.g. daily 10:15) | recurring routines |
| **Hook** | an event happens | react to a trigger |
| **Goal** | recursive — runs until purpose met | open-ended work |

The goal loop is the one to watch on cost: you define a purpose and the agent
iterates until it decides it's done.

## Five things every effective loop needs

Same primitives Osmani lists — they now ship *inside* the products (Claude Code,
Codex), so a loop is no longer a pile of bash you maintain forever:

1. **Worktrees** — so parallel agents don't step on each other.
2. **Skills** — written-down project knowledge the agent would otherwise guess.
3. **Plugins / connectors** — wire the agent into the tools you already use.
4. **Subagents** — one agent has the idea, a different one validates it.
5. **State tracking (external memory)** — a markdown file / Linear board that
   holds "what's done, what's next" *outside* the conversation. The agent forgets
   between runs; the repo doesn't.

## The "onboard an employee" framework

Design a loop the way you'd guide a new hire through a recurring task: what's the
job, what must they know (skills), what tools do they get (connectors), how do
they check their own work (validating subagents), where do they write down status
(memory). If you can onboard a person to it, you can onboard an agent.

## The two live builds

- **Daily aging-PR reviewer (Claude Code)** — a *cron* loop that schedules itself
  at 10:15 a.m., finds pull requests that are getting old, and spins off its own
  subagents to review and alert teams. No more manually babysitting a PR.
- **Weekly skills-identification loop (Codex)** — a loop that spots reusable
  skills and spawns *goal-based* subagents to validate its own output in real
  time; you can watch the subagents spin up.

## Warning signals (when loops get expensive)

> [!warning]
> Two red flags that a loop will burn money: **inefficient goal-based structures**
> (recursive loops that don't converge) and **unnecessary token-consumption
> patterns**. Token cost is the recurring caveat across both this and
> [[loop-engineering-designing-loops-instead-of-prompting-agents]] — usage varies
> wildly depending on whether you're token-rich or token-poor.

## Why I kept it

The clearest plain-language taxonomy of loop *types* I've seen — heartbeat / cron
/ hook / goal is a vocabulary worth having. The "onboard an employee" framing is
directly useful for how I think about delegating recurring work (Orakel
prospecting runs, Murmur processing, the Brain's own `/ingest` and `/lint`). Pairs
with the Brain's own phasing note (Phase 3: a research/validation gate on a
schedule) — that *is* a goal loop with a validating subagent.

## Links
- [[loop-engineering-designing-loops-instead-of-prompting-agents]] — the essay this episode is the how-to for
- [[braintrust-evals-as-prds]] — what the validating subagent should check against: an eval as spec
- [[services-as-software-autopilots]] — loops are how "autopilots" actually run unattended
- [[camera-not-an-engine]] — the theory under the loop: error signal = feedback step; camera (explore) vs engine (exploit) modes
- [[solo-builder-247-local-ai]] — this loop pattern taken to its limit: a solo builder runs build/review loops 24/7 on local hardware ("ambient AI")
