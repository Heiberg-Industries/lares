# Members' private conversations: Tracks approval and the OpenAI-compatible wire (eve 1.0.0-rc.10)

Measured 2026-11-12 against eve 1.0.0-rc.10 with the repository's framework patch, by
`../scripts/member-private-chat-proof.mjs`, on branch `eve-1.0` at
`c9d27ec174192df3a1fab7748b4f4cb31bf4af21`. The Tracks run and the first OpenAI-wire run used the
script unchanged; the two budget runs used that commit plus the one-condition change described
below. The earlier records stay as they are: `member-private-chat-2026-11-11.md` (rc.9, Tracks lane
last run), `member-private-chat-gateway-2026-11-12.md` (gateway lane, both wires, without mail send)
and `member-private-chat-budget-2026-11-12.md` (mail send and budget on the Anthropic wire).

Why this round: the Tracks lane is the evidence cited for "an approval card in web chat can only be
answered by the person who started the conversation" (see `web-chat-approval-2026-11-12.md`), and
its last run predated four approval changes on `eve-1.0` (no new send or outward action in the turn
after an answered card, the console's refusal of a second answer, the durable "turn applied an
answer" mark) and eve rc.10. The mail-send and budget lanes had only been run on the Anthropic wire.

Docker running (one disposable `pgvector/pgvector:pg16` container per run). Each run copies the
actual chief-of-staff role, builds it with `eve build`, starts it with `eve start`, and sends every
request through the console's real `forwardChat`. Only the model (scripted, or a local HTTP stand-in
for the gateway that speaks either wire) and the mail provider (synthetic) are fake. No credential,
no network, no money. `TMPDIR` was a real path with no symlink in it. Runs were serial, each about
one minute on this machine.

## Commands

```sh
# 1. Tracks lane, script unchanged
TMPDIR=<real path> PRIVATE_CHAT_PROOF_ROLE=chief-of-staff PRIVATE_CHAT_PROOF_TRACKS=1 \
  pnpm -C packages/board-evals exec tsx scripts/member-private-chat-proof.mjs

# 2. Mail send on the OpenAI-compatible wire, script unchanged
TMPDIR=<real path> PRIVATE_CHAT_PROOF_ROLE=chief-of-staff PRIVATE_CHAT_PROOF_GATEWAY_LANE=openai-compatible \
  PRIVATE_CHAT_PROOF_SEND=1 pnpm -C packages/board-evals exec tsx scripts/member-private-chat-proof.mjs

# 3. Mail send and budget on the OpenAI-compatible wire (after the change below)
TMPDIR=<real path> PRIVATE_CHAT_PROOF_ROLE=chief-of-staff PRIVATE_CHAT_PROOF_GATEWAY_LANE=openai-compatible \
  PRIVATE_CHAT_PROOF_SEND=1 PRIVATE_CHAT_PROOF_BUDGET=1 \
  pnpm -C packages/board-evals exec tsx scripts/member-private-chat-proof.mjs

# 4. The same on the Anthropic wire, to show the change did not alter that lane
TMPDIR=<real path> PRIVATE_CHAT_PROOF_ROLE=chief-of-staff PRIVATE_CHAT_PROOF_GATEWAY_LANE=anthropic \
  PRIVATE_CHAT_PROOF_SEND=1 PRIVATE_CHAT_PROOF_BUDGET=1 \
  pnpm -C packages/board-evals exec tsx scripts/member-private-chat-proof.mjs
```

## Results

All four runs exited 0. "Model calls" is the number of model requests the run recorded (on a
gateway lane, one per HTTP request to the stand-in); "mail-provider calls" counts the synthetic mail
provider's reads and accepted sends.

| Run | Variables | Result | Model calls | Mail-provider calls |
| --- | --- | --- | --- | --- |
| 1 Tracks cards (Keeper's real broker, real Git Vault) | `ROLE=chief-of-staff TRACKS=1` | **PASS** | 30 | 2 (reads only) |
| 2 Mail send, OpenAI-compatible wire | `ROLE=chief-of-staff GATEWAY_LANE=openai-compatible SEND=1` | **PASS** | 37 | 4 (2 reads, 2 sends) |
| 3 Mail send and budget, OpenAI-compatible wire | `+ BUDGET=1` | **PASS** | 37 | 4 (2 reads, 2 sends) |
| 4 Mail send and budget, Anthropic wire | `ROLE=chief-of-staff GATEWAY_LANE=anthropic SEND=1 BUDGET=1` | **PASS** | 37 | 4 (2 reads, 2 sends) |

The counts match the rc.9 runs: Tracks 30 model calls (`member-private-chat-2026-11-11.md`), mail
send and budget on the Anthropic wire 37 (`member-private-chat-budget-2026-11-12.md`).

Pass lines as printed:

- Run 1: "Tracks card approve/cancel/replay/cold-restart, two members, changed content, expiry and
  no new reads PASS (real Keeper broker and Git Vault)" and "withdrawn edit refuses the pending card
  before the runtime PASS (Keeper rechecks at write: its own suite)".
- Runs 2 to 4: "exact prepare/approve/cancel/replay/cold-restart and second-call refusal PASS", the
  gateway line for that wire ("actual event/session scopes, cold fresh turn, exact resume,
  retry/recovery single dispatch and manual/automatic compaction zero HTTP PASS"; manual compaction
  refused by the authored hook), and "pending account generation approval refused before
  model/provider PASS".
- Runs 3 and 4 also: "actual human and continued-turn approve/deny preparation, unchanged
  hashes/count after valid-authority cold replay PASS (preparation only)" (`proveDurableBudget`).

What the Tracks run re-proves on rc.10, unchanged assertions: a denied card writes nothing and the
conversation carries on; another member, another session, a forged card id and an ungranted member
are refused before the model and the Vault, and answers sent straight to the role with the route
password get `401`; the member who started the conversation approves across a cold restart of the
runtime and exactly one Git commit follows; a spent card cannot be answered again; in the turn after
an answer the model's second `track_create` writes nothing and raises no new card, and its
`tracks_list` read returns no track file; a second member works alone in their own conversation;
content changed under a card does not spend the approval; a company CRM track raises no card for a
member; an expired card refuses Approve and can still be cancelled; withdrawn edit rights refuse a
pending card before the runtime. Keeper's broker (in the proof's own process) printed one
`keeper: Vault request failed: tracks.write, error` line during this lane. The run does not say
which step caused it; by reading, the likely one is the changed-content step, where the Vault write
is expected to be refused and the approval to stay unspent (`use_count` 0 is asserted, and passed).

What the mail-send runs re-prove on the OpenAI-compatible wire, as on the Anthropic wire: exactly 3
prepared sends in the conversation; the new send in each continued turn (after a deny and after the
approve of an attack card) refused with "A new send cannot be started in the reply to an answered
request. Ask again in a new message." (2 refusals); 2 provider sends, both approved, none more
through two cold restarts and repeated answers (refused by the console with `409` and "This request
is no longer waiting, so this answer was not used."); the approve and deny resume checks
(`assertExactResume`: the call after each answer continues the turn that asked the card, as the
same member and admission); scoped model calls equal to HTTP requests; manual and automatic
compaction make no HTTP request; transient, stream, empty-reply and unsupported-tool failures each
make exactly one request. The fixture's OpenAI-compatible parsing needed no change.

## What changed in the script

Only the budget lane's guard (line 47) and the header comment that describes it (line 5). The
budget lane used to refuse to start unless the gateway lane was `anthropic`; it now accepts
`anthropic` or `openai-compatible`. The role (chief-of-staff) and mail-send conditions are
unchanged, and no assertion was added, loosened or removed.

```diff
- * PRIVATE_CHAT_PROOF_BUDGET=1 adds inactive preparation/cold-replay proof to chief/Anthropic + SEND.
+ * PRIVATE_CHAT_PROOF_BUDGET=1 adds inactive preparation/cold-replay proof to chief + SEND on a gateway lane (anthropic or openai-compatible).
-if(withBudget)assert.ok(gatewayLane==='anthropic'&&process.env.PRIVATE_CHAT_PROOF_ROLE==='chief-of-staff'&&withSend,'Durable proof uses the bounded chief/Anthropic approval fixture');
+if(withBudget)assert.ok(['anthropic','openai-compatible'].includes(gatewayLane)&&process.env.PRIVATE_CHAT_PROOF_ROLE==='chief-of-staff'&&withSend,'Durable proof uses the bounded chief approval fixture on a gateway lane (anthropic or openai-compatible)');
```

The budget recorder sits in the AI SDK middleware before the wire (`gatewayModelSource` in
`../scripts/gateway-invocation-fixture.mjs`), so run 3 adds little beyond run 2 except that the
recorder's attempt rows and the gateway's HTTP requests still line up one to one on this wire.

## Also re-run: web chat

`pnpm -C packages/board-evals run proof:web-chat`, on the same commit, unchanged: **PASS**, 13/13
items ("WEB CHAT PROOF: PASS"), exit 0. Its record is `web-chat-2026-11-12.md` (measured on rc.9);
the items and their evidence match that record.

## Not proven

- **Keeper-path charging.** The budget recorder charges through
  `PgBudgetAdmissionStore.prepareIntent` inside the model call, not through Keeper's model-purpose
  broker and gateway socket as production does. `proveDurableBudget` says "preparation only".
- **Keeper's transport on the OpenAI-compatible wire** is not exercised by any offline proof. These
  runs send from the role's own gateway provider straight to the local stand-in.
- The Tracks lane runs on the scripted model only, not on a gateway lane.
- The Vault-read lane (`PRIVATE_CHAT_PROOF_VAULT=1`), the default creative lane and the gateway lane
  without mail send were not re-run in this round.
