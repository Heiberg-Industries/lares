# Console redesign implementation ledger

2026-09-25. Implementation in progress; this is not completion of LAR-10 or LAR-50.

## Integration base

Isolated branch `codex/console-redesign` starts at main `166613e` and locally integrates
Agents draft PR #29 (`c63c316`) and chat draft PR #20 (`c5ae62e`). Neither upstream
PR is merged or marked ready by this work. Protected main is untouched.

The approved console and marketing are one design package. Marketing PR #31 and
Orbis PR #13 remain separate from the console implementation and live release.

## First review slice

- Shared `@lares/ui` source exports for shadcn Button, Input, Dialog and Tabs, geometric
  identities, page headers, empty/error states and status labels. Existing font licenses
  and shadcn MIT notice retained. Radix, Lucide, CVA, clsx and tailwind-merge versions
  follow the approved reference package. No new chat transport or analytics.
- Tailwind 4 PostCSS utilities with explicit shared-source scanning. **No preflight**:
  legacy operational pages keep their current reset while migrated pages use the shared
  patterns. Shared font aliases avoid the recursive Tailwind font-variable mapping.
- Responsive navigation: Home, Chat, Agents, Activity, Connections; Tools heading;
  Settings. Mobile Radix dialog, skip link, keyboard focus return, shared light/dark/system
  preference and inline initial theme selection. Existing deep links retained.
- `/agents`: real registry, display names/role icons, search, all capabilities expandable,
  workflow states with an explicit unavailable state. No fake health or approval count.
- `/agents/[name]`: Overview, Access, Schedules, Activity. Access uses the existing
  permissions-board adapter, preserving Vault area keys and always-ask constraints.
  Read/plain-write rows have no ineffective permission switches. Controls serialize
  writes, wait for the result, and require a reload after an unconfirmed outcome.
- `/`: first Home composition of recorded failed workflows, registered agents and current
  permission checks. Aggregate actionable approvals, runtime health and usage remain
  functional gaps; none are represented by invented values.
- `/activity`: current permission evidence, exact agent filter before LIMIT, stable id
  cursor, source-error state, and a link to Signals. It is deliberately labelled policy
  evidence, not a complete action/execution history. Legacy audit is no longer this view.
- `/settings`: working entry links for shared defaults, backup, writing style and alert
  routing. Connections retains mailbox/meeting entry points. Existing pages remain usable.
- Console image dependency closure corrected for UI, notion-sync and junk; workspace
  package dependency links are copied into the build stage. Next/Eve telemetry disabled.

## Data coverage

| Surface | Source | Meaning and limitation |
| --- | --- | --- |
| Agent identity/access | `agent_registry` | Last registered definition, not a current runtime health probe. Read failures are distinct from zero agents. |
| Workflow state | `workflow_jobs` grouped per agent/status | Waiting can mean an event, not a human approval. Failed counts are recorded failed jobs, not a new incident feed. |
| Permission controls | `getBoardRows` + `ratchet` | Strict read of registry/current levels/policy evidence on detail. Existing authenticated `setAutonomy` writes unchanged. |
| Permission evidence | `approval_events` | Policy decision per call. Does not establish action completion or whether a card is still actionable. |
| Schedules | authenticated `builderData` / Keeper definition | Saved enabled flags, not next-run/health proof. Unavailable Keeper is visible, never an empty schedule. |

The legacy `confirmations` join is not used as an aggregate approval inbox. The
`approval_asks` ledger alone also cannot establish a currently actionable card and
its owning live conversation. That mapping and usage data remain LAR-20 work.

## Remaining redesign slices

1. Create/edit journey, review step, dirty navigation, saved/pending effects and lifecycle
   dialogs. Existing builder and retire/delete actions are preserved but not yet redesigned.
2. Avatar upload/reset with authenticated storage, image processing and backup/restore;
   this slice ships default geometric identities only.
3. Finish populated chat transcript presentation and scroll behavior. The header avatar
   switcher, empty state, suggestions, multiline composer and per-owner/per-agent tab drafts
   are now implemented over the unchanged Eve session/approval transport.
4. Full Connections, Settings and specialist tool layouts; Home health/usage/actionable
   approvals and broader Activity source coverage. Advanced routes stay accessible meanwhile.
5. Final visual/functional acceptance against the approved preview, exact-SHA CI and
   owner review before merge/release. LAR-50 stays In Progress for the full install proof.

## Local verification

Browser review uses the real built Next console with its normal session verification and
an isolated loopback Postgres container, `lares-console-design-review`. Synthetic agents
include zero/one/many states, a long display name, and 23 capabilities. A temporary
loopback-only proxy issues the test session; no bypass, fixture data, credential or review
server is shipped in the application. No live Keeper or provider is connected.

- `pnpm -C services/console run test --maxWorkers=1`: 61 files, 671 tests passed.
- `pnpm -C services/console typecheck`: passed.
- `pnpm -C services/console build`: passed; existing Next middleware/Edge warnings remain.
- Authenticated browser review: desktop, 390px mobile and 768px tablet; light/dark,
  persisted theme, Escape/focus return, zero/one/three agents, 23 capabilities, search
  miss, and actual registry-read failure. No horizontal overflow in these reviewed views.
- Local image build was stopped during dependency installation when disk headroom was
  about 6 GB and competing database checks timed out. Those checks passed serially
  without timeout increases. The Dockerfile changes still require a completed image
  build before merge; no image was published or deployed. The subsequent Linux CI build
  passed at `4aaddb6` (run 36164095613, publishing disabled). That build predates the
  visual correction pass below.
- No provider-backed turn, real Keeper lifecycle, avatar persistence, install/restore,
  or full-route design acceptance is claimed by this slice.

## Screenshot correction pass — 25 September

- Matched the reference's 200px sidebar, 24px page heading, left alignment, muted navigation,
  Tools divider, warm table headers and softer card borders. Overrides are console-only.
- Restored Settings as stacked sections, with actual quiet-hour/time-zone reads and inline
  synchronized light/dark/system controls. Quiet hours remain managed through the existing
  enforced settings flow; the reference's cosmetic on/off switch is not reproduced.
- Restored Home's full-width agent table and Activity's compact tabular presentation.
  Policy records are still labelled as permission decisions, not completed work.
- Connections now use cards, preserving status details, account removal and add-account flow.
- Chat now opens a conversation with a keyboard-accessible avatar menu, centered empty state,
  suggestion chips that only fill the draft, and multiline composer. Drafts are isolated by
  owner and agent in tab storage. Eve resume/reset/send/approval logic is retained.
- Deadlines, Market watch and Saved preferences share the page/control styling; their full
  information architecture still needs refinement. Fixed the disposable review server's
  missing owner configuration and installed existing tool/settings schemas locally.
- Agent creation has a designed unavailable state; the phased wizard remains unfinished.
- Added checks for non-sending suggestions, agent-isolated drafts and independent Settings/
  sidebar theme synchronization. Browser review covers desktop Settings light/dark, mobile
  Settings/Chat, avatar menu, and the restored Deadlines page. No provider call was made.

This is a visual correction pass, not full redesign acceptance. LAR-50 remains open.

## Editor and operational follow-through — 25 September

- Creation is a three-step dialog over the agent list: purpose, identity/access, review.
  Instructions, model, access/skills and schedules remain editable in disclosures. The
  final review names the grants and enabled schedules; creation still uses the existing
  authenticated Keeper action. No provider or lifecycle adapter was replaced.
- Edit pages retain saved/pending effects. Closing a changed create dialog, clicking away
  through a link, or reloading warns about unsaved changes. Browser history navigation is
  not intercepted. Retirement has a confirmation dialog; deletion requires the exact slug.
  Unknown write outcomes disable subsequent writes until authoritative state is reloaded.
- Agent images use migration `089_agent_avatars.sql`, authenticated upload/reset/read paths,
  decoded PNG/JPEG/WebP input (2 MB limit), 256px WebP normalization and stripped metadata.
  Images are database rows with an agent-definition foreign key and follow database backups.
  Missing pre-upgrade avatar storage falls back to geometric identities. Apply the normal
  migration runner before using uploads; do not hand-apply a migration on a deployed box.
- Chat now distinguishes owner/agent messages, follows new output only while near the bottom,
  restores per-owner/per-agent tab scroll position, and offers Jump to latest. Existing
  plain-text safety, approval handling, replay, resume and draft isolation remain intact.
- Deadlines and Saved preferences show current items first, with add/import/maintenance
  controls in disclosures. No operational action was removed or replaced with sample data.
- Local avatar dump/restore preserved bytes; deleting its synthetic parent removed the image.
  This narrow test is not the installation-wide backup/restore proof required by LAR-50.

The earlier remaining-slices list is historical: editor, lifecycle, image storage and chat
presentation are implemented by this pass. Broader Home health/usage/actionable approvals
and completed-action Activity coverage need authoritative backend data (LAR-20), not more
styling. The console must not imply these unsupported states are already available.

The local browser's create dialog uses an external read-only Keeper fixture for layout
review. It refuses all writes and is not included in the repository or image. Live Keeper
create/edit/retire/delete and provider-backed chat on the final candidate remain release
verification, separate from automated/local design checks. LAR-50 remains In Progress.
