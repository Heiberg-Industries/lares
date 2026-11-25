# ADR 0029 — Outside tools that change something may run without asking only through a per-tool danger zone

**Date:** 2026-11-24
**Status:** Accepted 2026-11-24, built
**Supersedes:** —
**Amends / reconciles:** ADR-0019, the rule that a tool which changes something always asks the owner first (for the part that says "can never be switched on"). The rest of ADR-0019 stands.

## In plain language

1. Today an outside tool that "changes something" (sends, creates, deletes, pays) always shows the owner a card first, with no exception. Only tools that merely look things up can be set to run without asking.
2. The owner's direction is privacy first by default, and overridable per connection. The default stays exactly as it is: a changing tool always asks.
3. But an owner who knowingly wants one changing tool to run unattended should be able to say so, deliberately, once, and be able to see and undo it. Refusing that forever pushes people to work around Lares.
4. So there is one narrow way to do it: a red "danger zone" at the bottom of the connection's page in the console. It works one tool at a time (never a blanket switch). The owner types the tool's name to confirm. Lares records who and when in the audit log, shows a red badge on the tool from then on, and switches the permission off by itself the moment the tool's description changes.
5. Nothing an agent says or does can use this. Only the owner, in the console, can.

## Context

ADR-0019 lets an owner switch a single lookup to "run without asking", bound to the exact description the owner saw, recorded with who and when. It deliberately forbids the same for a tool that changes something: the validator refuses a trusted tool that is not marked as only looking things up, and a changing tool always raises a card.

That rule protects people, and it stays the default. It is also absolute in a way that has a cost: an owner with a tool they trust (a notes tool, an internal queue) cannot let it run unattended in a chat door, where there is no card to answer. The only choices today are "it asks every time" or "do not connect it". The owner has asked for the default to stay private and for the rule to be overridable, per connection and per tool, with the override visible and recorded.

Other facts that bound the design:

- A description change already pauses a tool (the pin check, ADR-0019 rule 10). Any new permission must follow it.
- The never-widen check on grants and skills stays: what an agent's definition does not grant, nothing grants.
- Only the owner, through the console, decides what outside tools may do. An agent's output is never an instruction to widen anything.

## Decision

1. **The default does not change.** A tool that changes something asks the owner first, in every door, until the owner uses the danger zone for that tool.
2. **One place to override.** A red section, "Danger zone", at the bottom of an outside connection's page in the console. It lists the connection's tools that change something. It is the only way a changing tool can run without asking.
3. **Per tool, never blanket.** Each tool is switched on separately. There is no "all tools of this connection" and no "all connections" control.
4. **The owner types the tool's name to confirm.** The control stays disabled until the typed name matches exactly. This is a deliberate friction, not a security boundary on its own.
5. **Only the owner, only in the console.** The action is refused for anyone who is not the installation's designated owner (another owner of the organisation cannot use it either), for any agent, and for any request that does not come from a signed-in console session. A conversation, a card answer, an agent's own definition or a definition import can never set it.
6. **Audit-logged.** Every switch on and every switch off writes an audit entry with who, when, the connection, the tool and the exact description fingerprint it was bound to.
7. **Shown, always.** A tool in this state carries a red badge ("Runs without asking: changes something") wherever the tool is listed (the connection page, the agent's page, the overview), and the connection's summary line counts it separately from lookups.
8. **Bound to the description.** The permission is bound to the same per-tool fingerprint as a lookup's. If the tool's description or input shape changes, it switches off automatically, like every other trust, and the owner is told in the same words used for lookups.
9. **The ratchet and spending limits still apply.** A changing tool that runs unattended is still subject to the agent's ratchet level, the member's spending limit and the description check. This record adds no way around them.
10. **The never-widen check is unchanged.** A tool can only be in this state if the agent's definition already allows that tool and its outside grant is not read-only. The validator keeps refusing a trusted tool marked read-only-grant-conflict as it does today; the new state is stored as its own list, separate from the lookups' list, so the existing "trusted tools must be lookups" check keeps meaning what it says.
11. **Doors.** In a private chat on a door, a changing tool in the danger zone is offered under the same rules as a trusted lookup (the claimed person, a private chat, no text read from outside before the call). In a shared room it is not offered, whatever its state.
12. **Per-connection override of the wider defaults** (which doors, which agents, sensitivity levels) is a separate decision with the channels and sensitivity levels work. This record covers only the "changes something may run without asking" override.

## Consequences

- **Good:** an owner can run a trusted changing tool unattended without leaving Lares' guard rails; the choice is deliberate, narrow, visible and reversible; every other default stays private.
- **Cost:** a new stored list on the agent's connection record, a new keeper action restricted to the owner, a console section, an audit entry type and a badge. Tests: the owner-only check, the typed-name confirmation, the automatic switch-off when a description changes, the audit entry, and that a definition import or agent output cannot set it.
- **Risk:** an owner may switch on a tool and forget it. The red badge and the count on the summary line are there so it stays in view; the automatic switch-off covers the server changing under them.

## Owner's answers (24 November 2026)

1. **No expiry.** The permission stays until the owner switches it off or the tool's description changes; the red badge keeps it in view.
2. **Only the designated owner.** Where an organisation has several owners, only the installation's designated owner can use the danger zone; no second approval is needed.
3. **Connection page only.** The switch lives only on the connection's page; the red badge still shows on the agent's page and the overview.

## Cross-references

- ADR-0019 (outside tools, the description pin, per-tool trust), ADR-0023 (member authority), ADR-0026 (who pays for a door turn).
