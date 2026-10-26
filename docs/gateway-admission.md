# Gateway admission adapter contract

This is an engine adapter for the digest-pinned LiteLLM 1.101.6 image. It is not
an enabled production spending authority. Account provisioning, reviewed prices,
maximum liability calculation, durable admission and a recovery witness outside
the restored database are required before activation. An absent authority refuses
model calls. The isolated CI fixture is never a production configuration option.

The included gateway uses the original upstream image, with engine Python files
mounted read-only. The native CLI prepares its database before the outer ASGI
application forwards the native application lifecycle and authentication. Existing
external gateways remain operator-controlled: the engine does not administer,
wrap, replace or fall back from them automatically.

The rc.13 installation and member-budget path uses the included gateway only; the
installer does not offer an external-gateway choice. A repair retains an older
configured endpoint, but that does not make it part of rc.13's Keeper-enforced
member-budget path. No external gateway is changed or automatically adopted.

## Version 1 signing and admission

The service uses a separate protected file containing exactly 32 raw key bytes.
Every RPC uses HTTPS with ordinary certificate verification, no redirects and no
retry. `SSL_CERT_FILE`, if configured, supplies a trusted CA file. There is no TLS
verification bypass. The method is `POST`; the fixed paths are
`/v1/gateway-budget/admit` and `/v1/gateway-budget/settle`.

`canonical(x)` means UTF-8 JSON with recursively sorted object keys, no insignificant
spaces, ASCII escapes and no nonfinite numbers. The protocol contains ASCII strings
and integers no larger than JavaScript's exact integer range. The header
`x-lares-signature` is lowercase hexadecimal HMAC-SHA256 of:

```text
canonical(["lares.gateway.rpc.v1", direction, "POST", rpcPath, sha256(exactRpcBodyBytes)])
```

`direction` is `request` or `response`. Responses must be HTTP 200 and have a valid
signature, verified in constant time. Whole RPC duration is at most 3 seconds;
request and response bodies are at most 8192 bytes. An unacknowledged response is
not retried and never restores a spending right.

The admission body has exactly these fields:

```text
version: 1
nonce: fresh 64-character lowercase hexadecimal request nonce
ticket: prepared intent ticket, 43 base64url characters
requestHash: hash of the exact captured model request
profileHash: sha256(canonical(reviewedProfile))
endpointHash: selected gateway endpoint identity
keyFingerprint: sha256(native virtual key UTF-8 bytes)
purposeAlias: requested purpose alias
```

The model request hash is hexadecimal SHA256 of:

```text
UTF8("lares.gateway.raw-request.v1") || NUL || ASCII(method) || NUL || ASCII(path) || NUL || rawBodyBytes
```

The caller must hash the final bytes after prompt-cache shaping and send those
same bytes. Model routes accept no query or encoded-path variants. The intent
ticket travels in `x-lares-budget-intent`; it is removed before native LiteLLM
receives headers, so native request snapshots cannot retain it.

An allow response contains exactly `version`, `state: "allowed"`, `nonce`,
`requestHash`, `profileHash`, `endpointHash`, `keyFingerprint`, `purposeAlias`,
`attemptId`, `bindingId` and integer `validForMs` between 1 and 3000. All echoed
fields must match. IDs are UUIDs. Local validity ends at the earlier of the
request's five-second monotonic deadline and RPC-start plus `validForMs`; server
wall clocks are not used to extend it.

The authority must derive member, agent, incarnation, credential generation,
current authority and recovery state from the persisted ticket and binding. None
is established by caller billing metadata. It must commit admission and consume
its local dispatch permit before signing the allow. A replay must not mint another
allow, including when the first response was lost.

## Fresh policy and physical dispatch

After admission completes, the gateway opens a fresh native database transaction
and locks the exact native key, user, team, membership and member-budget rows.
It verifies current identity, expiry, model permissions, membership and configured
caps. Missing rows/caps or unsupported policy relationships refuse. No native
database lock crosses the gate RPC.

The row locks establish the policy check's order relative to native revocation.
They remain held until the guarded physical send returns response headers or
fails, with a maximum transaction lifetime of 35 seconds. Physical response-header
time is independently bounded to 30 seconds, even if an SDK supplies a longer
timeout. Cleanup is bounded to 2 seconds. The one-use request right is consumed
synchronously before the physical transport's first await. Failed, expired,
cancelled and uncertain outcomes never rearm it. This does not make the two
databases one atomic budget authority; the admission ledger owns reservations.

Both model formats use target-specific injected clients. Only the reviewed
Anthropic-envelope to OpenAI-completion translation may share one request state
across two deployment-hook phases. The final HTTP guard applies to SDK retries,
native reconnections and message-reformat loops. Redirects, alternative routes,
unreviewed callbacks, response caching and Rust execution are disabled/refused.

The pinned native model-budget limiter and database cost logger remain installed.
The adapter verifies the budget/service/proxy hooks against their native owner-held
objects and records callback identities at startup. The separate native async cost
logger and four router accounting methods are admitted only in their reviewed event
lists. Native lazy promotion may add the same approved primary objects to event
lists; replacement objects and unknown callbacks refuse. Native shadow evaluation
can create detached provider requests, so its exact hook class is removed from all
nine callback registries before readiness. A subclass or later reintroduction
refuses; no shadow hook is invoked during removal. These checks do not establish
that native accounting and the admission ledger are one atomic authority.

## Terminal receipts

Only complete provider usage settles in this adapter. There is no zero-cost or
affirmative-nondispatch refund path. Missing terminal usage, cancellation, malformed
responses, failed cleanup and uncertain delivery retain the reservation.

The injected transport observes actual uncompressed provider JSON/SSE bytes before
SDK normalization. It requests `Accept-Encoding: identity`; a compressed response
retains the reservation. Evidence is transient and bounded to 1 MiB and 120 seconds.
A declared terminal stream tail is drained for at most 2 seconds before its marker
is yielded, detecting late/conflicting bytes. No prompt or response content enters
a receipt or log.

OpenAI streams require consistent response IDs, a single completed choice at index
zero, a valid final aggregate usage and `[DONE]`. Anthropic streams require valid
initial input/cache counts, a final delta with stop reason and cumulative output,
then `message_stop`. Invalid or conflicting events poison the receipt. Native
processing must also complete normally; synthesized SDK counts are never charged.

The settlement body echoes `version`, `nonce`, `requestHash`, `profileHash`,
`endpointHash`, `keyFingerprint`, `purposeAlias`, `attemptId`, `bindingId`, followed
by `kind: "terminal-usage"`, `format`, `usage` and `receiptHash`.
`receiptHash = sha256(canonical(body without receiptHash))`.

`format` describes the actual provider wire format, regardless of caller lane:

| Format | `inputTokens` | `outputTokens` | `cacheReadTokens` | `cacheWriteTokens` |
| --- | --- | --- | --- | --- |
| `openai` | `prompt_tokens`, including cached input | `completion_tokens` | cached subset of input | zero in this reviewed format |
| `anthropic` | `input_tokens`, excluding cache read/write categories | final cumulative `output_tokens` | separate cached read input | separate cache creation input |

The authority must apply its reviewed profile prices to those semantics and
construct the ledger's fixed receipt; the gateway supplies no claimed USD amount.
Settlement is one attempt. A lost acknowledgement leaves the outcome unconfirmed
to the gateway: the authority may already have committed the settlement. The
gateway does not retry or infer a refund; separate recovery inspects the durable ledger.

## Verification

`python3 -B services/box/tests/gateway-admission.test.py` exercises the wire contract,
actual embedded fixture framing and raw request hash without Docker or providers.
The manual `keeper and neutral runtime images` CI workflow runs
`services/keeper/tests/gateway-admission-image.probe.py` in the original pinned
image against isolated HTTPS fixtures. Passing source tests alone is not evidence
that the pinned image's hooks, clients or stream handling work. Neither probe
proves production price liability, durable account provisioning or restore safety.

The manually guarded live probe is
`services/keeper/tests/live/gateway-provider-usage.live.py` (**UNRUN**). After separate
approval to spend, an operator selects one `stream` or `nonstream` mode, an existing
reviewed profile, its exact provider/model, a protected provider key file and an
explicit output limit of at most 32 tokens. `--help` is safe without credentials.
The probe requires `I_UNDERSTAND_THIS_SPENDS_MONEY=1` and makes one tiny synthetic
request directly to that profile's HTTPS provider endpoint, with standard TLS,
no redirects and no retries. It feeds the actual bytes through the same
`WireEvidence` parser and reports only format/mode/success and a digest of validated
terminal counts. A parent process kills and reaps the guarded worker after 152
seconds, including DNS, trickled HTTP framing and cleanup. Errors, compressed or ambiguous responses fail without printing
URLs, credentials, prompts or response bodies. This is the live counterpart to the
provider response fixtures; it does not prove gateway enforcement or replace the
pinned-image integration proof. It is never run automatically or as part of CI.
