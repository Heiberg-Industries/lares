<callout icon="💡" color="blue">
	A talk at the Oslo Claude Code meetup described a multi-agent "external brain for knowledge management — so you can just ask *what do I need to know today?*" with model tiering, daily agent budgets, and source validation. That is \[\[Lares\]\] + \[\[lares-atlas-vault\]\] almost line-for-line — validation, not news. Two techniques worth stealing, and one uncomfortable point: **you should be giving this talk, not screenshotting it.**
</callout>

## Validation
The described system — ambient ingestion of news/newsletters/social, distilled into a queryable brain, agents on a daily budget scaling up for deep research on demand, cheap models for simple tasks and heavy models for hard ones — is what you already run (Saga/Calliope/Nora on the Hetzner box, the Atlas vault, model routing designed in Lares, Anthropic/Google/Mistral routing in \[\[Nora\]\]). The "boring infrastructure matters" takeaway (scope definition, storage, source validation) is the same lesson as your \[\[agent-maintenance-research-seed\]\].

## Two techniques to steal (small adds to what exists)
1. **Daily agent budgets.** A hard per-day spend cap per agent/loop, with the ability to "scale up for deeper research on demand." A concrete governance lever the fleet doesn't have yet. Fits directly into <mention-page url="https://www.notion.so/11111111111111111111111111111111">Designing agent loops — heartbeats, crons, hooks & goals</mention-page> (which already covers loop types + cost) — add budget as a first-class control.
2. **Proactive knowledge-gap detection.** The system "proactively identifies knowledge gaps and fills them" — i.e. it notices what it *doesn't* know and queues research. This is the active-learning upgrade to the passive Content Radar already sketched in `brain/_inbox/README.md` (Phase 2). Turns the brain from "files what arrives" into "hunts what's missing."

## Action flags for Bendik (personal brand / owner.example)
<callout icon="☑️" color="green">
	- [ ] **Speak at the Oslo Claude Code meetups.** Largest such community in the world, in your city, and the flagship talks describe *your* architecture. You're a keynote speaker (\[\[Heiberg Industries\]\] / owner.example) — this is the exact stage. Organisers: GritAI Studio + Mesh Oslo + Anthropic (Claude Community Ambassador programme).<br>- [ ] **Contemplating: Claude Certified Architect (Foundations) cert.** Cheap, dated credibility for the consulting/keynote positioning (spotted via Justin Fish's cert post, same screenshot batch). Low effort, signals "insider who builds," reinforces the AI-native-operator brand. Decision pending — not committed.
</callout>

## Related
\[\[Lares\]\] \[\[lares-atlas-vault\]\] <mention-page url="https://www.notion.so/11111111111111111111111111111111">Designing agent loops — heartbeats, crons, hooks & goals</mention-page> \[\[agent-maintenance-research-seed\]\] \[\[Nora\]\] \[\[Heiberg Industries\]\]

## Source
Fabian Garvik (LinkedIn), on a talk at Claude Code Meetup #7, Mesh Oslo: building multi-agent systems as an external "brain" for knowledge management — automating ingestion of news/newsletters/social so you can ask "what do I need to know today?"; agents on a daily budget scaling up for deeper research; model tiering (cheap models → simple tasks, heavy models → complex); the system proactively identifies and fills knowledge gaps. Takeaway: "the boring infrastructure stuff — scope definition, storage, source validation — matters a lot before any of this works well."