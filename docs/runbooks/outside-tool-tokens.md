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
is reachable. The current member flow stops at staging; it does not activate, rotate or revoke the
credential. An existing active credential remains the active revision until a separate, successful
Apply. Removing the declaration, revoking Lares custody and revoking the key at the outside provider
are separate actions.

## Signed outside-tool dispatch

When an outside tool is used, the agent sends a signed request to the Keeper broker. The broker
checks the current session, current member access, the accepted tool description set and any
required human approval before dispatch. The agent does not receive the bearer credential. A first
connection does not automatically trust new descriptions: a custodian must review and accept the
exact descriptions before a credential candidate can be staged.

The member-facing flow currently ends at staging. Apply, credential rotation, custody revocation,
provider-side key revocation and channel-specific approval verification are separate operations;
this flow does not perform them or claim that a staged candidate is active or reachable.
