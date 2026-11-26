# ADR 0030 — The console has three levels: owner, admin and member, decided in one place

**Date:** 2026-11-26
**Status:** Accepted 2026-11-26, built
**Supersedes:** —
**Amends / reconciles:** the part of `docs/member-authority.md` that said every shared console screen is for the designated owner alone.

## In plain language

1. Until now one person, the installation's named owner, could use the console's shared pages. Everyone else saw Chat, Your accounts and Your membership.
2. There is now a level in between: **admin**. The owner sets it per person on the Members page.
3. An admin may use the shared pages: Overview, Reviews, Agents, Writing style, Integrations, Outside tools, Deadlines, Meeting follow-ups, Saved preferences, Permission checks, Alerts, Quiet hours and delivery, Alert routing.
4. An admin may not use Members and roles, Backups or the General settings, and may not delete the installation's data. Those stay with the owner.
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
- The claim step of a chat door: the keeper records whoever asks as the address the agent answers to. An admin sets the door up; the owner does the claim.
- Sharing or adopting an agent, an agent's own model key, the installation's Notion key and Notion settings, the test brief, the owner's message inbox.
- Answering an approval stays with each agent's owner; answering a proposed change to the installation's notes stays with the owner.

## Consequences

- Every service must carry the widened role list before the first person is made admin: a service on an older version cannot read a person whose role is `admin`. They ship in the same release.
- The proof is the action inventory (`services/console/tests/actions/`) and `services/console/tests/console-levels.test.tsx`, which runs every page, action and route as owner, admin, member and an unknown role.
