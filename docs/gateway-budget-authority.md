# Keeper gateway budget authority

This is an inactive production integration. The keeper exposes a separate bounded
HTTP Unix socket and the console relays the two exact HTTPS POST paths
`/v1/gateway-budget/admit` and `/v1/gateway-budget/settle`. The console forwards
original bytes and signatures, holds no gateway signing key, claims no browser or
email actor, and never retries. Existing HTTPS termination supplies TLS.

The optional keeper configuration `gatewayBudget.serviceKeyFile` names the existing
protected service key shared with the gateway. It contains exactly 32 raw bytes,
is root-owned and regular, and cannot be writable by its group or accessible to
others. This code never generates or copies a key. Missing or unsafe custody
refuses the service. No console environment variable contains that key.

The production factory binds its recovery observation to the same prepared
financial journal used by its admission writer. It matches a persisted ticket's
installation account, endpoint generation and raw epoch against the journal's
committed open and approved installation account and active window. A matching
database epoch alone never establishes recovery authority. This observation is
discovery only: the writer still checks the complete database projection inside
its owned transaction before mutation. The test constructor can inject a witness
for focused tests; there is no production setting for one. This does not open a
closed account, unfreeze a journal, activate spending, or establish restore
acceptance. Reviewed prices, runtime ticket preparation after final prompt-cache
shaping and the remaining activation dependencies are still required.

## Wire and transaction boundary

Version 1 uses canonical JSON: recursively sorted keys, ASCII escapes, compact
separators and safe integer numbers. The keeper requires those exact bytes, which
also rejects duplicate fields, invalid UTF-8 and alternate numeric encodings.
Bodies are at most 8192 bytes. Domain-separated HMAC-SHA256 binds direction, POST,
the exact path and the hash of the exact body. Replies are signed independently.
The whole connection and relay have a three-second deadline. No redirect, retry,
alternate route, query or encoded path variant is accepted.

Admission discovers the persisted ticket's identity, then releases that database
connection. The store freshly verifies console/source authority and policy before
locking installation account, member account, binding and attempt. The gateway
cannot supply member, agent, incarnation or credential generation as authority.
Only acknowledged admission creates the process-local one-use dispatch permit.
The keeper consumes it synchronously before another await, then commits an opaque
grant commitment in a second store-owned transaction before signing allow. The
commitment covers exactly `version`, `nonce`, `requestHash`, `profileHash`,
`endpointHash`, `keyFingerprint`, `purposeAlias`, `attemptId` and `bindingId`, with
the `lares.gateway.grant.v1` domain. The random 256-bit nonce prevents identity
guessing from the stored digest. Raw echoed identity is not retained in that table.

A duplicate grant, failed or unacknowledged commit, expired response, disconnect or
lost allow never issues another permit or releases the reservation. Both
transactions use the store's owned transaction mechanism; a borrowed pool client
is not a replacement. The keeper uses a separate small pool with bounded
connection, lock and statement waits. Expiring HTTP work cannot authorize a late
allow even if the database subsequently finishes an uncertain admission.

## Immutable fixed pricing

SQL024 adds a nullable `pricing_profile` to each immutable gateway binding. Legacy
bindings are not assigned invented prices and cannot pass this gate. A reviewed
snapshot has exactly these fields:

```json
{
  "version": 1,
  "capabilityHash": "<SHA256 of the exact reviewed capability profile>",
  "format": "openai",
  "limits": {"inputTokens": 1000, "outputTokens": 1000},
  "usdPerMillionTokens": {
    "input": "10", "output": "90", "cacheRead": "5", "cacheWrite": "0"
  }
}
```

These numbers are synthetic test data, not provider prices or supported model
limits. Provisioning must bind real reviewed values to the exact capability hash.
The input bound is the total of all chargeable input categories; it must come
from a reviewed provider/capability bound, never a guessed tokenizer or request
byte count. The output bound covers all charged output, including thinking where
applicable. The fixed rates must cover the full permitted context range. Tiered
prices, extra provider fees and unreviewed cache classes are unsupported.

All rates are canonical nonnegative decimal USD per million tokens. The supported
rate range ends at 1,000,000 USD per million; each explicit token bound ends at
1,000,000,000. These implementation bounds keep all valid wire usage within the
ledger's monetary range. Maximum liability is total input bound times the highest
allowed input-category rate, plus full output bound times the output rate. Its
canonical value must equal the binding's immutable `maximum_liability`.

OpenAI input includes its cached-read subset, so ordinary input is
`inputTokens - cacheReadTokens`; cache writes must be zero. Anthropic ordinary
input excludes its separate cache-read and cache-write categories, so all three
input categories are charged separately. Prices use integer arithmetic: sum all
rate/count products, divide by one million, then round **up once** to the ledger's
10^-18 USD unit. A positive sub-unit charge is never truncated to zero.

## Terminal settlement and recovery limits

Settlement verifies the signed native counts, receipt hash and exact persisted
grant commitment. It reads the same immutable pricing snapshot after rotation,
window changes or member erasure. It does not require an active binding or erased
credential/purpose metadata. The store independently correlates immutable attempt
coordinates. The gateway cannot submit a USD amount or a nondispatch refund.
Missing or malformed terminal evidence retains the reservation. Valid observed
usage is priced even above reviewed bounds; charges above the reservation reach
the existing conflict/full-liability/freeze path. Repeated identical receipts are
idempotent; conflicting receipts retain the greatest observed liability.

The witness observation interface alone does not provide a write-ahead financial
journal. A real recovery implementation must participate before financial commits
and integrate provisioning, member removal/erasure and the explicit restore path.
It must freeze independently before database replacement and refuse missing or
ambiguous external evidence on a replacement host. No restoration, epoch update,
window change or rotation may silently open fresh caps or discard unknown use.

Focused protocol, pricing, relay/socket and real PostgreSQL tests exercise this
integration. The manual keeper/neutral-image workflow must also prove SQL024 in
the actual runtime images before merge. Passing these checks establishes the
inactive integration, not production activation or restore acceptance.
