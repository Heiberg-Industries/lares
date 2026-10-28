# Outside tools: declarations, credentials and reviewed descriptions

An agent definition can list outside tool servers under `outsideTools`. The Console's **Outside
connection settings** page edits those declarations. Saving a change marks it pending; **Apply saved
declarations** reconciles the definition with the runtime. The page shows saved and applied state
separately. If Apply's result cannot be confirmed, refresh the page before trying again. Applying a
declaration does not stage or activate a credential, and removing a declaration does not revoke a
held credential.

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
active and candidate pointers, advances the account generation, marks the account revoked, and
deletes the account's live encrypted credential revisions. Pending work and approvals tied to older
revisions no longer match. Non-secret operation and audit receipts remain with the account, and the
same account can be reconnected after a fresh review and consent. Revision numbers are never reused
for that account.

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
