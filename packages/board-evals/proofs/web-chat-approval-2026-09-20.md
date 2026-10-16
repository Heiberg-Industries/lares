> Editorial note: package identifiers in these historical excerpts were normalized during the Lares naming migration. This is not evidence of a new run; original output remains in the historical commit.

# An approval answered in web chat, proved on a real eve run — 2026-09-20 (W8B-s5)

W8B-s5 created a new class of approver: the signed-in console member. Before it, `approverFrom` →
`channelForAuthenticator` knew only `slack-webhook` and `telegram-webhook`, so **every** approval
answered over the agent's own HTTP door was refused — correct, and a launch blocker at the same
time, because a fresh installation has no chat app and therefore no way to approve anything at all.

The wave-7 lesson is why this file exists. Three controls in a row were wrong or dead in ways only a
real run showed; `callIdFrom` read `toolCallId`, a field eve does not set, so the payload check
silently never ran. Every claim below therefore rests on what the **framework** actually puts in
`ctx.session.auth`, observed, not on a hand-built context.

```sh
pnpm -C packages/board-evals run proof:web-chat-approval
```

**11 seconds of measured run** (plus a disposable `postgres:16-alpine` container, `eve build` ~4.3 s
and the door answering ~1.5 s later). Docker must be running. No model credential, no gateway, no
money: the package's own `mockModel` is scripted. Nothing outside `packages/board-evals` changes.

## What was real

- a real eve 0.60.1 process — `eve build`, then `eve start --host 127.0.0.1 --port <free>`;
- a real Postgres, with `039/042/044/045` applied and a registry row for the agent;
- the real `forwardChat` from `services/console/lib/chat-proxy.ts`, **imported, not copied**;
- and the point of this proof — **the real door and the real approver check.**
  `services/chief-of-staff/agent/channels/eve.ts` (6937 B), `lib/approvals.ts` (9608 B) and
  `lib/principals.ts` (17186 B) are copied **byte for byte** into the disposable fixture at run
  time and imported there; the copy is asserted identical to the source before the run starts.
  Nothing in the proof re-implements any of them.

The fixture's gated tool is the real shape (`gmail_send`, four recipients) and calls the shipped
`assertApprover(approverFrom(ctx.session.auth))` before it has any effect. "The tool ran" is a line
in a file that only appears *after* that check returns — so item 3's "nothing ran" is an absence of
evidence of the right kind, not a hopeful assertion.

## Results

| item | verdict | evidence |
| --- | --- | --- |
| 1 `ctx.session.auth` inside `execute` is what `approverFrom` expects | PASS | `auth.current.authenticator="lares-console"` · `attributes.user_id="owner@example.invalid"` · `principalId="owner@example.invalid"`; the shipped `principalFromAuth` resolves `{authenticator:"lares-console", userId:"owner@example.invalid"}` and the allow-list accepts it |
| 2 an answer from an allowed signed-in address executes the tool | PASS | answer accepted `202`; the tool's own log says `["sent"]`; answered for `requestId aitxt-Pv6mHxkG8CL80QKaAlyoik3T`, **not** the tool call id `mock-tool-call-1-0-1` |
| 3 an answer from a signed-in address that is **not** an approver is refused, and nothing runs | PASS | answer accepted `202` — the console let them in, the **agent** did not — and the tool's own log says `refused: approval refused: lares-console:stranger@example.invalid is not an allowed approver…`; no `sent` line |
| 4 a browser-forged member header is stripped | PASS | the browser sent `x-lares-member: attacker@example.invalid` on every request; the proxy put `["owner@example.invalid"]` on all 4 upstream calls, and the tool saw `user_id="owner@example.invalid"` |
| 5 an identity smuggled in the request **body** is refused by eve itself | PASS | `403 {"error":"This deployment does not accept a forwarded principal.","ok":false}` |
| 6 the route password on its own approves nothing | PASS | answered `202` with the credential and **no** member header; the door stamped `authenticator="http-basic"`, and the tool's log says `refused: … an unidentified principal is not an allowed approver…` |

## The trust boundary, in two sentences

The agent believes the console's claim about who is answering **because the request carries the
agent's own route password** — nothing more. So anything holding that password can claim to be any
member; today that is the console container and the keeper, both on the owner's own server (owner
decision B3, written into `docs/decisions/0022-the-tested-install-path.md`).

## How identity travels

1. The browser has only the console's `lares_session` cookie. It never sees the route password.
2. `forwardChat` calls `deps.signedInEmail()` — `verify()` of that cookie, re-done rather than
   trusted from middleware — **first**, before any database read, secret read, body read or
   connection.
3. It builds the upstream headers from an **allow-list of three** (`content-type`, `accept`,
   `last-event-id`). Everything else the browser sent is discarded, including any `x-lares-member`
   it invented. That is item 4: the forgery is not detected and rejected, it is never copied.
4. It then sets `Authorization: Basic eve:<route password>` and `x-lares-member: <verified address>`
   itself.
5. The agent's door (`basicFromSecretFile`) verifies the password with eve's own constant-time
   `verifyHttpBasic`, and **only inside the `result.ok` branch** reads the header, shape-checks it
   with `consoleMember`, and returns a session auth with `authenticator: "lares-console"`,
   `principalId: <member>` and `attributes.user_id: <member>`. No header, or an unusable one, leaves
   eve's own `http-basic` context — which is not a channel, and approves nothing (item 6).
6. `approverFrom` → `principalFromAuth` → `channelForAuthenticator("lares-console") === "console"` →
   `isAllowedPrincipalId("console", address, env)` against `CONSOLE_ALLOWED_EMAILS`
   (`LARES_CONSOLE_PRINCIPAL` on a managed incarnation). Unset or empty admits nobody.

**The body lane is closed, and not by us.** eve ships the designed mechanism for a trusted proxy to
assert an identity — a `forwardedPrincipal` field in the session-request body, gated by a channel's
`trustedForwarders` predicate (`dist/src/channel/forwarded-principal.js`). No role's door declares
that predicate, so eve answers `403` to the field outright (item 5). This is why the proxy can relay
the request body opaquely instead of parsing and rewriting it.

## What the run established that reading the code did not

1. **`ctx.session.auth.current` in the resumed turn is the identity on the *answering* request**,
   not on the one that opened the session. The card is parked in one turn and `execute` runs in
   another (W7's `tainted-approval` proof measured the new turn id); this run shows the
   `lares-console` context arriving from the `POST eve/v1/session/<id>` that carried
   `inputResponses`. Web chat therefore attributes an approval to whoever answered it, which is
   what Slack does and what Telegram's null-auth resume cannot.
2. **`initiator` carries the same context.** Both halves are `lares-console`, so `approverFrom`'s
   initiator fallback would reach the same member if `current` were ever absent here. Nothing
   depends on that today.
3. **A free-string `authenticator` survives the durable round trip.** The narrow
   `RuntimeSessionAuthenticator` union in `dist/src/shared/session-auth.d.ts`
   (`"http-basic" | "jwt-hmac" | "jwt-ecdsa" | "oidc"`) describes only the strategies eve itself
   builds. The channel boundary types it as `string` (`dist/src/channel/types.d.ts`) and the durable
   schema persists it as `z.string()` (`dist/src/tasks/session-index.js`), which is also how
   `"slack-webhook"` has always worked.
4. **A refused approval still answers `202`.** eve accepts the answer and the refusal happens inside
   the tool, so a caller cannot read "did this work" off the HTTP status. The evidence is the tool's
   own effect, which is what item 3 asserts.

## Not touched, noticed

- **`approval_asks.answered_via` is written `NULL` for every door**, web chat included.
  `services/chief-of-staff/agent/hooks/approval-record.ts` calls `recordAnswer(getPool(), a)` with
  `a = {requestId, outcome}` and never sets `answeredVia`, although `recordAnswer` accepts it and
  box `086` has the column. That is a wave-7 gap, not a wave-8 one, and nothing reads the column
  yet — but "which door answered this" is not recorded today, and the board cannot show it.
- **`services/travel` has no approver re-check at all** — no `lib/approvals.ts`, no
  `assertApprover` call anywhere — so its door was deliberately left untouched by this slice.
  Stamping an identity there would have changed nothing.
- **Creative records no `approval_asks` rows** (W7A-s4's hook is chief-of-staff-only), so its
  console approvals are approver-checked but never payload-bound or expired. Unchanged here.
