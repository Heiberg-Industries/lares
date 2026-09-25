# Console structure — agreed direction

Recorded 2026-09-25. The accepted direction below supersedes the initial navigation
grouping documented later in this file. Implementation planning comes next; the user
wants bounded tasks for smaller implementation agents after the plan is agreed.
Component foundation accepted: shadcn/ui + Tailwind CSS 4, with a selected AI Elements
pilot over Eve. See [UI stack decision](console-ui-stack.md). Prefer standard components
with a thin Lares color/font theme; custom work must serve a concrete product need.

The console's first design pass is built in services/console, using the real routes and
permission data. The exported Lares kit is a visual reference, not the source of screen
structure. This note records the current journeys and the next structural gaps.

## The owner's journeys

| Journey | Route today | What the owner needs | State |
| --- | --- | --- | --- |
| First conversation | installer → /agents/new → /chat/[name] | An honest handoff from setup to a healthy agent, then one real turn | Code exists; the complete stranger-install path still needs proof (ADR 0022, LAR-50) |
| Everyday work | /chat, /, /activity, /signals | Talk to agents, see what happened, and find what needs a decision | Working routes; /activity still reads the older audit table; one cross-agent waiting-on-you view and spend remain LAR-20 |
| Manage an agent | / → /agents/[name] → /agents/[name]/edit | See identity, reachable controls, evidence, and the edit path | This pass restructures the overview; builder and runtime work is tracked in LAR-5 |
| Approve an action | /chat/[name] today | Know what leaves the house, answer once, and see the result | Chat cards exist; cross-agent approval parity is part of LAR-20 |
| Recover | /backup | Understand protection and restore options without a false readiness claim | Restore belongs at the first setup choice (ADR 0022) |

The first setup screen must not claim a working conversation until the first agent is
created, healthy, and able to answer. The website must not call the source alpha a
tested installation before LAR-50 passes.

## Initial prototype navigation (superseded)

The current twelve links stay available while their labels are grouped around intent:
**Your work** (chat, fleet, activity, signals), **Sources & records** (integrations,
deadlines, meetings, taste, markets), and **Controls** (proactivity, voice, backup).
Agent creation stays on Fleet; an agent's own chat and edit actions stay on its overview.
This is a first pass, not a new route contract.

## Agent overview

The page's primary question is "what can this agent do, and what can I change?"
Use the existing permissions board data, including Vault area rows, to separate:

1. **You decide:** capabilities whose approval level can be changed. Show the level,
   source, recent decisions, and tools that always ask.
2. **Acts without asking:** plain writes from the definition. Offer the edit route,
   never a dial that writes a setting the engine ignores.
3. **Reads:** granted read access.

Recent permission checks follow the controls as evidence. The active approval check
writes approval_events; the old audit table has no production write callers in this
repo. Fetch by agent in the database before limiting the result, and label this
evidence honestly rather than presenting it as a complete activity stream.
The layout must hold both two capabilities and at least 23 without horizontal
scrolling or clipped words (LAR-63).

## Next structural pass

- Replace or retire the global /activity page's old audit query after deciding which
  current sources constitute a complete action history (LAR-63, LAR-20).
- Design the cross-agent waiting-on-you and cost view from real approval and gateway
  data (LAR-20), preserving the existing chat-card action semantics.
- Map the first-run screens against ADR 0022 and LAR-7 once the installer and
  first-agent handoff are ready to review together.
- Build the marketing site as real code alongside the console and shared tokens.
  The downloaded mockup's simulated waitlist and placeholder price lines are not
  launch-ready (LAR-11).


## Accepted structure (2026-09-25)

Primary navigation: Home, Chat, Agents, Activity, Connections, Settings.
Tools is a secondary group for available specialist features.

| Destination | Purpose |
| --- | --- |
| Home | Needs your attention, recent work, agent health, compact usage summary |
| Chat | Conversations organised by agent; visible New conversation action |
| Agents | Agent purpose and status; prominent Create agent; replaces Fleet |
| Activity | Actions, decisions, errors and usage, searchable/filterable by agent |
| Connections | Accounts, connection health, which agents have access |
| Settings | Shared preferences, notification defaults, models, backup/recovery |

Agent header: name, purpose, status, visible Chat and Edit agent actions, Actions menu.
Agent tabs: Overview, Access, Schedules, Activity. Overview prioritises attention,
recent work and next scheduled work. Access explains accounts, reads, writes and
approval requirements. Edit agent covers identity, instructions, personality,
language and model. Avoid mixing immediate permission changes with unsaved form edits.

### Agent journeys

- Create: choose purpose/template, name and instructions, access, short review.
  Advanced options are secondary. Show actual starting permissions before creation.
  Show Creating, Starting and Ready to chat from authoritative state.
- Edit: consistent labels/sections, preserve input, inline validation, explicit
  saved/pending/restart effects. Existing permanent identifiers cannot simply be
  renamed: a display-name UI requires checking the supported definition contract.
- Pause/resume: desired reversible behaviour, pending backend design and support.
  Specify schedules, incoming messages, running turns and pending approvals.
- Retire: current backend stops the agent and makes its definition read-only while
  retaining workflow data. Do not relabel this as reversible Pause or Archive.
- Delete: discoverable in Actions, confirmation names the agent and explains the
  actual data deletion scope. Do not imply Undo for permanent deletion.

### Move and rename

| Current surface | Target |
| --- | --- |
| Signals | Events in Activity; actionable problems on Home; alert routing in Settings |
| Proactivity | Shared Notifications & quiet hours in Settings; per-agent recurring work in Schedules |
| Voice | Email writing style under mailbox Connections; shared defaults available |
| Meetings | Meeting follow-up permissions under the relevant agent's Access |
| Taste | Saved preferences under Tools; entries first, import/maintenance secondary |
| Backup | Settings > Backup & recovery |
| Deadlines | Tools > Deadlines |
| Markets | Tools > Market watch |

Show current state and the next useful action before configuration. Distinguish
quiet, unavailable, busy and waiting-for-approval states. Empty states explain what
to do next. Preserve direct links/redirects when routes move. Shared controls and
agent overrides need one source of truth and a visible scope.

### Planning boundaries

First sequence: Agents list > Create > Overview > Edit > Retire/Delete, including
empty/loading/error/success states. Then Home and Activity with real source coverage.
Pause/resume, aggregate approvals and usage are functional work, not label changes.
Validate with unfamiliar users attempting create, edit instructions, find access and
remove an agent without guidance; include keyboard and small-screen journeys.

The downloaded design project and supplied screenshots remain the visual reference:
light near-white surfaces, subtle green tint, restrained typography and tables, with
light/dark treatments. The first static preview was a structural draft and is not
an approved replacement visual direction. Build on real code; no Figma dependency.

Related work: LAR-63 (agent detail), LAR-20 (activity/usage/attention), LAR-5 (builder),
LAR-7/LAR-50 (installation), LAR-10 (design system), LAR-11 (website).
