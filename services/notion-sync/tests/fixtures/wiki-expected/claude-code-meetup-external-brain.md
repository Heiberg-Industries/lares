<callout icon="💡" color="blue">
	A talk at the Example City agent meetup described a multi-agent "shared notes system for knowledge management — so you can just ask *what do I need to know today?*" with model tiering, daily agent budgets, and source validation. That is \[\[Example Project\]\] + \[\[example-notes-vault\]\] almost line-for-line — validation, not news. Two techniques worth borrowing, and one uncomfortable point: **you should be giving this talk, not screenshotting it.**
</callout>

## Validation
The described system — ambient ingestion of news/newsletters/social, distilled into a queryable notes system, agents on a daily budget scaling up for deep research on demand, cheap models for simple tasks and heavy models for hard ones — is what you already run (three agents on one small server, the notes vault, model routing designed in the project, several model providers routed in \[\[Example Agent\]\]). The "boring infrastructure matters" takeaway (scope definition, storage, source validation) is the same lesson as your \[\[agent-maintenance-research-seed\]\].

## Two techniques to borrow (small adds to what exists)
1. **Daily agent budgets.** A hard per-day spend cap per agent/loop, with the ability to "scale up for deeper research on demand." A concrete governance lever the fleet doesn't have yet. Fits directly into <mention-page url="https://www.notion.so/11111111111111111111111111111111">Designing agent loops — heartbeats, crons, hooks & goals</mention-page> (which already covers loop types + cost) — add budget as a first-class control.
2. **Proactive knowledge-gap detection.** The system "proactively identifies knowledge gaps and fills them" — i.e. it notices what it *doesn't* know and queues research. This is the active-learning upgrade to the passive reading radar already sketched in `notes/_inbox/README.md` (Phase 2). Turns the notes system from "files what arrives" into "hunts what's missing."

## Action flags for the owner
<callout icon="☑️" color="green">
	- [ ] **Speak at the Example City agent meetups.** A large community in your city, and the flagship talks describe *your* architecture. You already speak at events (\[\[Example Company\]\]) — this is the exact stage. Organisers: Example Studio + Example Hub.<br>- [ ] **Consider a professional certificate.** A cheap, dated credential for the consulting positioning (spotted in a colleague's post). Low effort, signals "insider who builds." Decision pending — not committed.
</callout>

## Related
\[\[Example Project\]\] \[\[example-notes-vault\]\] <mention-page url="https://www.notion.so/11111111111111111111111111111111">Designing agent loops — heartbeats, crons, hooks & goals</mention-page> \[\[agent-maintenance-research-seed\]\] \[\[Example Agent\]\] \[\[Example Company\]\]

## Source
Leo Example (social post), on a talk at Agent Meetup #7, Example Hub: building multi-agent systems as a shared "notes system" for knowledge management — automating ingestion of news/newsletters/social so you can ask "what do I need to know today?"; agents on a daily budget scaling up for deeper research; model tiering (cheap models → simple tasks, heavy models → complex); the system proactively identifies and fills knowledge gaps. Takeaway: "the boring infrastructure stuff — scope definition, storage, source validation — matters a lot before any of this works well."