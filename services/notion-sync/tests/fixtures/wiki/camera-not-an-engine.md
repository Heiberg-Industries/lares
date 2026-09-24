---
title: "A Camera, Not an Engine — seeing in latent space, and the camera/engine split in agents"
type: concept
source: "[[raw/a-camera-not-an-engine-ii]]"
created: 2026-06-22
tags: [ai, agents, thinking, writing, loops, clipping, writing-seed]
---

# A Camera, Not an Engine

> [!summary]
> Venkatesh Rao's frame: generative AI is an instrument for **seeing** in latent
> space — a camera — not an **engine** of production. Part II adds the agent twist:
> the same loop is a *camera* when seeing outruns doing (it **explores**, piling up
> information through rich feedback) and an *engine* when doing outruns seeing (it
> **exploits**, unleashing more energy than it can control). The failure mode of
> the engine is "AI psychosis" — runaway token-burning "productivity" with no error
> signal to regulate it.

Source: Venkatesh Rao, [*A Camera, Not an Engine II*](https://contraptions.venkateshrao.com/p/a-camera-not-an-engine-ii) (Jun 2026), a sequel to his Dec-2023 part I. Full text in [[raw/a-camera-not-an-engine-ii]].

## The core flip
The title inverts Donald Mackenzie's *An Engine, Not a Camera* (about economics). Rao's claim: despite the "generative" label, these models are primarily for **seeing** — pointing at and revealing things in latent space — not for manufacturing output. The new working definition of intelligence he builds on (from Sreeram Kannan / Eigenlabs):

> [!quote]
> Intelligence is a unit of information driving a unit of energy.

A telescope is the minimal example: information (where/when to look) drives energy (slewing the instrument) so that a bigger loop — sky → eyes → thoughts → actions — can run.

## Two crises for writers (the brass-telescope parable)
Rao revives his 2011 split between **writing to think** and **writing to write** — looking *through* words vs looking *at* words ("beautiful, heavy brass words"). The divide is, in his experience, nearly impossible to cross. AI puts both tribes in crisis:

- **Write-to-think:** writing is no longer the only or best way to think → adapt to new tools or retreat to shrinking niches.
- **Write-to-write:** become an antiquarian of words, or defend the supposed superiority of hand-wrought prose.

His own stance: words are becoming a **compile target** for pre-verbal thought. Prompting is *pointing* (steering the camera) and *programming behaviours* (output that machines read or code that runs). Natural language is shrinking to a thin **administrative layer** between pre-verbal input and energy-shaping output — and that managerial steering is *more* exhausting, not less ("we are all pharaohs now": every word can unleash a thousand more that govern computers).

## The camera/engine split in agents (the new part)
An agent is a feedback loop: see → think → do, with an **error signal** = the gap between expected and experienced outcomes. That error is the rate at which real context actually enters the system.

| | **Camera** | **Engine** |
|---|---|---|
| Balance | seeing outruns doing | doing outruns seeing |
| Behaviour | **explores** | **exploits** |
| Feedback | rich; context grows faster than action | impoverished; action outruns context |
| Tendency | maximally **mindful** | maximally **brutal** (oblivious, tone-deaf) |
| Produces | surplus of *information* | surplus of *externalities* (unintended consequences) |

Intelligence is getting the balance right *for the context* — you can over- or under-think relative to how precise the action needs to be. One-shotting is the zero-feedback extreme.

> [!important]
> **"AI psychosis" = an engine in a too-playable domain.** When a domain
> frictionlessly absorbs unlimited cognitive energy without consequence (chess is the
> archetype — fully synchronisable, rewindable, replayable), there's no error signal
> to regulate thinking, so you get a positive feedback loop: exponential "productivity"
> that does no real work and generates no value — "a shriek of explosive token bills."
> Rao's warning to organisations: atomised productivity in the high-playability pockets,
> far from real feedback, does nothing for the bottom line. Without feedback at every
> level keeping **context growing faster than action**, behaviour gets dumber and more
> damaging.

## Why I kept it
This is the missing *theory* layer under the practical loop material we already have. [[agent-loops-design]] and [[loop-engineering-designing-loops-instead-of-prompting-agents]] tell you *how* to wire a loop; Rao tells you *when a loop is doing real work vs tearing itself apart* — the error signal, and the camera/engine balance, are the same feedback path. The "engine in a playable domain" reading is a sharp diagnostic for the "agents look busy but move no needle" pattern flagged in [[services-as-software-autopilots]] and the labour-market notes in [[international-ai-safety-report-2026]].

It's also a strong **writing seed** (`writing-seed`): the write-to-think vs write-to-write split, and "prompting is pointing," sit right next to [[fadell-taste-judgment-ai-era]] (taste/judgment as the scarce input) and the studio's own voice work — see [[writing]].

## Connections
- [[strange-knowledgeability]] — same author, one turn on: AI as a mirror that resonates with any framing, and the post-perspectival incuriosity that mirrors the no-error-signal "AI psychosis" here.
- [[agent-loops-design]] / [[loop-engineering-designing-loops-instead-of-prompting-agents]] — the loop mechanics this theorises; error signal = their feedback step.
- [[services-as-software-autopilots]] — engine-mode "productivity theatre" vs camera-mode real value.
- [[fadell-taste-judgment-ai-era]] — taste/judgment as the pre-verbal input layer.
- [[writing]] — write-to-think vs write-to-write; essay seed.
- [[international-ai-safety-report-2026]] — organisational/labour evidence for the "no value" warning.
