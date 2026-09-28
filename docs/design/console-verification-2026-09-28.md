# Console verification and live test boundary — 28 September 2026

PR #32 remains a draft. This record separates local design checks from the
fresh-install and provider-backed evidence required by LAR-50. The approved
marketing site and its private repository are outside this review.

## Screen and state inventory

| Screens | Local state and interaction checks | Still needs live candidate evidence |
| --- | --- | --- |
| Home, Agents, agent detail | Empty/one/many agents, search miss, 23 capabilities, read failure, saved workflow state, access controls and pending effects were reviewed with synthetic data; current source tests cover the data adapters. | Runtime health, actionable approvals and spend require the authoritative backend in LAR-20. Real Keeper lifecycle remains unproved. |
| Create and edit agent | Purpose, identity/access, review, dirty close, retirement, exact-name deletion, avatar upload/reset, and unknown write outcomes have local browser/source coverage. | Create/edit/retire/delete and avatar persistence through a real Keeper and migrated installation. |
| Chat | Empty state now links to agent creation. Local tests cover owner/agent drafts, suggestions that do not send, Eve replay/ownership, approval presentation, scroll behavior and recovery. | One provider-backed turn, reload during/after a turn, approval replay and cross-agent isolation on the exact candidate. |
| Connections | Connection cards, mailbox add/remove, status and custody distinctions, Notion/CRM states, and permission controls retain their real data paths. The permission table now scrolls within the page on narrow screens. | Calendar and Gmail read checks, account add/remove and permission effects on the test installation. |
| Settings | Stacked sections and synchronized theme controls are retained. Quiet hours/time zone are read from the existing settings flow; links reach backup, writing style and alert routing. | Verify actual configured values and all linked controls in the installed console. |
| Activity and tools | Activity, Deadlines, Market watch, Saved preferences, Backup, Meeting follow-ups, Proactivity, Signals and Email writing style retain existing actions and empty/error states. The remaining operational pages now share the console heading and control treatment; wide tables scroll within their surface. | Exercise each tool with installed data, including empty, populated, failure and pending-write states where applicable. A source build does not establish these live states. |

The 28 September local build lists all application and API routes. Source testing
passed 670 tests in the restricted runner, then the 11 socket/database tests
passed with local runtime access. Typecheck and production build passed after
the page changes. This inventory is a code and local-review checkpoint, not a
claim that every installed screen has been observed.

## Proposed live window, before execution

1. Pin the exact PR #32 commit and its build-only console image digest. Review
   migration order and take a verified backup before `089_agent_avatars.sql`.
2. Provision two temporary, isolated test boxes and a fresh test account. Use
   the documented installer and wizard from a blank server. Use a temporary
   test hostname or Tailscale access; do not change `lares.heiberg.co` DNS or
   the deployed `lares.is` website. Do not reuse the deleted Hetzner server.
3. On the primary box, check authenticated desktop and phone layouts for every
   screen in the inventory. Create, edit, retire and delete a disposable agent;
   upload and reset an avatar; connect a disposable Google account and perform
   Calendar and Gmail reads; check the first brief or freshness heartbeat.
4. Run one bounded provider-backed web-chat exchange with that agent. Reload
   during and after a reply; inspect transcript and approval replay, new-chat
   isolation and the absence of the earlier step-marker text. Record provider,
   model, time, outcome and spend without copying credentials or private content.
5. Prove backup escrow and restore onto the second box. Compare manifests and
   the first brief/session records, then tear both boxes down and record provider
   resources actually removed. Append the observed result and defects to
   `docs/runbooks/golden-path-runs.md`; keep LAR-50 open until every criterion
   passes.

This window creates paid infrastructure and makes real provider calls. Its exact
candidate, account, cost ceiling, test hostnames and teardown owner must be
agreed before it starts. CI, the local fixture, and the September 25 partial
run do not replace it.

## Live checkpoint — 28 September

The owner approved a USD 5 API ceiling, provisioned a fresh Ubuntu server at
`89.167.43.7`, and pointed `lares.heiberg.co` to it. This supersedes the proposed
temporary-hostname step above for this test. One exact console image was
published from `6889c0e` and anonymously pulled by that server. The fresh
installer completed after a missing host Node/pnpm/toolchain prerequisite was
repaired; its real model check succeeded and box migration `089_agent_avatars.sql`
applied. Google sign-in, one restricted first-agent creation and a provider-backed
web-chat reply with transcript reload now have live proof. Agent creation reported
an unknown-outcome timeout although Keeper completed it. Owner-scoped tools first
failed because the generated console stack omitted the owner's identity; PR #32
now includes the renderer fix and the test stack was repaired. The owner then
connected the Google mailbox and approved access for the disposable agent. A
missing Keeper Google configuration and incorrect credential file modes needed
manual repair; the agent's Calendar and Gmail read request then returned counts
and survived reload. The deployed chat still renders two ordinary tool parts as
generic placeholders, now fixed in PR #32 source. Brief/heartbeat,
backup/restore, a clean installer run and all configured tool states still need proof.
The current evidence and remaining gates are in
[`golden-path-runs.md`](../runbooks/golden-path-runs.md). LAR-50 remains open.
