# An approval answered in web chat (eve 1.0.0-rc.9): NOT RUN, not ported

Attempted 2026-11-12 on branch `eve-1.0` at `6fc0095c`, with
`../scripts/web-chat-approval-proof.mjs` unchanged. The eve 0.60.1 record is
`web-chat-approval-2026-09-20.md`. **No item of this proof ran on eve 1.0**, and the script was not
ported: its central check cannot be kept, and porting the rest would be a different proof.

## How it failed

- `pnpm -C packages/board-evals run proof:web-chat-approval` stops at import: `node` cannot load
  the console proxy (`ERR_MODULE_NOT_FOUND` for `packages/agent-kit/src/console-source-transaction.js`,
  imported from `console-turn-authority.ts`). Under `tsx` it gets one step further.
- Under `tsx` it fails at `eve build` of the fixture: `Could not resolve '../../lib/agent-name.js'`
  and `'../../lib/conversation-continuity.js'` in the copied `agent/channels/eve.ts`.

## Why it is not ported

The proof's premise is that the chief of staff's door (`agent/channels/eve.ts`), `lib/approvals.ts`
and `lib/principals.ts` can be **copied byte for byte** into a disposable fixture and run there, so
that the real approver check is what refuses. That is no longer possible: the door now imports the
console admission, vault-broker and model-purpose modules and two more role files, and
`lib/approvals.ts` imports fourteen modules (personal send, tracks, deadlines, calendar, vault notes,
the exact-approval ledger and others). The same limit is recorded in `pending-reply-2026-11-11.md`.

The identity design the six items test has also changed, so most items would not be the same check
under a port:

| item (2026-09-20) | on eve 1.0 |
| --- | --- |
| 1 `ctx.session.auth` carries `authenticator: "lares-console"`, `attributes.user_id` | The proxy no longer sends `x-lares-member`; it sends `x-lares-member-id`, `x-lares-admission` and `x-lares-purpose`, and the door admits them against `console_session_bindings`. The auth shape is different. |
| 2 an allowed signed-in address approves | Still meaningful; now covered by the member private-chat proof's Tracks lane (the member who started the conversation approves, across a cold restart). |
| 3 a signed-in non-approver gets `202`, then the tool refuses | The console now refuses before the agent (no grant, wrong member, wrong session or forged card id: refused, no model call). Covered by the Tracks lane. |
| 4 a forged `x-lares-member` header is replaced by the proxy's | The proxy drops it and never sets that header; the member proof asserts it is absent upstream. |
| 5 a `forwardedPrincipal` body field gets eve's `403` | The proxy now rebuilds the body from a closed field list and refuses any other field with its own `400`, so eve never sees it. |
| 6 the route password alone approves nothing | Covered by the Tracks lane's direct-to-role answers, which get `401`. |

So the ground this proof covered on eve 0.60.1 is covered on eve 1.0 by
`member-private-chat-2026-11-11.md` (Tracks lane: deny and approve, wrong member, session, request
and forged answers refused before the model or the Vault), against the real compiled role and the
real proxy. What is **not** re-proved on eve 1.0 is item 1 as written: a verbatim record of
`ctx.session.auth` inside a gated tool's `execute` after a web-chat answer.

A proof that wanted this file's name back would build the real role (as the member proof does)
rather than copy files out of it.
