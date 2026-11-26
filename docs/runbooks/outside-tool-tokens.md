# Outside tools: declarations, credentials and reviewed descriptions

## The outside tools pages

Open **Integrations**, then **Outside tools**. The owner uses three screens; there is no step list.

- **Directory** (`/integrations/outside`): one row per connector with its state, tool count, the agents that use it and
  the next action. **Add custom connector** starts a new one. Connections made before the directory existed appear here
  by themselves the first time the page is opened; nothing is migrated.
- **Add** (`/integrations/outside/new`): Name, Server URL and Authentication (Automatic, or Token), then **Continue**.
  Lares saves the connector, asks the server one unauthenticated question and says in one sentence what it found: no
  login, a token, or a sign-in page. Choosing **Token** stands: the connector is a token connector even if the server
  also offers a sign-in page (many servers accept an API key as well). A server found to use only a sign-in page is saved
  but cannot be used yet; sign-in comes in a later release. Its page has **Use a token instead** for a server that also
  takes a token. A failure shows one message and **Try again**, which continues with the saved connector.
- **Connector page** (`/integrations/outside/<id>`):
  - **Who can use it**: each agent's tools as a list with the kind (looks things up, or changes something) and a
    **Run without asking** switch, saved with **Save tools**. A tool that changes something always asks, unless the
    owner put it in the **Danger zone** at the bottom of the page (see "The danger zone" below).
  - **Give an agent access**: choose the agents, paste the token once, **Find tools**, choose the tools, **Give access**.
    The token is sent to each chosen agent's own locked store in that one action. An agent whose outside access is
    read-only and a tool that changes something: the page offers **Leave it out** (everything else is saved) or
    **Let <agent> ask first** (a second confirmation, owner only).
  - **Replace token**, **Rename** (the label only; agents and tokens are untouched), **Check it works** (asks the
    server again what it is; it sends no token) and **Remove** (see below).
  - A reserved empty place at the bottom of the page is for the danger zone, which comes in a later change.

**Remove** takes the connector off every agent, erases the token Lares holds for each of them, and retires the directory
row, so the name can be used again. Running agents restart, which ends their open conversations. The page says so once
before it removes anything. If it stops part way, press **Remove** again to continue.

The old addresses `/integrations/connect-outside-tool` and `/agents/<name>/outside-tools` lead to these pages. Editing
an agent's declarations by hand in the raw definition editor still works and is picked up by the directory.

An agent definition lists outside tool servers under `outsideTools`. Saving a change marks it pending; applying it
reconciles the definition with the runtime. Applying a declaration does not stage or activate a credential, and removing
a declaration does not revoke a held credential (the page's **Remove** does, in the order above).

Outside bearer credentials are kept by Keeper in protected, encrypted custody. They are not placed
in a named file for an agent container, and the agent does not receive the token. A credential
custodian can use the member page to select a saved connection, review the exact destination and
purpose, and explicitly consent to one bounded tool-description lookup. The browser clears the
entered credential after submission and saves only a non-secret recovery reference for an uncertain
request. Keeper does not return the credential in the discovery result.

After discovery, the Console shows the exact declared tool descriptions and input schemas that would
be reviewed. The custodian records that exact description set, accepts it, then stages the submitted
credential as a candidate. Keeper checks the current signed-in session, current agent access and the
same description hash at each step. If the definition or access changes, the old review is refused.
Editing an agent does not grant authority over another member's credential.

A staged candidate is **pending Apply**. It is not active and does not mean that the outside server
is reachable. The credential custodian can now apply the exact staged revision from the member page.
Keeper activates that candidate only when the current session, candidate revision, generation,
accepted description set, definition and access revisions still match. A token can be replaced while
the connection declaration stays unchanged; its new custody revision still requires its own Apply.
Until that Apply succeeds, an existing active credential remains active. The page reports custody
activation only; it does not prove that the agent runtime started or can reach the outside server.
If the page reloads while a candidate is pending, Keeper can recover the exact saved stage and
activation-review evidence for the current custodian and candidate. If that evidence is missing or
ambiguous, Apply remains unavailable. Refresh status; if the candidate remains pending, an
authorized custodian can refresh the connection, review a fresh discovery and stage a replacement
against the currently displayed candidate revision when Keeper permits it. If Keeper refuses that
replacement or the old evidence remains ambiguous, stop and use the existing custody resolution
process; agent editors do not gain credential authority.
Removing the declaration, revoking Lares custody and revoking the key at the outside provider are
separate actions.

## Stop use and remove held credential material

The current credential custodian can use **Stop use and remove held credential** on the member
page. Keeper checks the signed current session, current access to the exact agent connection, account
owner, account identity and displayed generation inside one locked transaction. It then clears the
active and candidate pointers, advances the account generation, marks the account revoked, deletes
the account's live encrypted credential revisions, and renames the account to a retired tombstone
name. Pending work and approvals tied to the old account no longer match. Non-secret operation and
audit receipts remain with the retired account. The plain connection name is free: connecting it
again starts a brand-new account with fresh counters, after a fresh review and consent.

This removes Lares's held credential material from live Keeper revision rows. It does not remove the
agent's connection declaration, revoke the credential at its provider, or rewrite prior database
backups. A database snapshot may retain encrypted revision bytes; backup expiry and any separate
key-retention policy determine how long those snapshots remain useful. To disable the key itself,
revoke it with its provider using that provider's own procedure. Lares does not make that provider
change for you.

If a removal response is uncertain, refresh custody status and act only on the displayed exact
connection and generation. The page does not retry the removal automatically. A removed credential
can be reconnected by reviewing the connection and destination again and giving fresh consent.

Whole-agent runtime-start rollback after custody activation is not established by this flow. A
successful Keeper Apply or removal proves only the stored custody state; it is not evidence that the
runtime started, or that all runtime state can be rolled back.

## Signed outside-tool dispatch

When an outside tool is used, the agent sends a signed request to the Keeper broker. The broker
checks the current session, current member access, the accepted tool description set and any
required human approval before dispatch. The agent does not receive the bearer credential. A first
connection does not automatically trust new descriptions: a custodian must review and accept the
exact descriptions before a credential candidate can be staged.

Credential Apply activates a staged custody revision. It does not apply an agent definition, restart
the agent, prove provider reachability, or revoke the previous key at the provider. If Apply's result
is uncertain, the page checks the current exact custody revision and asks you to refresh before
trying again; it does not blindly repeat the request. Custody revocation, provider-side key revocation
and channel-specific approval verification remain separate operations.

## Run without asking, per tool

Every outside tool call asks for approval unless you switched that one tool to **Run without asking**.
Only a tool that only looks things up can be switched on; a tool that changes something always asks, and
the console refuses to save it as switched on. On the connector page the switch starts on only for
tools the server itself marks as read-only; you can change any switch before giving access, and later under **Who can use it**. Switching a tool on records who did it and when.

A switched-on tool still asks when the agent has just read someone else's words in the same
conversation, and a result from any outside tool, including one you switched on, counts as someone
else's words for the rest of that turn. The switch is tied to the tool description you saw. If the server changes that
description, the tool asks again until you switch it on again, and the connection is paused until you
have reviewed the new description. Each run under the switch is written to the Keeper audit log
(who switched it on, when, the tool, the conversation) without the tool's arguments.

Changing a switch after connecting edits the agent's definition, like any other definition change.

### Who can switch it on, and what is recorded

- Only a member who could approve that agent's outside calls (use access to the agent) can switch a tool on. Editing access
  alone is not enough, and the keeper refuses it on every way of saving a definition. A save through the raw definition
  editor, which has no signed-in member behind it, is accepted only from the host or the installation administrator.
- The fingerprint of the description a switch is tied to is always taken by the keeper from the description the agent has
  stored (`outside_tool_pins`), never from what a page or a file says. A tool the agent has not yet read from the server
  cannot be switched on: ask the agent for a look-up once, then switch it on. The connector page switches on the lookups you chose as part of **Give access**.
- Switching a tool OFF needs no approver rights; anyone who can edit the agent's connections can do it, and an explicit empty list switches everything off.
- A save that says nothing about the switches (a reconnect, or an edit elsewhere) keeps the ones whose description is unchanged and ends the others; the connector page says which were ended.
- The record holds who and when. "Who" is the signed-in member's email address (the keeper's audit address), not a member id.
- Until a switch is applied, each save of the definition records the time again; once applied, a switch that did not change
  keeps its original who and when. A switch whose tool description changed counts as new and is recorded again.
- Switches are not part of the definition's identity hash, so switching a lookup on or off does not force the stored token to
  be reviewed and sent again.
- Each run is written to the audit log as started, then finished or failed. If the closing write fails, the keeper logs it
  loudly and opens a repair, so a run never stays "started" unnoticed.

## The danger zone: a tool that changes something may run without asking

A tool that changes something (sends, creates, deletes, pays) always asks first. There is one narrow way around that,
decided in ADR-0029: the red **Danger zone** at the bottom of the connector page.

- It lists only the tools that change something, for each agent that may use them. Each tool is switched on on its own;
  there is no switch for all of them.
- The switch stays disabled until you type the tool's name exactly. Switching off needs no typing.
- Only the installation's designated owner can use it, from a signed-in console session. Another owner of the
  organisation, a member, an agent, a card answer, a definition import or a definition an agent wrote cannot. Whatever a
  saved or imported definition says for it is thrown away by the keeper. It also needs an agent whose outside access is
  not read-only, and a tool the agent may already use.
- It is tied to the description the agent has stored for the tool, like a lookup's switch. If the description or the input
  shape changes, it is off again by itself, the tool asks first again, and the page says so in the same words as for a
  lookup. There is no expiry otherwise.
- Every switch on and off is written to the keeper audit log (`outside.danger.set`): who, when, the connector, the tool and
  the description fingerprint it was bound to. Every run under it is audited like a lookup's, marked as coming from the danger zone.
- A tool in the danger zone carries the red badge **Runs without asking: changes something** on the connector page, the
  agent's page and the outside tools list. The connector's summary line counts these separately from lookups.
- In a private chat on a chat door (Slack, Telegram) the tool is offered and runs without a card, for the claimed owner
  only. It is never offered in a shared room. After ANY outside text in the same turn, even the result of a lookup on the
  same connection, it is refused in words (a lookup may chain on its own connection; a changing tool never does). The
  ratchet, the member's spending limit and the description check all still apply.
- To check it live: on a connector with a tool that changes something, type its name in the danger zone and switch it on,
  see the red badge, ask the agent to use it in a Slack private message (no card appears), then switch it off and ask again
  (it is no longer offered there).
