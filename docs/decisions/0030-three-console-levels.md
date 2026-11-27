# ADR 0030 — The console has three levels: owner, admin and member, decided in one place

**Date:** 2026-11-26
**Status:** Accepted 2026-11-26, built
**Supersedes:** —
**Amends / reconciles:** the part of `docs/member-authority.md` that said every shared console screen is for the designated owner alone.

## In plain language

1. Until now one person, the installation's named owner, could use the console's shared pages. Everyone else saw Chat, Your accounts and Your membership.
2. There is now a level in between: **admin**. The owner sets it per person on the Members page.
3. An admin may use the shared pages: Overview, Reviews, Agents (to see them), Writing style, Integrations, Outside tools, Deadlines, Meeting follow-ups, Saved preferences, Permission checks, Alerts, Quiet hours and delivery, Alert routing.
4. An admin may not use Members and roles, Backups or the General settings, and may not delete the installation's data. Those stay with the owner.
4a. For now an admin also may not create or edit an agent, connect a chat app to one, or change how freely it acts. The reason is in "What stays with the owner" below; it is a limit of this first step, not the owner's wish.
5. A member is exactly as before.
6. What an admin does is recorded as the admin, never as the owner.

## Decision

1. **Three levels, nothing finer.** Owner, admin, member. No per-person or per-page permissions.
2. **Owner means the named owner.** The installation's configured owner id, with the owner role, active: unchanged. A second person with the owner role is a member in the console, as before.
3. **Admin is a stored role.** `users.org_role` allows `admin` (`services/box/sql/040_admin_role.sql`). The one list of roles in code is `ORG_ROLES` in `packages/agent-kit/src/identity.ts`; the member schema and the keeper read it from there. Outside the console an admin is an ordinary (not limited) member: sharing, chat and private data follow the same rules as for any member.
4. **One function decides.** `mayUse(member, level)` in `services/console/lib/auth.ts`. Every page calls `requirePage(level)`, every action and route calls `requireAction(level)`, `actingAddress(level)` or `mayUse` directly, with the level written out at the call. No page, action, route or helper compares a role itself, and the middleware holds no role check.
5. **It fails closed.** A level that is not written out is unreadable to the inventory and fails its test. A level the function does not know is read as owner. A role it does not know holds no more than member. No configured owner id means nobody is the owner.
6. **The default is owner.** Each page, action and route is placed at its level on purpose, in lists in `services/console/tests/actions/action-inventory.test.ts`. Something new that is not placed fails that test.
7. **An action follows the page it serves, and takes the stricter level when two pages use it.** Owner-only actions on admin pages are listed in the same test, each with its reason. The page hides their buttons from an admin; the action refuses whatever the page shows.
8. **Identity is the person's own.** The address handed to the keeper and written to "changed by" fields is the signed-in person's own address, looked up after admission. Where the keeper compares that address with its configured administrator, an admin is refused: the keeper never gives an admin more than the console does.
9. **Only the owner changes a role**, only between admin and member, never their own. The member store refuses anything else (`setRole`), so it can neither make nor remove an owner, and the last-owner rule is untouched.
10. **One keeper rule changed.** The outside-connector directory (read, add, rename, check) accepts the named owner or an active admin. Removing a connector, the danger zone and widening an agent's outside access stay with the owner in the keeper.

## What stays with the owner, and why

- Members and roles, backups, the General settings: the owner's decision.
- Deleting an agent, ending a conversation, removing an outside connector: they delete data.
- **Creating and editing an agent.** The keeper saves whatever definition the console sends and has no check of its own on who sent it. Through that one request a person can give an agent more access (including outside access, which is owner-only elsewhere), change how freely it acts, and rewrite what it is told to do with the owner's mail and calendar. Until the keeper checks the sender's right to edit that agent and refuses a non-owner's widening, the form is the owner's.
- **A chat app's credentials.** Whoever supplies a Slack app's signing secret can send the agent messages that look like the owner's. Storing or replacing them is the owner's.
- **How freely an agent acts** (ask first, or act by itself), and accepting an outside tool's changed description.
- The claim step of a chat door: the keeper records whoever asks as the address the agent answers to.
- Using the installation's Notion key through clipping (reading a database, importing, adding properties).
- Sharing or adopting an agent, an agent's own model key, the installation's Notion key and Notion settings, the test brief, the owner's message inbox.
- Answering an approval stays with each agent's owner; answering a proposed change to the installation's notes stays with the owner.

## To open agent editing to admins later

The keeper has to decide for itself, from the signed-in session and not from the console's word: that the sender holds edit access to that agent; that a sender who is not the owner cannot add or raise a grant, autonomy level, skill, outside tool or egress setting; and that door credentials on a claimed door are replaced only by the owner, or the claim is cleared when they change. The agent form's parts already render for a person who is not the owner.

## Consequences

- Every service must carry the widened role list before the first person is made admin: a service on an older version cannot read a person whose role is `admin`. They ship in the same release.
- The proof is the action inventory (`services/console/tests/actions/`) and `services/console/tests/console-levels.test.tsx`, which runs every page, action and route as owner, admin, member and an unknown role.
