# Lares design system, console and marketing — execution plan

Status: approved visual direction; implementation plan prepared for later execution.
Date: 2026-09-25. Owner: Bendik.
This document authorizes no merge, deployment, provider call or production migration.
No implementation tasks have been dispatched by this planning pass.

## Integration checkpoint — 2026-09-25

The owner subsequently approved implementation in small reviewed slices. This copy of the
approved plan and `tools/design-preview/` is being ported from the older design branch onto
main `b680935` as a reference-only slice. It does not add the production website or replace
console screens. The design branch's older installer and runtime commits are intentionally
excluded. PR #20 owns chat reload and session access while it remains in review. LAR-10 and
LAR-11 stay open until their production acceptance criteria are met; LAR-50 remains open for
the broader fresh-install run.

## Owner update — contact replaces waitlist

The repository is now public. The owner removed the waitlist/signup plan for the
website. Keep a contact sheet for setup enquiries and other messages, and a booking
path using the Orbis service backed by the Heiberg calendar. The exact familia
headline in the approved brand copy is intentional: “Care f**k all about agents?
Get in touch.” Add a GitHub icon in the site header. PostHog and Google Search
Console are the intended analytics/search tools; hosting on the Orbis box is a
candidate for later discussion. This update supersedes older waitlist notes below.

## Owner visual correction — production website

The owner flagged visible diagonal lines and differences in card, hero, footer and
font sizing after the first website merge. The production website should retain
the draft's soft card gradients and fine grain, without a diagonal stripe overlay.
The hero retains gradient light and grain without a visible diagonal pattern.
Keep the reference's mono scale, card proportions and solid footer treatment.

## 1. Outcome and implementation principles

Deliver the approved Lares console and marketing experience in real application code, using one shared design system. Preserve the current working runtime and self-hosted installation model. Prefer established shadcn/ui behavior and selected AI Elements presentation over custom interface infrastructure. The UI supports the product.

The approved HTML is a visual and interaction reference, not production architecture. Do not copy its monolithic App, sample data, in-memory persistence or accumulated CSS overrides into the console. Production screens must use authoritative data and existing authenticated actions.

“No hardcoded design” means visual decisions have a single named owner: colors, fonts, sizes, radii, layout constraints, status semantics, motion and texture parameters live in shared tokens/components. Literal values are necessary in token definitions; they must not be duplicated throughout pages. Static editorial copy can remain content. Runtime data, permissions, health and availability cannot be simulated or inferred from styling.

## 2. Reference and current-source baseline

Approved final preview:
`/Users/bendik/.codex/visualizations/2026/09/24/01a0d3a4-9ece-7f51-9bc3-1ba9eacbd2bf/lares-marketing-v6.html`
It contains both Console and Marketing. Console approval predates the final marketing-only changes.

Preview implementation and agreed notes:
`/Users/bendik/.codex/worktrees/lares-console-structure/lares/tools/design-preview/`
`/Users/bendik/.codex/worktrees/lares-console-structure/lares/docs/design/`
Notes include console-structure.md, console-ui-stack.md, console-refinement.md, marketing-refinement.md and motion.md.
Original asset kit: `/Users/bendik/Downloads/Lares Design System Project/`.

Read-only inspection during planning:
- Active checkout `/Users/bendik/Developer/lares`, HEAD `b5a1193efbf536a8e4fd31c530941dce8327ce4e`; git status was clean when inspected. This is a point-in-time observation, not evidence the other session has stopped.
- Design worktree HEAD `7e300ae3f4a5401940df696cb86838682585f5ad`; it has uncommitted earlier design work. It is behind the inspected active checkout. Never merge it wholesale as a shortcut.
- Console package declares Next ^16.3.5, React ^19.2.7, patched Eve 0.60.1; existing console has no Tailwind/shadcn dependency setup. Console TypeScript/Vitest differ from the standalone preview. Preserve actual workspace versions and use pnpm.
- Workspace includes `services/*` and `packages/*`. No dedicated marketing application appeared in the inspected tracked file inventory; confirm again before creating one.
- `services/console/components/Chat.tsx` uses `useEveAgent`, same-origin proxy, send/respond/reset contracts, expiration and pending-response safeguards. Opening chat does not prewarm a session.
- `app/actions/definition.ts` already exposes authenticated Keeper create/save/retire/delete, connection reconciliation, conversation list/reset and channel actions. Its explicit “outcome may be unknown” result must survive the redesign.

Earlier notes may be stale: the original motion note says animations are not implemented and excludes decorative loops; the owner subsequently approved hero-only loops with pause/reduced-motion. v6 and this plan supersede that language. Historical Linear references below are pointers, not freshly verified ticket status.

## 3. Protect concurrent work

1. Keep this plan outside both checkouts until the implementation owner is ready. No commit, staging, dependency install, branch operation or source mutation in the active checkout during planning.
2. At implementation kickoff, read current repo instructions, HEAD, diff, open PRs, handoff and current Linear tickets. Coordinate ownership with the other session before touching shared files.
3. Create a fresh `codex/` implementation worktree from the then-current agreed integration base. Do not reset, stash, clean or rebase another session's checkout.
4. Compare existing design-worktree changes against current main. Port intentional changes individually; preserve newer backend, security and lifecycle work. Do not bulk cherry-pick an old UI branch.
5. One integration owner controls workspace manifests, pnpm lockfile, global styles, shared packages, navigation contracts and migrations. Other agents receive bounded file ownership.
6. Integrate small reviewed slices. Capture each slice's base SHA, changed files, checks, screenshots, known gaps and next dependency. Reconcile against current main at every integration point.
7. Commit/PR/merge only when the owner resumes that step. This request explicitly stops before committing.

## 4. Approved visual contract

### Shared
- Instrument Sans for interface/body; DM Mono for genuinely useful technical metadata. Self-host fonts and retain licenses.
- Original near-white/moss/ink palette, theme-aware semantic colors and restrained oxide attention color.
- Moderate control rounding (~10px), soft surfaces (12–20px according to component), pills for compact badges/chips; values centralized.
- Legible secondary text, visible focus, larger click targets, one clearly selected nav item and lighter hover state.
- Short feedback/navigation transitions; no delay before a user action executes. Reduced motion is respected.

### Console
- Home alone uses the house/bracket navigation icon. Every other destination has its own monochrome icon.
- Tools is a small separated noninteractive group heading, not a landing-page link.
- Stable sidebar, readable left-aligned content, soft tables/cards and clear primary actions.
- Chat agent switcher in the conversation header; agent name, role, icon and selected state. Distinct sender colors plus author labels/alignment.
- Default geometric role icons; reusable avatar everywhere; user image upload and restore-default action.
- Preserve conversations/drafts when switching agents; production persistence must come from verified supported contracts.

### Marketing
- Same fonts/palette, softer controls and cards. Hero has strong moss gradients, slowly moving light and gently drifting fine grain, faint surface texture, pause/play, static reduced-motion fallback.
- Offering cards have static grainy gradients and distinct compositions. No animation on the cards.
- Product example uses the actual shared approval/avatar/status presentation.
- Domus: Run it yourself; Villa: Hosted for you; Familia: Managed service. Content and availability must be verified before publishing.
- Solid full-width contact/footer, height determined by content. Light stone grey with a green undertone in light mode; near-black in dark mode. No grain/gradient or outer rounded contact card. Content aligns to the page grid; quiet divider above footer links.

## 5. Shared architecture and enforcement

Proposed lean package structure (final names checked against current repo at kickoff):

```
packages/ui/
  src/theme/tokens.css        # canonical primitive + semantic tokens, light/dark
  src/theme/motion.css        # shared keyframes and reduced-motion policy
  src/primitives/             # selected shadcn source, consistent primitive family
  src/patterns/               # PageHeader, EmptyState, StatusBadge, AgentAvatar, etc.
  src/marketing/              # GradientSurface, offering and contact layout primitives
  src/index.ts               # explicit supported exports
  tests/                     # behavior, semantic states and theme checks
services/console/             # authenticated product views and domain adapters
services/website/             # proposed public marketing app, separately deployable
```

Keep theme CSS separately importable so server-rendered public pages do not load console behavior. Product-specific runtime adapters belong in the console, not the shared package. Avoid a component framework beyond these needs.

Token groups: primitive palette; semantic background/surface/foreground/muted/border/focus/primary/attention/error/success; font families/weights/type scale; spacing; radius; elevation; content widths/sidebar width/control sizes; z-index; breakpoint policy; motion durations/easing/distance; gradient stops/grain opacity/scale/texture strength. Put light/dark values beside one another. Expose Tailwind 4 theme mapping from those tokens, not a second palette. Brand illustrations may have fixed vector geometry; their colors/sizing use tokens.

Use named variants such as StatusBadge(needs-attention), Surface(card), Button(primary), GradientSurface(hero|offering). Pages choose variants rather than styling them with raw hex/OKLCH values, pixel radii, shadow strings or inline typography. Hero speed/intensity and footer color are named tokens. Retain observed tuning as starting values, including 14/19-second light cycles and five-second grain drift; verify on devices.

Add a small component reference route or fixture app with all variants, themes and states. Reuse existing tooling if it suffices; Storybook is optional, not a prerequisite. A change to one token should visibly update both products.

Enforcement: targeted lint/CI checks flag new raw visual literals, arbitrary Tailwind appearance values and inline visual styles outside token/approved asset files. Audit existing violations and migrate by slice; do not fail unrelated legacy code immediately. Allow documented exceptions for computed data geometry (e.g. progress widths), with accessible bounds. Component variants must remain typed. Review prevents escape through duplicated local CSS variables. Remove legacy aliases after consumers migrate.

Tailwind integration: prove preflight/reset behavior on old pages before broad enablement. Use token aliases or scoped styles during migration, one temporary compatibility layer with an owner/removal gate. Do not ship an endless chain of preview overrides. Document client/server component boundaries and CSS export order. Audit dependency licenses and preserve Eve patch/overrides.

## 6. Route and workflow migration

| Current | Target / treatment |
|---|---|
| `/` fleet view | Home attention/health/recent work; move agent list to `/agents` |
| `/chat`, `/chat/[name]` | Retain routes; new header switcher and conversation presentation |
| `/agents/new`, `/agents/[name]`, `/agents/[name]/edit` | Retain stable deep links and identity contracts |
| `/activity`, `/signals` | Activity with explicit event coverage; Home surfaces actionable problems |
| `/integrations` | Connections UI; proposed `/connections` alias/redirect after route audit |
| `/proactivity` | Shared notification defaults in Settings; agent schedules under agent detail |
| `/voice` | Mailbox writing style under Connections; clearly scoped defaults |
| `/meetings` | Preserve management capabilities; relevant permissions in agent Access |
| `/backup` | Settings > Backup & recovery, retaining direct recovery access |
| `/deadlines`, `/taste`, `/markets` | Tools: Deadlines, Saved preferences, Market watch |

Choose final Settings subroutes after inventory; record old-to-new redirects including query/fragment handling and auth behavior. Never discard a working advanced screen because the preview omits it. A temporary contextual link is preferable to losing functionality. Nav visibility follows real feature availability; no dead placeholders in shipped navigation.

### Agent lifecycle

List: searchable real agents, role/avatar, authoritative state, attention count, recent evidence, Chat and Actions. Empty state leads to Create.
Create: purpose/template → identity/instructions/avatar → supported access choices → review. Show actual initial permissions and model requirements. Preserve valid input and server findings. After create, show Creating/Starting/Ready from real state; offer chat only when appropriate. Existing permanent name validation remains authoritative.
Edit: instructions/personality/language/model as supported; immutable identifier distinct from any future display name. Explain saved vs applied/restart-required state. Warn on dirty dismissal/navigation. Handle concurrent updates and unknown outcomes by reading state before retrying.
Detail: visible Chat/Edit/Actions, tabs Overview/Access/Schedules/Activity. Access must distinguish reads, plain writes and approval-controlled capabilities. Never show a toggle the engine ignores. Test long lists (23+ capabilities), narrow layouts and long names.
Retire/delete: preserve server semantics and confirmations, show exact retained/deleted scope, no fictitious undo. Pause/resume is excluded until backend semantics exist; retire is not renamed pause.

### Avatar persistence

Inspect supported definition/metadata storage first. Add an optional backward-compatible avatar reference in the appropriate owner, not a data URL in agent prompts or arbitrary definition fields. Implement authenticated upload/remove, bounded raster types/size (preview uses PNG/JPEG/WebP and 2 MB), server decode/re-encode and dimension limits, orientation/crop handling and metadata stripping. Store a generated asset identifier with ownership checks; no arbitrary remote fetch. Handle invalid files, failure, fallback, replacement and cache invalidation. Include assets in backup/export/restore and deletion policy. Default SVG role icons need no upload. Confirm storage/native image-processing dependency support before selecting a library (workspace currently ignores sharp build scripts).

### Chat and approvals

Wrap existing Eve state in a small typed presentation adapter. Preserve same-origin session auth, no agent secrets in the client and no prewarm/provider call from opening a view. Pilot AI Elements Conversation/Message/Prompt Input; keep only what demonstrably fits. No second useChat transport or copied example API route.
Preserve send, streaming, steering, reset, reconnect and failure behavior. Verify actual history/session discovery and restoration; existing Keeper conversation list/reset does not automatically prove web transcript restoration. If a backend addition is needed, scope it explicitly rather than claiming browser state is durable. New conversation has truthful session semantics and cannot leave stale actionable approvals visible.
Approval cards reuse the existing request ID and supported option IDs. Preserve expiration, in-flight turn restrictions, duplicate prevention, server refusal and unknown outcomes. Home and chat must reconcile the same approval identity; UI hiding alone is not idempotency. Keep payloads escaped. Streaming Markdown/Streamdown is optional behind a separate rendering review; don't weaken current plain-text safety.
Keep reading position, jump-to-latest, keyboard composer conventions, draft retention, clear sender identity and useful pending/error states. No artificial response timers in production.

### Home, Activity, Connections, Settings and Tools

Inventory data sources before composing summaries. Define adapters with freshness, unavailable state and coverage. Do not present the legacy audit table as complete history without proving its producers. Map decisions, tool events, signals, errors and usage; distinguish unknown/missing from zero. Paginate/filter at the data boundary with stable ordering. Counts and actions on Home must agree with underlying records. Cost displays specify scope/currency/time window and authoritative source.
Connections show provider/account identity, custody, real health, used-by agents, access scope and reconnect path. Stored credentials are not proof of connectivity. Preserve OAuth and error handling.
Settings separate shared defaults from agent overrides, notifications/quiet hours/time zone, model settings and backup/recovery. Never claim a verified restore from a stored backup timestamp.
Tools preserve existing deadline actions, preference browsing/import and market controls. Show meaningful empty/loading/error states and primary actions. Test dates/time zones and current permission boundaries.

## 7. Public marketing implementation

Confirm whether another session creates a website first. If absent, use a small separate `services/website` app with the existing supported React/Next stack and static output where practical. Do not couple the public root to console authentication or install a new deployment platform to use shared components.

Compose content-driven sections: header, hero, benefits, real-component product example, offering cards, name story, contact/footer. Keep text/offering metadata in a typed content module. Retain stable anchors, keyboard navigation and mobile flow. No sample agent data enters real console adapters.

Hero decorative layers are isolated, clipped and pointer-transparent. Pause stops grain and light; reduced motion is static from initial render. Pause offscreen/in hidden tabs where useful, keep content visible before JS, profile SVG noise and large moving layers on modest mobile hardware. Use a cached static grain asset if runtime filters are costly, preserving the same component contract. Avoid introducing WebGL for this treatment.

Contact: the public site has no waitlist/signup. Keep a real contact path for setup enquiries and other messages. The current email link opens the visitor's mail app; it does not claim to submit anything through the site. The booking link goes to the existing Heiberg calendar page. The popup requires an Orbis frame-policy and Lares-brand decision before integration. If a contact form is later chosen, implement verified delivery, validation, failure/success states and abuse controls before enabling it.

Before publishing: verify installation/availability/pricing and capability claims against the current release; confirm public source/docs links, metadata, canonical URL, social image, sitemap/robots as appropriate, favicon, fonts/licenses and no private console data. Use ordinary stable navigation, not preview surface-switching controls. Hosting/deploy and launch remain separate explicit steps.

## 8. Execution slices and bounded agent assignments

No agents should start until the owner resumes implementation and the integration base is reconciled. Use small assignments with a concrete acceptance artifact; do not delegate the whole redesign as one task.

| Slice | Owner scope | Dependency | Completion evidence |
|---|---|---|---|
| P0 Reconcile | Lead: current repo/tickets/data contracts/route map | Resume | Source SHA, overlap ledger, preserved-feature inventory and backend-gap list |
| P1 Foundation | UI agent: `packages/ui`, reference fixtures; lead owns manifests/lock | P0 | Token inventory, light/dark primitives, reset compatibility, no duplicated palette |
| P2 Real pilot | Integration agent: one editor section + one Eve conversation | P1 | Real adapters compile, current behavior retained, accessibility/stream checks |
| P3 Shell | Console agent: shell/nav/page patterns/route compatibility | P2 | Responsive keyboard nav, theme persistence, old deep links work |
| P4 Lifecycle | Lifecycle agent: list/create/detail/edit/retire/delete | P3 | End-to-end lifecycle and failure/unknown-outcome checks |
| P5 Identity storage | Backend+UI owner: avatar contract/storage/editor | P0/P1; coordinate P4 | Upload/reset/persistence/backup tests and schema compatibility |
| P6 Chat | Chat agent: presentation/history/approval mapping | P2/P3/P5 contract | Send/stream/switch/reconnect/reset/approval evidence |
| P7 Operations | Console agent: Home/Activity/Connections/Settings/Tools | P3 and verified source contracts | Real event coverage, filters, permissions and recovery UX |
| P8 Website | Marketing agent: separate app/content/sections | P1/P2 stable; identity API agreed | v6 fidelity, motion behavior, both themes/mobile; mock mode isolated |
| P9 Contact and booking | Website/Orbis owner: contact delivery and branded booking popup | P8 + cross-repo decision | Verified mail path, booking flow, errors and accessibility |
| P10 Consolidate | Lead: cleanup/docs/CI/review package | P4–P9 | Gates below, no old style duplication, owner-reviewed final build |

P8 can run alongside console slices once shared component APIs stabilize. P5 can run alongside P3 with a fixed avatar contract. P4/P6/P7 must not concurrently edit shared shell/agent detail files without explicit ownership. Only lead resolves shared dependency and migration changes. If backend gaps block one slice, proceed with independent slices; keep the blocker visible.

Each assignment must include: goal, allowed files, prohibited shared files, base SHA, dependencies, API contracts, visual reference, acceptance checks, and handoff format. Smaller agents implement bounded tasks; the lead reviews behavior and integrates. Do not allow independent agents to invent new token scales, runtime semantics or package choices.

## 9. Verification and acceptance gates

1. Foundation: same tokens and primitives power both apps; changing a semantic token affects both. Fonts self-hosted; light/dark/system preference works without a flash. No accidental global-reset regressions.
2. Functional: create/edit/retire/delete and error states; authenticated permission changes; connection failures; backup status; tools preserved. No production fixtures, fake metrics or prototype delays.
3. Chat: use current Eve test fixtures for streaming/steering/reconnect, switching/history, reset, approval expiry/duplicate/unknown outcome and tool errors. Real provider-backed proof requires its own authorization; local tests don't establish delivery.
4. UI: keyboard-only workflows, dialog focus/return, accessible labels, screen-reader announcements, visible focus, adequate target sizes, text/status contrast (WCAG AA), non-color state cues. Review 360–390px, tablet and desktop, long content, zero/one/many agents, 23+ capabilities, loading/empty/failure states, zoom and reduced motion.
5. Visual: browser screenshots against approved console and v6 marketing in both themes. Video/manual check for hero motion/pause and conversation scroll. Earlier preview DOM checks did not establish browser visual correctness; this gate remains necessary.
6. Performance: compare bundle and page metrics to baseline, avoid layout shifts, lazy-load noncritical tools, don't ship console runtime to marketing, keep animated surfaces responsive on modest devices. Establish measurable budgets from P0 baselines.
7. Build: use repository pnpm commands and actual scripts (console currently supports typecheck/test/build); run changed-package checks first and broader integration gates once needed. Document precise commands and outcomes. Seven old preview tests are reference evidence only, not production acceptance.
8. Publication: working contact and booking, factual copy, open-source notices, SEO/link checks, deployment configuration and owner acceptance. Do not interpret local green tests as live launch approval.

## 10. Migration, rollback and definition of done

Ship reviewed slices rather than a route-wide visual rewrite in one merge. Keep compatibility redirects and temporary token aliases until all dependents move. Prefer additive metadata changes; back up and plan rollback before any schema/storage migration. Capture current behavior before replacing controls. If chat presentation fails a gate, retain the existing authenticated transport/rendering path until corrected; never substitute sample responses.

Completion means all in-scope routes use the shared system, runtime features and error semantics are preserved, approved visuals work in light/dark/mobile, avatar/history/contact/booking behavior is truthful, old routes remain usable, raw visual duplication is removed from migrated pages, and component/API/theme/motion documentation is current. Deferred product features (notably pause/resume) are explicitly listed, not implied by UI affordances.

Delivery packet: final component/token inventory; route map; data-source coverage; before/after screenshots; meaningful test results; dependency/license notes; backend migrations and rollback notes; remaining known limitations; exact candidate SHA and deploy instructions. Owner reviews before any merge/release step.

## 11. Ticket reconciliation and pending decisions

Recheck historical references LAR-10 design system, LAR-11 website, LAR-5 builder, LAR-63 detail, LAR-20 attention/activity/usage, LAR-7/LAR-50 installation. Their live status was not read or modified in this planning pass. Link implementation slices to existing work rather than creating duplicate tickets.

Decisions to resolve during P0 without blocking this written plan:
- New website location if another session has already established one.
- Canonical avatar metadata/store and backup contract.
- Authoritative event/usage sources and supported conversation restoration.
- Contact/booking destination, hosting and confirmed launch copy.

Default choices already settled: real-code implementation, shadcn + Tailwind, selected AI Elements over Eve, original fonts/palette, approved console structure and v6 marketing surfaces. No Figma dependency or new general-purpose UI framework is needed.

## Original planning hold state

This plan is stored as an external review artifact. No source edits, staging, commits, PRs, ticket writes or implementation dispatch occurred as part of this planning pass. Resume from P0 when the owner is ready; re-read the live repo because the other session is active.

## Commit handoff update

The owner subsequently authorized branch-only commits of the completed design work and a Linear kickoff ticket. This plan is now versioned with the design sources. Implementation, merge, rebase and deployment remain separate. Do not edit `services/console/components/Chat.tsx` or `ChatTranscript.tsx` until coordinated with the separate chat-refresh session. Installer and backup gates remain owned by that session. The earlier hold text records the planning pass, not the current commit authorization.

### Linear reconciliation during commit review

LAR-10 and LAR-11 were re-read on 2026-09-25 and remain Backlog. LAR-10 also contains an older alternative-theme/customization requirement; reconcile this separately from the approved light/dark baseline. LAR-11's older waitlist requirement is superseded by the owner update above; it still includes docs, booking, contact and consent/analytics beyond this visual prototype. Verify current repository placement and service ownership before implementation. Public website analytics must never leak into the self-hosted console. The kickoff coordinates these tickets rather than claiming their acceptance criteria are already complete.
