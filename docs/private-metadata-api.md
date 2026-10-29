# Private metadata device API v1

This contract supports the bounded Mac private-metadata transfer. It does not authorize a
device or agent by a caller-supplied member identifier. The Console creates the dataset for
the signed-in member; Keeper issues the upload credential only after that member accepts the
currently configured descriptor fingerprint and purpose.

The Console management actions are authenticated server actions. They derive the member from
the current session cookie and rely on the framework's server-action origin checks; they do
not accept a member ID or session token from the browser as authority.

## Upload credential

The member receives one opaque 43-character base64url upload token after explicit consent.
The Mac CLI stores it in its protected local credential store. Send it only to the configured
private-metadata server over HTTPS. The server must never persist or log the token.

## Server validation

`POST /api/private-metadata/credential` accepts an `Authorization: Bearer <token>` header and
JSON body containing exactly one field, `scope` (`upload` or `read`). Requests with extra
fields are rejected. The request body is limited to 256 bytes.

On success the response is `200` with `{"ok":true,"accountId":"…","datasetId":"…","scope":"upload|read","generation":0}`.
The identity and generation are resolved by Keeper from the bearer; callers cannot supply
them. Use `upload` only for the upload operation and `read` only for lookup. The two tokens
are distinct. The read token is held in Keeper custody and is never delivered to the Mac or
agent.

Invalid, expired, wrong-scope, revoked, erased, or stale-generation credentials receive the
same `401` response: `{"ok":false,"code":"credential-refused"}`. A Keeper or database outage
returns `503` with `{"ok":false,"code":"unavailable"}`. Responses are private and not cacheable.

Validation checks current account ownership, status, and generation when the request begins.
Revocation prevents later requests; it does not promise to cancel a request already
authorized. A server must use only the returned opaque dataset identity for that request and
must not infer an owner from an agent, connection, or model-supplied identifier.
